import {
  type ActivationCause,
  type ArtifactRef,
  type Basis,
  type ClaimWait,
  type ExecutionStatus,
  type HandoffItem,
  isRetiredEvent,
  type MergeReview,
  type NodeRunOutput,
  type NodeStatus,
  type PinnedTemplate,
  type TicketWorkspace,
} from '@vuyro/contracts';
import type { DomainEvent } from '@vuyro/contracts';
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
  /** Generation record of what the activation consumed (§10.6 item 3). Absent on old events: free. */
  readonly basis?: Basis;
  /** Groups this execution's deliveries opened (a new generation it started; §10.6 item 3). */
  readonly opened?: readonly string[];
  readonly feedback?: { readonly run: number; readonly comment?: string };
  readonly attempts: number;
  /** Automatic restarts so far (engine restart, cancelled without a pause). Bounded by MAX_AUTOMATIC_ATTEMPTS. */
  readonly requeues: number;
  readonly executor?: 'agent' | 'script' | 'merge';
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
  /** The engine asked the run to stop for a claim conflict (M4): it then waits for the paths, or fails (`fail`). */
  readonly pauseClaim?: { readonly claim: ClaimWait; readonly fail?: true };
  /** Paused because another execution holds paths this one needs (M4). Cleared when it resumes. */
  readonly claimWait?: ClaimWait;
  /**
   * A person resumed it while it waited for a claim: for the rest of this execution its claims and checkouts go ahead
   * despite overlaps (recorded as warnings). A person decided it may; waiting again would undo that.
   */
  readonly override?: true;
  /** Worktree mode: start the lane's worktree over from the ticket branch (merge conflict, `rerun`). */
  readonly reset?: true;
  /** A join's merge waiting for a person (conflicts), M4. */
  readonly merge?: MergeReview;
  /** Set when the output had items for edges but every one was stale, so nothing travelled (not a path end, D-021). */
  readonly onlyStale?: boolean;
  /** Ticket step at which the execution finished (for "latest run", and "after the last activation"). */
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
  /** Current fan-out group (each-mode nodes): the group the node opened last. */
  readonly group?: string;
  /** Ticket step of the node's last activation (0: never activated). */
  readonly activated: number;
}

export interface Group {
  readonly node: string;
  /** The upstream fan-out group it hangs under (chained fan-out). */
  readonly parent?: string;
  /** The last empty delivery the group passed on: over which edges, at which ticket step. */
  readonly passed?: { readonly edges: readonly number[]; readonly step: number };
}

export interface TicketWorkflow {
  readonly exists: boolean;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly status: 'open' | 'done';
  readonly template?: PinnedTemplate;
  /** Claim priority (`priorityWins`). Default 0. */
  readonly priority: number;
  /** The workspace and app + project settings pinned at creation (M4). */
  readonly workspace?: TicketWorkspace;
  readonly nodes: Readonly<Record<string, NodeProgress>>;
  /** Fan-out groups by id. */
  readonly groups: Readonly<Record<string, Group>>;
  /**
   * Set when the log holds events in a retired format (§6): the ticket needs attention and nothing carries it on.
   * `event` names the first such event (type and version).
   */
  readonly attention?: { readonly reason: 'legacy-events'; readonly event: string };
  /**
   * Counts activations, completions and pass-overs in order ([[명령·이벤트 계약]] §10.6 item 1): "after X" compares
   * these steps.
   */
  readonly step: number;
  /** Groups of passed-over fan-out nodes whose empty delivery had nowhere further to go (implicit ends). */
  readonly endGroups: readonly string[];
  /** Agent run id → execution. */
  readonly runIndex: Readonly<Record<string, { readonly nodeId: string; readonly run: number }>>;
}

export const EMPTY_TICKET: TicketWorkflow = {
  exists: false,
  projectId: '',
  title: '',
  status: 'open',
  priority: 0,
  nodes: {},
  groups: {},
  step: 0,
  endGroups: [],
  runIndex: {},
};

const EMPTY_NODE: NodeProgress = { executions: [], lanes: {}, laneOrder: [], activated: 0 };

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

/** A group is live while it is its node's current group and the group it hangs under is live (§10.6 item 3). */
export function groupLive(state: TicketWorkflow, groupId: string): boolean {
  const seen = new Set<string>();
  for (let current: string | undefined = groupId; current !== undefined; ) {
    if (seen.has(current)) return false;
    seen.add(current);
    const group: Group | undefined = Object.hasOwn(state.groups, current) ? state.groups[current] : undefined;
    if (group === undefined || nodeProgress(state, group.node).group !== current) return false;
    current = group.parent;
  }
  return true;
}

/** A lane is live when it has no group (lane 'main') or its group is live: it belongs to the current generation. */
export function laneLive(state: TicketWorkflow, nodeId: string, lane: string): boolean {
  const group = laneOf(state, nodeId, lane)?.group;
  return group === undefined || groupLive(state, group);
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
export function evolveTicket(state: TicketWorkflow, event: NewEvent | DomainEvent): TicketWorkflow {
  if ('schemaVersion' in event && state.attention === undefined && isRetiredEvent(event)) {
    state = { ...state, attention: { reason: 'legacy-events', event: `${event.type} v${event.schemaVersion}` } };
  }
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
        priority: data.priority ?? 0,
        workspace: data.workspace,
      });
    }
    case 'ticket.updated': {
      const { data } = event;
      return {
        ...state,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.description === undefined ? {} : { description: data.description }),
        ...(data.priority === undefined ? {} : { priority: data.priority }),
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
      const step = state.step + 1;
      let next: TicketWorkflow = { ...state, step };
      if (data.group !== undefined && !Object.hasOwn(state.groups, data.group)) {
        next = { ...next, groups: { ...next.groups, [data.group]: withoutUndefined<Group>({ node: data.nodeId, parent: data.groupParent }) } };
        if (data.openedBy !== undefined) next = recordOpened(next, data.openedBy, data.group);
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
        basis: data.basis,
        feedback: data.feedback,
        attempts: 0,
        requeues: 0,
        runIds: [],
        routes: {},
        artifacts: {},
        pauseRequested: false,
        reset: data.workspace?.reset,
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
          activated: step,
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
          reset: undefined,
          merge: undefined,
        }),
      );
      if (data.runId !== undefined) next = { ...next, runIndex: { ...next.runIndex, [data.runId]: { nodeId: data.nodeId, run: data.run } } };
      return next;
    }
    case 'node.outputSubmitted':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, submitted: event.data.output }));
    case 'node.reviewRequested':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({ ...current, status: 'review', output: event.data.output, merge: event.data.merge }),
      );
    case 'node.returned':
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({ ...current, status: 'discarded' }));
    case 'node.completed': {
      const { data } = event;
      const step = state.step + 1;
      return setExecution({ ...state, step }, data.nodeId, data.run, (current) => ({
        ...current,
        status: data.status,
        output: data.output,
        // Empty deliveries count as routes with no items: the output did go somewhere.
        routes: Object.fromEntries([
          ...(data.empty ?? []).map((entry): [number, readonly number[]] => [entry.edge, []]),
          ...data.routes.map((route): [number, readonly number[]] => [route.edge, route.items]),
        ]),
        completedOrder: step,
        ...(data.routes.length === 0 && (data.empty ?? []).length === 0 && (data.stale ?? []).length > 0 ? { onlyStale: true } : {}),
      }));
    }
    case 'node.passedOver': {
      const { data } = event;
      const step = state.step + 1;
      const existing = Object.hasOwn(state.groups, data.group) ? state.groups[data.group] : undefined;
      const group = withoutUndefined<Group>({
        node: data.nodeId,
        parent: existing === undefined ? data.groupParent : existing.parent,
        passed: { edges: data.edges.map((entry) => entry.edge), step },
      });
      const opener = existing === undefined && data.openedBy !== undefined ? recordOpened(state, data.openedBy, data.group) : state;
      const next: TicketWorkflow = {
        ...opener,
        step,
        groups: { ...state.groups, [data.group]: group },
        endGroups: data.edges.length === 0 ? [...state.endGroups, data.group] : state.endGroups,
      };
      return setNode(next, data.nodeId, (node) => ({ ...node, group: data.group }));
    }
    case 'node.superseded':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({ ...current, status: 'superseded', pauseRequested: false, pauseClaim: undefined, claimWait: undefined }),
      );
    case 'node.requeued':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: 'queued',
          pauseClaim: undefined,
          requeues: current.requeues + 1,
          submitted: undefined,
          resumeFromRunId: event.data.resumeFromRunId,
        }),
      );
    case 'node.pauseRequested': {
      const { claim, fail } = event.data;
      return setExecution(state, event.data.nodeId, event.data.run, (current) => ({
        ...current,
        pauseRequested: true,
        ...(claim === undefined ? {} : { pauseClaim: fail === true ? { claim, fail } : { claim } }),
      }));
    }
    case 'node.paused':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: 'paused',
          pauseRequested: false,
          pauseClaim: undefined,
          submitted: undefined,
          resumeTo: event.data.resumeTo,
          resumeFromRunId: event.data.resumeFromRunId ?? current.resumeFromRunId,
          claimWait: event.data.claim,
        }),
      );
    case 'node.resumed':
      return setExecution(state, event.data.nodeId, event.data.run, (current) =>
        withoutUndefined<Execution>({
          ...current,
          status: current.status === 'paused' ? (current.resumeTo ?? 'queued') : current.status,
          pauseRequested: false,
          pauseClaim: undefined,
          resumeTo: undefined,
          claimWait: undefined,
          override: event.data.override ?? current.override,
        }),
      );
    default:
      return state;
  }
}

function recordOpened(state: TicketWorkflow, by: { nodeId: string; run: number }, group: string): TicketWorkflow {
  return setExecution(state, by.nodeId, by.run, (current) => ({ ...current, opened: [...(current.opened ?? []), group] }));
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
