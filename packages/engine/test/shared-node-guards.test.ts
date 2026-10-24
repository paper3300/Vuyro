import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResponse } from '@vuyro/contracts';
import type { TransportIdentity } from '../src/commands/caller.ts';
import { currentExecution } from '../src/workflow/state.ts';
import {
  buildFails,
  buildPasses,
  buildSpec,
  defineShared,
  devAgents,
  type DevStep,
  driveUntil,
  edits,
  enqueueBuild,
  MINUTE,
  saveBuildFlow,
  saveQuickFlow,
  sharedState,
  sourceFolder,
  startTicket,
} from './helpers/shared-fixtures.ts';
import { openWorkflowHarness, SYSTEM, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { edge, editorType, expectOk, projectAt, save, template } from './helpers/workspace-fixtures.ts';

/**
 * Shared nodes (M5): the guards of the commands and of the engine's batches, each with a test that fails when the
 * guard is taken away (the mutation runs of [[명령·이벤트 계약]] §8).
 */

/** A dev run that holds a file (checked out) for a long time, then reports done. */
function holds(file: string, ms: number, decisions: string[], name: string): DevStep {
  return async (s) => {
    const checkout = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, paths: [join(s.request.cwd ?? '', file)], source: 'hook' });
    decisions.push(`${name}:${(checkout as { result: { decision: string } }).result.decision}`);
    await s.sleep(ms);
    if (!s.cancelled) expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
  };
}

describe('shared node guards', { timeout: 30_000 }, () => {
  let h: WorkflowHarness;
  let root: string;
  let projectId: string;

  afterEach(async () => {
    await h.close();
  });

  async function open(settings?: Record<string, unknown>, noEngine = false): Promise<void> {
    h = await openWorkflowHarness({ noEngine });
    root = sourceFolder(join(h.dir, 'project'), ['src/a.c', 'src/b.c', 'src/c.c', 'src/e.c']);
    projectId = await projectAt(h, root, settings);
    await saveBuildFlow(h);
    await saveQuickFlow(h);
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
  }

  it('enqueue checks the request it is told about: project, request node, shared node name, and that it waits', async () => {
    await open(undefined, true);
    await defineShared(h, projectId, buildSpec({ batchTrigger: { manual: true } }));
    const ticketId = await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    const { projectId: other } = (await h.ok('project.create', { name: 'other' })).result as { projectId: string };
    const request = { projectId, name: 'build', ticketId, nodeId: 'build', lane: 'main', run: 1 };
    const send = (payload: Record<string, unknown>) => h.exec('sharedNode.enqueue', { ...request, ...payload }, SYSTEM);
    const refused = async (payload: Record<string, unknown>) => {
      const response = await send(payload);
      return response.ok ? `ok:${JSON.stringify(response.result)}` : response.error.message;
    };
    expect(await refused({ projectId: other })).toMatch(/is not in project/);
    expect(await refused({ nodeId: 'task' })).toMatch(/not a request node/);
    expect(await refused({ name: 'deploy' })).toMatch(/requests shared node 'build', not 'deploy'/);
    expect(await refused({ run: 2 })).toMatch(/no current run 2/);
    await h.ok('node.pause', { ticketId, nodeId: 'build' });
    expect(await refused({})).toBe('ok:{"queued":false,"reason":"the request is paused, not queued"}');
    expect((await sharedState(h, projectId)).queue).toEqual([]);
    await h.ok('node.resume', { ticketId, nodeId: 'build' });
    expect(await refused({})).toBe('ok:{"queued":true}');
    expect(await refused({})).toBe('ok:{"queued":true}');
    expect((await sharedState(h, projectId)).queue.map((entry) => entry.ticketId)).toEqual([ticketId]);
  });

  it('a new request while the node is blocked joins the queue but does not unblock it', async () => {
    await open();
    await defineShared(h, projectId);
    const observed: string[] = [];
    h.setBehavior(
      devAgents(h, {
        A: [edits('src/a.c')],
        C: [edits('src/c.c')],
        B: [
          edits('src/b.c', 'broken'),
          async (s) => {
            const late = await startTicket(h, projectId, 'D', {}, 'myteam/quick-flow');
            await s.sleep(MINUTE);
            const state = await sharedState(h, projectId);
            observed.push(`${state.blocked?.reason ?? 'not blocked'}:${String(state.queue.some((entry) => entry.ticketId === late))}`);
            await edits('src/b.c', 'fixed')(s, 'B');
          },
        ],
      }),
    );
    enqueueBuild(h, buildFails('src/b.c(1): error: x'));
    enqueueBuild(h, buildPasses());
    for (const title of ['A', 'B', 'C']) await startTicket(h, projectId, title);
    await h.drive();
    expect(observed).toEqual(['blamed:true']);
    const state = await sharedState(h, projectId);
    expect(state.recent.map((batch) => [batch.trigger, batch.members.length, batch.outcome])).toEqual([
      ['count', 3, 'failed'],
      ['retry', 4, 'succeeded'],
    ]);
  });

  it('never runs more batches at once than maxConcurrent: requests that come during a batch wait for it', async () => {
    await open();
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    enqueueBuild(h, buildPasses());
    enqueueBuild(h, buildPasses());
    await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    await driveUntil(h, h.clock.now() + MINUTE);
    await startTicket(h, projectId, 'B', {}, 'myteam/quick-flow');
    await startTicket(h, projectId, 'C', {}, 'myteam/quick-flow');
    await h.drive();
    const state = await sharedState(h, projectId);
    expect(state.recent.map((batch) => batch.members.length)).toEqual([1, 2]);
    const starts = await h.store.query<{ timestamp: number }>("SELECT timestamp FROM events WHERE type IN ('sharedNode.batchStarted', 'sharedNode.batchFinished') ORDER BY sequence");
    expect(starts.map((row) => row.timestamp)).toEqual([...starts.map((row) => row.timestamp)].sort((a, b) => a - b));
    const [, firstFinished, secondStarted] = starts.map((row) => row.timestamp);
    expect(secondStarted).toBeGreaterThanOrEqual(firstFinished ?? 0);
  });

  it("what the member tickets keep themselves (ticketDone claims) never blocks their own batch", async () => {
    await open();
    await save(h, editorType('myteam.keeper', [{ path: 'src/**', mode: 'exclusive', release: 'ticketDone' }]));
    await save(
      h,
      template(
        'myteam/keeper-flow',
        [
          { id: 'task', type: 'vuyro.human-task', version: 1 },
          { id: 'dev', type: 'myteam.keeper', version: 1 },
          { id: 'build', type: 'vuyro.shared-request', version: 1, params: { sharedNode: 'build' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('task', 'done', 'dev'), edge('dev', 'done', 'build'), edge('build', 'done', 'end')],
      ),
    );
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    h.setBehavior(async (s) => {
      expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
      return undefined;
    });
    enqueueBuild(h, buildPasses());
    const ticketId = await startTicket(h, projectId, 'K', {}, 'myteam/keeper-flow');
    await h.drive();
    expect(h.processes.spawned).toHaveLength(1);
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('a batch never takes paths from a running agent (priorityWins, immediate): it waits', async () => {
    await open({ onConflict: 'priorityWins', pauseMode: 'immediate' });
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    const decisions: string[] = [];
    h.setBehavior(devAgents(h, { E: [holds('src/e.c', 30 * MINUTE, decisions, 'E')], A: [edits('src/a.c')] }));
    enqueueBuild(h, buildPasses());
    const e = await startTicket(h, projectId, 'E', {}, 'myteam/edit-only');
    await driveUntil(h, h.clock.now() + MINUTE / 2);
    await startTicket(h, projectId, 'A', { priority: 10 });
    await h.drive();
    expect(decisions).toEqual(['E:granted']);
    // E finished its edit undisturbed; the batch started after it.
    expect(currentExecution(await h.ticket(e), 'dev', 'main')?.run).toBe(1);
    expect((await h.ticket(e)).status).toBe('done');
    const [released] = (await h.store.query<{ timestamp: number }>("SELECT timestamp FROM events WHERE type = 'checkout.released' AND data LIKE '%nodeDone%' ORDER BY sequence")).map((row) => row.timestamp);
    const [started] = (await h.store.query<{ timestamp: number }>("SELECT timestamp FROM events WHERE type = 'sharedNode.batchStarted'")).map((row) => row.timestamp);
    expect(started).toBeGreaterThanOrEqual(released ?? 0);
  });

  it("a person's run goes ahead over paths someone holds (recorded as overlaps); the engine's start waits", async () => {
    await open();
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    const decisions: string[] = [];
    h.setBehavior(devAgents(h, { E: [holds('src/e.c', 60 * MINUTE, decisions, 'E')] }));
    enqueueBuild(h, buildPasses());
    await startTicket(h, projectId, 'E', {}, 'myteam/edit-only');
    await driveUntil(h, h.clock.now() + MINUTE / 2);
    const a = await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    await driveUntil(h, h.clock.now() + 2 * MINUTE);
    expect((await sharedState(h, projectId)).waiting?.conflicts.map((conflict) => conflict.path)).toEqual(['src/**']);
    expect(h.processes.spawned).toEqual([]);
    const run = await h.ok('sharedNode.run', { projectId, name: 'build' });
    expect(run.result).toMatchObject({ started: true });
    await driveUntil(h, h.clock.now() + 10 * MINUTE);
    const started = await h.store.query<{ data: string }>("SELECT data FROM events WHERE type = 'sharedNode.batchStarted'");
    expect((JSON.parse(started[0]?.data ?? '{}') as { overlaps?: { path: string }[] }).overlaps?.map((overlap) => overlap.path)).toEqual(['src/**']);
    expect((await h.ticket(a)).status).toBe('done');
  });

  it('a batch whose result cannot be recorded is never run again: it is recorded as interrupted', async () => {
    await open();
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    enqueueBuild(h, buildPasses());
    enqueueBuild(h, buildPasses());
    // The first try to record the batch's end fails (as a crash of that command would).
    const execute = h.bus.execute.bind(h.bus);
    let failed = 0;
    h.bus.execute = (request: unknown, transport: TransportIdentity): Promise<CommandResponse> => {
      const envelope = request as { type?: string; payload?: { result?: { kind?: string } } };
      if (envelope.type === 'sharedNode.finish' && envelope.payload?.result?.kind === 'script' && failed === 0) {
        failed += 1;
        return Promise.resolve({ ok: false, error: { code: 'internal', message: 'disk full', retryable: true } });
      }
      return execute(request, transport);
    };
    const a = await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    await h.drive();
    expect(h.processes.spawned).toHaveLength(1);
    const state = await sharedState(h, projectId);
    expect(state.recent.map((batch) => batch.outcome)).toEqual(['interrupted']);
    expect(state.blocked?.reason).toBe('interrupted');
    expect(await h.status(a, 'build')).toBe('queued');
    expect(h.errors.map((entry) => entry.error.message)).toEqual(['sharedNode.finish: internal disk full']);
    h.errors.length = 0;
  });
});
