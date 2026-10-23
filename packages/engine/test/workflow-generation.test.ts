import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResponse, DefinitionEnvelope, TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { ticketWaitReasons } from '../src/workflow/machine.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { JoinOracle } from './helpers/join-oracle.ts';
import { MERGE_NODE_TYPE } from './helpers/merge-node.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * Generation records ([[명령·이벤트 계약]] §10.6 item 3) and the pre-release format rule (§6): what an opener's
 * deliveries belong to, tickets whose log predates the records, and the oracle on nodes with several input ports.
 */

const MINUTE = 60_000;

function expectOk(response: CommandResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`);
}

const edge = (from: string, fromPort: string, to: string, toPort = 'in'): TemplateEdge => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const agent = (id: string, instructions = `do ${id}`, extra: Partial<TemplateNode> = {}): TemplateNode => ({ id, type: 'vuyro.agent', version: 1, params: { instructions }, ...extra });
const human = (id: string): TemplateNode => ({ id, type: 'vuyro.human-task', version: 1 });

function template(id: string, nodes: TemplateNode[], edges: TemplateEdge[]): TemplateDefinition {
  return { vuyro: 'export', formatVersion: 1, kind: 'template', id, version: 1, name: id, content: { id, version: 1, name: id, nodes, edges } };
}

async function save(h: WorkflowHarness, definition: DefinitionEnvelope): Promise<void> {
  expectOk(await h.writer.save(definition, HUMAN, nextRequestId()));
}

async function ticketFor(h: WorkflowHarness, templateId: string): Promise<string> {
  const project = await h.ok('project.create', { name: 'sample' });
  const { projectId } = project.result as { projectId: string };
  const ticket = await h.ok('ticket.create', { projectId, title: 'Ticket', template: { id: templateId } });
  return (ticket.result as { ticketId: string }).ticketId;
}

describe('generation records', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  it('puts everything a plan sends into the generation it opened, even when the plan itself rests on nothing', async () => {
    // Review counterexample (73dc439): the entry plan opens g1 and, in the same completion, sends its plan to a
    // person. The plan rests on nothing (free), but the review belongs to g1: a newer plan takes it along.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { task: 'T1' } }] }));
        else {
          await s.sleep(60 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { done: true } }));
        }
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/plan-review',
        [agent('plan'), human('again'), agent('dev', 'task {{ input.data.task }}', { ports: { in: { mode: 'each' } } }), human('review'), { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('plan', 'done', 'dev'), edge('plan', 'done', 'review'), edge('again', 'done', 'dev'), edge('review', 'done', 'end'), edge('dev', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/plan-review');
    await h.activity.idle();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'plan').executions[0]?.opened).toEqual(['g1']);
    expect(nodeProgress(state, 'review').executions[0]?.basis).toEqual({ groups: ['g1'] });
    expect(await h.status(ticketId, 'review')).toBe('review');
    // A person plans again: a new generation replaces g1, and the review of the old plan goes with it.
    await h.ok('node.done', { ticketId, nodeId: 'again', port: 'done', items: [{ data: { task: 'U1' } }] });
    state = await h.ticket(ticketId);
    expect(currentExecution(state, 'review', 'main')?.status).toBe('superseded');
    expect(currentExecution(state, 'dev', '1')?.status).toBe('superseded');
    expect(currentExecution(state, 'dev', '2')?.status).toBe('queued');
    expect(await h.store.query("SELECT superseded_by FROM p_node_lanes WHERE node_id = 'review'")).toEqual([{ superseded_by: 'replaced' }]);
  });

  it('blocks a ticket whose log has workflow events in a retired format instead of resuming it', async () => {
    let started = 0;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        started += 1;
        await s.sleep(60 * MINUTE);
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
        return undefined;
      },
    });
    await save(h, template('myteam/legacy', [human('start'), agent('write'), human('check'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('start', 'done', 'write'), edge('write', 'done', 'check'), edge('check', 'done', 'end')]));
    const legacy = await ticketFor(h, 'myteam/legacy');
    const current = await ticketFor(h, 'myteam/legacy');
    for (const ticketId of [legacy, current]) await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.activity.idle();
    expect(started).toBe(2);

    // Simulate a development database written before the generation records: v1 workflow events without basis.
    const noUpdate = MIGRATIONS[0]?.find((sql) => sql.includes('events_no_update')) ?? '';
    await h.restart({
      whileClosed: (path) => {
        const db = new DatabaseSync(path);
        try {
          db.exec('DROP TRIGGER events_no_update');
          db.prepare(
            "UPDATE events SET schema_version = 1, data = json_remove(data, '$.basis', '$.openedBy') WHERE aggregate_id = ? AND type IN ('node.activated', 'node.completed', 'node.passedOver')",
          ).run(legacy);
          db.exec(noUpdate);
          db.prepare("UPDATE meta SET value = 'rebuilding' WHERE key = 'projection_state'").run();
        } finally {
          db.close();
        }
      },
    });
    await h.drive();

    // The legacy ticket needs attention: not resumed, its node commands refused, the board shows why.
    const state = await h.ticket(legacy);
    expect(state.attention).toEqual({ reason: 'legacy-events', event: 'node.activated v1' });
    if (state.template === undefined) throw new Error('no template');
    expect(ticketWaitReasons(state, await h.registry.workflow(state.template)).map((reason) => reason.kind)).toEqual(['attention']);
    expect(nodeProgress(await h.ticket(legacy), 'check').executions).toHaveLength(0);
    expect(started).toBe(3); // only the current ticket's interrupted agent was started again
    // The engine leaves the blocked ticket alone: it does not even try (and fail) to start or settle its work.
    // (The old engine's runs, interrupted by the restart, report that its closed database went away: not this.)
    const reported = h.errors.map((entry) => `${entry.context}: ${entry.error.message}`).filter((line) => !line.includes('sqlite worker exited'));
    expect(reported).toEqual([]);
    const refused = await h.exec('node.retry', { ticketId: legacy, nodeId: 'write' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/needs attention: its log has events in an older format \(node\.activated v1\)/);
    expect(await h.store.query('SELECT ticket_id, attention FROM p_tickets ORDER BY attention')).toEqual(
      expect.arrayContaining([
        { ticket_id: legacy, attention: 'legacy-events' },
        { ticket_id: current, attention: null },
      ]),
    );
    // The other ticket carries on.
    expect(await h.status(current, 'check')).toBe('review');
  });

  it('takes nothing on another port from a source whose latest run left elsewhere', async () => {
    // Final review counterexample (b6f6923): 'a' sends yes to m.left, is sent back, and its re-run leaves through no.
    // When the note then activates m on 'right', the left port must not get a's old yes item back.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, run } = s.request;
        if (nodeId === 'a') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: run === 1 ? 'done' : 'error', data: { answer: run === 1 ? 'yes' : 'no' } }));
        else if (nodeId === 'check') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: run === 1 ? 'reject' : 'approve', data: { feedback: 'again' } }));
        else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: nodeId } }));
        return undefined;
      },
    });
    await save(h, MERGE_NODE_TYPE);
    await save(
      h,
      template(
        'myteam/port-switch',
        [
          human('start'),
          human('note'),
          agent('a'),
          { id: 'check', type: 'vuyro.review-agent', version: 1, params: { instructions: 'check' } },
          agent('log'),
          { id: 'm', type: 'myteam.merge', version: 1, params: { instructions: 'merge' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [
          edge('start', 'done', 'a'),
          edge('a', 'done', 'm', 'left'),
          edge('a', 'done', 'check'),
          edge('check', 'reject', 'a'),
          edge('check', 'approve', 'end'),
          edge('a', 'error', 'log'),
          edge('note', 'done', 'm', 'right'),
          edge('m', 'done', 'end'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/port-switch');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.drive();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'a').executions.map((exec) => exec.output?.port)).toEqual(['done', 'error']);
    expect(nodeProgress(state, 'm').executions[0]?.inputs.left?.map((item) => item.data.answer)).toEqual(['yes']);
    await h.ok('node.done', { ticketId, nodeId: 'note', port: 'done', items: [{ data: { from: 'note' } }] });
    await h.drive();
    state = await h.ticket(ticketId);
    const second = nodeProgress(state, 'm').executions[1];
    expect(second?.inputs.right?.map((item) => item.data.from)).toEqual(['note']);
    expect(second?.inputs.left).toEqual([]);
    expect(second?.basis).toEqual({ groups: [], free: true });
  });

  it('checks a node with two input ports: the port it was not activated for counts as consumed too', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        const items = nodeId === 'plan' ? [{ data: { task: 'T1' } }] : [{ data: { from: nodeId } }];
        expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items }));
        return undefined;
      },
    });
    await save(h, MERGE_NODE_TYPE);
    await save(
      h,
      template(
        'myteam/two-ports',
        [
          human('start'),
          agent('plan'),
          agent('dev', 'task {{ input.data.task }}', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'm', type: 'myteam.merge', version: 1, params: { instructions: 'merge' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [
          edge('start', 'done', 'plan'),
          edge('plan', 'done', 'dev'),
          edge('dev', 'done', 'join'),
          edge('join', 'done', 'm', 'right'),
          edge('start', 'done', 'm', 'left'),
          edge('m', 'done', 'end'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/two-ports');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done', items: [{ data: { note: 'n' } }] });
    await h.drive();
    const state = await h.ticket(ticketId);
    const runs = nodeProgress(state, 'm').executions;
    // Activated by the join's delivery on 'right'; 'left' took start's latest delivery, so the record has both.
    expect(runs.at(-1)?.basis).toEqual({ groups: ['g1'], free: true });
    if (state.template === undefined) throw new Error('no template');
    const oracle = new JoinOracle(await h.registry.workflow(state.template));
    for (const event of await h.store.readAggregate(ticketId)) oracle.apply(event);
    expect(oracle.violations).toEqual([]);
    expect(oracle.idleProblems()).toEqual([]);
  });
});
