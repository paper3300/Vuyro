import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceAggregateId } from '@vuyro/contracts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { laneWorktree, ticketWorktree } from '../src/workspace/layout.ts';
import { git } from './helpers/workspace-fixtures.ts';
import { CONFLICTING, type ParallelTicket, startParallel } from './helpers/worktree-fixtures.ts';

/**
 * Merge conflicts at the join in worktree mode (M4, [[공유·권한·BlackBoard 설계]] §3.9 `onMergeConflict`): two lanes
 * change the same line, so the second branch conflicts with the first one merged.
 */

describe('merge conflicts at the join', { timeout: 120_000 }, () => {
  let t: ParallelTicket | undefined;

  afterEach(async () => {
    await t?.h.close();
    t = undefined;
  });

  it('fail: the join fails, the merge is undone, and the lanes keep their worktrees', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', onMergeConflict: 'fail' }, dev: CONFLICTING });
    const { h, ticketId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('failed');
    const failed = currentExecution(await h.ticket(ticketId), 'join', 'main');
    expect(failed?.output?.items[0]?.data).toMatchObject({ conflicts: [{ branch: `vuyro/${ticketId}/dev-2`, nodeId: 'dev', lane: '2', files: ['src/app.txt'] }] });
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(git(ticketTree.path, 'status', '--porcelain')).toBe('');
    expect(existsSync(laneWorktree(h.workspaces.layout.worktreeRoot, ticketId, 'dev', '2').path)).toBe(true);
    // Lane 1 merged; lane 2 did not.
    expect(readFileSync(join(ticketTree.path, 'src', 'app.txt'), 'utf8')).toContain('line 2 by lane 1');
  });

  it('ask: the merge waits in Review; a person resolves it and approves, and the merge goes on', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', onMergeConflict: 'ask' }, dev: CONFLICTING });
    const { h, ticketId, projectId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('review');
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    const held = currentExecution(await h.ticket(ticketId), 'join', 'main');
    expect(held?.merge).toEqual({ worktree: ticketTree.path, branch: ticketTree.branch, conflicts: [{ branch: `vuyro/${ticketId}/dev-2`, files: ['src/app.txt'] }] });
    expect(readFileSync(join(ticketTree.path, 'src', 'app.txt'), 'utf8')).toContain('<<<<<<<');
    // Two worktrees changed the same file: warned about before the merge.
    const warned = (await h.store.readAggregate(workspaceAggregateId(projectId))).filter((event) => event.type === 'workspace.overlapWarned');
    expect(warned.map((event) => (event.data as { path: string }).path)).toEqual(['src/app.txt']);

    // The person resolves the file in the ticket's worktree and approves.
    writeFileSync(join(ticketTree.path, 'src', 'app.txt'), 'line 1\nline 2 by both lanes\nline 3\n');
    git(ticketTree.path, 'add', 'src/app.txt');
    await h.ok('node.approve', { ticketId, nodeId: 'join' });
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('done');
    expect(await h.status(ticketId, 'qa')).toBe('review');
    expect(git(ticketTree.path, 'show', 'HEAD:src/app.txt')).toBe('line 1\nline 2 by both lanes\nline 3');
    expect(() => git(ticketTree.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
  });

  it('ask: approving while conflicts are still there keeps the merge waiting', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', onMergeConflict: 'ask' }, dev: CONFLICTING });
    const { h, ticketId } = t;
    await h.drive();
    await h.ok('node.approve', { ticketId, nodeId: 'join' });
    await h.drive();
    expect(nodeProgress(await h.ticket(ticketId), 'join').executions.map((exec) => exec.status)).toEqual(['superseded', 'review']);
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge?.conflicts).toEqual([{ branch: `vuyro/${ticketId}/dev-2`, files: ['src/app.txt'] }]);
  });

  it('rerun: the conflicting lane runs again on top of what was merged, and the join merges again', async () => {
    t = await startParallel({
      settings: { workspaceMode: 'worktree', onMergeConflict: 'rerun' },
      dev: (s, run) => {
        const file = join(s.request.cwd ?? '', 'src', 'app.txt');
        // The second run starts from the merged branch and builds on it.
        if (run === 1) void CONFLICTING(s, run);
        else writeFileSync(file, `${readFileSync(file, 'utf8')}line 4 by lane ${s.request.lane}\n`);
      },
    });
    const { h, ticketId } = t;
    await h.drive();
    expect(nodeProgress(await h.ticket(ticketId), 'join').executions.map((exec) => exec.status)).toEqual(['failed', 'done']);
    const reworked = nodeProgress(await h.ticket(ticketId), 'dev').executions.find((exec) => exec.cause === 'rework');
    expect(reworked).toMatchObject({ lane: '2', status: 'done' });
    expect(reworked?.feedback?.comment).toContain('conflicted with the other work merged');
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(git(ticketTree.path, 'show', 'HEAD:src/app.txt')).toBe('line 1\nline 2 by lane 1\nline 3\nline 4 by lane 2');
    expect(await h.status(ticketId, 'qa')).toBe('review');
  });

  it('agent: an agent resolves the conflict in the ticket worktree, a person reviews it, and the merge goes on', async () => {
    t = await startParallel({
      settings: { workspaceMode: 'worktree', onMergeConflict: 'agent' },
      dev: CONFLICTING,
      resolver: (s) => {
        expect(s.request.prompt).toContain('src/app.txt');
        writeFileSync(join(s.request.cwd ?? '', 'src', 'app.txt'), 'line 1\nline 2 merged by the agent\nline 3\n');
        git(s.request.cwd ?? '', 'add', 'src/app.txt');
      },
    });
    const { h, ticketId, seen } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('review');
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge).toMatchObject({ resolvedBy: 'agent' });
    const ticketTree = ticketWorktree(h.workspaces.layout.worktreeRoot, ticketId);
    expect(seen.find((request) => request.nodeId === 'join')?.cwd).toBe(ticketTree.path);
    await h.ok('node.approve', { ticketId, nodeId: 'join' });
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('done');
    expect(git(ticketTree.path, 'show', 'HEAD:src/app.txt')).toBe('line 1\nline 2 merged by the agent\nline 3');
  });

  it('agent: an agent that leaves conflicts hands the merge to a person', async () => {
    t = await startParallel({ settings: { workspaceMode: 'worktree', onMergeConflict: 'agent' }, dev: CONFLICTING, resolver: () => undefined });
    const { h, ticketId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('review');
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge).not.toHaveProperty('resolvedBy');
  });

  it('agent: staging a file that still has conflict markers is not a resolution', async () => {
    t = await startParallel({
      settings: { workspaceMode: 'worktree', onMergeConflict: 'agent' },
      dev: CONFLICTING,
      resolver: (s) => {
        git(s.request.cwd ?? '', 'add', 'src/app.txt');
      },
    });
    const { h, ticketId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('review');
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge).toEqual(expect.objectContaining({ conflicts: [{ branch: `vuyro/${ticketId}/dev-2`, files: ['src/app.txt'] }] }));
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge).not.toHaveProperty('resolvedBy');
  });

  it('a person hands a held merge to an agent by rejecting it with instructions', async () => {
    let instructions = '';
    t = await startParallel({
      settings: { workspaceMode: 'worktree', onMergeConflict: 'ask' },
      dev: CONFLICTING,
      resolver: (s) => {
        instructions = s.request.prompt;
        writeFileSync(join(s.request.cwd ?? '', 'src', 'app.txt'), 'line 1\nkeep lane 2\nline 3\n');
        git(s.request.cwd ?? '', 'add', 'src/app.txt');
      },
    });
    const { h, ticketId } = t;
    await h.drive();
    expect(await h.status(ticketId, 'join')).toBe('review');
    await h.ok('node.reject', { ticketId, nodeId: 'join', comment: 'keep the line of lane 2' });
    await h.drive();
    expect(instructions).toContain('keep the line of lane 2');
    expect(currentExecution(await h.ticket(ticketId), 'join', 'main')?.merge).toMatchObject({ resolvedBy: 'agent' });
  });
});
