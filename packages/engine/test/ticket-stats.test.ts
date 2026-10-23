import { afterEach, describe, expect, it } from 'vitest';
import type { DefinitionEnvelope } from '@vuyro/contracts';
import { EngineQueries } from '../src/daemon/queries.ts';
import { computeTicketStats, unionLength } from '../src/stats/ticket-stats.ts';
import type { ScriptedBehavior } from '../src/workflow/scripted-agent.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * Statistics from the events ([[명령·이벤트 계약]] §12): time per node split into queued / running / waiting for a
 * person / paused, tokens and tool calls of the agent runs, the ticket's total and human wait (overlaps once).
 */

const MINUTE = 60_000;

function template(id: string, nodes: unknown[], edges: unknown[]): DefinitionEnvelope {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'template',
    id,
    version: 1,
    name: id,
    content: { id, version: 1, name: id, nodes, edges },
  } as unknown as DefinitionEnvelope;
}

const REVIEWED = template(
  'test/reviewed',
  [
    { id: 'work', type: 'vuyro.agent', version: 1, params: { instructions: 'Do it.' }, review: 'human' },
    { id: 'end', type: 'vuyro.end', version: 1 },
  ],
  [{ from: { node: 'work', port: 'done' }, to: { node: 'end', port: 'in' } }],
);

const FANNED = template(
  'test/fanned',
  [
    { id: 'plan', type: 'vuyro.agent', version: 1, params: { instructions: 'Plan.' } },
    { id: 'dev', type: 'vuyro.agent', version: 1, params: { instructions: 'Build.' }, ports: { in: { mode: 'each' } } },
    { id: 'join', type: 'vuyro.join', version: 1 },
    { id: 'end', type: 'vuyro.end', version: 1 },
  ],
  [
    { from: { node: 'plan', port: 'done' }, to: { node: 'dev', port: 'in' } },
    { from: { node: 'dev', port: 'done' }, to: { node: 'join', port: 'in' } },
    { from: { node: 'join', port: 'done' }, to: { node: 'end', port: 'in' } },
  ],
);

describe('unionLength', () => {
  it.each([
    [[], 0],
    [[{ from: 0, to: 10 }], 10],
    [[{ from: 0, to: 10 }, { from: 5, to: 15 }], 15],
    [[{ from: 20, to: 30 }, { from: 0, to: 10 }], 20],
    [[{ from: 0, to: 30 }, { from: 5, to: 10 }], 30],
    [[{ from: 0, to: 10 }, { from: 10, to: 20 }], 20],
    [[{ from: 5, to: 5 }, { from: 8, to: 3 }], 0],
  ])('%j → %d', (intervals, expected) => {
    expect(unionLength(intervals)).toBe(expected);
  });
});

describe('ticket statistics', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  async function start(definition: DefinitionEnvelope, behavior: ScriptedBehavior, maxConcurrent?: number): Promise<string> {
    h = await openWorkflowHarness({ behavior, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) });
    const saved = await h.writer.save(definition, HUMAN, `save-${definition.id.replace('/', '-')}`);
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const project = await h.ok('project.create', { name: 'sample' });
    const { projectId } = project.result as { projectId: string };
    const ticket = await h.ok('ticket.create', { projectId, title: 'Stats', template: { id: definition.id } });
    return (ticket.result as { ticketId: string }).ticketId;
  }

  const stats = (ticketId: string) => new EngineQueries({ store: h.store, definitions: h.registry, clock: h.clock }).ticketStats(ticketId);

  it('splits a node into running and waiting for a person, with its tokens and tool calls', async () => {
    const ticketId = await start(REVIEWED, async (s) => {
      s.observe({ kind: 'session', providerSessionId: 'th-1', model: 'gpt-6-luna' });
      s.observe({ kind: 'toolCallStarted', toolCallId: 'item_1', name: 'command_execution' });
      s.observe({ kind: 'toolCallFinished', toolCallId: 'item_1', isError: true });
      s.observe({ kind: 'toolCallStarted', toolCallId: 'item_2', name: 'file_change' });
      s.observe({ kind: 'toolCallFinished', toolCallId: 'item_2' });
      s.observe({ kind: 'message', role: 'assistant', text: 'done' });
      await s.sleep(10 * MINUTE);
      // Two turns add up (Codex), and the run reports through `vuyro node done`.
      s.observe({ kind: 'usage', scope: 'turn', tokens: { input: 100, cacheRead: 400, cacheWrite: 0, output: 30, reasoning: 5 } });
      s.observe({ kind: 'usage', scope: 'turn', tokens: { input: 50, cacheRead: 200, cacheWrite: 10, output: 20, reasoning: 0 } });
      await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'work', port: 'done', summary: 'ok' });
      return undefined;
    });
    await h.drive();
    expect(await h.status(ticketId, 'work')).toBe('review');
    await h.clock.advance(15 * MINUTE);
    await h.ok('node.approve', { ticketId, nodeId: 'work' });
    await h.drive();
    await h.clock.advance(60 * MINUTE); // after completion nothing counts any more

    const result = await stats(ticketId);
    expect(result).toMatchObject({
      status: 'done',
      totalMs: 25 * MINUTE,
      humanWaitMs: 15 * MINUTE,
      activeMs: 10 * MINUTE,
      tokens: { input: 150, cacheRead: 600, cacheWrite: 10, output: 50, reasoning: 5 },
      agentRuns: 1,
      toolCalls: 2,
      toolErrors: 1,
      messages: 1,
      bottleneck: 'work',
    });
    expect(result?.costUsd).toBeUndefined();
    const work = result?.nodes.find((node) => node.nodeId === 'work');
    expect(work).toMatchObject({ runningMs: 10 * MINUTE, humanWaitMs: 15 * MINUTE, queuedMs: 0, executions: 1, attempts: 1, decisions: { human: 1, ai: 0 } });
  });

  it('counts parallel lanes per node but once in the ticket active time, and the queue wait when slots are full', async () => {
    const ticketId = await start(
      FANNED,
      async (s) => {
        const { ticketId: id, nodeId } = s.request;
        if (nodeId === 'plan') {
          await s.sleep(5 * MINUTE);
          await s.vuyro('node.done', { ticketId: id, nodeId, port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }] });
        } else {
          const n = /"n": (\d)/.exec(s.request.prompt)?.[1] ?? '1';
          await s.sleep(Number(n) * 10 * MINUTE);
          s.observe({ kind: 'usage', scope: 'run', tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 }, cost: { usd: 0.25, basis: 'list' } });
          await s.vuyro('node.done', { ticketId: id, nodeId, port: 'done', data: { n: Number(n) } });
        }
        return undefined;
      },
      2,
    );
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    const result = await stats(ticketId);
    const dev = result?.nodes.find((node) => node.nodeId === 'dev');
    // Lanes 1 and 2 start together; lane 3 waits for lane 1's slot (10 min), then runs 30 min.
    expect(dev).toMatchObject({ executions: 3, runningMs: 60 * MINUTE, queuedMs: 10 * MINUTE, agentRuns: 3, costUsd: 0.75 });
    expect(result).toMatchObject({ totalMs: 45 * MINUTE, activeMs: 45 * MINUTE, humanWaitMs: 0, bottleneck: 'dev' });
    expect(result?.tokens.input).toBe(30);
  });

  it('without the template, executor nodes are the ones that started (rejected human tasks wait for a person)', () => {
    const at = (minutes: number) => minutes * MINUTE;
    const base = { eventId: 'e', revision: 1, schemaVersion: 1, aggregateType: 'ticket', aggregateId: 't', replicaId: 'r', sequence: 1 };
    const human = { kind: 'human', userId: 'local', via: 'ui' } as const;
    const system = { kind: 'system', component: 'workflow' } as const;
    const exec = { ticketId: 't', lane: 'main' };
    const basis = { groups: [], free: true as const };
    const events = [
      { ...base, type: 'ticket.created', timestamp: at(0), actor: human, data: { ticketId: 't', projectId: 'p', title: 'x' } },
      { ...base, type: 'node.activated', timestamp: at(0), actor: human, data: { ...exec, nodeId: 'task', run: 1, cause: 'start', status: 'review', inputs: {}, basis } },
      { ...base, type: 'node.completed', timestamp: at(4), actor: human, data: { ...exec, nodeId: 'task', run: 1, status: 'done', output: { schemaVersion: 1, port: 'done', items: [] }, routes: [], basis } },
      { ...base, type: 'node.activated', timestamp: at(4), actor: system, data: { ...exec, nodeId: 'task', run: 2, cause: 'rework', status: 'rejected', inputs: {}, basis } },
    ] as unknown as Parameters<typeof computeTicketStats>[0]['ticketEvents'];
    const result = computeTicketStats({ ticketId: 't', ticketEvents: events, runEvents: [], asOf: at(10) });
    expect(result.nodes[0]).toMatchObject({ nodeId: 'task', humanWaitMs: at(10), queuedMs: 0, executions: 2, reworks: 1, decisions: { human: 1, ai: 0 } });
    expect(result).toMatchObject({ status: 'open', totalMs: at(10), humanWaitMs: at(10) });
  });
});
