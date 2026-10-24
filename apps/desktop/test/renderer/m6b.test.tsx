import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ExportResult, ImportPreview, RunEventsResult, RunLogEntry } from '@vuyro/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/components/App.tsx';
import { ImportDialog } from '../../src/renderer/components/ImportDialog.tsx';
import { Library } from '../../src/renderer/components/Library.tsx';
import { RunLog } from '../../src/renderer/components/RunLog.tsx';
import { TicketDrawer } from '../../src/renderer/components/TicketDetail.tsx';
import { WorkflowCanvas } from '../../src/renderer/components/WorkflowCanvas.tsx';
import { useUi } from '../../src/renderer/store.ts';
import { SDLC_WITH_EDGES, boardTicket, installBridge, lane, renderWithClient, setConnection, ticketDetail, ticketStats, type Handler } from './fixtures.tsx';

/** M6b screens against a fake bridge: the graph canvas, node detail and run log, JSON import and export. */

beforeEach(() => {
  setConnection();
});

const TICKET = '0190aaaa-bbbb-7ccc-8ddd-eeeeee123456';
const RUN = '0190aaaa-bbbb-7ccc-8ddd-000000000001';

const laneRow = (nodeId: string, status: string, run = 1) => ({ nodeId, lane: 'main', laneGroup: null, run, status, executor: 'agent', runId: null, attempt: 1, pauseRequested: 0, supersededBy: null, waitingFor: null, updatedAt: 0 });
const runRow = { runId: RUN, nodeId: 'spec', provider: 'claude', status: 'succeeded', model: 'small', startedAt: 0, settledAt: 1, terminalReason: null, tokensInput: 10, tokensCacheRead: 0, tokensCacheWrite: 0, tokensOutput: 5, costUsd: null, toolCalls: 1, toolErrors: 0 };

function logPage(entries: RunLogEntry[], cursor: number, more = false): RunEventsResult {
  return { run: { runId: RUN, ticketId: TICKET, nodeId: 'spec', provider: 'claude', status: 'running', model: null, startedAt: 0, settledAt: null }, entries, cursor, more };
}
const entry = (revision: number, patch: Record<string, unknown>) => ({ revision, sequence: 100 + revision, at: 1000 * revision, ...patch }) as RunLogEntry;

describe('graph canvas', () => {
  it('draws every node with its state and says which node was clicked', () => {
    const picked: string[] = [];
    renderWithClient(<WorkflowCanvas workflow={SDLC_WITH_EDGES} lanes={[lane('brainstorming', 'done'), lane('specApproval', 'review')]} onSelect={(id) => picked.push(id)} />);
    const canvas = screen.getByRole('group', { name: '워크플로 그래프' });
    expect(within(canvas).getByLabelText('노드 BrainStorming')).toHaveTextContent('완료');
    const approval = within(canvas).getByLabelText('노드 Spec approval');
    expect(approval).toHaveTextContent('사람 승인');
    expect(approval).toHaveTextContent('사람 차례');
    expect(within(canvas).getByLabelText('노드 QA')).toHaveTextContent('AI + 사람 확인');
    // A plain click (no pointer press): d3-drag needs `event.view`, which jsdom's synthetic presses lack.
    fireEvent.click(approval);
    expect(picked).toEqual(['specApproval']);
  });

  it('repaints when the lanes change (events) and keeps every node', () => {
    const view = renderWithClient(<WorkflowCanvas workflow={SDLC_WITH_EDGES} lanes={[lane('spec', 'running')]} />);
    expect(screen.getByLabelText('노드 Spec')).toHaveTextContent('실행 중');
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowCanvas workflow={SDLC_WITH_EDGES} lanes={[lane('spec', 'done')]} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('노드 Spec')).toHaveTextContent('완료');
    expect(screen.getAllByLabelText(/^노드 /)).toHaveLength(8);
  });
});

describe('graph view and node detail', () => {
  function engine(extra: Partial<Record<string, Handler>> = {}) {
    const detail = ticketDetail({
      workflow: SDLC_WITH_EDGES,
      lanes: [laneRow('brainstorming', 'done'), laneRow('spec', 'done'), laneRow('specApproval', 'review', 2)],
      executions: [{ nodeId: 'spec', run: 1, lane: 'main', cause: 'input', status: 'done', port: 'done', itemCount: 1, attempts: 1, activatedAt: 0, startedAt: 0, reviewAt: null, finishedAt: 1, error: null, supersededBy: null }],
      runs: [runRow],
      reviews: [{ nodeId: 'specApproval', lane: 'main', run: 2, kind: 'approval', inputs: [{ summary: 'Spec v2' }] }],
    });
    return installBridge({
      'query.projects': () => ({ projects: [{ projectId: 'p1', name: 'sample', createdAt: 0 }] }),
      'query.board': () => ({ tickets: [boardTicket({ ticketId: TICKET, title: '메모장 저장', lanes: [lane('specApproval', 'review')] }), boardTicket({ ticketId: 't-other', title: '다른 티켓' })], workflows: { 'vuyro/ai-sdlc@1': SDLC_WITH_EDGES } }),
      'query.ticket': () => detail,
      'query.ticketStats': () => ticketStats(),
      'query.artifacts': () => ({ artifacts: [] }),
      'query.sharedNodes': () => ({ sharedNodes: [] }),
      'engine.status': () => ({ lastSequence: 0 }),
      'query.runEvents': () =>
        logPage(
          [
            entry(1, { kind: 'started', provider: 'claude' }),
            entry(2, { kind: 'message', role: 'assistant', text: { text: 'Writing <b>the</b> spec', length: 22 } }),
            entry(3, { kind: 'toolStarted', toolCallId: 't1', name: 'Write', input: { text: '{"file_path":"docs/spec.md"}', length: 28 } }),
            entry(5, { kind: 'toolFinished', toolCallId: 't1', isError: false, output: { text: 'File written\nmore', length: 17 } }),
          ],
          5,
        ),
      ...extra,
    });
  }

  it('keeps the selected ticket when switching between the board and the graph', async () => {
    engine();
    useUi.setState({ projectId: 'p1' });
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole('article', { name: '메모장 저장' }));
    expect(useUi.getState()).toMatchObject({ ticketId: TICKET, detailOpen: true });
    // The drawer offers the graph of the same ticket.
    await userEvent.click(await screen.findByRole('button', { name: '그래프로 보기' }));
    expect(useUi.getState()).toMatchObject({ view: 'graph', ticketId: TICKET, detailOpen: false });
    expect(await screen.findByRole('group', { name: '메모장 저장 그래프' })).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: '티켓 목록' })).getByRole('button', { name: /메모장 저장/ })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(within(screen.getByRole('navigation', { name: '보기 전환' })).getByRole('button', { name: '보드' }));
    expect(await screen.findByRole('article', { name: '메모장 저장' })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('complementary', { name: '티켓 상세' })).not.toBeInTheDocument();
  });

  it('a clicked node shows its decision, numbers and agent log; deciding sends the execution the screen saw', async () => {
    const { commands } = engine();
    useUi.setState({ projectId: 'p1', view: 'graph', ticketId: TICKET });
    renderWithClient(<App />);
    fireEvent.click(await screen.findByLabelText('노드 Spec approval'));
    const panel = await screen.findByRole('region', { name: '노드 상세 Spec approval' });
    expect(within(panel).getByText('Spec v2')).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText('의견'), '좋습니다');
    await userEvent.click(within(panel).getByRole('button', { name: '승인' }));
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'node.approve', payload: { ticketId: TICKET, nodeId: 'specApproval', lane: 'main', run: 2, comment: '좋습니다' } }]);
    });

    fireEvent.click(screen.getByLabelText('노드 Spec'));
    const spec = await screen.findByRole('region', { name: '노드 상세 Spec' });
    const log = await within(spec).findByRole('region', { name: '실행 로그' });
    // Agent text is text, never markup.
    expect(within(log).getByText('Writing <b>the</b> spec')).toBeInTheDocument();
    const tool = within(log).getByRole('button', { name: /Write/ });
    expect(tool).toHaveTextContent('File written');
    expect(tool).toHaveTextContent('2.0s');
    await userEvent.click(tool);
    expect(within(log).getByText('{"file_path":"docs/spec.md"}')).toBeInTheDocument();
  });
});

describe('run log', () => {
  it('appends what came after the last entry when the run moves on, and fetches cut text in full on request', async () => {
    const calls: unknown[] = [];
    let page = 0;
    const { request } = installBridge({
      'query.runEvents': (params) => {
        calls.push(params);
        const { textLimit } = params as { textLimit?: number };
        if (textLimit !== undefined) return logPage([entry(2, { kind: 'message', role: 'assistant', text: { text: 'all of it', length: 9 } })], 2);
        page += 1;
        return page === 1
          ? logPage([entry(1, { kind: 'started', provider: 'claude' }), entry(2, { kind: 'message', role: 'assistant', text: { text: 'cut', length: 9 } })], 2)
          : logPage([entry(3, { kind: 'settled', outcome: 'succeeded' })], 3);
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RunLog runId={RUN} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('cut')).toBeInTheDocument();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runLog', RUN] });
    });
    expect(await screen.findByText('실행이 끝났습니다 (성공)')).toBeInTheDocument();
    expect(calls.slice(0, 2)).toEqual([
      { runId: RUN, after: 0, limit: 500 },
      { runId: RUN, after: 2, limit: 500 },
    ]);
    expect(screen.getAllByText('실행 시작 (claude)')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '전체 불러오기 (9자)' }));
    expect(await screen.findByText('all of it')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('query.runEvents', { runId: RUN, after: 1, limit: 1, textLimit: 1_048_576 });
  });

  it('folds long text and draws only the latest rows of a long run', async () => {
    const many = Array.from({ length: 450 }, (_, index) => entry(index + 1, { kind: 'message', role: 'assistant', text: { text: `line ${String(index + 1)}`, length: 8 } }));
    many.push(entry(451, { kind: 'message', role: 'assistant', text: { text: Array.from({ length: 20 }, (_, index) => `row ${String(index)}`).join('\n'), length: 200 } }));
    installBridge({ 'query.runEvents': () => logPage(many, 451) });
    renderWithClient(<RunLog runId={RUN} />);
    expect(await screen.findByText('line 450')).toBeInTheDocument();
    expect(screen.queryByText('line 1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(201);
    await userEvent.click(screen.getByRole('button', { name: /이전 항목 200개 더 보기/ }));
    expect(screen.getByText('line 252')).toBeInTheDocument();
    expect(screen.queryByText(/row 19/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '펼치기 (20줄)' }));
    expect(screen.getByText(/row 19/)).toBeInTheDocument();
  });
});

describe('ticket detail across tickets (M6a re-review)', () => {
  it('moving to another ticket starts without the last ticket\'s draft or notice', async () => {
    const review = { nodeId: 'specApproval', lane: 'main', run: 1, kind: 'approval' as const, inputs: [] };
    installBridge({
      'query.ticket': (params) => ticketDetail({ ticket: { ...ticketDetail().ticket, ticketId: (params as { ticketId: string }).ticketId, title: (params as { ticketId: string }).ticketId }, reviews: [review] }),
      'query.ticketStats': () => ticketStats(),
      'query.artifacts': () => ({ artifacts: [] }),
      'query.sharedNodes': () => ({ sharedNodes: [] }),
    });
    useUi.setState({ ticketId: 'ticket-a', detailOpen: true });
    renderWithClient(<TicketDrawer />);
    await userEvent.type(await screen.findByLabelText('의견'), '반려 사유 초안');
    act(() => {
      useUi.getState().openTicket('ticket-b');
    });
    expect(await screen.findByRole('heading', { name: 'ticket-b' })).toBeInTheDocument();
    expect(screen.getByLabelText('의견')).toHaveValue('');
  });
});

const PREVIEW: ImportPreview = {
  readable: true,
  problems: [],
  document: { kind: 'bundle', id: 'myteam/build', version: 1, name: 'Build flow', author: 'someone' },
  items: [
    {
      key: 'nodeType:myteam.build@1',
      kind: 'nodeType',
      id: 'myteam.build',
      version: 1,
      name: 'Build',
      hash: 'sha256:1',
      state: 'conflict',
      existingVersions: [1],
      actions: ['newVersion', 'newId', 'skip'],
      action: 'skip',
      problems: ['myteam.build@1이(가) 다른 내용으로 이미 있습니다.'],
      execution: [{ label: 'Build', type: 'myteam.build', typeVersion: 1, completion: 'script', script: { program: 'tools/build.cmd', args: ['--target', 'Game'], cwd: 'Build', env: ['BUILD_TOKEN'] }, claims: [{ path: 'Build/**', mode: 'exclusive' }] }],
    },
    {
      key: 'template:myteam/build@1',
      kind: 'template',
      id: 'myteam/build',
      version: 1,
      name: 'Build flow',
      hash: 'sha256:2',
      state: 'new',
      existingVersions: [],
      actions: ['add', 'newId', 'skip'],
      action: 'add',
      target: { id: 'myteam/build', version: 1, name: 'Build flow' },
      problems: [],
      execution: [{ nodeId: 'review', label: 'Review', type: 'vuyro.agent', typeVersion: 1, completion: 'agent', prompt: { text: '{{ params.instructions }} and more', length: 900 }, params: [{ name: 'instructions', value: { text: 'Check <script>', length: 14 } }] }],
    },
  ],
  dependencies: [
    { type: 'myteam.build', version: 1, status: 'installedDifferent' },
    { type: 'vuyro.agent', version: 1, status: 'installed' },
  ],
  credentials: ['env:BUILD_TOKEN'],
  saves: [],
  canSave: false,
};

describe('JSON import', () => {
  it('shows dependencies, conflicts and what each node runs before anything is saved; saving needs the person to confirm', async () => {
    const asked: unknown[] = [];
    const saved = { type: 'nodeType.save' as const, definition: { kind: 'nodeType', id: 'myteam.build', version: 2 } };
    const savedTemplate = { type: 'template.save' as const, definition: { kind: 'template', id: 'myteam/build', version: 1 } };
    const { commands } = installBridge({
      'query.importPreview': (params) => {
        asked.push(params);
        const { choices } = params as { choices: Record<string, { action: string }> };
        if (choices['nodeType:myteam.build@1']?.action !== 'newVersion') return PREVIEW;
        const [type, template] = PREVIEW.items;
        return {
          ...PREVIEW,
          items: [{ ...type, action: 'newVersion', target: { id: 'myteam.build', version: 2, name: 'Build' }, problems: [] }, template],
          dependencies: [{ type: 'myteam.build', version: 1, status: 'file', savedAs: { type: 'myteam.build', version: 2 } }, PREVIEW.dependencies[1]],
          saves: [saved, savedTemplate],
          canSave: true,
        };
      },
      'query.definitions': () => ({ definitions: [{ kind: 'nodeType', id: 'myteam.build', version: 2, status: 'active' }, { kind: 'template', id: 'myteam/build', version: 1, status: 'active' }] }),
      'command.execute': () => ({ status: 'staged' }),
    });
    renderWithClient(<ImportDialog onClose={() => undefined} />);
    await userEvent.click(screen.getByLabelText('JSON 붙여넣기'));
    await userEvent.paste('{"vuyro":"export"}');
    await userEvent.click(screen.getByRole('button', { name: '미리보기' }));

    expect(await screen.findByText('Build flow', { selector: 'span.text-\\[16px\\]' })).toBeInTheDocument();
    expect(screen.getByText('가져온 뒤 이 값 없이 실행됩니다: env:BUILD_TOKEN')).toBeInTheDocument();
    const dependencies = screen.getByRole('region', { name: '의존 노드 타입' });
    expect(dependencies).toHaveTextContent('myteam.build@1이 엔진의 다른 내용으로 실행됨');
    const build = screen.getByRole('article', { name: '노드 타입 Build' });
    expect(within(build).getByText('충돌: 같은 버전이 다른 내용으로 있음')).toBeInTheDocument();
    expect(within(build).getByText(/tools\/build\.cmd --target Game/)).toBeInTheDocument();
    expect(within(build).getByText(/Build\/\*\* \(쓰기\)/)).toBeInTheDocument();
    expect(within(build).getByText('BUILD_TOKEN')).toBeInTheDocument();
    const template = screen.getByRole('article', { name: '템플릿 Build flow' });
    expect(within(template).getByText('에이전트 프롬프트 (900자)')).toBeInTheDocument();
    expect(within(template).getByText('Check <script>')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가져올 것이 없습니다' })).toBeDisabled();

    // Overwrite as a new version: the preview is asked again with the choice.
    await userEvent.click(within(build).getByRole('radio', { name: '덮어쓰기 (새 버전으로)' }));
    expect(await screen.findByText('→ myteam.build@2(으)로 저장하고 템플릿이 그것을 씁니다')).toBeInTheDocument();
    expect(asked.at(-1)).toEqual({ text: '{"vuyro":"export"}', choices: { 'nodeType:myteam.build@1': { action: 'newVersion' } } });
    const save = screen.getByRole('button', { name: '가져오기 (2개 저장)' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /실행 내용.*확인했습니다/ }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(await screen.findByText('가져왔습니다: myteam.build@2, myteam/build@1')).toBeInTheDocument();
    expect(commands).toEqual([
      { type: 'nodeType.save', payload: { definition: saved.definition } },
      { type: 'template.save', payload: { definition: savedTemplate.definition } },
    ]);
  });

  it('a file the person picks is read by the main process; unreadable text says why and saves nothing', async () => {
    const { openJsonFile, commands } = installBridge({ 'query.importPreview': () => ({ readable: false, problems: ['권한 규칙은 파일로 가져올 수 없습니다.'], items: [], dependencies: [], credentials: [], saves: [], canSave: false }) });
    openJsonFile.mockResolvedValueOnce({ ok: true, value: { name: 'rules.json', text: '{}' } });
    renderWithClient(<ImportDialog onClose={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: '파일 열기…' }));
    expect(await screen.findByText('읽을 수 없는 파일입니다')).toBeInTheDocument();
    expect(screen.getByText('권한 규칙은 파일로 가져올 수 없습니다.')).toBeInTheDocument();
    expect(screen.getByText('rules.json')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가져올 것이 없습니다' })).toBeDisabled();
    expect(commands).toEqual([]);
  });

  it('a read-only connection can look but not import', async () => {
    setConnection({ phase: 'connected', access: 'read-only' });
    installBridge({ 'query.importPreview': () => ({ ...PREVIEW, items: [PREVIEW.items[1]], saves: [{ type: 'template.save', definition: {} }], canSave: true }) });
    renderWithClient(<ImportDialog onClose={() => undefined} />);
    await userEvent.click(screen.getByLabelText('JSON 붙여넣기'));
    await userEvent.paste('{}');
    await userEvent.click(screen.getByRole('button', { name: '미리보기' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /확인했습니다/ }));
    expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeDisabled();
  });

  it('confirming does not save what the engine says cannot be saved, nor a preview that is being redone', async () => {
    let answer: (preview: ImportPreview) => void = () => undefined;
    const ready = { ...PREVIEW, items: [PREVIEW.items[1]], saves: [{ type: 'template.save' as const, definition: {} }], canSave: true } as ImportPreview;
    let calls = 0;
    installBridge({
      'query.importPreview': () => {
        calls += 1;
        if (calls === 1) return { ...ready, canSave: false };
        if (calls === 2) return ready;
        return new Promise<ImportPreview>((resolve) => {
          answer = resolve;
        });
      },
    });
    renderWithClient(<ImportDialog onClose={() => undefined} />);
    await userEvent.click(screen.getByLabelText('JSON 붙여넣기'));
    await userEvent.paste('{}');
    await userEvent.click(screen.getByRole('button', { name: '미리보기' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /확인했습니다/ }));
    expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeDisabled();
    // A choice brings a saveable preview; then another choice while its preview is still on the way.
    await userEvent.click(screen.getByRole('radio', { name: '새 id로' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /확인했습니다/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('radio', { name: '건너뛰기' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /확인했습니다/ }));
    expect(screen.getByRole('checkbox', { name: /확인했습니다/ })).toBeChecked();
    expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeDisabled();
    await act(async () => {
      answer(ready);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeEnabled();
    });
  });

  it('a different choice asks the person to look again before saving', async () => {
    installBridge({ 'query.importPreview': () => ({ ...PREVIEW, items: [PREVIEW.items[1]], saves: [{ type: 'template.save', definition: {} }], canSave: true }) });
    renderWithClient(<ImportDialog onClose={() => undefined} />);
    await userEvent.click(screen.getByLabelText('JSON 붙여넣기'));
    await userEvent.paste('{}');
    await userEvent.click(screen.getByRole('button', { name: '미리보기' }));
    const confirm = await screen.findByRole('checkbox', { name: /확인했습니다/ });
    await userEvent.click(confirm);
    expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: '건너뛰기' }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /확인했습니다/ })).not.toBeChecked();
    });
    expect(screen.getByRole('button', { name: '가져오기 (1개 저장)' })).toBeDisabled();
  });
});

describe('JSON export', () => {
  it('says what was left out, then saves the file through the main process or copies it', async () => {
    const exported: ExportResult = {
      document: { vuyro: 'export', kind: 'bundle', id: 'myteam/build' },
      fileName: 'myteam.build@1.json',
      redacted: [{ path: '/embedded/0/content/script/env/BUILD_TOKEN', label: 'myteam.build@1 · 스크립트 환경 변수 BUILD_TOKEN' }],
    };
    const asked: unknown[] = [];
    const { saveJsonFile, copyText } = installBridge({
      'query.definitions': () => ({ definitions: [{ kind: 'template', id: 'myteam/build', version: 1, name: 'Build flow', hash: 'sha256:2', status: 'active', latest: true }] }),
      'query.templates': () => ({ templates: [{ ...SDLC_WITH_EDGES, id: 'myteam/build', name: 'Build flow' }] }),
      'query.exportDefinition': (params) => {
        asked.push(params);
        return exported;
      },
    });
    renderWithClient(<Library />);
    expect(await screen.findByRole('group', { name: 'Build flow 미리보기' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '내보낼 내용 만들기' }));
    expect(await screen.findByText('myteam.build@1 · 스크립트 환경 변수 BUILD_TOKEN')).toBeInTheDocument();
    expect(asked).toEqual([{ kind: 'template', id: 'myteam/build', version: 1, embedNodeTypes: true }]);
    await userEvent.click(screen.getByRole('button', { name: '파일로 저장…' }));
    expect(saveJsonFile).toHaveBeenCalledWith('myteam.build@1.json', JSON.stringify(exported.document, null, 2));
    expect(await screen.findByText('saved.json(으)로 저장했습니다.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '클립보드에 복사' }));
    expect(copyText).toHaveBeenCalledWith(JSON.stringify(exported.document, null, 2));
  });
});

describe('a window opened again (tray)', () => {
  it('subscribes from where the engine is now, fetches what it shows again, and follows the events from there', async () => {
    let boards = 0;
    const { subscribe } = installBridge({
      'engine.status': () => ({ lastSequence: 141 }),
      'query.projects': () => ({ projects: [{ projectId: 'p1', name: 'sample', createdAt: 0 }] }),
      'query.board': () => {
        boards += 1;
        return { tickets: [], workflows: {} };
      },
      'query.sharedNodes': () => ({ sharedNodes: [] }),
    });
    useUi.setState({ projectId: 'p1' });
    renderWithClient(<App />);
    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1);
    });
    expect(subscribe.mock.calls[0]?.[0]).toBe(141);
    await waitFor(() => {
      expect(useUi.getState().lastSequence).toBe(141);
    });
    const fetched = boards;
    const deliver = subscribe.mock.calls[0]?.[1];
    act(() => {
      deliver?.([{ sequence: 142, type: 'ticket.created', aggregateType: 'ticket', aggregateId: 't1', data: {} }]);
    });
    await waitFor(() => {
      expect(boards).toBeGreaterThan(fetched);
    });
    expect(useUi.getState().lastSequence).toBe(142);
  });
});
