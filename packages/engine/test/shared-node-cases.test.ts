import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CommandFailure, sharedNodeAggregateId } from '@vuyro/contracts';
import { MemoryFileSystem } from '../src/runtime/fs.ts';
import { currentExecution } from '../src/workflow/state.ts';
import { CLI } from './helpers/engine-harness.ts';
import {
  buildFails,
  buildPasses,
  buildSpec,
  defineShared,
  devAgents,
  type DevStep,
  driveUntil,
  during,
  edits,
  enqueueBuild,
  MINUTE,
  saveBuildFlow,
  saveQuickFlow,
  sharedState,
  sourceFolder,
  startTicket,
} from './helpers/shared-fixtures.ts';
import { HUMAN, openWorkflowHarness, SYSTEM, type WorkflowHarness, type WorkflowHarnessOptions } from './helpers/workflow-harness.ts';
import { edge, expectOk, projectAt, save, template } from './helpers/workspace-fixtures.ts';

/**
 * Shared nodes (M5): triggers, who may run what, the failure policies, protected paths, requests that cannot be served,
 * and the queue across engine restarts.
 */

function failure(response: unknown): CommandFailure['error'] {
  const value = response as { ok: boolean; error?: CommandFailure['error'] };
  if (value.ok || value.error === undefined) throw new Error(`expected a failure, got ${JSON.stringify(response)}`);
  return value.error;
}

/** A dev run that reports done after a while without editing anything. */
function reportsAfter(ms: number): DevStep {
  return async (s) => {
    await s.sleep(ms);
    expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
  };
}

async function eventTimes(h: WorkflowHarness, type: string): Promise<number[]> {
  const rows = await h.store.query<{ timestamp: number }>('SELECT timestamp FROM events WHERE type = ? ORDER BY sequence', [type]);
  return rows.map((row) => row.timestamp);
}

describe('shared nodes', { timeout: 30_000 }, () => {
  let h: WorkflowHarness;
  let root: string;
  let projectId: string;
  const titles = new Map<string, string>();

  afterEach(async () => {
    titles.clear();
    await h.close();
  });

  async function open(options: WorkflowHarnessOptions = {}, settings?: Record<string, unknown>): Promise<void> {
    h = await openWorkflowHarness(options);
    root = sourceFolder(join(h.dir, 'project'), ['src/a.c', 'src/b.c', 'src/c.c', 'src/d.c', 'src/e.c']);
    projectId = await projectAt(h, root, settings);
    await saveBuildFlow(h);
    await saveQuickFlow(h);
  }

  async function ticket(title: string, templateId = 'myteam/build-flow'): Promise<string> {
    const id = await startTicket(h, projectId, title, {}, templateId);
    titles.set(id, title);
    return id;
  }

  const named = (members: readonly { ticketId: string }[] | undefined): (string | undefined)[] => (members ?? []).map((member) => titles.get(member.ticketId));

  describe('triggers', () => {
    it('a window starts a batch with what is queued when the first request has waited that long', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 5, window: '20m' } }));
      enqueueBuild(h, buildPasses());
      await ticket('A', 'myteam/quick-flow');
      await h.clock.advance(3 * MINUTE);
      await ticket('B', 'myteam/quick-flow');
      await h.drive();
      const [queued] = await eventTimes(h, 'sharedNode.requestQueued');
      const [started] = await eventTimes(h, 'sharedNode.batchStarted');
      expect((started ?? 0) - (queued ?? 0)).toBe(20 * MINUTE);
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.trigger, named(batch.members)])).toEqual([['window', ['A', 'B']]]);
      expect(h.errors).toEqual([]);
    });

    it('afterPrevious runs one batch after another with everything that queued meanwhile', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ batchTrigger: { afterPrevious: true } }));
      h.setBehavior(
        devAgents(h, {
          A: [edits('src/a.c')],
          // B and C finish while A builds (without editing: an edit would wait for the batch's protected paths).
          B: [reportsAfter(2 * MINUTE)],
          C: [reportsAfter(3 * MINUTE)],
        }),
      );
      enqueueBuild(h, buildPasses());
      enqueueBuild(h, buildPasses());
      for (const title of ['A', 'B', 'C']) await ticket(title);
      await h.drive();
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.trigger, named(batch.members), batch.outcome])).toEqual([
        ['afterPrevious', ['A'], 'succeeded'],
        ['afterPrevious', ['B', 'C'], 'succeeded'],
      ]);
    });

    it('only a person starts a manual shared node; the engine-only commands refuse everyone else', async () => {
      await open();
      const defined = await defineShared(h, projectId, buildSpec({ batchTrigger: { manual: true, schedule: '0 12 * * *' } }));
      expect(defined.warnings.join('\n')).toMatch(/schedule is not supported yet/);
      expect(defined.warnings.join('\n')).toMatch(/batches start only when a person runs them/);
      enqueueBuild(h, buildPasses());
      const a = await ticket('A', 'myteam/quick-flow');
      await h.drive();
      expect((await sharedState(h, projectId)).queue.map((entry) => entry.ticketId)).toEqual([a]);
      expect(h.processes.spawned).toEqual([]);

      expect(failure(await h.exec('sharedNode.run', { projectId, name: 'build' }, CLI)).code).toBe('forbidden');
      for (const type of ['sharedNode.start', 'sharedNode.enqueue', 'sharedNode.finish']) {
        const payload = type === 'sharedNode.start' ? { projectId, name: 'build' } : type === 'sharedNode.enqueue' ? { projectId, name: 'build', ticketId: a, nodeId: 'build', lane: 'main', run: 1 } : { projectId, name: 'build', batch: 1, result: { kind: 'interrupted', reason: 'x' } };
        expect(failure(await h.exec(type, payload)).code, type).toBe('forbidden');
      }
      const run = await h.ok('sharedNode.run', { projectId, name: 'build' });
      expect(run.result).toMatchObject({ started: true, batch: 1 });
      await h.drive();
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.trigger, batch.outcome])).toEqual([['manual', 'succeeded']]);
      expect((await h.ticket(a)).status).toBe('done');
      // Nothing queued: a person's run is refused with the reason.
      expect(failure(await h.exec('sharedNode.run', { projectId, name: 'build' })).message).toMatch(/nothing is queued/);
    });
  });

  describe('failed batches', () => {
    it("'allFail' sends every ticket to its error port and blocks nothing", async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ onBatchFailure: 'allFail' }));
      h.setBehavior(devAgents(h, { A: [edits('src/a.c')], B: [edits('src/b.c')], C: [edits('src/c.c')] }));
      enqueueBuild(h, buildFails('src/b.c(3): error: broken'));
      enqueueBuild(h, buildPasses());
      for (const title of ['A', 'B', 'C']) await ticket(title);
      await h.drive();
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.outcome, batch.policy, named(batch.failed).sort(), batch.trigger])).toEqual([
        ['failed', 'allFail', ['A', 'B', 'C'], 'count'],
        ['succeeded', undefined, [], 'count'],
      ]);
      expect(state.blocked).toBeUndefined();
      for (const id of titles.keys()) {
        const done = await h.ticket(id);
        expect(done.status).toBe('done');
        // The first request failed with the error lines of the whole batch.
        const first = done.nodes.build?.executions[0];
        expect(first?.status).toBe('failed');
        expect((first?.output?.items[0]?.data as { errorsForThisTicket: string[] }).errorsForThisTicket).toEqual(['src/b.c(3): error: broken']);
      }
    });

    it("'blame' that finds nobody (the error is in a file no ticket of the batch changed) settles as allFail", async () => {
      await open();
      await defineShared(h, projectId);
      h.setBehavior(devAgents(h, { A: [edits('src/a.c')], B: [edits('src/b.c')], C: [edits('src/c.c')] }));
      enqueueBuild(h, buildFails('src/d.c:7:1: error: unknown type name'));
      enqueueBuild(h, buildPasses());
      for (const title of ['A', 'B', 'C']) await ticket(title);
      await h.drive();
      const [first] = (await sharedState(h, projectId)).recent;
      expect([first?.policy, first?.errorFiles, named(first?.failed).sort()]).toEqual(['allFail', ['src/d.c'], ['A', 'B', 'C']]);
      const data = (await h.ticket([...titles.keys()][0] ?? '')).nodes.build?.executions[0]?.output?.items[0]?.data;
      expect(data).toMatchObject({ blamedBy: 'none' });
    });

    it('refuses what would run differently from what it says: unsupported failure policies, more than one batch at a time', async () => {
      await open();
      for (const onBatchFailure of ['ask', 'bisect', 'agent'] as const) {
        const refused = failure(await h.exec('sharedNode.define', { projectId, spec: buildSpec({ onBatchFailure }) }));
        expect(refused.code, onBatchFailure).toBe('validation_failed');
        expect(JSON.stringify(refused.details), onBatchFailure).toMatch(/is not supported yet/);
      }
      const concurrent = failure(await h.exec('sharedNode.define', { projectId, spec: buildSpec({ maxConcurrent: 2 }) }));
      expect(JSON.stringify(concurrent.details)).toMatch(/only one runs at a time/);
      expect((await sharedState(h, projectId)).exists).toBe(false);
    });

    it('a person can unblock a node blocked by a blamed ticket: the waiting tickets build without it, and the blamed ticket raised its priority', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ raiseBlamedPriority: true }));
      const unblocked: string[] = [];
      h.setBehavior(
        devAgents(h, {
          A: [edits('src/a.c')],
          C: [edits('src/c.c')],
          B: [
            edits('src/b.c', 'broken'),
            // While B is being fixed, a person decides the blame was wrong and unblocks: A and C build at once.
            async (s) => {
              const response = await h.exec('sharedNode.unblock', { projectId, name: 'build' });
              expectOk(response);
              unblocked.push(JSON.stringify((response as { result: unknown }).result));
              await s.sleep(30 * MINUTE);
              await edits('src/b.c', 'fixed')(s, 'B');
            },
          ],
        }),
      );
      enqueueBuild(h, buildFails('src/b.c(1): error: nope'));
      enqueueBuild(h, buildPasses());
      enqueueBuild(h, buildPasses());
      const a = await ticket('A');
      const b = await ticket('B', 'myteam/build-flow');
      await h.ok('ticket.update', { ticketId: a, priority: 5 });
      for (const title of ['C']) await ticket(title);
      await h.drive();
      expect(unblocked).toEqual(['{"unblocked":true}']);
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.trigger, named(batch.members), batch.outcome])).toEqual([
        ['count', ['A', 'B', 'C'], 'failed'],
        ['retry', ['A', 'C'], 'succeeded'],
        // B alone: the count is not met, but its window… there is none: it waits until a person runs it.
      ]);
      expect((await h.ticket(b)).priority).toBe(6);
      expect(state.queue.map((entry) => titles.get(entry.ticketId))).toEqual(['B']);
      const run = await h.ok('sharedNode.run', { projectId, name: 'build' });
      expect(run.result).toMatchObject({ started: true });
      await h.drive();
      expect((await h.ticket(b)).status).toBe('done');
    });
  });

  describe('protected paths', () => {
    it('a batch waits for paths someone is editing, and an edit during a batch waits for the batch', async () => {
      await open();
      await save(
        h,
        template(
          'myteam/edit-only',
          [
            { id: 'task', type: 'vuyro.human-task', version: 1 },
            { id: 'dev', type: 'vuyro.agent', version: 1, params: { instructions: 'Edit.' } },
            { id: 'end', type: 'vuyro.end', version: 1 },
          ],
          [edge('task', 'done', 'dev'), edge('dev', 'done', 'end')],
        ),
      );
      await defineShared(h, projectId);
      const decisions: string[] = [];
      h.setBehavior(
        devAgents(h, {
          A: [edits('src/a.c')],
          B: [edits('src/b.c')],
          C: [edits('src/c.c')],
          // D holds src/d.c for half an hour: the first batch waits for it.
          D: [
            async (s) => {
              const checkout = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: 'dev', paths: [join(root, 'src/d.c')], source: 'hook' });
              decisions.push(`D:${(checkout as { result: { decision: string } }).result.decision}`);
              await s.sleep(30 * MINUTE);
              expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'dev', port: 'done' }));
            },
          ],
          // E tries to edit while the batch runs: it is stopped and goes on once the batch is over.
          E: [
            async (s) => {
              await s.sleep(33 * MINUTE);
              const checkout = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: 'dev', paths: [join(root, 'src/e.c')], source: 'hook' });
              decisions.push(`E:${(checkout as { result: { decision: string } }).result.decision}`);
              await s.sleep(24 * 60 * MINUTE);
            },
            async (s) => {
              const checkout = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: 'dev', paths: [join(root, 'src/e.c')], source: 'hook' });
              decisions.push(`E again:${(checkout as { result: { decision: string } }).result.decision}`);
              expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'dev', port: 'done' }));
            },
          ],
        }),
      );
      enqueueBuild(h, buildPasses());
      await ticket('D', 'myteam/edit-only');
      await driveUntil(h, h.clock.now() + MINUTE / 2);
      for (const title of ['A', 'B', 'C']) await ticket(title);
      await ticket('E', 'myteam/edit-only');
      await h.drive();
      expect(h.errors).toEqual([]);
      const waited = await h.store.query<{ data: string }>("SELECT data FROM events WHERE type = 'sharedNode.waiting'");
      expect(waited.map((row) => (JSON.parse(row.data) as { conflicts: { path: string; holder: { ticketId: string } }[] }).conflicts.map((conflict) => `${conflict.path}:${titles.get(conflict.holder.ticketId) ?? ''}`))).toEqual([['src/**:D']]);
      const [dDone] = await eventTimes(h, 'checkout.released');
      const [started] = await eventTimes(h, 'sharedNode.batchStarted');
      expect(started).toBeGreaterThanOrEqual(dDone ?? 0);
      expect(decisions).toEqual(['D:granted', 'E:wait', 'E again:granted']);
      const [finished] = await eventTimes(h, 'sharedNode.batchFinished');
      const eAgain = await h.store.query<{ timestamp: number }>("SELECT timestamp FROM events WHERE type = 'checkout.acquired' ORDER BY sequence DESC LIMIT 1");
      expect(eAgain[0]?.timestamp).toBeGreaterThanOrEqual(finished ?? 0);
      for (const id of titles.keys()) expect((await h.ticket(id)).status, titles.get(id)).toBe('done');
    });
  });

  describe('requests that cannot be served', () => {
    it('fail through the error port with the reason: no such shared node, worktree mode, or a request that does not match', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ requestSchema: { type: 'object', properties: { what: { type: 'number' } } }, batchTrigger: { count: 1 } }));
      await saveQuickFlow(h, 'deploy', 'myteam/deploy-flow');
      const missing = await ticket('missing', 'myteam/deploy-flow');
      const mismatch = await ticket('mismatch', 'myteam/quick-flow');
      await h.drive();
      const error = async (id: string) => (currentExecution(await h.ticket(id), 'build', 'main')?.output?.items[0]?.data ?? { error: '' }) as { error: string; issues?: unknown[] };
      expect((await error(missing)).error).toMatch(/shared node 'deploy' is not defined in this project/);
      expect((await error(mismatch)).error).toMatch(/does not match shared node 'build' \(requestSchema\)/);
      expect((await error(mismatch)).issues).toHaveLength(1);
      expect(h.processes.spawned).toEqual([]);

      const worktree = await projectAt(h, root, { workspaceMode: 'worktree' });
      await defineShared(h, worktree, buildSpec({ batchTrigger: { count: 1 } }));
      const { ticketId } = (await h.ok('ticket.create', { projectId: worktree, title: 'wt', template: { id: 'myteam/quick-flow' } })).result as { ticketId: string };
      await h.ok('node.done', { ticketId, nodeId: 'task', port: 'done', data: { what: 1 } });
      await h.drive();
      expect((await error(ticketId)).error).toMatch(/worktree mode/);
      expect(h.processes.spawned).toEqual([]);
    });

    it("a batch never runs in the engine's own folder: without a project folder it fails without starting anything", async () => {
      await open();
      const { projectId: bare } = (await h.ok('project.create', { name: 'no folder' })).result as { projectId: string };
      await defineShared(h, bare, buildSpec({ batchTrigger: { count: 1 } }));
      const { ticketId } = (await h.ok('ticket.create', { projectId: bare, title: 'bare', template: { id: 'myteam/quick-flow' } })).result as { ticketId: string };
      await h.ok('node.done', { ticketId, nodeId: 'task', port: 'done' });
      await h.drive();
      expect(h.processes.spawned).toEqual([]);
      const output = currentExecution(await h.ticket(ticketId), 'build', 'main')?.output;
      expect(output?.port).toBe('error');
      expect((output?.items[0]?.data as { error: string }).error).toMatch(/no workspace folder/);
    });

    it('a request replaced by a newer run of its lane takes its place in the queue; a paused one keeps its place but waits', async () => {
      await open();
      await save(
        h,
        template(
          'myteam/notes-flow',
          [
            { id: 'task', type: 'vuyro.human-task', version: 1 },
            { id: 'notes', type: 'vuyro.human-task', version: 1 },
            { id: 'dev', type: 'vuyro.agent', version: 1, params: { instructions: 'Change the code.' } },
            { id: 'build', type: 'vuyro.shared-request', version: 1, params: { sharedNode: 'build' } },
            { id: 'end', type: 'vuyro.end', version: 1 },
          ],
          [edge('task', 'done', 'dev'), edge('task', 'done', 'notes'), edge('notes', 'done', 'dev'), edge('dev', 'done', 'build'), edge('build', 'done', 'end')],
        ),
      );
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 2 } }));
      h.setBehavior(devAgents(h, { X: [edits('src/a.c')], Y: [edits('src/b.c')] }));
      enqueueBuild(h, buildPasses());
      const x = await ticket('X', 'myteam/notes-flow');
      await h.drive();
      // X's request run 1 waits; then more notes make dev run again and the new request replaces the first.
      expect((await sharedState(h, projectId)).queue.map((entry) => entry.run)).toEqual([1]);
      await h.ok('node.done', { ticketId: x, nodeId: 'notes', port: 'done' });
      await h.drive();
      expect((await sharedState(h, projectId)).queue.map((entry) => [titles.get(entry.ticketId), entry.run])).toEqual([['X', 2]]);
      expect(currentExecution(await h.ticket(x), 'build', 'main')?.run).toBe(2);
      // The replaced run cannot be queued any more.
      const stale = await h.exec('sharedNode.enqueue', { projectId, name: 'build', ticketId: x, nodeId: 'build', lane: 'main', run: 1 }, SYSTEM);
      expect(failure(stale).code).toBe('not_found');

      // A paused request keeps its place but is not built: Y alone does not meet the count.
      await h.ok('node.pause', { ticketId: x, nodeId: 'build' });
      const y = await ticket('Y', 'myteam/notes-flow');
      await h.drive();
      expect(h.processes.spawned).toEqual([]);
      expect((await sharedState(h, projectId)).queue.map((entry) => titles.get(entry.ticketId))).toEqual(['X', 'Y']);
      await h.ok('node.resume', { ticketId: x, nodeId: 'build' });
      await h.drive();
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [named(batch.members), batch.outcome])).toEqual([[['X', 'Y'], 'succeeded']]);
      expect((await h.ticket(x)).status).toBe('done');
      // Y's own notes task is still open; its build got its share.
      expect(currentExecution(await h.ticket(y), 'build', 'main')?.output?.port).toBe('done');
    });
  });

  describe('engine restarts and the app being closed', () => {
    it('the queue survives a restart and the window counts from when the requests joined', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 5, window: '20m' } }));
      enqueueBuild(h, buildPasses());
      const start = h.clock.now();
      await ticket('A', 'myteam/quick-flow');
      await ticket('B', 'myteam/quick-flow');
      await driveUntil(h, start + 10 * MINUTE);
      expect(h.processes.spawned).toEqual([]);
      await h.restart();
      expect((await sharedState(h, projectId)).queue.map((entry) => titles.get(entry.ticketId))).toEqual(['A', 'B']);
      await h.drive();
      const [started] = await eventTimes(h, 'sharedNode.batchStarted');
      expect(started).toBe(start + 20 * MINUTE);
      for (const id of titles.keys()) expect((await h.ticket(id)).status).toBe('done');
      expect(h.errors).toEqual([]);
    });

    it('a batch the engine lost is reported interrupted: its tickets go back to the queue, a person decides, and it runs again', async () => {
      await open({ noEngine: true });
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 2 } }));
      const a = await ticket('A', 'myteam/quick-flow');
      const b = await ticket('B', 'myteam/quick-flow');
      // What the engine did before it died: queued both and started their batch (no process ran in this test).
      for (const id of [a, b]) expectOk(await h.exec('sharedNode.enqueue', { projectId, name: 'build', ticketId: id, nodeId: 'build', lane: 'main', run: 1 }, SYSTEM));
      expect((await h.exec('sharedNode.start', { projectId, name: 'build' }, SYSTEM)) as unknown).toMatchObject({ ok: true, result: { started: true, batch: 1 } });
      expect(await h.status(a, 'build')).toBe('running');

      enqueueBuild(h, buildPasses());
      await h.restart();
      await h.drive();
      let state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => batch.outcome)).toEqual(['interrupted']);
      expect(state.blocked).toMatchObject({ reason: 'interrupted', batch: 1 });
      expect(state.queue.map((entry) => [titles.get(entry.ticketId), entry.retry])).toEqual([
        ['A', true],
        ['B', true],
      ]);
      expect(await h.status(a, 'build')).toBe('queued');
      expect(h.processes.spawned).toEqual([]);

      await h.ok('sharedNode.unblock', { projectId, name: 'build' });
      await h.drive();
      state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => [batch.trigger, named(batch.members), batch.outcome])).toEqual([
        ['count', ['A', 'B'], 'interrupted'],
        ['retry', ['A', 'B'], 'succeeded'],
      ]);
      expect((await h.ticket(a)).status).toBe('done');
    });

    it('stopping the engine during a batch kills it and records it as interrupted, never as a failure', async () => {
      await open();
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
      enqueueBuild(h, [{ delayMs: 60 * MINUTE, stdout: 'still building' }, { exit: 0 }]);
      const a = await ticket('A', 'myteam/quick-flow');
      await driveUntil(h, h.clock.now() + MINUTE);
      expect(await h.status(a, 'build')).toBe('running');
      h.engine?.stop({ cancelRunning: true });
      await h.activity.idle();
      const state = await sharedState(h, projectId);
      expect(state.recent.map((batch) => batch.outcome)).toEqual(['interrupted']);
      expect(state.blocked?.reason).toBe('interrupted');
      expect(h.processes.spawned[0]?.kills).toEqual(['SIGKILL']);
      expect(await h.status(a, 'build')).toBe('queued');
    });
  });

  describe('definitions', () => {
    it('checks the spec when it is defined and keeps a version per change', async () => {
      await open();
      const issues = async (spec: unknown) => JSON.stringify(failure(await h.exec('sharedNode.define', { projectId, spec })).details);
      expect(await issues(buildSpec({ node: { type: 'vuyro.agent', version: 1, params: { instructions: 'x' } } }))).toMatch(/runs a script node type/);
      expect(await issues(buildSpec({ protect: [{ path: '../outside/**', mode: 'shared' }] }))).toMatch(/stay inside the workspace/);
      expect(await issues(buildSpec({ node: { type: 'vuyro.script', version: 1, params: { program: '{{ nodes.dev.data.x }}' } } }))).toMatch(/no node 'dev'/);
      expect(await issues(buildSpec({ node: { type: 'vuyro.script', version: 1, params: {} } }))).toMatch(/program/);
      expect(failure(await h.exec('sharedNode.define', { projectId, spec: buildSpec({ node: { type: 'myteam.none', version: 1 } }) })).code).toBe('not_found');
      expect(failure(await h.exec('sharedNode.define', { projectId, spec: buildSpec() }, CLI)).code).toBe('forbidden');

      expect((await defineShared(h, projectId)).version).toBe(1);
      expect((await defineShared(h, projectId)).version).toBe(1);
      expect((await defineShared(h, projectId, buildSpec({ label: 'Build machine' }))).version).toBe(2);
      const rows = await h.store.query<{ name: string; version: number }>('SELECT name, version FROM p_shared_nodes WHERE aggregate_id = ?', [sharedNodeAggregateId(projectId, 'build')]);
      expect(rows).toEqual([{ name: 'build', version: 2 }]);
    });

    it("a request node names its shared node literally, whatever its type's param schema allows", async () => {
      await open();
      const type = {
        vuyro: 'export' as const,
        formatVersion: 1 as const,
        kind: 'nodeType' as const,
        id: 'myteam.request',
        version: 1,
        name: 'Request',
        content: {
          type: 'myteam.request',
          version: 1,
          label: 'Request',
          completion: 'shared' as const,
          inputs: [{ name: 'in', label: 'In' }],
          outputs: [
            { name: 'done', label: 'Done' },
            { name: 'error', label: 'Error' },
          ],
          params: [{ name: 'sharedNode', label: 'Shared node', required: true, schema: { type: 'string' } }],
        },
      };
      await save(h, type);
      const flow = template(
        'myteam/dynamic',
        [
          { id: 'task', type: 'vuyro.human-task', version: 1 },
          { id: 'build', type: 'myteam.request', version: 1, params: { sharedNode: '{{ input.data.target }}' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('task', 'done', 'build'), edge('build', 'done', 'end')],
      );
      const refused = failure(await h.writer.save(flow, HUMAN, 'req-dynamic-template-1'));
      expect(JSON.stringify(refused.details)).toMatch(/must name a shared node/);
    });

    it('writes each batch log and links it to every ticket of the batch', async () => {
      const fs = new MemoryFileSystem();
      await open({ sharedLogs: { dir: join('/', 'logs'), fs } });
      await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
      enqueueBuild(h, buildPasses(during(h, () => undefined), { stdout: 'compiled 3 files' }));
      const a = await ticket('A', 'myteam/quick-flow');
      await h.drive();
      const log = currentExecution(await h.ticket(a), 'build', 'main')?.output?.items[0]?.artifacts?.log;
      expect(log).toMatchObject({ kind: 'file', uri: join('/', 'logs', projectId, 'build', 'build-1.log') });
      expect(await fs.readText(log?.uri ?? '')).toMatch(/compiled 3 files/);
    });
  });
});
