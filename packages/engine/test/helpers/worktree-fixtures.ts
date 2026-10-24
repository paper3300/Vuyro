import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimSpec, WorkspaceSettings } from '@vuyro/contracts';
import type { ScriptedBehavior, ScriptedSession } from '../../src/workflow/scripted-agent.ts';
import { openWorkflowHarness, type WorkflowHarness } from './workflow-harness.ts';
import { edge, editorType, expectOk, git, gitRepo, MINUTE, projectAt, save, template, ticketIn } from './workspace-fixtures.ts';

/**
 * Worktree tests: a ticket that plans two tasks, works on them in parallel (fan-out lanes), joins them, has QA approve
 * or send a lane back, and ends. Real git in a temporary repository; the agents are scripted.
 */

export type DevStep = (s: ScriptedSession, run: number) => void | Promise<void>;

export interface Setup {
  readonly settings: WorkspaceSettings;
  /** What a dev lane writes on its n-th run (1-based). */
  readonly dev: DevStep;
  /** The merge agent (onMergeConflict: agent). */
  readonly resolver?: (s: ScriptedSession) => void | Promise<void>;
  /** Claims of the dev node (it then runs as a node type of its own). */
  readonly devClaims?: ClaimSpec[];
}

export interface ParallelTicket {
  readonly h: WorkflowHarness;
  readonly repo: string;
  readonly projectId: string;
  readonly ticketId: string;
  /** Every agent start request, in order. */
  readonly seen: ScriptedSession['request'][];
  worktreeList(): string[];
  branches(): string[];
}

function behavior(setup: Setup, seen: ScriptedSession['request'][]): ScriptedBehavior {
  const runs = new Map<string, number>();
  return async (s) => {
    seen.push(s.request);
    const { ticketId, nodeId, lane } = s.request;
    const key = `${nodeId}/${lane}`;
    const run = (runs.get(key) ?? 0) + 1;
    runs.set(key, run);
    if (nodeId === 'plan') {
      writeFileSync(join(s.request.cwd ?? '', 'PLAN.md'), '# plan\n');
      expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { taskId: 't1' } }, { data: { taskId: 't2' } }] }));
      return undefined;
    }
    if (nodeId === 'dev') {
      await s.sleep(MINUTE);
      await setup.dev(s, run);
      expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId: `t${lane}` } }));
      return undefined;
    }
    if (nodeId === 'join') {
      await setup.resolver?.(s);
      return undefined;
    }
    throw new Error(`unexpected agent for ${nodeId}`);
  };
}

export const CLEAN: DevStep = (s) => {
  writeFileSync(join(s.request.cwd ?? '', `lane-${s.request.lane}.txt`), `work of lane ${s.request.lane}\n`);
};

/** Both lanes change line 2 of src/app.txt differently: a merge conflict. */
export const CONFLICTING: DevStep = (s) => {
  writeFileSync(join(s.request.cwd ?? '', 'src', 'app.txt'), `line 1\nline 2 by lane ${s.request.lane}\nline 3\n`);
};

export async function startParallel(setup: Setup): Promise<ParallelTicket> {
  const seen: ScriptedSession['request'][] = [];
  const h = await openWorkflowHarness({ behavior: behavior(setup, seen) });
  const repo = gitRepo(join(h.dir, 'repo'));
  if (setup.devClaims !== undefined) await save(h, editorType('test.dev', setup.devClaims));
  const dev = setup.devClaims === undefined ? { type: 'vuyro.agent', params: { instructions: 'dev' } } : { type: 'test.dev' };
  await save(
    h,
    template(
      'myteam/parallel',
      [
        { id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'plan' } },
        { id: 'dev', version: 1, ...dev, ports: { in: { mode: 'each' } } },
        { id: 'join', type: 'vuyro.join', version: 1 },
        { id: 'qa', type: 'vuyro.approval', version: 1 },
        { id: 'end', type: 'vuyro.end', version: 1 },
      ],
      [edge('plan', 'done', 'dev'), edge('dev', 'done', 'join'), edge('join', 'done', 'qa'), edge('qa', 'approve', 'end'), edge('qa', 'reject', 'dev')],
      setup.settings,
    ),
  );
  const projectId = await projectAt(h, repo);
  const ticketId = await ticketIn(h, projectId, 'myteam/parallel');
  return {
    h,
    repo,
    projectId,
    ticketId,
    seen,
    worktreeList: () =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice(9)),
    branches: () =>
      git(repo, 'branch', '--format=%(refname:short)')
        .split('\n')
        .filter((line) => line !== '')
        .sort(),
  };
}
