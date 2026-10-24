import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome, codexUserHooks } from '@vuyro/agent-adapters';
import {
  type AgentProvider,
  type CommandResponse,
  type DetectedChange,
  type DomainEvent,
  type Holder,
  type MergeResult,
  type ScanReason,
  type Worktree,
  type WorktreeCleanupCandidate,
  workspaceAggregateId,
} from '@vuyro/contracts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { TransportIdentity } from '../commands/caller.ts';
import { holderActive } from '../commands/workspace-handlers.ts';
import type { ActivityTracker } from '../runtime/activity.ts';
import type { TimerHandle } from '../runtime/clock.ts';
import type { EventStore } from '../store/event-store.ts';
import type { CompiledNode, CompiledWorkflow } from '../workflow/compile.ts';
import { ancestorsOf } from '../workflow/context.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';
import { ACTIVE_STATUSES, currentExecution, EMPTY_TICKET, evolveTicket, type Execution, execution, nodeProgress, type TicketWorkflow } from '../workflow/state.ts';
import { GitError, type GitClient } from './git.ts';
import { laneWorktree, locate, type Location, ticketWorktree, type WorktreeName, worktreeGeneration } from './layout.ts';
import { EMPTY_LEDGER, evolveLedger, holderKey, type LedgerEntry, type LedgerState, sameHolder } from './ledger.ts';
import { insideRoot, isPattern, matches, matchesAny, normalizeRelative, pathKey } from './paths.ts';
import type { WorkspaceServices } from './services.ts';
import { DEFAULT_WATCH_EXCLUDE, laneWorktrees, mergingJoins, nodeSettings } from './settings.ts';
import type { FileWatcher, WatchHandle } from './watcher.ts';

/**
 * The engine's side of workspaces ([[명령·이벤트 계약]] §14): it does the file and git work the command handlers
 * cannot (they only decide from state), and records it through `workspace.record`:
 *
 * - before an executor starts: its folder (making the ticket's and the lane's worktree in worktree mode), the first
 *   look at a space (baseline), changes since the last look (`start` scan), and what changed in its checked-out
 *   files while it was paused (for its prompt);
 * - after it ends: the engine's commit in its own worktree, and the `finish` scan;
 * - on events: entries whose holders ended are released (or kept for the ticket), paused holders get their pause
 *   hashes, lanes waiting for claims resume once nothing they wait for holds any more, expired entries go, merged
 *   and finished worktrees are removed;
 * - the merge step of a join in worktree mode.
 *
 * Every git command is in `GitClient` (read-only queries, and worktree, merge and clean-up of Vuyro's own branches).
 */

const SYSTEM: TransportIdentity = { kind: 'internal', component: 'workspace' };

export interface MergeAgentRequest {
  readonly ticketId: string;
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly provider: AgentProvider;
  readonly model?: string;
  readonly cwd: string;
  readonly prompt: string;
}

export interface WorkspaceCoordinatorOptions {
  readonly bus: CommandBus;
  readonly store: EventStore;
  readonly definitions: DefinitionResolver;
  readonly services: WorkspaceServices;
  readonly git: GitClient;
  readonly activity: ActivityTracker;
  /** Watches spaces while executions run there. Absent = scans at start and finish only. */
  readonly watcher?: FileWatcher;
  /** How long watcher events gather before a scan. Default 1 s. */
  readonly watchDebounceMs?: number;
  /** Runs an agent that resolves merge conflicts (`onMergeConflict: agent`); resolves true when it ended normally. */
  readonly resolveConflicts?: (request: MergeAgentRequest) => Promise<boolean>;
  /** The user's Codex folder (its `hooks.json` turns the checkout hook off for Codex). Default `CODEX_HOME`, else `~/.codex`. */
  readonly codexHome?: string;
  readonly reportError: (error: Error, context: string) => void;
}

export interface PrepareTarget {
  readonly ticketId: string;
  readonly state: TicketWorkflow;
  readonly workflow: CompiledWorkflow;
  readonly node: CompiledNode;
  readonly exec: Execution;
  readonly provider?: AgentProvider;
}

export interface Prepared {
  readonly location: Location;
  /** The working folder (undefined: the process default). */
  readonly cwd?: string;
  /** Install the checkout hook into the agent CLI. */
  readonly checkoutHook: boolean;
  /** Extra prompt sections (what changed while the lane was paused). */
  readonly notes: readonly string[];
  /** Warnings to record on the run (e.g. why the hook is off). */
  readonly warnings: readonly string[];
}

function requestId(step: string, ...parts: (string | number)[]): string {
  return `ws-${step}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
}

/**
 * A merge left in progress in the ticket worktree under `fail` or `rerun` (an engine stopped mid-merge, or a merge
 * that conflicted against its preview). The engine does not abort it (that would drop whatever is in those files): the
 * join fails with where it is, and a person finishes or aborts it there. Running the lanes again would not help.
 */
function leftInProgress(worktree: string, branch: string, files: readonly string[]): MergeResult {
  return {
    kind: 'merge',
    outcome: 'error',
    worktree,
    branch,
    error: `a merge is in progress in ${worktree} with conflicts in ${files.slice(0, 20).join(', ')}; the engine does not abort it. Resolve and commit it, or abort it yourself, then retry the join`,
  };
}

/** Codex runs a repository's own hooks too when the hook trust check is bypassed (D-031): not with those present. The user's are checked in `codexUserHooks`. */
export function codexProjectHooks(root: string): boolean {
  if (existsSync(join(root, '.codex', 'hooks.json'))) return true;
  const config = join(root, '.codex', 'config.toml');
  if (!existsSync(config)) return false;
  try {
    return /\bhooks\b/.test(readFileSync(config, 'utf8'));
  } catch {
    return true;
  }
}

export class WorkspaceCoordinator {
  private readonly options: WorkspaceCoordinatorOptions;
  private readonly tickets = new Map<string, { revision: number; state: TicketWorkflow }>();
  private readonly ledgers = new Map<string, { revision: number; state: LedgerState }>();
  private readonly projectOf = new Map<string, string>();
  private readonly pending = new Set<string>();
  /** Tickets whose worktrees may be removable: a join merged, or the ticket completed. */
  private readonly cleanup = new Set<string>();
  private readonly watches = new Map<string, { handle: Promise<WatchHandle | undefined>; users: Set<string>; paths: Set<string>; timer?: TimerHandle | undefined; projectId: string; root: string }>();
  private chain: Promise<void> = Promise.resolve();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly expiryTimers = new Map<string, TimerHandle>();
  private stopped = false;

  constructor(options: WorkspaceCoordinatorOptions) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // State

  async ticket(ticketId: string): Promise<TicketWorkflow> {
    const cached = this.tickets.get(ticketId);
    let revision = cached?.revision ?? 0;
    let state = cached?.state ?? EMPTY_TICKET;
    for (const event of await this.options.store.readAggregate(ticketId, revision)) {
      state = evolveTicket(state, event);
      revision = event.revision;
    }
    this.tickets.set(ticketId, { revision, state });
    if (state.exists) this.projectOf.set(ticketId, state.projectId);
    return state;
  }

  async ledger(projectId: string): Promise<LedgerState> {
    const id = workspaceAggregateId(projectId);
    const cached = this.ledgers.get(id);
    let revision = cached?.revision ?? 0;
    let state = cached?.state ?? EMPTY_LEDGER;
    for (const event of await this.options.store.readAggregate(id, revision)) {
      state = evolveLedger(state, event);
      revision = event.revision;
    }
    this.ledgers.set(id, { revision, state });
    return state;
  }

  /**
   * Records bookkeeping. The request id includes the ledger revision it was decided from, so the same step after a
   * crash replays, while a later step with the same content (a file changed back and forth) is a new request.
   */
  private async record(payload: Record<string, unknown> & { projectId: string; op: string }, ...idParts: (string | number)[]): Promise<CommandResponse> {
    const revision = this.ledgers.get(workspaceAggregateId(payload.projectId))?.revision ?? 0;
    const response = await this.options.bus.execute({ requestId: requestId(payload.op, payload.projectId, revision, ...idParts), type: 'workspace.record', payload }, SYSTEM);
    if (!response.ok) this.options.reportError(new Error(`workspace.record ${payload.op}: ${response.error.code} ${response.error.message}`), 'workspace bookkeeping');
    return response;
  }

  /** Runs file and git work of one project one step at a time (git worktree commands share the repository's files). */
  private exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }

  // ---------------------------------------------------------------------------
  // Before and after an executor

  /** Where an execution of a lane works (`run`: the lane's current execution when absent). */
  locate(target: Pick<PrepareTarget, 'ticketId' | 'state' | 'workflow' | 'node'>, lane: string, run?: number): Location {
    return locate(this.options.services.layout, target.state, target.ticketId, target.workflow, target.node.id, lane, run);
  }

  async prepare(target: PrepareTarget): Promise<Prepared> {
    const { ticketId, state, node, exec } = target;
    const location = this.locate(target, exec.lane, exec.run);
    const holder: Holder = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run };
    const notes: string[] = [];
    const warnings: string[] = [];
    await this.exclusive(state.projectId, async () => {
      if (location.worktree !== undefined) await this.ensureWorktree(state, ticketId, location.worktree);
      if (location.root === undefined) return;
      // What changed before this execution started is not its doing.
      await this.scan(state.projectId, location, state, 'start', undefined, [], holder);
      notes.push(...(await this.resumeNotes(state.projectId, location, holder)));
    });
    if (location.root !== undefined) this.startWatching(state.projectId, location, state, holderKey(holder));
    let checkoutHook = location.settings.autoCheckoutHook && location.root !== undefined;
    if (checkoutHook && target.provider === 'codex' && location.root !== undefined && codexProjectHooks(location.root)) {
      checkoutHook = false;
      warnings.push('the automatic checkout hook is off for this Codex run: the workspace has its own Codex hooks, which bypassing the hook trust check would run unchecked (changes are still found afterwards)');
    } else if (checkoutHook && target.provider === 'codex' && codexUserHooks(this.options.codexHome ?? codexHome())) {
      // Codex loads the user's hooks.json even when the run ignores the user's config (D-031).
      checkoutHook = false;
      warnings.push('the automatic checkout hook is off for this Codex run: the user has Codex hooks of their own (hooks.json), which bypassing the hook trust check would run unchecked (changes are still found afterwards)');
    }
    return { location, ...(location.root === undefined ? {} : { cwd: location.root }), checkoutHook, notes, warnings };
  }

  /** After the executor's process ended, before the engine reports it: the engine's commit and the `finish` scan. */
  async finish(target: PrepareTarget): Promise<void> {
    const { ticketId, state, node, exec } = target;
    const location = this.locate(target, exec.lane, exec.run);
    const holder: Holder = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run };
    this.stopWatching(location.space, holderKey(holder));
    const root = location.root;
    if (root === undefined) return;
    await this.exclusive(state.projectId, async () => {
      // Scan first, so changes are seen in the working tree and attributed while the holder still runs.
      await this.scan(state.projectId, location, state, 'finish', holder);
      if (location.worktree !== undefined && existsSync(root) && !(await this.options.git.mergeInProgress(root).catch(() => false))) {
        await this.options.git.commitAll(root, `vuyro: ${node.id} lane ${exec.lane} run ${exec.run}`).catch((error: unknown) => {
          this.options.reportError(error instanceof Error ? error : new Error(String(error)), `committing the work of ${node.id} lane ${exec.lane}`);
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Worktrees

  private async repository(state: TicketWorkflow): Promise<string> {
    const root = state.workspace?.root;
    if (root === undefined) throw new Error('worktree mode needs the project folder (project.configure root)');
    const top = await this.options.git.topLevel(root);
    if (top === undefined) throw new Error(`worktree mode needs a git repository, and ${root} is not in one`);
    return root;
  }

  private async ensureTicketWorktree(state: TicketWorkflow, ticketId: string): Promise<{ name: WorktreeName; head: string }> {
    const repo = await this.repository(state);
    const name = ticketWorktree(this.options.services.layout.worktreeRoot, ticketId);
    const git = this.options.git;
    if (!(await this.knownWorktree(name.path))) {
      const base = (await git.revParse(repo, name.branch)) ?? (await git.revParse(repo, state.workspace?.baseRef ?? 'HEAD'));
      if (base === undefined) throw new Error(`cannot find the start of the ticket branch (${state.workspace?.baseRef ?? 'HEAD'}) in ${repo}`);
      await git.addWorktree(repo, name.path, name.branch, base);
      await this.record({ projectId: state.projectId, op: 'worktreeCreated', worktree: { ticketId, key: name.key, scope: 'ticket', path: name.path, branch: name.branch, base } }, name.key, base);
    }
    const head = await git.revParse(name.path, 'HEAD');
    if (head === undefined) throw new Error(`the ticket worktree ${name.path} has no commit`);
    return { name, head };
  }

  /** A worktree folder with its `.git` link in place is taken as made; anything else is made (again). */
  private knownWorktree(path: string): Promise<boolean> {
    return Promise.resolve(existsSync(join(path, '.git')));
  }

  /**
   * Makes the lane's worktree if it is not there. A lane that starts over (merge conflict, `rerun`) gets a worktree of
   * a new generation (its own folder and branch) from the ticket branch, so the old one is left untouched (D-042).
   * An existing worktree only picks up merged work when that is a fast-forward (git refuses rather than overwrite).
   */
  private async ensureWorktree(state: TicketWorkflow, ticketId: string, name: WorktreeName): Promise<void> {
    const ticket = await this.ensureTicketWorktree(state, ticketId);
    if (name.scope === 'ticket') return;
    const repo = await this.repository(state);
    const git = this.options.git;
    if (await this.knownWorktree(name.path)) {
      await git.fastForward(name.path, ticket.name.branch);
      return;
    }
    const existing = await git.revParse(repo, name.branch);
    await git.addWorktree(repo, name.path, name.branch, ticket.head);
    if (existing !== undefined) await git.fastForward(name.path, ticket.name.branch);
    const base = (await git.revParse(name.path, 'HEAD')) ?? ticket.head;
    await this.record(
      { projectId: state.projectId, op: 'worktreeCreated', worktree: { ticketId, key: name.key, scope: 'lane', ...(name.nodeId === undefined ? {} : { nodeId: name.nodeId }), ...(name.lane === undefined ? {} : { lane: name.lane }), path: name.path, branch: name.branch, base } },
      name.key,
      base,
    );
  }

  /**
   * The merge step of a join in worktree mode (§3.9 "합치기"): merges the branches of the lanes whose items the join
   * received into the ticket branch, in input order. Branches already in the ticket branch are skipped, so the step
   * can run again (after a person resolved a conflict, or after a crash).
   */
  async merge(target: PrepareTarget): Promise<MergeResult> {
    const step = await this.options.activity.track(() => this.exclusive(target.state.projectId, () => this.mergeStep(target)));
    if (step.kind === 'merge') return step;
    // The agent runs outside the lock (it may take minutes); checking its work takes the lock again.
    const { base, worktree, conflicts, agent } = step;
    return this.agentResolution(target, base, worktree, conflicts, agent);
  }

  private async mergeStep(
    target: PrepareTarget,
  ): Promise<
    | MergeResult
    | {
        kind: 'agent';
        base: Omit<MergeResult, 'outcome'>;
        worktree: string;
        conflicts: { branch: string; nodeId: string; lane: string; files: string[] }[];
        agent: { provider: AgentProvider; model?: string };
      }
  > {
    const { ticketId, state, workflow, node, exec } = target;
    let worktree: string | undefined;
    let branch: string | undefined;
    try {
      const ticket = await this.ensureTicketWorktree(state, ticketId);
      worktree = ticket.name.path;
      branch = ticket.name.branch;
      const git = this.options.git;
      const lanes = this.mergedLanes(state, workflow, ticketId, exec);
      const settings = nodeSettings(state, workflow, node.id);
      // A person rejected the held merge: an agent resolves it this time, with their comment.
      const policy = exec.cause === 'review' ? 'agent' : settings.onMergeConflict;
      const base = { kind: 'merge' as const, branch, worktree };
      if (await git.mergeInProgress(worktree)) {
        const unmerged = await git.unmerged(worktree);
        if (unmerged.length > 0) {
          // The branch being merged is the lane whose head is MERGE_HEAD.
          const mergeHead = await git.revParse(worktree, 'MERGE_HEAD');
          let pendingLane: (typeof lanes)[number] | undefined;
          for (const lane of lanes) {
            if (mergeHead !== undefined && (await git.revParse(worktree, `refs/heads/${lane.name.branch}`)) === mergeHead) pendingLane = lane;
          }
          const conflict = { branch: pendingLane?.name.branch ?? branch, nodeId: pendingLane?.nodeId ?? node.id, lane: pendingLane?.lane ?? 'main', files: unmerged };
          if (policy === 'agent') return { kind: 'agent', base, worktree, conflicts: [conflict], agent: settings.mergeAgent };
          if (policy === 'fail' || policy === 'rerun') return leftInProgress(worktree, branch, unmerged);
          return { ...base, outcome: 'conflict', conflicts: [conflict], head: ticket.head };
        }
        await git.concludeMerge(worktree);
      } else {
        await git.commitAll(worktree, `vuyro: work in the ticket worktree before merging ${node.id}`);
      }
      const merged: { branch: string; commit: string }[] = [];
      const conflicts: { branch: string; nodeId: string; lane: string; files: string[] }[] = [];
      for (const lane of lanes) {
        const commit = await git.revParse(worktree, `refs/heads/${lane.name.branch}`);
        if (commit === undefined) continue;
        if (await git.isAncestor(worktree, commit, 'HEAD')) {
          merged.push({ branch: lane.name.branch, commit });
          continue;
        }
        // fail and rerun never start a merge that would conflict, so there is never one to abort (D-042): the
        // conflict is found without touching the worktree, and the branch is simply not merged.
        if (policy === 'fail' || policy === 'rerun') {
          const predicted = await git.mergePreview(worktree, lane.name.branch);
          if (predicted.length > 0) {
            conflicts.push({ branch: lane.name.branch, nodeId: lane.nodeId, lane: lane.lane, files: predicted });
            if (policy === 'fail') break;
            continue;
          }
        }
        const files = await git.merge(worktree, lane.name.branch, `vuyro: merge ${lane.name.branch} (${node.id})`);
        if (files.length === 0) {
          merged.push({ branch: lane.name.branch, commit });
          continue;
        }
        const conflict = { branch: lane.name.branch, nodeId: lane.nodeId, lane: lane.lane, files };
        if (policy === 'ask') return { ...base, outcome: 'conflict', merged, conflicts: [conflict], head: (await git.revParse(worktree, 'HEAD')) ?? '' };
        if (policy === 'agent') return { kind: 'agent', base: { ...base, merged }, worktree, conflicts: [conflict], agent: settings.mergeAgent };
        // Predicted clean but conflicted all the same: the merge stays in progress for a person; nothing is aborted.
        return leftInProgress(worktree, branch, files);
      }
      const head = (await git.revParse(worktree, 'HEAD')) ?? '';
      if (conflicts.length > 0) return { ...base, outcome: 'conflict', merged, conflicts, head };
      return { ...base, outcome: 'merged', merged, head };
    } catch (error) {
      const message = error instanceof GitError || error instanceof Error ? error.message : String(error);
      return { kind: 'merge', outcome: 'error', error: message.slice(0, 65536), ...(worktree === undefined ? {} : { worktree }), ...(branch === undefined ? {} : { branch }) };
    }
  }

  private async agentResolution(
    target: PrepareTarget,
    base: Omit<MergeResult, 'outcome'>,
    worktree: string,
    conflicts: { branch: string; nodeId: string; lane: string; files: string[] }[],
    agent: { provider: AgentProvider; model?: string },
  ): Promise<MergeResult> {
    const git = this.options.git;
    const head = (await this.options.activity.track(() => git.revParse(worktree, 'HEAD'))) ?? '';
    if (this.options.resolveConflicts === undefined) return { ...base, outcome: 'conflict', conflicts, head };
    const comment = target.exec.feedback?.comment;
    const prompt = [
      'You are resolving a git merge conflict for Vuyro. The merge is in progress in the current folder.',
      `Branch being merged: ${conflicts.map((conflict) => conflict.branch).join(', ')}`,
      'Conflicting files:',
      ...conflicts.flatMap((conflict) => conflict.files.map((file) => `- ${file}`)),
      '',
      'Edit each file so that both sides of the work are kept and the conflict markers are gone, then stage them with `git add`.',
      'Do not commit, do not abort the merge, do not touch other branches. Exit when every file is resolved.',
      ...(comment === undefined || comment === '' ? [] : ['', 'Instructions from the person who asked for this:', comment]),
    ].join('\n');
    const ended = await this.options
      .resolveConflicts({
        ticketId: target.ticketId,
        nodeId: target.node.id,
        lane: target.exec.lane,
        run: target.exec.run,
        provider: agent.provider,
        ...(agent.model === undefined ? {} : { model: agent.model }),
        cwd: worktree,
        prompt,
      })
      .catch((error: unknown) => {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), 'resolving a merge conflict');
        return false;
      });
    const { unmerged, markers } = await this.options.activity.track(() =>
      this.exclusive(target.state.projectId, async () => {
        const left = await git.unmerged(worktree);
        return { unmerged: left, markers: left.length === 0 && ended ? this.conflictMarkers(worktree, conflicts) : [] };
      }),
    );
    // Resolved files still wait for a person (review); anything left over goes to them as a conflict.
    if (ended && unmerged.length === 0 && markers.length === 0) return { ...base, outcome: 'resolved', conflicts, head };
    return { ...base, outcome: 'conflict', conflicts: conflicts.map((conflict) => ({ ...conflict, files: unmerged.length > 0 ? unmerged : markers.length > 0 ? markers : conflict.files })), head };
  }

  private conflictMarkers(worktree: string, conflicts: readonly { files: readonly string[] }[]): string[] {
    const left: string[] = [];
    for (const file of conflicts.flatMap((conflict) => conflict.files)) {
      try {
        const text = readFileSync(join(worktree, file), 'utf8');
        if (/^<<<<<<< |^>>>>>>> /m.test(text)) left.push(file);
      } catch {
        // Deleted while resolving: no markers.
      }
    }
    return left;
  }

  /** The lanes (with worktrees of their own) whose results the join received, in input order. */
  private mergedLanes(state: TicketWorkflow, workflow: CompiledWorkflow, ticketId: string, exec: Execution): { nodeId: string; lane: string; name: WorktreeName }[] {
    const lanes = new Map<string, { nodeId: string; lane: string; name: WorktreeName }>();
    for (const items of Object.values(exec.inputs)) {
      for (const item of items) {
        for (const ref of item.lineage ?? []) {
          const sources = [ref, ...ancestorsOf(state, [ref], ref.nodeId)];
          for (const source of sources) {
            const lane = execution(state, source.nodeId, source.run)?.lane;
            if (lane === undefined || lane === 'main' || !laneWorktrees(state, workflow, source.nodeId)) continue;
            // The worktree (generation) the execution that produced the item worked in.
            const name = laneWorktree(this.options.services.layout.worktreeRoot, ticketId, source.nodeId, lane, worktreeGeneration(state, source.nodeId, lane, source.run));
            if (!lanes.has(name.key)) lanes.set(name.key, { nodeId: source.nodeId, lane, name });
          }
        }
      }
    }
    return [...lanes.values()];
  }

  // ---------------------------------------------------------------------------
  // Change detection

  private watchSettings(state: TicketWorkflow): { include: readonly string[]; exclude: readonly string[] } {
    return { include: state.workspace?.watch?.include ?? ['**'], exclude: state.workspace?.watch?.exclude ?? DEFAULT_WATCH_EXCLUDE };
  }

  private watched(state: TicketWorkflow, path: string): boolean {
    const { include, exclude } = this.watchSettings(state);
    const ci = this.options.services.caseInsensitive;
    return matchesAny(include, path, ci) && !matchesAny(exclude, path, ci) && !path.startsWith('.git/') && path !== '.git';
  }

  /**
   * Finds changed files in a space and records how the ledger explains them. Candidates: the read-only git status,
   * paths the watcher reported, paths seen changed before (a reverted file changes back), and the ledger's own paths
   * in the space. The verdict is the file's SHA-256 against the last recorded one. The first look at a space only
   * records where it starts (`workspace.baselined`).
   */
  async scan(projectId: string, location: Location, state: TicketWorkflow, reason: ScanReason, focus?: Holder, extra: readonly string[] = [], starting?: Holder): Promise<void> {
    const root = location.root;
    if (root === undefined || !existsSync(root)) return;
    const { services } = this.options;
    const ci = services.caseInsensitive;
    let dirty: Set<string> | undefined;
    const candidates = new Map<string, string>();
    const add = (path: string): void => {
      const normalized = normalizeRelative(path);
      if (normalized !== undefined && !isPattern(normalized) && this.watched(state, normalized)) candidates.set(pathKey(normalized, ci), normalized);
    };
    try {
      if ((await this.options.git.topLevel(root)) !== undefined) {
        dirty = new Set();
        for (const entry of await this.options.git.status(root)) {
          add(entry.path);
          dirty.add(pathKey(entry.path, ci));
        }
      }
    } catch (error) {
      this.options.reportError(error instanceof Error ? error : new Error(String(error)), `reading git status of ${root}`);
    }
    for (const path of extra) add(path);
    // The ledger is read after the files were listed: a checkout made before an edit that the listing saw is in it.
    const ledger = await this.ledger(projectId);
    const known = Object.hasOwn(ledger.known, location.space) ? (ledger.known[location.space] ?? {}) : undefined;
    for (const entry of Object.values(ledger.entries)) if (entry.space === location.space && entry.kind === 'checkout') add(entry.path);
    if (known === undefined) {
      const files: Record<string, string | null> = {};
      for (const path of candidates.values()) files[path] = await services.hash(root, path);
      await this.record({ projectId, op: 'baseline', space: location.space, files }, location.space, JSON.stringify(files));
      return;
    }
    for (const [key] of Object.entries(known)) {
      if (!candidates.has(key)) {
        const recorded = ledger.changed[location.space]?.[key]?.path ?? key;
        add(recorded);
      }
    }
    const holds = await this.holdingView(ledger);
    const running = (await this.runningIn(projectId, location.space)).filter((holder) => starting === undefined || !sameHolder(holder, starting));
    const changes: DetectedChange[] = [];
    for (const [key, path] of candidates) {
      const hash = await services.hash(root, path);
      const previous = Object.hasOwn(known, key) ? known[key] : undefined;
      if (previous === undefined) {
        // Never seen: a change when git calls it changed (or there is no git to ask), or when it differs from its checkout.
        const entry = Object.values(ledger.entries).find((candidate) => candidate.space === location.space && candidate.kind === 'checkout' && pathKey(candidate.path, ci) === key);
        const changed = entry?.baseHash !== undefined ? entry.baseHash !== hash : dirty === undefined || dirty.has(key);
        if (!changed) continue;
      } else if (previous === hash) {
        continue;
      }
      changes.push(this.attribute(ledger, location, path, hash, previous, holds, running, focus));
    }
    if (changes.length === 0) return;
    for (let index = 0; index < changes.length; index += 4096) {
      const batch = changes.slice(index, index + 4096);
      await this.record(
        { projectId, op: 'changes', space: location.space, scan: reason, changes: batch, ...(location.settings.overlapWarning && location.worktree?.scope === 'lane' ? { warnOverlaps: true } : {}) },
        location.space,
        reason,
        JSON.stringify(batch),
      );
    }
  }

  private attribute(
    ledger: LedgerState,
    location: Location,
    path: string,
    hash: string | null,
    previous: string | null | undefined,
    holds: (entry: LedgerEntry) => 'running' | 'held' | 'gone',
    running: readonly Holder[],
    focus: Holder | undefined,
  ): DetectedChange {
    const ci = this.options.services.caseInsensitive;
    const base = { path, hash, ...(previous === undefined ? {} : { previous }) };
    const covering = Object.values(ledger.entries).filter((entry) => entry.space === location.space && matches(entry.path, path, ci) && holds(entry) !== 'gone');
    const exclusive = covering.filter((entry) => entry.mode === 'exclusive');
    const runningHolder = exclusive.find((entry) => holds(entry) === 'running');
    if (runningHolder !== undefined) return { ...base, attribution: 'checkout', holder: runningHolder.holder };
    const held = exclusive[0] ?? covering[0];
    if (held !== undefined) return { ...base, attribution: 'conflict', holder: held.holder };
    const suspects = [...running];
    if (focus !== undefined && !suspects.some((holder) => sameHolder(holder, focus))) suspects.push(focus);
    // A lane's own worktree, or the ticket's worktree with one execution in it: the engine's folder, so it is theirs.
    if (location.worktree !== undefined && (location.worktree.scope === 'lane' || suspects.length === 1)) {
      const owner = focus ?? suspects[0];
      return { ...base, attribution: 'worktree', ...(owner === undefined ? {} : { holder: owner }) };
    }
    return { ...base, attribution: 'unattributed', ...(suspects.length === 0 ? {} : { suspects: suspects.slice(0, 64) }) };
  }

  /** Whether entries still hold, and whether their holder is running right now. */
  private async holdingView(ledger: LedgerState): Promise<(entry: LedgerEntry) => 'running' | 'held' | 'gone'> {
    const now = this.options.services.clock.now();
    const states = new Map<string, TicketWorkflow>();
    for (const entry of Object.values(ledger.entries)) if (!states.has(entry.holder.ticketId)) states.set(entry.holder.ticketId, await this.ticket(entry.holder.ticketId));
    return (entry) => {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) return 'gone';
      const state = states.get(entry.holder.ticketId);
      const exec = state === undefined ? undefined : execution(state, entry.holder.nodeId, entry.holder.run);
      const isRunning = exec?.status === 'running' && state !== undefined && holderActive(state, entry.holder);
      if (entry.release === 'manual') return isRunning ? 'running' : 'held';
      if (state === undefined || !state.exists || state.status !== 'open') return 'gone';
      if (entry.retained === true) return 'held';
      if (!holderActive(state, entry.holder)) return 'gone';
      return isRunning ? 'running' : 'held';
    };
  }

  /** Executions of the project running in a space. */
  private async runningIn(projectId: string, space: string): Promise<Holder[]> {
    const holders: Holder[] = [];
    for (const ticketId of await this.openTickets(projectId)) {
      const state = await this.ticket(ticketId);
      if (state.template === undefined) continue;
      let workflow: CompiledWorkflow;
      try {
        workflow = await this.options.definitions.workflow(state.template);
      } catch {
        continue;
      }
      for (const [nodeId, progress] of Object.entries(state.nodes)) {
        const node = workflow.nodes.get(nodeId);
        if (node === undefined) continue;
        for (const lane of progress.laneOrder) {
          const exec = currentExecution(state, nodeId, lane);
          if (exec?.status !== 'running') continue;
          if (this.locate({ ticketId, state, workflow, node }, lane, exec.run).space === space) holders.push({ ticketId, nodeId, lane, run: exec.run });
        }
      }
    }
    return holders;
  }

  private async openTickets(projectId: string): Promise<string[]> {
    const rows = await this.options.store.query<{ ticket_id: string }>("SELECT ticket_id FROM p_tickets WHERE project_id = ? AND status = 'open' ORDER BY created_at", [projectId]);
    return rows.map((row) => row.ticket_id);
  }

  /** What changed in the holder's checked-out files while it was paused (pauseHash), for its prompt. Clears the pause hashes. */
  private async resumeNotes(projectId: string, location: Location, holder: Holder): Promise<string[]> {
    const ledger = await this.ledger(projectId);
    const paused = Object.values(ledger.entries).filter((entry) => sameHolder(entry.holder, holder) && entry.pauseHash !== undefined && entry.space === location.space);
    if (paused.length === 0 || location.root === undefined) return [];
    const changed: { entryId: string; path: string; pauseHash: string | null; hash: string | null }[] = [];
    for (const entry of paused) {
      if (isPattern(entry.path)) continue;
      const hash = await this.options.services.hash(location.root, entry.path);
      if (hash !== (entry.pauseHash ?? null)) changed.push({ entryId: entry.id, path: entry.path, pauseHash: entry.pauseHash ?? null, hash });
    }
    await this.record({ projectId, op: 'resume', holder, changed }, holderKey(holder), JSON.stringify(changed.map((entry) => [entry.entryId, entry.hash])));
    if (changed.length === 0) return [];
    return [
      [
        '## Changed while you were paused',
        'You were stopped and are now resumed in the same session. These files you had checked out were changed by someone else in the meantime; read them again before you continue:',
        ...changed.map((entry) => `- ${entry.path}${entry.hash === null ? ' (deleted)' : ''}`),
      ].join('\n'),
    ];
  }

  // ---------------------------------------------------------------------------
  // Watching

  private startWatching(projectId: string, location: Location, state: TicketWorkflow, user: string): void {
    const watcher = this.options.watcher;
    const root = location.root;
    if (watcher === undefined || root === undefined || this.stopped) return;
    const existing = this.watches.get(location.space);
    if (existing !== undefined) {
      existing.users.add(user);
      return;
    }
    const entry = { handle: Promise.resolve<WatchHandle | undefined>(undefined), users: new Set([user]), paths: new Set<string>(), projectId, root } as {
      handle: Promise<WatchHandle | undefined>;
      users: Set<string>;
      paths: Set<string>;
      timer?: TimerHandle | undefined;
      projectId: string;
      root: string;
    };
    const ignore = [...(state.workspace?.watch?.exclude ?? DEFAULT_WATCH_EXCLUDE), '.git/**', '.git'];
    entry.handle = watcher
      .watch(
        root,
        ignore,
        (paths) => {
          for (const path of paths) entry.paths.add(path);
          if (entry.timer !== undefined) return;
          entry.timer = this.options.services.clock.setTimeout(() => {
            entry.timer = undefined;
            const batch = [...entry.paths];
            entry.paths.clear();
            this.enqueue(async () => {
              const fresh = await this.ticketForSpace(projectId, location.space);
              if (fresh !== undefined) await this.exclusive(projectId, () => this.scan(projectId, location, fresh, 'watch', undefined, batch));
            });
          }, this.options.watchDebounceMs ?? 1000);
        },
        (error) => {
          this.options.reportError(error, `watching ${root}`);
        },
      )
      .catch((error: unknown) => {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), `watching ${root}`);
        return undefined;
      });
    this.watches.set(location.space, entry);
  }

  private async ticketForSpace(projectId: string, space: string): Promise<TicketWorkflow | undefined> {
    const running = await this.runningIn(projectId, space);
    const first = running[0];
    return first === undefined ? undefined : this.ticket(first.ticketId);
  }

  private stopWatching(space: string, user: string): void {
    const entry = this.watches.get(space);
    if (entry === undefined) return;
    entry.users.delete(user);
    if (entry.users.size > 0) return;
    this.watches.delete(space);
    if (entry.timer !== undefined) this.options.services.clock.clearTimeout(entry.timer);
    void entry.handle.then((handle) => handle?.close()).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Reacting to events

  onEvents(events: readonly DomainEvent[]): void {
    if (this.stopped) return;
    for (const event of events) {
      if (event.type === 'ticket.created') this.projectOf.set(event.aggregateId, event.data.projectId);
      if (event.aggregateType === 'workspace' && (event.type === 'checkout.released' || event.type === 'checkout.acquired' || event.type === 'worktree.cleanupApproved')) {
        this.touch(event.data.projectId);
      }
      if (event.aggregateType !== 'ticket') continue;
      if (event.type === 'ticket.completed' || (event.type === 'node.completed' && event.data.status === 'done')) this.cleanup.add(event.aggregateId);
      if (
        event.type === 'node.completed' ||
        event.type === 'node.superseded' ||
        event.type === 'node.returned' ||
        event.type === 'node.paused' ||
        event.type === 'node.requeued' ||
        event.type === 'ticket.completed'
      ) {
        const projectId = this.projectOf.get(event.aggregateId);
        if (projectId !== undefined) this.touch(projectId);
        else
          this.enqueue(async () => {
            this.touch((await this.ticket(event.aggregateId)).projectId);
          });
      }
    }
  }

  private touch(projectId: string): void {
    if (projectId === '' || this.pending.has(projectId)) return;
    this.pending.add(projectId);
    this.enqueue(async () => {
      this.pending.delete(projectId);
      await this.reconcile(projectId);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    if (this.stopped) return;
    const done = this.options.activity.begin();
    this.chain = this.chain
      .then(work)
      .catch((error: unknown) => {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), 'workspace bookkeeping');
      })
      .finally(done);
  }

  /** Waits until the queued bookkeeping is done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * Brings a project's ledger in line with its tickets: releases what ended, keeps `ticketDone` entries for the ticket,
   * records pause hashes, removes worktrees that are merged or whose ticket completed, and resumes lanes that waited
   * for paths nobody holds any more.
   */
  async reconcile(projectId: string, reason: 'event' | 'recovery' = 'event'): Promise<void> {
    const ledger = await this.ledger(projectId);
    const now = this.options.services.clock.now();
    const release = new Map<string, string[]>();
    const retain: string[] = [];
    const pauses = new Map<string, { holder: Holder; hashes: Record<string, string | null> }>();
    const releaseAs = (reasonName: string, id: string): void => {
      release.set(reasonName, [...(release.get(reasonName) ?? []), id]);
    };
    let nextExpiry: number | undefined;
    for (const entry of Object.values(ledger.entries)) {
      if (entry.expiresAt !== undefined) {
        if (entry.expiresAt <= now) {
          releaseAs('expired', entry.id);
          continue;
        }
        nextExpiry = Math.min(nextExpiry ?? entry.expiresAt, entry.expiresAt);
      }
      // A person releases manual entries (or their ttl does).
      if (entry.release === 'manual') continue;
      const state = await this.ticket(entry.holder.ticketId);
      const open = state.exists && state.status === 'open';
      if (entry.retained === true) {
        if (!open) releaseAs(reason === 'recovery' ? 'recovered' : 'ticketDone', entry.id);
        continue;
      }
      const exec = execution(state, entry.holder.nodeId, entry.holder.run);
      if (open && exec !== undefined && holderActive(state, entry.holder)) {
        if (exec.status === 'paused' && entry.pauseHash === undefined && !isPattern(entry.path)) {
          const key = holderKey(entry.holder);
          const pause = pauses.get(key) ?? { holder: entry.holder, hashes: {} };
          pause.hashes[entry.id] = await this.hashEntry(state, entry);
          pauses.set(key, pause);
        }
        continue;
      }
      // The holder ended: by finishing (its own release), or by being replaced, discarded or never finishing.
      const ended = exec === undefined || exec.status === 'superseded' || exec.status === 'discarded' || currentExecution(state, entry.holder.nodeId, entry.holder.lane)?.run !== entry.holder.run;
      if (reason === 'recovery') releaseAs('recovered', entry.id);
      else if (ended) releaseAs('ended', entry.id);
      else if (entry.release === 'ticketDone' && open) retain.push(entry.id);
      else releaseAs(entry.release, entry.id);
    }
    for (const [reasonName, ids] of release) await this.record({ projectId, op: 'release', ids, reason: reasonName }, reasonName, ...ids);
    if (retain.length > 0) await this.record({ projectId, op: 'retain', ids: retain }, ...retain);
    for (const pause of pauses.values()) await this.record({ projectId, op: 'pause', holder: pause.holder, hashes: pause.hashes }, holderKey(pause.holder), JSON.stringify(pause.hashes));
    this.scheduleExpiry(projectId, nextExpiry);
    // Kept worktrees are looked at again when their ticket's work moves on and at engine start; a person's approved
    // clean-ups are carried out on the next pass.
    if (reason === 'recovery' || Object.keys(ledger.approved).length > 0 || Object.keys(ledger.worktrees).some((key) => this.cleanup.has(ledger.worktrees[key]?.ticketId ?? ''))) {
      await this.exclusive(projectId, () => this.cleanWorktrees(projectId, reason === 'recovery'));
      for (const worktree of Object.values(ledger.worktrees)) this.cleanup.delete(worktree.ticketId);
    }
    await this.resumeWaiting(projectId);
  }

  private async hashEntry(state: TicketWorkflow, entry: LedgerEntry): Promise<string | null> {
    if (state.template === undefined) return null;
    try {
      const workflow = await this.options.definitions.workflow(state.template);
      const node = workflow.nodes.get(entry.holder.nodeId);
      if (node === undefined) return null;
      const root = this.locate({ ticketId: entry.holder.ticketId, state, workflow, node }, entry.holder.lane, entry.holder.run).root;
      return root === undefined ? null : await this.options.services.hash(root, entry.path);
    } catch {
      return null;
    }
  }

  private scheduleExpiry(projectId: string, at: number | undefined): void {
    const clock = this.options.services.clock;
    const existing = this.expiryTimers.get(projectId);
    if (existing !== undefined) clock.clearTimeout(existing);
    this.expiryTimers.delete(projectId);
    if (at === undefined || this.stopped) return;
    this.expiryTimers.set(
      projectId,
      clock.setTimeout(() => {
        this.expiryTimers.delete(projectId);
        this.touch(projectId);
      }, Math.max(0, at - clock.now())),
    );
  }

  /** Lanes paused for a claim whose paths nobody holds any more go again (their start checks the claims again). */
  private async resumeWaiting(projectId: string): Promise<void> {
    const ledger = await this.ledger(projectId);
    const holds = await this.holdingView(ledger);
    const waiting: { ticketId: string; exec: Execution; priority: number; revision: number }[] = [];
    for (const ticketId of await this.openTickets(projectId)) {
      const state = await this.ticket(ticketId);
      for (const [nodeId, progress] of Object.entries(state.nodes)) {
        for (const lane of progress.laneOrder) {
          const exec = currentExecution(state, nodeId, lane);
          if (exec?.status !== 'paused' || exec.claimWait === undefined) continue;
          const stillHeld = exec.claimWait.conflicts.some((conflict) => {
            const entry = ledger.entries[conflict.entryId];
            return entry !== undefined && holds(entry) !== 'gone';
          });
          if (!stillHeld) waiting.push({ ticketId, exec, priority: state.priority, revision: this.tickets.get(ticketId)?.revision ?? 0 });
        }
      }
    }
    waiting.sort((a, b) => b.priority - a.priority);
    for (const { ticketId, exec, revision } of waiting) {
      const response = await this.options.bus.execute(
        {
          // The ticket revision makes every pause its own request (a lane may wait for a claim more than once).
          requestId: requestId('resume', ticketId, exec.nodeId, exec.lane, exec.run, revision),
          type: 'node.resume',
          payload: { ticketId, nodeId: exec.nodeId, lane: exec.lane },
        },
        SYSTEM,
      );
      if (!response.ok && response.error.code !== 'invariant_violated') this.options.reportError(new Error(`${response.error.code}: ${response.error.message}`), `resuming ${exec.nodeId} lane ${exec.lane}`);
    }
  }

  /**
   * Automatic clean-up (D-041, D-042). The engine removes a worktree on its own only when it is done with it (its ticket
   * completed, or a lane's branch is merged into the ticket branch) **and** it holds nothing at all: no changed, untracked
   * or ignored file. Anything else stays and is recorded as `worktree.kept` for a person, who removes it with
   * `worktree.cleanup` after seeing what it holds. A lane worktree replaced by a newer generation (`rerun`) is kept
   * while its ticket is open. Removal never uses `--force` here; branches are deleted only when merged.
   */
  private async cleanWorktrees(projectId: string, all = false): Promise<void> {
    await this.carryOutApprovals(projectId);
    const ledger = await this.ledger(projectId);
    const git = this.options.git;
    for (const worktree of Object.values(ledger.worktrees)) {
      if (!all && !this.cleanup.has(worktree.ticketId)) continue;
      try {
        const status = await this.worktreeStatus(worktree);
        if (status === undefined || status.inUse) continue;
        let removal: 'merged' | 'ticketDone';
        if (status.ticketDone) removal = 'ticketDone';
        else if (status.superseded) {
          await this.recordKept(projectId, worktree, 'superseded', await this.contentsOf(worktree.path));
          continue;
        } else if (worktree.scope === 'lane' && status.merged) removal = 'merged';
        else continue;
        const contents = await this.contentsOf(worktree.path);
        if (contents === undefined || contents.changed.length > 0 || contents.ignored.length > 0) {
          await this.recordKept(projectId, worktree, removal, contents);
          continue;
        }
        if (existsSync(worktree.path)) await git.removeWorktree(status.repo, worktree.path);
        // Only while it still is the commit found merged: a commit added since keeps the branch.
        const branchDeleted = worktree.scope === 'lane' && status.merged && status.head !== undefined && (await git.deleteBranch(status.repo, worktree.branch, status.head));
        await this.record({ projectId, op: 'worktreeRemoved', ticketId: worktree.ticketId, key: worktree.key, reason: removal, branchDeleted }, worktree.key, worktree.base);
      } catch (error) {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), `cleaning up worktree ${worktree.path}`);
      }
    }
  }

  /**
   * Where a worktree stands: in use (its ticket's work, or a lane's current worktree while the lane is active), done
   * with (ticket completed), a lane branch merged into the ticket branch, or a replaced generation of a lane.
   */
  private async worktreeStatus(
    worktree: Worktree,
  ): Promise<{ repo: string; ticketDone: boolean; inUse: boolean; merged: boolean; superseded: boolean; head?: string } | undefined> {
    const state = await this.ticket(worktree.ticketId);
    const repo = state.workspace?.root;
    if (repo === undefined) return undefined;
    const ticketDone = !state.exists || state.status !== 'open';
    if (worktree.scope === 'ticket') return { repo, ticketDone, inUse: !ticketDone, merged: false, superseded: false };
    const git = this.options.git;
    const lane = worktree.nodeId === undefined || worktree.lane === undefined ? undefined : currentExecution(state, worktree.nodeId, worktree.lane);
    const current =
      lane === undefined || worktree.nodeId === undefined || worktree.lane === undefined
        ? undefined
        : laneWorktree(this.options.services.layout.worktreeRoot, worktree.ticketId, worktree.nodeId, worktree.lane, worktreeGeneration(state, worktree.nodeId, worktree.lane, lane.run)).key;
    const superseded = current !== undefined && current !== worktree.key;
    const ticketBranch = ticketWorktree(this.options.services.layout.worktreeRoot, worktree.ticketId).branch;
    const head = await git.revParse(repo, `refs/heads/${worktree.branch}`);
    const merged = head !== undefined && (await git.revParse(repo, `refs/heads/${ticketBranch}`)) !== undefined && (await git.isAncestor(repo, head, `refs/heads/${ticketBranch}`));
    const inUse = !ticketDone && !superseded && lane !== undefined && ACTIVE_STATUSES.has(lane.status);
    return { repo, ticketDone, inUse, merged, superseded, ...(head === undefined ? {} : { head }) };
  }

  /** What a worktree holds beyond its commit (undefined: it could not be read, so it is treated as holding something). */
  private async contentsOf(path: string): Promise<{ changed: string[]; ignored: string[] } | undefined> {
    if (!existsSync(path)) return { changed: [], ignored: [] };
    try {
      const contents = await this.options.git.contents(path);
      return { changed: [...new Set(contents.changed)].sort(), ignored: [...new Set(contents.ignored)].sort() };
    } catch (error) {
      this.options.reportError(error instanceof Error ? error : new Error(String(error)), `reading what ${path} holds (it is kept)`);
      return undefined;
    }
  }

  private async recordKept(projectId: string, worktree: Worktree, removal: 'merged' | 'ticketDone' | 'superseded', contents: { changed: string[]; ignored: string[] } | undefined): Promise<void> {
    const changed = contents?.changed ?? [];
    const ignored = contents?.ignored ?? [];
    await this.record(
      { projectId, op: 'worktreeKept', ticketId: worktree.ticketId, key: worktree.key, removal, files: changed.slice(0, 1000), count: changed.length, ignored: ignored.slice(0, 1000), ignoredCount: ignored.length },
      worktree.key,
      removal,
      JSON.stringify([changed.slice(0, 1000), ignored.slice(0, 1000)]),
    );
  }

  /** Changes whenever anything in the worktree changes: its commit, or any changed, untracked or ignored file (with content). */
  private async fingerprint(path: string, contents: { changed: string[]; ignored: string[] }): Promise<string> {
    const hash = createHash('sha256');
    hash.update(JSON.stringify([existsSync(path) ? ((await this.options.git.revParse(path, 'HEAD')) ?? null) : null, contents.changed, contents.ignored]));
    for (const file of [...contents.changed, ...contents.ignored]) hash.update(`\u0000${file}\u0000${(await this.options.services.hash(path, file)) ?? 'none'}`);
    return `sha256:${hash.digest('hex')}`;
  }

  /**
   * Worktrees a person may clean up (`vuyro workspace cleanup`): every worktree the engine is not using, with what it
   * holds and the fingerprint `worktree.cleanup` must send back.
   */
  async cleanupCandidates(projectId: string, ticketId?: string): Promise<WorktreeCleanupCandidate[]> {
    return this.options.activity.track(() =>
      this.exclusive(projectId, async () => {
        const ledger = await this.ledger(projectId);
        const candidates: WorktreeCleanupCandidate[] = [];
        for (const worktree of Object.values(ledger.worktrees)) {
          if (ticketId !== undefined && worktree.ticketId !== ticketId) continue;
          const status = await this.worktreeStatus(worktree);
          if (status === undefined || status.inUse) continue;
          const contents = await this.contentsOf(worktree.path);
          if (contents === undefined) continue;
          candidates.push({
            key: worktree.key,
            ticketId: worktree.ticketId,
            scope: worktree.scope,
            ...(worktree.nodeId === undefined ? {} : { nodeId: worktree.nodeId }),
            ...(worktree.lane === undefined ? {} : { lane: worktree.lane }),
            path: worktree.path,
            branch: worktree.branch,
            merged: worktree.scope === 'lane' && status.merged,
            files: contents.changed.slice(0, 200),
            count: contents.changed.length,
            ignored: contents.ignored.slice(0, 200),
            ignoredCount: contents.ignored.length,
            fingerprint: await this.fingerprint(worktree.path, contents),
          });
        }
        return candidates;
      }),
    );
  }

  /**
   * Clean-ups a person approved: the worktree goes (with `--force`: they saw what it holds) only if it still has the
   * fingerprint they were shown and the engine is not using it. Otherwise the approval is dropped with the reason.
   */
  private async carryOutApprovals(projectId: string): Promise<void> {
    const ledger = await this.ledger(projectId);
    for (const [key, approved] of Object.entries(ledger.approved)) {
      const worktree = ledger.worktrees[key];
      if (worktree === undefined) continue;
      try {
        const status = await this.worktreeStatus(worktree);
        if (status === undefined || status.inUse) {
          await this.record({ projectId, op: 'cleanupSkipped', key, reason: 'inUse', detail: 'the engine is using this worktree' }, key, approved, 'inUse');
          continue;
        }
        const contents = await this.contentsOf(worktree.path);
        if (contents === undefined || (await this.fingerprint(worktree.path, contents)) !== approved) {
          await this.record({ projectId, op: 'cleanupSkipped', key, reason: 'changed', detail: 'the worktree changed after it was shown; look at it again' }, key, approved, 'changed');
          continue;
        }
        if (existsSync(worktree.path)) await this.options.git.removeWorktree(status.repo, worktree.path, { approvedByPerson: true });
        const branchDeleted = worktree.scope === 'lane' && status.merged && status.head !== undefined && (await this.options.git.deleteBranch(status.repo, worktree.branch, status.head));
        await this.record({ projectId, op: 'worktreeRemoved', ticketId: worktree.ticketId, key, reason: 'manual', branchDeleted }, key, worktree.base, 'manual');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.record({ projectId, op: 'cleanupSkipped', key, reason: 'error', detail: message.slice(0, 4096) }, key, approved, 'error');
      }
    }
  }

  /**
   * At engine start (after orphaned runs settled): every project's ledger is reconciled (entries of executions that
   * ended while the engine was down are released as `recovered`), and the spaces with recorded state are scanned for
   * changes made while nobody watched (`startup`, unattributed).
   */
  async recover(): Promise<void> {
    const rows = await this.options.store.query<{ project_id: string }>('SELECT project_id FROM p_projects ORDER BY created_at');
    for (const { project_id: projectId } of rows) {
      await this.reconcile(projectId, 'recovery');
      const ledger = await this.ledger(projectId);
      for (const ticketId of await this.openTickets(projectId)) {
        const state = await this.ticket(ticketId);
        if (state.template === undefined) continue;
        let workflow: CompiledWorkflow;
        try {
          workflow = await this.options.definitions.workflow(state.template);
        } catch {
          continue;
        }
        const spaces = new Set<string>();
        for (const nodeId of Object.keys(state.nodes)) {
          const node = workflow.nodes.get(nodeId);
          if (node === undefined) continue;
          for (const lane of nodeProgress(state, nodeId).laneOrder) {
            const location = this.locate({ ticketId, state, workflow, node }, lane);
            if (spaces.has(location.space) || !Object.hasOwn(ledger.known, location.space)) continue;
            spaces.add(location.space);
            await this.exclusive(projectId, () => this.scan(projectId, location, state, 'startup'));
          }
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [space, entry] of this.watches) {
      for (const user of [...entry.users]) this.stopWatching(space, user);
    }
    for (const timer of this.expiryTimers.values()) this.options.services.clock.clearTimeout(timer);
    this.expiryTimers.clear();
  }

  /** Whether a join of this ticket runs as a merge step. */
  static merges(state: TicketWorkflow, workflow: CompiledWorkflow, nodeId: string): boolean {
    return mergingJoins(state, workflow).has(nodeId);
  }

  /** Workspace-relative form of an absolute path in a location (hooks send absolute paths). */
  static relative(location: Location, path: string, caseInsensitive: boolean): string | undefined {
    return location.root === undefined ? undefined : insideRoot(location.root, path, caseInsensitive);
  }
}
