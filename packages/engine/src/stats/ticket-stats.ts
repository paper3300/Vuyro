import type { DomainEvent, NodeStats, TicketStats, TimeStats, UsageStats } from '@vuyro/contracts';

/**
 * Ticket statistics computed from the event log alone ([[명령·이벤트 계약]] §12): per node the time spent
 * queued, running, waiting for a person and paused, the tokens, tool calls and messages of its agent runs,
 * and for the ticket its total time and the wall-clock time anything waited for a person.
 *
 * Pure: the same events and `asOf` always give the same numbers. Open intervals end at `asOf`.
 */

export type NodeKind = 'agent' | 'script' | 'human' | 'join' | 'shared';

export interface TicketStatsInput {
  readonly ticketId: string;
  /** Events of the ticket aggregate, in revision order. */
  readonly ticketEvents: readonly DomainEvent[];
  /** Events of the ticket's runs (run aggregates), in sequence order. */
  readonly runEvents: readonly DomainEvent[];
  /** Node completion kinds from the pinned template, when it can be read. */
  readonly nodeKinds?: Readonly<Record<string, NodeKind>>;
  readonly asOf: number;
}

type Category = keyof TimeStats;

interface ExecutionTrack {
  readonly nodeId: string;
  status: string;
  since: number;
  open: boolean;
}

interface Interval {
  readonly from: number;
  readonly to: number;
}

interface RunUsage {
  nodeId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number | undefined;
  toolCalls: number;
  toolErrors: number;
  messages: number;
}

interface MutableNode {
  nodeId: string;
  executions: number;
  attempts: number;
  failed: number;
  reworks: number;
  decisions: { human: number; ai: number };
  time: Record<Category, number>;
}

const emptyTime = (): Record<Category, number> => ({ queuedMs: 0, runningMs: 0, humanWaitMs: 0, pausedMs: 0 });

export function computeTicketStats(input: TicketStatsInput): TicketStats {
  const { asOf } = input;
  const nodes = new Map<string, MutableNode>();
  const node = (nodeId: string): MutableNode => {
    let found = nodes.get(nodeId);
    if (found === undefined) {
      found = { nodeId, executions: 0, attempts: 0, failed: 0, reworks: 0, decisions: { human: 0, ai: 0 }, time: emptyTime() };
      nodes.set(nodeId, found);
    }
    return found;
  };
  // An executor node is one the template says runs an agent or script; without the template, one that ever started.
  const startedNodes = new Set(input.ticketEvents.filter((event) => event.type === 'node.started').map((event) => (event.data as { nodeId: string }).nodeId));
  const isExecutor = (nodeId: string): boolean => {
    const kind = input.nodeKinds?.[nodeId];
    return kind === undefined ? startedNodes.has(nodeId) : kind === 'agent' || kind === 'script';
  };
  const categoryOf = (nodeId: string, status: string): Category | undefined => {
    switch (status) {
      case 'queued':
        return 'queuedMs';
      case 'running':
        return 'runningMs';
      case 'review':
        return 'humanWaitMs';
      case 'rejected':
        // A rejected human task waits for the person; a rejected agent or script waits for a slot.
        return isExecutor(nodeId) ? 'queuedMs' : 'humanWaitMs';
      case 'paused':
        return 'pausedMs';
      default:
        return undefined;
    }
  };

  const tracks = new Map<string, ExecutionTrack>();
  const human: Interval[] = [];
  const running: Interval[] = [];
  const close = (track: ExecutionTrack, at: number): void => {
    if (!track.open) return;
    const category = categoryOf(track.nodeId, track.status);
    const to = Math.max(track.since, Math.min(at, asOf));
    if (category !== undefined && to > track.since) {
      node(track.nodeId).time[category] += to - track.since;
      if (category === 'humanWaitMs') human.push({ from: track.since, to });
      if (category === 'runningMs') running.push({ from: track.since, to });
    }
    track.since = to;
  };
  const move = (nodeId: string, run: number, status: string | undefined, at: number): void => {
    const track = tracks.get(`${nodeId}#${run}`);
    if (track === undefined) return;
    close(track, at);
    if (status === undefined) track.open = false;
    else track.status = status;
  };

  let createdAt = asOf;
  let completedAt: number | undefined;
  for (const event of input.ticketEvents) {
    const at = event.timestamp;
    switch (event.type) {
      case 'ticket.created':
        createdAt = at;
        break;
      case 'ticket.completed':
        completedAt = at;
        break;
      case 'node.activated': {
        const { nodeId, run, status, cause, supersedes } = event.data;
        if (supersedes !== undefined) move(nodeId, supersedes, undefined, at);
        tracks.set(`${nodeId}#${run}`, { nodeId, status, since: at, open: true });
        const stats = node(nodeId);
        stats.executions += 1;
        if (cause === 'rework' || cause === 'review' || cause === 'retry') stats.reworks += 1;
        break;
      }
      case 'node.started':
        node(event.data.nodeId).attempts += 1;
        move(event.data.nodeId, event.data.run, 'running', at);
        break;
      case 'node.reviewRequested':
        move(event.data.nodeId, event.data.run, 'review', at);
        break;
      case 'node.requeued':
        move(event.data.nodeId, event.data.run, 'queued', at);
        break;
      case 'node.paused':
        move(event.data.nodeId, event.data.run, 'paused', at);
        break;
      case 'node.resumed':
        move(event.data.nodeId, event.data.run, event.data.status, at);
        break;
      case 'node.returned':
        countDecision(node(event.data.nodeId), event);
        move(event.data.nodeId, event.data.run, undefined, at);
        break;
      case 'node.superseded':
        move(event.data.nodeId, event.data.run, undefined, at);
        break;
      case 'node.completed': {
        const stats = node(event.data.nodeId);
        if (event.data.status === 'failed') stats.failed += 1;
        countDecision(stats, event);
        move(event.data.nodeId, event.data.run, undefined, at);
        break;
      }
      default:
        break;
    }
  }
  const end = completedAt ?? asOf;
  for (const track of tracks.values()) close(track, end);

  // Agent runs: 'run' usage is the final total and replaces; 'turn' usage adds up (as the runs projection does).
  const runs = new Map<string, RunUsage>();
  for (const event of input.runEvents) {
    if (event.type === 'run.started') {
      if (event.data.ticketId !== input.ticketId) continue;
      runs.set(event.data.runId, { nodeId: event.data.nodeId, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: undefined, toolCalls: 0, toolErrors: 0, messages: 0 });
      continue;
    }
    const run = runs.get(event.aggregateId);
    if (run === undefined) continue;
    switch (event.type) {
      case 'run.usageRecorded': {
        const { tokens, cost, scope } = event.data;
        if (scope === 'run') {
          Object.assign(run, { input: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, output: tokens.output, reasoning: tokens.reasoning ?? 0 });
          if (cost !== undefined) run.costUsd = cost.usd;
        } else {
          run.input += tokens.input;
          run.cacheRead += tokens.cacheRead;
          run.cacheWrite += tokens.cacheWrite;
          run.output += tokens.output;
          run.reasoning += tokens.reasoning ?? 0;
          if (cost !== undefined) run.costUsd = (run.costUsd ?? 0) + cost.usd;
        }
        break;
      }
      case 'run.toolCallStarted':
        run.toolCalls += 1;
        break;
      case 'run.toolCallFinished':
        if (event.data.isError === true) run.toolErrors += 1;
        break;
      case 'run.messageRecorded':
        run.messages += 1;
        break;
      default:
        break;
    }
  }
  const usageByNode = new Map<string, UsageStats>();
  for (const run of runs.values()) {
    node(run.nodeId);
    usageByNode.set(run.nodeId, addUsage(usageByNode.get(run.nodeId) ?? emptyUsage(), run));
  }

  const nodeStats: NodeStats[] = [...nodes.values()].map((stats) => ({
    nodeId: stats.nodeId,
    executions: stats.executions,
    attempts: stats.attempts,
    failed: stats.failed,
    reworks: stats.reworks,
    decisions: stats.decisions,
    ...stats.time,
    ...(usageByNode.get(stats.nodeId) ?? emptyUsage()),
  }));
  const total = nodeStats.reduce<UsageStats>((sum, stats) => sumUsage(sum, stats), emptyUsage());
  let bottleneck: NodeStats | undefined;
  for (const stats of nodeStats) {
    if (bottleneck === undefined || stats.runningMs + stats.humanWaitMs > bottleneck.runningMs + bottleneck.humanWaitMs) bottleneck = stats;
  }
  return {
    ticketId: input.ticketId,
    status: completedAt === undefined ? 'open' : 'done',
    createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    totalMs: Math.max(0, end - createdAt),
    humanWaitMs: unionLength(human),
    activeMs: unionLength(running),
    ...total,
    nodes: nodeStats,
    ...(bottleneck === undefined || bottleneck.runningMs + bottleneck.humanWaitMs === 0 ? {} : { bottleneck: bottleneck.nodeId }),
    asOf,
  };
}

/** Decisions made by someone other than the engine: people (human) or AI (agent, unverified). */
function countDecision(stats: MutableNode, event: DomainEvent): void {
  if (event.actor.kind === 'human') stats.decisions.human += 1;
  else if (event.actor.kind === 'agent' || event.actor.kind === 'unverified') stats.decisions.ai += 1;
}

function emptyUsage(): UsageStats {
  return { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, agentRuns: 0, toolCalls: 0, toolErrors: 0, messages: 0 };
}

function addUsage(sum: UsageStats, run: RunUsage): UsageStats {
  return sumUsage(sum, {
    tokens: { input: run.input, cacheRead: run.cacheRead, cacheWrite: run.cacheWrite, output: run.output, reasoning: run.reasoning },
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
    agentRuns: 1,
    toolCalls: run.toolCalls,
    toolErrors: run.toolErrors,
    messages: run.messages,
  });
}

function sumUsage(a: UsageStats, b: UsageStats): UsageStats {
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
    },
    ...(cost === undefined ? {} : { costUsd: cost }),
    agentRuns: a.agentRuns + b.agentRuns,
    toolCalls: a.toolCalls + b.toolCalls,
    toolErrors: a.toolErrors + b.toolErrors,
    messages: a.messages + b.messages,
  };
}

/** Total length of the union of intervals (overlaps counted once). */
export function unionLength(intervals: readonly Interval[]): number {
  const sorted = [...intervals].filter((interval) => interval.to > interval.from).sort((a, b) => a.from - b.from);
  let total = 0;
  let current: Interval | undefined;
  for (const interval of sorted) {
    if (current === undefined || interval.from > current.to) {
      if (current !== undefined) total += current.to - current.from;
      current = { ...interval };
    } else if (interval.to > current.to) {
      current = { from: current.from, to: interval.to };
    }
  }
  if (current !== undefined) total += current.to - current.from;
  return total;
}
