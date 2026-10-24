import type { RunObservation } from '@vuyro/contracts';
import { describe, expect, it } from 'vitest';
import {
  agentEnvironment,
  claudeArgs,
  CliAgentAdapter,
  codexArgs,
  ExecutableNotFoundError,
  FakeProcessRunner,
  type FakeScript,
  resolveExecutable,
} from '../src/index.ts';
import type { AgentStartRequest } from '../src/index.ts';
import { ManualClock } from './helpers/manual-clock.ts';

const RESULT = JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', session_id: 's-1', usage: { input_tokens: 1, output_tokens: 2 } });
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-haiku-5-5', claude_code_version: '2.1.309' });

function request(extra: Partial<AgentStartRequest> = {}): AgentStartRequest {
  return {
    runId: 'run-1',
    provider: 'claude',
    ticketId: 't-1',
    nodeId: 'dev',
    lane: 'main',
    run: 1,
    prompt: 'line one\nline "two" with $(not a shell)',
    env: { VUYRO_RUN_TOKEN: 'vrt_token', VUYRO_NODE: 'dev' },
    ...extra,
  };
}

function setup(script: FakeScript, options: { timeoutMs?: number; lingerMs?: number; maxStderrLines?: number; baseEnv?: Record<string, string> } = {}) {
  const clock = new ManualClock();
  const runner = new FakeProcessRunner(clock);
  runner.enqueue(script);
  const adapter = CliAgentAdapter.claude({ runner, clock, resolve: (command) => `C:\\bin\\${command}.exe`, baseEnv: options.baseEnv ?? {}, ...options });
  return { clock, runner, adapter };
}

async function drain(observations: AsyncIterable<RunObservation>): Promise<RunObservation[]> {
  const out: RunObservation[] = [];
  for await (const observation of observations) out.push(observation);
  return out;
}

describe('CliAgentAdapter', () => {
  it('starts the CLI without a shell, the prompt on stdin, the token only in the environment', async () => {
    const { runner, adapter } = setup({ steps: [{ stdout: INIT }, { stdout: RESULT }, { exit: 0 }] });
    const handle = adapter.start(request({ model: 'haiku', cwd: 'C:\\work', resume: { runId: 'run-0', providerSessionId: 's-1' } }));
    await drain(handle.observations);
    expect(await handle.settled).toMatchObject({ outcome: 'succeeded' });
    const [spawn] = runner.spawned;
    expect(spawn?.spec.command).toBe('C:\\bin\\claude.exe');
    expect(spawn?.spec.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--resume',
      's-1',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(vuyro:*)',
    ]);
    expect(spawn?.spec.args.join(' ')).not.toContain('vrt_token');
    expect(spawn?.spec.args.join(' ')).not.toContain('line one');
    expect(spawn?.spec).toMatchObject({ cwd: 'C:\\work', killTree: true });
    expect(spawn?.spec.env?.VUYRO_RUN_TOKEN).toBe('vrt_token');
    expect(spawn?.input()).toBe(request().prompt);
    expect(spawn?.inputEnded()).toBe(true);
  });

  it('cancel stops the process tree and settles cancelled', async () => {
    const { runner, adapter, clock } = setup({ steps: [{ stdout: INIT }, { delayMs: 60_000, stdout: RESULT }, { exit: 0 }] });
    const handle = adapter.start(request());
    const observations = drain(handle.observations);
    await clock.advance(1000);
    handle.cancel();
    handle.cancel();
    expect(await handle.settled).toEqual({ outcome: 'cancelled', exitCode: null, signal: 'SIGTERM' });
    expect((await observations).map((observation) => observation.kind)).toEqual(['session']);
    expect(runner.spawned[0]?.kills).toEqual(['SIGTERM']);
  });

  it('a cancel after the process ended keeps its own outcome', async () => {
    const { adapter, runner } = setup({ steps: [{ stdout: RESULT }, { exit: 0 }] });
    const handle = adapter.start(request());
    await drain(handle.observations);
    await runner.spawned[0]?.process.exited;
    handle.cancel();
    expect((await handle.settled).outcome).toBe('succeeded');
    expect(runner.spawned[0]?.kills).toEqual([]);
  });

  it('stops a run at its time limit and settles failed (timeout)', async () => {
    const { adapter, clock, runner } = setup({ steps: [{ stdout: INIT }] }, { timeoutMs: 5000 });
    const handle = adapter.start(request());
    const observations = drain(handle.observations);
    await clock.advance(4999);
    expect(runner.spawned[0]?.kills).toEqual([]);
    await clock.advance(1);
    expect(await handle.settled).toMatchObject({ outcome: 'failed', terminalReason: 'timeout', signal: 'SIGKILL' });
    await observations;
  });

  it('the request time limit wins over the adapter default', async () => {
    const { adapter, clock } = setup({ steps: [{ stdout: INIT }] }, { timeoutMs: 5000 });
    const handle = adapter.start(request({ timeoutMs: 100 }));
    void drain(handle.observations);
    await clock.advance(100);
    expect(await handle.settled).toMatchObject({ outcome: 'failed', terminalReason: 'timeout' });
  });

  it('stops a process that lingers after its final line and keeps the success', async () => {
    const { adapter, clock, runner } = setup({ steps: [{ stdout: INIT }, { stdout: RESULT }] }, { lingerMs: 1000 });
    const handle = adapter.start(request());
    void drain(handle.observations);
    await clock.advance(1000);
    expect(runner.spawned[0]?.kills).toEqual(['SIGTERM']);
    expect(await handle.settled).toMatchObject({ outcome: 'succeeded', terminalReason: 'completed', signal: 'SIGTERM' });
  });

  it('a process that cannot start settles failed (start_failed)', async () => {
    const clock = new ManualClock();
    const runner = new FakeProcessRunner(clock); // no script: ENOENT
    const handle = CliAgentAdapter.codex({ runner, clock, resolve: (command) => command, baseEnv: {} }).start(request({ provider: 'codex' }));
    expect(await drain(handle.observations)).toEqual([]);
    expect(await handle.settled).toMatchObject({ outcome: 'failed', terminalReason: 'start_failed' });
  });

  it('an executable that cannot be found throws from start (the engine settles it as start_failed)', () => {
    const clock = new ManualClock();
    const adapter = CliAgentAdapter.claude({ runner: new FakeProcessRunner(clock), clock, baseEnv: { PATH: '' } });
    expect(() => adapter.start(request())).toThrow(ExecutableNotFoundError);
  });

  it('keeps at most maxStderrLines stderr lines raw and says how many it dropped', async () => {
    const steps = [...Array.from({ length: 5 }, (_, index) => ({ stderr: `noise ${index}` })), { stdout: RESULT }, { exit: 0 }];
    const { adapter } = setup({ steps }, { maxStderrLines: 2 });
    const handle = adapter.start(request());
    const observations = await drain(handle.observations);
    expect(observations.filter((observation) => observation.kind === 'raw' && observation.stream === 'stderr')).toHaveLength(2);
    expect(observations.at(-1)).toMatchObject({ kind: 'warning', message: '3 more stderr lines were not kept' });
  });

  it('keeps non-JSON and unknown lines raw and cuts oversized values to the schema limits', async () => {
    const huge = 'x'.repeat(2_000_000);
    const steps = [
      { stdout: 'not json' },
      { stdout: JSON.stringify({ type: 'mystery', value: 1 }) },
      { stdout: JSON.stringify({ type: 'assistant', session_id: 's-1', message: { id: 'm1', content: [{ type: 'text', text: huge }, { type: 'tool_use', id: 't1', name: 'Write', input: { content: huge } }] } }) },
      { stdout: RESULT },
      { exit: 0 },
    ];
    const { adapter } = setup({ steps });
    const observations = await drain(adapter.start(request()).observations);
    expect(observations[0]).toMatchObject({ kind: 'raw', stream: 'stdout', raw: 'not json' });
    expect(observations[1]).toMatchObject({ kind: 'raw', providerType: 'mystery', raw: { type: 'mystery', value: 1 } });
    const message = observations.find((observation) => observation.kind === 'message');
    expect(message?.kind === 'message' ? message.text.length : 0).toBeLessThanOrEqual(1_048_576);
    const tool = observations.find((observation) => observation.kind === 'toolCallStarted');
    expect(tool?.kind === 'toolCallStarted' ? tool.input : undefined).toMatchObject({ truncated: true });
  });
});

describe('agent environment', () => {
  it('drops every inherited VUYRO_* variable (any case) and adds the run variables', () => {
    const env = agentEnvironment(
      { PATH: 'C:\\bin', VUYRO_HUMAN_CREDENTIAL: 'vhc_secret', vuyro_run_token: 'vrt_other', Vuyro_Pipe: 'x', HOME: 'C:\\home', EMPTY: undefined },
      { VUYRO_RUN_TOKEN: 'vrt_mine', VUYRO_PIPE: '\\\\.\\pipe\\p' },
    );
    expect(env).toEqual({ PATH: 'C:\\bin', HOME: 'C:\\home', VUYRO_RUN_TOKEN: 'vrt_mine', VUYRO_PIPE: '\\\\.\\pipe\\p' });
  });

  it('the adapter passes the filtered environment to the process', async () => {
    const { adapter, runner } = setup({ steps: [{ stdout: RESULT }, { exit: 0 }] }, { baseEnv: { PATH: 'C:\\bin', VUYRO_HUMAN_CREDENTIAL: 'vhc_secret' } });
    await drain(adapter.start(request()).observations);
    expect(runner.spawned[0]?.spec.env).toEqual({ PATH: 'C:\\bin', VUYRO_RUN_TOKEN: 'vrt_token', VUYRO_NODE: 'dev' });
  });
});

describe('arguments', () => {
  it('Claude: model and resume only when given', () => {
    expect(claudeArgs({})).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(claudeArgs({ model: '', extraArgs: ['--x'] })).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--x']);
  });

  it('Codex: the prompt from stdin, resume after the exec options', () => {
    expect(codexArgs({ model: 'gpt-6-luna', extraArgs: ['-s', 'workspace-write'] })).toEqual(['exec', '--json', '-m', 'gpt-6-luna', '-s', 'workspace-write', '-']);
    expect(codexArgs({ resumeSessionId: 'th-1' })).toEqual(['exec', '--json', 'resume', 'th-1', '-']);
  });
});

describe('resolveExecutable', () => {
  it('keeps paths as they are and finds real executables on PATH', () => {
    expect(resolveExecutable('C:\\tools\\claude.exe', {})).toBe('C:\\tools\\claude.exe');
    const node = resolveExecutable('node', { PATH: process.execPath.replace(/[\\/][^\\/]+$/, '') });
    expect(node.toLowerCase()).toBe(process.execPath.toLowerCase());
  });

  it('reports a missing command', () => {
    expect(() => resolveExecutable('vuyro-no-such-cli', { PATH: process.cwd() })).toThrow(/not found on PATH/);
  });
});

describe('vuyro MCP bridge for Codex', () => {
  it('registers vuyro mcp and forwards the run variables by name; the token never reaches the command line', async () => {
    const clock = new ManualClock();
    const runner = new FakeProcessRunner(clock);
    runner.enqueue({ steps: [{ exit: 0 }] });
    const adapter = CliAgentAdapter.codex({ runner, clock, resolve: (command) => command, baseEnv: {}, vuyroMcp: { command: 'C:\\node\\node.exe', args: ['C:\\vuyro\\bin.js', 'mcp'] } });
    const handle = adapter.start(request({ provider: 'codex' }));
    await drain(handle.observations);
    const args = runner.spawned[0]?.spec.args ?? [];
    expect(args).toEqual([
      'exec',
      '--json',
      '-s',
      'workspace-write',
      '-c',
      'mcp_servers.vuyro.command="C:\\\\node\\\\node.exe"',
      '-c',
      'mcp_servers.vuyro.args=["C:\\\\vuyro\\\\bin.js","mcp"]',
      '-c',
      'mcp_servers.vuyro.env_vars=["VUYRO_RUN_TOKEN","VUYRO_TICKET","VUYRO_NODE","VUYRO_LANE","VUYRO_RUN_ID","VUYRO_PIPE","VUYRO_DATA_DIR"]',
      '-',
    ]);
    expect(args.join(' ')).not.toContain('vrt_token');
  });

  it('Claude reports through its own shell tool and gets no MCP flags', async () => {
    const clock = new ManualClock();
    const runner = new FakeProcessRunner(clock);
    runner.enqueue({ steps: [{ exit: 0 }] });
    const adapter = CliAgentAdapter.claude({ runner, clock, resolve: (command) => command, baseEnv: {}, vuyroMcp: { command: 'node', args: ['bin.js', 'mcp'] } });
    const handle = adapter.start(request());
    await drain(handle.observations);
    expect(runner.spawned[0]?.spec.args.join(' ')).not.toContain('mcp_servers');
  });
});

describe('Codex MCP tool items', () => {
  it('an MCP call with error null succeeded; one with an error failed', async () => {
    const { CodexStreamNormalizer } = await import('../src/codex.ts');
    const normalizer = new CodexStreamNormalizer();
    const item = (error: unknown) => JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'vuyro', tool: 'vuyro_node_done', arguments: { port: 'done' }, result: { content: [] }, error, status: 'completed' } });
    const ok = normalizer.stdout(item(null), 0);
    expect(ok.map((observation) => observation.kind)).toEqual(['toolCallStarted', 'toolCallFinished']);
    expect(ok[0]).toMatchObject({ name: 'mcp:vuyro/vuyro_node_done' });
    expect(ok[1]).not.toHaveProperty('isError');
    expect(normalizer.stdout(item({ message: 'boom' }), 0)[1]).toMatchObject({ isError: true });
  });
});
