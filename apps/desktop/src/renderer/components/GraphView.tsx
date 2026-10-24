import type { BoardTicketView } from '@vuyro/contracts';
import { useEffect, useState } from 'react';
import { byPriority, type Phase, ticketPhase, type Tone } from '../board-model.ts';
import { errorText, formatDuration, formatTokens, shortId } from '../format.ts';
import { useBoard, useTicket, useTicketStats } from '../queries.ts';
import { useUi } from '../store.ts';
import { NodeDetail } from './NodeDetail.tsx';
import { Button, ErrorNote, TONE_BAR } from './ui.tsx';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';

/**
 * The graph view (시안 01): the project's tickets on the left, the selected ticket's workflow on the canvas painted
 * live by its node states, and the clicked node's detail (decisions, numbers, executions, agent logs) on the right.
 * The ticket selection is the same as the board's, so switching views keeps it.
 */

const PHASE: Readonly<Record<Phase, { label: string; tone: Tone }>> = {
  review: { label: '사람 차례', tone: 'human' },
  running: { label: '실행 중', tone: 'agent' },
  blocked: { label: '막힘', tone: 'failed' },
  waiting: { label: '대기', tone: 'wait' },
  done: { label: '완료', tone: 'done' },
};

type Filter = 'open' | 'mine' | 'done' | 'all';
const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'open', label: '진행 중' },
  { key: 'mine', label: '내 차례' },
  { key: 'done', label: '완료' },
  { key: 'all', label: '전체' },
];

function matches(ticket: BoardTicketView, filter: Filter): boolean {
  const phase = ticketPhase(ticket);
  if (filter === 'open') return phase !== 'done';
  if (filter === 'mine') return phase === 'review';
  if (filter === 'done') return phase === 'done';
  return true;
}

export function GraphView({ projectId }: { projectId: string }) {
  const board = useBoard(projectId);
  const ticketId = useUi((state) => state.ticketId);
  const selectTicket = useUi((state) => state.selectTicket);
  const [filter, setFilter] = useState<Filter>('open');
  const tickets = [...(board.data?.tickets ?? [])].filter((ticket) => matches(ticket, filter) || ticket.ticketId === ticketId).sort(byPriority);

  // Nothing selected yet, or a remembered ticket that is gone: the first ticket of the list.
  const first = tickets[0]?.ticketId;
  const known = board.data === undefined || ticketId === undefined || board.data.tickets.some((ticket) => ticket.ticketId === ticketId);
  useEffect(() => {
    if ((ticketId === undefined || !known) && first !== undefined) selectTicket(first);
  }, [ticketId, known, first, selectTicket]);

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="티켓 목록" className="flex w-64 flex-none flex-col gap-3 overflow-y-auto border-r border-line bg-white px-3 py-4">
        <div className="flex items-center justify-between px-1.5">
          <span className="font-semibold">티켓</span>
          <span className="text-[12px] text-muted">{tickets.length}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 px-1.5">
          {FILTERS.map((each) => (
            <button
              key={each.key}
              type="button"
              aria-pressed={filter === each.key}
              onClick={() => { setFilter(each.key); }}
              className={`h-[26px] rounded-full border px-2.5 text-[12px] ${filter === each.key ? 'border-agent bg-agent/10 text-agent' : 'border-line text-muted hover:bg-chip'}`}
            >
              {each.label}
            </button>
          ))}
        </div>
        {board.error !== null && <ErrorNote error={errorText(board.error)} />}
        <ul className="flex flex-col gap-1">
          {tickets.map((ticket) => {
            const phase = PHASE[ticketPhase(ticket)];
            const chosen = ticket.ticketId === ticketId;
            return (
              <li key={ticket.ticketId}>
                <button
                  type="button"
                  aria-current={chosen ? 'true' : undefined}
                  onClick={() => { selectTicket(ticket.ticketId); }}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left ${chosen ? 'border-agent/40 bg-agent/5' : 'border-transparent hover:bg-chip'}`}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="font-mono text-[11px] text-muted">{shortId(ticket.ticketId)}</span>
                    <span className={`h-2 w-2 rounded-full ${TONE_BAR[phase.tone]}`} />
                  </span>
                  <span className="text-[13px] leading-snug font-medium">{ticket.title}</span>
                  <span className="text-[12px] text-muted">{phase.label}</span>
                </button>
              </li>
            );
          })}
          {tickets.length === 0 && board.data !== undefined && <li className="px-1.5 text-[12.5px] text-muted">티켓이 없습니다.</li>}
        </ul>
      </aside>
      {ticketId === undefined ? (
        <p className="flex-1 p-8 text-muted">왼쪽에서 티켓을 고르세요.</p>
      ) : (
        <TicketGraph key={ticketId} ticketId={ticketId} />
      )}
    </div>
  );
}

function TicketGraph({ ticketId }: { ticketId: string }) {
  const detail = useTicket(ticketId);
  const open = detail.data?.ticket.status === 'open';
  const stats = useTicketStats(ticketId, open);
  const nodeId = useUi((state) => state.nodeId);
  const selectNode = useUi((state) => state.selectNode);
  const openTicket = useUi((state) => state.openTicket);
  const [notice, setNotice] = useState<string>();
  if (detail.error !== null) return <div className="flex-1 p-6"><ErrorNote error={errorText(detail.error)} /></div>;
  if (detail.data === undefined) return <p className="flex-1 p-6 text-muted">불러오는 중…</p>;
  const { ticket, workflow } = detail.data;
  const tiles = [
    { label: '총 소요 시간', value: formatDuration(stats.data?.totalMs) },
    { label: '사람 대기', value: formatDuration(stats.data?.humanWaitMs) },
    { label: '토큰', value: stats.data === undefined ? '—' : formatTokens(stats.data.tokens.input + stats.data.tokens.cacheRead + stats.data.tokens.cacheWrite + stats.data.tokens.output) },
    { label: '도구 호출', value: stats.data === undefined ? '—' : `${String(stats.data.toolCalls)}회` },
  ];
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-[12px] text-muted">
              <span className="font-mono">{shortId(ticket.ticketId)}</span>
              <span className="rounded-full border border-line bg-white px-2 py-px">{workflow === undefined ? (ticket.template?.id ?? '템플릿 없음') : `${workflow.name} v${String(workflow.version)}`}</span>
            </span>
            <h2 className="text-[20px] leading-snug font-bold">{ticket.title}</h2>
          </div>
          <Button onClick={() => { openTicket(ticket.ticketId); }}>티켓 상세</Button>
        </header>
        <div className="grid grid-cols-4 gap-2.5">
          {tiles.map((tile) => (
            <div key={tile.label} className="rounded-xl border border-line bg-white px-3 py-2">
              <div className="text-[11.5px] text-muted">{tile.label}</div>
              <div className="font-mono text-[15px] font-semibold">{tile.value}</div>
            </div>
          ))}
        </div>
        {notice !== undefined && (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-human/30 bg-human/10 px-3 py-2 text-[13px] text-human">
            <span className="flex-1">{notice}</span>
            <Button small kind="ghost" onClick={() => { setNotice(undefined); }}>
              닫기
            </Button>
          </div>
        )}
        {workflow === undefined ? (
          <p className="rounded-lg bg-stale/10 px-3 py-2 text-[13px] text-stale">정의 파일이 바뀌어 이 티켓의 그래프를 그릴 수 없습니다.</p>
        ) : (
          <WorkflowCanvas workflow={workflow} lanes={detail.data.lanes} stats={stats.data?.nodes} selected={nodeId} onSelect={selectNode} height={440} label={`${ticket.title} 그래프`} />
        )}
        <Legend />
      </main>
      <aside aria-label="노드 상세 패널" className="flex w-[400px] flex-none flex-col gap-3 overflow-y-auto border-l border-line bg-canvas px-4 py-5">
        {nodeId === undefined ? (
          <p className="text-[13px] text-muted">그래프에서 노드를 누르면 상세(결정, 시간·토큰, 실행 기록, 에이전트 로그)가 보입니다.</p>
        ) : (
          <NodeDetail detail={detail.data} stats={stats.data} nodeId={nodeId} onStale={setNotice} />
        )}
      </aside>
    </>
  );
}

const LEGEND: readonly { label: string; tone: Tone }[] = [
  { label: '사람 차례', tone: 'human' },
  { label: '에이전트 실행', tone: 'agent' },
  { label: '완료', tone: 'done' },
  { label: '반려', tone: 'rejected' },
  { label: '실패', tone: 'failed' },
  { label: '대기', tone: 'wait' },
];

function Legend() {
  return (
    <div className="flex flex-wrap gap-3.5 text-[12px] text-muted">
      {LEGEND.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${TONE_BAR[entry.tone]}`} />
          {entry.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="w-5 border-t-2 border-dashed border-rejected" />
        반려 루프
      </span>
    </div>
  );
}
