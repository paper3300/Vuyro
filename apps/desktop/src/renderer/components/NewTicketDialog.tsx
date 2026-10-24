import { useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { execute } from '../api.ts';
import { stageHint } from '../board-model.ts';
import { errorText } from '../format.ts';
import { useTemplates } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import { Button, Chip, ErrorNote, Modal } from './ui.tsx';

const DEFAULT_TEMPLATE = 'vuyro/ai-sdlc';

const PRIORITIES = [
  { value: 10, label: '높음' },
  { value: 0, label: '보통' },
  { value: -10, label: '낮음' },
] as const;

/** A ticket from a title, an optional description and a template card: no YAML, no JSON (PRD 성공 기준). */
export function NewTicketDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const templates = useTemplates();
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const openTicket = useUi((state) => state.openTicket);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string>();
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const usable = (templates.data ?? []).filter((template) => template.problem === undefined);
  const chosen = usable.find((template) => template.id === picked) ?? usable.find((template) => template.id === DEFAULT_TEMPLATE) ?? usable[0];

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (title.trim() === '' || chosen === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const { ticketId } = await execute<{ ticketId: string }>('ticket.create', {
        projectId,
        title: title.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        template: { id: chosen.id, version: chosen.version },
        priority,
      });
      await client.invalidateQueries({ queryKey: ['board', projectId] });
      onClose();
      openTicket(ticketId);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="새 티켓" onClose={onClose} wide>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">제목</span>
          <input
            value={title}
            maxLength={300}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            placeholder="예: 메모장 저장 기능"
            className="h-9 rounded-lg border border-[#d5d9e0] px-3 outline-none focus:border-agent"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">설명</span>
          <textarea
            value={description}
            rows={4}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            placeholder="목표, 배경, 제약 (첫 노드와 에이전트가 읽습니다)"
            className="rounded-lg border border-[#d5d9e0] px-3 py-2 outline-none focus:border-agent"
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 font-semibold">템플릿</legend>
          {templates.isLoading && <p className="text-muted">템플릿을 불러오는 중…</p>}
          {usable.map((template) => (
            <label
              key={template.id}
              className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-3 ${chosen?.id === template.id ? 'border-agent bg-agent/5' : 'border-line bg-white'}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="template"
                  checked={chosen?.id === template.id}
                  onChange={() => {
                    setPicked(template.id);
                  }}
                />
                <span className="font-semibold">{template.name}</span>
                <span className="font-mono text-[11.5px] text-muted">
                  {template.id} v{template.version}
                </span>
              </span>
              {template.description !== undefined && <span className="text-[12.5px] text-muted">{template.description}</span>}
              <span className="flex flex-wrap items-center gap-1" aria-label={`${template.name} 단계`}>
                {template.nodes.map((node, index) => (
                  <span key={node.id} className="flex items-center gap-1">
                    {index > 0 && <span className="text-muted">→</span>}
                    <Chip tone={stageHint(node).tone} title={stageHint(node).text}>
                      {node.label}
                    </Chip>
                  </span>
                ))}
              </span>
            </label>
          ))}
          {(templates.data ?? [])
            .filter((template) => template.problem !== undefined)
            .map((template) => (
              <p key={template.id} className="text-[12px] text-failed">
                {template.id}: 쓸 수 없음 ({template.problem})
              </p>
            ))}
        </fieldset>
        <label className="flex items-center gap-3">
          <span className="font-semibold">우선순위</span>
          <select
            value={priority}
            onChange={(event) => {
              setPriority(Number(event.target.value));
            }}
            className="h-9 rounded-lg border border-[#d5d9e0] bg-white px-2"
          >
            {PRIORITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted">같은 파일을 여러 티켓이 잡으려 할 때 먼저 받습니다. 보드에서 카드를 끌어 바꿀 수도 있습니다.</span>
        </label>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" kind="primary" disabled={!canWrite || busy || title.trim() === '' || chosen === undefined}>
            티켓 만들기
          </Button>
        </div>
      </form>
    </Modal>
  );
}
