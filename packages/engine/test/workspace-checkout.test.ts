import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DomainEvent, workspaceAggregateId } from '@vuyro/contracts';
import { EngineQueries } from '../src/daemon/queries.ts';
import { parcelWatcher } from '../src/workspace/watcher.ts';
import { type ScriptedBehavior, ScriptedAgentAdapter, type ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution } from '../src/workflow/state.ts';
import { CLI } from './helpers/engine-harness.ts';
import { openWorkflowHarness, SYSTEM, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { edge, expectOk, gitRepo, MINUTE, projectAt, save, template, ticketIn } from './helpers/workspace-fixtures.ts';

/**
 * Checkouts right before an edit (M4, [[공유·권한·BlackBoard 설계]] §3.8) and change detection afterwards:
 * - the hook refuses an edit of a file another node holds (and the node pauses until it is free);
 * - an edit through the hook is attributed to its holder;
 * - a change that went around the hook is found afterwards and flagged as unattributed.
 * The hook itself is `vuyro hook pretooluse` (CLI tests); here the agents send the same `checkout.acquire` it sends.
 */

type Step = (s: ScriptedSession) => Promise<unknown>;

/** Per node: what its agent does on each of its runs (1st, 2nd, …). */
function script(steps: Record<string, Step[]>): ScriptedBehavior {
  const runs = new Map<string, number>();
  return async (s) => {
    const index = runs.get(s.request.nodeId) ?? 0;
    runs.set(s.request.nodeId, index + 1);
    const step = steps[s.request.nodeId]?.[index] ?? steps[s.request.nodeId]?.at(-1);
    if (step === undefined) throw new Error(`no step for ${s.request.nodeId} run ${index + 1}`);
    const result = await step(s);
    if (s.cancelled) return { outcome: 'cancelled' };
    return result === 'cancelled' ? { outcome: 'cancelled' } : undefined;
  };
}

async function checkout(s: ScriptedSession, ...paths: string[]): Promise<{ granted: boolean; decision: string; reason?: string }> {
  const response = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, paths: paths.map((path) => join(s.request.cwd ?? '', path)), source: 'hook' });
  expectOk(response);
  return response.ok ? (response.result as { granted: boolean; decision: string; reason?: string }) : { granted: false, decision: 'error' };
}

function write(s: ScriptedSession, path: string, text: string): void {
  writeFileSync(join(s.request.cwd ?? '', path), text);
}

async function done(s: ScriptedSession): Promise<void> {
  if (s.cancelled) return;
  expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
}

/** Waits until cancelled (the engine paused the run). */
async function untilStopped(s: ScriptedSession): Promise<string> {
  await s.sleep(24 * 60 * MINUTE);
  return 'cancelled';
}

async function twoAgents(h: WorkflowHarness, settings: Record<string, unknown> = {}): Promise<void> {
  await save(
    h,
    template(
      'myteam/pair',
      [
        { id: 'a', type: 'vuyro.agent', version: 1, params: { instructions: 'a' } },
        { id: 'b', type: 'vuyro.agent', version: 1, params: { instructions: 'b' } },
        { id: 'endA', type: 'vuyro.end', version: 1 },
        { id: 'endB', type: 'vuyro.end', version: 1 },
      ],
      [edge('a', 'done', 'endA'), edge('b', 'done', 'endB')],
      settings,
    ),
  );
}

async function ledger(h: WorkflowHarness, projectId: string): Promise<DomainEvent[]> {
  return h.store.readAggregate(workspaceAggregateId(projectId));
}

async function changes(h: WorkflowHarness, projectId: string): Promise<{ path: string; attribution: string; node: string | null; suspects: string[]; scan: string }[]> {
  const rows = await h.store.query<{ path: string; attribution: string; node_id: string | null; suspects: string | null; scan: string }>(
    'SELECT path, attribution, node_id, suspects, scan FROM p_workspace_changes WHERE project_id = ? ORDER BY sequence, id',
    [projectId],
  );
  return rows.map((row) => ({
    path: row.path,
    attribution: row.attribution,
    node: row.node_id,
    scan: row.scan,
    suspects: row.suspects === null ? [] : (JSON.parse(row.suspects) as { nodeId: string }[]).map((holder) => holder.nodeId),
  }));
}

// Real git and file hashing: seconds per test, more under a full parallel run (the default 5 s timed out there).
describe('checkouts before edits and changes found afterwards', { timeout: 30_000 }, () => {
  let h: WorkflowHarness;
  let repo: string;

  afterEach(async () => {
    await h.close();
  });

  async function open(steps: Record<string, Step[]>): Promise<void> {
    h = await openWorkflowHarness({ behavior: script(steps) });
    repo = gitRepo(join(h.dir, 'repo'));
  }

  it('blocks an edit of a file another node checked out; the node pauses and edits it once the file is free', async () => {
    const results: string[] = [];
    await open({
      a: [
        async (s) => {
          await s.sleep(MINUTE / 2);
          results.push(`a:${(await checkout(s, 'src/app.txt')).decision}`);
          write(s, 'src/app.txt', 'by a\n');
          await s.sleep(10 * MINUTE);
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await s.sleep(MINUTE);
          const answer = await checkout(s, 'src/app.txt');
          results.push(`b:${answer.decision}`);
          expect(answer.reason).toContain("held by node 'a'");
          if (!answer.granted) return untilStopped(s);
          return undefined;
        },
        async (s) => {
          results.push(`b2:${(await checkout(s, 'src/app.txt')).decision}`);
          write(s, 'src/app.txt', 'by a\nby b\n');
          await done(s);
        },
      ],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.activity.idle();
    await h.clock.advance(2 * MINUTE);
    await h.activity.idle();
    expect(results).toEqual(['a:granted', 'b:wait']);
    expect(await h.status(ticketId, 'b')).toBe('paused');
    expect(currentExecution(await h.ticket(ticketId), 'b', 'main')?.claimWait).toMatchObject({ policy: 'firstWins', conflicts: [{ path: 'src/app.txt', holder: { nodeId: 'a' } }] });
    const blocked = (await ledger(h, projectId)).find((event) => event.type === 'checkout.blocked');
    expect(blocked?.data).toMatchObject({ source: 'hook', outcome: 'wait', paths: ['src/app.txt'] });

    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(results).toEqual(['a:granted', 'b:wait', 'b2:granted']);
    // Both edits went through the ledger: each is attributed to its holder.
    const found = await changes(h, projectId);
    expect(found.filter((change) => change.path === 'src/app.txt').map((change) => `${change.attribution}:${change.node ?? ''}`)).toEqual(['checkout:a', 'checkout:b']);
    expect(found.filter((change) => change.attribution === 'unattributed')).toEqual([]);
  });

  it('flags a change that went around the hook as unattributed, with the nodes that were running as suspects', async () => {
    await open({
      a: [
        async (s) => {
          // After b started (its start scan sees nothing yet).
          await s.sleep(MINUTE);
          await checkout(s, 'src/app.txt');
          write(s, 'src/app.txt', 'through the hook\n');
          // A shell command writes another file: no checkout.
          write(s, 'src/shell.txt', 'around the hook\n');
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await s.sleep(5 * MINUTE);
          await done(s);
        },
      ],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    const found = await changes(h, projectId);
    expect(found).toEqual([
      { path: 'src/app.txt', attribution: 'checkout', node: 'a', scan: 'finish', suspects: [] },
      { path: 'src/shell.txt', attribution: 'unattributed', node: null, scan: 'finish', suspects: ['a', 'b'] },
    ]);
    // Screens get the flagged ones.
    const queries = new EngineQueries({ store: h.store, definitions: h.registry, clock: h.clock });
    const view = await queries.workspace(projectId, { changes: 'flagged', limit: 50 });
    expect(view.changes.map((change) => change.path)).toEqual(['src/shell.txt']);
  });

  it('finds changes made while no node ran (a person, or the engine was down) and attributes them to nobody', async () => {
    await open({
      a: [
        async (s) => {
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await s.sleep(10 * MINUTE);
          await done(s);
        },
      ],
    });
    await save(
      h,
      template(
        'myteam/chain',
        [
          { id: 'a', type: 'vuyro.agent', version: 1, params: { instructions: 'a' } },
          { id: 'gate', type: 'vuyro.human-task', version: 1 },
          { id: 'b', type: 'vuyro.agent', version: 1, params: { instructions: 'b' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('a', 'done', 'gate'), edge('gate', 'done', 'b'), edge('b', 'done', 'end')],
      ),
    );
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/chain');
    await h.drive();
    // A person edits while the ticket waits for them; it is found when b starts.
    writeFileSync(join(repo, 'README.md'), '# edited by hand\n');
    await h.ok('node.done', { ticketId, nodeId: 'gate', port: 'done' });
    await h.activity.idle();
    expect(await changes(h, projectId)).toEqual([{ path: 'README.md', attribution: 'unattributed', node: null, scan: 'start', suspects: [] }]);
    // While the engine is down a file is deleted: found when it starts again.
    await h.restart({
      whileClosed: () => {
        unlinkSync(join(repo, 'src', 'app.txt'));
      },
    });
    await h.activity.idle();
    const found = await changes(h, projectId);
    // b was running when the engine stopped: it may have made the change before the engine went down.
    expect(found.at(-1)).toEqual({ path: 'src/app.txt', attribution: 'unattributed', node: null, scan: 'startup', suspects: ['b'] });
    const deleted = (await ledger(h, projectId)).filter((event) => event.type === 'workspace.changesDetected').at(-1);
    expect(deleted?.data).toMatchObject({ changes: [{ path: 'src/app.txt', hash: null }] });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('tells a resumed agent which of its checked-out files others changed while it was paused', async () => {
    let resumedPrompt = '';
    await open({
      a: [
        async (s) => {
          await s.sleep(MINUTE);
          await checkout(s, 'src/b.txt');
          write(s, 'src/b.txt', 'a was here\n');
          await s.sleep(10 * MINUTE);
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await checkout(s, 'src/notes.txt');
          write(s, 'src/notes.txt', 'b notes\n');
          await s.sleep(2 * MINUTE);
          // a holds src/b.txt now: b pauses (holding src/notes.txt).
          const answer = await checkout(s, 'src/b.txt');
          if (!answer.granted) return untilStopped(s);
          return undefined;
        },
        async (s) => {
          resumedPrompt = s.request.prompt;
          await checkout(s, 'src/b.txt');
          await done(s);
        },
      ],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.activity.idle();
    await h.clock.advance(3 * MINUTE);
    await h.activity.idle();
    expect(await h.status(ticketId, 'b')).toBe('paused');
    const paused = (await ledger(h, projectId)).find((event) => event.type === 'checkout.paused');
    expect(paused?.data).toMatchObject({ holder: { nodeId: 'b' } });
    // Someone changes b's checked-out file while b waits.
    writeFileSync(join(repo, 'src', 'notes.txt'), 'changed while b was paused\n');
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(resumedPrompt).toContain('## Changed while you were paused');
    expect(resumedPrompt).toContain('- src/notes.txt');
    const resumed = (await ledger(h, projectId)).find((event) => event.type === 'checkout.resumed');
    expect(resumed?.data).toMatchObject({ holder: { nodeId: 'b' }, changed: [{ path: 'src/notes.txt' }] });
    // The change was made while b held the file but did not run: a conflict, attributed to the holder.
    expect((await changes(h, projectId)).find((change) => change.path === 'src/notes.txt' && change.attribution === 'conflict')).toMatchObject({ node: 'b' });
  });

  it('fail at checkout time: the edit is refused and the node fails', async () => {
    await open({
      a: [
        async (s) => {
          await checkout(s, 'src/app.txt');
          await s.sleep(10 * MINUTE);
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await s.sleep(MINUTE);
          const answer = await checkout(s, 'src/app.txt');
          expect(answer).toMatchObject({ granted: false, decision: 'fail' });
          return untilStopped(s);
        },
      ],
    });
    await twoAgents(h, { onConflict: 'fail' });
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    expect(await h.status(ticketId, 'b')).toBe('failed');
    expect(currentExecution(await h.ticket(ticketId), 'b', 'main')?.output?.items[0]?.summary).toContain('checkout conflict (onConflict: fail)');
  });

  it('a deadlock between waiting nodes goes to a person whatever the policy', async () => {
    await open({
      a: [
        async (s) => {
          await checkout(s, 'src/x.txt');
          await s.sleep(2 * MINUTE);
          const answer = await checkout(s, 'src/y.txt');
          if (!answer.granted) return untilStopped(s);
          return undefined;
        },
        async (s) => {
          await checkout(s, 'src/y.txt');
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await checkout(s, 'src/y.txt');
          await s.sleep(5 * MINUTE);
          const answer = await checkout(s, 'src/x.txt');
          if (!answer.granted) return untilStopped(s);
          return undefined;
        },
        async (s) => {
          await checkout(s, 'src/x.txt');
          await done(s);
        },
      ],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.activity.idle();
    await h.clock.advance(6 * MINUTE);
    await h.activity.idle();
    expect([await h.status(ticketId, 'a'), await h.status(ticketId, 'b')]).toEqual(['paused', 'paused']);
    const blocks = (await ledger(h, projectId)).filter((event) => event.type === 'checkout.blocked').map((event) => event.data as { outcome: string; deadlock?: boolean });
    expect(blocks).toEqual([expect.objectContaining({ outcome: 'wait' }), expect.objectContaining({ outcome: 'ask', deadlock: true })]);
    expect(currentExecution(await h.ticket(ticketId), 'b', 'main')?.claimWait).toMatchObject({ ask: true, deadlock: true });
    // A person lets b go ahead: it overlaps on x, finishes, and a gets y.
    await h.ok('node.resume', { ticketId, nodeId: 'b' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('checks what an agent may check out: its own running lane only, inside the workspace, files not patterns', async () => {
    const answers: unknown[] = [];
    await open({
      a: [
        async (s) => {
          const { ticketId } = s.request;
          const as = (payload: Record<string, unknown>) => s.vuyro('checkout.acquire', { ticketId, nodeId: 'a', source: 'hook', ...payload });
          answers.push(await s.vuyro('checkout.acquire', { ticketId, nodeId: 'b', paths: ['src/app.txt'] }));
          answers.push(await as({ paths: ['src/*.txt'] }));
          answers.push(await as({ paths: [join(h.dir, 'outside.txt'), '../escape.txt'] }));
          answers.push(await as({ paths: ['src\\app.txt', 'SRC/App.txt'] }));
          await done(s);
        },
      ],
      b: [
        async (s) => {
          await s.sleep(MINUTE);
          await done(s);
        },
      ],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    const [otherNode, pattern, outside, same] = answers as { ok: boolean; error?: { code: string }; result?: { decision: string; paths?: string[] } }[];
    expect(otherNode?.error?.code).toBe('out_of_scope');
    expect(pattern?.error?.code).toBe('validation_failed');
    expect(outside?.result).toMatchObject({ decision: 'outside' });
    // One file, however it is spelled (Windows paths ignore case).
    expect(same?.result?.paths).toEqual(process.platform === 'win32' ? ['src/app.txt'] : ['src/app.txt', 'SRC/App.txt']);
    // Without a run token nobody may check out (read-only), and the engine-only bookkeeping is the engine's.
    const unverified = await h.exec('checkout.acquire', { ticketId, nodeId: 'a', lane: 'main', paths: ['src/app.txt'] }, CLI);
    expect(unverified.ok ? 'ok' : unverified.error.code).toBe('forbidden');
    const system = await h.exec('workspace.record', { projectId, op: 'baseline', space: 'root', files: {} }, SYSTEM);
    expect(system.ok).toBe(true);
  });

  it('a run that ended can no longer check out with its token', async () => {
    let token = '';
    await open({
      a: [
        async (s) => {
          token = s.request.env.VUYRO_RUN_TOKEN ?? '';
          return untilStopped(s);
        },
        async (s) => done(s),
      ],
      b: [async (s) => done(s)],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/pair');
    await h.activity.idle();
    // A person pauses a: its run is cancelled and settles, which revokes the token.
    await h.ok('node.pause', { ticketId, nodeId: 'a' });
    await h.activity.idle();
    expect(await h.status(ticketId, 'a')).toBe('paused');
    const stale = await h.bus.execute(
      { requestId: 'stale-checkout-1', type: 'checkout.acquire', payload: { ticketId, nodeId: 'a', paths: ['src/app.txt'] }, auth: { runToken: token } },
      CLI,
    );
    expect(stale.ok ? 'ok' : stale.error.code).toBe('unauthenticated');
  });

  it('asks the agent CLI for the hook in shared mode, not in worktree mode, and never for Codex when the workspace has Codex hooks', async () => {
    await open({ a: [async (s) => done(s)], b: [async (s) => done(s)] });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    expect(h.adapter.started.map((request) => request.checkoutHook)).toEqual([true, true]);
    const off = await projectAt(h, repo, { autoCheckoutHook: false });
    await ticketIn(h, off, 'myteam/pair');
    await h.drive();
    expect(h.adapter.started.slice(2).map((request) => request.checkoutHook)).toEqual([undefined, undefined]);
  });

  it('leaves the hook out of a Codex run when the workspace has Codex hooks of its own, and says so on the run', async () => {
    let codex: ScriptedAgentAdapter | undefined;
    h = await openWorkflowHarness({
      adapters: ({ clock, bus }) => {
        codex = new ScriptedAgentAdapter({ provider: 'codex', clock, bus, behavior: (s) => done(s).then(() => undefined) });
        return { codex };
      },
    });
    repo = gitRepo(join(h.dir, 'repo'));
    await save(
      h,
      template('myteam/codex', [{ id: 'a', type: 'vuyro.agent', version: 1, params: { instructions: 'a', provider: 'codex' } }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('a', 'done', 'end')]),
    );
    const projectId = await projectAt(h, repo);
    await ticketIn(h, projectId, 'myteam/codex');
    await h.drive();
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.codex', 'hooks.json'), '{"PreToolUse": []}\n');
    await ticketIn(h, projectId, 'myteam/codex');
    await h.drive();
    expect(codex?.started.map((request) => request.checkoutHook)).toEqual([true, undefined]);
    const warnings = await h.store.query<{ message: string }>("SELECT json_extract(data, '$.message') AS message FROM events WHERE type = 'run.warningRecorded'");
    expect(warnings.map((row) => row.message)).toEqual([expect.stringContaining('the workspace has its own Codex hooks')]);
  });

  it("leaves the hook out of a Codex run when the user's Codex folder has hooks.json (loaded even with --ignore-user-config)", async () => {
    let codex: ScriptedAgentAdapter | undefined;
    const home = join(tmpdir(), `vuyro-codex-home-${process.pid}-${Date.now()}`);
    mkdirSync(home);
    try {
      h = await openWorkflowHarness({
        codexHome: home,
        adapters: ({ clock, bus }) => {
          codex = new ScriptedAgentAdapter({ provider: 'codex', clock, bus, behavior: (s) => done(s).then(() => undefined) });
          return { codex };
        },
      });
      repo = gitRepo(join(h.dir, 'repo'));
      await save(
        h,
        template('myteam/codex', [{ id: 'a', type: 'vuyro.agent', version: 1, params: { instructions: 'a', provider: 'codex' } }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('a', 'done', 'end')]),
      );
      const projectId = await projectAt(h, repo);
      await ticketIn(h, projectId, 'myteam/codex');
      await h.drive();
      writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'herdr' }] }] } }));
      await ticketIn(h, projectId, 'myteam/codex');
      await h.drive();
      expect(codex?.started.map((request) => request.checkoutHook)).toEqual([true, undefined]);
      const warnings = await h.store.query<{ message: string }>("SELECT json_extract(data, '$.message') AS message FROM events WHERE type = 'run.warningRecorded'");
      expect(warnings.map((row) => row.message)).toEqual([expect.stringContaining('the user has Codex hooks of their own')]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an agent may not name another lane of its node, and a replaced run may not check out', async () => {
    const answers: string[] = [];
    await open({
      a: [async (s) => done(s)],
      b: [async (s) => done(s)],
      work: [
        async (s) => {
          if (s.request.lane === '1') {
            const response = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: 'work', lane: '2', paths: ['src/app.txt'] });
            answers.push(`lane:${response.ok ? 'ok' : response.error.code}`);
          }
          await done(s);
        },
      ],
      slow: [
        async (s) => {
          // Replaced by newer input while it runs: its run is cancelled, and its call comes in before the run settles.
          await s.sleep(60 * MINUTE);
          const response = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: 'slow', paths: ['src/app.txt'] });
          answers.push(`replaced:${response.ok ? 'ok' : response.error.code}`);
          return 'cancelled';
        },
        async (s) => done(s),
      ],
    });
    await save(
      h,
      template(
        'myteam/lanes',
        [
          { id: 'one', type: 'vuyro.human-task', version: 1 },
          { id: 'two', type: 'vuyro.human-task', version: 1 },
          { id: 'work', type: 'vuyro.agent', version: 1, params: { instructions: 'w' }, ports: { in: { mode: 'each' } } },
          { id: 'slow', type: 'vuyro.agent', version: 1, params: { instructions: 's' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('one', 'done', 'work'), edge('one', 'done', 'slow'), edge('two', 'done', 'slow'), edge('work', 'done', 'end'), edge('slow', 'done', 'end')],
      ),
    );
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/lanes');
    await h.ok('node.done', { ticketId, nodeId: 'one', port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }] });
    await h.activity.idle();
    await h.ok('node.done', { ticketId, nodeId: 'two', port: 'done' });
    await h.drive();
    expect(answers.sort()).toEqual(['lane:out_of_scope', 'replaced:invariant_violated']);
  });

  it('records the release of what a node checked out when it ends, and an agent may release its own checkouts early', async () => {
    let released: unknown;
    await open({
      a: [
        async (s) => {
          await checkout(s, 'src/one.txt', 'src/two.txt');
          const response = await s.vuyro('checkout.release', { ticketId: s.request.ticketId, nodeId: 'a', paths: [join(s.request.cwd ?? '', 'src/one.txt')] });
          released = response.ok ? response.result : response.error;
          await done(s);
        },
      ],
      b: [async (s) => done(s)],
    });
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    expect(released).toEqual({ released: 1 });
    const reasons = (await ledger(h, projectId)).filter((event) => event.type === 'checkout.released').map((event) => (event.data as { reason: string }).reason);
    expect(reasons).toEqual(['manual', 'nodeDone']);
  });

  it('works without git: changes are found from the ledger paths and the watcher candidates', async () => {
    h = await openWorkflowHarness({
      behavior: script({
        a: [
          async (s) => {
            await checkout(s, 'notes.txt');
            write(s, 'notes.txt', 'hello\n');
            await done(s);
          },
        ],
        b: [async (s) => done(s)],
      }),
    });
    const plain = join(h.dir, 'plain');
    mkdirSync(plain);
    await twoAgents(h);
    const projectId = await projectAt(h, plain);
    await ticketIn(h, projectId, 'myteam/pair');
    await h.drive();
    expect((await changes(h, projectId)).map((change) => `${change.attribution}:${change.path}`)).toEqual(['checkout:notes.txt']);
    rmSync(plain, { recursive: true, force: true });
  });

  it('the file watcher finds a change while an agent runs, before it ends', async () => {
    h = await openWorkflowHarness({
      behavior: script({
        a: [
          async (s) => {
            await s.sleep(30 * MINUTE);
            await done(s);
          },
        ],
        b: [async (s) => done(s)],
      }),
      watcher: parcelWatcher(),
    });
    repo = gitRepo(join(h.dir, 'repo'));
    await twoAgents(h);
    const projectId = await projectAt(h, repo);
    await ticketIn(h, projectId, 'myteam/pair');
    await h.activity.idle();
    // Real time: the watcher subscribes, then sees the edit; the scan waits a (virtual) second for more events.
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(join(repo, 'README.md'), '# edited while a runs\n');
    for (let attempt = 0; attempt < 100 && (h.clock.nextDueAt() ?? Infinity) > h.clock.now() + 1000; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await h.clock.advance(1000);
    await h.activity.idle();
    expect(await changes(h, projectId)).toEqual([{ path: 'README.md', attribution: 'unattributed', node: null, scan: 'watch', suspects: ['a'] }]);
    await h.drive();
  });
});
