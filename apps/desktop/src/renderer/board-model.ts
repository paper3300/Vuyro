import type { BoardTicketView, WorkflowNodeView, WorkflowView } from '@vuyro/contracts';

/**
 * How the board reads tickets (시안 02 칸반 보드): columns are the stages of one template, left to right like its graph,
 * and a ticket sits where its earliest unfinished work is (that is what holds it up). With every template at once
 * the columns are the ticket's state instead. Pure functions, so the component tests stay about the screen.
 */

/** Lane statuses where someone (an executor or a person) still has something to do. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'review', 'failed', 'paused', 'rejected', 'stale']);

export type Tone = 'done' | 'agent' | 'human' | 'rejected' | 'stale' | 'wait' | 'failed' | 'paused';

export interface Column {
  readonly key: string;
  readonly title: string;
  /** How the stage finishes (사람 승인, 자동 · 병렬, …) or what the state means. */
  readonly hint: string;
  readonly hintTone: Tone;
  readonly tickets: readonly BoardTicketView[];
}

export function workflowKey(template: BoardTicketView['template']): string | undefined {
  return template === null ? undefined : `${template.id}@${template.version}`;
}

/** Higher priority first, then older first (the order claims are granted in, D-034). */
export function byPriority(a: BoardTicketView, b: BoardTicketView): number {
  return b.priority - a.priority || a.createdAt - b.createdAt || a.ticketId.localeCompare(b.ticketId);
}

/** How a node finishes, in a planner's words. */
export function stageHint(node: WorkflowNodeView): { text: string; tone: Tone } {
  const parallel = node.inputMode === 'each' ? ' · 병렬' : '';
  switch (node.completion) {
    case 'human': {
      const approval = node.outputs.some((port) => port.name === 'approve') && node.outputs.some((port) => port.name === 'reject');
      return { text: approval ? '사람 승인' : '사람 완료 처리', tone: 'human' };
    }
    case 'agent':
      return { text: node.review === 'human' ? `AI + 사람 확인${parallel}` : `자동${parallel}`, tone: node.review === 'human' ? 'human' : 'agent' };
    case 'script':
      return { text: `스크립트${parallel}`, tone: 'agent' };
    case 'join':
      return { text: node.outputs.length === 0 ? '끝' : '합류', tone: 'done' };
    case 'shared':
      return { text: '공유 노드', tone: 'agent' };
    default:
      return { text: node.completion, tone: 'wait' };
  }
}

/** Where a ticket sits on a template's board: the node id of its column. */
export function ticketStage(ticket: BoardTicketView, workflow: WorkflowView): string | undefined {
  const order = new Map(workflow.nodes.map((node, index) => [node.id, index]));
  const last = workflow.nodes.at(-1)?.id;
  if (ticket.status === 'done') return last;
  let earliestActive: { id: string; index: number } | undefined;
  let furthest: { id: string; index: number } | undefined;
  for (const lane of ticket.lanes) {
    const index = order.get(lane.nodeId);
    if (index === undefined) continue;
    if (ACTIVE_STATUSES.has(lane.status) && (earliestActive === undefined || index < earliestActive.index)) earliestActive = { id: lane.nodeId, index };
    if (furthest === undefined || index > furthest.index) furthest = { id: lane.nodeId, index };
  }
  return earliestActive?.id ?? furthest?.id ?? workflow.nodes[0]?.id;
}

export function stageColumns(workflow: WorkflowView, tickets: readonly BoardTicketView[]): Column[] {
  const byStage = new Map<string, BoardTicketView[]>(workflow.nodes.map((node) => [node.id, []]));
  for (const ticket of tickets) {
    const stage = ticketStage(ticket, workflow);
    if (stage !== undefined) byStage.get(stage)?.push(ticket);
  }
  return workflow.nodes.map((node) => {
    const hint = stageHint(node);
    return { key: node.id, title: node.label, hint: hint.text, hintTone: hint.tone, tickets: [...(byStage.get(node.id) ?? [])].sort(byPriority) };
  });
}

export type Phase = 'review' | 'running' | 'blocked' | 'waiting' | 'done';

/** A ticket's state as one word, for the board across all templates. */
export function ticketPhase(ticket: BoardTicketView): Phase {
  if (ticket.status === 'done') return 'done';
  const statuses = new Set(ticket.lanes.map((lane) => lane.status));
  if (statuses.has('review')) return 'review';
  if (ticket.attention !== null || statuses.has('failed') || statuses.has('paused') || statuses.has('stale')) return 'blocked';
  if (statuses.has('running') || statuses.has('queued') || statuses.has('rejected')) return 'running';
  return 'waiting';
}

const PHASES: readonly { key: Phase; title: string; hint: string; tone: Tone }[] = [
  { key: 'review', title: '사람 차례', hint: '승인·작업 대기', tone: 'human' },
  { key: 'running', title: '실행 중', hint: '에이전트·스크립트', tone: 'agent' },
  { key: 'blocked', title: '막힘', hint: '실패·일시정지', tone: 'rejected' },
  { key: 'waiting', title: '대기', hint: '다음 단계 대기', tone: 'wait' },
  { key: 'done', title: '완료', hint: '끝난 티켓', tone: 'done' },
];

export function statusColumns(tickets: readonly BoardTicketView[]): Column[] {
  return PHASES.map((phase) => ({
    key: phase.key,
    title: phase.title,
    hint: phase.hint,
    hintTone: phase.tone,
    tickets: tickets.filter((ticket) => ticketPhase(ticket) === phase.key).sort(byPriority),
  }));
}

/** One tone for a node from its lanes (the worst state wins: a person or a failure needs looking at first). */
export function laneTone(statuses: readonly string[], node?: WorkflowNodeView): Tone {
  if (statuses.length === 0) return 'wait';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('review')) return 'human';
  if (statuses.includes('rejected')) return 'rejected';
  if (statuses.includes('paused')) return 'paused';
  if (statuses.includes('stale')) return 'stale';
  if (statuses.includes('running') || statuses.includes('queued')) return node?.completion === 'human' ? 'human' : 'agent';
  return 'done';
}

/** The progress bar on a card: one segment per stage. */
export function segments(ticket: BoardTicketView, workflow: WorkflowView): { nodeId: string; label: string; tone: Tone }[] {
  return workflow.nodes.map((node) => {
    const statuses = ticket.lanes.filter((lane) => lane.nodeId === node.id).map((lane) => lane.status);
    return { nodeId: node.id, label: node.label, tone: ticket.status === 'done' && statuses.length === 0 ? 'wait' : laneTone(statuses, node) };
  });
}

/** What a card says about the person: approve something, or do something. */
export function personBadge(ticket: BoardTicketView, workflow: WorkflowView | undefined): string | undefined {
  const reviewing = ticket.lanes.filter((lane) => lane.status === 'review');
  if (reviewing.length === 0) return undefined;
  const tasks = reviewing.every((lane) => {
    const node = workflow?.nodes.find((each) => each.id === lane.nodeId);
    return node !== undefined && node.completion === 'human' && stageHint(node).text === '사람 완료 처리';
  });
  return tasks ? '내 작업 필요' : '내 승인 필요';
}

export function boardSummary(tickets: readonly BoardTicketView[]): { approvals: number; running: number; tokens: number } {
  let approvals = 0;
  let running = 0;
  let tokens = 0;
  for (const ticket of tickets) {
    if (ticket.lanes.some((lane) => lane.status === 'review')) approvals += 1;
    running += ticket.lanes.filter((lane) => lane.status === 'running').length;
    tokens += ticket.tokens.input + ticket.tokens.cacheRead + ticket.tokens.cacheWrite + ticket.tokens.output;
  }
  return { approvals, running, tokens };
}

const PRIORITY_MIN = -1000;
const PRIORITY_MAX = 1000;

/**
 * The priority that puts a dragged card between its new neighbours (cards are ordered by priority, higher first).
 * `ordered` is the column as shown, `from`/`to` are indexes in it. Undefined when nothing changes.
 */
export function priorityForMove(ordered: readonly BoardTicketView[], from: number, to: number): number | undefined {
  if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) return undefined;
  const rest = ordered.filter((_, index) => index !== from);
  const above = rest[to - 1];
  const below = rest[to];
  let next: number;
  if (above === undefined && below !== undefined) next = below.priority + 1;
  else if (below === undefined && above !== undefined) next = above.priority - 1;
  else if (above !== undefined && below !== undefined) next = above.priority - below.priority >= 2 ? Math.floor((above.priority + below.priority) / 2) : above.priority;
  else return undefined;
  const clamped = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, next));
  return clamped === ordered[from]?.priority ? undefined : clamped;
}
