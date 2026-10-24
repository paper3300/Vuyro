import { useQueryClient } from '@tanstack/react-query';
import type { SharedNodeView } from '@vuyro/contracts';
import { useState } from 'react';
import { execute } from '../api.ts';
import { errorText, formatTime, shortId } from '../format.ts';
import { useSharedNodes } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import { Button, Chip, ErrorNote } from './ui.tsx';
import type { Tone } from '../board-model.ts';

/**
 * Shared nodes of the project (M5, 명령·이벤트 계약 §15): state, why one is blocked and by which tickets, how many
 * requests wait, and the person's "풀기" (`sharedNode.unblock`). With `ticketId`, only the shared nodes that ticket waits
 * on or is blamed by.
 */

const STATUS: Readonly<Record<SharedNodeView['status'], { label: string; tone: Tone }>> = {
  idle: { label: '대기 중', tone: 'wait' },
  running: { label: '묶음 실행 중', tone: 'agent' },
  blocked: { label: '막힘', tone: 'failed' },
  waiting: { label: '보호 경로 대기', tone: 'paused' },
};

const BLOCK_REASON: Readonly<Record<string, string>> = {
  blamed: '빌드가 깨졌고 원인으로 추정한 티켓이 고쳐질 때까지 멈췄습니다.',
  interrupted: '묶음이 도는 중에 엔진이 멈춰 결과를 모릅니다. 확인한 뒤 풀어 주세요.',
};

export function involves(node: SharedNodeView, ticketId: string): boolean {
  return (
    node.queue.some((entry) => entry.ticketId === ticketId) ||
    node.running.some((batch) => batch.members.some((member) => member.ticketId === ticketId)) ||
    (node.blocked?.by.some((member) => member.ticketId === ticketId) ?? false)
  );
}

export function SharedNodes({ projectId, ticketId }: { projectId: string; ticketId?: string }) {
  const shared = useSharedNodes(projectId);
  const nodes = (shared.data ?? []).filter((node) => ticketId === undefined || involves(node, ticketId));
  if (nodes.length === 0) return null;
  return (
    <section aria-label="공유 노드" className="flex flex-col gap-2">
      <h3 className="font-bold">공유 노드</h3>
      {nodes.map((node) => (
        <SharedNodeCard key={node.name} node={node} ticketId={ticketId} />
      ))}
    </section>
  );
}

function SharedNodeCard({ node, ticketId }: { node: SharedNodeView; ticketId: string | undefined }) {
  const canWrite = useCanWrite();
  const openTicket = useUi((state) => state.openTicket);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = STATUS[node.status];
  const mine = ticketId === undefined ? undefined : node.queue.find((entry) => entry.ticketId === ticketId);
  const last = node.recent[0];
  const causes = [...new Set(node.blocked?.by.map((member) => member.ticketId) ?? [])];

  const unblock = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await execute('sharedNode.unblock', { projectId: node.projectId, name: node.name });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: ['sharedNodes', node.projectId] });
    }
  };

  return (
    <article aria-label={`공유 노드 ${node.label}`} className={`flex flex-col gap-2 rounded-xl border bg-white p-3 ${node.status === 'blocked' ? 'border-failed/40' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{node.label}</span>
        <span className="font-mono text-[11.5px] text-muted">{node.name}</span>
        <Chip tone={status.tone}>{status.label}</Chip>
        <span className="text-[12.5px] text-muted">대기 요청 {node.queue.length}건</span>
        {mine !== undefined && <span className="text-[12.5px] text-agent">이 티켓은 {mine.position}번째</span>}
        {node.running.length > 0 && <span className="text-[12.5px] text-muted">실행 중 묶음에 티켓 {node.running.reduce((sum, batch) => sum + batch.members.length, 0)}개</span>}
        <span className="flex-1" />
        {node.status === 'blocked' && (
          <Button small kind="primary" disabled={!canWrite || busy} title={canWrite ? undefined : '권한을 연결해야 풀 수 있습니다'} onClick={() => void unblock()}>
            풀기
          </Button>
        )}
      </div>
      {node.blocked !== undefined && (
        <div className="flex flex-col gap-1 rounded-md bg-failed/10 px-3 py-2 text-[13px]">
          <span className="text-failed">
            {BLOCK_REASON[node.blocked.reason] ?? node.blocked.reason} (묶음 #{node.blocked.batch})
          </span>
          {causes.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted">원인 티켓</span>
              {causes.map((cause) => (
                <button
                  key={cause}
                  type="button"
                  onClick={() => {
                    openTicket(cause);
                  }}
                  className="rounded-md border border-failed/30 bg-white px-1.5 font-mono text-[12px] text-failed hover:bg-failed/10"
                >
                  {shortId(cause)}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {last !== undefined && (
        <span className="text-[12px] text-muted">
          최근 묶음 #{last.batch}: {last.outcome === 'succeeded' ? '성공' : last.outcome === 'failed' ? '실패' : last.outcome === 'interrupted' ? '중단' : '진행 중'} · {formatTime(last.finishedAt ?? last.startedAt)}
          {last.errorFiles !== undefined && last.errorFiles.length > 0 ? ` · 오류 파일 ${last.errorFiles.slice(0, 3).join(', ')}` : ''}
        </span>
      )}
      <ErrorNote error={error} />
    </article>
  );
}
