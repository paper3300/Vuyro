import type { DefinitionListing, ExportResult } from '@vuyro/contracts';
import { useState } from 'react';
import { bridge, call } from '../api.ts';
import { errorText } from '../format.ts';
import { useDefinitions, useTemplates } from '../queries.ts';
import { ImportDialog } from './ImportDialog.tsx';
import { Button, Chip, ErrorNote, JsonBlock } from './ui.tsx';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';

/**
 * Templates and node types on this engine (M6b): a template's graph as a preview, and JSON export (file or clipboard,
 * secrets left out and named) and import (preview first, the person confirms, then the save commands).
 */

interface Selection {
  readonly kind: 'nodeType' | 'template';
  readonly id: string;
}

export function Library() {
  const definitions = useDefinitions();
  const [selected, setSelected] = useState<Selection>();
  const [importing, setImporting] = useState(false);
  const all = definitions.data ?? [];
  const latest = all.filter((row) => row.latest);
  const pick = selected ?? (latest.find((row) => row.kind === 'template') === undefined ? undefined : { kind: 'template' as const, id: latest.find((row) => row.kind === 'template')?.id ?? '' });
  const chosen = pick === undefined ? undefined : latest.find((row) => row.kind === pick.kind && row.id === pick.id);

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="정의 목록" className="flex w-72 flex-none flex-col gap-4 overflow-y-auto border-r border-line bg-white px-3 py-4">
        <Button kind="primary" onClick={() => { setImporting(true); }}>
          JSON 가져오기…
        </Button>
        <ErrorNote error={definitions.error === null ? undefined : errorText(definitions.error)} />
        <DefinitionGroup title="템플릿" rows={latest.filter((row) => row.kind === 'template')} all={all} selected={pick} onSelect={setSelected} />
        <DefinitionGroup title="노드 타입" rows={latest.filter((row) => row.kind === 'nodeType')} all={all} selected={pick} onSelect={setSelected} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {chosen === undefined ? <p className="text-muted">왼쪽에서 템플릿이나 노드 타입을 고르세요.</p> : <DefinitionPanel key={`${chosen.kind}:${chosen.id}`} row={chosen} versions={all.filter((row) => row.kind === chosen.kind && row.id === chosen.id)} />}
      </main>
      {importing && <ImportDialog onClose={() => { setImporting(false); }} />}
    </div>
  );
}

function DefinitionGroup({ title, rows, all, selected, onSelect }: { title: string; rows: readonly DefinitionListing[]; all: readonly DefinitionListing[]; selected: Selection | undefined; onSelect: (selection: Selection) => void }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="px-1.5 text-[12px] font-semibold text-muted">
        {title} ({rows.length})
      </h3>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const chosen = selected?.kind === row.kind && selected.id === row.id;
          const versions = all.filter((each) => each.kind === row.kind && each.id === row.id).length;
          return (
            <li key={`${row.kind}:${row.id}`}>
              <button
                type="button"
                aria-current={chosen ? 'true' : undefined}
                onClick={() => { onSelect({ kind: row.kind, id: row.id }); }}
                className={`flex w-full flex-col items-start rounded-lg border px-2.5 py-1.5 text-left ${chosen ? 'border-agent/40 bg-agent/5' : 'border-transparent hover:bg-chip'}`}
              >
                <span className="text-[13px] font-medium">{row.name}</span>
                <span className="font-mono text-[11px] text-muted">
                  {row.id} v{row.version}
                  {versions > 1 ? ` (버전 ${String(versions)}개)` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DefinitionPanel({ row, versions }: { row: DefinitionListing; versions: readonly DefinitionListing[] }) {
  const templates = useTemplates();
  const summary = row.kind === 'template' ? templates.data?.find((each) => each.id === row.id && each.version === row.version) : undefined;
  return (
    <>
      <header className="flex flex-col gap-1">
        <span className="text-[12px] text-muted">{row.kind === 'template' ? '템플릿' : '노드 타입'}</span>
        <h2 className="text-[20px] font-bold">{row.name}</h2>
        <span className="font-mono text-[12px] text-muted">
          {row.id} · 버전 {versions.map((each) => `v${String(each.version)}${each.status === 'active' ? '' : ` (${each.status})`}`).join(', ')}
        </span>
        {summary?.description !== undefined && <p className="text-[13px] text-muted">{summary.description}</p>}
      </header>
      {row.kind === 'template' && summary !== undefined && summary.problem === undefined && <WorkflowCanvas workflow={summary} height={380} label={`${row.name} 미리보기`} />}
      {summary?.problem !== undefined && <ErrorNote error={`이 템플릿은 지금 쓸 수 없습니다: ${summary.problem}`} />}
      <ExportPanel row={row} />
    </>
  );
}

/** Export: what leaves (secrets named), then a file or the clipboard. */
export function ExportPanel({ row }: { row: DefinitionListing }) {
  const [embed, setEmbed] = useState(true);
  const [result, setResult] = useState<ExportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const text = result === undefined ? undefined : JSON.stringify(result.document, null, 2);

  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      setResult(await call<ExportResult>('query.exportDefinition', { kind: row.kind, id: row.id, version: row.version, ...(row.kind === 'template' ? { embedNodeTypes: embed } : {}) }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (result === undefined || text === undefined) return;
    setError(undefined);
    const saved = await bridge().saveJsonFile(result.fileName, text);
    if (!saved.ok) setError(errorText(saved.error));
    else if (saved.value !== null) setDone(`${saved.value.name}(으)로 저장했습니다.`);
  };
  const copy = async () => {
    if (text === undefined) return;
    setError(undefined);
    const copied = await bridge().copyText(text);
    if (!copied.ok) setError(errorText(copied.error));
    else setDone('클립보드에 복사했습니다. 다른 Vuyro의 「JSON 가져오기」에 붙여 넣으세요.');
  };

  return (
    <section aria-label="내보내기" className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4">
      <h3 className="font-bold">JSON으로 내보내기</h3>
      {row.kind === 'template' && (
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={embed}
            onChange={(event) => {
              setEmbed(event.target.checked);
              setResult(undefined);
            }}
          />
          쓰는 노드 타입을 함께 넣기 (묶음, 받는 쪽에 노드 타입이 없어도 됩니다)
        </label>
      )}
      <div className="flex gap-2">
        <Button kind="primary" disabled={busy} onClick={() => void prepare()}>
          내보낼 내용 만들기
        </Button>
      </div>
      {result !== undefined && (
        <>
          {result.redacted.length === 0 ? (
            <p className="text-[13px] text-done">비밀값으로 보이는 내용이 없어 그대로 내보냅니다.</p>
          ) : (
            <div role="note" className="rounded-lg border border-human/30 bg-human/10 px-3 py-2 text-[13px]">
              <b className="text-human">비밀값일 수 있어 빼고 내보냅니다 ({result.redacted.length})</b>
              <ul className="mt-1 list-disc pl-5">
                {result.redacted.map((field) => (
                  <li key={field.path}>{field.label}</li>
                ))}
              </ul>
              <p className="mt-1 text-muted">받는 쪽에는 이름만 `requires.credentials`로 전해집니다. 값은 받는 사람이 채워야 합니다.</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()}>파일로 저장…</Button>
            <Button onClick={() => void copy()}>클립보드에 복사</Button>
            <Chip tone="wait">{result.fileName}</Chip>
          </div>
          {done !== undefined && <p className="text-[13px] text-done">{done}</p>}
          <details>
            <summary className="cursor-pointer text-[12.5px] text-muted">내용 보기</summary>
            <JsonBlock value={result.document} />
          </details>
        </>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
