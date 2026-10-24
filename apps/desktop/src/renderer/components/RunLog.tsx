import type { LogText, RunLogEntry } from '@vuyro/contracts';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorText, formatTime } from '../format.ts';
import { fullLogEntry, useRunLog } from '../queries.ts';
import { buildLogRows, formatToolDuration, type LogRow } from '../run-log-model.ts';
import { Button, Chip, ErrorNote, PlainText } from './ui.tsx';

/**
 * One agent run's log (M6b): messages and tool calls in time order, live. Everything an agent wrote is plain text.
 * The screen never stalls on a long run: only the latest rows are drawn (older ones on request), long text is folded,
 * and text the engine cut short is fetched in full only when asked.
 */

const ROWS_PER_STEP = 200;
const FOLDED_LINES = 6;
const FOLDED_CHARS = 600;

const ROLE: Readonly<Record<string, string>> = { assistant: '에이전트', user: '입력', system: '시스템' };

/** The text field of an entry, for fetching it in full. */
function entryText(entry: RunLogEntry | undefined, field: 'text' | 'input' | 'output' | 'detail'): string | undefined {
  if (entry === undefined) return undefined;
  switch (entry.kind) {
    case 'message':
    case 'raw':
      return entry.text.text;
    case 'toolStarted':
      return entry.input?.text;
    case 'toolFinished':
      return entry.output?.text;
    case 'warning':
      return entry.message.text;
    case 'settled':
      return field === 'detail' ? entry.error?.text : undefined;
    default:
      return undefined;
  }
}

/** Text folded to a few lines; "전체 불러오기" when the engine cut it. */
function LongText({ text, mono, fetchFull }: { text: LogText; mono?: boolean; fetchFull?: (() => Promise<string | undefined>) | undefined }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string>();
  const [error, setError] = useState<string>();
  const shown = full ?? text.text;
  const lines = shown.split('\n');
  const long = lines.length > FOLDED_LINES || shown.length > FOLDED_CHARS;
  const folded = long && !open ? lines.slice(0, FOLDED_LINES).join('\n').slice(0, FOLDED_CHARS) : shown;
  const cut = full === undefined && text.length > text.text.length;
  return (
    <div className="flex flex-col gap-1">
      <PlainText text={folded} className={`${mono === true ? 'font-mono text-[11.5px]' : 'text-[12.5px]'} ${open ? 'max-h-96 overflow-auto' : ''}`} />
      {(long || cut) && (
        <span className="flex flex-wrap gap-2 text-[11.5px]">
          {long && (
            <button type="button" className="text-agent hover:underline" onClick={() => { setOpen(!open); }}>
              {open ? '접기' : `펼치기 (${String(lines.length)}줄)`}
            </button>
          )}
          {cut && fetchFull !== undefined && (
            <button
              type="button"
              className="text-agent hover:underline"
              onClick={() => {
                setError(undefined);
                void fetchFull()
                  .then((value) => {
                    if (value !== undefined) {
                      setFull(value);
                      setOpen(true);
                    }
                  })
                  .catch((failure: unknown) => { setError(errorText(failure)); });
              }}
            >
              전체 불러오기 ({text.length.toLocaleString()}자)
            </button>
          )}
        </span>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function ToolRow({ row, runId }: { row: Extract<LogRow, { kind: 'tool' }>; runId: string }) {
  const [open, setOpen] = useState(false);
  const full = (revision: number | undefined, field: 'input' | 'output') => (revision === undefined ? undefined : async () => entryText(await fullLogEntry(runId, revision), field));
  return (
    <li className={`rounded-md border px-2 py-1.5 ${row.isError ? 'border-failed/30 bg-failed/5' : 'border-line bg-white'}`}>
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }} className="flex w-full items-center gap-2 text-left">
        <span className="w-3 text-muted">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[12px] font-semibold">{row.name}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={row.summary}>
          {row.summary ?? (row.finished ? '' : '실행 중…')}
        </span>
        {row.isError && <Chip tone="failed">실패</Chip>}
        <span className="font-mono text-[11px] text-muted">{row.finished ? formatToolDuration(row.durationMs) : '…'}</span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5 border-t border-chip pt-1.5">
          {row.input !== undefined && (
            <div>
              <div className="text-[11px] text-muted">입력</div>
              <LongText text={row.input} mono fetchFull={full(row.inputRevision, 'input')} />
            </div>
          )}
          {row.output !== undefined && (
            <div>
              <div className="text-[11px] text-muted">결과</div>
              <LongText text={row.output} mono fetchFull={full(row.outputRevision, 'output')} />
            </div>
          )}
          {row.input === undefined && row.output === undefined && <span className="text-[11.5px] text-muted">입력과 결과가 기록되지 않았습니다.</span>}
        </div>
      )}
    </li>
  );
}

const NOTE_TONE: Readonly<Record<string, string>> = { info: 'text-muted', warn: 'text-human', error: 'text-failed', done: 'text-done' };

function Row({ row, runId }: { row: LogRow; runId: string }) {
  switch (row.kind) {
    case 'message': {
      const revision = row.revisions.length === 1 ? row.revisions[0] : undefined;
      return (
        <li className="flex flex-col gap-0.5 rounded-md bg-chip/60 px-2 py-1.5">
          <span className="flex gap-2 text-[11px] text-muted">
            <b>{ROLE[row.role] ?? row.role}</b>
            <span className="font-mono">{formatTime(row.at)}</span>
          </span>
          <LongText text={row.text} fetchFull={revision === undefined ? undefined : async () => entryText(await fullLogEntry(runId, revision), 'text')} />
        </li>
      );
    }
    case 'tool':
      return <ToolRow row={row} runId={runId} />;
    case 'note':
      return (
        <li className={`px-1 text-[12px] ${NOTE_TONE[row.tone] ?? ''}`}>
          <span className="mr-2 font-mono text-[11px] text-muted">{formatTime(row.at)}</span>
          {row.text}
          {row.detail !== undefined && <LongText text={row.detail} />}
        </li>
      );
    case 'raw':
      return (
        <li className="px-1 font-mono text-[11px] text-muted">
          {row.stream}
          {row.providerType === undefined ? '' : ` · ${row.providerType}`}
          <LongText text={row.text} mono />
        </li>
      );
  }
}

export function RunLog({ runId }: { runId: string }) {
  const log = useRunLog(runId);
  const rows = useMemo(() => buildLogRows(log.data?.entries ?? []), [log.data]);
  const [showRaw, setShowRaw] = useState(false);
  const [visible, setVisible] = useState(ROWS_PER_STEP);
  const box = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const listed = showRaw ? rows : rows.filter((row) => row.kind !== 'raw');
  const raw = rows.length - rows.filter((row) => row.kind !== 'raw').length;
  const hidden = Math.max(0, listed.length - visible);
  const shown = listed.slice(hidden);

  // Keep the newest row in view while the person has not scrolled up.
  useLayoutEffect(() => {
    const element = box.current;
    if (element !== null && follow.current) element.scrollTop = element.scrollHeight;
  }, [shown.length]);

  if (log.error !== null) return <ErrorNote error={errorText(log.error)} />;
  if (log.data === undefined) return <p className="text-[12.5px] text-muted">로그를 불러오는 중…</p>;
  return (
    <section aria-label="실행 로그" className="flex min-h-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <span>
          항목 {listed.length.toLocaleString()}개{log.isFetching ? ' · 갱신 중' : ''}
        </span>
        <span className="flex-1" />
        {raw > 0 && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showRaw} onChange={(event) => { setShowRaw(event.target.checked); }} />
            원본 줄 {raw}개
          </label>
        )}
      </div>
      {hidden > 0 && (
        <Button small kind="ghost" onClick={() => { setVisible(visible + ROWS_PER_STEP); }}>
          이전 항목 {Math.min(hidden, ROWS_PER_STEP)}개 더 보기 (남은 {hidden.toLocaleString()}개)
        </Button>
      )}
      <ol
        ref={box}
        aria-label="로그 항목"
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="flex max-h-[520px] min-h-0 flex-col gap-1 overflow-y-auto pr-1"
      >
        {shown.map((row) => (
          <Row key={row.key} row={row} runId={runId} />
        ))}
        {shown.length === 0 && <li className="text-[12.5px] text-muted">아직 기록이 없습니다.</li>}
      </ol>
      {log.data.more && (
        <Button small kind="ghost" onClick={log.loadMore}>
          나머지 기록 더 불러오기
        </Button>
      )}
    </section>
  );
}
