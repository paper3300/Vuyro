import type { NodeStats, TicketStats } from '@vuyro/contracts';
import { useEffect, useState } from 'react';
import { stageHint } from '../board-model.ts';
import { causeLabel, formatDuration, formatTime, formatTokens, statusLabel, supersedeLabel } from '../format.ts';
import type { AgentRunRow, TicketDetail } from '../types.ts';
import { RunLog } from './RunLog.tsx';
import { ReviewCard } from './TicketDetail.tsx';
import { Chip, PlainText, statusTone } from './ui.tsx';

/**
 * A node of a ticket (시안 01 right panel): what waits for the person there, its time, tokens and tool calls, its
 * executions, and the log of each agent run (messages and tool calls, live).
 */
export function NodeDetail({ detail, stats, nodeId, onStale }: { detail: TicketDetail; stats: TicketStats | undefined; nodeId: string; onStale: (notice: string) => void }) {
  const node = detail.workflow?.nodes.find((each) => each.id === nodeId);
  const lanes = detail.lanes.filter((lane) => lane.nodeId === nodeId);
  const executions = detail.executions.filter((execution) => execution.nodeId === nodeId);
  const reviews = detail.reviews.filter((review) => review.nodeId === nodeId);
  const nodeStats = stats?.nodes.find((each) => each.nodeId === nodeId);
  const label = node?.label ?? nodeId;
  const statuses = lanes.length === 0 ? ['wait'] : [...new Set(lanes.map((lane) => lane.status))];

  return (
    <section aria-label={`노드 상세 ${label}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <span className="text-[12px] text-muted">선택한 노드</span>
        <h3 className="text-[17px] leading-snug font-bold">{label}</h3>
        <span className="text-[12px] text-muted">
          {node === undefined ? nodeId : `${stageHint(node).text} · ${node.type}@${String(node.typeVersion)}`}
        </span>
        <span className="flex flex-wrap gap-1">
          {statuses.map((status) => (
            <Chip key={status} tone={statusTone(status)}>
              {statusLabel(status)}
              {lanes.length > 1 ? ` ${String(lanes.filter((lane) => lane.status === status).length)}` : ''}
            </Chip>
          ))}
        </span>
      </header>
      {reviews.map((review) => (
        <ReviewCard key={`${review.nodeId}/${review.lane}/${String(review.run)}`} ticketId={detail.ticket.ticketId} review={review} workflow={detail.workflow} onStale={onStale} />
      ))}
      <NodeTiles stats={nodeStats} />
      <Executions executions={executions} />
      <AgentRuns runs={detail.runs.filter((run) => run.nodeId === nodeId)} />
    </section>
  );
}

function NodeTiles({ stats }: { stats: NodeStats | undefined }) {
  const tiles = [
    { label: '실행 시간', value: formatDuration(stats?.runningMs) },
    { label: '사람 대기', value: formatDuration(stats?.humanWaitMs) },
    {
      label: '토큰 입력/캐시/출력',
      value: stats === undefined || stats.agentRuns === 0 ? '—' : `${formatTokens(stats.tokens.input)}/${formatTokens(stats.tokens.cacheRead + stats.tokens.cacheWrite)}/${formatTokens(stats.tokens.output)}`,
    },
    { label: '도구 호출', value: stats === undefined || stats.agentRuns === 0 ? '—' : `${String(stats.toolCalls)}${stats.toolErrors > 0 ? ` (실패 ${String(stats.toolErrors)})` : ''}` },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border border-line bg-white px-2.5 py-1.5">
          <div className="text-[11px] text-muted">{tile.label}</div>
          <div className="truncate font-mono text-[13.5px] font-semibold" title={tile.value}>
            {tile.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function Executions({ executions }: { executions: TicketDetail['executions'] }) {
  if (executions.length === 0) return <p className="text-[12.5px] text-muted">아직 실행되지 않았습니다.</p>;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-[12px] font-semibold text-muted">실행 기록</h4>
      <ol className="flex flex-col gap-1 text-[12px]">
        {[...executions].reverse().map((execution) => (
          <li key={`${execution.lane}/${String(execution.run)}`} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-muted">#{execution.run}</span>
            {execution.lane !== 'main' && <span className="text-muted">레인 {execution.lane}</span>}
            <Chip tone={statusTone(execution.status)}>{statusLabel(execution.status)}</Chip>
            <span>{causeLabel(execution.cause)}</span>
            {execution.port !== null && <span className="font-mono">→ {execution.port}</span>}
            <span className="font-mono text-muted">{formatTime(execution.activatedAt)}</span>
            {supersedeLabel(execution.supersededBy) !== undefined && <span className="text-stale">{supersedeLabel(execution.supersededBy)}</span>}
            {execution.error !== null && <PlainText text={execution.error} className="w-full text-failed" />}
          </li>
        ))}
      </ol>
    </div>
  );
}

const RUN_STATUS: Readonly<Record<string, string>> = { running: '실행 중', succeeded: '성공', failed: '실패', abnormal_exit: '비정상 종료', cancelled: '취소됨' };

/** The node's agent runs, newest first; the chosen one's log below (the newest by default, following new runs). */
export function AgentRuns({ runs }: { runs: readonly AgentRunRow[] }) {
  const newest = runs.at(-1)?.runId;
  const [picked, setPicked] = useState<string>();
  const shown = runs.some((run) => run.runId === picked) ? picked : newest;
  // A new run starts: follow it unless the person picked an older one on purpose.
  useEffect(() => {
    setPicked(undefined);
  }, [newest]);
  if (runs.length === 0) return <p className="text-[12.5px] text-muted">이 노드에는 에이전트 실행 기록이 없습니다.</p>;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <h4 className="text-[12px] font-semibold text-muted">에이전트 실행 ({runs.length})</h4>
      <div role="tablist" aria-label="에이전트 실행" className="flex flex-wrap gap-1">
        {[...runs].reverse().map((run, index) => (
          <button
            key={run.runId}
            type="button"
            role="tab"
            aria-selected={run.runId === shown}
            onClick={() => { setPicked(run.runId); }}
            className={`rounded-md border px-2 py-0.5 text-[11.5px] ${run.runId === shown ? 'border-agent bg-agent/10 text-agent' : 'border-line bg-white text-muted hover:bg-chip'}`}
          >
            {runs.length - index}번째 · {run.provider}
            {run.model === null ? '' : ` ${run.model}`} · {RUN_STATUS[run.status] ?? run.status}
          </button>
        ))}
      </div>
      {shown !== undefined && <RunLog key={shown} runId={shown} />}
    </div>
  );
}
