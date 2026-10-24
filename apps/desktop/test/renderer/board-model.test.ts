import type { WorkflowNodeView } from '@vuyro/contracts';
import { describe, expect, it } from 'vitest';
import { boardSummary, personBadge, priorityForMove, segments, stageColumns, stageHint, statusColumns, ticketPhase, ticketStage } from '../../src/renderer/board-model.ts';
import { errorText, formatDuration, formatTokens, shortId } from '../../src/renderer/format.ts';
import { queryKeysFor } from '../../src/renderer/live.ts';
import { SDLC, boardTicket, lane } from './fixtures.tsx';

describe('board model', () => {
  it('puts a ticket where its earliest unfinished work is', () => {
    expect(ticketStage(boardTicket({ ticketId: 'a', title: 'new', lanes: [lane('brainstorming', 'review')] }), SDLC)).toBe('brainstorming');
    const approving = boardTicket({ ticketId: 'b', title: 'b', lanes: [lane('brainstorming', 'done'), lane('spec', 'done'), lane('specApproval', 'review')] });
    expect(ticketStage(approving, SDLC)).toBe('specApproval');
    // Spec sent back by the approval: the ticket is at Spec again even though later nodes have rows.
    const rework = boardTicket({ ticketId: 'c', title: 'c', lanes: [lane('spec', 'running'), lane('specApproval', 'done'), lane('plan', 'done')] });
    expect(ticketStage(rework, SDLC)).toBe('spec');
    // Parallel Dev: the earliest active lane holds it.
    const parallel = boardTicket({ ticketId: 'd', title: 'd', lanes: [lane('dev', 'running', '1'), lane('dev', 'done', '2'), lane('qa', 'failed')] });
    expect(ticketStage(parallel, SDLC)).toBe('dev');
    // Nothing active (between steps): the furthest node it reached.
    expect(ticketStage(boardTicket({ ticketId: 'e', title: 'e', lanes: [lane('spec', 'done'), lane('brainstorming', 'done')] }), SDLC)).toBe('spec');
    expect(ticketStage(boardTicket({ ticketId: 'f', title: 'f', status: 'done', lanes: [lane('brainstorming', 'done')] }), SDLC)).toBe('done');
    expect(ticketStage(boardTicket({ ticketId: 'g', title: 'g' }), SDLC)).toBe('brainstorming');
  });

  it('makes one column per stage with how it finishes, cards by priority', () => {
    const tickets = [
      boardTicket({ ticketId: 'low', title: 'low', priority: -1, lanes: [lane('specApproval', 'review')] }),
      boardTicket({ ticketId: 'high', title: 'high', priority: 5, lanes: [lane('specApproval', 'review')] }),
    ];
    const columns = stageColumns(SDLC, tickets);
    expect(columns.map((column) => column.title)).toEqual(['BrainStorming', 'Spec', 'Spec approval', 'Plan', 'Dev', 'Join', 'QA', 'Done']);
    expect(columns.map((column) => column.hint)).toEqual(['사람 완료 처리', '자동', '사람 승인', '자동', '자동 · 병렬', '합류', 'AI + 사람 확인', '끝']);
    expect(columns[2]?.tickets.map((ticket) => ticket.ticketId)).toEqual(['high', 'low']);
    expect(stageHint({ ...(SDLC.nodes[1] as WorkflowNodeView), completion: 'script' }).text).toBe('스크립트');
  });

  it('groups tickets by state when all templates are shown', () => {
    const tickets = [
      boardTicket({ ticketId: 'r', title: 'r', lanes: [lane('spec', 'running'), lane('qa', 'review')] }),
      boardTicket({ ticketId: 'x', title: 'x', lanes: [lane('spec', 'running')] }),
      boardTicket({ ticketId: 'f', title: 'f', lanes: [lane('spec', 'failed')] }),
      boardTicket({ ticketId: 'w', title: 'w', lanes: [lane('spec', 'done')] }),
      boardTicket({ ticketId: 'd', title: 'd', status: 'done' }),
      boardTicket({ ticketId: 'a', title: 'a', attention: 'legacy-events' }),
    ];
    expect(tickets.map(ticketPhase)).toEqual(['review', 'running', 'blocked', 'waiting', 'done', 'blocked']);
    expect(statusColumns(tickets).map((column) => [column.title, column.tickets.length])).toEqual([
      ['사람 차례', 1],
      ['실행 중', 1],
      ['막힘', 2],
      ['대기', 1],
      ['완료', 1],
    ]);
  });

  it('colours the progress bar and says what the person has to do', () => {
    const ticket = boardTicket({ ticketId: 's', title: 's', lanes: [lane('brainstorming', 'done'), lane('spec', 'running'), lane('dev', 'failed', '1'), lane('dev', 'done', '2')] });
    expect(segments(ticket, SDLC).map((segment) => segment.tone)).toEqual(['done', 'agent', 'wait', 'wait', 'failed', 'wait', 'wait', 'wait']);
    expect(personBadge(boardTicket({ ticketId: 't', title: 't', lanes: [lane('brainstorming', 'review')] }), SDLC)).toBe('내 작업 필요');
    expect(personBadge(boardTicket({ ticketId: 'u', title: 'u', lanes: [lane('specApproval', 'review')] }), SDLC)).toBe('내 승인 필요');
    expect(personBadge(boardTicket({ ticketId: 'v', title: 'v', lanes: [lane('qa', 'review')] }), SDLC)).toBe('내 승인 필요');
    expect(personBadge(ticket, SDLC)).toBeUndefined();
  });

  it('sums what waits for people, what runs and the tokens', () => {
    const tickets = [
      boardTicket({ ticketId: 'a', title: 'a', lanes: [lane('qa', 'review')], tokens: { input: 100, cacheRead: 50, cacheWrite: 10, output: 40, reasoning: 0 } }),
      boardTicket({ ticketId: 'b', title: 'b', lanes: [lane('dev', 'running', '1'), lane('dev', 'running', '2')] }),
    ];
    expect(boardSummary(tickets)).toEqual({ approvals: 1, running: 2, tokens: 200 });
  });

  it('picks a priority that puts a dragged card between its new neighbours', () => {
    const column = [10, 5, 0, -3].map((priority, index) => boardTicket({ ticketId: `t${index}`, title: `t${index}`, priority }));
    expect(priorityForMove(column, 3, 0)).toBe(11); // to the top
    expect(priorityForMove(column, 0, 3)).toBe(-4); // to the bottom
    expect(priorityForMove(column, 3, 1)).toBe(7); // between 10 and 5
    expect(priorityForMove(column, 0, 0)).toBeUndefined();
    expect(priorityForMove(column, 0, 9)).toBeUndefined();
    const crowded = [1000, 999].map((priority, index) => boardTicket({ ticketId: `c${index}`, title: `c${index}`, priority }));
    expect(priorityForMove(crowded, 1, 0)).toBe(1000); // clamped to the contract's maximum
  });
});

describe('words and numbers', () => {
  it('formats durations, tokens and ids', () => {
    expect(formatDuration(12_000)).toBe('12초');
    expect(formatDuration(35 * 60_000)).toBe('35분');
    expect(formatDuration(2 * 3600_000 + 14 * 60_000)).toBe('2시간 14분');
    expect(formatDuration(3 * 86_400_000 + 4 * 3600_000)).toBe('3일 4시간');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(shortId('0190aaaa-bbbb-7ccc-8ddd-eeeeee123456')).toBe('T-123456');
    expect(errorText({ code: 'forbidden', message: 'unverified callers are read-only' })).toBe('권한이 없습니다: unverified callers are read-only');
    expect(errorText({ code: 'weird', message: 'x' })).toBe('x');
  });

  it('marks only the queries an event batch touches', () => {
    const keys = queryKeysFor([
      { sequence: 1, type: 'node.completed', aggregateId: 't1', aggregateType: 'ticket', data: {} },
      { sequence: 2, type: 'project.created', aggregateId: 'p1', aggregateType: 'project', data: {} },
      { sequence: 3, type: 'command.denied', aggregateId: 'a1', aggregateType: 'audit', data: {} },
    ]);
    expect(keys).toEqual([['ticket', 't1'], ['ticketStats', 't1'], ['artifacts', 't1'], ['board'], ['sharedNodes'], ['projects']]);
  });
});
