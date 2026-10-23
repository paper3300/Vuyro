import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandFailure, CommandResponse, DefinitionEnvelope, NodeTypeDefinition, TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import type { ScriptedBehavior } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { CLI, nextRequestId } from './helpers/engine-harness.ts';
import { HUMAN, openWorkflowHarness, SYSTEM, type WorkflowHarness } from './helpers/workflow-harness.ts';

const MINUTE = 60_000;

function expectOk(response: CommandResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`);
}

function expectFailure(response: CommandResponse, code: CommandFailure['error']['code']): CommandFailure {
  if (response.ok) throw new Error(`expected ${code}, got success`);
  expect(response.error.code, response.error.message).toBe(code);
  return response;
}

function template(id: string, nodes: TemplateNode[], edges: TemplateEdge[]): TemplateDefinition {
  return { vuyro: 'export', formatVersion: 1, kind: 'template', id, version: 1, name: id, content: { id, version: 1, name: id, nodes, edges } };
}

const edge = (from: string, fromPort: string, to: string, toPort = 'in', extra: Partial<TemplateEdge> = {}): TemplateEdge => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
  ...extra,
});

const agent = (id: string, instructions = `do ${id}`, extra: Partial<TemplateNode> = {}): TemplateNode => ({
  id,
  type: 'vuyro.agent',
  version: 1,
  params: { instructions },
  ...extra,
});

async function save(h: WorkflowHarness, definition: DefinitionEnvelope): Promise<void> {
  expectOk(await h.writer.save(definition, HUMAN, nextRequestId()));
}

async function ticketFor(h: WorkflowHarness, templateId: string): Promise<string> {
  const project = await h.ok('project.create', { name: 'sample' });
  const { projectId } = project.result as { projectId: string };
  const ticket = await h.ok('ticket.create', { projectId, title: 'Ticket', template: { id: templateId } });
  return (ticket.result as { ticketId: string }).ticketId;
}

/** A fan-out: plan emits `count` items, each runs in its own 'work' lane, then join → end. */
function fanOut(): TemplateDefinition {
  return template(
    'myteam/fanout',
    [
      agent('plan'),
      agent('work', 'work on {{ input.data.n }}', {
        ports: { in: { mode: 'each' } },
      }),
      { id: 'join', type: 'vuyro.join', version: 1 },
      { id: 'end', type: 'vuyro.end', version: 1 },
    ],
    [edge('plan', 'done', 'work'), edge('work', 'done', 'join'), edge('join', 'done', 'end')],
  );
}

describe('WorkflowEngine', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  it('keeps executions over the concurrency limit queued and starts them as slots free up', async () => {
    let running = 0;
    let max = 0;
    const behavior: ScriptedBehavior = async (s) => {
      running += 1;
      max = Math.max(max, running);
      try {
        await s.sleep(MINUTE);
        if (s.request.nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'plan', port: 'done', items: [1, 2, 3, 4, 5].map((n) => ({ data: { n } })) }));
        } else {
          expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'work', port: 'done', data: { n: /work on (\d)/.exec(s.request.prompt)?.[1] } }));
        }
        return undefined;
      } finally {
        running -= 1;
      }
    };
    h = await openWorkflowHarness({ behavior, maxConcurrent: 2 });
    await save(h, fanOut());
    const ticketId = await ticketFor(h, 'myteam/fanout');
    await h.activity.idle();
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    const lanes = await h.store.query<{ lane: string; status: string }>("SELECT lane, status FROM p_node_lanes WHERE node_id = 'work' ORDER BY CAST(lane AS INTEGER)");
    expect(lanes.map((row) => row.status)).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
    await h.drive();
    expect(max).toBe(2);
    const state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    const joined = nodeProgress(state, 'join').executions[0]?.output?.items.map((item) => item.data.n);
    expect(joined).toEqual(['1', '2', '3', '4', '5']);
  });

  it('gathers a fan-out into a whole input without a join node, once every lane finished', async () => {
    const seen: string[] = [];
    h = await openWorkflowHarness({
      behavior: async (s) => {
        const { ticketId, nodeId } = s.request;
        if (nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }] }));
        } else if (nodeId === 'work') {
          const n = Number(/work on (\d)/.exec(s.request.prompt)?.[1]);
          await s.sleep(n * MINUTE);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { n } }));
        } else {
          seen.push(s.request.prompt);
          expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done' }));
        }
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/gather',
        [agent('plan'), agent('work', 'work on {{ input.data.n }}', { ports: { in: { mode: 'each' } } }), agent('sum', 'sum {{ inputs.in.length }} results'), { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('plan', 'done', 'work'), edge('work', 'done', 'sum'), edge('sum', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/gather');
    await h.drive();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('sum 3 results');
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('routes items by edge conditions', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        if (s.request.nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'plan', port: 'done', items: [{ data: { size: 1 } }, { data: { size: 9 } }] }));
        }
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/split',
        [agent('plan'), { id: 'small', type: 'vuyro.human-task', version: 1 }, { id: 'big', type: 'vuyro.human-task', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }],
        [
          edge('plan', 'done', 'small', 'in', { when: { op: 'lt', left: { path: 'item.data.size' }, right: { value: 5 } } }),
          edge('plan', 'done', 'big', 'in', { when: { not: { op: 'lt', left: { path: 'item.data.size' }, right: { value: 5 } } } }),
          edge('small', 'done', 'end'),
          edge('big', 'done', 'end'),
        ],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/split');
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(currentExecution(state, 'small', 'main')?.inputs.in?.map((item) => item.data.size)).toEqual([1]);
    expect(currentExecution(state, 'big', 'main')?.inputs.in?.map((item) => item.data.size)).toEqual([9]);
  });

  it('holds output behind a review gate; a rejection runs the node again with the comment', async () => {
    const prompts: string[] = [];
    h = await openWorkflowHarness({
      behavior: async (s) => {
        prompts.push(s.request.prompt);
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done', summary: `draft ${s.request.run}` }));
        return undefined;
      },
    });
    await save(h, template('myteam/gate', [agent('write', 'write it', { review: 'human' }), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/gate');
    await h.drive();
    expect(await h.status(ticketId, 'write')).toBe('review');
    expect(await h.status(ticketId, 'end')).toBe('wait');
    await h.ok('node.reject', { ticketId, nodeId: 'write', comment: 'too short' });
    await h.drive();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('too short');
    const state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'write').executions.map((exec) => `${exec.cause}:${exec.status}`)).toEqual(['start:discarded', 'review:review']);
    await h.ok('node.approve', { ticketId, nodeId: 'write' });
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('fails a node whose agent ended without reporting, and retries it on request', async () => {
    let attempts = 0;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        attempts += 1;
        if (attempts > 1) expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done' }));
        return undefined;
      },
    });
    await save(h, template('myteam/retry', [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/retry');
    await h.drive();
    let state = await h.ticket(ticketId);
    const failed = currentExecution(state, 'write', 'main');
    expect(failed?.status).toBe('failed');
    expect(failed?.output?.port).toBe('error');
    expect(String(failed?.output?.items[0]?.data.error)).toMatch(/without reporting a result/);
    expectFailure(await h.exec('node.retry', { ticketId, nodeId: 'write' }, CLI), 'forbidden');
    await h.ok('node.retry', { ticketId, nodeId: 'write' });
    await h.drive();
    state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    expect(nodeProgress(state, 'write').executions.map((exec) => `${exec.cause}:${exec.status}`)).toEqual(['start:failed', 'retry:done']);
  });

  it('pauses a running agent (cancels it) and resumes its provider session', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        s.observe({ kind: 'session', providerSessionId: `session-${s.request.runId}` });
        await s.sleep(10 * MINUTE);
        if (s.cancelled) return undefined;
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done' }));
        return undefined;
      },
    });
    await save(h, template('myteam/pause', [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/pause');
    await h.activity.idle();
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    expect(await h.status(ticketId, 'write')).toBe('running');
    await h.ok('node.pause', { ticketId, nodeId: 'write' });
    await h.activity.idle();
    expect(await h.status(ticketId, 'write')).toBe('paused');
    const first = h.adapter.started[0];
    expect(await h.store.queryOne('SELECT status FROM p_runs WHERE run_id = ?', [first?.runId ?? ''])).toEqual({ status: 'cancelled' });
    await h.clock.advance(30 * MINUTE);
    await h.activity.idle();
    expect(h.adapter.started).toHaveLength(1);
    await h.ok('node.resume', { ticketId, nodeId: 'write' });
    await h.drive();
    expect(h.adapter.started).toHaveLength(2);
    expect(h.adapter.started[1]?.resume).toEqual({ runId: first?.runId, providerSessionId: `session-${first?.runId ?? ''}` });
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('a pause resumed before it took effect never fails the lane', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        await s.sleep(10 * MINUTE);
        if (!s.cancelled) expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done' }));
        return undefined;
      },
    });
    await save(h, template('myteam/flip', [agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }], [edge('write', 'done', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/flip');
    await h.activity.idle();
    await h.ok('node.pause', { ticketId, nodeId: 'write' });
    await h.ok('node.resume', { ticketId, nodeId: 'write' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    expect(nodeProgress(state, 'write').executions.map((exec) => exec.status)).toEqual(['done']);
  });

  it('after an engine restart, re-runs interrupted agents (resuming the session) and fails interrupted scripts', async () => {
    const script: NodeTypeDefinition = {
      vuyro: 'export',
      formatVersion: 1,
      kind: 'nodeType',
      id: 'myteam.sleep',
      version: 1,
      name: 'Sleep',
      content: {
        type: 'myteam.sleep',
        version: 1,
        label: 'Sleep',
        completion: 'script',
        inputs: [{ name: 'in', label: 'In' }],
        outputs: [{ name: 'done', label: 'Done' }, { name: 'error', label: 'Error' }],
        params: [],
        script: { program: 'sleep', args: ['600'] },
      },
    };
    h = await openWorkflowHarness({
      behavior: async (s) => {
        s.observe({ kind: 'session', providerSessionId: 'session-1' });
        await s.sleep(10 * MINUTE);
        if (!s.cancelled) expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done' }));
        return undefined;
      },
    });
    h.processes.enqueue({ steps: [{ delayMs: 10 * MINUTE, exit: 0 }] });
    await save(h, script);
    await save(
      h,
      template(
        'myteam/restart',
        [agent('write'), { id: 'wait', type: 'myteam.sleep', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('write', 'done', 'end'), edge('wait', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/restart');
    await h.activity.idle();
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    expect(await h.status(ticketId, 'write')).toBe('running');
    expect(await h.status(ticketId, 'wait')).toBe('running');

    await h.restart();
    await h.drive();
    const state = await h.ticket(ticketId);
    const write = currentExecution(state, 'write', 'main');
    expect(write?.status).toBe('done');
    expect(write?.attempts).toBe(2);
    expect(write?.runIds).toHaveLength(2);
    expect(h.adapter.started[0]?.resume).toEqual({ runId: write?.runIds[0], providerSessionId: 'session-1' });
    const wait = currentExecution(state, 'wait', 'main');
    expect(wait?.status).toBe('failed');
    expect(String(wait?.output?.items[0]?.data.error)).toMatch(/engine restarted/);
    const settled = await h.store.query<{ status: string; terminal_reason: string }>('SELECT status, terminal_reason FROM p_runs ORDER BY started_at');
    expect(settled[0]).toEqual({ status: 'abnormal_exit', terminal_reason: 'engine_restarted' });
  });

  it('runs script nodes without a shell, with a minimal environment, mapping exit codes and JSON output', async () => {
    const definition = (output: 'json' | 'none', exitPorts?: Record<string, string>): NodeTypeDefinition => ({
      vuyro: 'export',
      formatVersion: 1,
      kind: 'nodeType',
      id: `myteam.check-${output}`,
      version: 1,
      name: 'Check',
      content: {
        type: `myteam.check-${output}`,
        version: 1,
        label: 'Check',
        completion: 'script',
        inputs: [{ name: 'in', label: 'In' }],
        outputs: [
          { name: 'done', label: 'Done', schema: output === 'json' ? { type: 'object', required: ['passed'], properties: { passed: { type: 'integer' } } } : { type: 'object' } },
          { name: 'warn', label: 'Warn' },
          { name: 'error', label: 'Error' },
        ],
        params: [{ name: 'target', label: 'Target', schema: { type: 'string', default: '{{ ticket.title }}' } }],
        script: { program: 'check', args: ['--target', '{{ params.target }}'], env: { CHECK_MODE: 'strict' }, output, timeout: '5m', ...(exitPorts === undefined ? {} : { exitPorts }) },
      },
    });
    h = await openWorkflowHarness();
    await save(h, definition('json'));
    await save(h, definition('none', { '0': 'done', '3': 'warn', default: 'error' }));
    await save(
      h,
      template(
        'myteam/scripts',
        [
          { id: 'json', type: 'myteam.check-json', version: 1 },
          { id: 'codes', type: 'myteam.check-none', version: 1 },
          { id: 'slow', type: 'myteam.check-none', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        [edge('json', 'done', 'end'), edge('codes', 'warn', 'end'), edge('slow', 'done', 'end')],
      ),
    );
    h.processes.enqueue({ match: (spec) => spec.args.includes('Ticket') && h.processes.spawned.length === 0, steps: [{ stdout: 'checking' }, { stdout: '{"data":{"passed":3},"summary":"3 passed"}' }, { exit: 0 }] });
    h.processes.enqueue({ steps: [{ stdout: 'careful' }, { exit: 3 }] });
    h.processes.enqueue({ steps: [{ delayMs: 10 * MINUTE, exit: 0 }] });
    const ticketId = await ticketFor(h, 'myteam/scripts');
    await h.drive();
    const state = await h.ticket(ticketId);
    const spawned = h.processes.spawned.map((entry) => entry.spec);
    expect(spawned[0]).toMatchObject({ command: 'check', args: ['--target', 'Ticket'] });
    // Nothing from the engine's environment beyond the base set, and never the run-token variables.
    expect(spawned[0]?.env).toEqual({ PATH: '/bin', CHECK_MODE: 'strict' });
    for (const spec of spawned) expect(Object.keys(spec.env ?? {}).some((name) => name.startsWith('VUYRO_'))).toBe(false);
    expect(currentExecution(state, 'json', 'main')?.output).toMatchObject({ port: 'done', items: [{ data: { passed: 3 }, summary: '3 passed' }] });
    expect(currentExecution(state, 'codes', 'main')?.output).toMatchObject({ port: 'warn', items: [{ data: { exitCode: 3, stdout: 'careful\n' } }] });
    const slow = currentExecution(state, 'slow', 'main');
    expect(slow?.status).toBe('failed');
    expect(String(slow?.output?.items[0]?.data.error)).toMatch(/timed out/);
  });

  it('fails a script whose JSON result has malformed items instead of trusting them', async () => {
    h = await openWorkflowHarness();
    await save(h, {
      vuyro: 'export',
      formatVersion: 1,
      kind: 'nodeType',
      id: 'myteam.emit',
      version: 1,
      name: 'Emit',
      content: {
        type: 'myteam.emit',
        version: 1,
        label: 'Emit',
        completion: 'script',
        inputs: [{ name: 'in', label: 'In' }],
        outputs: [{ name: 'done', label: 'Done' }, { name: 'error', label: 'Error' }],
        params: [],
        script: { program: 'emit', output: 'json' },
      },
    });
    await save(h, template('myteam/emit', [{ id: 'emit', type: 'myteam.emit', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('emit', 'done', 'end')]));
    h.processes.enqueue({ steps: [{ stdout: '{"items":[{"data":"not an object","lineage":[{"nodeId":"x"}]}]}' }, { exit: 0 }] });
    const ticketId = await ticketFor(h, 'myteam/emit');
    await h.drive();
    const exec = currentExecution(await h.ticket(ticketId), 'emit', 'main');
    expect(exec?.status).toBe('failed');
    expect(String(exec?.output?.items[0]?.data.error)).toMatch(/item 0 is not valid/);
  });

  it('supersedes a running execution when new input arrives, and ignores the old run', async () => {
    let oldDone: CommandResponse | undefined;
    h = await openWorkflowHarness({
      behavior: async (s) => {
        if (s.request.run === 1) {
          await s.sleep(10 * MINUTE);
          oldDone = await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done' });
          return undefined;
        }
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'write', port: 'done', summary: 'second' }));
        return undefined;
      },
    });
    await save(
      h,
      template(
        'myteam/supersede',
        [{ id: 'a', type: 'vuyro.human-task', version: 1 }, { id: 'b', type: 'vuyro.human-task', version: 1 }, agent('write'), { id: 'end', type: 'vuyro.end', version: 1 }],
        [edge('a', 'done', 'write'), edge('b', 'done', 'write'), edge('write', 'done', 'end')],
      ),
    );
    const ticketId = await ticketFor(h, 'myteam/supersede');
    await h.ok('node.done', { ticketId, nodeId: 'a', port: 'done' });
    await h.activity.idle();
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    expect(await h.status(ticketId, 'write')).toBe('running');
    await h.ok('node.done', { ticketId, nodeId: 'b', port: 'done' });
    await h.drive();
    const state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'write').executions.map((exec) => exec.status)).toEqual(['superseded', 'done']);
    expect(currentExecution(state, 'write', 'main')?.output?.items[0]?.summary).toBe('second');
    // The cancelled first run can no longer report: its execution was superseded (or its token is gone).
    expect(oldDone?.ok).toBe(false);
    if (oldDone !== undefined && !oldDone.ok) expect(['invariant_violated', 'unauthenticated']).toContain(oldDone.error.code);
    expect(state.status).toBe('done');
  });

  it('lets a join continue with the lanes that succeeded, and keeps the ticket open until the failed lane is retried', async () => {
    h = await openWorkflowHarness({
      behavior: async (s) => {
        if (s.request.nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'plan', port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }] }));
          return undefined;
        }
        if (s.request.prompt.includes('work on 2')) throw new Error('crashed');
        expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'work', port: 'done', data: { n: 1 } }));
        return undefined;
      },
    });
    await save(h, fanOut());
    const ticketId = await ticketFor(h, 'myteam/fanout');
    await h.drive();
    let state = await h.ticket(ticketId);
    expect(currentExecution(state, 'work', '2')?.status).toBe('failed');
    expect(nodeProgress(state, 'join').executions[0]?.output?.items.map((item) => item.data.n)).toEqual([1]);
    // The end node finished, but the failed lane keeps the ticket open until someone retries it.
    expect(await h.status(ticketId, 'end')).toBe('done');
    expect(state.status).toBe('open');
    h.setBehavior(async (s) => {
      expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'work', port: 'done', data: { n: 2 } }));
      return undefined;
    });
    await h.ok('node.retry', { ticketId, nodeId: 'work', lane: '2' });
    await h.drive();
    state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'join').executions[1]?.output?.items.map((item) => item.data.n)).toEqual([1, 2]);
    expect(state.status).toBe('done');
  });
});

describe('node command boundary', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  /** Two fan-out lanes that wait for the test to act with their tokens. */
  async function twoLanes(): Promise<{ ticketId: string; tokens: Map<string, string> }> {
    const tokens = new Map<string, string>();
    h = await openWorkflowHarness({
      behavior: async (s) => {
        if (s.request.nodeId === 'plan') {
          expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: 'plan', port: 'done', items: [{ data: { n: 1 } }, { data: { n: 2 } }] }));
          return undefined;
        }
        // Tokens of the first ticket only (a later ticket's lanes reuse the lane names).
        if (!tokens.has(s.request.lane)) tokens.set(s.request.lane, s.request.env.VUYRO_RUN_TOKEN ?? '');
        await s.sleep(60 * MINUTE);
        return undefined;
      },
    });
    await save(h, fanOut());
    const ticketId = await ticketFor(h, 'myteam/fanout');
    await h.activity.idle();
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    return { ticketId, tokens };
  }

  const asAgent = (token: string, type: string, payload: unknown, context?: Record<string, string>): Promise<CommandResponse> =>
    h.bus.execute({ requestId: nextRequestId(), type, payload, auth: { runToken: token }, ...(context === undefined ? {} : { context }) }, CLI);

  it('limits an agent to its own lane, node and ticket, and records the refusals', async () => {
    const { ticketId, tokens } = await twoLanes();
    const lane1 = tokens.get('1') ?? '';
    expectFailure(await asAgent(lane1, 'node.done', { ticketId, nodeId: 'work', lane: '2', port: 'done' }), 'out_of_scope');
    expectFailure(await asAgent(lane1, 'artifact.add', { ticketId, nodeId: 'work', lane: '2', slot: 'change', ref: { kind: 'git', uri: 'x' } }), 'out_of_scope');
    expectFailure(await asAgent(lane1, 'node.done', { ticketId, nodeId: 'plan', port: 'done' }), 'out_of_scope');
    expectFailure(await asAgent(lane1, 'node.done', { ticketId, nodeId: 'work', port: 'done' }, { nodeId: 'plan' }), 'out_of_scope');
    expectFailure(await asAgent(lane1, 'node.approve', { ticketId, nodeId: 'work' }), 'forbidden');
    expectFailure(await asAgent(lane1, 'node.retry', { ticketId, nodeId: 'work' }), 'forbidden');
    expectFailure(await asAgent(lane1, 'node.start', { ticketId, nodeId: 'work', lane: '1', run: 2, attempt: 2 }), 'forbidden');
    expectFailure(await asAgent(lane1, 'template.save', { definition: fanOut() }), 'forbidden');
    const denials = await h.store.query<{ command_type: string; code: string }>('SELECT command_type, code FROM p_command_denials ORDER BY sequence');
    expect(denials).toEqual([
      { command_type: 'node.done', code: 'out_of_scope' },
      { command_type: 'artifact.add', code: 'out_of_scope' },
      { command_type: 'node.done', code: 'out_of_scope' },
      { command_type: 'node.done', code: 'out_of_scope' },
      { command_type: 'node.approve', code: 'forbidden' },
      { command_type: 'node.retry', code: 'forbidden' },
      { command_type: 'node.start', code: 'forbidden' },
      { command_type: 'template.save', code: 'forbidden' },
    ]);
    // Its own lane works, named or not.
    expectOk(await asAgent(lane1, 'node.done', { ticketId, nodeId: 'work', lane: '1', port: 'done', data: { n: 1 } }));
    expectOk(await asAgent(tokens.get('2') ?? '', 'node.done', { ticketId, nodeId: 'work', port: 'done', data: { n: 2 } }));
  });

  it('refuses an agent naming a lane of another ticket before reading that ticket', async () => {
    const { tokens } = await twoLanes();
    const project = await h.ok('project.create', { name: 'other' });
    const { projectId } = project.result as { projectId: string };
    const other = await h.ok('ticket.create', { projectId, title: 'other', template: { id: 'myteam/fanout' } });
    const otherId = (other.result as { ticketId: string }).ticketId;
    await h.activity.idle();
    const read = vi.spyOn(h.store, 'readAggregate');
    expectFailure(await asAgent(tokens.get('1') ?? '', 'node.done', { ticketId: otherId, nodeId: 'work', lane: '1', port: 'done' }), 'out_of_scope');
    expectFailure(await asAgent(tokens.get('1') ?? '', 'artifact.add', { ticketId: otherId, nodeId: 'work', lane: '1', slot: 'x', ref: { kind: 'git', uri: 'x' } }), 'out_of_scope');
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('keeps engine steps and agent results away from people and unverified clients', async () => {
    const { ticketId } = await twoLanes();
    expectFailure(await h.exec('node.done', { ticketId, nodeId: 'work', port: 'done' }, CLI), 'forbidden');
    expectFailure(await h.exec('node.start', { ticketId, nodeId: 'work', lane: '1', run: 2, attempt: 2 }, HUMAN), 'forbidden');
    expectFailure(await h.exec('node.finish', { ticketId, nodeId: 'work', lane: '1', run: 2, attempt: 1, result: { kind: 'script', exitCode: 0 } }, HUMAN), 'forbidden');
    // A person cannot pose as the agent of an agent node.
    const failure = expectFailure(await h.exec('node.done', { ticketId, nodeId: 'work', lane: '1', port: 'done' }, HUMAN), 'invariant_violated');
    expect(failure.error.message).toMatch(/finished by its agent executor/);
    // The engine itself cannot start the same execution twice.
    expectFailure(await h.exec('node.start', { ticketId, nodeId: 'work', lane: '1', run: 1, attempt: 1 }, SYSTEM), 'invariant_violated');
  });

  it('rejects results that do not match the port, with issues the agent can fix', async () => {
    const { ticketId, tokens } = await twoLanes();
    const token = tokens.get('1') ?? '';
    const unknownPort = expectFailure(await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'approve' }), 'validation_failed');
    expect(unknownPort.error.message).toMatch(/no output port 'approve'/);
    expectFailure(await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'done', data: { a: 1 }, items: [] }), 'validation_failed');
    const badLineage = expectFailure(
      await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'done', items: [{ lineage: [{ nodeId: 'plan', run: 9, item: 0 }] }] }),
      'validation_failed',
    );
    expect(JSON.stringify(badLineage.error.details)).toMatch(/no such output item/);
    const badPair = expectFailure(await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'done', items: [{ pairedInput: 4 }] }), 'validation_failed');
    expect(JSON.stringify(badPair.error.details)).toMatch(/no input item 4/);
    expectOk(await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'done', items: [{ pairedInput: 0, data: { n: 1 } }] }));
  });

  it('refuses a token once its run settled', async () => {
    const { ticketId, tokens } = await twoLanes();
    const token = tokens.get('1') ?? '';
    await h.ok('node.pause', { ticketId, nodeId: 'work', lane: '1' });
    await h.activity.idle();
    expect(await h.status(ticketId, 'work', '1')).toBe('paused');
    expectFailure(await asAgent(token, 'node.done', { ticketId, nodeId: 'work', port: 'done' }), 'unauthenticated');
    expectFailure(await asAgent(token, 'artifact.add', { ticketId, nodeId: 'work', slot: 'change', ref: { kind: 'git', uri: 'x' } }), 'unauthenticated');
  });

  it('closes a finished ticket to further node commands', async () => {
    h = await openWorkflowHarness();
    await save(h, template('myteam/one', [{ id: 'task', type: 'vuyro.human-task', version: 1 }, { id: 'end', type: 'vuyro.end', version: 1 }], [edge('task', 'done', 'end')]));
    const ticketId = await ticketFor(h, 'myteam/one');
    await h.ok('node.done', { ticketId, nodeId: 'task', port: 'done' });
    expect((await h.ticket(ticketId)).status).toBe('done');
    expectFailure(await h.exec('node.retry', { ticketId, nodeId: 'task' }), 'invariant_violated');
  });
});
