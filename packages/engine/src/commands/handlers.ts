import {
  type CommandError,
  commandError,
  type CommandPayload,
  type CommandResult,
  type CommandType,
  type RunObservation,
} from '@vuyro/contracts';
import type { RandomSource } from '../runtime/ids.ts';
import type { IdGenerator } from '../runtime/ids.ts';
import type { NewEvent, StreamAppend } from '../store/event-store.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';
import type { WorkspaceServices } from '../workspace/services.ts';
import { currentExecution, execution } from '../workflow/state.ts';
import {
  type AggregateDefinition,
  permissionsAggregate,
  permissionsAggregateId,
  projectAggregate,
  type RunState,
  runAggregate,
  type TicketState,
  ticketAggregate,
} from './aggregates.ts';
import type { CommandTarget } from './authorize.ts';
import type { CallerContext } from './caller.ts';
import { issueRunToken } from './run-token.ts';
import { sharedNodeDefine, sharedNodeEnqueue, sharedNodeFinish, sharedNodeRun, sharedNodeStart, sharedNodeUnblock } from './shared-handlers.ts';
import {
  appConfigure,
  checkoutForceRelease,
  projectConfigure,
  ticketWorkspace,
  workspaceRecord,
  worktreeCleanup,
} from './workspace-handlers.ts';
import {
  checkoutAcquireHandler,
  checkoutReleaseHandler,
  createTicketEvents,
  definitionAbandon,
  definitionActivate,
  laneScope,
  nodeApprove,
  nodeDone,
  nodeFinish,
  nodePause,
  nodeReject,
  nodeResume,
  nodeRetry,
  nodeStart,
  nodeTypeSave,
  templateSave,
} from './workflow-handlers.ts';

export interface Loaded<S> {
  readonly aggregateId: string;
  readonly revision: number;
  readonly state: S;
}

export interface HandlerContext {
  readonly caller: CallerContext;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
  /** Definition files (templates, node types). Absent in engines without a definition store. */
  readonly definitions?: DefinitionResolver;
  /** Workspace layout, clock and file hashes for the checkout ledger (M4). */
  readonly workspaces?: WorkspaceServices;
  load<S>(definition: AggregateDefinition<S>, aggregateId: string): Promise<Loaded<S>>;
}

export type Decision<T extends CommandType> =
  | {
      readonly ok: true;
      readonly appends: readonly StreamAppend[];
      readonly result: CommandResult<T>;
      /** What an idempotent replay returns, when it must differ from `result` (secrets). */
      readonly storedResult?: CommandResult<T>;
      /** Aggregate whose revision the response reports, for commands that create one. */
      readonly created?: string;
    }
  | { readonly ok: false; readonly error: CommandError };

export interface CommandHandler<T extends CommandType, S> {
  /** The existing aggregate the command changes (checked against `expectedRevision`). Omit when it creates one. */
  readonly target?: (payload: CommandPayload<T>) => { readonly definition: AggregateDefinition<S>; readonly aggregateId: string };
  /** Ticket, node and run the command acts on, for the scope check. */
  readonly scope: (payload: CommandPayload<T>, target: Loaded<S> | undefined) => CommandTarget;
  /**
   * True (or true for this payload) when `scope` needs the loaded target (e.g. a run's ticket and node,
   * or the run that drives a named lane). The bus first authorizes from the payload alone, before reading
   * anything, and only then loads the target and authorizes again with the full scope.
   */
  readonly scopeNeedsTarget?: boolean | ((payload: CommandPayload<T>) => boolean);
  readonly decide: (ctx: HandlerContext, payload: CommandPayload<T>, target: Loaded<S> | undefined) => Promise<Decision<T>>;
}

const fail = (code: CommandError['code'], message: string): { ok: false; error: CommandError } => ({
  ok: false,
  error: commandError(code, message),
});

function stream(aggregateType: string, aggregateId: string, expectedRevision: number, events: NewEvent[]): StreamAppend {
  return { aggregateType, aggregateId, expectedRevision, events };
}

function requireTarget<S>(target: Loaded<S> | undefined): Loaded<S> {
  if (target === undefined) throw new Error('handler declared a target but none was loaded');
  return target;
}

const OBSERVATION_EVENTS = {
  session: 'run.sessionIdentified',
  message: 'run.messageRecorded',
  toolCallStarted: 'run.toolCallStarted',
  toolCallFinished: 'run.toolCallFinished',
  usage: 'run.usageRecorded',
  warning: 'run.warningRecorded',
  raw: 'run.rawRecorded',
} as const satisfies Record<RunObservation['kind'], string>;

function observationEvent(runId: string, observation: RunObservation): NewEvent {
  const { kind, ...fields } = observation;
  return { type: OBSERVATION_EVENTS[kind], data: { runId, ...fields } } as NewEvent;
}

const runningRun = (target: Loaded<RunState> | undefined): Loaded<RunState> | { ok: false; error: CommandError } => {
  const run = requireTarget(target);
  if (!run.state.exists) return fail('not_found', `run ${run.aggregateId} does not exist`);
  if (run.state.status !== 'running') return fail('invariant_violated', `run ${run.aggregateId} has already settled (${run.state.status})`);
  return run;
};

const ticketTarget = (payload: { ticketId: string }) => ({ definition: ticketAggregate, aggregateId: payload.ticketId });
const runTarget = (payload: { runId: string }) => ({ definition: runAggregate, aggregateId: payload.runId });
const runScope = (payload: { runId: string }, target: Loaded<RunState> | undefined): CommandTarget => ({
  runId: payload.runId,
  ...(target?.state.exists === true ? { ticketId: target.state.ticketId, nodeId: target.state.nodeId } : {}),
});

type HandlerMap = { readonly [T in CommandType]: CommandHandler<T, never> };

/** A handler with its payload and state types erased, for the bus after it validated the payload. */
export interface ErasedHandler {
  readonly target?: (payload: unknown) => { readonly definition: AggregateDefinition<unknown>; readonly aggregateId: string };
  readonly scope: (payload: unknown, target: Loaded<unknown> | undefined) => CommandTarget;
  readonly scopeNeedsTarget?: boolean | ((payload: unknown) => boolean);
  readonly decide: (ctx: HandlerContext, payload: unknown, target: Loaded<unknown> | undefined) => Promise<Decision<CommandType>>;
}

export function handlerFor(type: CommandType): ErasedHandler {
  return HANDLERS[type] as unknown as ErasedHandler;
}

function handler<T extends CommandType, S>(definition: CommandHandler<T, S>): CommandHandler<T, never> {
  return definition as unknown as CommandHandler<T, never>;
}

export const HANDLERS: HandlerMap = {
  'project.create': handler<'project.create', never>({
    scope: () => ({}),
    decide: (ctx, payload) => {
      const projectId = ctx.ids.next();
      return Promise.resolve({
        ok: true,
        appends: [stream('project', projectId, 0, [{ type: 'project.created', data: { projectId, name: payload.name } }])],
        result: { projectId },
        created: projectId,
      });
    },
  }),

  'ticket.create': handler<'ticket.create', never>({
    scope: () => ({}),
    decide: async (ctx, payload) => {
      const project = await ctx.load(projectAggregate, payload.projectId);
      if (!project.state.exists) return fail('not_found', `project ${payload.projectId} does not exist`);
      const ticketId = ctx.ids.next();
      const events = await createTicketEvents(ctx, ticketId, payload, await ticketWorkspace(ctx, project.state));
      if (!Array.isArray(events)) return events;
      return {
        ok: true,
        appends: [stream('ticket', ticketId, 0, events)],
        result: { ticketId },
        created: ticketId,
      };
    },
  }),

  'ticket.update': handler<'ticket.update', TicketState>({
    target: ticketTarget,
    scope: (payload) => ({ ticketId: payload.ticketId }),
    decide: (_ctx, payload, target) => {
      const ticket = requireTarget(target);
      if (!ticket.state.exists) return Promise.resolve(fail('not_found', `ticket ${payload.ticketId} does not exist`));
      return Promise.resolve({
        ok: true,
        appends: [stream('ticket', ticket.aggregateId, ticket.revision, [{ type: 'ticket.updated', data: payload }])],
        result: {},
      });
    },
  }),

  'artifact.add': handler<'artifact.add', TicketState>({
    target: ticketTarget,
    // Naming a lane its run does not drive is out of a node agent's scope (see laneScope).
    scope: laneScope,
    scopeNeedsTarget: (payload) => payload.lane !== undefined,
    decide: (ctx, payload, target) => {
      const ticket = requireTarget(target);
      if (!ticket.state.exists) return Promise.resolve(fail('not_found', `ticket ${payload.ticketId} does not exist`));
      const runId = ctx.caller.binding?.runId;
      let data = { ...payload, ...(runId === undefined ? {} : { runId }) };
      if (runId !== undefined && Object.hasOwn(ticket.state.runIndex, runId)) {
        // A workflow run may register artifacts only while it still drives its lane (not once superseded).
        const owner = ticket.state.runIndex[runId];
        const exec = owner === undefined ? undefined : execution(ticket.state, owner.nodeId, owner.run);
        const current = exec === undefined ? undefined : currentExecution(ticket.state, exec.nodeId, exec.lane);
        if (exec === undefined || current?.run !== exec.run || exec.status !== 'running' || exec.runIds.at(-1) !== runId) {
          return Promise.resolve(fail('invariant_violated', `run ${runId} no longer drives its lane (it is ${exec?.status ?? 'unknown'})`));
        }
        // The run says which lane it registers for, so parallel lanes keep their own latest artifact (M6a fix:
        // without it every lane's registration had no lane and the registry's "current" kept only the last one).
        data = { ...data, lane: payload.lane ?? exec.lane };
      }
      return Promise.resolve({
        ok: true,
        appends: [stream('ticket', ticket.aggregateId, ticket.revision, [{ type: 'artifact.added', data }])],
        result: {},
      });
    },
  }),

  'run.start': handler<'run.start', never>({
    scope: (payload) => ({ ticketId: payload.ticketId, nodeId: payload.nodeId }),
    decide: async (ctx, payload) => {
      const ticket = await ctx.load(ticketAggregate, payload.ticketId);
      if (!ticket.state.exists) return fail('not_found', `ticket ${payload.ticketId} does not exist`);
      if (payload.resumedFromRunId !== undefined) {
        const previous = await ctx.load(runAggregate, payload.resumedFromRunId);
        if (!previous.state.exists) return fail('not_found', `run ${payload.resumedFromRunId} does not exist`);
        const sameNode = previous.state.ticketId === payload.ticketId && previous.state.nodeId === payload.nodeId;
        if (!sameNode || previous.state.provider !== payload.provider) {
          return fail('invariant_violated', 'a run can only resume a run of the same node and provider');
        }
        if (previous.state.status === 'running') return fail('invariant_violated', 'cannot resume a run that is still running');
      }
      const runId = ctx.ids.next();
      const { token, hash } = issueRunToken(ctx.random);
      const data = {
        runId,
        ticketId: payload.ticketId,
        nodeId: payload.nodeId,
        provider: payload.provider,
        tokenHash: hash,
        ...(payload.resumedFromRunId === undefined ? {} : { resumedFromRunId: payload.resumedFromRunId }),
      };
      return {
        ok: true,
        appends: [stream('run', runId, 0, [{ type: 'run.started', data }])],
        result: { runId, runToken: token },
        storedResult: { runId },
        created: runId,
      };
    },
  }),

  'run.observe': handler<'run.observe', RunState>({
    target: runTarget,
    scope: runScope,
    scopeNeedsTarget: true,
    decide: (_ctx, payload, target) => {
      const run = runningRun(target);
      if ('ok' in run) return Promise.resolve(run);
      const events = payload.observations.map((observation) => observationEvent(run.aggregateId, observation));
      return Promise.resolve({ ok: true, appends: [stream('run', run.aggregateId, run.revision, events)], result: {} });
    },
  }),

  'run.settle': handler<'run.settle', RunState>({
    target: runTarget,
    scope: runScope,
    scopeNeedsTarget: true,
    decide: (_ctx, payload, target) => {
      const run = runningRun(target);
      if ('ok' in run) return Promise.resolve(run);
      return Promise.resolve({
        ok: true,
        appends: [stream('run', run.aggregateId, run.revision, [{ type: 'run.settled', data: payload }])],
        result: {},
      });
    },
  }),

  'permission.edit': handler<'permission.edit', { ruleCount: number }>({
    target: (payload) => ({
      definition: permissionsAggregate,
      aggregateId: permissionsAggregateId(payload.scope, payload.scope === 'project' ? payload.projectId : undefined),
    }),
    scope: () => ({}),
    decide: async (ctx, payload, target) => {
      const rules = requireTarget(target);
      if (payload.scope === 'project') {
        const project = await ctx.load(projectAggregate, payload.projectId);
        if (!project.state.exists) return fail('not_found', `project ${payload.projectId} does not exist`);
      }
      return {
        ok: true,
        appends: [stream('permissions', rules.aggregateId, rules.revision, [{ type: 'permission.rulesChanged', data: payload }])],
        result: {},
      };
    },
  }),

  'project.configure': handler(projectConfigure),
  'app.configure': handler(appConfigure),
  'checkout.acquire': handler(checkoutAcquireHandler),
  'checkout.release': handler(checkoutReleaseHandler),
  'checkout.forceRelease': handler(checkoutForceRelease),
  'workspace.record': handler(workspaceRecord),
  'worktree.cleanup': handler(worktreeCleanup),
  'nodeType.save': handler(nodeTypeSave),
  'template.save': handler(templateSave),
  'definition.activate': handler(definitionActivate),
  'definition.abandon': handler(definitionAbandon),
  'node.done': handler(nodeDone),
  'node.approve': handler(nodeApprove),
  'node.reject': handler(nodeReject),
  'node.retry': handler(nodeRetry),
  'node.pause': handler(nodePause),
  'node.resume': handler(nodeResume),
  'node.start': handler(nodeStart),
  'node.finish': handler(nodeFinish),
  'sharedNode.define': handler(sharedNodeDefine),
  'sharedNode.enqueue': handler(sharedNodeEnqueue),
  'sharedNode.start': handler(sharedNodeStart),
  'sharedNode.run': handler(sharedNodeRun),
  'sharedNode.finish': handler(sharedNodeFinish),
  'sharedNode.unblock': handler(sharedNodeUnblock),
};
