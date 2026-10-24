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

  it('a failed batch puts its waiting tickets in front of requests that came meanwhile; new requests do not unblock it', async () => {
    await open();
    await defineShared(h, projectId);
    const observed: string[] = [];
    const tickets: Record<string, string> = {};
    const name = (id: string): string => Object.keys(tickets).find((title) => tickets[title] === id) ?? '?';
    h.setBehavior(
      devAgents(h, {
        A: [edits('src/a.c')],
        C: [edits('src/c.c')],
        B: [
          edits('src/b.c', 'broken'),
          async (s) => {
            const state = await sharedState(h, projectId);
            observed.push(`${state.blocked?.reason ?? 'not blocked'}:${state.queue.map((entry) => name(entry.ticketId)).join(',')}`);
            await edits('src/b.c', 'fixed')(s, 'B');
          },
        ],
      }),
    );
    // D asks while the first batch runs: it waits behind it.
    enqueueBuild(h, [
      during(h, async () => {
        tickets.D = await startTicket(h, projectId, 'D', {}, 'myteam/quick-flow');
      }),
      ...buildFails('src/b.c(1): error: x'),
    ]);
    enqueueBuild(h, buildPasses());
    for (const title of ['A', 'B', 'C']) tickets[title] = await startTicket(h, projectId, title);
    await h.drive();
    // The tickets the failed batch put back come first; D's request did not unblock the node.
    expect(observed).toEqual(['blamed:A,C,D']);
    const state = await sharedState(h, projectId);
    expect(state.recent.map((batch) => [batch.trigger, batch.members.map((member) => name(member.ticketId)), batch.outcome])).toEqual([
      ['count', ['A', 'B', 'C'], 'failed'],
      ['retry', ['A', 'C', 'D', 'B'], 'succeeded'],
    ]);
  });

  it('the commands themselves refuse to start a batch while one runs or the node is blocked (the scheduler checks the same first)', async () => {
    await open(undefined, true);
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    await saveQuickFlow(h, 'build2', 'myteam/quick-flow-2');
    await defineShared(h, projectId, buildSpec({ name: 'build2', batchTrigger: { afterPrevious: true }, maxConcurrent: 2 }));
    const a = await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    const b = await startTicket(h, projectId, 'B', {}, 'myteam/quick-flow');
    const start = async (shared = 'build') => {
      const response = await h.exec('sharedNode.start', { projectId, name: shared }, SYSTEM);
      expectOk(response);
      return (response as { result: { started: boolean; batch?: number; reason?: string } }).result;
    };
    const run = async () => {
      const response = await h.exec('sharedNode.run', { projectId, name: 'build' });
      return response.ok ? `started ${String((response.result as { batch?: number }).batch)}` : response.error.message;
    };
    const enqueue = async (ticketId: string, shared = 'build') => {
      expectOk(await h.exec('sharedNode.enqueue', { projectId, name: shared, ticketId, nodeId: 'build', lane: 'main', run: 1 }, SYSTEM));
    };
    await enqueue(a);
    expect(await start()).toMatchObject({ started: true, batch: 1 });
    await enqueue(b);
    expect(await start()).toMatchObject({ started: false, reason: 'a batch is running' });
    expect(await run()).toMatch(/1 batch\(es\) running/);
    expectOk(await h.exec('sharedNode.finish', { projectId, name: 'build', batch: 1, result: { kind: 'interrupted', reason: 'test' } }, SYSTEM));
    expect(await start()).toMatchObject({ started: false, reason: expect.stringMatching(/blocked: batch 1 was interrupted/) as string });
    expect(await run()).toMatch(/blocked: batch 1 was interrupted/);
    await h.ok('sharedNode.unblock', { projectId, name: 'build' });
    expect(await start()).toMatchObject({ started: true, batch: 2, reason: 'retry' });
    expect((await sharedState(h, projectId)).running[2]?.members.map((member) => member.ticketId)).toEqual([a, b]);

    // afterPrevious waits for the previous batch even when there is room for two.
    const c = await startTicket(h, projectId, 'C', {}, 'myteam/quick-flow-2');
    const d = await startTicket(h, projectId, 'D', {}, 'myteam/quick-flow-2');
    await enqueue(c, 'build2');
    expect(await start('build2')).toMatchObject({ started: true, reason: 'afterPrevious' });
    await enqueue(d, 'build2');
    expect(await start('build2')).toMatchObject({ started: false });
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
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 2 } }));
    h.setBehavior(async (s) => {
      expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
      return undefined;
    });
    enqueueBuild(h, buildPasses());
    // Q queues first, so K (whose ticket keeps an exclusive claim on src/**) is not the batch's first member.
    const q = await startTicket(h, projectId, 'Q', {}, 'myteam/quick-flow');
    const ticketId = await startTicket(h, projectId, 'K', {}, 'myteam/keeper-flow');
    await h.drive();
    expect(h.processes.spawned).toHaveLength(1);
    expect((await sharedState(h, projectId)).recent[0]?.members.map((member) => member.ticketId)).toEqual([q, ticketId]);
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
    expect(await h.store.query("SELECT 1 FROM events WHERE type = 'checkout.released' AND data LIKE '%preempted%'")).toEqual([]);
    expect(await h.store.query("SELECT 1 FROM events WHERE type = 'node.pauseRequested'")).toEqual([]);
    const completions = await h.store.query<{ timestamp: number; data: string }>("SELECT timestamp, data FROM events WHERE type = 'node.completed' AND aggregate_id = ? ORDER BY sequence", [e]);
    const eDone = completions.find((row) => (JSON.parse(row.data) as { nodeId: string }).nodeId === 'dev')?.timestamp;
    const [started] = (await h.store.query<{ timestamp: number }>("SELECT timestamp FROM events WHERE type = 'sharedNode.batchStarted'")).map((row) => row.timestamp);
    expect(eDone).toBeDefined();
    expect(started).toBeGreaterThanOrEqual(eDone ?? Number.MAX_SAFE_INTEGER);
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

  it('a batch is never run twice by one engine, even when not even its interruption can be recorded', async () => {
    await open();
    await defineShared(h, projectId, buildSpec({ batchTrigger: { count: 1 } }));
    enqueueBuild(h, buildPasses());
    enqueueBuild(h, buildPasses());
    const execute = h.bus.execute.bind(h.bus);
    h.bus.execute = (request: unknown, transport: TransportIdentity): Promise<CommandResponse> => {
      if ((request as { type?: string }).type === 'sharedNode.finish') return Promise.resolve({ ok: false, error: { code: 'internal', message: 'disk full', retryable: true } });
      return execute(request, transport);
    };
    await startTicket(h, projectId, 'A', {}, 'myteam/quick-flow');
    await h.drive();
    // A new request makes the scheduler look at the node again: the batch it ran is still recorded as running.
    await startTicket(h, projectId, 'B', {}, 'myteam/quick-flow');
    await h.drive();
    expect(h.processes.spawned).toHaveLength(1);
    expect(Object.keys((await sharedState(h, projectId)).running)).toEqual(['1']);
    h.errors.length = 0;
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
