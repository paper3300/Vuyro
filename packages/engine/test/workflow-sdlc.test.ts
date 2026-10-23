import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResponse, NodeRunOutput } from '@vuyro/contracts';
import type { ScriptedBehavior, ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution, nodeProgress } from '../src/workflow/state.ts';
import { openWorkflowHarness, startSdlcTicket, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * M2 completion test: the default template "AI-Native SDLC" runs a ticket to Done with fake agents on a
 * virtual clock. Plan's items fan out to parallel Dev lanes; QA rejects one task, and only that lane
 * runs again (found through lineage, routed by the reject port) before the ticket finishes.
 */

const TASKS = [
  { taskId: 'T1', scope: 'open a file', files: ['src/open.ts'] },
  { taskId: 'T2', scope: 'save a file', files: ['src/save.ts'] },
  { taskId: 'T3', scope: 'show a status bar', files: ['src/status.ts'] },
];
const MINUTE = 60_000;

function expectOk(response: CommandResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`);
}

describe('AI-Native SDLC template', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  it('runs a ticket from BrainStorming to Done with parallel Dev lanes and a partial QA rejection', async () => {
    let running = 0;
    let maxRunning = 0;
    const devTasks: string[] = [];
    const qaPrompts: string[] = [];
    const specPrompts: string[] = [];

    const behavior: ScriptedBehavior = async (s: ScriptedSession) => {
      const { ticketId, nodeId, run } = s.request;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        s.observe({ kind: 'session', providerSessionId: `session-${s.request.runId}`, model: 'claude-haiku-5-5' });
        s.observe({ kind: 'message', role: 'assistant', text: `working on ${nodeId}` });
        switch (nodeId) {
          case 'spec': {
            specPrompts.push(s.request.prompt);
            await s.sleep(5 * MINUTE);
            expectOk(await s.vuyro('artifact.add', { ticketId, nodeId, slot: 'specDoc', ref: { kind: 'file', uri: 'docs/spec.md', version: String(run) } }));
            expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { title: 'Notepad', acceptanceCriteria: ['can open', 'can save'] }, summary: `spec v${run}` }));
            break;
          }
          case 'plan': {
            await s.sleep(3 * MINUTE);
            expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', items: TASKS.map((task) => ({ data: task, summary: task.scope })) }));
            break;
          }
          case 'dev': {
            // The task comes from the rendered instructions ({{ nodes.plan.item.data.taskId }} through lineage).
            const taskId = /task (T\d)\)/.exec(s.request.prompt)?.[1] ?? '?';
            devTasks.push(`${taskId}@lane${s.request.lane}`);
            await s.sleep((10 + Number(taskId.slice(1))) * MINUTE);
            expectOk(await s.vuyro('artifact.add', { ticketId, nodeId, slot: 'change', ref: { kind: 'git', uri: `repo:${taskId}`, version: `sha-${taskId}-${run}` } }));
            expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'done', data: { taskId, notes: `done in run ${run}` } }));
            break;
          }
          case 'qa': {
            qaPrompts.push(s.request.prompt);
            await s.sleep(4 * MINUTE);
            if (run === 1) {
              // Reject only the second input item (task T2).
              expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'reject', items: [{ pairedInput: 1, data: { feedback: 'saving loses the last line' } }] }));
            } else {
              expectOk(await s.vuyro('node.done', { ticketId, nodeId, port: 'approve', data: { verdict: 'pass' } }));
            }
            break;
          }
          default:
            throw new Error(`unexpected node ${nodeId}`);
        }
        s.observe({ kind: 'usage', scope: 'run', tokens: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20 } });
        return undefined;
      } finally {
        running -= 1;
      }
    };
    h = await openWorkflowHarness({ behavior, maxConcurrent: 4 });
    const { ticketId } = await startSdlcTicket(h);

    // BrainStorming waits for a person.
    await h.drive();
    expect(await h.status(ticketId, 'brainstorming')).toBe('review');
    await h.ok('node.done', { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'A tiny notepad', data: { idea: 'notepad' } });

    // Spec runs, then waits for approval. The first spec is rejected and the spec runs again with the comment.
    await h.drive();
    expect(await h.status(ticketId, 'specApproval')).toBe('review');
    expect(specPrompts[0]).toContain('A tiny notepad');
    await h.ok('node.reject', { ticketId, nodeId: 'specApproval', comment: 'add acceptance criteria for saving' });
    expect(await h.status(ticketId, 'spec')).toMatch(/rejected|running/);
    await h.drive();
    expect(specPrompts).toHaveLength(2);
    expect(specPrompts[1]).toContain('add acceptance criteria for saving');
    expect(await h.status(ticketId, 'specApproval')).toBe('review');
    await h.ok('node.approve', { ticketId, nodeId: 'specApproval', comment: 'looks right' });

    // Plan fans out into three Dev lanes that run at the same time; then QA reviews the joined result.
    await h.drive();
    let state = await h.ticket(ticketId);
    expect(nodeProgress(state, 'dev').laneOrder).toEqual(['1', '2', '3']);
    expect(maxRunning).toBe(3);
    expect(devTasks.sort()).toEqual(['T1@lane1', 'T2@lane2', 'T3@lane3']);
    expect(await h.status(ticketId, 'qa')).toBe('review');
    expect(qaPrompts[0]).toContain('"taskId": "T2"');
    const heldQa = currentExecution(state, 'qa', 'main')?.output;
    expect(heldQa?.port).toBe('reject');

    // A person confirms QA's verdict: only T2's lane runs again.
    await h.ok('node.approve', { ticketId, nodeId: 'qa', comment: 'agreed' });
    state = await h.ticket(ticketId);
    expect(currentExecution(state, 'dev', '2')?.cause).toBe('rework');
    expect(currentExecution(state, 'dev', '2')?.status).toBe('rejected');
    expect(currentExecution(state, 'dev', '1')?.status).toBe('done');
    expect(currentExecution(state, 'dev', '3')?.status).toBe('done');
    devTasks.length = 0;
    await h.drive();
    expect(devTasks).toEqual(['T2@lane2']);

    // QA runs again on all three tasks (lanes 1 and 3 keep their earlier output) and approves.
    state = await h.ticket(ticketId);
    const join = nodeProgress(state, 'join').executions;
    expect(join).toHaveLength(2);
    const joined = join[1]?.output as NodeRunOutput;
    expect(joined.items.map((item) => item.data.taskId)).toEqual(['T1', 'T2', 'T3']);
    expect(joined.items.map((item) => item.lineage)).toEqual([
      [{ nodeId: 'dev', run: 1, item: 0 }],
      [{ nodeId: 'dev', run: 4, item: 0 }],
      [{ nodeId: 'dev', run: 3, item: 0 }],
    ]);
    expect(await h.status(ticketId, 'qa')).toBe('review');
    await h.ok('node.approve', { ticketId, nodeId: 'qa' });
    await h.drive();

    state = await h.ticket(ticketId);
    expect(state.status).toBe('done');
    expect(await h.status(ticketId, 'done')).toBe('done');

    // Every run counted once: spec ×2, plan ×1, dev ×4 (3 + 1 rework), qa ×2.
    const runs = await h.store.query<{ node_id: string; n: number }>('SELECT node_id, COUNT(*) AS n FROM p_runs GROUP BY node_id ORDER BY node_id');
    expect(runs).toEqual([
      { node_id: 'dev', n: 4 },
      { node_id: 'plan', n: 1 },
      { node_id: 'qa', n: 2 },
      { node_id: 'spec', n: 2 },
    ]);
    expect((await h.store.query<{ status: string }>("SELECT DISTINCT status FROM p_runs")).map((row) => row.status)).toEqual(['succeeded']);
    const tokens = await h.store.queryOne<{ total: number }>('SELECT SUM(tokens_input + tokens_output) AS total FROM p_runs');
    expect(tokens?.total).toBe(9 * 120);
    const ticketRow = await h.store.queryOne<{ status: string; template_id: string; completed_at: number }>('SELECT status, template_id, completed_at FROM p_tickets');
    expect(ticketRow).toMatchObject({ status: 'done', template_id: 'vuyro/ai-sdlc' });

    // The artifact registry kept every registration, attached to its lane by the run.
    const changes = await h.store.query<{ uri: string; version: string }>("SELECT uri, version FROM p_artifacts WHERE slot = 'change' ORDER BY sequence");
    expect(changes.map((row) => row.uri).sort()).toEqual(['repo:T1', 'repo:T2', 'repo:T2', 'repo:T3']);

    // Who did what: people approved, agents submitted, the engine routed.
    const events = await h.store.readAggregate(ticketId);
    const approvals = events.filter((event) => event.type === 'node.completed' && (event.data.nodeId === 'specApproval' || event.data.nodeId === 'qa'));
    expect(approvals.every((event) => event.actor.kind === 'human')).toBe(true);
    const submissions = events.filter((event) => event.type === 'node.outputSubmitted');
    expect(submissions).toHaveLength(9);
    expect(submissions.every((event) => event.actor.kind === 'agent' && event.actor.role === 'node.agent')).toBe(true);
    expect(h.errors).toEqual([]);
    // The run token reaches the agent only through its environment.
    for (const request of h.adapter.started) {
      const token = request.env.VUYRO_RUN_TOKEN ?? '';
      expect(token).toMatch(/^vrt_/);
      expect(request.prompt).not.toContain(token);
    }

    // Replaying the log rebuilds the same tables.
    const before = await h.store.query('SELECT * FROM p_node_runs ORDER BY ticket_id, node_id, run');
    await h.store.rebuildProjections();
    expect(await h.store.query('SELECT * FROM p_node_runs ORDER BY ticket_id, node_id, run')).toEqual(before);
  });
});
