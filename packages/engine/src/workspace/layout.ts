import { join } from 'node:path';
import type { CompiledWorkflow } from '../workflow/compile.ts';
import { execution, laneOf, type TicketWorkflow } from '../workflow/state.ts';
import { type EffectiveSettings, laneWorktrees, nodeSettings } from './settings.ts';

/**
 * Where an execution works ([[공유·권한·BlackBoard 설계]] §3.9):
 * - shared mode: the project folder (space `root`).
 * - worktree mode, ticket scope: the ticket's worktree (space `wt:<ticket key>`).
 * - worktree mode, nodeRun scope: each lane of a fan-out node gets its own worktree (`wt:<ticket key>/<node>-<lane>`);
 *   everything else of the ticket works in the ticket's worktree, where the join merges the lanes' branches.
 *
 * Names are derived, not stored, so a crash between creating a worktree and recording it finds the same folder.
 */

export interface Location {
  readonly space: string;
  /** The folder, when one is known (shared mode needs the project folder, `project.configure root`). */
  readonly root: string | undefined;
  readonly settings: EffectiveSettings;
  /** Set in worktree mode. */
  readonly worktree?: WorktreeName;
}

export interface WorktreeName {
  readonly key: string;
  readonly scope: 'ticket' | 'lane';
  readonly path: string;
  readonly branch: string;
  readonly nodeId?: string;
  readonly lane?: string;
}

/** Short folder key of a ticket: the random tail of its UUIDv7 (48 bits), so worktree paths stay short on Windows. */
export function ticketKey(ticketId: string): string {
  return `t${ticketId.replace(/-/g, '').slice(-12)}`;
}

export function ticketWorktree(worktreeRoot: string, ticketId: string): WorktreeName {
  const key = ticketKey(ticketId);
  return { key, scope: 'ticket', path: join(worktreeRoot, key, '_ticket'), branch: `vuyro/${ticketId}/ticket` };
}

/**
 * A lane's worktree. `generation` is the execution that started the lane over in a new worktree (D-042); the first
 * worktree of a lane has none. Each generation has its own folder and branch, so nothing is ever reset.
 */
export function laneWorktree(worktreeRoot: string, ticketId: string, nodeId: string, lane: string, generation?: number): WorktreeName {
  const base = ticketKey(ticketId);
  const name = generation === undefined ? `${nodeId}-${lane}` : `${nodeId}-${lane}.r${generation}`;
  return { key: `${base}/${name}`, scope: 'lane', path: join(worktreeRoot, base, name), branch: `vuyro/${ticketId}/${name}`, nodeId, lane };
}

export interface LayoutOptions {
  /** Folder that holds the engine's worktrees. */
  readonly worktreeRoot: string;
}

/** The generation of a lane's worktree an execution works in: the latest execution up to `run` that started a new one. */
export function worktreeGeneration(state: TicketWorkflow, nodeId: string, lane: string, run: number): number | undefined {
  let generation: number | undefined;
  for (const candidate of laneOf(state, nodeId, lane)?.runs ?? []) {
    if (candidate <= run && execution(state, nodeId, candidate)?.newWorktree === true) generation = candidate;
  }
  return generation;
}

/** Where an execution works. `run` defaults to the lane's current execution. */
export function locate(options: LayoutOptions, state: TicketWorkflow, ticketId: string, workflow: CompiledWorkflow, nodeId: string, lane: string, run?: number): Location {
  const settings = nodeSettings(state, workflow, nodeId);
  if (settings.workspaceMode === 'shared') {
    return { space: 'root', root: state.workspace?.root, settings };
  }
  const at = run ?? laneOf(state, nodeId, lane)?.runs.at(-1) ?? 0;
  const worktree =
    settings.worktreeScope === 'nodeRun' && lane !== 'main' && laneWorktrees(state, workflow, nodeId)
      ? laneWorktree(options.worktreeRoot, ticketId, nodeId, lane, worktreeGeneration(state, nodeId, lane, at))
      : ticketWorktree(options.worktreeRoot, ticketId);
  return { space: `wt:${worktree.key}`, root: worktree.path, settings, worktree };
}
