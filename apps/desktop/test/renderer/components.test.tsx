import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Board } from '../../src/renderer/components/Board.tsx';
import { ConnectionBanner } from '../../src/renderer/components/ConnectionBanner.tsx';
import { NewTicketDialog } from '../../src/renderer/components/NewTicketDialog.tsx';
import { TicketDetailView } from '../../src/renderer/components/TicketDetail.tsx';
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
      expect(commands).toEqual([{ type: 'node.reject', payload: { ticketId: approval.ticket.ticketId, nodeId: 'specApproval', lane: 'main', comment: 'Add undo' } }]);
    });
    await userEvent.click(within(card).getByRole('button', { name: '승인' }));
    await waitFor(() => {
      expect(commands.at(-1)).toEqual({ type: 'node.approve', payload: { ticketId: approval.ticket.ticketId, nodeId: 'specApproval', lane: 'main' } });
    });
  });

  it('finishes a human task with its summary', async () => {
    const { commands } = show(ticketDetail({ reviews: [{ nodeId: 'brainstorming', lane: 'main', run: 1, kind: 'task', inputs: [] }] }));
    const card = await screen.findByRole('article', { name: 'BrainStorming 사람 작업' });
    await userEvent.type(within(card).getByLabelText('요약'), '메모장 앱 아이디어');
    await userEvent.click(within(card).getByRole('button', { name: '완료' }));
    await waitFor(() => {
      expect(commands).toEqual([{ type: 'node.done', payload: { ticketId: approval.ticket.ticketId, nodeId: 'brainstorming', lane: 'main', port: 'done', summary: '메모장 앱 아이디어' } }]);
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
        { type: 'node.retry', payload: { ticketId: detail.ticket.ticketId, nodeId: 'dev', lane: '1' } },
        { type: 'node.resume', payload: { ticketId: detail.ticket.ticketId, nodeId: 'dev', lane: '2' } },
      ]);
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
