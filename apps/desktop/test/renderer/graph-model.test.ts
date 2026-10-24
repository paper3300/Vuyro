import type { NodeStats, RunLogEntry, WorkflowView } from '@vuyro/contracts';
import { describe, expect, it } from 'vitest';
import { focusNode, graphModel, initialViewport, layoutWorkflow, READABLE_ZOOM } from '../../src/renderer/graph-model.ts';
import { buildLogRows, firstLine, formatToolDuration } from '../../src/renderer/run-log-model.ts';
import { lane, SDLC_WITH_EDGES } from './fixtures.tsx';

/** The canvas and the run log as data: layout, painting, loop edges, and log rows. */

const node = (id: string, patch: Partial<WorkflowView['nodes'][number]> = {}): WorkflowView['nodes'][number] => ({
  id,
  label: id,
  type: 'vuyro.agent',
  typeVersion: 1,
  completion: 'agent',
  review: 'none',
  outputs: [{ name: 'done', label: 'Done' }],
  inputMode: 'whole',
  ...patch,
});

const edge = (from: string, to: string, patch: Partial<WorkflowView['edges'][number]> = {}): WorkflowView['edges'][number] => ({
  from: { node: from, port: 'done' },
  to: { node: to, port: 'in' },
  back: false,
  ...patch,
});

describe('graph layout', () => {
  it("uses the template's positions when every node has one", () => {
    const positions = layoutWorkflow(SDLC_WITH_EDGES);
    expect(positions.get('brainstorming')).toEqual({ x: 0, y: 0 });
    expect(positions.get('done')).toEqual({ x: 1680, y: 0 });
  });

  it('places nodes without positions by stage: columns by longest forward path, rows centred; loops do not count', () => {
    const workflow: WorkflowView = {
      id: 't/x',
      version: 1,
      hash: 'sha256:x',
      name: 'x',
      nodes: [node('a'), node('b'), node('c'), node('d', { position: { x: 5, y: 5 } })],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'a', { back: true })],
    };
    const positions = layoutWorkflow(workflow);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')).toEqual({ x: 250, y: -68 });
    expect(positions.get('c')).toEqual({ x: 250, y: 68 });
    expect(positions.get('d')).toEqual({ x: 500, y: 0 });
  });
});

describe('graph painting', () => {
  it('paints nodes by their lanes: a person, agents at work, done, failed, and waiting', () => {
    const lanes = [
      { nodeId: 'brainstorming', lane: 'main', status: 'done' },
      { nodeId: 'specApproval', lane: 'main', status: 'review' },
      { nodeId: 'dev', lane: '1', status: 'running' },
      { nodeId: 'dev', lane: '2', status: 'done' },
      { nodeId: 'dev', lane: '3', status: 'done' },
      { nodeId: 'plan', lane: 'main', status: 'failed' },
    ];
    const { nodes } = graphModel(SDLC_WITH_EDGES, lanes);
    const byId = new Map(nodes.map((each) => [each.id, each]));
    expect(byId.get('brainstorming')).toMatchObject({ tone: 'done', state: '완료' });
    expect(byId.get('specApproval')).toMatchObject({ tone: 'human', state: '사람 차례', hint: { text: '사람 승인' } });
    expect(byId.get('dev')).toMatchObject({ tone: 'agent', state: '실행 중 1 · 완료 2', hint: { text: '자동 · 병렬' } });
    expect(byId.get('plan')).toMatchObject({ tone: 'failed', state: '실패' });
    expect(byId.get('qa')).toMatchObject({ tone: 'wait', state: '' });
  });

  it('shows time and tokens when the ticket has statistics', () => {
    const stats = { nodeId: 'spec', runningMs: 125_000, humanWaitMs: 0, tokens: { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200, reasoning: 0 } } as unknown as NodeStats;
    const spec = graphModel(SDLC_WITH_EDGES, [], [stats]).nodes.find((each) => each.id === 'spec');
    expect(spec?.metric).toBe('2분 · 1.7k tok');
  });

  it('marks rework loops and labels decisions by port; an edge label wins', () => {
    const { edges } = graphModel(SDLC_WITH_EDGES);
    const loops = edges.filter((each) => each.back).map((each) => [each.source, each.target, each.label]);
    expect(loops).toEqual([
      ['specApproval', 'spec', 'rework'],
      ['qa', 'dev', 'rework (rejected tasks only)'],
    ]);
    expect(edges.find((each) => each.source === 'specApproval' && !each.back)?.label).toBe('Approve');
    expect(edges.find((each) => each.source === 'brainstorming')?.label).toBeUndefined();
  });
});

describe('first view of the canvas', () => {
  it('opens on what holds the ticket up: the first node neither waiting nor done', () => {
    const { nodes } = graphModel(SDLC_WITH_EDGES, [lane('brainstorming', 'done'), lane('spec', 'done'), lane('specApproval', 'review')]);
    expect(focusNode(nodes)).toBe('specApproval');
    expect(focusNode(graphModel(SDLC_WITH_EDGES).nodes)).toBe('brainstorming');
    expect(focusNode([])).toBeUndefined();
  });

  it('fits a graph that is readable whole; otherwise readable size centred on the focus, never past the ends', () => {
    expect(initialViewport({ x: 0, y: 0, width: 600, height: 96 }, { width: 900, height: 400 }, undefined)).toBeUndefined();
    const wide = { x: 0, y: 0, width: 1864, height: 96 };
    const view = { width: 700, height: 440 };
    const middle = initialViewport(wide, view, { x: 960, y: 0 });
    expect(middle?.zoom).toBe(READABLE_ZOOM);
    // The focus node's centre sits in the middle of the view.
    expect(Math.round((960 + 92) * READABLE_ZOOM + (middle?.x ?? 0))).toBe(350);
    expect(middle?.y).toBe(Math.round(220 - 48 * READABLE_ZOOM));
    // At the start the graph's left end stays at the margin; at the end its right end does.
    expect(initialViewport(wide, view, { x: 0, y: 0 })?.x).toBe(24);
    const end = initialViewport(wide, view, { x: 1680, y: 0 });
    expect(Math.round((end?.x ?? 0) + 1864 * READABLE_ZOOM)).toBe(700 - 24);
  });
});

describe('run log rows', () => {
  const at = (revision: number, ms: number) => ({ revision, sequence: 100 + revision, at: ms });
  const text = (value: string, length = value.length) => ({ text: value, length });

  it('joins a tool call with its result: how long it took and the first line of the result', () => {
    const entries: RunLogEntry[] = [
      { ...at(1, 1000), kind: 'started', provider: 'claude' },
      { ...at(2, 1100), kind: 'toolStarted', toolCallId: 't1', name: 'Bash', input: text('{"command":"build"}') },
      { ...at(3, 1200), kind: 'message', role: 'assistant', messageId: 'm1', text: text('Building') },
      { ...at(4, 3600), kind: 'toolFinished', toolCallId: 't1', isError: true, output: text('\n  error C2065: x undeclared\nmore') },
      { ...at(5, 3700), kind: 'toolFinished', toolCallId: 'lost', isError: false },
      { ...at(6, 3800), kind: 'settled', outcome: 'failed', terminalReason: 'error', error: text('exit 1') },
    ];
    const rows = buildLogRows(entries);
    expect(rows.map((row) => row.kind)).toEqual(['note', 'tool', 'message', 'tool', 'note']);
    expect(rows[1]).toMatchObject({ kind: 'tool', name: 'Bash', finished: true, isError: true, durationMs: 2500, summary: 'error C2065: x undeclared', outputRevision: 4, inputRevision: 2 });
    expect(rows[3]).toMatchObject({ kind: 'tool', name: 'lost', finished: true });
    expect(rows[4]).toMatchObject({ kind: 'note', tone: 'error', text: '실행이 실패로 끝났습니다 · error', detail: { text: 'exit 1' } });
  });

  it('a tool still running has no result yet', () => {
    const rows = buildLogRows([{ ...at(1, 0), kind: 'toolStarted', toolCallId: 't', name: 'Read' }]);
    expect(rows[0]).toMatchObject({ kind: 'tool', finished: false, isError: false });
  });

  it('joins lines of one provider message, keeps others apart, and keeps the full length', () => {
    const rows = buildLogRows([
      { ...at(1, 0), kind: 'message', role: 'assistant', messageId: 'm1', text: text('one') },
      { ...at(2, 0), kind: 'message', role: 'assistant', messageId: 'm1', text: text('two', 9000) },
      { ...at(3, 0), kind: 'message', role: 'assistant', messageId: 'm2', text: text('three') },
      { ...at(4, 0), kind: 'message', role: 'user', text: text('four') },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'message', text: { text: 'one\ntwo', length: 9004 }, revisions: [1, 2] });
  });

  it('words for usage, warnings and how a run ended', () => {
    const rows = buildLogRows([
      { ...at(1, 0), kind: 'usage', scope: 'run', tokens: { input: 1200, cacheRead: 300, cacheWrite: 0, output: 450 } },
      { ...at(2, 0), kind: 'warning', message: text('slow'), source: 'rate' },
      { ...at(3, 0), kind: 'settled', outcome: 'succeeded' },
    ]);
    expect(rows.map((row) => (row.kind === 'note' ? [row.tone, row.text] : row.kind))).toEqual([
      ['info', '실행 전체 토큰 · 입력 1.2k · 캐시 300 · 출력 450'],
      ['warn', '경고 (rate)'],
      ['done', '실행이 끝났습니다 (성공)'],
    ]);
  });

  it('short summaries and durations', () => {
    expect(firstLine('\n\n  hello  \nworld')).toBe('hello');
    expect(firstLine('   ')).toBeUndefined();
    expect(firstLine('x'.repeat(200))).toHaveLength(161);
    expect(formatToolDuration(850)).toBe('850ms');
    expect(formatToolDuration(12_400)).toBe('12.4s');
    expect(formatToolDuration(130_000)).toBe('2m 10s');
    expect(formatToolDuration(undefined)).toBe('');
  });
});
