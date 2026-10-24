import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceAggregateId } from '@vuyro/contracts';
import type { ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { laneWorktree, ticketWorktree } from '../src/workspace/layout.ts';
import { openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';
import { edge, git, projectAt, save, template, ticketIn } from './helpers/workspace-fixtures.ts';
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

  it('worktree mode outside a git repository fails the node with the reason', async () => {
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
    const projectId = await projectAt(h, h.dir);
    const ticketId = await ticketIn(h, projectId, 'myteam/one');
    await h.drive();
    expect(await h.status(ticketId, 'plan')).toBe('failed');
    expect(currentExecution(await h.ticket(ticketId), 'plan', 'main')?.output?.items[0]?.summary).toContain('needs a git repository');
    expect(seen).toEqual([]);
  });
});
