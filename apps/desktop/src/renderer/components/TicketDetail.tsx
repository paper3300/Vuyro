import { useQueryClient } from '@tanstack/react-query';
import type { ItemView, NodeStats, ReviewView, TicketStats, WorkflowView } from '@vuyro/contracts';
import { useEffect, useState } from 'react';
import { ApiError, execute } from '../api.ts';
import { stageHint } from '../board-model.ts';
import { causeLabel, errorText, formatDuration, formatTime, formatTokens, shortId, statusLabel, supersedeLabel } from '../format.ts';
import { useArtifacts, useTicket, useTicketStats } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import type { ExecutionRow, LaneRow, TicketDetail as Detail, WaitReason } from '../types.ts';
import { SharedNodes } from './SharedNodes.tsx';
import { Button, Chip, ErrorNote, JsonBlock, PlainText, statusTone } from './ui.tsx';

/**
 * One ticket: what waits for the person (approve, reject, finish a task), what holds it up, and per node the time,
 * tokens (input / cache / output) and tool calls; for the ticket the total time, the time spent waiting for people
 * and the bottleneck node (PRD 성공 기준). Every button sends a command; the screen updates from the events.
 */
export function TicketDrawer() {
  const ticketId = useUi((state) => state.ticketId);
  const openTicket = useUi((state) => state.openTicket);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openTicket(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [openTicket]);
  if (ticketId === undefined) return null;
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-ink/20" onMouseDown={(event) => {
        if (event.target === event.currentTarget) openTicket(undefined);
      }}>
      <aside aria-label="티켓 상세" className="flex h-full w-[min(880px,92vw)] flex-col overflow-y-auto border-l border-line bg-canvas shadow-2xl">
        <TicketDetailView
          ticketId={ticketId}
          onClose={() => {
            openTicket(undefined);
          }}
        />
      </aside>
    </div>
  );
}

export function TicketDetailView({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const detail = useTicket(ticketId);
  const open = detail.data?.ticket.status === 'open';
  const stats = useTicketStats(ticketId, open);
  const [notice, setNotice] = useState<string>();
  if (detail.error !== null) return <div className="p-6"><ErrorNote error={errorText(detail.error)} /></div>;
  if (detail.data === undefined) return <p className="p-6 text-muted">불러오는 중…</p>;
  const data = detail.data;
  const { ticket, workflow } = data;
  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <span className="font-mono">{shortId(ticket.ticketId)}</span>
            <span>·</span>
            <span>{workflow?.name ?? ticket.template?.id ?? '템플릿 없음'}</span>
            {ticket.priority !== 0 && <span>· 우선순위 {ticket.priority > 0 ? `+${ticket.priority}` : ticket.priority}</span>}
          </div>
          <h2 className="mt-1 text-[20px] leading-snug font-bold">{ticket.title}</h2>
          {ticket.description !== null && <PlainText text={ticket.description} className="mt-1.5 text-muted" />}
        </div>
        <Chip tone={ticket.status === 'done' ? 'done' : ticket.attention !== null ? 'stale' : 'agent'}>{ticket.status === 'done' ? '완료' : ticket.attention !== null ? '주의 필요' : '진행 중'}</Chip>
        <Button kind="ghost" small onClick={onClose} title="닫기 (Esc)">
          ✕
        </Button>
      </header>
      <StatsSummary stats={stats.data} workflow={workflow} />
      {notice !== undefined && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-human/30 bg-human/10 px-3 py-2 text-[13px] text-human">
          <span className="flex-1">{notice}</span>
          <Button
            small
            kind="ghost"
            onClick={() => {
              setNotice(undefined);
            }}
          >
            닫기
          </Button>
        </div>
      )}
      <SharedNodes projectId={ticket.projectId} ticketId={ticket.ticketId} />
      <Reviews detail={data} onStale={setNotice} />
      <Holdups detail={data} onStale={setNotice} />
      <NodeTable detail={data} stats={stats.data} />
      <Artifacts ticketId={ticketId} workflow={workflow} />
    </div>
  );
}

function nodeLabel(workflow: WorkflowView | undefined, nodeId: string): string {
  return workflow?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

function laneName(lane: string): string {
  return lane === 'main' ? '' : ` · 레인 ${lane}`;
}

function StatsSummary({ stats, workflow }: { stats: TicketStats | undefined; workflow: WorkflowView | undefined }) {
  const tiles: { label: string; value: string; hint?: string; tone?: string }[] = [
    { label: '총 소요 시간', value: formatDuration(stats?.totalMs), hint: '생성부터 완료(또는 지금)까지' },
    { label: '사람 대기 시간', value: formatDuration(stats?.humanWaitMs), hint: '누군가 사람을 기다린 시간(겹친 시간은 한 번)', tone: 'text-human' },
    { label: '실행 시간', value: formatDuration(stats?.activeMs), hint: '에이전트·스크립트가 하나라도 돈 시간', tone: 'text-agent' },
    {
      label: '토큰 입력 / 캐시 / 출력',
      value: stats === undefined ? '—' : `${formatTokens(stats.tokens.input)}/${formatTokens(stats.tokens.cacheRead + stats.tokens.cacheWrite)}/${formatTokens(stats.tokens.output)}`,
      hint: '캐시 = 캐시 읽기 + 캐시 쓰기',
    },
    { label: '병목 노드', value: stats?.bottleneck === undefined ? '—' : nodeLabel(workflow, stats.bottleneck), hint: '실행 + 사람 대기가 가장 긴 노드', tone: 'text-rejected' },
  ];
  return (
    <section aria-label="티켓 통계" className="grid grid-cols-5 gap-2.5">
      {tiles.map((tile) => (
        <div key={tile.label} title={tile.hint} className="rounded-xl border border-line bg-white px-3 py-2.5">
          <div className="text-[11.5px] text-muted">{tile.label}</div>
          <div className={`mt-0.5 truncate font-mono text-[14px] font-semibold ${tile.tone ?? ''}`} title={tile.value}>
            {tile.value}
          </div>
        </div>
      ))}
      {stats?.costUsd !== undefined && <p className="col-span-5 text-[11.5px] text-muted">정가 기준 추정 금액(Claude만, 청구액 아님): ${stats.costUsd.toFixed(2)}</p>}
    </section>
  );
}

function Reviews({ detail, onStale }: { detail: Detail; onStale: (notice: string) => void }) {
  if (detail.reviews.length === 0) return null;
  return (
    <section aria-label="사람 차례" className="flex flex-col gap-3">
      <h3 className="font-bold text-human">지금 사람 차례 ({detail.reviews.length})</h3>
      {detail.reviews.map((review) => (
        <ReviewCard key={`${review.nodeId}/${review.lane}/${review.run}`} ticketId={detail.ticket.ticketId} review={review} workflow={detail.workflow} onStale={onStale} />
      ))}
    </section>
  );
}

/** Shown above the detail when a decision was refused because the screen was behind (the card it came from is gone). */
export const STALE_NOTICE = '그 사이 다른 실행으로 바뀌어 반영하지 않았습니다. 화면을 새로 고쳤으니 다시 확인하세요.';

/**
 * Sends a person's command. Commands carry the execution the screen showed (`run`); when the engine refuses because
 * the lane moved on (`revision_conflict`), the ticket is fetched again and the person is told.
 */
function useCommand(ticketId: string, onStale: (notice: string) => void) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (type: string, payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await execute(type, payload);
      await client.invalidateQueries({ queryKey: ['ticket', ticketId] });
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'revision_conflict') onStale(STALE_NOTICE);
      else setError(errorText(failure));
      await client.invalidateQueries({ queryKey: ['ticket', ticketId] });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function ReviewCard({ ticketId, review, workflow, onStale }: { ticketId: string; review: ReviewView; workflow: WorkflowView | undefined; onStale: (notice: string) => void }) {
  const canWrite = useCanWrite();
  const { busy, error, run } = useCommand(ticketId, onStale);
  const [text, setText] = useState('');
  const node = workflow?.nodes.find((each) => each.id === review.nodeId);
  const target = { ticketId, nodeId: review.nodeId, lane: review.lane, run: review.run };
  const comment = text.trim() === '' ? {} : { comment: text.trim() };
  const disabled = !canWrite || busy;
  const why = canWrite ? undefined : '권한을 연결해야 할 수 있습니다';
  const kindText = review.kind === 'approval' ? '승인' : review.kind === 'task' ? '사람 작업' : '결과 확인';

  return (
    <article aria-label={`${nodeLabel(workflow, review.nodeId)} ${kindText}`} className="flex flex-col gap-3 rounded-xl border border-[#e7b98a] bg-white p-4">
      <div className="flex items-center gap-2">
        <span className="font-bold">
          {nodeLabel(workflow, review.nodeId)}
          {laneName(review.lane)}
        </span>
        <Chip tone="human">{kindText}</Chip>
        {node !== undefined && <span className="text-[12px] text-muted">{stageHint(node).text}</span>}
      </div>
      {review.feedback !== undefined && (
        <div className="rounded-md bg-rejected/10 px-3 py-2 text-[13px]">
          <b className="text-rejected">지난 반려 의견</b>
          <PlainText text={review.feedback} />
        </div>
      )}
      {review.kind === 'gate' && review.output !== undefined && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] text-muted">
            결과 포트 <b className="font-mono text-ink">{review.output.port}</b> · 아이템 {review.output.items.length}개
          </div>
          {review.reason === 'empty' && <p className="text-[13px] text-human">이 결과는 다음 노드로 보낼 아이템이 없습니다. 승인하면 빈 결과로 넘어갑니다.</p>}
          {review.merge !== undefined && <JsonBlock value={review.merge} />}
          <Items items={review.output.items} />
        </div>
      )}
      {review.kind !== 'gate' && (review.inputs?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] text-muted">받은 입력</div>
          <Items items={review.inputs ?? []} />
        </div>
      )}
      <textarea
        aria-label={review.kind === 'task' ? '요약' : '의견'}
        value={text}
        rows={review.kind === 'task' ? 4 : 2}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={review.kind === 'task' ? '한 일과 요점을 적으세요 (다음 노드가 읽습니다)' : '의견 (선택, 반려할 때는 무엇을 고칠지)'}
        className="rounded-lg border border-[#d5d9e0] px-3 py-2 outline-none focus:border-agent"
      />
      <ErrorNote error={error} />
      <div className="flex flex-wrap justify-end gap-2">
        {review.kind === 'task' ? (
          (node?.outputs ?? [{ name: 'done', label: 'Done' }]).map((port) => (
            <Button
              key={port.name}
              kind={port.name === 'error' ? 'danger' : 'primary'}
              disabled={disabled}
              title={why}
              onClick={() => {
                void run('node.done', { ...target, port: port.name, ...(text.trim() === '' ? {} : { summary: text.trim() }) })
                  .then((ok) => {
                    if (ok) setText('');
                  });
              }}
            >
              {port.name === 'done' ? '완료' : port.name === 'error' ? '못 함' : (port.label ?? port.name)}
            </Button>
          ))
        ) : (
          <>
            <Button
              kind="danger"
              disabled={disabled}
              title={why}
              onClick={() => {
                void run('node.reject', { ...target, ...comment }).then((ok) => {
                  if (ok) setText('');
                });
              }}
            >
              {review.kind === 'gate' ? '반려 (다시 실행)' : '반려'}
            </Button>
            <Button
              kind="primary"
              disabled={disabled}
              title={why}
              onClick={() => {
                void run('node.approve', { ...target, ...comment }).then((ok) => {
                  if (ok) setText('');
                });
              }}
            >
              승인
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function Items({ items }: { items: readonly ItemView[] }) {
  if (items.length === 0) return <p className="text-[12.5px] text-muted">(아이템 없음)</p>;
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, index) => (
        // Items have no ids; their order is their identity within one output.
        <li key={index} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
          {items.length > 1 && <span className="text-[11.5px] text-muted">아이템 {index + 1}</span>}
          {item.summary !== undefined && <PlainText text={item.summary} />}
          {item.data !== undefined && <JsonBlock value={item.data} />}
          {item.artifacts !== undefined && (
            <ul className="flex flex-col gap-0.5 text-[12.5px]">
              {Object.entries(item.artifacts).map(([slot, ref]) => (
                <li key={slot} className="font-mono break-all">
                  <b>{slot}</b> · {ref.kind} · {ref.uri}
                  {ref.version === undefined ? '' : ` @ ${ref.version}`}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

const WAIT_TEXT: Readonly<Record<WaitReason['kind'], string>> = {
  active: '진행 중',
  failed: '실패해서 멈춤',
  stale: '결과가 낡아 아무 데도 가지 않음',
  attention: '이전 형식의 기록이 있어 이어서 처리하지 않음',
};

/** What holds the ticket up besides people: failures, stale results, pauses and claims, with what to press. */
function Holdups({ detail, onStale }: { detail: Detail; onStale: (notice: string) => void }) {
  const canWrite = useCanWrite();
  const { busy, error, run } = useCommand(detail.ticket.ticketId, onStale);
  const reasons = (detail.waitingFor ?? []).filter((reason) => reason.status !== 'review');
  const lanes = new Map(detail.lanes.map((lane) => [`${lane.nodeId}/${lane.lane}`, lane]));
  if (detail.ticket.status !== 'open') return null;
  if (detail.waitingFor === undefined) {
    return <p className="rounded-lg bg-stale/10 px-3 py-2 text-[13px] text-stale">정의 파일이 바뀌어 대기 사유를 계산할 수 없습니다. 정의를 되돌리거나 새 버전으로 저장하세요.</p>;
  }
  if (reasons.length === 0) return null;
  return (
    <section aria-label="대기 사유" className="flex flex-col gap-2">
      <h3 className="font-bold">대기 사유</h3>
      <ErrorNote error={error} />
      <ul className="flex flex-col gap-1.5">
        {reasons.map((reason) => {
          const lane = lanes.get(`${reason.nodeId}/${reason.lane}`);
          const target = { ticketId: detail.ticket.ticketId, nodeId: reason.nodeId, lane: reason.lane, run: reason.run };
          return (
            <li key={`${reason.nodeId}/${reason.lane}/${reason.run}`} className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
              <span className="font-semibold">
                {nodeLabel(detail.workflow, reason.nodeId)}
                {laneName(reason.lane)}
              </span>
              <Chip tone={statusTone(reason.status)}>{statusLabel(reason.status)}</Chip>
              <span className="flex-1 text-[12.5px] text-muted">
                {reason.kind === 'active' ? waitText(lane) : WAIT_TEXT[reason.kind]}
              </span>
              {(reason.kind === 'failed' || reason.kind === 'stale') && (
                <Button small disabled={!canWrite || busy} onClick={() => void run('node.retry', target)}>
                  다시 시도
                </Button>
              )}
              {reason.status === 'running' && lane?.executor === 'agent' && (
                <Button small disabled={!canWrite || busy || lane.pauseRequested === 1} onClick={() => void run('node.pause', target)}>
                  일시정지
                </Button>
              )}
              {reason.status === 'paused' && (
                <Button small disabled={!canWrite || busy} onClick={() => void run('node.resume', target)}>
                  재개
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function waitText(lane: LaneRow | undefined): string {
  if (lane === undefined) return WAIT_TEXT.active;
  if (lane.status === 'queued') return '실행 슬롯을 기다림';
  if (lane.status === 'running') return lane.pauseRequested === 1 ? '일시정지 요청됨' : `${lane.executor === 'script' ? '스크립트' : lane.executor === 'merge' ? '머지' : '에이전트'} 실행 중`;
  if (lane.status === 'paused') {
    if (lane.waitingFor !== null && typeof lane.waitingFor === 'object') return `다른 티켓이 쥔 파일을 기다림: ${claimText(lane.waitingFor)}`;
    return '사람이 일시정지함';
  }
  if (lane.status === 'rejected') return '반려되어 다시 시작을 기다림';
  return WAIT_TEXT.active;
}

function claimText(claim: object): string {
  const paths = (claim as { paths?: unknown }).paths;
  if (Array.isArray(paths)) return paths.slice(0, 3).map(String).join(', ') + (paths.length > 3 ? ` 외 ${paths.length - 3}개` : '');
  return JSON.stringify(claim).slice(0, 160);
}

/** Every node of the workflow in stage order, with its time, tokens and tool calls; history on demand. */
function NodeTable({ detail, stats }: { detail: Detail; stats: TicketStats | undefined }) {
  const nodes = detail.workflow?.nodes.map((node) => ({ id: node.id, label: node.label })) ?? [...new Set(detail.lanes.map((lane) => lane.nodeId))].map((id) => ({ id, label: id }));
  const byNode = new Map((stats?.nodes ?? []).map((node) => [node.nodeId, node]));
  return (
    <section aria-label="노드" className="flex flex-col gap-2">
      <h3 className="font-bold">노드</h3>
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-chip text-left text-[11.5px] text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">노드</th>
              <th className="px-3 py-2 font-semibold">상태</th>
              <th className="px-3 py-2 text-right font-semibold">실행</th>
              <th className="px-3 py-2 text-right font-semibold">사람 대기</th>
              <th className="px-3 py-2 text-right font-semibold" title="입력 / 캐시(읽기+쓰기) / 출력">
                토큰 입력 / 캐시 / 출력
              </th>
              <th className="px-3 py-2 text-right font-semibold">도구 호출</th>
              <th className="px-3 py-2 text-right font-semibold">실행 횟수</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <NodeRow key={node.id} label={node.label} lanes={detail.lanes.filter((lane) => lane.nodeId === node.id)} executions={detail.executions.filter((execution) => execution.nodeId === node.id)} stats={byNode.get(node.id)} bottleneck={stats?.bottleneck === node.id} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NodeRow({ label, lanes, executions, stats, bottleneck }: { label: string; lanes: readonly LaneRow[]; executions: readonly ExecutionRow[]; stats: NodeStats | undefined; bottleneck: boolean }) {
  const [open, setOpen] = useState(false);
  const statuses = lanes.length === 0 ? ['wait'] : [...new Set(lanes.map((lane) => lane.status))];
  return (
    <>
      <tr className={`border-t border-line ${bottleneck ? 'bg-rejected/5' : ''}`}>
        <td className="px-3 py-2">
          <button
            type="button"
            aria-expanded={open}
            disabled={executions.length === 0}
            onClick={() => {
              setOpen(!open);
            }}
            className="flex items-center gap-1.5 font-semibold disabled:cursor-default"
          >
            <span className="w-3 text-muted">{executions.length === 0 ? '' : open ? '▾' : '▸'}</span>
            {label}
            {bottleneck && <Chip tone="rejected">병목</Chip>}
          </button>
        </td>
        <td className="px-3 py-2">
          <span className="flex flex-wrap gap-1">
            {statuses.map((status) => (
              <Chip key={status} tone={statusTone(status)}>
                {statusLabel(status)}
                {lanes.length > 1 ? ` ${lanes.filter((lane) => lane.status === status).length}` : ''}
              </Chip>
            ))}
          </span>
        </td>
        <td className="px-3 py-2 text-right font-mono">{stats === undefined ? '—' : formatDuration(stats.runningMs)}</td>
        <td className="px-3 py-2 text-right font-mono text-human">{stats === undefined ? '—' : formatDuration(stats.humanWaitMs)}</td>
        <td className="px-3 py-2 text-right font-mono">{stats === undefined || stats.agentRuns === 0 ? '—' : `${formatTokens(stats.tokens.input)} / ${formatTokens(stats.tokens.cacheRead + stats.tokens.cacheWrite)} / ${formatTokens(stats.tokens.output)}`}</td>
        <td className="px-3 py-2 text-right font-mono">{stats === undefined || stats.agentRuns === 0 ? '—' : `${stats.toolCalls}${stats.toolErrors > 0 ? ` (실패 ${stats.toolErrors})` : ''}`}</td>
        <td className="px-3 py-2 text-right font-mono">{stats === undefined ? executions.length : `${stats.executions}${stats.reworks > 0 ? ` (재작업 ${stats.reworks})` : ''}`}</td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-canvas">
          <td colSpan={7} className="px-4 py-2">
            <ol aria-label={`${label} 실행 기록`} className="flex flex-col gap-1 text-[12.5px]">
              {executions.map((execution) => (
                <li key={execution.run} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-muted">#{execution.run}</span>
                  {execution.lane !== 'main' && <span className="text-muted">레인 {execution.lane}</span>}
                  <Chip tone={statusTone(execution.status)}>{statusLabel(execution.status)}</Chip>
                  <span>{causeLabel(execution.cause)}</span>
                  {execution.port !== null && <span className="font-mono">→ {execution.port}</span>}
                  <span className="font-mono text-muted">
                    {formatTime(execution.activatedAt)}
                    {execution.finishedAt === null ? '' : ` ~ ${formatTime(execution.finishedAt)}`}
                  </span>
                  {supersedeLabel(execution.supersededBy) !== undefined && <span className="text-stale">{supersedeLabel(execution.supersededBy)}</span>}
                  {execution.error !== null && <PlainText text={execution.error} className="w-full text-failed" />}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

function Artifacts({ ticketId, workflow }: { ticketId: string; workflow: WorkflowView | undefined }) {
  const artifacts = useArtifacts(ticketId);
  const current = (artifacts.data ?? []).filter((artifact) => artifact.current);
  if (current.length === 0) return null;
  return (
    <section aria-label="산출물" className="flex flex-col gap-2">
      <h3 className="font-bold">산출물</h3>
      <ul className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3 text-[12.5px]">
        {current.map((artifact) => (
          <li key={artifact.sequence} className="font-mono break-all">
            <b>{nodeLabel(workflow, artifact.nodeId)}</b> · {artifact.slot} · {artifact.kind} · {artifact.uri}
            {artifact.version === null ? '' : ` @ ${artifact.version}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
