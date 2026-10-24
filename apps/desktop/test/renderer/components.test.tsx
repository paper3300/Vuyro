import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Board } from '../../src/renderer/components/Board.tsx';
import { ConnectionBanner } from '../../src/renderer/components/ConnectionBanner.tsx';
import { NewTicketDialog } from '../../src/renderer/components/NewTicketDialog.tsx';
import { SharedNodes } from '../../src/renderer/components/SharedNodes.tsx';
import { STALE_NOTICE, TicketDetailView } from '../../src/renderer/components/TicketDetail.tsx';
import { useUi } from '../../src/renderer/store.ts';
import { SDLC, TEMPLATE, boardTicket, installBridge, lane, renderWithClient, setConnection, ticketDetail, ticketStats } from './fixtures.tsx';

/** Screens against a fake bridge: what they show, and that every button sends the right engine command. */

beforeEach(() => {
  setConnection();
});

describe('board', () => {
  const board = {
    tickets: [
      boardTicket({ ticketId: 't-approve', title: '퀘스트 데이터 정리', lanes: [lane('brainstorming', 'done'), lane('spec', 'done'), lane('specApproval', 'review')], tokens: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, reasoning: 0 } }),
      boardTicket({ ticketId: 't-dev', title: '인벤토리 정렬', lanes: [lane('dev', 'running', '1'), lane('dev', 'done', '2')] }),
      boardTicket({ ticketId: 't-other', title: '다른 템플릿', template: { id: 'test/other', version: 1, hash: 'sha256:x' } }),
    ],
    workflows: { 'vuyro/ai-sdlc@1': SDLC },
  };

  it('shows stage columns of the main template with cards where their work is', async () => {
    installBridge({ 'query.board': () => board });
    renderWithClient(<Board projectId="p1" />);
    const approval = await screen.findByRole('region', { name: 'Spec approval' });
    const card = within(approval).getByRole('article', { name: '퀘스트 데이터 정리' });
    expect(within(card).getByText('내 승인 필요')).toBeInTheDocument();
    expect(within(card).getByText('토큰 3.5k')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Dev' })).getByRole('article', { name: '인벤토리 정렬' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Dev' })).getByText('Dev 1 실행 중')).toBeInTheDocument();
    expect(screen.getByText('다른 템플릿의 티켓 1건은 이 보드에 없습니다. 「전체」로 모두 볼 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByText('사람 차례 1건')).toBeInTheDocument();
  });

  it('switches to state columns for all templates', async () => {
    installBridge({ 'query.board': () => board });
    renderWithClient(<Board projectId="p1" />);
    await screen.findByRole('region', { name: 'Spec approval' });
    await userEvent.selectOptions(screen.getByLabelText('템플릿 필터'), '*');
    expect(within(screen.getByRole('region', { name: '사람 차례' })).getByRole('article', { name: '퀘스트 데이터 정리' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '실행 중' })).getByRole('article', { name: '인벤토리 정렬' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '대기' })).getByRole('article', { name: '다른 템플릿' })).toBeInTheDocument();
  });

  it('opens a ticket when its card is clicked', async () => {
    installBridge({ 'query.board': () => board });
    renderWithClient(<Board projectId="p1" />);
    await userEvent.click(await screen.findByRole('article', { name: '인벤토리 정렬' }));
    expect(useUi.getState().ticketId).toBe('t-dev');
  });

  it('a read-only connection cannot create tickets', async () => {
    setConnection({ phase: 'connected', access: 'read-only' });
    installBridge({ 'query.board': () => board });
    renderWithClient(<Board projectId="p1" />);
    expect(await screen.findByRole('button', { name: '+ 새 티켓' })).toBeDisabled();
  });
});

describe('new ticket', () => {
  it('creates a ticket from a title and a template card, no YAML', async () => {
    const other = { ...TEMPLATE, id: 'test/small', name: 'Small task', description: 'One agent', nodes: TEMPLATE.nodes.slice(1, 2) };
    const { commands } = installBridge({ 'query.templates': () => ({ templates: [TEMPLATE, other] }), 'command.execute': () => ({ ticketId: 'new-ticket' }) });
    renderWithClient(<NewTicketDialog projectId="p1" onClose={() => undefined} />);
    expect(await screen.findByText('AI-Native SDLC')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /AI-Native SDLC/ })).toBeChecked();
    const create = screen.getByRole('button', { name: '티켓 만들기' });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText('제목'), '메모장 저장 기능');
    await userEvent.type(screen.getByLabelText('설명'), 'Ctrl+S');
    await userEvent.click(screen.getByRole('radio', { name: /Small task/ }));
    await userEvent.selectOptions(screen.getByRole('combobox'), '10');
    await userEvent.click(create);
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'ticket.create', payload: { projectId: 'p1', title: '메모장 저장 기능', description: 'Ctrl+S', template: { id: 'test/small', version: 1 }, priority: 10 } }]);
    });
    expect(useUi.getState().ticketId).toBe('new-ticket');
  });

  it('shows the engine refusal instead of closing', async () => {
    installBridge({ 'query.templates': () => ({ templates: [TEMPLATE] }), 'command.execute': () => new Error('template not active') });
    renderWithClient(<NewTicketDialog projectId="p1" onClose={() => undefined} />);
    await userEvent.type(await screen.findByLabelText('제목'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '티켓 만들기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지금 상태에서는 할 수 없습니다: template not active');
  });
});

describe('ticket detail', () => {
  const approval = ticketDetail({
    lanes: [{ nodeId: 'specApproval', lane: 'main', laneGroup: null, run: 1, status: 'review', executor: null, runId: null, attempt: 0, pauseRequested: 0, supersededBy: null, waitingFor: null, updatedAt: 0 }],
    reviews: [
      {
        nodeId: 'specApproval',
        lane: 'main',
        run: 1,
        kind: 'approval',
        inputs: [{ summary: '<img src=x onerror=alert(1)><b>스펙</b>', data: { title: '메모장' }, artifacts: { specDoc: { kind: 'file', uri: 'docs/spec.md', version: 'v1' } } }],
      },
    ],
    waitingFor: [{ nodeId: 'specApproval', lane: 'main', run: 1, kind: 'active', status: 'review' }],
    executions: [
      { nodeId: 'spec', run: 1, lane: 'main', cause: 'input', status: 'superseded', port: null, itemCount: null, attempts: 1, activatedAt: 0, startedAt: 0, reviewAt: null, finishedAt: 10, error: null, supersededBy: 'new-input' },
      { nodeId: 'spec', run: 2, lane: 'main', cause: 'input', status: 'done', port: 'done', itemCount: 1, attempts: 1, activatedAt: 10, startedAt: 10, reviewAt: null, finishedAt: 20, error: null, supersededBy: null },
    ],
  });
  const stats = ticketStats({
    bottleneck: 'spec',
    nodes: [{ nodeId: 'spec', queuedMs: 0, runningMs: 40 * 60_000, humanWaitMs: 0, pausedMs: 0, tokens: { input: 12_300, cacheRead: 40_000, cacheWrite: 2000, output: 4500, reasoning: 0 }, agentRuns: 2, toolCalls: 7, toolErrors: 1, messages: 4, executions: 2, attempts: 2, failed: 0, reworks: 1, decisions: { human: 0, ai: 0 } }],
  });

  function show(detail = approval) {
    const bridge = installBridge({ 'query.ticket': () => detail, 'query.ticketStats': () => stats, 'query.artifacts': () => ({ artifacts: [] }) });
    renderWithClient(<TicketDetailView ticketId={detail.ticket.ticketId} onClose={() => undefined} />);
    return bridge;
  }

  it('shows total time, people wait, tokens and the bottleneck node', async () => {
    show();
    const tiles = await screen.findByRole('region', { name: '티켓 통계' });
    expect(within(tiles).getByText('2시간 14분')).toBeInTheDocument();
    expect(within(tiles).getByText('35분')).toBeInTheDocument();
    expect(within(tiles).getByText('12k/42k/4.5k')).toBeInTheDocument();
    expect(within(tiles).getByText('Spec')).toBeInTheDocument();
    const nodes = screen.getByRole('region', { name: '노드' });
    const specRow = within(nodes).getByRole('button', { name: /Spec\s*병목/ }).closest('tr');
    expect(specRow).not.toBeNull();
    expect(within(specRow as HTMLElement).getByText('40분')).toBeInTheDocument();
    expect(within(specRow as HTMLElement).getByText('7 (실패 1)')).toBeInTheDocument();
    expect(within(specRow as HTMLElement).getByText('2 (재작업 1)')).toBeInTheDocument();
  });

  it('shows why an execution was cut short', async () => {
    show();
    await userEvent.click(await screen.findByRole('button', { name: /Spec\s*병목/ }));
    expect(screen.getByRole('list', { name: 'Spec 실행 기록' })).toHaveTextContent('새 입력이 와서 밀려남');
  });

  it('shows agent output as text, never as HTML', async () => {
    show();
    expect(await screen.findByText('<img src=x onerror=alert(1)><b>스펙</b>')).toBeInTheDocument();
    expect(document.body.querySelector('img')).toBeNull();
    expect([...document.body.querySelectorAll('b')].map((element) => element.textContent)).not.toContain('스펙');
    expect(screen.getByText(/docs\/spec\.md @ v1/)).toBeInTheDocument();
  });

  it('approves and rejects through the command API, with the comment', async () => {
    const { commands } = show();
    const card = await screen.findByRole('article', { name: 'Spec approval 승인' });
    await userEvent.type(within(card).getByLabelText('의견'), 'Add undo');
    await userEvent.click(within(card).getByRole('button', { name: '반려' }));
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'node.reject', payload: { ticketId: approval.ticket.ticketId, nodeId: 'specApproval', lane: 'main', run: 1, comment: 'Add undo' } }]);
    });
    await userEvent.click(within(card).getByRole('button', { name: '승인' }));
    await waitFor(() => {
      expect(commands.at(-1)).toEqual({ type: 'node.approve', payload: { ticketId: approval.ticket.ticketId, nodeId: 'specApproval', lane: 'main', run: 1 } });
    });
  });

  it('finishes a human task with its summary', async () => {
    const { commands } = show(ticketDetail({ reviews: [{ nodeId: 'brainstorming', lane: 'main', run: 1, kind: 'task', inputs: [] }] }));
    const card = await screen.findByRole('article', { name: 'BrainStorming 사람 작업' });
    await userEvent.type(within(card).getByLabelText('요약'), '메모장 앱 아이디어');
    await userEvent.click(within(card).getByRole('button', { name: '완료' }));
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'node.done', payload: { ticketId: approval.ticket.ticketId, nodeId: 'brainstorming', lane: 'main', run: 1, port: 'done', summary: '메모장 앱 아이디어' } }]);
    });
  });

  it('a review gate shows the held result and says when it is empty', async () => {
    show(ticketDetail({ reviews: [{ nodeId: 'qa', lane: 'main', run: 1, kind: 'gate', output: { port: 'approve', items: [] }, reason: 'empty', feedback: '테스트 추가' }] }));
    const card = await screen.findByRole('article', { name: 'QA 결과 확인' });
    expect(within(card).getByText('이 결과는 다음 노드로 보낼 아이템이 없습니다. 승인하면 빈 결과로 넘어갑니다.')).toBeInTheDocument();
    expect(within(card).getByText('테스트 추가')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '반려 (다시 실행)' })).toBeEnabled();
  });

  it('offers retry for failures and resume for pauses, and shows the claim a lane waits for', async () => {
    const detail = ticketDetail({
      lanes: [
        { nodeId: 'dev', lane: '1', laneGroup: 'g', run: 1, status: 'failed', executor: 'agent', runId: null, attempt: 1, pauseRequested: 0, supersededBy: null, waitingFor: null, updatedAt: 0 },
        { nodeId: 'dev', lane: '2', laneGroup: 'g', run: 2, status: 'paused', executor: 'agent', runId: null, attempt: 1, pauseRequested: 0, supersededBy: null, waitingFor: { paths: ['src/a.ts'] }, updatedAt: 0 },
      ],
      waitingFor: [
        { nodeId: 'dev', lane: '1', run: 1, kind: 'failed', status: 'failed' },
        { nodeId: 'dev', lane: '2', run: 2, kind: 'active', status: 'paused' },
      ],
    });
    const { commands } = show(detail);
    const holdups = await screen.findByRole('region', { name: '대기 사유' });
    expect(holdups).toHaveTextContent('다른 티켓이 쥔 파일을 기다림: src/a.ts');
    await userEvent.click(within(holdups).getByRole('button', { name: '다시 시도' }));
    await userEvent.click(within(holdups).getByRole('button', { name: '재개' }));
    await waitFor(() => {
      expect(commands).toEqual([
        { type: 'node.retry', payload: { ticketId: detail.ticket.ticketId, nodeId: 'dev', lane: '1', run: 1 } },
        { type: 'node.resume', payload: { ticketId: detail.ticket.ticketId, nodeId: 'dev', lane: '2', run: 2 } },
      ]);
    });
  });

  it('a decision refused because the screen was behind refreshes the ticket and says so', async () => {
    let fetched = 0;
    const second = ticketDetail({ reviews: approval.reviews.map((review) => ({ ...review, run: 2 })) });
    installBridge({
      'query.ticket': () => (++fetched === 1 ? approval : second),
      'query.ticketStats': () => stats,
      'query.artifacts': () => ({ artifacts: [] }),
      'query.sharedNodes': () => ({ sharedNodes: [] }),
      'command.execute': () => Object.assign(new Error('lane main of node specApproval is on execution 2 now, not 1'), { code: 'revision_conflict' }),
    });
    renderWithClient(<TicketDetailView ticketId={approval.ticket.ticketId} onClose={() => undefined} />);
    const card = await screen.findByRole('article', { name: 'Spec approval 승인' });
    await userEvent.click(within(card).getByRole('button', { name: '승인' }));
    expect(await screen.findByText(STALE_NOTICE)).toBeInTheDocument();
    await waitFor(() => {
      expect(fetched).toBeGreaterThan(1);
    });
  });

  it('read-only: decisions are visible but cannot be sent', async () => {
    setConnection({ phase: 'connected', access: 'read-only' });
    show();
    const card = await screen.findByRole('article', { name: 'Spec approval 승인' });
    expect(within(card).getByRole('button', { name: '승인' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: '반려' })).toBeDisabled();
  });
});

describe('connection banner', () => {
  it('says nothing when the app can write', () => {
    installBridge();
    const { container } = renderWithClient(<ConnectionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('read-only: offers pairing, then shows the dialog code', async () => {
    setConnection({ phase: 'connected', access: 'read-only', message: '읽기 전용으로 연결했습니다.' });
    const { pair } = installBridge();
    const view = renderWithClient(<ConnectionBanner />);
    await userEvent.click(screen.getByRole('button', { name: '권한 연결' }));
    expect(pair).toHaveBeenCalledTimes(1);
    setConnection({ phase: 'connected', access: 'read-only', pairing: { code: '4821', expiresAt: 0 } });
    view.rerender(<ConnectionBanner />);
    expect(screen.getByLabelText('확인 코드')).toHaveTextContent('4821');
  });

  it('offline: retries on request', async () => {
    setConnection({ phase: 'offline', access: 'none', message: '엔진 연결이 끊겼습니다. 다시 연결합니다.' });
    const { retry } = installBridge();
    renderWithClient(<ConnectionBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('엔진 연결이 끊겼습니다.');
    await userEvent.click(screen.getByRole('button', { name: '지금 다시 시도' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('shared nodes', () => {
  const blocked = {
    projectId: 'p1',
    name: 'build',
    label: 'Unreal 빌드',
    version: 1,
    spec: {},
    status: 'blocked' as const,
    blocked: { reason: 'blamed', batch: 4, by: [{ ticketId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeaaaaaa', nodeId: 'build', lane: 'main', run: 1 }] },
    queue: [
      { ticketId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeebbbbbb', nodeId: 'build', lane: 'main', run: 1, position: 1, queuedAt: 0, retry: true },
      { ticketId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeecccccc', nodeId: 'build', lane: 'main', run: 1, position: 2, queuedAt: 0, retry: true },
    ],
    running: [],
    recent: [{ batch: 4, batchId: 'b4', trigger: 'count', members: [], startedAt: 0, finishedAt: 10, outcome: 'failed' as const, errorFiles: ['Source/Inventory.cpp'] }],
  };
  const idle = { ...blocked, name: 'lint', label: '린트', status: 'idle' as const, blocked: undefined, queue: [], recent: [] };

  it('shows why a shared node is blocked, by which ticket, how many wait, and unblocks it as the person', async () => {
    const { commands } = installBridge({ 'query.sharedNodes': () => ({ sharedNodes: [blocked, idle] }), 'command.execute': () => ({ unblocked: true }) });
    renderWithClient(<SharedNodes projectId="p1" />);
    const card = await screen.findByRole('article', { name: '공유 노드 Unreal 빌드' });
    expect(card).toHaveTextContent('막힘');
    expect(card).toHaveTextContent('빌드가 깨졌고 원인으로 추정한 티켓이 고쳐질 때까지 멈췄습니다. (묶음 #4)');
    expect(card).toHaveTextContent('대기 요청 2건');
    expect(card).toHaveTextContent('오류 파일 Source/Inventory.cpp');
    expect(screen.getByRole('article', { name: '공유 노드 린트' })).toHaveTextContent('대기 중');
    await userEvent.click(within(card).getByRole('button', { name: 'T-aaaaaa' }));
    expect(useUi.getState().ticketId).toBe('0190aaaa-bbbb-7ccc-8ddd-eeeeeeaaaaaa');
    await userEvent.click(within(card).getByRole('button', { name: '풀기' }));
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'sharedNode.unblock', payload: { projectId: 'p1', name: 'build' } }]);
    });
  });

  it('in a ticket, shows only the shared nodes it waits on or is blamed by, with its place in the queue', async () => {
    installBridge({ 'query.sharedNodes': () => ({ sharedNodes: [blocked, idle] }) });
    renderWithClient(<SharedNodes projectId="p1" ticketId="0190aaaa-bbbb-7ccc-8ddd-eeeeeecccccc" />);
    const card = await screen.findByRole('article', { name: '공유 노드 Unreal 빌드' });
    expect(card).toHaveTextContent('이 티켓은 2번째');
    expect(screen.queryByRole('article', { name: '공유 노드 린트' })).toBeNull();
  });

  it('cannot unblock without the person credential', async () => {
    setConnection({ phase: 'connected', access: 'read-only' });
    installBridge({ 'query.sharedNodes': () => ({ sharedNodes: [blocked] }) });
    renderWithClient(<SharedNodes projectId="p1" />);
    expect(await screen.findByRole('button', { name: '풀기' })).toBeDisabled();
  });
});
