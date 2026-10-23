import type {
  ActivationCause,
  ArtifactRef,
  ExecutionStatus,
  HandoffItem,
  NodeRunOutput,
  NodeStatus,
  PinnedTemplate,
} from '@vuyro/contracts';
import type { NewEvent } from '../store/event-store.ts';

/**
 * The ticket's workflow state, folded from the ticket aggregate's events. Pure and template-free:
 * every routing decision is in the events (activations, routes), so replay never needs the template.
 * Updates copy only what changes, because the command bus caches states and must never see them mutate.
 */

export interface Execution {
  readonly nodeId: string;
  /** Execution number within the node (ItemRef.run). */
  readonly run: number;
  readonly lane: string;
  readonly cause: ActivationCause;
  readonly status: ExecutionStatus;
  readonly inputs: Readonly<Record<string, readonly HandoffItem[]>>;
  readonly feedback?: { readonly run: number; readonly comment?: string };
  readonly attempts: number;
  readonly executor?: 'agent' | 'script';
  /** Agent runs of this execution, oldest first. The last one is current. */
  readonly runIds: readonly string[];
  /** What the agent submitted with `node.done` (applied when its run settles). */
  readonly submitted?: NodeRunOutput;
  /** The final output (done/failed) or the one held for review. */
  readonly output?: NodeRunOutput;
  /** Edge index → output item indexes that travelled it. */
  readonly routes: Readonly<Record<number, readonly number[]>>;
  /** Artifacts registered for this execution (by its runs, or for its lane while it was active). */
  readonly artifacts: Readonly<Record<string, ArtifactRef>>;
  readonly resumeFromRunId?: string;
  readonly pauseRequested: boolean;
  readonly resumeTo?: 'queued' | 'review' | 'rejected';
  /** Order in which executions finished within the ticket (for "latest run"). */
  readonly completedOrder?: number;
}

export interface Lane {
  readonly lane: string;
  readonly group?: string;
  /** Runs of this lane, oldest first. The last one is the lane's current execution. */
  readonly runs: readonly number[];
}

export interface NodeProgress {
  readonly executions: readonly Execution[];
  readonly lanes: Readonly<Record<string, Lane>>;
  readonly laneOrder: readonly string[];
  /** Current fan-out group (each-mode nodes). */
  readonly group?: string;
  /** Delivery sequence of the latest route into this node, per incoming edge index. */
  readonly deliveries: Readonly<Record<number, number>>;
  /** Delivery sequence when the node was last activated. */
  readonly consumed: number;
}

export interface TicketWorkflow {
  readonly exists: boolean;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly status: 'open' | 'done';
  readonly template?: PinnedTemplate;
  readonly nodes: Readonly<Record<string, NodeProgress>>;
  /** Group id → parent group (chained fan-out). */
  readonly groups: Readonly<Record<string, { readonly node: string; readonly parent?: string }>>;
  readonly deliverySeq: number;
  readonly completions: number;
  /** Agent run id → execution. */
  readonly runIndex: Readonly<Record<string, { readonly nodeId: string; readonly run: number }>>;
}

export const EMPTY_TICKET: TicketWorkflow = {
  exists: false,
  projectId: '',
  title: '',
  status: 'open',
  nodes: {},
  groups: {},
  deliverySeq: 0,
  completions: 0,
  runIndex: {},
};

const EMPTY_NODE: NodeProgress = { executions: [], lanes: {}, laneOrder: [], deliveries: {}, consumed: 0 };

/** Statuses of executions that still need someone (executor, person). */
export const ACTIVE_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['queued', 'running', 'review', 'rejected', 'paused']);
/** Statuses that end an execution. */
export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['done', 'failed', 'superseded', 'discarded']);

export function nodeProgress(state: TicketWorkflow, nodeId: string): NodeProgress {
  return Object.hasOwn(state.nodes, nodeId) ? (state.nodes[nodeId] ?? EMPTY_NODE) : EMPTY_NODE;
}

export function execution(state: TicketWorkflow, nodeId: string, run: number): Execution | undefined {
  return nodeProgress(state, nodeId).executions[run - 1];
}

export function laneOf(state: TicketWorkflow, nodeId: string, lane: string): Lane | undefined {
  const progress = nodeProgress(state, nodeId);
  return Object.hasOwn(progress.lanes, lane) ? progress.lanes[lane] : undefined;
}

/** The lane's current (latest) execution. */
export function currentExecution(state: TicketWorkflow, nodeId: string, lane: string): Execution | undefined {
  const run = laneOf(state, nodeId, lane)?.runs.at(-1);
  return run === undefined ? undefined : execution(state, nodeId, run);
}

/** Lane-visible status: the current execution's status; a node with no lanes is waiting. */
export function laneStatus(state: TicketWorkflow, nodeId: string, lane: string): NodeStatus {
  const status = currentExecution(state, nodeId, lane)?.status;
  if (status === undefined || status === 'superseded' || status === 'discarded') return 'wait';
  return status;
}

function setNode(state: TicketWorkflow, nodeId: string, update: (node: NodeProgress) => NodeProgress): TicketWorkflow {
  return { ...state, nodes: { ...state.nodes, [nodeId]: update(nodeProgress(state, nodeId)) } };
}

function setExecution(state: TicketWorkflow, nodeId: string, run: number, update: (current: Execution) => Execution): TicketWorkflow {
  return setNode(state, nodeId, (node) => {
    const current = node.executions[run - 1];
    if (current === undefined) return node;
    const executions = [...node.executions];
    executions[run - 1] = update(current);
    return { ...node, executions };
  });
}

type Loose<T> = { [K in keyof T]: T[K] | undefined };

/** Drops undefined fields, so optional fields are absent rather than undefined (exactOptionalPropertyTypes). */
function withoutUndefined<T extends object>(value: Loose<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** Folds one ticket event into the workflow state. */
export function evolveTicket(state: TicketWorkflow, event: NewEvent): TicketWorkflow {
  switch (event.type) {
    case 'ticket.created': {
      const { data } = event;
      return withoutUndefined<TicketWorkflow>({
        ...EMPTY_TICKET,
        exists: true,
        projectId: data.projectId,
        title: data.title,
        description: data.description,
        template: data.template,
      });
    }
    case 'ticket.updated': {
      const { data } = event;
      return {
        ...state,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.description === undefined ? {} : { description: data.description }),
      };
    }
    case 'ticket.completed':
      return { ...state, status: 'done' };
    case 'artifact.added': {
      const { data } = event;
      const target = artifactTarget(state, data.nodeId, data.runId, data.lane);
      if (target === undefined) return state;
      return setExecution(state, data.nodeId, target, (current) => ({ ...current, artifacts: { ...current.artifacts, [data.slot]: data.ref } }));
    }
    case 'node.activated': {
      const { data } = event;
      let next = state;
      if (data.group !== undefined && !Object.hasOwn(state.groups, data.group)) {
        next = {
          ...next,
          groups: { ...next.groups, [data.group]: withoutUndefined<{ node: string; parent?: string }>({ node: data.nodeId, parent: data.groupParent }) },
        };
      }
      if (data.supersedes !== undefined) {
        next = setExecution(next, data.nodeId, data.supersedes, (current) => ({ ...current, status: 'superseded' }));
      }
      const fresh = withoutUndefined<Execution>({
        nodeId: data.nodeId,
        run: data.run,
        lane: data.lane,
        cause: data.cause,
        status: data.status,
        inputs: data.inputs,
        feedback: data.feedback,
        attempts: 0,
        runIds: [],
        routes: {},
        artifacts: {},
        pauseRequested: false,
      });
      return setNode(next, data.nodeId, (node) => {
        const existing = Object.hasOwn(node.lanes, data.lane) ? node.lanes[data.lane] : undefined;
        const lane = withoutUndefined<Lane>({ lane: data.lane, group: data.group ?? existing?.group, runs: [...(existing?.runs ?? []), data.run] });
        return withoutUndefined<NodeProgress>({
          ...node,
          executions: [...node.executions, fresh],
          lanes: { ...node.lanes, [data.lane]: lane },
          laneOrder: existing === undefined ? [...node.laneOrder, data.lane] : node.laneOrder,
          group: data.group ?? node.group,
          consumed: state.deliverySeq,
        });
      });
    }
    case 'node.started': {
      const { data } = event;
      let next = setExecution(state, data.nodeId, data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: 'running',
          attempts: data.attempt,
          executor: data.executor,
          runIds: data.runId === undefined ? current.runIds : [...current.runIds, data.runId],
          resumeFromRunId: undefined,
        }),
      );
      if (data.runId !== undefined) next = { ...next, runIndex: { ...next.runIndex, [data.runId]: { nodeId: data.nodeId, run: data.run } } };
      return next;
    }
    case 'node.outputSubmitted':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, submitted: event.data.output }));
    case 'node.reviewRequested':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, status: 'review', output: event.data.output }));
    case 'node.returned':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, status: 'discarded' }));
    case 'node.completed': {
      const { data } = event;
      const completions = state.completions + 1;
      let next: TicketWorkflow = { ...state, completions };
      next = setExecution(next, data.nodeId, data.run, (current) => ({
        ...current,
        status: data.status,
        output: data.output,
        routes: Object.fromEntries(data.routes.map((route) => [route.edge, route.items])),
        completedOrder: completions,
      }));
      // Record deliveries per target edge; targets read them to decide when to fire.
      let seq = next.deliverySeq;
      for (const route of data.routes) {
        seq += 1;
        next = setNode(next, route.to, (node) => ({ ...node, deliveries: { ...node.deliveries, [route.edge]: seq } }));
      }
      return { ...next, deliverySeq: seq };
    }
    case 'node.requeued':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({ ...current, status: 'queued', submitted: undefined, resumeFromRunId: event.data.resumeFromRunId }),
      );
    case 'node.pauseRequested':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, pauseRequested: true }));
    case 'node.paused':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: 'paused',
          pauseRequested: false,
          submitted: undefined,
          resumeTo: event.data.resumeTo,
          resumeFromRunId: event.data.resumeFromRunId ?? current.resumeFromRunId,
        }),
      );
    case 'node.resumed':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: current.status === 'paused' ? (current.resumeTo ?? 'queued') : current.status,
          pauseRequested: false,
          resumeTo: undefined,
        }),
      );
    default:
      return state;
  }
}

/** Which execution an artifact registration belongs to: the run's execution, else the named or only active lane. */
function artifactTarget(state: TicketWorkflow, nodeId: string, runId: string | undefined, lane: string | undefined): number | undefined {
  if (runId !== undefined) {
    const owner = Object.hasOwn(state.runIndex, runId) ? state.runIndex[runId] : undefined;
    return owner?.nodeId === nodeId ? owner.run : undefined;
  }
  const progress = nodeProgress(state, nodeId);
  const candidates = (lane === undefined ? progress.laneOrder : [lane])
    .map((name) => currentExecution(state, nodeId, name))
    .filter((current): current is Execution => current !== undefined && ACTIVE_STATUSES.has(current.status));
  return candidates.length === 1 ? candidates[0]?.run : undefined;
}
