import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResponse, DefinitionEnvelope, TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import type { WorkspaceTarget } from '../src/workflow/engine.ts';
import type { ScriptedBehavior } from '../src/workflow/scripted-agent.ts';
import { endReached, ticketWaitReasons } from '../src/workflow/machine.ts';
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

  it('holds an empty output on a connected error port too; approving it lets the failure travel and closes the ticket', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'error', items: [] }));
        return undefined;
      },
    });
    await save(h, template('myteam/error-empty', [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end'), edge('write', 'error', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/error-empty');
    await h.drive();
    expect(await h.status(ticketId, 'write')).toBe('review');
    const held = (await h.store.readAggregate(ticketId)).find((event) => event.type === 'node.reviewRequested');
    expect(held?.data).toMatchObject({ reason: 'empty', output: { port: 'error', items: [] } });
    await h.ok('node.approve', { ticketId, nodeId: 'write' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(currentExecution(state, 'write', 'main')?.status).toBe('failed');
    expect(await h.status(ticketId, 'end')).toBe('done');
    expect(state.status).toBe('done');
  });

  it('lets an end node fed by both the done and the error port finish on either', async () => {
    let fail = true;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        if (fail) throw new Error('crashed');
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done' }));
        return undefined;
      },
    });
    await save(h, template('myteam/either', [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end'), edge('write', 'error', 'end')]));
    const failing = await ticketFor(h, 'myteam/either');
    await h.drive();
    expect(currentExecution(await h.ticket(failing), 'write', 'main')?.status).toBe('failed');
    expect((await h.ticket(failing)).status).toBe('done');
    fail = false;
    const passing = await ticketFor(h, 'myteam/either');
    await h.drive();
    expect((await h.ticket(passing)).status).toBe('done');
  });

  it('holds an output whose items pass no edge condition, like an empty one', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done', items: [{ data: { size: 1 } }] }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/filtered',
        [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }],
        [{ ...edge('write', 'done', 'end'), when: { op: 'gt', left: { path: 'item.data.size' }, right: { value: 5 } } }],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/filtered');
    await h.drive();
    expect(await h.status(ticketId, 'write')).toBe('review');
    await h.ok('node.approve', { ticketId, nodeId: 'write' });
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('joins a branch whose taken path goes through a middle node, ignoring the path not taken', async () => {
    // A: done -> C -> join, error -> join. Whichever way A goes, the join must fire once.
    for (const outcome of ['done', 'error'] as const) {
      const ran: string[] = [];
      h = await openWorkflowHarness({
        behavior: async (s) => {
          const { ticketId, nodeId } = s.request;
          ran.push(nodeId);
          const port = nodeId === 'a' ? outcome : 'done';
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port, data: { from: nodeId } }));
          return undefined;
        },
      });
      await save(
        h,
        template(
          'myteam/branch',
          [agent('a'), agent('c'), { id: 'join', type: 'vuyro.join', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }],
          [edge('a', 'done', 'c'), edge('a', 'error', 'join'), edge('c', 'done', 'join'), edge('join', 'done', 'end')],
        ),
      );
      const ticketId = await ticketFor(h, 'myteam/branch');
      await h.drive();
      const state = await h.ticket(ticketId);
      expect(state.status, outcome).toBe('done');
      const joins = nodeProgress(state, 'join').executions;
      expect(joins, outcome).toHaveLength(1);
      expect(joins[0]?.output?.items.map((item) => item.data.from), outcome).toEqual(outcome === 'done' ? ['c'] : ['a']);
      expect(ran, outcome).toEqual(outcome === 'done' ? ['a', 'c'] : ['a']);
      await h.close();
    }
    h = await openWorkflowHarness();
  });

  it('revives a dead join path when a rejection loop runs the branch again', async () => {
    // First pass A fails (error -> join, C is dead). QA rejects; A runs again and this time goes through C.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, run } = s.request;
        if (nodeId === 'a') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: run === 1 ? 'error' : 'done', data: { from: `a${run}` } }));
        else if (nodeId === 'c') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: `c${run}` } }));
        else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: run === 1 ? 'reject' : 'approve', ...(run === 1 ? { data: { feedback: 'again' } } : {}) }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/revive',
        [{ id: 'start', type: 'vuyro.human-task', version: 1 }, agent('a'), agent('c'), { id: 'join', type: 'vuyro.join', version: 1 }, { id: 'qa', type: 'vuyro.review-agent', version: 1, params: { instructions: 'check' } }, { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('start', 'done', 'a'), edge('a', 'done', 'c'), edge('a', 'error', 'join'), edge('c', 'done', 'join'), edge('join', 'done', 'qa'), edge('qa', 'approve', 'end'), edge('qa', 'reject', 'a')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/revive');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    expect(nodeProgress(state, 'join').executions.map((exec) => exec.output?.items.map((item) => item.data.from))).toEqual([['a1'], ['c1']]);
  });

  it('waits for a source that is sent back for rework while the join waits for its other source', async () => {
    // start -> a, start -> b; a -> join and a -> qa; qa rejects a once; b is slow. The join must use a's second result.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, run } = s.request;
        if (nodeId === 'a') {
          if (run === 2) await s.sleep(60 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: `a${run}` } }));
        } else if (nodeId === 'b') {
          await s.sleep(30 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: 'b' } }));
        } else if (run === 1) {
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'reject', data: { feedback: 'again' } }));
        } else {
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'approve' }));
        }
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/race',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          agent('a'),
          agent('b'),
          { id: 'qa', type: 'vuyro.review-agent', version: 1, params: { instructions: 'check' } },
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
          { id: 'reviewed', type: 'vuyro.end', version: 1 },
        ],
        [
          edge('start', 'done', 'a'),
          edge('start', 'done', 'b'),
          edge('a', 'done', 'join'),
          edge('a', 'done', 'qa'),
          edge('qa', 'reject', 'a'),
          edge('qa', 'approve', 'reviewed'),
          edge('b', 'done', 'join'),
          edge('join', 'done', 'end'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/race');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.activity.idle();
    // At 30 minutes b is done while a's rework (60 minutes) is still running: the join must wait.
    await h.clock.advance(31 * MINUTE);
    await h.activity.idle();
    let state = await h.ticket(ticketId);
    expect(currentExecution(state, 'b', 'main')?.status).toBe('done');
    expect(currentExecution(state, 'a', 'main')?.status).toBe('running');
    expect(nodeProgress(state, 'join').executions).toHaveLength(0);
    await h.drive();
    state = await h.ticket(ticketId);
    const joins = nodeProgress(state, 'join').executions;
    expect(joins).toHaveLength(1);
    expect(joins[0]?.output?.items.map((item) => item.data.from).sort()).toEqual(['a2', 'b']);
    expect(state.status).toBe('done');
  });

  it('does not let a failed lane of a replaced plan keep the ticket open', async () => {
    let planRun = 0;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') {
          planRun += 1;
          const prefix = planRun === 1 ? 'T' : 'U';
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [1, 2].map((n) => ({ data: { taskId: `${prefix}${n}` } })) }));
          return undefined;
        }
        const taskId = /task (\w+)/.exec(s.request.prompt)?.[1] ?? '?';
        if (taskId === 'T2') throw new Error('crashed');
        expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId } }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/replan-fail',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          { id: 'replan', type: 'vuyro.human-task', version: 1 },
          agent('plan'),
          agent('dev', 'task {{ nodes.plan.item.data.taskId }}', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('start', 'done', 'plan'), edge('replan', 'done', 'plan'), edge('plan', 'done', 'dev'), edge('dev', 'done', 'join'), edge('join', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/replan-fail');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.drive();
    let state = await h.ticket(ticketId);
    expect(currentExecution(state, 'dev', '2')?.status).toBe('failed');
    expect(await h.status(ticketId, 'end')).toBe('done');
    if (state.template === undefined) throw new Error('no template');
    const workflow = await h.registry.workflow(state.template);
    expect(endReached(state, workflow)).toBe(true);
    expect(ticketWaitReasons(state, workflow).map((reason) => `${reason.kind}:${reason.nodeId}/${reason.lane}`).sort()).toEqual(['active:replan/main', 'failed:dev/2']);
    // A new plan replaces the failed task; its old lane no longer holds the ticket open.
    await h.ok('node.done', { ticketId, nodeId: 'replan', port: 'done' });
    await h.drive();
    state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'join').executions.at(-1)?.output?.items.map((item) => item.data.taskId)).toEqual(['U1', 'U2']);
    expect(state.status).toBe('done');
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

  it('supersedes the lanes of a replaced plan, so they cannot hold up the join of the new plan', async () => {
    // Review counterexample (e864a07): old-plan lanes waiting in Review blocked the new plan's join and end forever.
    let planRun = 0;
    let oldCancelled = false;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') {
          planRun += 1;
          const prefix = planRun === 1 ? 'T' : 'U';
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [1, 2].map((n) => ({ data: { taskId: `${prefix}${n}` } })) }));
          return undefined;
        }
        const taskId = /task (\w+)/.exec(s.request.prompt)?.[1] ?? '?';
        if (taskId === 'T2') {
          await s.sleep(60 * MINUTE);
          oldCancelled = s.cancelled;
          return undefined;
        }
        expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId } }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/replan-review',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          { id: 'replan', type: 'vuyro.human-task', version: 1 },
          agent('plan'),
          agent('dev', 'task {{ nodes.plan.item.data.taskId }}', { ports: { in: { mode: 'each' } }, review: 'human' }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('start', 'done', 'plan'), edge('replan', 'done', 'plan'), edge('plan', 'done', 'dev'), edge('dev', 'done', 'join'), edge('join', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/replan-review');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.activity.idle();
    // Old plan: T1 waits in Review, T2 is still running.
    expect(await h.status(ticketId, 'dev', '1')).toBe('review');
    expect(await h.status(ticketId, 'dev', '2')).toBe('running');

    await h.ok('node.done', { ticketId, nodeId: 'replan', port: 'done' });
    await h.activity.idle();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').laneOrder).toEqual(['1', '2', '3', '4']);
    expect(['1', '2'].map((lane) => currentExecution(state, 'dev', lane)?.status)).toEqual(['superseded', 'superseded']);
    const superseded = (await h.store.readAggregate(ticketId)).flatMap((event) => (event.type === 'node.superseded' ? [`${event.data.lane}:${event.data.reason}`] : []));
    expect(superseded).toEqual(['1:replaced', '2:replaced']);
    expect(oldCancelled).toBe(true);
    // The replaced review is gone: a person can no longer approve it, nor retry an old lane.
    expect((await h.exec('node.approve', { ticketId, nodeId: 'dev', lane: '1' })).ok).toBe(false);
    expect((await h.exec('node.retry', { ticketId, nodeId: 'dev', lane: '2' })).ok).toBe(false);

    // Finishing every lane of the new plan runs the join and the end.
    expect(['3', '4'].map((lane) => currentExecution(state, 'dev', lane)?.status)).toEqual(['review', 'review']);
    await h.ok('node.approve', { ticketId, nodeId: 'dev', lane: '3' });
    expect(nodeProgress(await h.ticket(ticketId), 'join').executions).toHaveLength(0);
    await h.ok('node.approve', { ticketId, nodeId: 'dev', lane: '4' });
    await h.drive();
    state = await h.ticket(ticketId);
    const joins = nodeProgress(state, 'join').executions;
    expect(joins).toHaveLength(1);
    expect(joins[0]?.output?.items.map((item) => item.data.taskId)).toEqual(['U1', 'U2']);
    expect(await h.status(ticketId, 'end')).toBe('done');
    // Both entries finished and nothing else is active: the ticket is done.
    expect(state.status).toBe('done');
    const lanes = await h.store.query("SELECT lane, status FROM p_node_lanes WHERE node_id = 'dev' ORDER BY lane");
    expect(lanes).toEqual([
      { lane: '1', status: 'wait' },
      { lane: '2', status: 'wait' },
      { lane: '3', status: 'done' },
      { lane: '4', status: 'done' },
    ]);
  });

  it('settles every join and fan-in of a command before deciding the ticket is done', async () => {
    // Oracle counterexample against e864a07: the join fired while the finishing lane's edges were still being
    // routed, reached the end and completed the ticket before the fan-in 'summary' was activated.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        const items = nodeId === 'plan' ? [1, 2].map((n) => ({ data: { n } })) : [{ data: { from: nodeId } }];
        expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/join-and-fan-in',
        [
          agent('plan'),
          agent('dev', 'dev', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
          // Listed after the end on purpose: the sweep reaches the end first.
          agent('summary'),
        ],
        [edge('plan', 'done', 'dev'), edge('dev', 'done', 'join'), edge('join', 'done', 'end'), edge('dev', 'done', 'summary')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/join-and-fan-in');
    await h.drive();
    const state = await h.ticket(ticketId);
    const events = await h.store.readAggregate(ticketId);
    const completedAt = events.findIndex((event) => event.type === 'ticket.completed');
    const summaryAt = events.findIndex((event) => event.type === 'node.activated' && event.data.nodeId === 'summary');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(completedAt).toBeGreaterThan(summaryAt);
    expect(currentExecution(state, 'summary', 'main')?.status).toBe('done');
    expect(state.status).toBe('done');
  });

  it('takes every fan-out that becomes ready in the same command into one fan-in', async () => {
    // d lane 1 feeds both chained fan-outs e1 and e2; d lane 2 fails late. Only then are e1 and e2 settled, together.
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [1, 2].map((n) => ({ data: { n } })) }));
        else if (nodeId === 'd' && s.request.prompt.includes('item 2')) {
          await s.sleep(60 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'error', data: { reason: 'late failure' } }));
        } else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: nodeId } }));
        return undefined;
      },
    });
    const each = { ports: { in: { mode: 'each' as const } } };
    await save(
      h,
      template(
        'myteam/double-fan-in',
        [
          agent('plan'),
          agent('d', 'item {{ input.data.n }}', each),
          agent('e1', 'e1', each),
          agent('e2', 'e2', each),
          agent('a', 'summarize {{ inputs.in.length }}'),
          agent('log'),
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('plan', 'done', 'd'), edge('d', 'done', 'e1'), edge('d', 'done', 'e2'), edge('d', 'error', 'log'), edge('e1', 'done', 'a'), edge('e2', 'done', 'a'), edge('a', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/double-fan-in');
    await h.drive();
    const state = await h.ticket(ticketId);
    const runs = nodeProgress(state, 'a').executions;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.inputs.in?.map((item) => item.data.from)).toEqual(['e1', 'e2']);
    expect(state.status).toBe('done');
  });

  it('reworks only the live lanes a rejection points at, even when it also names a replaced lane', async () => {
    let planRun = 0;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') {
          planRun += 1;
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { task: planRun === 1 ? 'T1' : 'U1' } }] }));
        } else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { done: true } }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/reject-across-plans',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          { id: 'replan', type: 'vuyro.human-task', version: 1 },
          agent('plan'),
          agent('dev', 'task {{ input.data.task }}', { ports: { in: { mode: 'each' } } }),
          { id: 'join', type: 'vuyro.join', version: 1 },
          { id: 'qa', type: 'vuyro.approval', version: 1 },
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
    const ticketId = await ticketFor(h, 'myteam/reject-across-plans');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.drive();
    await h.ok('node.done', { ticketId, nodeId: 'replan', port: 'done' });
    await h.drive();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').laneOrder).toEqual(['1', '2']);
    // The reviewer's item descends from the old lane 1 and the new lane 2: only lane 2 runs again.
    const lineage = [1, 2].map((run) => ({ nodeId: 'dev', run, item: 0 }));
    await h.ok('node.reject', { ticketId, nodeId: 'qa', items: [{ data: { feedback: 'redo' }, lineage }] });
    await h.drive();
    state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').lanes['1']?.runs).toEqual([1]);
    expect(nodeProgress(state, 'dev').lanes['2']?.runs).toEqual([2, 3]);
    expect(await h.status(ticketId, 'qa')).toBe('review');
  });

  it('takes nothing from a chained fan-out whose upstream group was replaced', async () => {
    // plan -> d (each) -> e (each, chained under d's group) -> a (fan-in). A new plan replaces d's group while
    // e's group still has a running lane; the new d lane then fails. e's old group must not feed 'a'.
    let planRun = 0;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId, prompt } = s.request;
        if (nodeId === 'plan') {
          planRun += 1;
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { task: planRun === 1 ? 'T1' : 'U1' } }] }));
        } else if (nodeId === 'd') {
          if (prompt.includes('U1')) expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'error', data: { reason: 'no' } }));
          else expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [1, 2].map((part) => ({ data: { part } })) }));
        } else {
          if (prompt.includes('part 2')) await s.sleep(60 * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { from: nodeId } }));
        }
        return undefined;
      },
    });
    const each = { ports: { in: { mode: 'each' as const } } };
    await save(
      h,
      template(
        'myteam/chained-replan',
        [
          { id: 'start', type: 'vuyro.human-task', version: 1 },
          { id: 'replan', type: 'vuyro.human-task', version: 1 },
          agent('plan'),
          agent('d', 'task {{ input.data.task }}', each),
          agent('e', 'part {{ input.data.part }}', each),
          agent('a'),
          agent('log'),
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [
          edge('start', 'done', 'plan'),
          edge('replan', 'done', 'plan'),
          edge('plan', 'done', 'd'),
          edge('d', 'done', 'e'),
          edge('d', 'error', 'log'),
          edge('e', 'done', 'a'),
          edge('a', 'done', 'end'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/chained-replan');
    await h.ok('node.done', { ticketId, nodeId: 'start', port: 'done' });
    await h.activity.idle();
    expect(await h.status(ticketId, 'e', '1')).toBe('done');
    expect(await h.status(ticketId, 'e', '2')).toBe('running');
    await h.ok('node.done', { ticketId, nodeId: 'replan', port: 'done' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(currentExecution(state, 'e', '2')?.status).toBe('superseded');
    expect(currentExecution(state, 'd', '2')?.status).toBe('failed');
    expect(nodeProgress(state, 'a').executions).toHaveLength(0);
    // The failure went to 'log', which ends its path: the ticket is done without the old plan's work.
    expect(state.status).toBe('done');
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
