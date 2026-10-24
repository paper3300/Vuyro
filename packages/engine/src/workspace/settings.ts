import type { AgentProvider, WorkspaceSettings } from '@vuyro/contracts';
import type { CompiledWorkflow } from '../workflow/compile.ts';
import type { TicketWorkflow } from '../workflow/state.ts';

/**
 * Workspace settings are layered app → project → template → node ([[명령·이벤트 계약]] §14): each layer sets only
 * the fields it cares about and a later layer wins field by field. A ticket pins the merged app + project layers
 * when it is created; the template and node layers come from its pinned template.
 */

export interface EffectiveSettings {
  readonly workspaceMode: 'shared' | 'worktree';
  readonly worktreeScope: 'ticket' | 'nodeRun';
  readonly autoCheckoutHook: boolean;
  readonly onMergeConflict: 'ask' | 'agent' | 'rerun' | 'fail';
  readonly mergeAgent: { readonly provider: AgentProvider; readonly model?: string };
  readonly overlapWarning: boolean;
  readonly onConflict: 'firstWins' | 'priorityWins' | 'ask' | 'warn' | 'fail';
  readonly pauseMode: 'boundary' | 'immediate';
}

/** Later layers win field by field. `undefined` layers are skipped. */
export function mergeSettings(...layers: readonly (WorkspaceSettings | undefined)[]): WorkspaceSettings {
  let merged: WorkspaceSettings = {};
  for (const layer of layers) if (layer !== undefined) merged = { ...merged, ...layer };
  return merged;
}

/**
 * Defaults ([[공유·권한·BlackBoard 설계]] §3.7–§3.9, [[결정 대기]] D-029…): shared mode; worktrees per fan-out lane
 * when worktree mode is chosen; the checkout hook on in shared mode and off in worktree mode (folders do not
 * overlap there); merge conflicts go to a person; claims: the first comer wins, pausing at node boundaries.
 */
export function effectiveSettings(settings: WorkspaceSettings): EffectiveSettings {
  const workspaceMode = settings.workspaceMode ?? 'shared';
  return {
    workspaceMode,
    worktreeScope: settings.worktreeScope ?? 'nodeRun',
    autoCheckoutHook: settings.autoCheckoutHook ?? workspaceMode === 'shared',
    onMergeConflict: settings.onMergeConflict ?? 'ask',
    mergeAgent: settings.mergeAgent ?? { provider: 'claude' },
    overlapWarning: settings.overlapWarning ?? true,
    onConflict: settings.onConflict ?? 'firstWins',
    pauseMode: settings.pauseMode ?? 'boundary',
  };
}

/** The settings one node of a ticket runs with. */
export function nodeSettings(state: TicketWorkflow, workflow: CompiledWorkflow, nodeId: string): EffectiveSettings {
  return effectiveSettings(mergeSettings(state.workspace?.settings, workflow.template.settings, workflow.nodes.get(nodeId)?.instance.settings));
}

/** A fan-out node (each input): in nodeRun worktree mode its lanes get worktrees of their own. */
export function isFanOutNode(workflow: CompiledWorkflow, nodeId: string): boolean {
  return workflow.nodes.get(nodeId)?.inputs.some((port) => port.mode === 'each') === true;
}

/** Whether a node's lanes run in worktrees of their own (worktree mode, nodeRun scope, fan-out node). */
export function laneWorktrees(state: TicketWorkflow, workflow: CompiledWorkflow, nodeId: string): boolean {
  const settings = nodeSettings(state, workflow, nodeId);
  return settings.workspaceMode === 'worktree' && settings.worktreeScope === 'nodeRun' && isFanOutNode(workflow, nodeId);
}

/**
 * Joins that merge: a join fed directly by a node whose lanes run in worktrees of their own merges their branches
 * into the ticket branch before it passes their items on (§3.9 "합치기"). It runs as the engine's merge step instead
 * of finishing on the spot.
 */
export function mergingJoins(state: TicketWorkflow, workflow: CompiledWorkflow): ReadonlySet<string> {
  const joins = new Set<string>();
  for (const node of workflow.nodes.values()) {
    if (node.completion !== 'join') continue;
    const sources = node.incoming.map((index) => workflow.edges[index]?.edge.from.node).filter((id): id is string => id !== undefined);
    if (sources.some((source) => laneWorktrees(state, workflow, source))) joins.add(node.id);
  }
  return joins;
}

/** Change detection looks at everything but `.git` and the usual build output folders, unless the project says otherwise. */
export const DEFAULT_WATCH_EXCLUDE: readonly string[] = [
  '.git/**',
  'node_modules/**',
  'Intermediate/**',
  'Binaries/**',
  'Saved/**',
  'DerivedDataCache/**',
];
