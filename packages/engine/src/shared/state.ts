import type { BatchTrigger, ClaimWait, DomainEvent, Holder, PinnedNodeType, SharedNodeSpec } from '@vuyro/contracts';
import type { NewEvent } from '../store/event-store.ts';
import { sameHolder } from '../workspace/ledger.ts';

/**
 * A shared node's state (M5, [[명령·이벤트 계약]] §15), folded from its aggregate (`shared:<projectId>:<name>`):
 * the definitions, the queue of requests, the batches running now and whether it is blocked. Pure, like the ticket
 * fold: the command handlers decide from it and the engine reads it to know what to run.
 */

export interface QueueEntry extends Holder {
  /** Engine clock when the request joined the queue (the `window` trigger counts from the oldest). */
  readonly at: number;
  /** Put back by a failed or interrupted batch: it met a trigger once already. */
  readonly retry?: true;
}

export interface RunningBatch {
  readonly batch: number;
  readonly batchId: string;
  readonly trigger: BatchTrigger;
  readonly members: readonly QueueEntry[];
  /** The definition version the batch runs. */
  readonly definition: number;
  /** Ledger entries it holds (`protect`). */
  readonly entries: readonly string[];
  readonly startedAt?: number;
}

export interface FinishedBatch {
  readonly batch: number;
  readonly batchId: string;
  readonly trigger: BatchTrigger;
  readonly members: readonly Holder[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly outcome: 'succeeded' | 'failed' | 'interrupted';
  readonly policy?: string;
  readonly failed: readonly Holder[];
  readonly errorFiles?: readonly string[];
}

export interface SharedDefinition {
  readonly spec: SharedNodeSpec;
  readonly nodeType: PinnedNodeType;
}

export interface SharedBlock {
  readonly reason: 'blamed' | 'interrupted';
  readonly batch: number;
  /** `blamed`: request lanes that must come back with a new execution before batches start again. */
  readonly by: readonly Holder[];
}

export interface SharedNodeState {
  readonly exists: boolean;
  readonly projectId: string;
  readonly name: string;
  /** The current definition version (0 before the first). */
  readonly version: number;
  readonly definitions: Readonly<Record<number, SharedDefinition>>;
  /** Waiting requests, front first. */
  readonly queue: readonly QueueEntry[];
  readonly running: Readonly<Record<number, RunningBatch>>;
  /** The last batch number given out. */
  readonly batches: number;
  readonly blocked?: SharedBlock;
  /** Protected paths someone else holds; the next batch waits for them. Cleared when a batch starts. */
  readonly waiting?: { readonly conflicts: ClaimWait['conflicts']; readonly policy: ClaimWait['policy'] };
  /** The last finished batches, newest last (at most RECENT_BATCHES). */
  readonly recent: readonly FinishedBatch[];
}

export const EMPTY_SHARED_NODE: SharedNodeState = {
  exists: false,
  projectId: '',
  name: '',
  version: 0,
  definitions: {},
  queue: [],
  running: {},
  batches: 0,
  recent: [],
};

const RECENT_BATCHES = 20;

/** The definition a shared node runs now. */
export function currentDefinition(state: SharedNodeState): SharedDefinition | undefined {
  return Object.hasOwn(state.definitions, state.version) ? state.definitions[state.version] : undefined;
}

export function runningBatches(state: SharedNodeState): RunningBatch[] {
  return Object.values(state.running).sort((a, b) => a.batch - b.batch);
}

/** The same request lane (ticket, node, lane), whatever the execution. */
export function sameLane(a: Holder, b: Holder): boolean {
  return a.ticketId === b.ticketId && a.nodeId === b.nodeId && a.lane === b.lane;
}

/** The state without an optional field (absent rather than undefined). */
function omit(state: SharedNodeState, key: 'blocked' | 'waiting'): SharedNodeState {
  return Object.fromEntries(Object.entries(state).filter(([name]) => name !== key)) as unknown as SharedNodeState;
}

function holderOnly(entry: Holder): Holder {
  return { ticketId: entry.ticketId, nodeId: entry.nodeId, lane: entry.lane, run: entry.run };
}

export function evolveSharedNode(state: SharedNodeState, event: NewEvent | DomainEvent): SharedNodeState {
  const timestamp = 'timestamp' in event ? event.timestamp : undefined;
  switch (event.type) {
    case 'sharedNode.defined': {
      const { data } = event;
      return {
        ...state,
        exists: true,
        projectId: data.projectId,
        name: data.name,
        version: data.version,
        definitions: { ...state.definitions, [data.version]: { spec: data.spec, nodeType: data.nodeType } },
      };
    }
    case 'sharedNode.requestQueued': {
      const { data } = event;
      const replaced = [data.request, ...(data.replaces ?? [])];
      const queue = state.queue.filter((entry) => !replaced.some((request) => sameHolder(entry, request)));
      let next: SharedNodeState = { ...state, queue: [...queue, { ...data.request, at: data.at }] };
      // A blamed lane that comes back with a newer execution was fixed.
      if (state.blocked?.reason === 'blamed') {
        const by = state.blocked.by.filter((blamed) => !(sameLane(blamed, data.request) && data.request.run > blamed.run));
        next = { ...next, blocked: { ...state.blocked, by } };
      }
      return next;
    }
    case 'sharedNode.requestDropped': {
      const { requests } = event.data;
      return { ...state, queue: state.queue.filter((entry) => !requests.some((request) => sameHolder(entry, request))) };
    }
    case 'sharedNode.waiting':
      return { ...state, waiting: { conflicts: event.data.conflicts, policy: event.data.policy } };
    case 'sharedNode.batchStarted': {
      const { data } = event;
      const members = data.members.map((member) => state.queue.find((entry) => sameHolder(entry, member)) ?? { ...member, at: timestamp ?? 0 });
      const batch: RunningBatch = {
        batch: data.batch,
        batchId: data.batchId,
        trigger: data.trigger,
        members,
        definition: data.definition,
        entries: data.entries,
        ...(timestamp === undefined ? {} : { startedAt: timestamp }),
      };
      return {
        ...omit(state, 'waiting'),
        queue: state.queue.filter((entry) => !data.members.some((member) => sameHolder(entry, member))),
        running: { ...state.running, [data.batch]: batch },
        batches: Math.max(state.batches, data.batch),
      };
    }
    case 'sharedNode.batchFinished': {
      const { data } = event;
      const running = Object.hasOwn(state.running, data.batch) ? state.running[data.batch] : undefined;
      // Requests put back go to the front, in their order, and keep when they first joined.
      const back = data.requeued.map((request): QueueEntry => {
        const member = running?.members.find((entry) => sameHolder(entry, request));
        return { ...request, at: member?.at ?? timestamp ?? 0, retry: true };
      });
      const queue = [...back, ...state.queue.filter((entry) => !data.requeued.some((request) => sameHolder(entry, request)))];
      const finished: FinishedBatch = {
        batch: data.batch,
        batchId: running?.batchId ?? `${state.name}-${data.batch}`,
        trigger: running?.trigger ?? 'manual',
        members: (running?.members ?? []).map(holderOnly),
        ...(running?.startedAt === undefined ? {} : { startedAt: running.startedAt }),
        ...(timestamp === undefined ? {} : { finishedAt: timestamp }),
        outcome: data.outcome,
        ...(data.policy === undefined ? {} : { policy: data.policy }),
        failed: data.failed,
        ...(data.errorFiles === undefined ? {} : { errorFiles: data.errorFiles }),
      };
      const rest = Object.fromEntries(Object.entries(state.running).filter(([batch]) => Number(batch) !== data.batch));
      return { ...state, queue, running: rest, recent: [...state.recent, finished].slice(-RECENT_BATCHES) };
    }
    case 'sharedNode.blocked':
      return { ...state, blocked: { reason: event.data.reason, batch: event.data.batch, by: event.data.by } };
    case 'sharedNode.unblocked':
      return omit(state, 'blocked');
    default:
      return state;
  }
}
