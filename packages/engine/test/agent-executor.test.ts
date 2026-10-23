import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CliAgentAdapter, type FakeProcessContext, type FakeStep } from '@vuyro/agent-adapters';
import type { DefinitionEnvelope } from '@vuyro/contracts';
import { hashRunToken } from '../src/commands/run-token.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * The agent executor with the real CLI adapters (M3): the engine starts the Claude / Codex adapter, which spawns
 * a (fake) process without a shell, gives it the prompt on stdin and the run token in the environment, reads
 * its recorded output, and settles the run from the final line and the exit. Cancel, time limit, pause and
 * engine restart all go through the same path. No real CLI runs: the processes replay the M0b fixtures.
 */

const fixtures = new URL('../../agent-adapters/fixtures/', import.meta.url);
const lines = (path: string) => readFileSync(new URL(path, fixtures), 'utf8').split('\n').filter((line) => line !== '');
const CLAUDE_SIMPLE = lines('claude/2.1.309/simple.jsonl');
const CLAUDE_TOOLS = lines('claude/2.1.309/tools-read-write.jsonl');
const CODEX_TOOLS = lines('codex/0.163.0/tools-read-write.jsonl');
const SESSION = (JSON.parse(CLAUDE_SIMPLE[0] ?? '{}') as { session_id: string }).session_id;
const MINUTE = 60_000;

function oneAgent(provider: 'claude' | 'codex'): DefinitionEnvelope {
  const id = `test/one-${provider}`;
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'template',
    id,
    version: 1,
    name: id,
    content: {
      id,
      version: 1,
      name: id,
      nodes: [
        { id: 'work', type: 'vuyro.agent', version: 1, params: { instructions: 'Write the report.', provider, ...(provider === 'codex' ? { model: 'gpt-6-luna' } : {}) } },
        { id: 'end', type: 'vuyro.end', version: 1 },
      ],
      edges: [{ from: { node: 'work', port: 'done' }, to: { node: 'end', port: 'in' } }],
    },
  } as unknown as DefinitionEnvelope;
}

/** What the agent does through `vuyro` (its run token from the environment). Counted as work so drive() waits. */
function vuyro(h: WorkflowHarness, type: string, payload: (env: Readonly<Record<string, string>>) => Record<string, unknown>) {
  return (process: FakeProcessContext): Promise<void> => h.activity.track(async () => {
    const env = process.spec.env ?? {};
    const response = await h.bus.execute(
      { requestId: `agent-${String(env.VUYRO_RUN_ID)}-${type}`, type, payload: payload(env), auth: { runToken: env.VUYRO_RUN_TOKEN ?? '' } },
      { kind: 'engine-token', client: 'cli' },
    );
    if (!response.ok) throw new Error(`${type}: ${response.error.code} ${response.error.message}`);
  });
}

const done = (h: WorkflowHarness) =>
  vuyro(h, 'node.done', (env) => ({ ticketId: env.VUYRO_TICKET, nodeId: env.VUYRO_NODE, port: 'done', summary: 'report written' }));

describe('agent executor with the CLI adapters', () => {
  let h: WorkflowHarness;

  afterEach(async () => {
    await h.close();
  });

  /** Opens the harness, queues the process the engine will start, and creates the ticket. */
  async function start(provider: 'claude' | 'codex', steps: () => FakeStep[], options: { agentTimeoutMs?: number } = {}): Promise<string> {
    h = await openWorkflowHarness({
      adapters: ({ clock, processes }) => ({
        claude: CliAgentAdapter.claude({ runner: processes, clock, resolve: (command) => `C:\\agents\\${command}.exe`, baseEnv: { PATH: 'C:\\agents', VUYRO_HUMAN_CREDENTIAL: 'vhc_never' } }),
        codex: CliAgentAdapter.codex({ runner: processes, clock, resolve: (command) => `C:\\agents\\${command}.exe`, baseEnv: { PATH: 'C:\\agents' } }),
      }),
      agentEnv: { VUYRO_PIPE: '\\\\.\\pipe\\vuyro-engine-test', VUYRO_DATA_DIR: 'C:\\data' },
      workspace: ({ ticketId, nodeId }) => `C:\\work\\${ticketId.slice(0, 8)}\\${nodeId}`,
      ...options,
    });
    const saved = await h.writer.save(oneAgent(provider), HUMAN, `save-one-${provider}`);
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    h.processes.enqueue({ steps: steps() });
    const { projectId } = (await h.ok('project.create', { name: 'sample' })).result as { projectId: string };
    const ticket = await h.ok('ticket.create', { projectId, title: 'Report', template: { id: `test/one-${provider}` } });
    return (ticket.result as { ticketId: string }).ticketId;
  }

  const runs = () => h.store.query<Record<string, unknown>>('SELECT * FROM p_runs ORDER BY started_at, run_id');

  it('runs a Claude node: stdin prompt, token only in the environment, recorded output, settlement', async () => {
    // The process replays a recorded run and reports through vuyro before its final line.
    const ticketId = await start('claude', () => [
      ...CLAUDE_TOOLS.slice(0, -1).map((line) => ({ stdout: line })),
      { delayMs: 2 * MINUTE, run: done(h) },
      { stdout: CLAUDE_TOOLS.at(-1) ?? '' },
      { exit: 0 },
    ]);
    await h.drive();

    expect((await h.ticket(ticketId)).status).toBe('done');
    const [run] = await runs();
    expect(run).toMatchObject({ provider: 'claude', status: 'succeeded', terminal_reason: 'completed', exit_code: 0, tool_calls: 2, tool_errors: 0, model: 'claude-haiku-5-5' });
    const result = JSON.parse(CLAUDE_TOOLS.at(-1) ?? '{}') as { usage: { input_tokens: number; output_tokens: number }; total_cost_usd: number };
    expect(run).toMatchObject({ tokens_input: result.usage.input_tokens, tokens_output: result.usage.output_tokens, cost_usd: result.total_cost_usd, cost_basis: 'list' });

    const [spawn] = h.processes.spawned;
    const env = spawn?.spec.env ?? {};
    expect(spawn?.spec.command).toBe('C:\\agents\\claude.exe');
    expect(spawn?.spec.args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(spawn?.spec.cwd).toBe(`C:\\work\\${ticketId.slice(0, 8)}\\work`);
    expect(spawn?.spec.killTree).toBe(true);
    expect(hashRunToken(env.VUYRO_RUN_TOKEN ?? '')).toBe(run?.token_hash);
    expect(env).toMatchObject({ VUYRO_TICKET: ticketId, VUYRO_NODE: 'work', VUYRO_LANE: 'main', VUYRO_RUN_ID: run?.run_id, VUYRO_PIPE: '\\\\.\\pipe\\vuyro-engine-test', PATH: 'C:\\agents' });
    // An inherited human credential never reaches the agent.
    expect(Object.keys(env).some((name) => name.toUpperCase() === 'VUYRO_HUMAN_CREDENTIAL')).toBe(false);
    expect(spawn?.input()).toContain('Write the report.');
    expect(spawn?.inputEnded()).toBe(true);
    for (const arg of spawn?.spec.args ?? []) expect(arg).not.toContain(env.VUYRO_RUN_TOKEN);
    expect(h.errors).toEqual([]);
  });

  it('runs a Codex node with its model and adds the turn usage', async () => {
    const ticketId = await start('codex', () => [...CODEX_TOOLS.slice(0, -1).map((line) => ({ stdout: line })), { run: done(h) }, { stdout: CODEX_TOOLS.at(-1) ?? '' }, { exit: 0 }]);
    await h.drive();
    expect((await h.ticket(ticketId)).status).toBe('done');
    expect(h.processes.spawned[0]?.spec.args).toEqual(['exec', '--json', '-m', 'gpt-6-luna', '-s', 'workspace-write', '-']);
    expect((await runs())[0]).toMatchObject({ provider: 'codex', status: 'succeeded', model: 'gpt-6-luna', tokens_input: 52877 - 40960, tokens_cache_read: 40960, tool_calls: 2 });
  });

  it('stops a run at the agent time limit: the tree is killed, the run fails (timeout), the node fails', async () => {
    // The process never ends on its own.
    const ticketId = await start('claude', () => [{ stdout: CLAUDE_SIMPLE[0] ?? '' }], { agentTimeoutMs: 30 * MINUTE });
    await h.drive();
    expect(h.processes.spawned[0]?.kills).toEqual(['SIGKILL']);
    expect((await runs())[0]).toMatchObject({ status: 'failed', terminal_reason: 'timeout' });
    expect(await h.status(ticketId, 'work')).toBe('failed');
  });

  it('keeps a reported result when the process then dies without its final line (D-010)', async () => {
    const ticketId = await start('claude', () => [{ stdout: CLAUDE_SIMPLE[0] ?? '' }, { run: done(h) }, { exit: 3221225477 }]);
    await h.drive();
    expect((await runs())[0]).toMatchObject({ status: 'abnormal_exit', exit_code: 3221225477 });
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('pause cancels the process tree; resume continues the provider session', async () => {
    const ticketId = await start('claude', () => [{ stdout: CLAUDE_SIMPLE[0] ?? '' }, { delayMs: 60 * MINUTE, stdout: 'never' }]);
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    await h.ok('node.pause', { ticketId, nodeId: 'work' });
    await h.activity.idle();
    expect(h.processes.spawned[0]?.kills).toEqual(['SIGTERM']);
    expect(await h.status(ticketId, 'work')).toBe('paused');
    expect((await runs())[0]).toMatchObject({ status: 'cancelled', provider_session_id: SESSION });

    h.processes.enqueue({ steps: [{ stdout: CLAUDE_SIMPLE[0] ?? '' }, { run: done(h) }, { stdout: CLAUDE_SIMPLE.at(-1) ?? '' }, { exit: 0 }] });
    await h.ok('node.resume', { ticketId, nodeId: 'work' });
    await h.drive();
    const args = h.processes.spawned[1]?.spec.args ?? [];
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
    const [first, second] = await runs();
    expect(second?.resumed_from_run_id).toBe(first?.run_id);
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('after an engine restart the orphaned run is settled and a new run resumes the session', async () => {
    const ticketId = await start('claude', () => [{ stdout: CLAUDE_SIMPLE[0] ?? '' }, { delayMs: 60 * MINUTE, stdout: 'never' }]);
    await h.clock.advance(MINUTE);
    await h.activity.idle();
    h.processes.enqueue({ steps: [{ stdout: CLAUDE_SIMPLE[0] ?? '' }, { run: done(h) }, { stdout: CLAUDE_SIMPLE.at(-1) ?? '' }, { exit: 0 }] });
    await h.restart();
    await h.drive();
    const [orphan, resumed] = await runs();
    expect(orphan).toMatchObject({ status: 'abnormal_exit', terminal_reason: 'engine_restarted' });
    expect(resumed).toMatchObject({ status: 'succeeded', resumed_from_run_id: orphan?.run_id });
    const args = h.processes.spawned.at(-1)?.spec.args ?? [];
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION);
    expect((await h.ticket(ticketId)).status).toBe('done');
  });

  it('an executable that cannot be found fails the run as start_failed', async () => {
    h = await openWorkflowHarness({
      adapters: ({ clock, processes }) => ({ claude: CliAgentAdapter.claude({ runner: processes, clock, baseEnv: { PATH: '' } }) }),
    });
    const saved = await h.writer.save(oneAgent('claude'), HUMAN, 'save-one-claude-missing');
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const { projectId } = (await h.ok('project.create', { name: 'sample' })).result as { projectId: string };
    const { ticketId } = (await h.ok('ticket.create', { projectId, title: 'x', template: { id: 'test/one-claude' } })).result as { ticketId: string };
    await h.drive();
    expect((await runs())[0]).toMatchObject({ status: 'failed', terminal_reason: 'start_failed' });
    expect(await h.status(ticketId, 'work')).toBe('failed');
  });
});
