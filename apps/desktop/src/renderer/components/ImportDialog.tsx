import { useQueryClient } from '@tanstack/react-query';
import type { DefinitionListing, ImportAction, ImportChoice, ImportDependency, ImportItem, ImportPreview, NodeExecutionPreview } from '@vuyro/contracts';
import { useEffect, useState } from 'react';
import { bridge, call, execute } from '../api.ts';
import { errorText } from '../format.ts';
import { useImportPreview } from '../queries.ts';
import { useCanWrite } from '../store.ts';
import { Button, Chip, ErrorNote, JsonBlock, Modal, PlainText } from './ui.tsx';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';

/**
 * Importing a template or node type from JSON (M6b, 공유·권한·BlackBoard 설계 §1.3). The text comes from a file the
 * person picks (main reads it) or from pasting; the engine reads it as untrusted and answers with a preview: the
 * node types it needs (in the file or missing), what clashes with what is here (overwrite as a new version, a new id,
 * or skip), and what every node would run (script commands, arguments and folders, agent prompts, paths it writes).
 * Nothing is saved until the person has looked at that and confirms; saving sends the preview's save commands.
 */

const KIND: Readonly<Record<string, string>> = { nodeType: '노드 타입', template: '템플릿', bundle: '묶음 (템플릿 + 노드 타입)' };

const STATE: Readonly<Record<ImportItem['state'], { label: string; tone: 'agent' | 'done' | 'wait' | 'failed' }>> = {
  new: { label: '새로 추가', tone: 'agent' },
  newVersion: { label: '새 버전 추가', tone: 'agent' },
  same: { label: '이미 있음 (같은 내용)', tone: 'done' },
  conflict: { label: '충돌: 같은 버전이 다른 내용으로 있음', tone: 'failed' },
};

const ACTION: Readonly<Record<ImportAction, string>> = { add: '추가', skip: '건너뛰기', newVersion: '덮어쓰기 (새 버전으로)', newId: '새 id로' };

const DEPENDENCY: Readonly<Record<ImportDependency['status'], { label: string; tone: 'done' | 'agent' | 'human' | 'failed' }>> = {
  file: { label: '파일에 포함 (함께 저장)', tone: 'agent' },
  installed: { label: '이미 있음', tone: 'done' },
  installedDifferent: { label: '이 엔진의 다른 내용으로 실행됨', tone: 'human' },
  missing: { label: '누락 (파일에도 여기에도 없음)', tone: 'failed' },
};

const SETTLE_TIMEOUT_MS = 15_000;

/** Waits until a saved version is active (the engine writes the file, then activates it). */
async function untilActive(kind: string, id: string, version: number): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { definitions } = await call<{ definitions: DefinitionListing[] }>('query.definitions', { kind });
    const row = definitions.find((each) => each.id === id && each.version === version);
    if (row?.status === 'active') return;
    if (row?.status === 'abandoned') throw new Error(`${id}@${String(version)} 파일을 쓰지 못해 저장이 취소되었습니다.`);
    if (Date.now() > deadline) throw new Error(`${id}@${String(version)}이(가) 활성화되지 않았습니다.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<{ text: string; name?: string }>();
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [error, setError] = useState<string>();

  const openFile = async () => {
    setError(undefined);
    const opened = await bridge().openJsonFile();
    if (!opened.ok) setError(errorText(opened.error));
    else if (opened.value !== null) {
      setChoices({});
      setSource({ text: opened.value.text, name: opened.value.name });
    }
  };

  return (
    <Modal title="JSON 가져오기" onClose={onClose} wide>
      {source === undefined ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">Vuyro에서 내보낸 템플릿·노드 타입 JSON을 가져옵니다. 저장하기 전에 무엇을 실행하는지 먼저 보여 줍니다.</p>
          <div>
            <Button kind="primary" onClick={() => void openFile()}>
              파일 열기…
            </Button>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">또는 붙여넣기</span>
            <textarea
              aria-label="JSON 붙여넣기"
              value={draft}
              rows={8}
              onChange={(event) => { setDraft(event.target.value); }}
              placeholder='{"vuyro": "export", ...}'
              className="rounded-lg border border-[#d5d9e0] px-3 py-2 font-mono text-[12px] outline-none focus:border-agent"
            />
          </label>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>취소</Button>
            <Button
              kind="primary"
              disabled={draft.trim() === ''}
              onClick={() => {
                setChoices({});
                setSource({ text: draft });
              }}
            >
              미리보기
            </Button>
          </div>
        </div>
      ) : (
        <ImportReview
          source={source}
          choices={choices}
          onChoose={(key, choice) => { setChoices((previous) => ({ ...previous, [key]: choice })); }}
          onBack={() => { setSource(undefined); }}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function ImportReview({
  source,
  choices,
  onChoose,
  onBack,
  onClose,
}: {
  source: { text: string; name?: string };
  choices: Readonly<Record<string, ImportChoice>>;
  onChoose: (key: string, choice: ImportChoice) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const preview = useImportPreview(source.text, choices);
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string[]>();
  const data = preview.data;
  const current = !preview.isPlaceholderData && !preview.isFetching;
  // A different choice can change what runs (a skipped node type runs this engine's copy): look again.
  useEffect(() => {
    setConfirmed(false);
  }, [choices]);

  const save = async (plan: ImportPreview) => {
    setSaving(true);
    setError(undefined);
    const done: string[] = [];
    try {
      for (const step of plan.saves) {
        const definition = step.definition as { kind: string; id: string; version: number };
        await execute(step.type, { definition: step.definition });
        await untilActive(definition.kind, definition.id, definition.version);
        done.push(`${definition.id}@${String(definition.version)}`);
      }
      setSaved(done);
    } catch (failure) {
      setError(`${errorText(failure)}${done.length > 0 ? ` (이미 저장된 것: ${done.join(', ')})` : ''}`);
    } finally {
      setSaving(false);
      await client.invalidateQueries({ queryKey: ['definitions'] });
      await client.invalidateQueries({ queryKey: ['templates'] });
    }
  };

  if (saved !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-done">
          가져왔습니다: {saved.join(', ')}
        </p>
        <p className="text-[13px] text-muted">새 티켓을 만들 때 고를 수 있습니다.</p>
        <div className="flex justify-end">
          <Button kind="primary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    );
  }
  if (preview.error !== null) return <ErrorNote error={errorText(preview.error)} />;
  if (data === undefined) return <p className="text-muted">파일을 읽는 중…</p>;

  return (
    <div className="flex flex-col gap-4">
      {source.name !== undefined && <span className="font-mono text-[12px] text-muted">{source.name}</span>}
      {data.document !== undefined && (
        <header className="flex flex-col gap-0.5">
          <span className="text-[12px] text-muted">{KIND[data.document.kind] ?? data.document.kind}</span>
          <span className="text-[16px] font-bold">{data.document.name}</span>
          <span className="font-mono text-[12px] text-muted">
            {data.document.id} v{data.document.version}
            {data.document.author === undefined ? '' : ` · ${data.document.author}`}
          </span>
          {data.document.description !== undefined && <PlainText text={data.document.description} className="text-[13px] text-muted" />}
        </header>
      )}
      {data.problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-failed/30 bg-failed/10 px-3 py-2 text-[13px] text-failed">
          <b>{data.readable ? '가져올 수 없습니다' : '읽을 수 없는 파일입니다'}</b>
          <ul className="mt-1 list-disc pl-5">
            {data.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {data.credentials.length > 0 && (
        <div role="note" className="rounded-lg border border-human/30 bg-human/10 px-3 py-2 text-[13px]">
          <b className="text-human">내보낸 쪽에서 비밀값을 뺐습니다</b>
          <p>가져온 뒤 이 값 없이 실행됩니다: {data.credentials.join(', ')}</p>
        </div>
      )}
      {data.dependencies.length > 0 && (
        <section aria-label="의존 노드 타입" className="flex flex-col gap-1.5">
          <h3 className="font-bold">의존 노드 타입</h3>
          <ul className="flex flex-col gap-1 text-[13px]">
            {data.dependencies.map((dependency) => (
              <li key={`${dependency.type}@${String(dependency.version)}`} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">
                  {dependency.type}@{dependency.version}
                </span>
                <Chip tone={DEPENDENCY[dependency.status].tone}>{DEPENDENCY[dependency.status].label}</Chip>
                {dependency.savedAs !== undefined && (
                  <span className="text-[12px] text-muted">
                    → {dependency.savedAs.type}@{dependency.savedAs.version}(으)로 저장하고 템플릿이 그것을 씁니다
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.items.map((item) => (
        <ImportItemCard key={item.key} item={item} choice={choices[item.key]} onChoose={(choice) => { onChoose(item.key, choice); }} />
      ))}
      {data.readable && (
        <label className="flex items-start gap-2 rounded-lg bg-chip px-3 py-2 text-[13px]">
          <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); }} className="mt-0.5" />
          <span>위의 실행 내용(스크립트 명령·인자·폴더, 에이전트 프롬프트, 쓰는 경로)을 확인했습니다. 이 정의로 만든 티켓은 이것을 실행합니다.</span>
        </label>
      )}
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onBack}>다른 파일</Button>
        <Button onClick={onClose}>취소</Button>
        <Button
          kind="primary"
          disabled={!canWrite || !confirmed || !data.canSave || !current || saving}
          title={canWrite ? undefined : '권한을 연결해야 가져올 수 있습니다'}
          onClick={() => void save(data)}
        >
          {data.saves.length === 0 ? '가져올 것이 없습니다' : `가져오기 (${String(data.saves.length)}개 저장)`}
        </Button>
      </div>
    </div>
  );
}

function ImportItemCard({ item, choice, onChoose }: { item: ImportItem; choice: ImportChoice | undefined; onChoose: (choice: ImportChoice) => void }) {
  const state = STATE[item.state];
  const [newId, setNewId] = useState(choice?.id ?? '');
  const [newName, setNewName] = useState(choice?.name ?? '');
  const pickAction = (action: ImportAction) => {
    if (action === 'newId') onChoose({ action, ...(newId.trim() === '' ? {} : { id: newId.trim() }), ...(newName.trim() === '' ? {} : { name: newName.trim() }) });
    else if (action === 'newVersion') onChoose({ action, ...(newName.trim() === '' ? {} : { name: newName.trim() }) });
    else onChoose({ action });
  };
  return (
    <article aria-label={`${KIND[item.kind] ?? item.kind} ${item.name}`} className={`flex flex-col gap-3 rounded-xl border bg-white p-4 ${item.problems.length > 0 ? 'border-failed/40' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">{KIND[item.kind]}</span>
        <span className="font-bold">{item.name}</span>
        <span className="font-mono text-[12px] text-muted">
          {item.id} v{item.version}
        </span>
        <Chip tone={state.tone}>{state.label}</Chip>
        {item.existingVersions.length > 0 && <span className="text-[12px] text-muted">이 엔진에 있는 버전: {item.existingVersions.map((version) => `v${String(version)}`).join(', ')}</span>}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{item.name} 처리</legend>
        <div className="flex flex-wrap gap-3 text-[13px]">
          {item.actions.map((action) => (
            <label key={action} className="flex items-center gap-1.5">
              <input type="radio" name={`action-${item.key}`} checked={item.action === action && (choice !== undefined || item.state !== 'conflict')} onChange={() => { pickAction(action); }} />
              {ACTION[action]}
            </label>
          ))}
        </div>
        {item.action === 'newId' && (
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="새 id"
              value={newId}
              onChange={(event) => { setNewId(event.target.value); }}
              onBlur={() => { pickAction('newId'); }}
              placeholder={item.kind === 'template' ? 'myteam/ai-sdlc' : 'myteam.build'}
              className="h-8 w-64 rounded-md border border-[#d5d9e0] px-2 font-mono text-[12.5px]"
            />
            <input
              aria-label="새 이름"
              value={newName}
              onChange={(event) => { setNewName(event.target.value); }}
              onBlur={() => { pickAction('newId'); }}
              placeholder={item.name}
              className="h-8 w-64 rounded-md border border-[#d5d9e0] px-2 text-[12.5px]"
            />
            <Button small onClick={() => { pickAction('newId'); }}>
              적용
            </Button>
          </div>
        )}
        {item.target !== undefined ? (
          <span className="text-[12.5px] text-agent">
            저장 위치: <span className="font-mono">{item.target.id}@{item.target.version}</span> · {item.target.name}
          </span>
        ) : (
          <span className="text-[12.5px] text-muted">저장하지 않습니다.</span>
        )}
      </fieldset>
      {item.problems.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-[12.5px] text-failed">
          {item.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {item.workflow !== undefined && <WorkflowCanvas workflow={item.workflow} height={260} label={`${item.name} 미리보기`} />}
      {item.settings !== undefined && (
        <div className="text-[12.5px]">
          <span className="text-muted">템플릿 설정</span>
          <JsonBlock value={item.settings} />
        </div>
      )}
      {/* What will be saved, and every template, shows its nodes open; a node type left as it is folds. */}
      <details open={item.target !== undefined || item.kind === 'template'} className="flex flex-col gap-2">
        <summary className="cursor-pointer text-[13px] font-semibold">실행 내용</summary>
        <section aria-label={`${item.name} 실행 내용`} className="mt-2 flex flex-col gap-2">
          {item.execution.map((node) => (
            <ExecutionCard key={node.nodeId ?? node.type} node={node} />
          ))}
        </section>
      </details>
    </article>
  );
}

const COMPLETION: Readonly<Record<string, string>> = { human: '사람', agent: '에이전트', script: '스크립트', join: '합류', shared: '공유 노드 요청' };

function ExecutionCard({ node }: { node: NodeExecutionPreview }) {
  const runs = node.script !== undefined || node.prompt !== undefined;
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] ${node.script !== undefined ? 'border-human/40 bg-human/5' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{node.label}</span>
        <span className="font-mono text-[11.5px] text-muted">
          {node.type}@{node.typeVersion}
        </span>
        {node.completion === undefined ? <Chip tone="failed">노드 타입 없음</Chip> : <Chip tone={runs ? 'human' : 'wait'}>{COMPLETION[node.completion] ?? node.completion}</Chip>}
        {node.review === 'human' && <Chip tone="human">사람 확인</Chip>}
      </div>
      {node.script !== undefined && (
        <div className="flex flex-col gap-0.5 font-mono text-[12px]">
          <span>
            <b>명령</b> {node.script.program} {node.script.args.join(' ')}
          </span>
          {node.script.cwd !== undefined && (
            <span>
              <b>폴더</b> {node.script.cwd}
            </span>
          )}
          {node.script.env.length > 0 && (
            <span>
              <b>환경 변수</b> {node.script.env.join(', ')}
            </span>
          )}
          {node.script.timeout !== undefined && (
            <span>
              <b>제한 시간</b> {node.script.timeout}
            </span>
          )}
        </div>
      )}
      {node.prompt !== undefined && (
        <details>
          <summary className="cursor-pointer text-muted">에이전트 프롬프트 ({node.prompt.length.toLocaleString()}자)</summary>
          <PlainText text={node.prompt.text} className="mt-1 max-h-48 overflow-auto rounded bg-chip p-2 font-mono text-[11.5px]" />
        </details>
      )}
      {node.params !== undefined && (
        <ul className="flex flex-col gap-0.5">
          {node.params.map((param) => (
            <li key={param.name} className="flex gap-2">
              <span className="font-mono text-muted">{param.name}</span>
              <PlainText text={param.value.text} className="min-w-0 flex-1" />
            </li>
          ))}
        </ul>
      )}
      {node.claims !== undefined && (
        <span>
          <b>쓰는 경로</b>{' '}
          {node.claims.map((claim) => `${claim.path}${claim.mode === 'exclusive' ? ' (쓰기)' : ' (읽기)'}`).join(', ')}
        </span>
      )}
      {node.writes !== undefined && (
        <span>
          <b>BlackBoard 쓰기</b> {node.writes.join(', ')}
        </span>
      )}
      {node.reads !== undefined && (
        <span>
          <b>BlackBoard 읽기</b> {node.reads.join(', ')}
        </span>
      )}
      {node.settings !== undefined && (
        <span>
          <b>노드 설정</b> <span className="font-mono">{JSON.stringify(node.settings)}</span>
        </span>
      )}
    </div>
  );
}
