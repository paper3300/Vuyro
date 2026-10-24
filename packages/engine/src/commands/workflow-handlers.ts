import {
  type CommandError,
  commandError,
  type CommandPayload,
  type DefinitionEnvelope,
  type DefinitionKind,
  definitionAggregateId,
  type DraftItem,
  DraftItemSchema,
  nodeTypeKey,
  SchemaValidator,
  type TicketWorkspace,
} from '@vuyro/contracts';
import type { NewEvent, StreamAppend } from '../store/event-store.ts';
import { type CompiledNode, type CompiledNodeType, type CompiledWorkflow, compileNodeType, compileWorkflow, DefinitionError } from '../workflow/compile.ts';
import { DefinitionLoadError, definitionHash } from '../workflow/definitions.ts';
import {
  activateEntries,
  buildOutput,
  complete,
  executionLive,
  failureOutput,
  finishWithOutput,
  joinItems,
  rerun,
  rework,
  withLateArtifacts,
  WorkflowDraft,
} from '../workflow/machine.ts';
import { locate } from '../workspace/layout.ts';
import { mergingJoins, nodeSettings } from '../workspace/settings.ts';
import { ACTIVE_STATUSES, currentExecution, EMPTY_TICKET, type Execution, execution, laneOf, nodeProgress } from '../workflow/state.ts';
import { type DefinitionState, definitionAggregate, runAggregate, type TicketState, ticketAggregate } from './aggregates.ts';
import type { CommandTarget } from './authorize.ts';
import type { CommandHandler, Decision, HandlerContext, Loaded } from './handlers.ts';
import { issueRunToken } from './run-token.ts';
import { checkoutAcquire, checkoutRelease, claimItems, decideClaims, holderOf, preemptionAppends, servicesOf } from './workspace-handlers.ts';

/**
 * Handlers of the workflow commands (M2): definitions, node results, approvals, and the engine's
 * own start/finish commands. Decisions are pure folds over the ticket state plus the pinned template;
 * see workflow/machine.ts for the routing rules.
 */

type Failure = { readonly ok: false; readonly error: CommandError };
const fail = (code: CommandError['code'], message: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  error: commandError(code, message, details),
});

/** How often the engine starts an interrupted agent again on its own (engine restart, cancel without a pause). */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

function ticketStream(ticket: Loaded<TicketState>, events: readonly NewEvent[]): StreamAppend {
  return { aggregateType: 'ticket', aggregateId: ticket.aggregateId, expectedRevision: ticket.revision, events };
}

function requireTicket(target: Loaded<TicketState> | undefined): Loaded<TicketState> {
  if (target === undefined) throw new Error('handler declared a target but none was loaded');
  return target;
}

const ticketTarget = (payload: { ticketId: string }) => ({ definition: ticketAggregate, aggregateId: payload.ticketId });
const nodeScope = (payload: { ticketId: string; nodeId: string }): CommandTarget => ({ ticketId: payload.ticketId, nodeId: payload.nodeId });

export async function openWorkflow(ctx: HandlerContext, ticket: Loaded<TicketState>, needOpen = true): Promise<CompiledWorkflow | Failure> {
  if (!ticket.state.exists) return fail('not_found', `ticket ${ticket.aggregateId} does not exist`);
  const pin = ticket.state.template;
  if (pin === undefined) return fail('invariant_violated', `ticket ${ticket.aggregateId} does not run a workflow`);
  if (needOpen && ticket.state.status !== 'open') return fail('invariant_violated', `ticket ${ticket.aggregateId} is already ${ticket.state.status}`);
  if (ticket.state.attention !== undefined) {
    // Fail closed: a ticket with events in a retired format is not carried on (§6, pre-release format change).
    return fail('invariant_violated', `ticket ${ticket.aggregateId} needs attention: its log has events in an older format (${ticket.state.attention.event})`);
  }
  if (ctx.definitions === undefined) return fail('invariant_violated', 'this engine has no definition store');
  try {
    return await ctx.definitions.workflow(pin);
  } catch (error) {
    if (error instanceof DefinitionLoadError || error instanceof DefinitionError) {
      return fail('invariant_violated', `the ticket's pinned definitions cannot be used: ${error.message}`);
    }
    throw error;
  }
}

export function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

function nodeOf(workflow: CompiledWorkflow, nodeId: string): CompiledNode | Failure {
  return workflow.nodes.get(nodeId) ?? fail('not_found', `node '${nodeId}' is not in template ${workflow.template.id}@${workflow.template.version}`);
}

/** The lane a person means: the one named, or the only lane in a matching state. */
function pickLane(ticket: TicketState, nodeId: string, lane: string | undefined, matches: (exec: Execution) => boolean, what: string): Execution | Failure {
  if (lane !== undefined) {
    if (laneOf(ticket, nodeId, lane) === undefined) return fail('not_found', `node '${nodeId}' has no lane '${lane}'`);
    const exec = currentExecution(ticket, nodeId, lane);
    if (exec === undefined || !matches(exec)) return fail('invariant_violated', `lane '${lane}' of node '${nodeId}' is not ${what} (it is ${exec?.status ?? 'wait'})`);
    return exec;
  }
  const candidates = nodeProgress(ticket, nodeId)
    .laneOrder.map((name) => currentExecution(ticket, nodeId, name))
    .filter((exec): exec is Execution => exec !== undefined && matches(exec));
  const [only] = candidates;
  if (only === undefined) return fail('invariant_violated', `node '${nodeId}' has no lane that is ${what}`);
  if (candidates.length > 1) return fail('invariant_violated', `several lanes of node '${nodeId}' are ${what}; name one with 'lane'`);
  return only;
}

function draftsFrom(payload: { data?: Record<string, unknown>; summary?: string; artifacts?: DraftItem['artifacts']; items?: DraftItem[] }): DraftItem[] | Failure {
  if (payload.items !== undefined) {
    if (payload.data !== undefined || payload.summary !== undefined || payload.artifacts !== undefined) {
      return fail('validation_failed', "send either 'items' or 'data'/'summary'/'artifacts', not both", { issues: [{ path: '/items', message: 'conflicts with data/summary/artifacts' }] });
    }
    return payload.items;
  }
  return [
    {
      ...(payload.data === undefined ? {} : { data: payload.data }),
      ...(payload.summary === undefined ? {} : { summary: payload.summary }),
      ...(payload.artifacts === undefined ? {} : { artifacts: payload.artifacts }),
    },
  ];
}

function outputOrFail(draft: WorkflowDraft, node: CompiledNode, exec: Execution, port: string, drafts: readonly DraftItem[], ctx: HandlerContext) {
  const validator = ctx.definitions?.dataValidator;
  if (validator === undefined) return fail('invariant_violated', 'this engine has no definition store');
  const result = buildOutput(draft, node, exec, port, drafts, validator);
  if (!result.ok) return fail('validation_failed', result.message, { issues: result.issues });
  return result;
}

/** Success with the draft's ticket events. Every workflow command returns an empty result. */
function decided(ticket: Loaded<TicketState>, draft: WorkflowDraft): Decision<never> {
  return { ok: true, appends: [ticketStream(ticket, draft.events)], result: {} as never };
}

/** Checks untrusted item drafts (a script's stdout) against the draft schema. */
const draftValidator = new SchemaValidator();

// ---------------------------------------------------------------------------
// Definitions

/**
 * Checks a definition before it is staged. Templates are compiled against the active node types, or against
 * `staged` (node types staged by the same import) first.
 */
async function compileDefinition(
  ctx: HandlerContext,
  definition: DefinitionEnvelope,
  staged: ReadonlyMap<string, CompiledNodeType> = new Map(),
): Promise<Failure | { ok: true; nodeType?: CompiledNodeType }> {
  const resolver = ctx.definitions;
  if (resolver === undefined) return fail('invariant_violated', 'this engine has no definition store');
  const issue = (message: string, issues: { path: string; message: string }[]) =>
    fail('validation_failed', message, { issues: issues.map((entry) => ({ path: `/definition/content${entry.path}`, message: entry.message })) });
  if (definition.kind === 'nodeType') {
    const { content } = definition;
    if (content.type !== definition.id || content.version !== definition.version) {
      return fail('validation_failed', 'content type and version must match the envelope id and version', { issues: [{ path: '/definition/content', message: 'mismatch' }] });
    }
    const { nodeType, issues } = compileNodeType(content, resolver.dataValidator);
    if (issues.length > 0 || nodeType === undefined) return issue(`node type ${content.type}@${content.version} is not valid`, issues);
    return { ok: true, nodeType };
  }
  const { content } = definition;
  if (content.id !== definition.id || content.version !== definition.version) {
    return fail('validation_failed', 'content id and version must match the envelope id and version', { issues: [{ path: '/definition/content', message: 'mismatch' }] });
  }
  const types = new Map<string, CompiledNodeType>();
  for (const node of content.nodes) {
    const key = nodeTypeKey(node.type, node.version);
    if (types.has(key)) continue;
    const own = staged.get(key);
    if (own !== undefined) {
      types.set(key, own);
      continue;
    }
    try {
      const type = await resolver.nodeType(node.type, node.version);
      if (type !== undefined) types.set(key, type);
    } catch (error) {
      if (error instanceof DefinitionLoadError || error instanceof DefinitionError) return fail('invariant_violated', error.message);
      throw error;
    }
  }
  const { issues } = compileWorkflow(content, types, resolver.dataValidator);
  return issues.length > 0 ? issue(`template ${content.id}@${content.version} is not valid`, issues) : { ok: true };
}

function stageHandler<T extends 'nodeType.save' | 'template.save'>(kind: DefinitionKind): CommandHandler<T, DefinitionState> {
  return {
    target: (payload) => ({ definition: definitionAggregate, aggregateId: definitionAggregateId(kind, payload.definition.id) }),
    scope: () => ({}),
    decide: async (ctx, payload, target) => {
      if (target === undefined) throw new Error('definition target not loaded');
      const definition: DefinitionEnvelope = payload.definition;
      const hash = definitionHash(definition);
      if (definition.checksum !== undefined && definition.checksum !== hash) {
        return fail('validation_failed', `checksum ${definition.checksum} does not match the content (${hash})`, { issues: [{ path: '/definition/checksum', message: 'mismatch' }] });
      }
      const key = { kind, id: definition.id, version: definition.version, hash };
      const existing = Object.hasOwn(target.state.versions, definition.version) ? target.state.versions[definition.version] : undefined;
      if (existing !== undefined && existing.status !== 'abandoned') {
        if (existing.hash !== hash) {
          return fail('invariant_violated', `${kind} ${definition.id}@${definition.version} already exists with other content; save it as a new version`, {
            existingHash: existing.hash,
          });
        }
        return { ok: true, appends: [], result: { ...key, status: existing.status === 'active' ? 'active' : 'staged' } };
      }
      const compiled = await compileDefinition(ctx, definition);
      if (!compiled.ok) return compiled;
      return {
        ok: true,
        appends: [
          {
            aggregateType: 'definition',
            aggregateId: target.aggregateId,
            expectedRevision: target.revision,
            events: [{ type: 'definition.staged', data: { ...key, name: definition.name, definition } }],
          },
        ],
        result: { ...key, status: 'staged' },
      };
    },
  };
}

/**
 * `definition.import`: every definition of one import staged in one commit, or none (M6b review). Node types come
 * first so the templates are checked against them. A version that exists with other content, or an id or version the
 * preview promised that is no longer free (`expect`), refuses the whole import: the person previews again.
 */
export const definitionImport: CommandHandler<'definition.import', DefinitionState> = {
  scope: () => ({}),
  decide: async (ctx, payload) => {
    const indexed = payload.items.map((item, index) => ({ item, index }));
    const ordered = [...indexed.filter(({ item }) => item.definition.kind === 'nodeType'), ...indexed.filter(({ item }) => item.definition.kind === 'template')];
    const streams = new Map<string, { loaded: Loaded<DefinitionState>; events: NewEvent[] }>();
    const staged = new Map<string, CompiledNodeType>();
    const seen = new Set<string>();
    const saved: { kind: DefinitionKind; id: string; version: number; hash: string; status: 'staged' | 'active' }[] = [];
    for (const { item, index } of ordered) {
      const definition: DefinitionEnvelope = item.definition;
      const { kind } = definition;
      const label = `${kind} ${definition.id}@${String(definition.version)}`;
      const at = (message: string) => [{ path: `/items/${String(index)}`, message }];
      if (seen.has(label)) return fail('validation_failed', `${label} is in the import twice`, { issues: at('duplicate') });
      seen.add(label);
      const hash = definitionHash(definition);
      if (definition.checksum !== undefined && definition.checksum !== hash) {
        return fail('validation_failed', `checksum of ${label} does not match the content`, { issues: at('checksum mismatch') });
      }
      const aggregateId = definitionAggregateId(kind, definition.id);
      const entry = streams.get(aggregateId) ?? { loaded: await ctx.load(definitionAggregate, aggregateId), events: [] };
      streams.set(aggregateId, entry);
      const live = Object.entries(entry.loaded.state.versions)
        .filter(([, version]) => version.status !== 'abandoned')
        .map(([version, state]) => ({ version: Number(version), ...state }));
      if (item.expect === 'newId' && live.length > 0) {
        return fail('invariant_violated', `${kind} ${definition.id} exists now; preview the import again`, { issues: at('id taken') });
      }
      if (item.expect === 'newVersion' && live.some((version) => version.version >= definition.version)) {
        return fail('invariant_violated', `${label} is no longer the newest version; preview the import again`, { issues: at('not newest') });
      }
      const existing = live.find((version) => version.version === definition.version);
      if (existing !== undefined && existing.hash !== hash) {
        return fail('invariant_violated', `${label} already exists with other content; preview the import again`, { issues: at('other content'), existingHash: existing.hash });
      }
      const compiled = await compileDefinition(ctx, definition, staged);
      if (!compiled.ok) {
        const issues = (compiled.error.details as { issues?: { path: string; message: string }[] } | undefined)?.issues ?? [];
        return fail(compiled.error.code, `${label}: ${compiled.error.message}`, { issues: issues.map((entry) => ({ path: `/items/${String(index)}${entry.path}`, message: entry.message })) });
      }
      if (compiled.nodeType !== undefined) staged.set(nodeTypeKey(definition.id, definition.version), compiled.nodeType);
      if (existing !== undefined) {
        saved.push({ kind, id: definition.id, version: definition.version, hash, status: existing.status === 'active' ? 'active' : 'staged' });
        continue;
      }
      entry.events.push({ type: 'definition.staged', data: { kind, id: definition.id, version: definition.version, hash, name: definition.name, definition } });
      saved.push({ kind, id: definition.id, version: definition.version, hash, status: 'staged' });
    }
    const appends: StreamAppend[] = [...streams.entries()]
      .filter(([, entry]) => entry.events.length > 0)
      .map(([aggregateId, entry]) => ({ aggregateType: 'definition', aggregateId, expectedRevision: entry.loaded.revision, events: entry.events }));
    return { ok: true, appends, result: { saved } };
  },
};

function definitionTarget(payload: { kind: DefinitionKind; id: string }) {
  return { definition: definitionAggregate, aggregateId: definitionAggregateId(payload.kind, payload.id) };
}

type DefinitionKey = { kind: DefinitionKind; id: string; version: number; hash: string };

/**
 * Whether a staged version may become active: staged with this hash, its file in place with that hash (re-read,
 * whoever asks), and for a template every node type it uses active or activated in the same commit (`together`).
 */
async function activationCheck(ctx: HandlerContext, payload: DefinitionKey, state: DefinitionState, together: ReadonlySet<string>): Promise<Failure | 'active' | 'ready'> {
  const version = Object.hasOwn(state.versions, payload.version) ? state.versions[payload.version] : undefined;
  if (version === undefined || version.hash !== payload.hash) return fail('not_found', `${payload.kind} ${payload.id}@${payload.version} with this hash was never staged`);
  if (version.status === 'active') return 'active';
  if (version.status === 'abandoned') return fail('invariant_violated', `${payload.kind} ${payload.id}@${payload.version} was abandoned`);
  const fileHash = await ctx.definitions?.fileHash(payload.kind, payload.id, payload.version);
  if (fileHash !== payload.hash) {
    return fail('invariant_violated', `the file of ${payload.kind} ${payload.id}@${payload.version} does not match the staged hash`, { fileHash: fileHash ?? null });
  }
  // A template becomes usable only with its node types: one that could not be written keeps the template unusable.
  if (payload.kind === 'template' && ctx.definitions !== undefined) {
    const file = await ctx.definitions.readFile('template', payload.id, payload.version);
    if (file.kind === 'template') {
      for (const node of file.content.nodes) {
        const key = nodeTypeKey(node.type, node.version);
        if (together.has(key)) continue;
        const type = await ctx.definitions.nodeType(node.type, node.version).catch(() => undefined);
        if (type === undefined) return fail('invariant_violated', `template ${payload.id}@${payload.version} needs node type ${key}, which is not active`);
      }
    }
  }
  return 'ready';
}

const activated = (payload: DefinitionKey): NewEvent => ({ type: 'definition.activated', data: { kind: payload.kind, id: payload.id, version: payload.version, hash: payload.hash } });

export const definitionActivate: CommandHandler<'definition.activate', DefinitionState> = {
  target: definitionTarget,
  scope: () => ({}),
  decide: async (ctx, payload, target) => {
    if (target === undefined) throw new Error('definition target not loaded');
    const check = await activationCheck(ctx, payload, target.state, new Set());
    if (check === 'active') return { ok: true, appends: [], result: {} };
    if (check !== 'ready') return check;
    return { ok: true, appends: [{ aggregateType: 'definition', aggregateId: target.aggregateId, expectedRevision: target.revision, events: [activated(payload)] }], result: {} };
  },
};

/** `definition.activateMany`: every version of one save or import, in one commit, or none. */
export const definitionActivateMany: CommandHandler<'definition.activateMany', DefinitionState> = {
  scope: () => ({}),
  decide: async (ctx, payload) => {
    const together = new Set(payload.items.filter((item) => item.kind === 'nodeType').map((item) => nodeTypeKey(item.id, item.version)));
    const streams = new Map<string, { loaded: Loaded<DefinitionState>; events: NewEvent[] }>();
    for (const item of payload.items) {
      const aggregateId = definitionAggregateId(item.kind, item.id);
      const entry = streams.get(aggregateId) ?? { loaded: await ctx.load(definitionAggregate, aggregateId), events: [] };
      streams.set(aggregateId, entry);
      const check = await activationCheck(ctx, item, entry.loaded.state, together);
      if (check === 'active') continue;
      if (check !== 'ready') return check;
      entry.events.push(activated(item));
    }
    const appends: StreamAppend[] = [...streams.entries()]
      .filter(([, entry]) => entry.events.length > 0)
      .map(([aggregateId, entry]) => ({ aggregateType: 'definition', aggregateId, expectedRevision: entry.loaded.revision, events: entry.events }));
    return { ok: true, appends, result: {} };
  },
};

export const definitionAbandon: CommandHandler<'definition.abandon', DefinitionState> = {
  target: definitionTarget,
  scope: () => ({}),
  decide: (_ctx, payload, target) => {
    if (target === undefined) throw new Error('definition target not loaded');
    const version = Object.hasOwn(target.state.versions, payload.version) ? target.state.versions[payload.version] : undefined;
    if (version === undefined || version.hash !== payload.hash) return Promise.resolve(fail('not_found', `${payload.kind} ${payload.id}@${payload.version} with this hash was never staged`));
    if (version.status !== 'staged') return Promise.resolve({ ok: true, appends: [], result: {} });
    return Promise.resolve({
      ok: true,
      appends: [
        {
          aggregateType: 'definition',
          aggregateId: target.aggregateId,
          expectedRevision: target.revision,
          events: [{ type: 'definition.abandoned', data: { ...payload } }],
        },
      ],
      result: {},
    });
  },
};

export const nodeTypeSave = stageHandler<'nodeType.save'>('nodeType');
export const templateSave = stageHandler<'template.save'>('template');

// ---------------------------------------------------------------------------
// Tickets

/** `ticket.create` with a template: pins it and activates the entry nodes in the same commit. */
export async function createTicketEvents(
  ctx: HandlerContext,
  ticketId: string,
  payload: CommandPayload<'ticket.create'>,
  workspace?: TicketWorkspace,
): Promise<NewEvent[] | Failure> {
  const base = {
    ticketId,
    projectId: payload.projectId,
    title: payload.title,
    ...(payload.description === undefined ? {} : { description: payload.description }),
    ...(payload.priority === undefined ? {} : { priority: payload.priority }),
    ...(workspace === undefined ? {} : { workspace }),
  };
  if (payload.template === undefined) return [{ type: 'ticket.created', data: base }];
  if (ctx.definitions === undefined) return fail('invariant_violated', 'this engine has no definition store');
  let loaded;
  try {
    loaded = await ctx.definitions.template(payload.template.id, payload.template.version);
  } catch (error) {
    if (error instanceof DefinitionLoadError || error instanceof DefinitionError) return fail('invariant_violated', error.message);
    throw error;
  }
  if (loaded === undefined) {
    const version = payload.template.version === undefined ? '' : `@${payload.template.version}`;
    return fail('not_found', `template ${payload.template.id}${version} is not active`);
  }
  const draft = new WorkflowDraft(ticketId, EMPTY_TICKET, loaded.workflow);
  draft.emit({ type: 'ticket.created', data: { ...base, template: loaded.pin } });
  activateEntries(draft);
  return draft.events;
}

// ---------------------------------------------------------------------------
// Node commands

/**
 * Scope of a command that may name a lane. A node agent's run decides its lane, so naming another lane
 * of the same node (or a lane its run no longer drives) is out of its scope: the named lane's current run
 * becomes the scope's run, which authorization compares with the token's run.
 */
export function laneScope(payload: { ticketId: string; nodeId: string; lane?: string }, target: Loaded<TicketState> | undefined): CommandTarget {
  const scope: CommandTarget = nodeScope(payload);
  if (payload.lane === undefined || target === undefined) return scope;
  const runId = currentExecution(target.state, payload.nodeId, payload.lane)?.runIds.at(-1);
  return { ...scope, runId: runId ?? 'none' };
}

export const checkoutAcquireHandler = checkoutAcquire(openWorkflow);
export const checkoutReleaseHandler = checkoutRelease(openWorkflow);

export const nodeDone: CommandHandler<'node.done', TicketState> = {
  target: ticketTarget,
  scope: laneScope,
  scopeNeedsTarget: (payload) => payload.lane !== undefined,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const drafts = draftsFrom(payload);
    if (isFailure(drafts)) return drafts;
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    const runId = ctx.caller.binding?.runId;

    if (runId !== undefined) {
      // A node agent: its run token names the execution.
      const owner = Object.hasOwn(ticket.state.runIndex, runId) ? ticket.state.runIndex[runId] : undefined;
      const exec = owner === undefined ? undefined : execution(ticket.state, owner.nodeId, owner.run);
      if (exec === undefined || owner?.nodeId !== payload.nodeId) return fail('invariant_violated', `run ${runId} is not an execution of node '${payload.nodeId}'`);
      if (currentExecution(ticket.state, exec.nodeId, exec.lane)?.run !== exec.run || exec.status !== 'running' || exec.runIds.at(-1) !== runId) {
        return fail('invariant_violated', `run ${runId} no longer drives lane '${exec.lane}' of node '${exec.nodeId}' (it is ${exec.status})`);
      }
      const result = outputOrFail(draft, node, exec, payload.port, drafts, ctx);
      if (isFailure(result)) return result;
      draft.emit({
        type: 'node.outputSubmitted',
        data: { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run, runId, output: result.output },
      });
      return decided(ticket, draft);
    }

    if (node.completion !== 'human') {
      return fail('invariant_violated', `node '${node.id}' is finished by its ${node.completion} executor, not by 'node.done'`);
    }
    const exec = pickLane(ticket.state, node.id, payload.lane, (candidate) => candidate.status === 'review' || candidate.status === 'rejected', 'waiting for a person');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const result = outputOrFail(draft, node, exec, payload.port, drafts, ctx);
    if (isFailure(result)) return result;
    finishWithOutput(draft, node, exec, result.output, result.undeclared);
    return decided(ticket, draft);
  },
};

function reviewable(exec: Execution): boolean {
  return exec.status === 'review';
}

/**
 * A person's command names the execution they saw (`run`): refuse it when the lane has moved on to another one, so an
 * old screen never approves, rejects or finishes work it did not show.
 */
function seenExecution(ticketId: string, exec: Execution, run: number | undefined): Failure | undefined {
  if (run === undefined || run === exec.run) return undefined;
  return fail('revision_conflict', `lane '${exec.lane}' of node '${exec.nodeId}' is on execution ${exec.run} now, not ${run}; look again`, {
    aggregateId: ticketId,
    nodeId: exec.nodeId,
    lane: exec.lane,
    expectedRun: run,
    actualRun: exec.run,
  });
}

export const nodeApprove: CommandHandler<'node.approve', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = pickLane(ticket.state, node.id, payload.lane, reviewable, 'in review');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    if (exec.merge !== undefined) {
      // A merge that stopped on conflicts: the person resolved them (or let the agent's resolution stand); the merge step goes on.
      rerun(draft, exec, 'retry');
      return decided(ticket, draft);
    }
    if (node.completion !== 'human') {
      // Review gate: release the held output.
      if (exec.output === undefined) return fail('invariant_violated', `lane '${exec.lane}' of node '${node.id}' holds no output`);
      // A held error output (an empty one, D-016) stays a failure; approving only lets it travel.
      complete(draft, node.id, exec.run, exec.output, exec.output.port === 'error' ? 'failed' : 'done');
      return decided(ticket, draft);
    }
    if (!node.outputs.has('approve')) return fail('invariant_violated', `node '${node.id}' has no 'approve' port; finish it with 'node.done'`);
    const result = outputOrFail(draft, node, exec, 'approve', [payload.comment === undefined ? {} : { data: { comment: payload.comment } }], ctx);
    if (isFailure(result)) return result;
    complete(draft, node.id, exec.run, result.output, 'done', { undeclared: result.undeclared });
    return decided(ticket, draft);
  },
};

export const nodeReject: CommandHandler<'node.reject', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = pickLane(ticket.state, node.id, payload.lane, reviewable, 'in review');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    if (exec.merge !== undefined) {
      // A merge that stopped on conflicts: an agent resolves them, with the person's comment as instructions.
      if (payload.items !== undefined) return fail('validation_failed', 'items apply to approval nodes only', { issues: [{ path: '/items', message: 'not allowed here' }] });
      rerun(draft, exec, 'review', { run: exec.run, ...(payload.comment === undefined ? {} : { comment: payload.comment }) });
      return decided(ticket, draft);
    }
    if (node.completion !== 'human') {
      // Review gate: discard the held output and run the lane again with the reviewer's comment.
      if (payload.items !== undefined) return fail('validation_failed', 'items apply to approval nodes only', { issues: [{ path: '/items', message: 'not allowed here' }] });
      draft.emit({
        type: 'node.returned',
        data: { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run, ...(payload.comment === undefined ? {} : { comment: payload.comment }) },
      });
      rerun(draft, exec, 'review', { run: exec.run, ...(payload.comment === undefined ? {} : { comment: payload.comment }) });
      return decided(ticket, draft);
    }
    if (!node.outputs.has('reject')) return fail('invariant_violated', `node '${node.id}' has no 'reject' port`);
    const comment = payload.comment === undefined ? {} : { comment: payload.comment };
    const drafts = (payload.items ?? [{}]).map((item) => ({ ...item, data: { ...comment, ...(item.data ?? {}) } }));
    const result = outputOrFail(draft, node, exec, 'reject', drafts, ctx);
    if (isFailure(result)) return result;
    complete(draft, node.id, exec.run, result.output, 'done', { undeclared: result.undeclared });
    return decided(ticket, draft);
  },
};

export const nodeRetry: CommandHandler<'node.retry', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    // A failure of a replaced generation stays as it is: a newer plan replaced its work (D-019).
    const named = payload.lane === undefined ? undefined : currentExecution(ticket.state, node.id, payload.lane);
    if (named !== undefined && !executionLive(ticket.state, named)) {
      return fail('invariant_violated', `lane '${named.lane}' of node '${node.id}' belongs to a replaced generation; it cannot be retried`);
    }
    // A success whose items all answered replaced work went nowhere (D-021): it is retried like a failure.
    const retriable = (candidate: Execution): boolean =>
      (candidate.status === 'failed' || (candidate.status === 'done' && candidate.onlyStale === true)) && executionLive(ticket.state, candidate);
    const exec = pickLane(ticket.state, node.id, payload.lane, retriable, 'failed or stale');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    rerun(draft, exec, 'retry');
    return decided(ticket, draft);
  },
};

export const nodePause: CommandHandler<'node.pause', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = pickLane(ticket.state, node.id, payload.lane, (candidate) => ACTIVE_STATUSES.has(candidate.status) && candidate.status !== 'paused' && !candidate.pauseRequested, 'pausable');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const fields = { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run };
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    if (exec.status === 'running') {
      if (exec.executor !== 'agent') return fail('invariant_violated', `a running ${exec.executor ?? 'executor'} cannot be paused; wait for it or let it fail`);
      draft.emit({ type: 'node.pauseRequested', data: fields });
    } else {
      draft.emit({ type: 'node.paused', data: { ...fields, resumeTo: exec.status as 'queued' | 'review' | 'rejected' } });
    }
    return decided(ticket, draft);
  },
};

export const nodeResume: CommandHandler<'node.resume', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = pickLane(ticket.state, node.id, payload.lane, (candidate) => candidate.status === 'paused' || candidate.pauseRequested, 'paused');
    if (isFailure(exec)) return exec;
    const stale = seenExecution(ticket.aggregateId, exec, payload.run);
    if (stale !== undefined) return stale;
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    const status = exec.status === 'paused' ? (exec.resumeTo ?? 'queued') : 'running';
    // A lane waiting for a claim: the engine resumes it when the paths are free (its start checks them again);
    // a person resuming it lets it go ahead despite the overlap (§3.7: a person can always decide).
    const override = exec.status === 'paused' && exec.claimWait !== undefined && ctx.caller.principal.kind !== 'system';
    draft.emit({
      type: 'node.resumed',
      data: { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run, status, ...(override ? { override: true as const } : {}) },
    });
    return decided(ticket, draft);
  },
};

// ---------------------------------------------------------------------------
// Engine commands

/** The execution a system command names, if it is still the lane's current one. */
function namedExecution(ticket: TicketState, payload: { nodeId: string; lane: string; run: number }): Execution | Failure {
  const exec = execution(ticket, payload.nodeId, payload.run);
  if (exec?.lane !== payload.lane) return fail('not_found', `node '${payload.nodeId}' has no run ${payload.run} on lane '${payload.lane}'`);
  return exec;
}

export const nodeStart: CommandHandler<'node.start', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = namedExecution(ticket.state, payload);
    if (isFailure(exec)) return exec;
    if (currentExecution(ticket.state, node.id, exec.lane)?.run !== exec.run) return fail('invariant_violated', `run ${exec.run} was superseded`);
    if (exec.status !== 'queued' && exec.status !== 'rejected') return fail('invariant_violated', `run ${exec.run} of node '${node.id}' is ${exec.status}, not ready to start`);
    if (payload.attempt !== exec.attempts + 1) return fail('invariant_violated', `attempt ${payload.attempt} does not follow attempt ${exec.attempts}`);
    const merging = node.completion === 'join' && mergingJoins(ticket.state, workflow).has(node.id);
    if (node.completion !== 'agent' && node.completion !== 'script' && !merging) return fail('invariant_violated', `node '${node.id}' has no executor (${node.completion})`);
    const fields = { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt: payload.attempt };
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    // Claims the node type declares are taken together before it starts (§3.7). A conflict decides by policy.
    const claims = claimItems(node.type.spec.claims ?? []);
    if (isFailure(claims)) return claims;
    const extra: StreamAppend[] = [];
    if (claims.length > 0) {
      const location = locate(servicesOf(ctx).layout, ticket.state, ticket.aggregateId, workflow, node.id, exec.lane, exec.run);
      const decision = await decideClaims(ctx, { ticket, workflow, holder: holderOf(ticket.aggregateId, exec), location, items: claims, source: 'start', override: exec.override === true });
      const ledgerAppend: StreamAppend = { aggregateType: 'workspace', aggregateId: decision.ledger.aggregateId, expectedRevision: decision.ledger.revision, events: decision.ledgerEvents };
      if (decision.outcome === 'wait' || decision.outcome === 'ask' || decision.outcome === 'fail') {
        if (decision.outcome === 'fail' || decision.claim === undefined) {
          const error = `claims conflict (onConflict: fail): ${decision.conflicts.map((conflict) => `'${conflict.path}' is held by '${conflict.holder.nodeId}' of ticket ${conflict.holder.ticketId}`).join('; ')}`;
          complete(draft, node.id, exec.run, failureOutput(node, exec, error, { conflicts: decision.conflicts.slice(0, 50) }), 'failed', { error });
        } else {
          draft.emit({ type: 'node.paused', data: { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run, resumeTo: exec.status === 'rejected' ? 'rejected' : 'queued', claim: decision.claim } });
        }
        return {
          ok: true,
          appends: [ticketStream(ticket, draft.events), ledgerAppend],
          result: { blocked: decision.outcome },
        };
      }
      if (decision.ledgerEvents.length > 0) extra.push(ledgerAppend);
      extra.push(...(await preemptionAppends(ctx, decision, ticket.aggregateId)));
    }
    if (merging) {
      // A join's merge step takes its node type's claims like any executor (a custom join may declare some).
      draft.emit({ type: 'node.started', data: { ...fields, executor: 'merge' } });
      return { ok: true, appends: [ticketStream(ticket, draft.events), ...extra], result: {} };
    }
    if (node.completion === 'script') {
      draft.emit({ type: 'node.started', data: { ...fields, executor: 'script' } });
      return { ok: true, appends: [ticketStream(ticket, draft.events), ...extra], result: {} };
    }
    const provider = typeof node.params.provider === 'string' && (node.params.provider === 'claude' || node.params.provider === 'codex') ? node.params.provider : 'claude';
    let resumedFromRunId: string | undefined;
    if (exec.resumeFromRunId !== undefined) {
      const previous = await ctx.load(runAggregate, exec.resumeFromRunId);
      const usable = previous.state.exists && previous.state.provider === provider && previous.state.status !== 'running' && previous.state.sessionId !== undefined;
      if (usable) resumedFromRunId = exec.resumeFromRunId;
    }
    const runId = ctx.ids.next();
    const { token, hash } = issueRunToken(ctx.random);
    draft.emit({ type: 'node.started', data: { ...fields, executor: 'agent', runId } });
    const runStarted: NewEvent = {
      type: 'run.started',
      data: {
        runId,
        ticketId: ticket.aggregateId,
        nodeId: node.id,
        provider,
        tokenHash: hash,
        ...(resumedFromRunId === undefined ? {} : { resumedFromRunId }),
      },
    };
    return {
      ok: true,
      appends: [ticketStream(ticket, draft.events), { aggregateType: 'run', aggregateId: runId, expectedRevision: 0, events: [runStarted] }, ...extra],
      result: { runId, runToken: token },
      storedResult: { runId },
    };
  },
};

export const nodeFinish: CommandHandler<'node.finish', TicketState> = {
  target: ticketTarget,
  scope: nodeScope,
  decide: async (ctx, payload, target) => {
    const ticket = requireTicket(target);
    const workflow = await openWorkflow(ctx, ticket, false);
    if (isFailure(workflow)) return workflow;
    const node = nodeOf(workflow, payload.nodeId);
    if (isFailure(node)) return node;
    const exec = namedExecution(ticket.state, payload);
    if (isFailure(exec)) return exec;
    // A superseded execution's result is no longer wanted; nothing to record.
    if (exec.status === 'superseded') return { ok: true, appends: [], result: {} };
    if (exec.status !== 'running' || exec.attempts !== payload.attempt) {
      return fail('invariant_violated', `run ${exec.run} of node '${node.id}' is not running attempt ${payload.attempt} (${exec.status}, attempt ${exec.attempts})`);
    }
    const draft = new WorkflowDraft(ticket.aggregateId, ticket.state, workflow);
    const fields = { ticketId: ticket.aggregateId, nodeId: node.id, lane: exec.lane, run: exec.run };
    const { result } = payload;

    if (result.kind === 'agent') {
      if (exec.executor !== 'agent' || exec.runIds.at(-1) !== result.runId) return fail('invariant_violated', `run ${result.runId} is not the current run of this execution`);
      const run = await ctx.load(runAggregate, result.runId);
      if (!run.state.exists) return fail('not_found', `run ${result.runId} does not exist`);
      if (run.state.status === 'running') return fail('invariant_violated', `run ${result.runId} has not settled yet`);
      const resumeFrom = run.state.sessionId === undefined ? {} : { resumeFromRunId: result.runId };
      const canRequeue = exec.requeues < MAX_AUTOMATIC_ATTEMPTS;
      const interrupted = run.state.status === 'abnormal_exit' && run.state.terminalReason === 'engine_restarted';
      if (run.state.status === 'cancelled' && exec.pauseRequested && exec.pauseClaim?.fail === true) {
        // Stopped for a claim conflict under `onConflict: fail`.
        const conflicts = exec.pauseClaim.claim.conflicts;
        const error = `checkout conflict (onConflict: fail): ${conflicts.map((conflict) => `'${conflict.path}' is held by '${conflict.holder.nodeId}' of ticket ${conflict.holder.ticketId}`).join('; ')}`;
        complete(draft, node.id, exec.run, failureOutput(node, exec, error, { conflicts: conflicts.slice(0, 50) }), 'failed', { error });
      } else if (run.state.status === 'cancelled' && exec.pauseRequested) {
        draft.emit({ type: 'node.paused', data: { ...fields, resumeTo: 'queued', ...resumeFrom, ...(exec.pauseClaim === undefined ? {} : { claim: exec.pauseClaim.claim }) } });
      } else if (exec.submitted !== undefined && run.state.status !== 'cancelled') {
        // The agent reported before it ended; its result counts even if the process then exited badly.
        finishWithOutput(draft, node, exec, withLateArtifacts(exec.submitted, exec));
      } else if ((interrupted || run.state.status === 'cancelled') && canRequeue) {
        // Cancelled without a pause: the engine stopped it (shutdown, or a pause that was resumed before it took effect).
        const reason = interrupted ? 'the engine restarted while the agent was running' : 'the run was cancelled and the lane is still wanted';
        draft.emit({ type: 'node.requeued', data: { ...fields, reason, ...resumeFrom } });
      } else {
        const reason =
          run.state.status === 'succeeded'
            ? "the agent finished without reporting a result ('vuyro node done')"
            : `the agent run ended ${run.state.status}${run.state.terminalReason === undefined ? '' : ` (${run.state.terminalReason})`}`;
        const error = run.state.error === undefined ? reason : `${reason}: ${run.state.error}`;
        complete(draft, node.id, exec.run, failureOutput(node, exec, error, { outcome: run.state.status }), 'failed', { error });
      }
      return decided(ticket, draft);
    }

    if (result.kind === 'merge') {
      if (exec.executor !== 'merge') return fail('invariant_violated', 'this execution is not a merge');
      finishMerge(draft, node, exec, result);
      return decided(ticket, draft);
    }

    if (exec.executor !== 'script') return fail('invariant_violated', 'this execution is not a script');
    const outcome = scriptOutput(node, result);
    if ('error' in outcome) {
      complete(draft, node.id, exec.run, failureOutput(node, exec, outcome.error, outcome.details), 'failed', { error: outcome.error });
      return decided(ticket, draft);
    }
    const validator = ctx.definitions?.dataValidator;
    if (validator === undefined) return fail('invariant_violated', 'this engine has no definition store');
    const built = buildOutput(draft, node, exec, outcome.port, outcome.drafts, validator);
    if (!built.ok) {
      const error = `script output rejected: ${built.message}: ${built.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`;
      complete(draft, node.id, exec.run, failureOutput(node, exec, error), 'failed', { error });
      return decided(ticket, draft);
    }
    finishWithOutput(draft, node, exec, built.output, built.undeclared);
    return decided(ticket, draft);
  },
};

/**
 * Applies a join's merge step (worktree mode, §3.9 "합치기"): merged → the join passes its items on, each with the
 * ticket branch and commit; conflicts → by `onMergeConflict`: fail (the join fails), rerun (the join fails and the
 * conflicting lanes run again on top of what was merged; the join fires again when they finish), ask or an agent
 * that could not resolve them (the merge waits for a person in Review); resolved by an agent → Review as well.
 */
function finishMerge(draft: WorkflowDraft, node: CompiledNode, exec: Execution, result: Extract<CommandPayload<'node.finish'>['result'], { kind: 'merge' }>): void {
  const items = joinItems(draft, node.id, exec.run).map((item) =>
    result.branch === undefined || result.head === undefined
      ? item
      : { ...item, artifacts: { ...(item.artifacts ?? {}), mergedBranch: { kind: 'git', uri: result.branch, version: result.head } } },
  );
  const done = { schemaVersion: 1 as const, port: 'done', items };
  const conflicts = result.conflicts ?? [];
  const describe = conflicts.map((conflict) => `${conflict.branch} (${conflict.files.slice(0, 10).join(', ')})`).join('; ');
  if (result.outcome === 'merged') {
    complete(draft, node.id, exec.run, done, 'done');
    return;
  }
  if (result.outcome === 'error' || result.worktree === undefined || result.branch === undefined) {
    const error = `merge failed: ${result.error ?? 'unknown error'}`;
    complete(draft, node.id, exec.run, failureOutput(node, exec, error), 'failed', { error });
    return;
  }
  const review = { worktree: result.worktree, branch: result.branch, conflicts: conflicts.map((conflict) => ({ branch: conflict.branch, files: conflict.files })) };
  if (result.outcome === 'resolved') {
    draft.emit({ type: 'node.reviewRequested', data: { ticketId: draft.ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, output: done, merge: { ...review, resolvedBy: 'agent' } } });
    return;
  }
  const policy = nodeSettings(draft.state, draft.workflow, node.id).onMergeConflict;
  if (policy === 'fail') {
    const error = `merge conflict (onMergeConflict: fail): ${describe}`;
    complete(draft, node.id, exec.run, failureOutput(node, exec, error, { conflicts: conflicts.slice(0, 50) }), 'failed', { error });
    return;
  }
  if (policy === 'rerun') {
    const error = `merge conflict (onMergeConflict: rerun): ${describe}; those lanes run again on top of the merged branch`;
    complete(draft, node.id, exec.run, failureOutput(node, exec, error, { conflicts: conflicts.slice(0, 50) }), 'failed', { error });
    for (const conflict of conflicts) {
      const lane = currentExecution(draft.state, conflict.nodeId, conflict.lane);
      if (lane === undefined || ACTIVE_STATUSES.has(lane.status)) continue;
      rework(
        draft,
        lane,
        `Your branch ${conflict.branch} conflicted with the other work merged into ${result.branch} (files: ${conflict.files.slice(0, 20).join(', ')}). ` +
          'Your worktree now starts from the merged branch; do the task again on top of it.',
      );
    }
    return;
  }
  // ask, or an agent that could not resolve them: a person decides (approve = continue the merge, reject = let an agent try).
  draft.emit({ type: 'node.reviewRequested', data: { ticketId: draft.ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, output: done, merge: review } });
}

const TAIL = 4096;
const tail = (text: string | undefined): string => (text === undefined ? '' : text.length > TAIL ? text.slice(-TAIL) : text);

/** Maps a script's exit to an output port and items (see ScriptSpec). Shared nodes map their batch's exit the same way. */
export function scriptOutput(
  node: CompiledNode,
  result: Extract<CommandPayload<'node.finish'>['result'], { kind: 'script' }>,
): { port: string; drafts: DraftItem[] } | { error: string; details: Record<string, unknown> } {
  const script = node.type.script;
  if (script === undefined) return { error: 'node type has no script', details: {} };
  const details = { exitCode: result.exitCode, stderr: tail(result.stderr) };
  if (result.error !== undefined) return { error: `script did not complete: ${result.error}`, details };
  if (result.timedOut === true) return { error: `script timed out after ${script.timeoutMs} ms`, details };
  const code = result.exitCode === null ? undefined : String(result.exitCode);
  const port = (code !== undefined && Object.hasOwn(script.exitPorts, code) ? script.exitPorts[code] : script.exitPorts.default) ?? 'error';
  if (script.output === 'none') {
    return { port, drafts: [{ data: { exitCode: result.exitCode, stdout: tail(result.stdout), ...(port === 'error' ? { stderr: tail(result.stderr) } : {}) } }] };
  }
  const lines = (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) return port === 'error' ? { error: `script exited with ${String(result.exitCode)}`, details } : { error: 'script printed no JSON result', details };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { error: 'the last line of the script output is not JSON', details: { ...details, line: last.slice(0, 1000) } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'the script result must be a JSON object', details };
  const value = parsed as { port?: unknown; data?: unknown; summary?: unknown; items?: unknown };
  const chosen = typeof value.port === 'string' ? value.port : port;
  if (value.items !== undefined) {
    if (!Array.isArray(value.items)) return { error: "the script result's 'items' must be an array", details };
    for (const [index, item] of value.items.entries()) {
      const issues = draftValidator.validate(DraftItemSchema, item);
      if (issues.length > 0) return { error: `script result item ${index} is not valid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`, details };
    }
    return { port: chosen, drafts: value.items as DraftItem[] };
  }
  const item: DraftItem = {
    ...(typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data) ? { data: value.data as Record<string, unknown> } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
  };
  return { port: chosen, drafts: [item] };
}
