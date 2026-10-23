import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResponse, DefinitionEnvelope, TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import type { WorkspaceTarget } from '../src/workflow/engine.ts';
import type { ScriptedBehavior } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/** Edge cases of routing: empty fan-out outputs, rejections that arrive after a new plan, workspaces. */

const MINUTE = 60_000;

function expectOk(response: CommandResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`);
}

const edge = (from: string, fromPort: string, to: string, toPort = 'in'): TemplateEdge => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const agent = (id: string, instructions = `do ${id}`, extra: Partial<TemplateNode> = {}): TemplateNode => ({ id, type: 'vuyro.agent', version: 1, params: { instructions }, ...extra });

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

describe('routing edge cases', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  it('holds an empty fan-out for a person: reject runs the plan again, approve skips the fan-out', async () => {
    const checkInputs: number[] = [];
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [] }));
        else if (nodeId === 'check') {
          checkInputs.push(Number(/checking (\d+) items/.exec(s.request.prompt)?.[1]));
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done' }));
        } else throw new Error(`unexpected ${nodeId}`);
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/empty',
        [
          agent('plan'),
          agent('work', 'work', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          agent('check', 'checking {{ inputs.in.length }} items'),
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('plan', 'done', 'work'), edge('work', 'done', 'join'), edge('join', 'done', 'check'), edge('check', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/empty');
    await h.drive();
    expect(await h.status(ticketId, 'plan')).toBe('review');
    let events = await h.store.readAggregate(ticketId);
    expect(events.find((event) => event.type === 'node.reviewRequested')?.data).toMatchObject({ reason: 'empty', output: { items: [] } });

    await h.ok('node.reject', { ticketId, nodeId: 'plan', comment: 'there must be at least one task' });
    await h.drive();
    expect(nodeProgress(await h.ticket(ticketId), 'plan').executions.map((exec) => exec.status)).toEqual(['discarded', 'review']);

    await h.ok('node.approve', { ticketId, nodeId: 'plan', comment: 'nothing to do, skip' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'work').laneOrder).toEqual([]);
    expect(nodeProgress(state, 'join').executions[0]?.output?.items).toEqual([]);
    expect(checkInputs).toEqual([0]);
    expect(state.status).toBe('done');
    events = await h.store.readAggregate(ticketId);
    expect(events.filter((event) => event.type === 'node.passedOver').map((event) => event.data.nodeId)).toEqual(['work']);
  });

  it('lets a person finish a human node with no items, which skips what it would feed', async () => {
    h = await openWorkflowHarness();
    await save(
      h,
      template(
        'myteam/empty-human',
        [
          { id: 'list', type: 'vuyro.human-task', version: 1 },
          { id: 'each', type: 'vuyro.human-task', version: 1, ports: { in: { mode: 'each' } } },
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('list', 'done', 'each'), edge('each', 'done', 'join'), edge('join', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/empty-human');
    await h.ok('node.done', { ticketId, nodeId: 'list', port: 'done', items: [] });
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('drops a rejection that answers lanes of an older plan, keeping the new plan lanes and their join', async () => {
    let planRun = 0;
    const behavior: ScriptedBehavior = async (s) => {
      const { ticketId, nodeId, run } = s.request;
      switch (nodeId) {
        case 'plan': {
          planRun += 1;
          const prefix = planRun === 1 ? 'T' : 'U';
          if (planRun > 1) await s.sleep(MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [1, 2].map((n) => ({ data: { taskId: `${prefix}${n}` } })) }));
          return undefined;
        }
        case 'dev': {
          const taskId = /task (\w+)/.exec(s.request.prompt)?.[1] ?? '?';
          if (taskId.startsWith('U')) await s.sleep(30 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId } }));
          return undefined;
        }
        case 'qa':
          if (run === 1) expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'reject', items: [{ pairedInput: 0, data: { feedback: 'redo T1' } }] }));
          else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'approve' }));
          return undefined;
        default:
          throw new Error(`unexpected ${nodeId}`);
      }
    };
    h = await openWorkflowHarness({ behavior });
    await save(
      h,
      template(
        'myteam/replan',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          { id: 'replan', type: 'vuyro.human-task', version: 1 },
          agent('plan'),
          agent('dev', 'task {{ nodes.plan.item.data.taskId }}', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'qa', type: 'vuyro.review-agent', version: 1, review: 'human', params: { instructions: 'check' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [
          edge('start', 'done', 'plan'),
          edge('replan', 'done', 'plan'),
          edge('plan', 'done', 'dev'),
          edge('dev', 'done', 'join'),
          edge('join', 'done', 'qa'),
          edge('qa', 'approve', 'end'),
          edge('qa', 'reject', 'dev'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/replan');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.drive();
    // QA's rejection of T1 waits for a person; meanwhile someone asks for a new plan.
    expect(await h.status(ticketId, 'qa')).toBe('review');
    await h.ok('node.done', { ticketId, nodeId: 'replan', port: 'done' });
    await h.activity.idle();
    await h.clock.advance(2 * MINUTE);
    await h.activity.idle();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').laneOrder).toEqual(['1', '2', '3', '4']);
    expect(currentExecution(state, 'dev', '3')?.status).toBe('running');

    // The old rejection arrives now. Its lanes belong to the old plan: it is recorded as stale and goes nowhere.
    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').laneOrder).toEqual(['1', '2', '3', '4']);
    const qaDone = (await h.store.readAggregate(ticketId)).filter((event) => event.type === 'node.completed' && event.data.nodeId === 'qa').at(-1);
    expect(qaDone?.type === 'node.completed' ? qaDone.data : undefined).toMatchObject({ output: { port: 'reject' }, routes: [], stale: [{ to: 'dev', items: [0] }] });

    await h.drive();
    state = await h.ticket(ticketId);
    const joins = nodeProgress(state, 'join').executions;
    expect(joins.at(-1)?.output?.items.map((item) => item.data.taskId)).toEqual(['U1', 'U2']);
    expect(await h.status(ticketId, 'qa')).toBe('review');
    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('tells the workspace resolver which execution it serves', async () => {
    const targets: WorkspaceTarget[] = [];
    h = await openWorkflowHarness({
      workspace: (target) => {
        targets.push(target);
        return `C:/work/${target.nodeId}-${target.lane}`;
      },
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }] }));
        else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done' }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/ws',
        [agent('plan'), agent('work', 'work', { ports: { in: { mode: 'each' } } }), { id: 'join', type: 'vuyro.join', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('plan', 'done', 'work'), edge('work', 'done', 'join'), edge('join', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/ws');
    await h.drive();
    expect(targets.map((target) => `${target.nodeId}/${target.lane}/${target.run}/${target.attempt}`)).toEqual(['plan/main/1/1', 'work/1/1/1', 'work/2/2/1']);
    expect(targets.every((target) => target.ticketId === ticketId)).toBe(true);
    expect(h.adapter.started.map((request) => request.cwd)).toEqual(['C:/work/plan-main', 'C:/work/work-1', 'C:/work/work-2']);
  });
});
