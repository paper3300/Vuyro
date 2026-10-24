import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceAggregateId } from '@vuyro/contracts';
import { EngineQueries } from '../src/daemon/queries.ts';
import type { ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { gitEnvironment, isRepositoryTop, nodeGitExec } from '../src/workspace/git.ts';
import { laneWorktree, ticketWorktree } from '../src/workspace/layout.ts';
import { CLI } from './helpers/engine-harness.ts';
import { openWorkflowHarness, SYSTEM, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { edge, editorType, expectOk, git, gitRepo, MINUTE, projectAt, save, template, ticketIn } from './helpers/workspace-fixtures.ts';
import { CLEAN, type ParallelTicket, startParallel } from './helpers/worktree-fixtures.ts';

/**
 * Worktree mode (M4, [[공유·권한·BlackBoard 설계]] §3.9): fan-out lanes work in git worktrees of their own, the join
 * merges their branches into the ticket branch, and the worktrees go away once merged or when the ticket completes.
 * Merge conflicts are in workspace-merge.test.ts.
 */

describe('worktree mode', { timeout: 120_000 }, () => {
  let t: ParallelTicket | undefined;
  let h: WorkflowHarness | undefined;

  afterEach(async () => {
    await (t?.h ?? h)?.close();
    t = undefined;
    h = undefined;
  });

  it('runs each lane in its own worktree, merges them at the join, and cleans up', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', worktreeScope: 'nodeRun' }, dev: CLEAN });
    const { h, ticketId, projectId, seen, repo } = t;
    await h.activity.idle();
    const root = h.workspaces.layout.worktreeRoot;
    const ticketTree = ticketWorktree(root, ticketId);
    const lane1 = laneWorktree(root, ticketId, 'dev', '1');
    const lane2 = laneWorktree(root, ticketId, 'dev', '2');
    // Plan works in the ticket's worktree; each dev lane in its own, on its own branch from the ticket branch.
    expect(seen.map((request) => `${request.nodeId}/${request.lane}@${request.cwd ?? ''}`)).toEqual([
      `plan/main@${ticketTree.path}`,
      `dev/1@${lane1.path}`,
      `dev/2@${lane2.path}`,
    ]);
    expect(git(lane1.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`vuyro/${ticketId}/dev-1`);
    expect(existsSync(join(lane1.path, 'PLAN.md'))).toBe(true);
    // Worktree mode: the checkout hook is off by default.
    expect(seen.every((request) => request.checkoutHook !== true)).toBe(true);

    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('done');
    expect(await h.status(ticketId, 'qa')).toBe('review');
    const head = git(ticketTree.path, 'rev-parse', 'HEAD');
    expect(git(ticketTree.path, 'show', `${head}:lane-1.txt`)).toBe('work of lane 1');
    expect(git(ticketTree.path, 'show', `${head}:lane-2.txt`)).toBe('work of lane 2');
    const joined = currentExecution(await h.ticket(ticketId), 'join', 'main');
    expect(joined?.executor).toBe('merge');
    expect(joined?.output?.items.map((item) => item.artifacts?.mergedBranch)).toEqual([
      { kind: 'git', uri: ticketTree.branch, version: head },
      { kind: 'git', uri: ticketTree.branch, version: head },
    ]);
    // Merged lanes' worktrees and branches are gone; the ticket's worktree stays while the ticket is open.
    expect(existsSync(lane1.path) || existsSync(lane2.path)).toBe(false);
    expect(t.branches()).toEqual(['main', ticketTree.branch]);
    const removed = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'worktree.removed');
    expect(removed.map((event) => (event.data as { reason: string }).reason)).toEqual(['merged', 'merged']);
    // Each change was made in the engine's own worktrees by the one execution there: nothing is flagged.
    const flagged = await h.store.query("SELECT path FROM p_workspace_changes WHERE attribution IN ('unattributed', 'conflict')");
    expect(flagged).toEqual([]);

    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    // The ticket's result is its branch; every worktree of the ticket is gone.
    expect(existsSync(ticketTree.path)).toBe(false);
    expect(t.worktreeList()).toHaveLength(1);
    expect(t.branches()).toEqual(['main', ticketTree.branch]);
    expect(git(repo, 'show', `${ticketTree.branch}:lane-2.txt`)).toBe('work of lane 2');
    // The person's own branch and working folder were not touched.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('keeps a worktree with uncommitted changes instead of removing it, until they are committed (D-041)', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', worktreeScope: 'nodeRun' }, dev: CLEAN });
    const { h, ticketId, projectId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'qa')).toBe('review');
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    // While QA waits for a person, someone adds a file in the ticket's worktree and changes a committed one.
    writeFileSync(join(ticketTree.path, 'notes.txt'), 'my notes\n');
    writeFileSync(join(ticketTree.path, 'lane-1.txt'), 'edited by hand\n');

    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    // Nothing is lost: the worktree is still there with both changes, and the ledger says why.
    expect(readFileSync(join(ticketTree.path, 'notes.txt'), 'utf8')).toBe('my notes\n');
    expect(readFileSync(join(ticketTree.path, 'lane-1.txt'), 'utf8')).toBe('edited by hand\n');
    const kinds = async () => (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'worktree.kept' || event.type === 'worktree.removed');
    expect((await kinds()).map((event) => [event.type, event.data])).toEqual([
      ['worktree.removed', expect.objectContaining({ reason: 'merged' }) as unknown],
      ['worktree.removed', expect.objectContaining({ reason: 'merged' }) as unknown],
      [
        'worktree.kept',
        { projectId, ticketId, key: ticketTree.key, removal: 'ticketDone', reason: 'uncommitted', files: ['lane-1.txt', 'notes.txt'], count: 2, ignored: [], ignoredCount: 0 },
      ],
    ]);
    const shown = await new EngineQueries({ store: h.store, definitions: h.registry, clock: h.clock }).workspace(projectId, { changes: 'flagged', limit: 100 });
    expect(shown.worktrees.find((row) => row.key === ticketTree.key)).toMatchObject({ removedAt: null, keptReason: 'uncommitted', keptFiles: ['lane-1.txt', 'notes.txt'], keptCount: 2 });

    // Looked at again (engine start), unchanged: still kept, recorded once.
    await h.restart();
    await h.drive();
    expect(existsSync(join(ticketTree.path, 'notes.txt'))).toBe(true);
    expect((await kinds()).filter((event) => event.type === 'worktree.kept')).toHaveLength(1);

    // Once the person committed their work, the worktree holds nothing more and goes; the branch keeps what was committed.
    git(ticketTree.path, 'add', '--all');
    git(ticketTree.path, '-c', 'user.name=Person', '-c', 'user.email=person@localhost', 'commit', '--quiet', '-m', 'notes');
    await h.restart();
    await h.drive();
    expect(existsSync(ticketTree.path)).toBe(false);
    expect((await kinds()).at(-1)?.type).toBe('worktree.removed');
    expect(git(t.repo, 'show', `${ticketTree.branch}:notes.txt`)).toBe('my notes');
  });

  it('keeps a worktree that holds only ignored files; a person removes it after seeing them, and only as it was shown (D-042)', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', worktreeScope: 'nodeRun' }, dev: CLEAN });
    const { h, ticketId, projectId, repo } = t;
    await h.drive();
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    // A file git ignores (local settings, build output): git status does not show it, removing the worktree would delete it.
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.local\n');
    writeFileSync(join(ticketTree.path, 'secret.local'), 'my local settings\n');
    expect(git(ticketTree.path, 'status', '--porcelain')).toBe('');

    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(readFileSync(join(ticketTree.path, 'secret.local'), 'utf8')).toBe('my local settings\n');
    const kept = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'worktree.kept');
    expect(kept.map((event) => event.data)).toEqual([
      { projectId, ticketId, key: ticketTree.key, removal: 'ticketDone', reason: 'ignored', files: [], count: 0, ignored: ['secret.local'], ignoredCount: 1 },
    ]);
    await h.restart();
    await h.drive();
    expect(existsSync(join(ticketTree.path, 'secret.local'))).toBe(true);

    // The clean-up list shows the ignored file and a fingerprint of what is there.
    const engine = h.engine;
    if (engine === undefined) throw new Error('no engine');
    const [shown] = await engine.workspaces.cleanupCandidates(projectId);
    expect(shown).toMatchObject({ key: ticketTree.key, path: ticketTree.path, files: [], ignored: ['secret.local'], ignoredCount: 1 });
    const fingerprint = shown?.fingerprint ?? '';
    // Only a person: an agent, an unverified client or the engine itself is refused.
    for (const transport of [CLI, SYSTEM]) {
      const refused = await h.exec('worktree.cleanup', { projectId, key: ticketTree.key, fingerprint }, transport);
      expect(refused.ok ? 'ok' : refused.error.code).toBe('forbidden');
    }

    // It changed after it was shown: the approval is dropped and nothing is removed.
    writeFileSync(join(ticketTree.path, 'secret.local'), 'changed after the look\n');
    await h.ok('worktree.cleanup', { projectId, key: ticketTree.key, fingerprint });
    await h.drive();
    expect(readFileSync(join(ticketTree.path, 'secret.local'), 'utf8')).toBe('changed after the look\n');
    const skipped = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'worktree.cleanupSkipped');
    expect(skipped.map((event) => (event.data as { reason: string }).reason)).toEqual(['changed']);

    // Looked at again and confirmed: removed with what it held. The ticket branch stays.
    const [again] = await engine.workspaces.cleanupCandidates(projectId);
    expect(again?.fingerprint).not.toBe(fingerprint);
    await h.ok('worktree.cleanup', { projectId, key: ticketTree.key, fingerprint: again?.fingerprint ?? '' });
    await h.drive();
    expect(existsSync(ticketTree.path)).toBe(false);
    const removed = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'worktree.removed').at(-1);
    expect(removed?.data).toMatchObject({ key: ticketTree.key, reason: 'manual' });
    expect(t.branches()).toContain(ticketTree.branch);
    expect(await engine.workspaces.cleanupCandidates(projectId)).toEqual([]);
  });

  it("a merging join takes its node type's claims: it waits for a claim and merges once the paths are free", async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, lane, cwd } = s.request;
        if (nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: {} }, { data: {} }] }));
        } else if (nodeId === 'dev') {
          await s.sleep(MINUTE);
          writeFileSync(join(cwd ?? '', `lane-${lane}.txt`), `work of lane ${lane}\n`);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: {} }));
        } else {
          // `side` works in the ticket's worktree and holds src/** for half an hour.
          await s.sleep(30 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: {} }));
        }
        return undefined;
      },
    });
    const repo = gitRepo(join(h.dir, 'repo'));
    await save(h, editorType('test.side', [{ path: 'src/**', mode: 'exclusive' }]));
    await save(h, {
      vuyro: 'export',
      formatVersion: 1,
      kind: 'nodeType',
      id: 'test.mjoin',
      version: 1,
      name: 'test.mjoin',
      content: { type: 'test.mjoin', version: 1, label: 'Join', completion: 'join', inputs: [{ name: 'in', label: 'In' }], outputs: [{ name: 'done', label: 'Done' }], params: [], claims: [{ path: 'src/**', mode: 'exclusive' }] },
    });
    await save(
      h,
      template(
        'myteam/claimjoin',
        [
          { id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'plan' } },
          { id: 'dev', type: 'vuyro.agent', version: 1, params: { instructions: 'dev' }, ports: { in: { mode: 'each' } } },
          { id: 'side', type: 'test.side', version: 1 },
          { id: 'mjoin', type: 'test.mjoin', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('plan', 'done', 'dev'), edge('plan', 'done', 'side'), edge('dev', 'done', 'mjoin'), edge('mjoin', 'done', 'end'), edge('side', 'done', 'end')],
        { workspaceMode: 'worktree', worktreeScope: 'nodeRun' },
      ),
    );
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/claimjoin');
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    const events = (await h.store.readAggregate(ticketId)).filter((event) => (event.data as { nodeId?: string }).nodeId === 'mjoin').map((event) => event.type);
    // Blocked by side's claim first (no start), then started as the merge step once side ended.
    expect(events).toEqual(['node.activated', 'node.paused', 'node.resumed', 'node.started', 'node.completed']);
    const blocked = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'checkout.blocked');
    expect(blocked.map((event) => (event.data as { requester: { nodeId: string } }).requester.nodeId)).toEqual(['mjoin']);
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(git(repo, 'show', `${ticketTree.branch}:lane-2.txt`)).toBe('work of lane 2');
  });

  it('a lane sent back by QA works again in a worktree that starts from the merged branch', async () => {
    t = await startParallel({
      settings: { workspaceMode: 'worktree', worktreeScope: 'nodeRun' },
      dev: (s, run) => {
        const file = join(s.request.cwd ?? '', `lane-${s.request.lane}.txt`);
        writeFileSync(file, run === 1 ? 'first try\n' : `${readFileSync(file, 'utf8')}fixed\n`);
      },
    });
    const { h, ticketId } = t;
    await h.drive();
    const item = currentExecution(await h.ticket(ticketId), 'qa', 'main')?.inputs.in?.[0];
    expect(item).toBeDefined();
    await h.ok('node.reject', { ticketId, nodeId: 'qa', items: [{ data: { reason: 'lane 1 is wrong' }, lineage: item?.lineage ?? [] }] });
    await h.drive();
    expect(nodeProgress(await h.ticket(ticketId), 'dev').executions.map((exec) => `${exec.lane}:${exec.cause}`)).toEqual(['1:input', '2:input', '1:rework']);
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(readFileSync(join(ticketTree.path, 'lane-1.txt'), 'utf8')).toBe('first try\nfixed\n');
    expect(await h.status(ticketId, 'qa')).toBe('review');
  });

  it('claims of lanes in their own worktrees do not conflict: the files are different files', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree' }, dev: CLEAN, devClaims: [{ path: 'src/**', mode: 'exclusive' }] });
    const { h, ticketId, projectId } = t;
    await h.activity.idle();
    expect([await h.status(ticketId, 'dev', '1'), await h.status(ticketId, 'dev', '2')]).toEqual(['running', 'running']);
    const spaces = await h.store.query<{ space: string }>('SELECT space FROM p_checkouts WHERE project_id = ? ORDER BY space', [projectId]);
    expect(spaces.map((row) => row.space)).toEqual([`wt:${laneWorktree(h.workspaces.layout.worktreeRoot, ticketId, 'dev', '1').key}`, `wt:${laneWorktree(h.workspaces.layout.worktreeRoot, ticketId, 'dev', '2').key}`]);
  });

  it('ticket scope: every node of the ticket works in the ticket worktree and the join does not merge', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', worktreeScope: 'ticket' }, dev: CLEAN });
    const { h, ticketId, seen } = t;
    await h.drive();
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(new Set(seen.map((request) => request.cwd))).toEqual(new Set([ticketTree.path]));
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.executor).toBeUndefined();
    expect(git(ticketTree.path, 'show', 'HEAD:lane-1.txt')).toBe('work of lane 1');
    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(existsSync(ticketTree.path)).toBe(false);
  });

  it('worktree mode on a folder that stopped being a git repository fails the node with the reason', async () => {
    const seen: ScriptedSession['request'][] = [];
    h = await openWorkflowHarness({
      behavior: (s) => {
        seen.push(s.request);
        return Promise.resolve(undefined);
      },
    });
    await save(
      h,
      template('myteam/one', [{ id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'plan' } }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('plan', 'done', 'end')], {
        workspaceMode: 'worktree',
      }),
    );
    // A repository when the ticket was made (ticket.create checks it), gone by the time the node runs.
    const repo = gitRepo(join(h.dir, 'was-a-repo'));
    const projectId = await projectAt(h, repo);
    const ticketId = await ticketIn(h, projectId, 'myteam/one');
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    await h.drive();
    expect(await h.status(ticketId, 'plan')).toBe('failed');
    expect(currentExecution(await h.ticket(ticketId), 'plan', 'main')?.output?.items[0]?.summary).toContain('needs a git repository');
    expect(seen).toEqual([]);
  });
  it("the default template follows the project's workspace mode: parallel Dev lanes in worktrees, merged at the join (D-073)", async () => {
    const seen: string[] = [];
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, lane, cwd } = s.request;
        seen.push(`${nodeId}/${lane}@${cwd ?? ''}`);
        if (nodeId === 'spec') {
          expectOk(await s.vuyro('artifact.add', { ticketId, nodeId, slot: 'specDoc', ref: { kind: 'file', uri: 'docs/spec.md', version: '1' } }));
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { title: 'Notepad', acceptanceCriteria: ['can save'] } }));
        } else if (nodeId === 'plan') {
          writeFileSync(join(cwd ?? '', 'PLAN.md'), '# plan\n');
          const items = ['T1', 'T2'].map((taskId) => ({ data: { taskId, scope: taskId, files: [`src/${taskId}.txt`] } }));
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items }));
        } else if (nodeId === 'dev') {
          await s.sleep(MINUTE);
          writeFileSync(join(cwd ?? '', 'src', `lane-${lane}.txt`), `work of lane ${lane}\n`);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId: `T${lane}` } }));
        } else if (nodeId === 'qa') {
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'approve', data: { verdict: 'pass' } }));
        } else {
          throw new Error(`unexpected agent for ${nodeId}`);
        }
        return undefined;
      },
    });
    const repo = gitRepo(join(h.dir, 'repo'));
    // The project chose worktree mode; the template does not choose one (v2), so the project's choice holds.
    const projectId = await projectAt(h, repo, { workspaceMode: 'worktree' });
    const ticketId = await ticketIn(h, projectId, 'vuyro/ai-sdlc');
    expect((await h.ticket(ticketId)).template).toMatchObject({ id: 'vuyro/ai-sdlc', version: 2 });
    await h.drive();
    await h.ok('node.done', { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'A notepad' });
    await h.drive();
    await h.ok('node.approve', { ticketId, nodeId: 'specApproval' });
    await h.drive();
    expect(await h.status(ticketId, 'qa')).toBe('review');

    const root = h.workspaces.layout.worktreeRoot;
    const ticketTree = ticketWorktree(root, ticketId);
    expect(seen).toEqual([
      `spec/main@${ticketTree.path}`,
      `plan/main@${ticketTree.path}`,
      `dev/1@${laneWorktree(root, ticketId, 'dev', '1').path}`,
      `dev/2@${laneWorktree(root, ticketId, 'dev', '2').path}`,
      `qa/main@${ticketTree.path}`,
    ]);
    // The join merged both lanes into the ticket branch; QA saw the merged tree.
    const head = git(ticketTree.path, 'rev-parse', 'HEAD');
    expect(git(ticketTree.path, 'show', `${head}:src/lane-1.txt`)).toBe('work of lane 1');
    expect(git(ticketTree.path, 'show', `${head}:src/lane-2.txt`)).toBe('work of lane 2');
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.executor).toBe('merge');

    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(existsSync(ticketTree.path)).toBe(false);
    expect(git(repo, 'show', `${ticketTree.branch}:src/lane-2.txt`)).toBe('work of lane 2');
    // The person's branch and folder were not touched.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // A project that chose nothing: the same template runs in the project folder (shared, the default).
    seen.length = 0;
    const plain = await projectAt(h, repo);
    const shared = await ticketIn(h, plain, 'vuyro/ai-sdlc');
    await h.drive();
    await h.ok('node.done', { ticketId: shared, nodeId: 'brainstorming', port: 'done', summary: 'Same again' });
    await h.drive();
    expect(seen).toEqual([`spec/main@${repo}`]);
  });
  it('worktree mode is saved only for a git repository: an empty .git, a folder inside a repository or no folder is refused (D-072)', async () => {
    h = await openWorkflowHarness({ behavior: () => Promise.resolve(undefined) });
    const repo = gitRepo(join(h.dir, 'repo'));
    const fake = join(h.dir, 'fake');
    mkdirSync(join(fake, '.git'), { recursive: true });
    // git itself decides, not the presence of .git.
    expect(await isRepositoryTop(repo)).toBe(true);
    expect(await isRepositoryTop(fake)).toBe(false);
    expect(await isRepositoryTop(join(repo, 'src'))).toBe(false);
    expect(await isRepositoryTop(join(h.dir, 'missing'))).toBe(false);

    const { projectId } = (await h.ok('project.create', { name: 'sample' })).result as { projectId: string };
    const refused = async (payload: Record<string, unknown>) => {
      const response = await h?.exec('project.configure', { projectId, ...payload });
      return response?.ok === false ? response.error.code : 'ok';
    };
    expect(await refused({ settings: { workspaceMode: 'worktree' } })).toBe('validation_failed'); // no folder
    expect(await refused({ root: fake, settings: { workspaceMode: 'worktree' } })).toBe('validation_failed');
    expect(await refused({ root: join(repo, 'src'), settings: { workspaceMode: 'worktree' } })).toBe('validation_failed');
    expect(await refused({ root: fake })).toBe('ok');
    // The mode alone, against the folder the project has.
    expect(await refused({ settings: { workspaceMode: 'worktree' } })).toBe('validation_failed');
    expect(await refused({ root: repo, settings: { workspaceMode: 'worktree' } })).toBe('ok');
    // Moving a worktree project to a folder that is not a repository, or clearing it, is refused too.
    expect(await refused({ root: fake })).toBe('validation_failed');
    expect(await refused({ root: null })).toBe('validation_failed');
    expect(await refused({ baseRef: 'main' })).toBe('ok');
    expect(await refused({ root: fake, settings: { workspaceMode: 'shared' } })).toBe('ok');
    const configured = (await h.store.readAggregate(projectId)).filter((event) => event.type === 'project.configured');
    expect(configured).toHaveLength(4);
  });
  it('inherited GIT_DIR, GIT_WORK_TREE and the like do not reach git: the folder the engine names is the one asked', async () => {
    h = await openWorkflowHarness({ behavior: () => Promise.resolve(undefined) });
    const repo = gitRepo(join(h.dir, 'repo'));
    const plain = join(h.dir, 'plain');
    mkdirSync(plain);
    const inherited = { ...process.env, GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: plain, GIT_INDEX_FILE: join(repo, '.git', 'index'), GIT_CEILING_DIRECTORIES: h.dir, git_common_dir: join(repo, '.git') };
    const env = gitEnvironment(inherited);
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'git_common_dir']) expect(env, name).not.toHaveProperty(name);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // With them, git would call the plain folder the top of a repository.
    expect(await isRepositoryTop(plain, nodeGitExec({ env: inherited }))).toBe(false);
    expect(await isRepositoryTop(repo, nodeGitExec({ env: inherited }))).toBe(true);
  });

  it("worktree mode inherited from the app layer is checked too, when the project is configured and when a ticket is made", async () => {
    h = await openWorkflowHarness({ behavior: () => Promise.resolve(undefined) });
    const repo = gitRepo(join(h.dir, 'repo'));
    const plain = join(h.dir, 'plain');
    mkdirSync(plain);
    await save(h, template('myteam/one', [{ id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'plan' } }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('plan', 'done', 'end')]));
    await save(
      h,
      template('myteam/wt', [{ id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'plan' } }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('plan', 'done', 'end')], { workspaceMode: 'worktree' }),
    );
    const code = (response: { ok: boolean; error?: { code: string } } | undefined) => (response?.ok === false ? response.error?.code : 'ok');
    const { projectId } = (await h.ok('project.create', { name: 'sample' })).result as { projectId: string };
    await h.ok('project.configure', { projectId, root: plain });
    const ticket = async (templateId: string) => code(await h?.exec('ticket.create', { projectId, title: 't', template: { id: templateId } }));
    // A template that chooses worktree mode, on a folder that is not a repository.
    expect(await ticket('myteam/wt')).toBe('validation_failed');
    expect(await ticket('myteam/one')).toBe('ok');
    // The app layer says worktree: the project's folder must be a repository now.
    await h.ok('app.configure', { settings: { workspaceMode: 'worktree' } });
    expect(await ticket('myteam/one')).toBe('validation_failed');
    expect(code(await h.exec('project.configure', { projectId, root: plain }))).toBe('validation_failed');
    expect(code(await h.exec('project.configure', { projectId, settings: { onConflict: 'warn' } }))).toBe('validation_failed');
    // The project's own layer can choose shared; or the folder can be a repository.
    expect(code(await h.exec('project.configure', { projectId, settings: { workspaceMode: 'shared' } }))).toBe('ok');
    expect(await ticket('myteam/one')).toBe('ok');
    expect(code(await h.exec('project.configure', { projectId, root: repo, settings: {} }))).toBe('ok');
    expect(await ticket('myteam/one')).toBe('ok');
    expect(await ticket('myteam/wt')).toBe('ok');
  });
});
