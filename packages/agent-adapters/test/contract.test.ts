import { readFileSync } from 'node:fs';
import type { RunObservation } from '@vuyro/contracts';
import { describe, expect, it } from 'vitest';
import { type AgentSettlement, CliAgentAdapter, FakeProcessRunner, type FakeStep } from '../src/index.ts';
import type { AgentStartRequest } from '../src/index.ts';
import { ManualClock } from './helpers/manual-clock.ts';

/**
 * Contract tests per provider ([[구현 계획]] M3): the recorded M0b output, replayed through the real adapter
 * on a fake process, must give the session id, tokens and cost, tool calls and the settlement the CLIs
 * actually meant ([[초기 검증 결과]] M0b).
 */

const fixtures = new URL('../fixtures/', import.meta.url);
const CLAUDE = 'claude/2.1.309/';
const CODEX = 'codex/0.163.0/';

function lines(path: string): string[] {
  return readFileSync(new URL(path, fixtures), 'utf8').split('\n').filter((line) => line !== '');
}

function request(provider: 'claude' | 'codex', extra: Partial<AgentStartRequest> = {}): AgentStartRequest {
  return {
    runId: '01900000-0000-7000-8000-000000000001',
    provider,
    ticketId: '01900000-0000-7000-8000-000000000002',
    nodeId: 'dev',
    lane: 'main',
    run: 1,
    prompt: 'do the task',
    env: { VUYRO_RUN_TOKEN: 'vrt_secret' },
    ...extra,
  };
}

interface Replay {
  readonly observations: RunObservation[];
  readonly settlement: AgentSettlement;
  readonly runner: FakeProcessRunner;
}

async function replay(
  provider: 'claude' | 'codex',
  fixture: string,
  options: { exit?: number | null; signal?: string; stderr?: string[]; extra?: Partial<AgentStartRequest> } = {},
): Promise<Replay> {
  const clock = new ManualClock();
  const runner = new FakeProcessRunner(clock);
  const dir = provider === 'claude' ? CLAUDE : CODEX;
  const steps: FakeStep[] = [
    ...lines(`${dir}${fixture}.jsonl`).map((line) => ({ stdout: line })),
    ...(options.stderr ?? []).map((line) => ({ stderr: line })),
    { exit: options.exit === undefined ? 0 : options.exit, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  ];
  runner.enqueue({ steps });
  const options_ = { runner, clock, resolve: (command: string) => command, baseEnv: {} };
  const adapter = provider === 'claude' ? CliAgentAdapter.claude(options_) : CliAgentAdapter.codex(options_);
  const handle = adapter.start(request(provider, options.extra));
  const observations: RunObservation[] = [];
  for await (const observation of handle.observations) observations.push(observation);
  return { observations, settlement: await handle.settled, runner };
}

const ofKind = <K extends RunObservation['kind']>(observations: RunObservation[], kind: K) =>
  observations.filter((observation): observation is Extract<RunObservation, { kind: K }> => observation.kind === kind);

describe('Claude Code 2.1.309 contract', () => {
  it('identifies the session once with model and CLI version', async () => {
    const { observations } = await replay('claude', 'simple');
    expect(ofKind(observations, 'session')).toMatchObject([{ model: 'claude-haiku-5-5', cliVersion: '2.1.309' }]);
    const id = ofKind(observations, 'session')[0]?.providerSessionId;
    const init = JSON.parse(lines(`${CLAUDE}simple.jsonl`)[0] ?? '{}') as { session_id: string };
    expect(id).toBe(init.session_id);
  });

  it('records the final usage once (scope run) with the list-price cost, not the streaming snapshots', async () => {
    const { observations } = await replay('claude', 'tools-read-write');
    const result = JSON.parse(lines(`${CLAUDE}tools-read-write.jsonl`).at(-1) ?? '{}') as {
      usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number };
      total_cost_usd: number;
    };
    expect(ofKind(observations, 'usage')).toEqual([
      {
        kind: 'usage',
        scope: 'run',
        tokens: {
          input: result.usage.input_tokens,
          cacheRead: result.usage.cache_read_input_tokens,
          cacheWrite: result.usage.cache_creation_input_tokens,
          output: result.usage.output_tokens,
        },
        cost: { usd: result.total_cost_usd, basis: 'list' },
        model: 'claude-haiku-5-5',
        observedAt: expect.any(Number) as number,
      },
    ]);
    expect(ofKind(observations, 'usage')[0]?.tokens.output).toBe(217);
  });

  it('pairs tool calls by provider id; success has no isError', async () => {
    const { observations } = await replay('claude', 'tools-read-write');
    const started = ofKind(observations, 'toolCallStarted');
    const finished = ofKind(observations, 'toolCallFinished');
    expect(started.map((call) => call.name)).toEqual(['Read', 'Write']);
    expect(finished.map((call) => call.toolCallId)).toEqual(started.map((call) => call.toolCallId));
    expect(started[0]?.toolCallId).toMatch(/^toolu_/);
    for (const call of finished) expect('isError' in call).toBe(false);
    expect(started[1]?.input).toMatchObject({ content: 'HELLO VUYRO\n' });
    expect(finished[0]?.output).toContain('hello vuyro');
  });

  it('records a failing tool as an error result and still settles succeeded', async () => {
    const { observations, settlement } = await replay('claude', 'tool-failure');
    expect(ofKind(observations, 'toolCallFinished')).toMatchObject([{ isError: true }]);
    expect(settlement).toMatchObject({ outcome: 'succeeded', exitCode: 0, terminalReason: 'completed' });
  });

  it('records a hook denial as an error tool result and keeps the hook events raw', async () => {
    const { observations } = await replay('claude', 'hook-deny-json');
    expect(ofKind(observations, 'toolCallFinished')).toMatchObject([{ isError: true, output: expect.stringContaining('PreToolUse:Write') as string }]);
    const raw = ofKind(observations, 'raw').map((observation) => observation.providerType);
    expect(raw).toEqual(expect.arrayContaining(['system/hook_started', 'system/hook_response', 'rate_limit_event', 'result']));
  });

  it('keeps messages split over lines under one message id', async () => {
    const { observations } = await replay('claude', 'hook-deny-edit');
    const messages = ofKind(observations, 'message');
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message.messageId).toMatch(/^msg_/);
    expect(messages.at(-1)?.text).toContain('did not go through');
  });

  it('settles a failed run from is_error and terminal_reason (subtype says success)', async () => {
    const { settlement } = await replay('claude', 'error-unknown-model', { exit: 1 });
    expect(settlement).toMatchObject({ outcome: 'failed', exitCode: 1, terminalReason: 'api_error' });
    expect(settlement.error).toMatch(/API error 404/);
  });

  it('settles a run without the final line as abnormal_exit', async () => {
    const { settlement } = await replay('claude', 'synthetic-truncated-no-result', { exit: 0, stderr: ['boom'] });
    expect(settlement).toMatchObject({ outcome: 'abnormal_exit', exitCode: 0 });
    expect(settlement.error).toContain('boom');
  });

  it('a resumed run reports the same session id (the Vuyro run id is the key)', async () => {
    const original = await replay('claude', 'simple');
    const resumed = await replay('claude', 'resume');
    expect(ofKind(resumed.observations, 'session')[0]?.providerSessionId).toBe(ofKind(original.observations, 'session')[0]?.providerSessionId);
  });
});

describe('Codex CLI 0.163.0 contract', () => {
  it('identifies the session from thread.started and reports the requested model', async () => {
    const { observations } = await replay('codex', 'simple', { extra: { model: 'gpt-6-luna' } });
    const thread = JSON.parse(lines(`${CODEX}simple.jsonl`)[0] ?? '{}') as { thread_id: string };
    expect(ofKind(observations, 'session')).toMatchObject([{ providerSessionId: thread.thread_id, model: 'gpt-6-luna' }]);
  });

  it('records usage per turn with cached input taken out of input, and no cost', async () => {
    const { observations } = await replay('codex', 'tools-read-write');
    expect(ofKind(observations, 'usage')).toEqual([
      {
        kind: 'usage',
        scope: 'turn',
        tokens: { input: 52877 - 40960, cacheRead: 40960, cacheWrite: 0, output: 113, reasoning: 0 },
        observedAt: expect.any(Number) as number,
      },
    ]);
  });

  it('pairs tool items by item id and reports messages', async () => {
    const { observations } = await replay('codex', 'tools-read-write');
    expect(ofKind(observations, 'toolCallStarted').map((call) => [call.toolCallId, call.name])).toEqual([
      ['item_1', 'command_execution'],
      ['item_2', 'file_change'],
    ]);
    expect(ofKind(observations, 'toolCallFinished')).toMatchObject([
      { toolCallId: 'item_1', output: expect.stringContaining('hello vuyro') as string },
      { toolCallId: 'item_2', output: expect.stringMatching(/^add .*output\.txt$/) as string },
    ]);
    for (const call of ofKind(observations, 'toolCallFinished')) expect('isError' in call).toBe(false);
    expect(ofKind(observations, 'message').map((message) => message.text).at(-1)).toBe('done');
  });

  it('records a failing command as an error result and still settles succeeded', async () => {
    const { observations, settlement } = await replay('codex', 'tool-failure');
    expect(ofKind(observations, 'toolCallFinished')).toMatchObject([{ isError: true }]);
    expect(settlement).toMatchObject({ outcome: 'succeeded', terminalReason: 'completed' });
  });

  it('treats error items and error lines as warnings and settles a failed turn as failed', async () => {
    const stderr = lines(`${CODEX}error-unknown-model.stderr.txt`);
    const { observations, settlement } = await replay('codex', 'error-unknown-model', { exit: 1, stderr });
    expect(ofKind(observations, 'warning').map((warning) => warning.source)).toEqual(['codex.item.error', 'codex.error']);
    expect(settlement).toMatchObject({ outcome: 'failed', exitCode: 1, terminalReason: 'turn_failed' });
    expect(settlement.error).toContain('not supported');
    expect(ofKind(observations, 'raw').filter((raw) => raw.stream === 'stderr').length).toBe(stderr.length);
  });

  it('keeps a hook denial (stderr only) raw', async () => {
    const stderr = lines(`${CODEX}hook-deny-apply-patch.stderr.txt`);
    const { observations } = await replay('codex', 'hook-deny-apply-patch', { stderr });
    const kept = ofKind(observations, 'raw').filter((raw) => raw.stream === 'stderr').map((raw) => String(raw.raw));
    expect(kept.some((line) => line.includes('Command blocked by PreToolUse hook'))).toBe(true);
    expect(ofKind(observations, 'toolCallStarted')).toEqual([]);
  });

  it('settles a run without turn.completed as abnormal_exit', async () => {
    const { settlement } = await replay('codex', 'synthetic-truncated-no-turn-end', { exit: 0 });
    expect(settlement.outcome).toBe('abnormal_exit');
  });

  it('a resumed run reports the same thread id', async () => {
    const original = await replay('codex', 'simple');
    const resumed = await replay('codex', 'resume');
    expect(ofKind(resumed.observations, 'session')[0]?.providerSessionId).toBe(ofKind(original.observations, 'session')[0]?.providerSessionId);
  });
});

describe('settlement with the process exit', () => {
  it.each([
    // [provider, fixture, exit, signal, outcome]
    ['claude', 'simple', 0, undefined, 'succeeded'],
    ['claude', 'simple', 1, undefined, 'failed'],
    ['claude', 'simple', null, 'SIGKILL', 'failed'],
    ['claude', 'error-unknown-model', 0, undefined, 'failed'],
    ['claude', 'synthetic-truncated-no-result', 1, undefined, 'abnormal_exit'],
    ['claude', 'synthetic-truncated-no-result', 3221225477, undefined, 'abnormal_exit'],
    ['claude', 'synthetic-truncated-no-result', null, 'SIGTERM', 'abnormal_exit'],
    ['codex', 'simple', 0, undefined, 'succeeded'],
    ['codex', 'simple', 2, undefined, 'failed'],
    ['codex', 'error-unknown-model', 0, undefined, 'failed'],
    ['codex', 'synthetic-truncated-no-turn-end', 1, undefined, 'abnormal_exit'],
    ['codex', 'synthetic-truncated-no-turn-end', null, 'SIGKILL', 'abnormal_exit'],
  ] as const)('%s %s, exit %s signal %s → %s', async (provider, fixture, exit, signal, outcome) => {
    const { settlement } = await replay(provider, fixture, { exit, ...(signal === undefined ? {} : { signal }) });
    expect(settlement.outcome).toBe(outcome);
    expect(settlement.exitCode).toBe(exit);
    expect(settlement.signal ?? null).toBe(signal ?? null);
    if (outcome === 'failed' && fixture === 'simple') expect(settlement.terminalReason).toBe('exit_code');
  });
});
