import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceAggregateId } from '@vuyro/contracts';
import { EngineQueries } from '../src/daemon/queries.ts';
import { evolveLedger, EMPTY_LEDGER } from '../src/workspace/ledger.ts';
import { currentExecution } from '../src/workflow/state.ts';
import {
  buildFails,
  buildPasses,
  defineShared,
  devAgents,
  during,
  edits,
  enqueueBuild,
  MINUTE,
  saveBuildFlow,
  sharedState,
  sourceFolder,
  startTicket,
} from './helpers/shared-fixtures.ts';
import { openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { projectAt } from './helpers/workspace-fixtures.ts';

/**
 * Shared nodes (M5, [[공유·권한·BlackBoard 설계]] §4), the milestone's completion test: three tickets queue for one
 * build and are built together; when the build breaks, the ticket that changed the broken file goes back through its
 * error port, the shared node is blocked, the others wait at the front of the queue, and once the culprit is fixed all
 * three are built again together.
 */

describe('shared node: three tickets, one build, blame and rebuild', { timeout: 30_000 }, () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  it('builds three queued tickets at once; a break blames its ticket, blocks the node, and rebuilds all after the fix', async () => {
    const seen: Record<string, unknown> = {};
    h = await openWorkflowHarness();
    const root = sourceFolder(join(h.dir, 'project'), ['src/a.c', 'src/b.c', 'src/c.c']);
    const projectId = await projectAt(h, root);
    await saveBuildFlow(h);
    await defineShared(h, projectId);

    h.setBehavior(
      devAgents(h, {
        A: [edits('src/a.c')],
        C: [edits('src/c.c')],
        B: [
          edits('src/b.c', 'broken'),
          // The fix: while B's developer works on it, the node is blocked and A and C wait at the front of the queue.
          async (s) => {
            const state = await sharedState(h, projectId);
            seen.blocked = state.blocked;
            seen.queueWhileBlocked = state.queue.map((entry) => ({ ticket: entry.ticketId, retry: entry.retry === true }));
            seen.feedback = currentExecution(await h.ticket(s.request.ticketId), 'dev', 'main')?.inputs;
            await edits('src/b.c', 'fixed')(s, 'B');
          },
        ],
      }),
    );

    // Batch 1 breaks in b.c; batch 2 passes. While batch 1 runs, the ledger holds the protected sources.
    enqueueBuild(h, [
      during(h, async () => {
        seen.duringBatch = await Promise.all(Object.values(tickets).map((ticketId) => h.status(ticketId, 'build')));
        let ledger = EMPTY_LEDGER;
        for (const event of await h.store.readAggregate(workspaceAggregateId(projectId))) ledger = evolveLedger(ledger, event);
        seen.protect = Object.values(ledger.entries)
          .filter((entry) => entry.path === 'src/**')
          .map((entry) => `${entry.mode}:${entry.holder.nodeId}`);
      }),
      ...buildFails(`${join(root, 'src', 'b.c')}(12): error C2065: 'x': undeclared identifier`, 'Build failed: 1 error(s).'),
    ]);
    enqueueBuild(h, buildPasses());

    const tickets: Record<string, string> = {};
    for (const title of ['A', 'B', 'C']) tickets[title] = await startTicket(h, projectId, title);
    await h.drive();
    expect(h.errors).toEqual([]);

    // One build for the three, then one for the three again.
    expect(h.processes.spawned.map((spawn) => spawn.spec.command)).toEqual(['build-tool', 'build-tool']);
    // In the project folder, without a shell and without the engine's environment.
    expect(h.processes.spawned.map((spawn) => spawn.spec.cwd)).toEqual([root, root]);
    expect(h.processes.spawned[0]?.spec.env).toEqual({ PATH: '/bin' });
    expect(seen.duringBatch).toEqual(['running', 'running', 'running']);
    expect(seen.protect).toEqual(['shared:build', 'shared:build', 'shared:build']);

    const state = await sharedState(h, projectId);
    const [first, second] = state.recent;
    const ticketsOf = (members: readonly { ticketId: string }[] | undefined) => (members ?? []).map((member) => Object.keys(tickets).find((title) => tickets[title] === member.ticketId));
    expect(first?.trigger).toBe('count');
    expect(ticketsOf(first?.members).sort()).toEqual(['A', 'B', 'C']);
    expect(first?.outcome).toBe('failed');
    expect(first?.policy).toBe('blame');
    expect(ticketsOf(first?.failed)).toEqual(['B']);
    expect(first?.errorFiles).toEqual(['src/b.c']);

    // While B was being fixed: blocked by B; A and C waited at the front of the queue.
    expect((seen.blocked as { reason: string; by: { ticketId: string }[] }).reason).toBe('blamed');
    expect(ticketsOf((seen.blocked as { by: { ticketId: string }[] }).by)).toEqual(['B']);
    expect(seen.queueWhileBlocked).toEqual([
      { ticket: tickets.A, retry: true },
      { ticket: tickets.C, retry: true },
    ]);
    // B's developer got the error that blamed it.
    const feedback = (seen.feedback as { in: { data: { errorsForThisTicket: string[]; batchId: string; errorFiles: string[] } }[] }).in[0]?.data;
    expect(feedback?.batchId).toBe('build-1');
    expect(feedback?.errorFiles).toEqual(['src/b.c']);
    expect(feedback?.errorsForThisTicket[0]).toContain("error C2065: 'x'");

    // The fix came back: all three were built together again (the waiting two first), and passed.
    expect(second?.trigger).toBe('retry');
    expect(ticketsOf(second?.members)).toEqual(['A', 'C', 'B']);
    expect(second?.outcome).toBe('succeeded');
    expect(state.blocked).toBeUndefined();
    expect(state.queue).toEqual([]);
    expect(state.running).toEqual({});

    for (const title of ['A', 'B', 'C']) {
      const ticket = await h.ticket(tickets[title] ?? '');
      expect(ticket.status, title).toBe('done');
      const build = currentExecution(ticket, 'build', 'main');
      expect(build?.output?.port, title).toBe('done');
      expect(build?.output?.items[0]?.data, title).toMatchObject({ batchId: 'build-2', errorsForThisTicket: [] });
      expect([...((build?.output?.items[0]?.data as { batch: string[] }).batch)].sort()).toEqual(Object.values(tickets).sort());
    }
    // The batch's claims went with it.
    let ledger = EMPTY_LEDGER;
    for (const event of await h.store.readAggregate(workspaceAggregateId(projectId))) ledger = evolveLedger(ledger, event);
    expect(Object.values(ledger.entries)).toEqual([]);
    // A's and C's build requests ran twice without failing; B's failed once.
    expect(currentExecution(await h.ticket(tickets.A ?? ''), 'build', 'main')?.run).toBe(1);
    expect(currentExecution(await h.ticket(tickets.B ?? ''), 'build', 'main')?.run).toBe(2);

    // What screens and `vuyro shared show` read.
    const [view] = await new EngineQueries({ store: h.store, definitions: h.registry, clock: h.clock }).sharedNodes(projectId);
    expect(view).toMatchObject({ name: 'build', label: 'Build station', version: 1, status: 'idle', queue: [], running: [] });
    expect(view?.recent.map((batch) => [batch.batchId, batch.outcome, batch.policy, batch.failed])).toEqual([
      ['build-2', 'succeeded', undefined, []],
      ['build-1', 'failed', 'blame', [tickets.B]],
    ]);
    expect((view?.recent[1]?.finishedAt ?? 0) - (view?.recent[1]?.startedAt ?? 0)).toBe(5 * MINUTE);
  });
});
