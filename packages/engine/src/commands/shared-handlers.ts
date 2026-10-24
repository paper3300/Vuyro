import {
  APP_SETTINGS_AGGREGATE_ID,
  type ArtifactRef,
  batchIdOf,
  type BatchTrigger,
  type CommandError,
  commandError,
  type CommandPayload,
  type Holder,
  type NodeRunOutput,
  type SharedNodeSpec,
  sharedNodeAggregateId,
  workspaceAggregateId,
} from '@vuyro/contracts';
import { blameMembers, reportedFiles, scanErrors } from '../shared/blame.ts';
import { currentDefinition, type QueueEntry, runningBatches, type SharedNodeState } from '../shared/state.ts';
import type { NewEvent, StreamAppend } from '../store/event-store.ts';
import { type CompiledNode, type CompiledWorkflow, compileSharedNode, DefinitionError, SHARED_NODE_PARAM } from '../workflow/compile.ts';
import { DefinitionLoadError } from '../workflow/definitions.ts';
import { parseDuration } from '../workflow/duration.ts';
import { buildOutput, complete, failureOutput, finishWithOutput, WorkflowDraft } from '../workflow/machine.ts';
import { currentExecution, type Execution, execution } from '../workflow/state.ts';
import { sameHolder } from '../workspace/ledger.ts';
import { effectiveSettings, mergeSettings, nodeSettings } from '../workspace/settings.ts';
import { appSettingsAggregate, projectAggregate, sharedNodeAggregate, type TicketState, ticketAggregate, workspaceAggregate } from './aggregates.ts';
import type { CommandHandler, HandlerContext, Loaded } from './handlers.ts';
import { isFailure, openWorkflow, scriptOutput } from './workflow-handlers.ts';
import { claimItems, decideClaims, servicesOf } from './workspace-handlers.ts';

/**
 * Shared node commands (M5, [[명령·이벤트 계약]] §15, [[공유·권한·BlackBoard 설계]] §4).
 *
 * A request node (`completion: 'shared'`) of a ticket is queued by the engine (`sharedNode.enqueue`). A trigger starts a
 * batch (`sharedNode.start`, or a person's `sharedNode.run`): every member's request node turns running in the same
 * commit, and the batch takes the shared node's `protect` paths as shared claims. The engine runs the node type once
 * and reports it (`sharedNode.finish`): every member ticket gets its own share of the result in the same commit. A failed
 * batch is settled by `onBatchFailure`: `blame` fails the tickets that changed the files in the errors, puts the others
 * back at the front of the queue and blocks the shared node until the blamed tickets come back fixed.
 */

type Failure = { readonly ok: false; readonly error: CommandError };
const fail = (code: CommandError['code'], message: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  error: commandError(code, message, details),
});

const sharedTarget = (payload: { projectId: string; name: string }) => ({
  definition: sharedNodeAggregate,
  aggregateId: sharedNodeAggregateId(payload.projectId, payload.name),
});

function sharedStream(shared: Loaded<SharedNodeState>, events: readonly NewEvent[]): StreamAppend {
  return { aggregateType: 'shared', aggregateId: shared.aggregateId, expectedRevision: shared.revision, events };
}

function ticketStream(ticket: Loaded<TicketState>, events: readonly NewEvent[]): StreamAppend {
  return { aggregateType: 'ticket', aggregateId: ticket.aggregateId, expectedRevision: ticket.revision, events };
}

function requireShared(target: Loaded<SharedNodeState> | undefined): Loaded<SharedNodeState> {
  if (target === undefined) throw new Error('shared node not loaded');
  return target;
}

function holderOf(entry: Holder): Holder {
  return { ticketId: entry.ticketId, nodeId: entry.nodeId, lane: entry.lane, run: entry.run };
}

/** The node a shared node runs, compiled from its pinned type. Fails closed when the file changed. */
async function sharedNodeOf(ctx: HandlerContext, spec: SharedNodeSpec, pinned: { type: string; version: number; hash?: string }): Promise<CompiledNode | Failure> {
  if (ctx.definitions === undefined) return fail('invariant_violated', 'this engine has no definition store');
  let found;
  try {
    found = await ctx.definitions.pinnedNodeType(pinned.type, pinned.version, pinned.hash);
  } catch (error) {
    if (error instanceof DefinitionLoadError || error instanceof DefinitionError) return fail('invariant_violated', `shared node '${spec.name}' cannot use its node type: ${error.message}`);
    throw error;
  }
  if (found === undefined) return fail('not_found', `node type ${pinned.type}@${pinned.version} is not active`);
  const { node, issues } = compileSharedNode(spec, found.nodeType, ctx.definitions.dataValidator);
  if (node === undefined) {
    return fail('validation_failed', `shared node '${spec.name}' is not valid`, { issues: issues.map((issue) => ({ path: `/spec${issue.path}`, message: issue.message })) });
  }
  return node;
}

// ---------------------------------------------------------------------------
// Definition

/** Parts of a spec this version accepts but does not act on (recorded in [[결정 대기]]). */
function unsupported(spec: SharedNodeSpec): string[] {
  const warnings: string[] = [];
  const trigger = spec.batchTrigger;
  if (trigger.schedule !== undefined) warnings.push("batchTrigger.schedule is not supported yet: it never starts a batch (use count, window, afterPrevious or 'sharedNode.run')");
  if (trigger.expediteOnPriority === true) warnings.push('batchTrigger.expediteOnPriority is not supported yet: high-priority requests wait for the triggers like any other');
  if (trigger.count === undefined && trigger.window === undefined && trigger.afterPrevious !== true) {
    warnings.push("no automatic trigger this version runs: batches start only when a person runs them ('sharedNode.run')");
  }
  if (spec.onBatchFailure === 'ask' || spec.onBatchFailure === 'bisect' || spec.onBatchFailure === 'agent') {
    warnings.push(`onBatchFailure '${spec.onBatchFailure}' is not supported yet: a failed batch is settled as 'allFail' (every ticket gets the failure)`);
  }
  return warnings;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const sharedNodeDefine: CommandHandler<'sharedNode.define', SharedNodeState> = {
  target: (payload) => sharedTarget({ projectId: payload.projectId, name: payload.spec.name }),
  scope: () => ({}),
  decide: async (ctx, payload, target) => {
    const shared = requireShared(target);
    const project = await ctx.load(projectAggregate, payload.projectId);
    if (!project.state.exists) return fail('not_found', `project ${payload.projectId} does not exist`);
    const { spec } = payload;
    if (ctx.definitions === undefined) return fail('invariant_violated', 'this engine has no definition store');
    let pinned;
    try {
      pinned = await ctx.definitions.pinnedNodeType(spec.node.type, spec.node.version);
    } catch (error) {
      if (error instanceof DefinitionLoadError || error instanceof DefinitionError) return fail('invariant_violated', error.message);
      throw error;
    }
    if (pinned === undefined) return fail('not_found', `node type ${spec.node.type}@${spec.node.version} is not active`);
    const node = await sharedNodeOf(ctx, spec, { type: spec.node.type, version: spec.node.version, hash: pinned.hash });
    if (isFailure(node)) return node;
    const nodeType = { type: spec.node.type, version: spec.node.version, hash: pinned.hash };
    const warnings = unsupported(spec);
    const existing = currentDefinition(shared.state);
    if (existing !== undefined && sameJson(existing.spec, spec) && sameJson(existing.nodeType, nodeType)) {
      return { ok: true, appends: [], result: { name: spec.name, version: shared.state.version, warnings } };
    }
    const version = shared.state.version + 1;
    return {
      ok: true,
      appends: [sharedStream(shared, [{ type: 'sharedNode.defined', data: { projectId: payload.projectId, name: spec.name, version, spec, nodeType } }])],
      result: { name: spec.name, version, warnings },
    };
  },
};

// ---------------------------------------------------------------------------
// Queue

/** The request execution a holder names, if it is still its lane's current one. */
function requestExecution(state: TicketState, request: Holder): Execution | undefined {
  const exec = execution(state, request.nodeId, request.run);
  if (exec?.lane !== request.lane || currentExecution(state, request.nodeId, request.lane)?.run !== request.run) return undefined;
  return exec;
}

/** Fails a request node's execution through its error port (the request cannot be served). */
function failRequest(draft: WorkflowDraft, node: CompiledNode, exec: Execution, error: string, details: Record<string, unknown> = {}): void {
  complete(draft, node.id, exec.run, failureOutput(node, exec, error, details), 'failed', { error });
}

export const sharedNodeEnqueue: CommandHandler<'sharedNode.enqueue', SharedNodeState> = {
  target: sharedTarget,
  scope: (payload) => ({ ticketId: payload.ticketId, nodeId: payload.nodeId }),
  decide: async (ctx, payload, target) => {
    const shared = requireShared(target);
    const ticket = await ctx.load(ticketAggregate, payload.ticketId);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    if (ticket.state.projectId !== payload.projectId) return fail('invariant_violated', `ticket ${payload.ticketId} is not in project ${payload.projectId}`);
    const node = workflow.nodes.get(payload.nodeId);
    if (node === undefined) return fail('not_found', `node '${payload.nodeId}' is not in template ${workflow.template.id}@${workflow.template.version}`);
    if (node.completion !== 'shared') return fail('invariant_violated', `node '${node.id}' is not a request node (${node.completion})`);
    if (node.params[SHARED_NODE_PARAM] !== payload.name) return fail('invariant_violated', `node '${node.id}' requests shared node '${String(node.params[SHARED_NODE_PARAM])}', not '${payload.name}'`);
    const request = holderOf(payload);
    const exec = requestExecution(ticket.state, request);
    if (exec === undefined) return fail('not_found', `node '${payload.nodeId}' has no current run ${payload.run} on lane '${payload.lane}'`);
    const queued = shared.state.queue.some((entry) => sameHolder(entry, request)) || runningBatches(shared.state).some((batch) => batch.members.some((member) => sameHolder(member, request)));
    if (queued) return { ok: true, appends: [], result: { queued: true } };
    if (exec.status !== 'queued') return { ok: true, appends: [], result: { queued: false, reason: `the request is ${exec.status}, not queued` } };

    // A request that cannot be served fails through its error port, with the reason (it can be retried).
    const refuse = (reason: string, details: Record<string, unknown> = {}) => {
      const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
      failRequest(draft, node, exec, reason, details);
      return { ok: true as const, appends: [ticketStream(ticket, draft.events)], result: { queued: false, reason } };
    };
    const definition = currentDefinition(shared.state);
    if (!shared.state.exists || definition === undefined) return refuse(`shared node '${payload.name}' is not defined in this project`);
    if (nodeSettings(ticket.state, workflow, node.id).workspaceMode !== 'shared') {
      return refuse('shared nodes build the shared project folder: this ticket works in worktree mode (merging ticket branches for a batch is not supported yet)');
    }
    const schema = definition.spec.requestSchema;
    if (schema !== undefined && ctx.definitions !== undefined) {
      const issues = Object.entries(exec.inputs).flatMap(([port, items]) =>
        items.flatMap((item, index) => ctx.definitions?.dataValidator.validate(schema, item.data).map((issue) => ({ path: `/inputs/${port}/${index}/data${issue.path}`, message: issue.message })) ?? []),
      );
      if (issues.length > 0) return refuse(`the request does not match shared node '${payload.name}' (requestSchema)`, { issues: issues.slice(0, 50) });
    }

    const replaces = shared.state.queue.filter((entry) => entry.ticketId === request.ticketId && entry.nodeId === request.nodeId && entry.lane === request.lane).map(holderOf);
    const events: NewEvent[] = [
      {
        type: 'sharedNode.requestQueued',
        data: { projectId: payload.projectId, name: payload.name, request, at: servicesOf(ctx).clock.now(), ...(replaces.length === 0 ? {} : { replaces: replaces.slice(0, 64) }) },
      },
    ];
    // The last blamed lane is back with a new execution: it was fixed, batches start again.
    const blocked = shared.state.blocked;
    if (blocked?.reason === 'blamed') {
      const left = blocked.by.filter((blamed) => !(blamed.ticketId === request.ticketId && blamed.nodeId === request.nodeId && blamed.lane === request.lane && request.run > blamed.run));
      if (left.length === 0) events.push({ type: 'sharedNode.unblocked', data: { projectId: payload.projectId, name: payload.name, reason: 'fixed' } });
    }
    return { ok: true, appends: [sharedStream(shared, events)], result: { queued: true } };
  },
};

// ---------------------------------------------------------------------------
// Starting a batch

interface Candidate {
  readonly entry: QueueEntry;
  readonly ticket: Loaded<TicketState>;
  readonly workflow: CompiledWorkflow;
  readonly node: CompiledNode;
  readonly exec: Execution;
}

type StartResult = { started: boolean; batch?: number; reason?: string; nextCheckAt?: number };

/** Which trigger starts a batch now with these requests (§4.2), or when the window will be met. */
function trigger(spec: SharedNodeSpec, eligible: readonly QueueEntry[], running: number, now: number, manual: boolean): { trigger?: BatchTrigger; nextCheckAt?: number } {
  if (manual) return { trigger: 'manual' };
  // Requests a failed or interrupted batch put back met a trigger already: they go again as soon as they can.
  if (eligible.some((entry) => entry.retry === true)) return { trigger: 'retry' };
  const { count, window, afterPrevious } = spec.batchTrigger;
  if (count !== undefined && eligible.length >= count) return { trigger: 'count' };
  if (afterPrevious === true && running === 0) return { trigger: 'afterPrevious' };
  if (window !== undefined) {
    const due = Math.min(...eligible.map((entry) => entry.at)) + parseDuration(window);
    if (now >= due) return { trigger: 'window' };
    return { nextCheckAt: due };
  }
  return {};
}

async function startBatch(ctx: HandlerContext, shared: Loaded<SharedNodeState>, manual: boolean) {
  const { state } = shared;
  const fields = { projectId: state.projectId, name: state.name };
  const definition = currentDefinition(state);
  if (!state.exists || definition === undefined) return fail('not_found', `shared node '${shared.aggregateId}' does not exist`);
  const notStarted = (reason: string, extra: Partial<StartResult> = {}, events: NewEvent[] = []) => ({
    ok: true as const,
    appends: events.length === 0 ? [] : [sharedStream(shared, events)],
    result: { started: false, reason, ...extra },
  });
  if (state.blocked !== undefined) {
    const reason =
      state.blocked.reason === 'interrupted'
        ? `blocked: batch ${state.blocked.batch} was interrupted by an engine restart; unblock it to go on`
        : `blocked until the blamed tickets come back fixed (${state.blocked.by.map((blamed) => blamed.ticketId).join(', ')}); unblock it to go on now`;
    return manual ? fail('invariant_violated', reason) : notStarted(reason);
  }
  const { spec } = definition;
  const running = runningBatches(state).length;
  if (running >= spec.maxConcurrent) return manual ? fail('invariant_violated', `${running} batch(es) running (maxConcurrent ${spec.maxConcurrent})`) : notStarted('a batch is running');

  // Requests whose execution ended or was replaced leave the queue; paused ones keep their place but wait.
  const dropped: Holder[] = [];
  const candidates: Candidate[] = [];
  for (const entry of state.queue) {
    const ticket = await ctx.load(ticketAggregate, entry.ticketId);
    const exec = ticket.state.exists ? requestExecution(ticket.state, entry) : undefined;
    const workflow = exec === undefined || ticket.state.status !== 'open' ? undefined : await openWorkflow(ctx, ticket);
    const node = workflow === undefined || isFailure(workflow) ? undefined : workflow.nodes.get(entry.nodeId);
    if (exec === undefined || workflow === undefined || isFailure(workflow) || node?.completion !== 'shared' || (exec.status !== 'queued' && exec.status !== 'paused')) {
      dropped.push(holderOf(entry));
      continue;
    }
    if (exec.status === 'queued') candidates.push({ entry, ticket, workflow, node, exec });
  }
  const dropEvents: NewEvent[] = dropped.length === 0 ? [] : [{ type: 'sharedNode.requestDropped', data: { ...fields, requests: dropped.slice(0, 4096) } }];
  if (candidates.length === 0) return manual ? fail('invariant_violated', `nothing is queued for shared node '${state.name}'`) : notStarted('nothing is queued', {}, dropEvents);

  const services = servicesOf(ctx);
  const chosen = trigger(spec, candidates.map((candidate) => candidate.entry), running, services.clock.now(), manual);
  if (chosen.trigger === undefined) {
    return notStarted('no trigger is met yet', chosen.nextCheckAt === undefined ? {} : { nextCheckAt: chosen.nextCheckAt }, dropEvents);
  }
  // The node type must still be exactly what was pinned (fail closed, like a ticket's pinned definitions).
  const node = await sharedNodeOf(ctx, spec, definition.nodeType);
  if (isFailure(node)) return node;

  const members = candidates.slice(0, 4096);
  const holders = members.map((member) => holderOf(member.entry));
  const batch = state.batches + 1;
  const batchId = batchIdOf(state.name, batch);
  const appends: StreamAppend[] = [];
  let entries: readonly string[] = [];
  let overlaps: readonly { path: string; entryId: string; entryPath: string; holder: Holder }[] = [];

  // Protect the sources while the batch runs (§4.3): shared claims, held by every member.
  const items = claimItems(spec.protect ?? []);
  if (isFailure(items)) return items;
  const project = await ctx.load(projectAggregate, state.projectId);
  const first = members[0];
  if (items.length > 0 && project.state.root !== undefined && first !== undefined) {
    const app = await ctx.load(appSettingsAggregate, APP_SETTINGS_AGGREGATE_ID);
    const location = { space: 'root', root: project.state.root, settings: effectiveSettings(mergeSettings(app.state.settings, project.state.settings)) };
    const decision = await decideClaims(ctx, {
      ticket: first.ticket,
      workflow: first.workflow,
      holder: holders[0] ?? holderOf(first.entry),
      location,
      items,
      source: 'start',
      // A person running it decides to go ahead (D-033).
      override: manual,
      batch: { holders },
    });
    const ledgerAppend: StreamAppend = { aggregateType: 'workspace', aggregateId: decision.ledger.aggregateId, expectedRevision: decision.ledger.revision, events: decision.ledgerEvents };
    if (decision.outcome === 'wait' || decision.outcome === 'ask') {
      // Recorded once per set of conflicts: the engine tries again whenever paths are released.
      const same = state.waiting !== undefined && sameJson(state.waiting.conflicts.map((conflict) => conflict.entryId).sort(), decision.conflicts.map((conflict) => conflict.entryId).sort());
      if (same) return notStarted('waiting for protected paths', {}, dropEvents);
      return {
        ok: true as const,
        appends: [sharedStream(shared, [...dropEvents, { type: 'sharedNode.waiting', data: { ...fields, conflicts: decision.conflicts.slice(0, 256), policy: decision.claim?.policy ?? location.settings.onConflict } }]), ledgerAppend],
        result: { started: false, reason: 'waiting for protected paths' },
      };
    }
    if (decision.outcome === 'fail') {
      // `onConflict: fail`: the batch cannot start, so its requests fail (they can be retried).
      const error = `protected paths are held (onConflict: fail): ${decision.conflicts.map((conflict) => `'${conflict.path}' by '${conflict.holder.nodeId}' of ticket ${conflict.holder.ticketId}`).join('; ')}`;
      const byTicket = new Map<string, { ticket: Loaded<TicketState>; draft: WorkflowDraft }>();
      for (const member of members) {
        const existing = byTicket.get(member.ticket.aggregateId) ?? { ticket: member.ticket, draft: new WorkflowDraft(member.ticket.aggregateId, member.ticket.state, member.workflow) };
        failRequest(existing.draft, member.node, existing.draft.exec(member.node.id, member.exec.run), error, { conflicts: decision.conflicts.slice(0, 50) });
        byTicket.set(member.ticket.aggregateId, existing);
      }
      return {
        ok: true as const,
        appends: [
          sharedStream(shared, [...dropEvents, { type: 'sharedNode.requestDropped', data: { ...fields, requests: holders } }]),
          ledgerAppend,
          ...[...byTicket.values()].map(({ ticket, draft }) => ticketStream(ticket, draft.events)),
        ],
        result: { started: false, reason: error },
      };
    }
    if (decision.ledgerEvents.length > 0) appends.push(ledgerAppend);
    entries = decision.entryIds ?? [];
    overlaps = decision.outcome === 'overlap' ? decision.conflicts : [];
  }

  const byTicket = new Map<string, { ticket: Loaded<TicketState>; draft: WorkflowDraft }>();
  for (const member of members) {
    const existing = byTicket.get(member.ticket.aggregateId) ?? { ticket: member.ticket, draft: new WorkflowDraft(member.ticket.aggregateId, member.ticket.state, member.workflow) };
    existing.draft.emit({
      type: 'node.started',
      data: { ...holderOf(member.entry), attempt: member.exec.attempts + 1, executor: 'shared', batch: { sharedNode: state.name, batch, batchId } },
    });
    byTicket.set(member.ticket.aggregateId, existing);
  }
  const started: NewEvent = {
    type: 'sharedNode.batchStarted',
    data: {
      ...fields,
      batch,
      batchId,
      members: holders,
      trigger: chosen.trigger,
      definition: state.version,
      entries: [...entries].slice(0, 4096),
      ...(overlaps.length === 0 ? {} : { overlaps: overlaps.slice(0, 256) }),
    },
  };
  return {
    ok: true as const,
    appends: [sharedStream(shared, [...dropEvents, started]), ...appends, ...[...byTicket.values()].map(({ ticket, draft }) => ticketStream(ticket, draft.events))],
    result: { started: true, batch, reason: chosen.trigger },
  };
}

export const sharedNodeStart: CommandHandler<'sharedNode.start', SharedNodeState> = {
  target: sharedTarget,
  scope: () => ({}),
  decide: (ctx, _payload, target) => startBatch(ctx, requireShared(target), false),
};

export const sharedNodeRun: CommandHandler<'sharedNode.run', SharedNodeState> = {
  target: sharedTarget,
  scope: () => ({}),
  decide: async (ctx, _payload, target) => {
    const decided = await startBatch(ctx, requireShared(target), true);
    if (!decided.ok) return decided;
    const { started, batch, reason } = decided.result;
    return { ...decided, result: { started, ...(batch === undefined ? {} : { batch }), reason } };
  },
};

export const sharedNodeUnblock: CommandHandler<'sharedNode.unblock', SharedNodeState> = {
  target: sharedTarget,
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    const shared = requireShared(target);
    if (!shared.state.exists) return Promise.resolve(fail('not_found', `shared node '${payload.name}' does not exist in project ${payload.projectId}`));
    if (shared.state.blocked === undefined) return Promise.resolve({ ok: true, appends: [], result: { unblocked: false } });
    return Promise.resolve({
      ok: true,
      appends: [sharedStream(shared, [{ type: 'sharedNode.unblocked', data: { projectId: payload.projectId, name: payload.name, reason: 'person' } }])],
      result: { unblocked: true },
    });
  },
};

// ---------------------------------------------------------------------------
// Finishing a batch

interface LiveMember {
  readonly request: Holder;
  readonly ticket: Loaded<TicketState>;
  readonly workflow: CompiledWorkflow;
  readonly node: CompiledNode;
  readonly exec: Execution;
}

const TAIL = 4096;
const tail = (text: string | undefined): string => (text === undefined ? '' : text.length > TAIL ? text.slice(-TAIL) : text);

/** How the batch ended, read like a script node's exit (exit ports, `output: json`). */
function batchOutcome(node: CompiledNode, result: Extract<CommandPayload<'sharedNode.finish'>['result'], { kind: 'script' }>) {
  const outcome = scriptOutput(node, result);
  if ('error' in outcome) return { succeeded: false, error: outcome.error, data: {} as Record<string, unknown>, summary: undefined };
  const [first] = outcome.drafts;
  const data = first?.data ?? {};
  const summary = first?.summary;
  if (outcome.port === 'error') return { succeeded: false, error: summary ?? `the batch exited with ${String(result.exitCode)}`, data, summary };
  return { succeeded: true, error: undefined, data, summary };
}

export const sharedNodeFinish: CommandHandler<'sharedNode.finish', SharedNodeState> = {
  target: sharedTarget,
  scope: () => ({}),
  decide: async (ctx, payload, target) => {
    const shared = requireShared(target);
    const { state } = shared;
    const running = Object.hasOwn(state.running, payload.batch) ? state.running[payload.batch] : undefined;
    // Already applied (a replay after a crash): nothing more to do.
    if (running === undefined) return { ok: true, appends: [], result: {} };
    const fields = { projectId: state.projectId, name: state.name };
    const definition = Object.hasOwn(state.definitions, running.definition) ? state.definitions[running.definition] : undefined;
    if (definition === undefined) return fail('invariant_violated', `batch ${payload.batch} runs definition ${running.definition}, which is unknown`);
    const { spec } = definition;
    const batchId = running.batchId;

    // Members still waiting for this batch. A member whose request was replaced meanwhile gets nothing.
    const members: LiveMember[] = [];
    for (const member of running.members) {
      const ticket = await ctx.load(ticketAggregate, member.ticketId);
      const exec = ticket.state.exists ? requestExecution(ticket.state, member) : undefined;
      if (exec?.status !== 'running' || exec.executor !== 'shared' || exec.batch?.sharedNode !== state.name || exec.batch.batch !== payload.batch) continue;
      const workflow = await openWorkflow(ctx, ticket);
      if (isFailure(workflow)) continue;
      const node = workflow.nodes.get(member.nodeId);
      if (node === undefined) continue;
      members.push({ request: holderOf(member), ticket, workflow, node, exec });
    }
    const drafts = new Map<string, WorkflowDraft>();
    const draftOf = (member: LiveMember): WorkflowDraft => {
      const existing = drafts.get(member.ticket.aggregateId);
      if (existing !== undefined) return existing;
      const draft = new WorkflowDraft(member.ticket.aggregateId, member.ticket.state, member.workflow);
      drafts.set(member.ticket.aggregateId, draft);
      return draft;
    };
    const ticketIds = [...new Set(running.members.map((member) => member.ticketId))];
    const share = { batchId, batch: ticketIds };

    // The batch's protected paths go with it.
    const ledger = await ctx.load(workspaceAggregate, workspaceAggregateId(state.projectId));
    const release = running.entries.filter((id) => Object.hasOwn(ledger.state.entries, id));
    const ledgerAppends: StreamAppend[] =
      release.length === 0
        ? []
        : [{ aggregateType: 'workspace', aggregateId: ledger.aggregateId, expectedRevision: ledger.revision, events: [{ type: 'checkout.released', data: { projectId: state.projectId, ids: release, reason: 'nodeDone' } }] }];

    const requeue = (list: readonly LiveMember[], reason: string): void => {
      for (const member of list) draftOf(member).emit({ type: 'node.requeued', data: { ...member.request, reason } });
    };
    const failMember = (member: LiveMember, error: string, details: Record<string, unknown>, log: ArtifactRef | undefined): void => {
      const draft = draftOf(member);
      const output = failureOutput(member.node, draft.exec(member.node.id, member.exec.run), error, { ...share, ...details });
      const withLog: NodeRunOutput = log === undefined ? output : { ...output, items: output.items.map((item) => ({ ...item, artifacts: { ...(item.artifacts ?? {}), log } })) };
      finishWithOutput(draft, member.node, draft.exec(member.node.id, member.exec.run), withLog);
    };
    const finished = (data: Omit<Extract<NewEvent, { type: 'sharedNode.batchFinished' }>['data'], 'projectId' | 'name' | 'batch'>): NewEvent => ({
      type: 'sharedNode.batchFinished',
      data: { ...fields, batch: payload.batch, ...data },
    });
    const decided = (sharedEvents: NewEvent[]) => ({
      ok: true as const,
      appends: [sharedStream(shared, sharedEvents), ...ledgerAppends, ...[...drafts.entries()].map(([ticketId, draft]) => {
        const ticket = members.find((member) => member.ticket.aggregateId === ticketId)?.ticket;
        if (ticket === undefined) throw new Error(`ticket ${ticketId} not loaded`);
        return ticketStream(ticket, draft.events);
      })],
      result: {},
    });

    const { result } = payload;
    if (result.kind === 'interrupted') {
      // Nobody knows how it ended (D-011: a script is never run again on its own). The requests go back to the front of
      // the queue and a person decides when the shared node goes on.
      requeue(members, `batch ${batchId} was interrupted (${result.reason}); waiting in the queue`);
      return decided([
        finished({ outcome: 'interrupted', succeeded: [], failed: [], requeued: members.map((member) => member.request), error: result.reason }),
        { type: 'sharedNode.blocked', data: { ...fields, reason: 'interrupted', batch: payload.batch, by: [] } },
      ]);
    }

    const node = await sharedNodeOf(ctx, spec, definition.nodeType);
    const outcome = isFailure(node) ? { succeeded: false, error: node.error.message, data: {} as Record<string, unknown>, summary: undefined } : batchOutcome(node, result);
    const log = result.log;
    if (outcome.succeeded) {
      const summary = outcome.summary ?? `Batch ${batchId} succeeded with ${ticketIds.length} ticket(s)`;
      const validator = ctx.definitions?.dataValidator;
      for (const member of members) {
        const draft = draftOf(member);
        const exec = draft.exec(member.node.id, member.exec.run);
        const built = validator === undefined ? undefined : buildOutput(draft, member.node, exec, 'done', [{ data: { ...outcome.data, ...share, errorsForThisTicket: [], exitCode: result.exitCode }, summary, ...(log === undefined ? {} : { artifacts: { log } }) }], validator);
        if (built?.ok === true) finishWithOutput(draft, member.node, exec, built.output, built.undeclared);
        else failMember(member, `the batch succeeded but its result does not fit node '${member.node.id}': ${built === undefined ? 'no definition store' : `${built.message}: ${built.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`}`, {}, log);
      }
      return decided([finished({ outcome: 'succeeded', succeeded: members.map((member) => member.request), failed: [], requeued: [], exitCode: result.exitCode, ...(log === undefined ? {} : { log }) })]);
    }

    // Failed: which files do the errors name?
    const project = await ctx.load(projectAggregate, state.projectId);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const scan = scanErrors(output, project.state.root, servicesOf(ctx).caseInsensitive);
    const reported = Array.isArray(outcome.data.errorFiles) ? outcome.data.errorFiles.filter((file): file is string => typeof file === 'string') : undefined;
    const errorFiles = reported === undefined ? scan.files.map((file) => file.path) : reportedFiles(reported, project.state.root, servicesOf(ctx).caseInsensitive);
    const error = `batch ${batchId} failed: ${outcome.error ?? 'unknown error'}`;
    const base = { exitCode: result.exitCode, stderr: tail(result.stderr) };
    const blame = spec.onBatchFailure === 'blame' ? blameMembers(ledger.state, 'root', errorFiles, members.map((member) => member.request), servicesOf(ctx).caseInsensitive) : undefined;
    const common = { exitCode: result.exitCode, errorFiles: errorFiles.slice(0, 1000), error: error.slice(0, 65536), ...(log === undefined ? {} : { log }) };

    if (blame !== undefined && blame.blamed.length > 0) {
      const blamedTickets = new Set(blame.blamed.map((member) => member.ticketId));
      const blamed = members.filter((member) => blamedTickets.has(member.request.ticketId));
      const others = members.filter((member) => !blamedTickets.has(member.request.ticketId));
      const linesOf = (ticketId: string): string[] => {
        const files = new Set(blame.filesByTicket.get(ticketId) ?? []);
        const fromScan = scan.files.filter((file) => files.has(file.path)).flatMap((file) => file.lines);
        return [...new Set(fromScan.length > 0 ? fromScan : [...files])].slice(0, 100);
      };
      for (const member of blamed) {
        failMember(member, `${error}; the errors are in files this ticket changed`, { ...base, errorsForThisTicket: linesOf(member.request.ticketId), errorFiles: blame.filesByTicket.get(member.request.ticketId) ?? [], blamedBy: blame.evidence ?? 'edit' }, log);
      }
      requeue(others, `batch ${batchId} failed because of ${[...blamedTickets].join(', ')}; waiting in the queue until they are fixed`);
      if (spec.raiseBlamedPriority === true) {
        // The others wait for the blamed tickets: let those go first where tickets compete (priorityWins).
        const top = Math.min(1000, Math.max(...members.map((member) => member.ticket.state.priority)) + 1);
        for (const member of blamed) {
          const draft = draftOf(member);
          if (draft.state.priority < top) draft.emit({ type: 'ticket.updated', data: { ticketId: member.ticket.aggregateId, priority: top } });
        }
      }
      return decided([
        finished({ outcome: 'failed', policy: 'blame', succeeded: [], failed: blamed.map((member) => member.request), requeued: others.map((member) => member.request), ...common }),
        { type: 'sharedNode.blocked', data: { ...fields, reason: 'blamed', batch: payload.batch, by: blamed.map((member) => member.request) } },
      ]);
    }

    // allFail, or `blame` that found nobody: every ticket gets the failure (with every error line).
    const lines = scan.lines.length > 0 ? scan.lines.slice(0, 100) : [tail(result.stderr) || tail(result.stdout)].filter((line) => line !== '');
    for (const member of members) failMember(member, error, { ...base, errorsForThisTicket: lines, ...(blame === undefined ? {} : { blamedBy: 'none' }) }, log);
    return decided([finished({ outcome: 'failed', policy: 'allFail', succeeded: [], failed: members.map((member) => member.request), requeued: [], ...common })]);
  },
};
