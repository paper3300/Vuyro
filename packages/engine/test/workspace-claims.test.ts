import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaimSpec, DomainEvent, WorkspaceSettings } from '@vuyro/contracts';
import type { ScriptedBehavior } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { workspaceAggregateId } from '@vuyro/contracts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { edge, editorType, expectOk, MINUTE, projectAt, save, template, ticketIn } from './helpers/workspace-fixtures.ts';

/**
 * Claims (M4, [[공유·권한·BlackBoard 설계]] §3.7): two nodes that claim the same paths when they start. The conflict
 * policy decides: the later one waits and resumes on its own, fails, goes ahead with a warning, or waits for a person.
 */

/** Agents work for `minutes` of virtual time, then report done. */
function working(minutes: Record<string, number>): ScriptedBehavior {
  return async (s) => {
    await s.sleep((minutes[s.request.nodeId] ?? 1) * MINUTE);
    if (s.cancelled) return { outcome: 'cancelled' };
    expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
    return undefined;
  };
}

/** Two editors that both start at once (two entry nodes), each going to its own end. */
async function twoEditors(h: WorkflowHarness, claims: ClaimSpec[], settings?: WorkspaceSettings, id = 'myteam/two'): Promise<void> {
  await save(h, editorType('test.editor', claims));
  await save(
    h,
    template(
      id,
      [
        { id: 'a', type: 'test.editor', version: 1 },
        { id: 'b', type: 'test.editor', version: 1 },
        { id: 'endA', type: 'vuyro.end', version: 1 },
        { id: 'endB', type: 'vuyro.end', version: 1 },
      ],
      [edge('a', 'done', 'endA'), edge('b', 'done', 'endB')],
      settings,
    ),
  );
}

async function ledgerEvents(h: WorkflowHarness, projectId: string): Promise<DomainEvent[]> {
  return h.store.readAggregate(workspaceAggregateId(projectId));
}

async function heldPaths(h: WorkflowHarness, projectId: string): Promise<string[]> {
  const rows = await h.store.query<{ node_id: string; path: string }>('SELECT node_id, path FROM p_checkouts WHERE project_id = ? ORDER BY node_id', [projectId]);
  return rows.map((row) => `${row.node_id}:${row.path}`);
}

describe('claims and their conflict policies', () => {
  let h: WorkflowHarness;
  let root: string;

  afterEach(async () => {
    await h.close();
  });

  async function open(behavior: ScriptedBehavior): Promise<void> {
    h = await openWorkflowHarness({ behavior });
    root = join(h.dir, 'ws');
    mkdirSync(root, { recursive: true });
  }

  it('firstWins: the later node pauses for the claim and resumes once the holder is done', async () => {
    await open(working({ a: 10, b: 5 }));
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive' }]);
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.activity.idle();
    expect(await h.status(ticketId, 'a')).toBe('running');
    expect(await h.status(ticketId, 'b')).toBe('paused');
    const b = currentExecution(await h.ticket(ticketId), 'b', 'main');
    expect(b?.claimWait).toMatchObject({ policy: 'firstWins', conflicts: [{ path: 'src/**', holder: { nodeId: 'a', lane: 'main', run: 1 } }] });
    expect(await heldPaths(h, projectId)).toEqual(['a:src/**']);
    const blocked = (await ledgerEvents(h, projectId)).find((event) => event.type === 'checkout.blocked');
    expect(blocked?.data).toMatchObject({ outcome: 'wait', source: 'start', requester: { nodeId: 'b' } });
    // The board says why: the lane row carries the claim it waits for.
    const lane = await h.store.queryOne<{ waiting_for: string }>("SELECT waiting_for FROM p_node_lanes WHERE ticket_id = ? AND node_id = 'b'", [ticketId]);
    expect(JSON.parse(lane?.waiting_for ?? 'null')).toMatchObject({ conflicts: [{ holder: { nodeId: 'a' } }] });

    await h.drive();
    const state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    // b ran only after a: its execution was paused, then resumed and started.
    const events = await h.store.readAggregate(ticketId);
    const order = events
      .filter((event) => ['node.started', 'node.completed', 'node.paused', 'node.resumed'].includes(event.type) && ['a', 'b'].includes((event.data as { nodeId: string }).nodeId))
      .map((event) => `${event.type}:${(event.data as { nodeId: string }).nodeId}`);
    expect(order.slice(0, 6)).toEqual(['node.started:a', 'node.paused:b', 'node.completed:a', 'node.resumed:b', 'node.started:b', 'node.completed:b']);
    const resumed = events.find((event) => event.type === 'node.resumed');
    expect(resumed?.actor).toEqual({ kind: 'system', component: 'workspace' });
    expect(await heldPaths(h, projectId)).toEqual([]);
    const released = (await ledgerEvents(h, projectId)).filter((event) => event.type === 'checkout.released').map((event) => (event.data as { reason: string }).reason);
    expect(released).toEqual(['nodeDone', 'nodeDone']);
  });

  it('shared claims do not conflict with each other, but an exclusive one does', async () => {
    await open(working({ a: 10, b: 5 }));
    await save(h, editorType('test.reader', [{ path: 'docs/**', mode: 'shared' }]));
    await save(h, editorType('test.writer', [{ path: 'docs/spec.md', mode: 'exclusive' }]));
    await save(
      h,
      template(
        'myteam/readers',
        [
          { id: 'a', type: 'test.reader', version: 1 },
          { id: 'b', type: 'test.reader', version: 1 },
          { id: 'c', type: 'test.writer', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('a', 'done', 'end'), edge('b', 'done', 'end'), edge('c', 'done', 'end')],
      ),
    );
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/readers');
    await h.activity.idle();
    expect([await h.status(ticketId, 'a'), await h.status(ticketId, 'b'), await h.status(ticketId, 'c')]).toEqual(['running', 'running', 'paused']);
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('fail: the later node fails with the conflict, and a person can retry it later', async () => {
    await open(working({ a: 10, b: 5 }));
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive' }], { onConflict: 'fail' });
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.activity.idle();
    expect(await h.status(ticketId, 'b')).toBe('failed');
    const failed = currentExecution(await h.ticket(ticketId), 'b', 'main');
    expect(failed?.output?.items[0]?.data).toMatchObject({ conflicts: [{ holder: { nodeId: 'a' } }] });
    expect(((await ledgerEvents(h, projectId)).find((event) => event.type === 'checkout.blocked')?.data as { outcome: string }).outcome).toBe('fail');
    await h.drive();
    expect(await h.status(ticketId, 'a')).toBe('done');
    await h.ok('node.retry', { ticketId, nodeId: 'b' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('warn: both run, and the overlap is recorded', async () => {
    await open(working({ a: 10, b: 5 }));
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive' }], { onConflict: 'warn' });
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.activity.idle();
    expect([await h.status(ticketId, 'a'), await h.status(ticketId, 'b')]).toEqual(['running', 'running']);
    const acquired = (await ledgerEvents(h, projectId)).filter((event) => event.type === 'checkout.acquired');
    expect(acquired[1]?.data).toMatchObject({ overlaps: [{ path: 'src/**', holder: { nodeId: 'a' } }] });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('a claim may carry its own policy over the settings', async () => {
    await open(working({ a: 10, b: 5 }));
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive', onConflict: 'fail' }], { onConflict: 'warn' });
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.activity.idle();
    expect(await h.status(ticketId, 'b')).toBe('failed');
  });

  it('ask: the later node waits for a person; resuming it lets it go ahead with the overlap recorded', async () => {
    await open(working({ a: 30, b: 5 }));
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive' }], { onConflict: 'ask' });
    const projectId = await projectAt(h, root);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.activity.idle();
    expect(await h.status(ticketId, 'b')).toBe('paused');
    expect(currentExecution(await h.ticket(ticketId), 'b', 'main')?.claimWait).toMatchObject({ ask: true });
    await h.ok('node.resume', { ticketId, nodeId: 'b' }, HUMAN);
    await h.activity.idle();
    expect([await h.status(ticketId, 'a'), await h.status(ticketId, 'b')]).toEqual(['running', 'running']);
    const resumed = (await h.store.readAggregate(ticketId)).find((event) => event.type === 'node.resumed');
    expect(resumed?.data).toMatchObject({ override: true });
    const acquired = (await ledgerEvents(h, projectId)).filter((event) => event.type === 'checkout.acquired');
    expect(acquired.at(-1)?.data).toMatchObject({ overlaps: [{ holder: { nodeId: 'a' } }] });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('claims of different tickets in the same project conflict; other projects are separate', async () => {
    await open(working({ a: 10, b: 10 }));
    await save(h, editorType('test.editor', [{ path: 'src/**', mode: 'exclusive' }]));
    await save(h, template('myteam/one', [{ id: 'a', type: 'test.editor', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('a', 'done', 'end')]));
    const projectId = await projectAt(h, root);
    const first = await ticketIn(h, projectId, 'myteam/one');
    const second = await ticketIn(h, projectId, 'myteam/one');
    const otherRoot = join(h.dir, 'other');
    mkdirSync(otherRoot);
    const otherProject = await projectAt(h, otherRoot);
    const third = await ticketIn(h, otherProject, 'myteam/one');
    await h.activity.idle();
    expect([await h.status(first, 'a'), await h.status(second, 'a'), await h.status(third, 'a')]).toEqual(['running', 'paused', 'running']);
    await h.drive();
    for (const ticketId of [first, second, third]) expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('priorityWins with immediate pausing: a higher-priority ticket takes the paths and the holder resumes its session later', async () => {
    const prompts: string[] = [];
    await open(async (s) => {
      prompts.push(`${s.request.ticketId.slice(-4)}:${s.request.resume === undefined ? 'new' : 'resume'}`);
      s.observe({ kind: 'session', providerSessionId: `session-${s.request.runId}` });
      await s.sleep(10 * MINUTE);
      if (s.cancelled) return { outcome: 'cancelled' };
      expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
      return undefined;
    });
    await save(h, editorType('test.editor', [{ path: 'src/**', mode: 'exclusive', pauseMode: 'immediate' }]));
    await save(
      h,
      template('myteam/one', [{ id: 'a', type: 'test.editor', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('a', 'done', 'end')], { onConflict: 'priorityWins' }),
    );
    const projectId = await projectAt(h, root);
    const low = await ticketIn(h, projectId, 'myteam/one', { priority: 0 });
    await h.activity.idle();
    expect(await h.status(low, 'a')).toBe('running');
    await h.clock.advance(3 * MINUTE);
    const high = await ticketIn(h, projectId, 'myteam/one', { priority: 5 });
    await h.activity.idle();
    expect(await h.status(high, 'a')).toBe('running');
    expect(await h.status(low, 'a')).toBe('paused');
    const lowExec = currentExecution(await h.ticket(low), 'a', 'main');
    expect(lowExec?.claimWait).toMatchObject({ policy: 'priorityWins', preemptedBy: { ticketId: high } });
    const released = (await ledgerEvents(h, projectId)).find((event) => event.type === 'checkout.released');
    expect(released?.data).toMatchObject({ reason: 'preempted' });

    await h.drive();
    expect((await h.ticket(high)).status).toBe('done');
    expect((await h.ticket(low)).status).toBe('done');
    // The low ticket's agent went on with its own session after the high one finished.
    expect(prompts).toEqual([`${low.slice(-4)}:new`, `${high.slice(-4)}:new`, `${low.slice(-4)}:resume`]);
  });

  it('priorityWins without immediate pausing waits like firstWins', async () => {
    await open(working({ a: 10 }));
    await save(h, editorType('test.editor', [{ path: 'src/**', mode: 'exclusive' }]));
    await save(h, template('myteam/one', [{ id: 'a', type: 'test.editor', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('a', 'done', 'end')], { onConflict: 'priorityWins' }));
    const projectId = await projectAt(h, root);
    const low = await ticketIn(h, projectId, 'myteam/one', { priority: 0 });
    await h.activity.idle();
    const high = await ticketIn(h, projectId, 'myteam/one', { priority: 5 });
    await h.activity.idle();
    expect([await h.status(low, 'a'), await h.status(high, 'a')]).toEqual(['running', 'paused']);
    await h.drive();
    expect((await h.ticket(high)).status).toBe('done');
  });

  it('ticketDone claims outlive their node: later nodes of the same ticket go ahead, other tickets wait for the ticket', async () => {
    await open(working({ a: 10, c: 10 }));
    await save(h, editorType('test.keeper', [{ path: 'src/**', mode: 'exclusive', release: 'ticketDone' }]));
    await save(h, editorType('test.editor', [{ path: 'src/**', mode: 'exclusive' }]));
    await save(
      h,
      template(
        'myteam/keep',
        [
          { id: 'a', type: 'test.keeper', version: 1 },
          { id: 'c', type: 'test.editor', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('a', 'done', 'c'), edge('c', 'done', 'end')],
      ),
    );
    await save(h, template('myteam/one', [{ id: 'x', type: 'test.editor', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('x', 'done', 'end')]));
    const projectId = await projectAt(h, root);
    const keeper = await ticketIn(h, projectId, 'myteam/keep');
    await h.activity.idle();
    await h.clock.advance(11 * MINUTE);
    await h.activity.idle();
    // a finished: its claim is kept for the ticket, and c (same ticket) is not blocked by it.
    expect(await h.status(keeper, 'c')).toBe('running');
    const retained = (await ledgerEvents(h, projectId)).find((event) => event.type === 'checkout.retained');
    expect(retained).toBeDefined();
    const other = await ticketIn(h, projectId, 'myteam/one');
    await h.activity.idle();
    expect(await h.status(other, 'x')).toBe('paused');
    await h.drive();
    expect((await h.ticket(keeper)).status).toBe('done');
    expect((await h.ticket(other)).status).toBe('done');
    const reasons = (await ledgerEvents(h, projectId)).filter((event) => event.type === 'checkout.released').map((event) => (event.data as { reason: string }).reason);
    expect(reasons).toContain('ticketDone');
  });

  it('a claim with a ttl expires on its own; a manual one stays until a person releases it', async () => {
    await open(working({ a: 1, b: 1 }));
    await save(h, editorType('test.manual', [{ path: 'src/**', mode: 'exclusive', release: 'manual' }]));
    await save(h, editorType('test.ttl', [{ path: 'docs/**', mode: 'exclusive', release: 'manual', ttl: '2h' }]));
    await save(h, editorType('test.editor', [{ path: 'src/**', mode: 'exclusive' }]));
    await save(h, editorType('test.doc', [{ path: 'docs/**', mode: 'exclusive' }]));
    await save(
      h,
      template(
        'myteam/hold',
        [
          { id: 'a', type: 'test.manual', version: 1 },
          { id: 'b', type: 'test.ttl', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('a', 'done', 'end'), edge('b', 'done', 'end')],
      ),
    );
    await save(
      h,
      template(
        'myteam/after',
        [
          { id: 'x', type: 'test.editor', version: 1 },
          { id: 'y', type: 'test.doc', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('x', 'done', 'end'), edge('y', 'done', 'end')],
      ),
    );
    const projectId = await projectAt(h, root);
    const holder = await ticketIn(h, projectId, 'myteam/hold');
    // Not drive(): it would run the clock up to the ttl.
    await h.activity.idle();
    await h.clock.advance(2 * MINUTE);
    await h.activity.idle();
    expect((await h.ticket(holder)).status).toBe('done');
    const later = await ticketIn(h, projectId, 'myteam/after');
    await h.activity.idle();
    expect([await h.status(later, 'x'), await h.status(later, 'y')]).toEqual(['paused', 'paused']);
    // Two hours after it was taken the ttl entry is gone and y goes; x still waits for the manual one.
    await h.clock.advance(2 * 60 * MINUTE);
    await h.activity.idle();
    await h.drive();
    expect(await h.status(later, 'y')).toBe('done');
    expect(await h.status(later, 'x')).toBe('paused');
    const reasons = (await ledgerEvents(h, projectId)).filter((event) => event.type === 'checkout.released').map((event) => (event.data as { reason: string }).reason);
    expect(reasons).toContain('expired');
    const manual = await h.store.query<{ entry_id: string }>("SELECT entry_id FROM p_checkouts WHERE project_id = ? AND release = 'manual'", [projectId]);
    expect(manual).toHaveLength(1);
    await h.ok('checkout.forceRelease', { projectId, ids: manual.map((row) => row.entry_id) });
    await h.drive();
    expect((await h.ticket(later)).status).toBe('done');
  });

  it('agents may not release entries by id, nor configure the project (person only)', async () => {
    await open(working({ a: 1 }));
    const projectId = await projectAt(h, root);
    const cli = { kind: 'engine-token', client: 'cli' } as const;
    const forced = await h.exec('checkout.forceRelease', { projectId, ids: ['01900000-0000-7000-8000-000000000000'] }, cli);
    expect(forced.ok ? 'ok' : forced.error.code).toBe('forbidden');
    const configured = await h.exec('project.configure', { projectId, root: 'C:\\elsewhere' }, cli);
    expect(configured.ok ? 'ok' : configured.error.code).toBe('forbidden');
    const recorded = await h.exec('workspace.record', { projectId, op: 'release', ids: ['01900000-0000-7000-8000-000000000000'], reason: 'manual' }, HUMAN);
    expect(recorded.ok ? 'ok' : recorded.error.code).toBe('forbidden');
  });

  it('a ticket pins the app and project settings it was created with', async () => {
    await open(working({ a: 1 }));
    await h.ok('app.configure', { settings: { onConflict: 'warn', pauseMode: 'immediate' } });
    const projectId = await projectAt(h, root, { onConflict: 'ask' });
    await twoEditors(h, [{ path: 'src/**', mode: 'exclusive' }]);
    const ticketId = await ticketIn(h, projectId, 'myteam/two');
    await h.ok('project.configure', { projectId, settings: { onConflict: 'fail' } });
    const state = await h.ticket(ticketId);
    expect(state.workspace).toEqual({ root, settings: { onConflict: 'ask', pauseMode: 'immediate' } });
    await h.activity.idle();
    expect(currentExecution(await h.ticket(ticketId), 'b', 'main')?.claimWait).toMatchObject({ ask: true });
    expect(nodeProgress(await h.ticket(ticketId), 'b').executions).toHaveLength(1);
  });
});
