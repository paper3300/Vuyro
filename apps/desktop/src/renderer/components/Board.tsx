import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardResult, BoardTicketView, WorkflowView } from '@vuyro/contracts';
import { useMemo, useState } from 'react';
import { execute } from '../api.ts';
import { boardSummary, type Column, laneTone, personBadge, priorityForMove, segments, stageColumns, statusColumns, workflowKey } from '../board-model.ts';
import { errorText, formatDuration, formatTokens, shortId, statusLabel, totalTokens } from '../format.ts';
import { useBoard } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import { NewTicketDialog } from './NewTicketDialog.tsx';
import { Button, Chip, ErrorNote, TONE_BAR, statusTone } from './ui.tsx';

/** "All templates" in the filter: columns become the ticket's state. */
export const ALL_TEMPLATES = '*';

/** The template most of the project's tickets use (the board opens on it). */
function defaultFilter(board: BoardResult): string {
  const counts = new Map<string, number>();
  for (const ticket of board.tickets) {
    const key = workflowKey(ticket.template);
    if (key !== undefined && Object.hasOwn(board.workflows, key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? ALL_TEMPLATES;
}

export function Board({ projectId }: { projectId: string }) {
  const board = useBoard(projectId);
  const [filter, setFilter] = useState<string>();
  const [creating, setCreating] = useState(false);
  const canWrite = useCanWrite();
  const data = board.data;
  const chosen = filter ?? (data === undefined ? ALL_TEMPLATES : defaultFilter(data));
  const workflow = chosen === ALL_TEMPLATES ? undefined : data?.workflows[chosen];
  const shown = useMemo(() => (data === undefined ? [] : workflow === undefined ? data.tickets : data.tickets.filter((ticket) => workflowKey(ticket.template) === chosen)), [data, workflow, chosen]);
  const columns = workflow === undefined ? statusColumns(shown) : stageColumns(workflow, shown);
  const summary = boardSummary(data?.tickets ?? []);
  const hidden = (data?.tickets.length ?? 0) - shown.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none flex-wrap items-center gap-6 px-7 pt-3.5 text-[13px] text-muted">
        <span>
          <b className="text-human">사람 차례 {summary.approvals}건</b> 대기 중
        </span>
        <span>
          실행 중 에이전트 <b className="text-agent">{summary.running}</b>
        </span>
        <span>
          토큰 합계 <b className="font-mono text-ink">{formatTokens(summary.tokens)}</b>
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-2">
          <span>템플릿</span>
          <select
            aria-label="템플릿 필터"
            value={chosen}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            className="h-[34px] rounded-lg border border-[#d5d9e0] bg-white px-2 text-ink"
          >
            {Object.values(data?.workflows ?? {}).map((each) => (
              <option key={`${each.id}@${each.version}`} value={`${each.id}@${each.version}`}>
                {each.name} v{each.version}
              </option>
            ))}
            <option value={ALL_TEMPLATES}>전체 (상태별)</option>
          </select>
        </label>
        <Button
          kind="primary"
          disabled={!canWrite}
          title={canWrite ? undefined : '권한을 연결해야 만들 수 있습니다'}
          onClick={() => {
            setCreating(true);
          }}
        >
          + 새 티켓
        </Button>
      </div>
      {board.error !== null && (
        <div className="px-7 pt-3">
          <ErrorNote error={errorText(board.error)} />
        </div>
      )}
      {hidden > 0 && <p className="px-7 pt-2 text-[12px] text-muted">다른 템플릿의 티켓 {hidden}건은 이 보드에 없습니다. 「전체」로 모두 볼 수 있습니다.</p>}
      <BoardColumns columns={columns} workflows={data?.workflows ?? {}} projectId={projectId} />
      {creating && (
        <NewTicketDialog
          projectId={projectId}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Columns with cards. Dragging a card up or down its column changes the ticket's priority (`ticket.update`): higher
 * cards win claims first. Columns themselves follow the work, so cards do not move between them by hand.
 */
function BoardColumns({ columns, workflows, projectId }: { columns: readonly Column[]; workflows: BoardResult['workflows']; projectId: string }) {
  const client = useQueryClient();
  const canWrite = useCanWrite();
  const [error, setError] = useState<string>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const column = columns.find((each) => each.tickets.some((ticket) => ticket.ticketId === active.id));
    if (column === undefined || !column.tickets.some((ticket) => ticket.ticketId === over.id)) return;
    const from = column.tickets.findIndex((ticket) => ticket.ticketId === active.id);
    const to = column.tickets.findIndex((ticket) => ticket.ticketId === over.id);
    const priority = priorityForMove(column.tickets, from, to);
    if (priority === undefined) return;
    const key = ['board', projectId];
    client.setQueryData<BoardResult>(key, (old) => (old === undefined ? old : { ...old, tickets: old.tickets.map((ticket) => (ticket.ticketId === active.id ? { ...ticket, priority } : ticket)) }));
    setError(undefined);
    try {
      await execute('ticket.update', { ticketId: String(active.id), priority });
    } catch (failure) {
      setError(errorText(failure));
      void client.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <div className="flex-1 overflow-auto px-7 pt-4 pb-7">
      <ErrorNote error={error} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void onDragEnd(event)}>
        <div className="grid min-w-max auto-cols-[minmax(220px,1fr)] grid-flow-col items-start gap-3.5" aria-label="칸반 보드">
          {columns.map((column) => (
            <section key={column.key} aria-label={column.title} className="flex min-h-[560px] flex-col gap-2.5 rounded-xl bg-lane p-3">
              <div className="flex items-center justify-between px-1 pt-0.5">
                <span className="font-bold">{column.title}</span>
                <span className="text-[12px] text-muted">{column.tickets.length}</span>
              </div>
              <span className="self-start">
                <Chip tone={column.hintTone}>{column.hint}</Chip>
              </span>
              <SortableContext items={column.tickets.map((ticket) => ticket.ticketId)} strategy={verticalListSortingStrategy} disabled={!canWrite}>
                {column.tickets.map((ticket) => (
                  <SortableCard key={ticket.ticketId} ticket={ticket} workflow={workflowFor(ticket, workflows)} />
                ))}
              </SortableContext>
            </section>
          ))}
        </div>
      </DndContext>
    </div>
  );
}

function workflowFor(ticket: BoardTicketView, workflows: BoardResult['workflows']): WorkflowView | undefined {
  const key = workflowKey(ticket.template);
  return key === undefined ? undefined : workflows[key];
}

function SortableCard({ ticket, workflow }: { ticket: BoardTicketView; workflow: WorkflowView | undefined }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: ticket.ticketId });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? 'opacity-60' : ''} {...attributes} {...listeners}>
      <TicketCard ticket={ticket} workflow={workflow} />
    </div>
  );
}

export function TicketCard({ ticket, workflow }: { ticket: BoardTicketView; workflow: WorkflowView | undefined }) {
  const openTicket = useUi((state) => state.openTicket);
  const badge = personBadge(ticket, workflow);
  const failed = ticket.lanes.some((lane) => lane.status === 'failed');
  const labels = new Map(workflow?.nodes.map((node) => [node.id, node.label]));
  const active = ticket.lanes.filter((lane) => lane.status !== 'done');
  const chips = (active.length > 0 ? active : ticket.status === 'done' ? [] : ticket.lanes.slice(-1)).slice(0, 3);
  const elapsed = (ticket.completedAt ?? Date.now()) - ticket.createdAt;
  return (
    <article
      onClick={() => {
        openTicket(ticket.ticketId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') openTicket(ticket.ticketId);
      }}
      aria-label={ticket.title}
      className={`flex cursor-pointer flex-col gap-2 rounded-[10px] border bg-white p-3 shadow-sm hover:border-agent ${badge !== undefined ? 'border-[#e7b98a]' : 'border-line'}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted">{shortId(ticket.ticketId)}</span>
        <span className="truncate pl-2 text-[11px] text-muted">{workflow?.name ?? ticket.template?.id ?? '템플릿 없음'}</span>
      </div>
      <span className="leading-snug font-semibold">{ticket.title}</span>
      {workflow !== undefined && (
        <div className="flex gap-[3px]" aria-label="노드 진행">
          {segments(ticket, workflow).map((segment) => (
            <span key={segment.nodeId} title={segment.label} className={`h-1.5 flex-1 rounded-sm ${TONE_BAR[segment.tone]}`} />
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((lane) => (
            <Chip key={`${lane.nodeId}/${lane.lane}`} tone={lane.status === 'running' || lane.status === 'queued' ? laneTone([lane.status], workflow?.nodes.find((node) => node.id === lane.nodeId)) : statusTone(lane.status)}>
              {labels.get(lane.nodeId) ?? lane.nodeId}
              {lane.lane === 'main' ? '' : ` ${lane.lane}`} {statusLabel(lane.status)}
            </Chip>
          ))}
          {active.length > 3 && <Chip tone="wait">+{active.length - 3}</Chip>}
        </div>
      )}
      {badge !== undefined && <span className="self-start rounded-md bg-human px-2.5 py-0.5 text-[12px] font-semibold text-white">{badge}</span>}
      {failed && <span className="self-start rounded-md bg-failed px-2.5 py-0.5 text-[12px] font-semibold text-white">실패 — 확인 필요</span>}
      {ticket.attention !== null && <span className="self-start rounded-md bg-stale px-2.5 py-0.5 text-[12px] font-semibold text-white">주의 필요</span>}
      <div className="flex justify-between border-t border-chip pt-2 font-mono text-[11.5px] text-muted">
        <span title="생성부터 지금(또는 완료)까지">{formatDuration(elapsed)}</span>
        <span title="입력 + 캐시 + 출력 토큰">토큰 {formatTokens(totalTokens(ticket.tokens))}</span>
      </div>
    </article>
  );
}
