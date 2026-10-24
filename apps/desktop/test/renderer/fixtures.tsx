import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { BoardTicketView, TemplateSummary, TicketStats, WorkflowView } from '@vuyro/contracts';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { BridgeResult, ConnectionState, RendererMethod, VuyroBridge } from '../../src/shared/bridge.ts';
import { useUi } from '../../src/renderer/store.ts';
import type { TicketDetail } from '../../src/renderer/types.ts';

/** A fake `window.vuyro` and engine data shaped like the default template, for component tests. */

export const SDLC: WorkflowView = {
  id: 'vuyro/ai-sdlc',
  version: 1,
  hash: 'sha256:abc',
  name: 'AI-Native SDLC',
  description: 'Default workflow',
  nodes: [
    { id: 'brainstorming', label: 'BrainStorming', type: 'vuyro.human-task', typeVersion: 1, completion: 'human', review: 'none', outputs: [{ name: 'done', label: 'Done' }], inputMode: 'none' },
    { id: 'spec', label: 'Spec', type: 'vuyro.agent', typeVersion: 1, completion: 'agent', review: 'none', outputs: [{ name: 'done', label: 'Done' }, { name: 'error', label: 'Could not finish' }], inputMode: 'whole' },
    { id: 'specApproval', label: 'Spec approval', type: 'vuyro.approval', typeVersion: 1, completion: 'human', review: 'none', outputs: [{ name: 'approve', label: 'Approve' }, { name: 'reject', label: 'Reject' }], inputMode: 'whole' },
    { id: 'plan', label: 'Plan', type: 'vuyro.agent', typeVersion: 1, completion: 'agent', review: 'none', outputs: [{ name: 'done', label: 'Done' }], inputMode: 'whole' },
    { id: 'dev', label: 'Dev', type: 'vuyro.agent', typeVersion: 1, completion: 'agent', review: 'none', outputs: [{ name: 'done', label: 'Done' }], inputMode: 'each' },
    { id: 'join', label: 'Join', type: 'vuyro.join', typeVersion: 1, completion: 'join', review: 'none', outputs: [{ name: 'done', label: 'Done' }], inputMode: 'whole' },
    { id: 'qa', label: 'QA', type: 'vuyro.review-agent', typeVersion: 1, completion: 'agent', review: 'human', outputs: [{ name: 'approve', label: 'Approve' }, { name: 'reject', label: 'Reject' }], inputMode: 'whole' },
    { id: 'done', label: 'Done', type: 'vuyro.end', typeVersion: 1, completion: 'join', review: 'none', outputs: [], inputMode: 'whole' },
  ],
  edges: [],
};

export const TEMPLATE: TemplateSummary = SDLC;
const PIN = { id: SDLC.id, version: 1, hash: SDLC.hash };
const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export function boardTicket(patch: Partial<BoardTicketView> & Pick<BoardTicketView, 'ticketId' | 'title'>): BoardTicketView {
  return {
    projectId: 'p1',
    status: 'open',
    priority: 0,
    template: PIN,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    completedAt: null,
    revision: 3,
    attention: null,
    lanes: [],
    tokens: zero,
    ...patch,
  };
}

export const lane = (nodeId: string, status: string, laneName = 'main') => ({ nodeId, lane: laneName, run: 1, status, waitingFor: null, updatedAt: 0 });

export function ticketDetail(patch: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ticket: {
      ticketId: '0190aaaa-bbbb-7ccc-8ddd-eeeeee123456',
      projectId: 'p1',
      title: '메모장 저장',
      description: '저장 기능',
      status: 'open',
      priority: 0,
      template: PIN,
      createdAt: 0,
      updatedAt: 0,
      completedAt: null,
      revision: 9,
      attention: null,
    },
    lanes: [],
    executions: [],
    runs: [],
    waitingFor: [],
    workflow: SDLC,
    reviews: [],
    ...patch,
  };
}

export function ticketStats(patch: Partial<TicketStats> = {}): TicketStats {
  return {
    ticketId: '0190aaaa-bbbb-7ccc-8ddd-eeeeee123456',
    status: 'open',
    createdAt: 0,
    totalMs: 2 * 3600_000 + 14 * 60_000,
    humanWaitMs: 35 * 60_000,
    activeMs: 50 * 60_000,
    tokens: { input: 12_300, cacheRead: 40_000, cacheWrite: 2000, output: 4500, reasoning: 0 },
    agentRuns: 2,
    toolCalls: 7,
    toolErrors: 1,
    messages: 4,
    nodes: [],
    asOf: 0,
    ...patch,
  };
}

export type Handler = (params: unknown) => unknown;

/** Installs a fake bridge. `handlers` answer engine methods; command.execute calls are recorded. */
export function installBridge(handlers: Partial<Record<RendererMethod, Handler>> = {}) {
  const commands: { type: string; payload: unknown }[] = [];
  const request = vi.fn((method: RendererMethod, params?: unknown): Promise<BridgeResult<unknown>> => {
    if (method === 'command.execute') {
      const envelope = params as { type: string; payload: unknown; requestId: string };
      commands.push({ type: envelope.type, payload: envelope.payload });
      const answer = handlers['command.execute']?.(params);
      if (answer instanceof Error) return Promise.resolve({ ok: false, error: { code: (answer as Error & { code?: string }).code ?? 'invariant_violated', message: answer.message, retryable: false } });
      return Promise.resolve({ ok: true, value: { ok: true, result: answer ?? {} } });
    }
    const handler = handlers[method];
    if (handler === undefined) return Promise.resolve({ ok: false, error: { code: 'unknown_command', message: method, retryable: false } });
    return Promise.resolve({ ok: true, value: handler(params) });
  });
  const pair = vi.fn(() => Promise.resolve<BridgeResult<null>>({ ok: true, value: null }));
  const retry = vi.fn(() => Promise.resolve());
  const bridge: VuyroBridge = {
    request,
    subscribe: vi.fn(() => () => undefined),
    connection: () => Promise.resolve(useUi.getState().connection),
    onConnection: () => () => undefined,
    pair,
    retry,
  };
  window.vuyro = bridge;
  return { commands, request, pair, retry };
}

export function setConnection(state: ConnectionState = { phase: 'connected', access: 'write' }): void {
  useUi.setState({ connection: state, projectId: undefined, ticketId: undefined, lastSequence: 0 });
}

export function renderWithClient(element: ReactElement): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
