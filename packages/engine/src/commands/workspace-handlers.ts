import {
  APP_SETTINGS_AGGREGATE_ID,
  type CheckoutEntry,
  type ClaimSpec,
  type ClaimWait,
  type CommandError,
  type CommandPayload,
  commandError,
  type Conflict,
  type DetectedChange,
  type Holder,
  workspaceAggregateId,
} from '@vuyro/contracts';
import type { NewEvent, StreamAppend } from '../store/event-store.ts';
import type { CompiledNode, CompiledWorkflow } from '../workflow/compile.ts';
import { parseDuration } from '../workflow/duration.ts';
import { WorkflowDraft } from '../workflow/machine.ts';
import { ACTIVE_STATUSES, currentExecution, type Execution, execution, type TicketWorkflow } from '../workflow/state.ts';
import { locate, type Location } from '../workspace/layout.ts';
import { entriesOf, findConflicts, holderKey, keptSignature, type LedgerEntry, type LedgerState, type PathRequest, sameHolder, warnKey } from '../workspace/ledger.ts';
import { insideRoot, isPattern, matches, normalizeRelative, pathKey } from '../workspace/paths.ts';
import type { WorkspaceServices } from '../workspace/services.ts';
import { mergeSettings } from '../workspace/settings.ts';
import { appSettingsAggregate, type AppSettingsState, projectAggregate, type ProjectState, type TicketState, ticketAggregate, workspaceAggregate } from './aggregates.ts';
import type { CommandTarget } from './authorize.ts';
import type { CommandHandler, HandlerContext, Loaded } from './handlers.ts';

/**
 * Workspace commands (M4, [[명령·이벤트 계약]] §14): project and app settings, the internal checkout ledger
 * (claims at node start, checkouts right before an edit, conflicts and their policies), and the engine's own
 * bookkeeping. The ledger is Vuyro's alone: nothing here locks or checks out anything in git or Perforce.
 */

type Failure = { readonly ok: false; readonly error: CommandError };
const fail = (code: CommandError['code'], message: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  error: commandError(code, message, details),
});

export function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export function servicesOf(ctx: HandlerContext): WorkspaceServices {
  if (ctx.workspaces === undefined) throw new Error('the command bus has no workspace services');
  return ctx.workspaces;
}

function stream(aggregateType: string, loaded: Loaded<unknown>, events: readonly NewEvent[]): StreamAppend {
  return { aggregateType, aggregateId: loaded.aggregateId, expectedRevision: loaded.revision, events };
}

// ---------------------------------------------------------------------------
// Settings

export const projectConfigure: CommandHandler<'project.configure', ProjectState> = {
  target: (payload) => ({ definition: projectAggregate, aggregateId: payload.projectId }),
  scope: () => ({}),
  decide: (ctx, payload, target) => {
    if (target === undefined) throw new Error('project not loaded');
    if (!target.state.exists) return Promise.resolve(fail('not_found', `project ${payload.projectId} does not exist`));
    return worktreeNeedsRepository(ctx, payload, target.state).then(
      (refusal) => refusal ?? { ok: true, appends: [stream('project', target, [{ type: 'project.configured', data: payload }])], result: {} },
    );
  },
};

/**
 * Worktree mode needs the project folder to be a git repository's own folder (D-072): checked when the change touches
 * the folder or the settings, against the folder the project has after it and its effective mode (the app layer it
 * inherits, then its own).
 */
async function worktreeNeedsRepository(ctx: HandlerContext, payload: CommandPayload<'project.configure'>, state: ProjectState): Promise<Failure | undefined> {
  if (payload.root === undefined && payload.settings === undefined) return undefined;
  const app = await ctx.load(appSettingsAggregate, APP_SETTINGS_AGGREGATE_ID);
  if (mergeSettings(app.state.settings, payload.settings ?? state.settings).workspaceMode !== 'worktree') return undefined;
  return repositoryFor(ctx, payload.root === undefined ? state.root : (payload.root ?? undefined));
}

/** The folder worktree mode needs: there, and a git repository's own folder. */
export async function repositoryFor(ctx: HandlerContext, root: string | undefined): Promise<Failure | undefined> {
  if (root === undefined) return fail('validation_failed', 'worktree mode needs a project folder that is a git repository');
  if (!(await servicesOf(ctx).isGitRepository(root))) return fail('validation_failed', `worktree mode needs a git repository, and ${root} is not the top folder of one`);
  return undefined;
}

export const appConfigure: CommandHandler<'app.configure', AppSettingsState> = {
  target: () => ({ definition: appSettingsAggregate, aggregateId: APP_SETTINGS_AGGREGATE_ID }),
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    if (target === undefined) throw new Error('settings not loaded');
    return Promise.resolve({ ok: true, appends: [stream('settings', target, [{ type: 'app.configured', data: payload }])], result: {} });
  },
};

/** What `ticket.create` pins: the project's folder and the app + project settings layers. */
export async function ticketWorkspace(ctx: HandlerContext, project: ProjectState): Promise<NonNullable<TicketWorkflow['workspace']> | undefined> {
  const app = await ctx.load(appSettingsAggregate, APP_SETTINGS_AGGREGATE_ID);
  const settings = { ...(app.state.settings ?? {}), ...(project.settings ?? {}) };
  if (project.root === undefined && project.baseRef === undefined && project.watch === undefined && Object.keys(settings).length === 0) return undefined;
  return {
    ...(project.root === undefined ? {} : { root: project.root }),
    ...(project.baseRef === undefined ? {} : { baseRef: project.baseRef }),
    ...(project.watch === undefined ? {} : { watch: project.watch }),
    settings,
  };
}

// ---------------------------------------------------------------------------
// Claims and checkouts

export interface ClaimItem extends PathRequest {
  readonly kind: 'claim' | 'checkout';
  readonly release: 'nodeDone' | 'ticketDone' | 'manual';
  readonly ttlMs?: number;
  /** Claim-level override of the node's policy. */
  readonly onConflict?: ClaimWait['policy'];
  readonly pauseMode?: 'boundary' | 'immediate';
}

export type ClaimOutcome = 'granted' | 'overlap' | 'wait' | 'ask' | 'fail';

export interface ClaimDecision {
  readonly outcome: ClaimOutcome;
  readonly conflicts: readonly Conflict[];
  /** Events of the project's ledger. */
  readonly ledgerEvents: readonly NewEvent[];
  readonly ledger: Loaded<LedgerState>;
  /** What the requester waits for (wait, ask, fail). */
  readonly claim?: ClaimWait;
  /** Running executions of other tickets a higher-priority request takes paths from (priorityWins, immediate). */
  readonly preempted: readonly { readonly holder: Holder; readonly claim: ClaimWait }[];
  /** The workspace-relative paths the requester now holds. */
  readonly paths: readonly string[];
  /** Ids of the entries recorded (granted, overlap). */
  readonly entryIds?: readonly string[];
}

/** Severity order: the strictest resolution of any conflict decides for the whole request. */
const SEVERITY = { warn: 0, preempt: 1, wait: 2, ask: 3, fail: 4 } as const;
type Resolution = keyof typeof SEVERITY;

/** Whether a ledger entry still holds its paths: not expired, and its holder still active (or a person keeps it). */
async function holdingCheck(ctx: HandlerContext, requester: Loaded<TicketState>, entries: readonly LedgerEntry[]): Promise<(entry: LedgerEntry) => boolean> {
  const now = servicesOf(ctx).clock.now();
  const tickets = new Map<string, TicketWorkflow>([[requester.aggregateId, requester.state]]);
  for (const entry of entries) {
    if (!tickets.has(entry.holder.ticketId)) tickets.set(entry.holder.ticketId, (await ctx.load(ticketAggregate, entry.holder.ticketId)).state);
  }
  return (entry) => {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) return false;
    if (entry.release === 'manual') return true;
    const state = tickets.get(entry.holder.ticketId);
    if (state === undefined || !state.exists || state.status !== 'open') return false;
    if (entry.retained === true) return true;
    return holderActive(state, entry.holder);
  };
}

/** The holder's execution is still its lane's current one and still active. */
export function holderActive(state: TicketWorkflow, holder: Holder): boolean {
  const exec = execution(state, holder.nodeId, holder.run);
  return exec !== undefined && exec.lane === holder.lane && ACTIVE_STATUSES.has(exec.status) && currentExecution(state, holder.nodeId, holder.lane)?.run === holder.run;
}

/** A lane waiting for paths (paused for a claim, or about to be). */
function waitOf(exec: Execution | undefined): ClaimWait | undefined {
  return exec?.claimWait ?? exec?.pauseClaim?.claim;
}

/**
 * Deadlock check ([[공유·권한·BlackBoard 설계]] §3.7 "교착 상태"): would the requester wait on someone who (through
 * other waits) waits on it? An entry a ticket keeps after its node ended stands for every waiting lane of that ticket.
 */
async function wouldDeadlock(ctx: HandlerContext, ledger: LedgerState, requester: Holder, conflicts: readonly Conflict[]): Promise<boolean> {
  const seen = new Set<string>();
  const queue: Conflict[] = [...conflicts];
  while (queue.length > 0) {
    const conflict = queue.shift();
    if (conflict === undefined) break;
    const entry = ledger.entries[conflict.entryId];
    const ticket = (await ctx.load(ticketAggregate, conflict.holder.ticketId)).state;
    const holders: Holder[] = [];
    if (entry?.retained === true) {
      for (const [nodeId, progress] of Object.entries(ticket.nodes)) {
        for (const exec of progress.executions) if (waitOf(exec) !== undefined) holders.push({ ticketId: conflict.holder.ticketId, nodeId, lane: exec.lane, run: exec.run });
      }
    } else {
      holders.push(conflict.holder);
    }
    for (const holder of holders) {
      const key = holderKey(holder);
      if (seen.has(key)) continue;
      seen.add(key);
      const wait = waitOf(execution(ticket, holder.nodeId, holder.run));
      if (wait === undefined) continue;
      for (const next of wait.conflicts) {
        const nextEntry = ledger.entries[next.entryId];
        if (sameHolder(next.holder, requester)) return true;
        if (nextEntry?.retained === true && next.holder.ticketId === requester.ticketId) return true;
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Decides a claim or checkout request of one execution against the project's ledger (§3.7, §3.8):
 * - no conflict: granted (entries recorded, checkouts with the file's hash now);
 * - `warn`: granted, the overlap recorded; a person's override of a waiting lane does the same;
 * - `firstWins`: the requester waits; `priorityWins`: a higher-priority ticket takes the paths from a running
 *   holder whose entries say `pauseMode: immediate` (the holder pauses), else waits like `firstWins`;
 * - `ask`: waits for a person; a deadlock between waiting lanes goes to a person whatever the policy;
 * - `fail`: the requester fails.
 */
export async function decideClaims(
  ctx: HandlerContext,
  args: {
    readonly ticket: Loaded<TicketState>;
    readonly workflow: CompiledWorkflow;
    readonly holder: Holder;
    readonly location: Location;
    readonly items: readonly ClaimItem[];
    readonly source: 'start' | 'hook' | 'agent';
    readonly override: boolean;
    /**
     * A shared node's batch (M5): the other member executions hold the same entries, and nothing the member tickets
     * hold conflicts with it (the batch builds those tickets' own changes; their kept entries would block it forever).
     */
    readonly batch?: { readonly holders: readonly Holder[] };
  },
): Promise<ClaimDecision> {
  const services = servicesOf(ctx);
  const { ticket, holder, location, items, source } = args;
  const projectId = ticket.state.projectId;
  const ledger = await ctx.load(workspaceAggregate, workspaceAggregateId(projectId));
  const fresh = items.filter((item) => !alreadyCovers(ledger.state, location.space, holder, item, services.caseInsensitive));
  const members = args.batch?.holders ?? [];
  const memberTickets = new Set(members.map((member) => member.ticketId));
  const own = (conflict: Conflict): boolean =>
    members.some((member) => sameHolder(member, conflict.holder)) || (ledger.state.entries[conflict.entryId]?.retained === true && memberTickets.has(conflict.holder.ticketId));
  const candidates = findConflicts(ledger.state, location.space, fresh, holder, () => true, services.caseInsensitive).filter((conflict) => !own(conflict));
  const holds = await holdingCheck(
    ctx,
    ticket,
    candidates.map((conflict) => ledger.state.entries[conflict.entryId]).filter((entry): entry is LedgerEntry => entry !== undefined),
  );
  const conflicts = candidates.filter((conflict) => {
    const entry = ledger.state.entries[conflict.entryId];
    return entry !== undefined && holds(entry);
  });
  const paths = items.map((item) => item.path);

  // Resolve each conflict with the requester's policy (the claim's own, else the node's settings).
  const policyOf = (path: string): ClaimWait['policy'] => items.find((item) => item.path === path)?.onConflict ?? location.settings.onConflict;
  let resolution: Resolution = 'warn';
  const preemptible: Conflict[] = [];
  for (const conflict of conflicts) {
    const policy = policyOf(conflict.path);
    let next: Resolution;
    if (policy === 'warn') next = 'warn';
    else if (policy === 'fail') next = 'fail';
    else if (policy === 'ask') next = 'ask';
    // A batch never takes paths from a running agent: it waits like `firstWins`.
    else if (policy === 'priorityWins' && args.batch === undefined && (await canPreempt(ctx, ledger.state, ticket, conflict))) next = 'preempt';
    else next = 'wait';
    if (next === 'preempt') preemptible.push(conflict);
    if (SEVERITY[next] > SEVERITY[resolution]) resolution = next;
  }
  if (args.override) resolution = 'warn';
  const policy = conflicts.length === 0 ? location.settings.onConflict : policyOf(conflicts[0]?.path ?? '');

  if (conflicts.length > 0 && (resolution === 'wait' || resolution === 'ask' || resolution === 'fail')) {
    const deadlock = resolution === 'wait' && (await wouldDeadlock(ctx, ledger.state, holder, conflicts));
    const outcome: 'wait' | 'ask' | 'fail' = deadlock ? 'ask' : resolution;
    const claim: ClaimWait = {
      policy,
      conflicts: conflicts.slice(0, 256),
      ...(outcome === 'ask' ? { ask: true as const } : {}),
      ...(deadlock ? { deadlock: true as const } : {}),
    };
    const blocked: NewEvent = {
      type: 'checkout.blocked',
      data: {
        projectId,
        requester: holder,
        space: location.space,
        paths: paths.slice(0, 1024),
        source,
        conflicts: conflicts.slice(0, 256),
        policy,
        outcome,
        ...(deadlock ? { deadlock: true as const } : {}),
      },
    };
    return { outcome, conflicts, ledgerEvents: [blocked], ledger, claim, preempted: [], paths: [] };
  }

  const now = services.clock.now();
  const entries: CheckoutEntry[] = [];
  for (const item of fresh) {
    const baseHash = item.kind === 'checkout' && location.root !== undefined ? await services.hash(location.root, item.path) : undefined;
    for (const entryHolder of [holder, ...members.filter((member) => !sameHolder(member, holder))]) {
      entries.push({
        id: ctx.ids.next(),
        space: location.space,
        path: item.path,
        kind: item.kind,
        mode: item.mode,
        holder: entryHolder,
        release: item.release,
        onConflict: item.onConflict ?? location.settings.onConflict,
        pauseMode: item.pauseMode ?? location.settings.pauseMode,
        priority: ticket.state.priority,
        ...(item.ttlMs === undefined ? {} : { expiresAt: now + item.ttlMs }),
        ...(baseHash === undefined ? {} : { baseHash }),
      });
    }
  }
  const events: NewEvent[] = [];
  const preempted: { holder: Holder; claim: ClaimWait }[] = [];
  if (resolution === 'preempt' && !args.override) {
    // The higher-priority request takes the paths: the holders' overlapping entries go, the holders pause and
    // wait for the requester's new entries.
    events.push({ type: 'checkout.released', data: { projectId, ids: [...new Set(preemptible.map((conflict) => conflict.entryId))], reason: 'preempted' } });
    const byHolder = new Map<string, { holder: Holder; conflicts: Conflict[] }>();
    for (const conflict of preemptible) {
      const key = holderKey(conflict.holder);
      const waiting = byHolder.get(key) ?? { holder: conflict.holder, conflicts: [] };
      for (const entry of entries) {
        if (matches(entry.path, conflict.entryPath, services.caseInsensitive) || matches(conflict.entryPath, entry.path, services.caseInsensitive) || entry.path === conflict.path) {
          waiting.conflicts.push({ path: conflict.entryPath, entryId: entry.id, entryPath: entry.path, holder });
        }
      }
      byHolder.set(key, waiting);
    }
    for (const { holder: preemptedHolder, conflicts: waits } of byHolder.values()) {
      preempted.push({ holder: preemptedHolder, claim: { policy: 'priorityWins', conflicts: waits.slice(0, 256), preemptedBy: holder } });
    }
  }
  const overlaps = resolution === 'warn' ? conflicts : [];
  if (entries.length > 0) {
    events.push({ type: 'checkout.acquired', data: { projectId, entries, source, ...(overlaps.length === 0 ? {} : { overlaps: overlaps.slice(0, 256) }) } });
  }
  return { outcome: overlaps.length > 0 ? 'overlap' : 'granted', conflicts, ledgerEvents: events, ledger, preempted, paths, entryIds: entries.map((entry) => entry.id) };
}

/** A running agent of a lower-priority ticket whose entry allows immediate pausing can be preempted. */
async function canPreempt(ctx: HandlerContext, ledger: LedgerState, requester: Loaded<TicketState>, conflict: Conflict): Promise<boolean> {
  const entry = ledger.entries[conflict.entryId];
  if (entry === undefined || entry.retained === true || entry.pauseMode !== 'immediate') return false;
  if (conflict.holder.ticketId === requester.aggregateId) return false;
  const holderTicket = (await ctx.load(ticketAggregate, conflict.holder.ticketId)).state;
  if (requester.state.priority <= holderTicket.priority) return false;
  const exec = execution(holderTicket, conflict.holder.nodeId, conflict.holder.run);
  return exec?.status === 'running' && exec.executor === 'agent' && !exec.pauseRequested;
}

function alreadyCovers(ledger: LedgerState, space: string, holder: Holder, item: ClaimItem, caseInsensitive: boolean): boolean {
  return entriesOf(ledger, holder).some((entry) => {
    if (entry.space !== space || (entry.mode === 'shared' && item.mode === 'exclusive')) return false;
    if (entry.kind === 'checkout' || isPattern(item.path)) return entry.kind === item.kind && pathKey(entry.path, caseInsensitive) === pathKey(item.path, caseInsensitive);
    return matches(entry.path, item.path, caseInsensitive);
  });
}

/** Appends for `node.pauseRequested` on the tickets whose running holders were preempted. */
export async function preemptionAppends(ctx: HandlerContext, decision: ClaimDecision, skipTicket: string): Promise<StreamAppend[]> {
  const byTicket = new Map<string, { holder: Holder; claim: ClaimWait }[]>();
  for (const entry of decision.preempted) {
    if (entry.holder.ticketId === skipTicket) continue;
    byTicket.set(entry.holder.ticketId, [...(byTicket.get(entry.holder.ticketId) ?? []), entry]);
  }
  const appends: StreamAppend[] = [];
  for (const [ticketId, list] of byTicket) {
    const loaded = await ctx.load(ticketAggregate, ticketId);
    appends.push(
      stream(
        'ticket',
        loaded,
        list.map(({ holder, claim }) => ({ type: 'node.pauseRequested', data: { ticketId, nodeId: holder.nodeId, lane: holder.lane, run: holder.run, claim } })),
      ),
    );
  }
  return appends;
}

/** A node type's declared claims as ledger requests (patterns normalized; invalid ones are reported). */
export function claimItems(claims: readonly ClaimSpec[]): ClaimItem[] | Failure {
  const items: ClaimItem[] = [];
  for (const [index, claim] of claims.entries()) {
    const path = normalizeRelative(claim.path);
    if (path === undefined) return fail('invariant_violated', `claim ${index} ('${claim.path}') is not a path inside the workspace`);
    items.push({
      path,
      mode: claim.mode,
      kind: 'claim',
      release: claim.release ?? 'nodeDone',
      ...(claim.ttl === undefined ? {} : { ttlMs: parseDuration(claim.ttl) }),
      ...(claim.onConflict === undefined ? {} : { onConflict: claim.onConflict }),
      ...(claim.pauseMode === undefined ? {} : { pauseMode: claim.pauseMode }),
    });
  }
  return items;
}

export function holderOf(ticketId: string, exec: Execution): Holder {
  return { ticketId, nodeId: exec.nodeId, lane: exec.lane, run: exec.run };
}

function describeConflicts(conflicts: readonly Conflict[]): string {
  return conflicts
    .slice(0, 5)
    .map((conflict) => `'${conflict.path}' is held by node '${conflict.holder.nodeId}' (lane ${conflict.holder.lane}) of ticket ${conflict.holder.ticketId} ('${conflict.entryPath}')`)
    .join('; ');
}

/** The scope of a node agent's checkout: its run decides the lane (see laneScope in workflow-handlers). */
function checkoutScope(payload: { ticketId: string; nodeId: string; lane?: string }, target: Loaded<TicketState> | undefined): CommandTarget {
  const scope: CommandTarget = { ticketId: payload.ticketId, nodeId: payload.nodeId };
  if (payload.lane === undefined || target === undefined) return scope;
  const runId = currentExecution(target.state, payload.nodeId, payload.lane)?.runIds.at(-1);
  return { ...scope, runId: runId ?? 'none' };
}

/** The running execution a checkout is for: the caller's run, or (a person) the named or only running lane. */
function runningExecution(ctx: HandlerContext, ticket: TicketState, nodeId: string, lane: string | undefined): Execution | Failure {
  const runId = ctx.caller.binding?.runId;
  if (runId !== undefined) {
    const owner = Object.hasOwn(ticket.runIndex, runId) ? ticket.runIndex[runId] : undefined;
    const exec = owner === undefined ? undefined : execution(ticket, owner.nodeId, owner.run);
    if (exec === undefined || owner?.nodeId !== nodeId) return fail('invariant_violated', `run ${runId} is not an execution of node '${nodeId}'`);
    if (currentExecution(ticket, exec.nodeId, exec.lane)?.run !== exec.run || exec.status !== 'running' || exec.runIds.at(-1) !== runId) {
      return fail('invariant_violated', `run ${runId} no longer drives lane '${exec.lane}' of node '${exec.nodeId}' (it is ${exec.status})`);
    }
    return exec;
  }
  const lanes = lane === undefined ? Object.keys(ticket.nodes[nodeId]?.lanes ?? {}) : [lane];
  const running = lanes.map((name) => currentExecution(ticket, nodeId, name)).filter((exec): exec is Execution => exec?.status === 'running');
  const [only] = running;
  if (only === undefined) return fail('invariant_violated', `node '${nodeId}' has no running lane${lane === undefined ? '' : ` '${lane}'`}`);
  if (running.length > 1) return fail('invariant_violated', `several lanes of node '${nodeId}' are running; name one with 'lane'`);
  return only;
}

/**
 * Builds what a checkout request needs: the ticket's workflow, the caller's running execution and where it works.
 * `openWorkflow` comes from the workflow handlers (it refuses tickets that are closed or need attention).
 */
export interface CheckoutContext {
  readonly workflow: CompiledWorkflow;
  readonly node: CompiledNode;
  readonly exec: Execution;
  readonly location: Location;
}

export async function checkoutContext(
  ctx: HandlerContext,
  ticket: Loaded<TicketState>,
  payload: { nodeId: string; lane?: string },
  openWorkflow: (ctx: HandlerContext, ticket: Loaded<TicketState>) => Promise<CompiledWorkflow | Failure>,
): Promise<CheckoutContext | Failure> {
  const workflow = await openWorkflow(ctx, ticket);
  if (isFailure(workflow)) return workflow;
  const node = workflow.nodes.get(payload.nodeId);
  if (node === undefined) return fail('not_found', `node '${payload.nodeId}' is not in template ${workflow.template.id}@${workflow.template.version}`);
  const exec = runningExecution(ctx, ticket.state, node.id, payload.lane);
  if (isFailure(exec)) return exec;
  const location = locate(servicesOf(ctx).layout, ticket.state, ticket.aggregateId, workflow, node.id, exec.lane, exec.run);
  return { workflow, node, exec, location };
}

export function checkoutAcquire(
  openWorkflow: (ctx: HandlerContext, ticket: Loaded<TicketState>) => Promise<CompiledWorkflow | Failure>,
): CommandHandler<'checkout.acquire', TicketState> {
  return {
    target: (payload) => ({ definition: ticketAggregate, aggregateId: payload.ticketId }),
    scope: checkoutScope,
    scopeNeedsTarget: (payload) => payload.lane !== undefined,
    decide: async (ctx, payload, target) => {
      if (target === undefined) throw new Error('ticket not loaded');
      const services = servicesOf(ctx);
      const found = await checkoutContext(ctx, target, payload, openWorkflow);
      if (isFailure(found)) return found;
      const { workflow, exec, location } = found;
      if (location.root === undefined) {
        // No folder is known for this execution, so nothing can overlap: there is no shared folder to protect.
        return { ok: true, appends: [], result: { granted: true, decision: 'outside', reason: 'this execution has no workspace folder' } };
      }
      const mode = payload.mode ?? 'exclusive';
      const items: ClaimItem[] = [];
      const seen = new Set<string>();
      for (const [index, raw] of payload.paths.entries()) {
        if (isPattern(raw)) {
          return fail('validation_failed', 'a checkout names files, not patterns (patterns are claims of the node type)', { issues: [{ path: `/paths/${index}`, message: 'wildcards are not allowed' }] });
        }
        const path = insideRoot(location.root, raw, services.caseInsensitive);
        if (path === undefined) continue;
        const key = pathKey(path, services.caseInsensitive);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ path, mode, kind: 'checkout', release: 'nodeDone' });
      }
      if (items.length === 0) return { ok: true, appends: [], result: { granted: true, decision: 'outside', reason: 'no path is inside the workspace folder' } };
      const holder = holderOf(target.aggregateId, exec);
      const decision = await decideClaims(ctx, { ticket: target, workflow, holder, location, items, source: payload.source ?? 'agent', override: exec.override === true });
      const appends: StreamAppend[] = [];
      if (decision.ledgerEvents.length > 0) appends.push(stream('workspace', decision.ledger, decision.ledgerEvents));
      if (decision.outcome === 'granted' || decision.outcome === 'overlap') {
        appends.push(...(await preemptionAppends(ctx, decision, target.aggregateId)));
        return {
          ok: true,
          appends,
          result: {
            granted: true,
            decision: decision.outcome,
            paths: decision.paths.slice(0, 256),
            ...(decision.outcome === 'overlap' ? { reason: `overlap allowed (warn): ${describeConflicts(decision.conflicts)}`, conflicts: decision.conflicts.slice(0, 256) } : {}),
          },
        };
      }
      // Refused: the running lane stops (it waits for the paths, or fails); the agent's edit is blocked by the hook.
      if (exec.executor === 'agent' && decision.claim !== undefined) {
        const draft = new WorkflowDraft(target.aggregateId, target.state, workflow);
        draft.emit({
          type: 'node.pauseRequested',
          data: { ticketId: target.aggregateId, nodeId: exec.nodeId, lane: exec.lane, run: exec.run, claim: decision.claim, ...(decision.outcome === 'fail' ? { fail: true as const } : {}) },
        });
        appends.push(stream('ticket', target, draft.events));
      }
      const what =
        decision.outcome === 'fail'
          ? 'this node fails (onConflict: fail)'
          : decision.outcome === 'ask'
            ? `a person decides which goes first${decision.claim?.deadlock === true ? ' (the waits form a cycle)' : ''}; this node pauses until then`
            : 'this node pauses and resumes once the files are free';
      return {
        ok: true,
        appends,
        result: { granted: false, decision: decision.outcome, reason: `checkout refused: ${describeConflicts(decision.conflicts)}. ${what}.`, conflicts: decision.conflicts.slice(0, 256) },
      };
    },
  };
}

export function checkoutRelease(
  openWorkflow: (ctx: HandlerContext, ticket: Loaded<TicketState>) => Promise<CompiledWorkflow | Failure>,
): CommandHandler<'checkout.release', TicketState> {
  return {
    target: (payload) => ({ definition: ticketAggregate, aggregateId: payload.ticketId }),
    scope: checkoutScope,
    scopeNeedsTarget: (payload) => payload.lane !== undefined,
    decide: async (ctx, payload, target) => {
      if (target === undefined) throw new Error('ticket not loaded');
      const services = servicesOf(ctx);
      const found = await checkoutContext(ctx, target, payload, openWorkflow);
      if (isFailure(found)) return found;
      const { exec, location } = found;
      const ledger = await ctx.load(workspaceAggregate, workspaceAggregateId(target.state.projectId));
      const keys =
        payload.paths === undefined || location.root === undefined
          ? undefined
          : new Set(
              payload.paths
                .map((raw) => (location.root === undefined ? undefined : insideRoot(location.root, raw, services.caseInsensitive)))
                .filter((path): path is string => path !== undefined)
                .map((path) => pathKey(path, services.caseInsensitive)),
            );
      // Only checkouts: claims belong to the node and end with it.
      const ids = entriesOf(ledger.state, holderOf(target.aggregateId, exec))
        .filter((entry) => entry.kind === 'checkout' && (keys === undefined || keys.has(pathKey(entry.path, services.caseInsensitive))))
        .map((entry) => entry.id);
      if (ids.length === 0) return { ok: true, appends: [], result: { released: 0 } };
      return {
        ok: true,
        appends: [stream('workspace', ledger, [{ type: 'checkout.released', data: { projectId: target.state.projectId, ids, reason: 'manual' } }])],
        result: { released: ids.length },
      };
    },
  };
}

export const checkoutForceRelease: CommandHandler<'checkout.forceRelease', LedgerState> = {
  target: (payload) => ({ definition: workspaceAggregate, aggregateId: workspaceAggregateId(payload.projectId) }),
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    if (target === undefined) throw new Error('ledger not loaded');
    const ids = [...new Set(payload.ids)].filter((id) => Object.hasOwn(target.state.entries, id));
    if (ids.length === 0) return Promise.resolve({ ok: true, appends: [], result: { released: 0 } });
    return Promise.resolve({
      ok: true,
      appends: [stream('workspace', target, [{ type: 'checkout.released', data: { projectId: payload.projectId, ids, reason: 'manual' } }])],
      result: { released: ids.length },
    });
  },
};

/**
 * A person's confirmed clean-up of a worktree (`vuyro workspace cleanup`): recorded here, carried out by the engine,
 * which removes it only if what it holds still has the fingerprint the person saw (D-042). Human only (fixed rule).
 */
export const worktreeCleanup: CommandHandler<'worktree.cleanup', LedgerState> = {
  target: (payload) => ({ definition: workspaceAggregate, aggregateId: workspaceAggregateId(payload.projectId) }),
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    if (target === undefined) throw new Error('ledger not loaded');
    const worktree = target.state.worktrees[payload.key];
    if (worktree === undefined) return Promise.resolve(fail('not_found', `project ${payload.projectId} has no worktree '${payload.key}'`));
    if (target.state.approved[payload.key] === payload.fingerprint) return Promise.resolve({ ok: true, appends: [], result: { requested: true } });
    return Promise.resolve({
      ok: true,
      appends: [
        stream('workspace', target, [{ type: 'worktree.cleanupApproved', data: { projectId: payload.projectId, ticketId: worktree.ticketId, key: payload.key, fingerprint: payload.fingerprint } }]),
      ],
      result: { requested: true },
    });
  },
};

/** The engine's bookkeeping. Ids that are already gone are dropped (the step may run twice after a crash). */
export const workspaceRecord: CommandHandler<'workspace.record', LedgerState> = {
  target: (payload) => ({ definition: workspaceAggregate, aggregateId: workspaceAggregateId(payload.projectId) }),
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    if (target === undefined) throw new Error('ledger not loaded');
    const ledger = target.state;
    const { projectId } = payload;
    const events: NewEvent[] = [];
    switch (payload.op) {
      case 'release': {
        const ids = [...new Set(payload.ids)].filter((id) => Object.hasOwn(ledger.entries, id));
        if (ids.length > 0) events.push({ type: 'checkout.released', data: { projectId, ids, reason: payload.reason } });
        break;
      }
      case 'retain': {
        const ids = [...new Set(payload.ids)].filter((id) => Object.hasOwn(ledger.entries, id) && ledger.entries[id]?.retained !== true);
        if (ids.length > 0) events.push({ type: 'checkout.retained', data: { projectId, ids } });
        break;
      }
      case 'pause': {
        const hashes = Object.fromEntries(Object.entries(payload.hashes).filter(([id]) => ledger.entries[id] !== undefined && sameHolder(ledger.entries[id].holder, payload.holder)));
        if (Object.keys(hashes).length > 0) events.push({ type: 'checkout.paused', data: { projectId, holder: payload.holder, hashes } });
        break;
      }
      case 'resume':
        if (entriesOf(ledger, payload.holder).some((entry) => entry.pauseHash !== undefined) || payload.changed.length > 0) {
          events.push({ type: 'checkout.resumed', data: { projectId, holder: payload.holder, changed: payload.changed } });
        }
        break;
      case 'changes': {
        events.push({ type: 'workspace.changesDetected', data: { projectId, space: payload.space, scan: payload.scan, changes: payload.changes } });
        if (payload.warnOverlaps === true) events.push(...overlapWarnings(ledger, projectId, payload.space, payload.changes));
        break;
      }
      case 'baseline':
        events.push({ type: 'workspace.baselined', data: { projectId, space: payload.space, files: payload.files } });
        break;
      case 'worktreeCreated':
        if (ledger.worktrees[payload.worktree.key]?.path !== payload.worktree.path || ledger.worktrees[payload.worktree.key]?.base !== payload.worktree.base) {
          events.push({ type: 'worktree.created', data: { projectId, worktree: payload.worktree } });
        }
        break;
      case 'worktreeKept': {
        // Once per content: the clean-up looks again on every pass.
        const reason = payload.removal === 'superseded' ? 'superseded' : payload.count > 0 ? 'uncommitted' : 'ignored';
        const data = {
          projectId,
          ticketId: payload.ticketId,
          key: payload.key,
          removal: payload.removal,
          reason,
          files: payload.files,
          count: payload.count,
          ignored: payload.ignored,
          ignoredCount: payload.ignoredCount,
        } as const;
        if (Object.hasOwn(ledger.worktrees, payload.key) && ledger.kept[payload.key] !== keptSignature(data)) events.push({ type: 'worktree.kept', data });
        break;
      }
      case 'cleanupSkipped':
        if (Object.hasOwn(ledger.approved, payload.key)) {
          events.push({ type: 'worktree.cleanupSkipped', data: { projectId, key: payload.key, reason: payload.reason, ...(payload.detail === undefined ? {} : { detail: payload.detail }) } });
        }
        break;
      case 'worktreeRemoved':
        if (Object.hasOwn(ledger.worktrees, payload.key)) {
          events.push({ type: 'worktree.removed', data: { projectId, ticketId: payload.ticketId, key: payload.key, reason: payload.reason, branchDeleted: payload.branchDeleted } });
        }
        break;
    }
    return Promise.resolve({ ok: true, appends: events.length === 0 ? [] : [stream('workspace', target, events)], result: {} });
  },
};

/** Files a worktree changed that another worktree changed too: a merge conflict is likely (§3.9 "미리 알려주기"). */
function overlapWarnings(ledger: LedgerState, projectId: string, space: string, changes: readonly DetectedChange[]): NewEvent[] {
  const events: NewEvent[] = [];
  const warned = new Set<string>();
  for (const change of changes) {
    if (change.attribution !== 'worktree') continue;
    const key = pathKey(change.path);
    for (const [other, paths] of Object.entries(ledger.changed)) {
      // Lane worktrees only (`wt:<ticket>/<node>-<lane>`): what the ticket's own worktree changes is not merged.
      if (other === space || !other.includes('/') || !Object.hasOwn(paths, key)) continue;
      const pair = warnKey(change.path, space, other);
      if (ledger.warned[pair] === true || warned.has(pair)) continue;
      warned.add(pair);
      const otherHolder = paths[key]?.holder;
      events.push({
        type: 'workspace.overlapWarned',
        data: {
          projectId,
          path: change.path,
          spaces: [space, other],
          holders: [...(change.holder === undefined ? [] : [change.holder]), ...(otherHolder === undefined ? [] : [otherHolder])],
        },
      });
    }
  }
  return events;
}
