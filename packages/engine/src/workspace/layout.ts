import { join } from 'node:path';
import type { CompiledWorkflow } from '../workflow/compile.ts';
import type { TicketWorkflow } from '../workflow/state.ts';
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

export function laneWorktree(worktreeRoot: string, ticketId: string, nodeId: string, lane: string): WorktreeName {
  const base = ticketKey(ticketId);
  const name = `${nodeId}-${lane}`;
  return { key: `${base}/${name}`, scope: 'lane', path: join(worktreeRoot, base, name), branch: `vuyro/${ticketId}/${name}`, nodeId, lane };
}

export interface LayoutOptions {
  /** Folder that holds the engine's worktrees. */
  readonly worktreeRoot: string;
}

export function locate(options: LayoutOptions, state: TicketWorkflow, ticketId: string, workflow: CompiledWorkflow, nodeId: string, lane: string): Location {
  const settings = nodeSettings(state, workflow, nodeId);
  if (settings.workspaceMode === 'shared') {
    return { space: 'root', root: state.workspace?.root, settings };
  }
  const worktree =
    settings.worktreeScope === 'nodeRun' && lane !== 'main' && laneWorktrees(state, workflow, nodeId)
      ? laneWorktree(options.worktreeRoot, ticketId, nodeId, lane)
      : ticketWorktree(options.worktreeRoot, ticketId);
  return { space: `wt:${worktree.key}`, root: worktree.path, settings, worktree };
}
