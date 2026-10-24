import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * Pins the facts recorded in 초기 검증 결과.md (M0b) to the fixtures,
 * so the M3 adapters are built against what the CLIs actually print.
 */

type Line = Record<string, unknown> & { type: string };

const fixtures = new URL('../fixtures/', import.meta.url);
const CLAUDE = 'claude/2.1.309/';
const CODEX = 'codex/0.163.0/';
const CLAUDE_2_1_310 = 'claude/2.1.310/';

function text(path: string): string {
  return readFileSync(new URL(path, fixtures), 'utf8');
}

function jsonl(path: string): Line[] {
  return text(path)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Line);
}

function only(lines: Line[], type: string, subtype?: string): Line[] {
  return lines.filter((line) => line.type === type && (subtype === undefined || line.subtype === subtype));
}

function first(lines: Line[], type: string, subtype?: string): Line {
  const found = only(lines, type, subtype)[0];
  if (found === undefined) throw new Error(`no ${type}${subtype === undefined ? '' : `/${subtype}`} line`);
  return found;
}

function contentBlocks(lines: Line[], type: 'assistant' | 'user'): Array<Record<string, unknown>> {
  return only(lines, type).flatMap((line) => (line.message as { content: Array<Record<string, unknown>> }).content);
}

function items(lines: Line[], type: string): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.type === 'item.completed')
    .map((line) => line.item as Record<string, unknown>)
    .filter((item) => item.type === type);
}

type Settle = 'succeeded' | 'failed' | 'unsettled';

/** Settle rule from 초기 검증 결과 M0b: is_error/terminal_reason, never subtype. */
function claudeSettle(lines: Line[]): Settle {
  const result = only(lines, 'result').at(-1);
  if (result === undefined) return 'unsettled';
  return result.is_error === false && result.terminal_reason === 'completed' ? 'succeeded' : 'failed';
}

/** Settle rule from 초기 검증 결과 M0b: the last turn.completed / turn.failed. */
function codexSettle(lines: Line[]): Settle {
  const end = lines.filter((line) => line.type === 'turn.completed' || line.type === 'turn.failed').at(-1);
  if (end === undefined) return 'unsettled';
  return end.type === 'turn.completed' ? 'succeeded' : 'failed';
}

function hookLog(path: string): Array<Record<string, unknown>> {
  return text(path)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('fixture files', () => {
  const files = [CLAUDE, CLAUDE_2_1_310, CODEX].flatMap((dir) => readdirSync(new URL(dir, fixtures)).map((name) => dir + name));

  // Read at run time; the real user name never appears in this file.
  const user = userInfo().username.toLowerCase();
  const userPrefixes = Array.from({ length: Math.max(0, user.length - 3) }, (_, i) => user.slice(0, user.length - i));

  it.each(files)('%s is sanitized', (file) => {
    const content = text(file).toLowerCase();
    // Also prefixes (4+ characters): tools truncate paths in their messages.
    if (!'sample'.startsWith(user.slice(0, 4))) {
      for (const prefix of userPrefixes) expect(content.includes(prefix), `contains "${prefix.slice(0, 2)}…"`).toBe(false);
    }
    expect(content).not.toMatch(/vuyro-m0b\d*-\d+/);
  });

  // Hook logs hold the hooks' stdin payloads, which have no `type`.
  const streams = files.filter((file) => file.endsWith('.jsonl') && !file.endsWith('.hook-log.jsonl'));
  it.each(streams)('%s is JSONL with a type on every line', (file) => {
    for (const line of jsonl(file)) expect(typeof line.type).toBe('string');
  });
});

describe('Claude Code 2.1.309 stream-json', () => {
  it('carries the session id on every line and starts with system/init', () => {
    const lines = jsonl(`${CLAUDE}simple.jsonl`);
    const init = first(lines, 'system', 'init');
    expect(lines[0]).toBe(init);
    expect(init).toMatchObject({ model: 'claude-haiku-5-5', claude_code_version: '2.1.309' });
    for (const line of lines) expect(line.session_id).toBe(init.session_id);
  });

  it('settles with one result line holding tokens and cost', () => {
    const lines = jsonl(`${CLAUDE}simple.jsonl`);
    expect(lines.at(-1)?.type).toBe('result');
    const result = first(lines, 'result');
    expect(result).toMatchObject({ subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'pong' });
    expect(typeof result.total_cost_usd).toBe('number');
    expect(result.usage).toMatchObject({
      input_tokens: expect.any(Number) as number,
      cache_creation_input_tokens: expect.any(Number) as number,
      cache_read_input_tokens: expect.any(Number) as number,
      output_tokens: expect.any(Number) as number,
    });
    expect(Object.keys(result.modelUsage as object)).toEqual(['claude-haiku-5-5']);
  });

  it('reports tool calls as tool_use blocks answered by tool_result blocks', () => {
    const lines = jsonl(`${CLAUDE}tools-read-write.jsonl`);
    const uses = contentBlocks(lines, 'assistant').filter((block) => block.type === 'tool_use');
    const results = contentBlocks(lines, 'user').filter((block) => block.type === 'tool_result');
    expect(uses.map((use) => use.name)).toEqual(['Read', 'Write']);
    expect(results.map((result) => result.tool_use_id)).toEqual(uses.map((use) => use.id));
    expect(first(lines, 'result').num_turns).toBe(3);
  });

  it('keeps the session id when resuming', () => {
    const original = first(jsonl(`${CLAUDE}simple.jsonl`), 'system', 'init');
    const resumed = jsonl(`${CLAUDE}resume.jsonl`);
    expect(first(resumed, 'system', 'init').session_id).toBe(original.session_id);
    expect(first(resumed, 'result').result).toBe('pong');
  });

  it('cannot tell a run from its resume by session id and turn count (Vuyro run id is the key)', () => {
    const original = first(jsonl(`${CLAUDE}simple.jsonl`), 'result');
    const resumed = first(jsonl(`${CLAUDE}resume.jsonl`), 'result');
    expect([resumed.session_id, resumed.num_turns]).toEqual([original.session_id, original.num_turns]);
  });

  it('gives the hook the same tool_use_id as the stream', () => {
    const hook = JSON.parse(text(`${CLAUDE}hook-input-pretooluse-write.json`)) as { tool_use_id: string };
    const uses = contentBlocks(jsonl(`${CLAUDE}hook-deny-json.jsonl`), 'assistant').filter((b) => b.type === 'tool_use');
    expect(uses.map((use) => use.id)).toEqual([hook.tool_use_id]);
  });

  it('omits is_error on successful tool results', () => {
    const results = contentBlocks(jsonl(`${CLAUDE}tools-read-write.jsonl`), 'user').filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const result of results) expect('is_error' in result).toBe(false);
  });

  it('reports a failing tool as an error result without failing the run', () => {
    const lines = jsonl(`${CLAUDE}tool-failure.jsonl`);
    const results = contentBlocks(lines, 'user').filter((b) => b.type === 'tool_result');
    expect(results).toMatchObject([{ is_error: true }]);
    expect(first(lines, 'result').permission_denials).toEqual([]); // not a hook/permission denial
    expect(claudeSettle(lines)).toBe('succeeded');
  });

  it.each([
    ['simple', 'succeeded'],
    ['error-unknown-model', 'failed'],
    ['synthetic-truncated-no-result', 'unsettled'],
  ] as const)('settles %s as %s', (name, expected) => {
    expect(claudeSettle(jsonl(`${CLAUDE}${name}.jsonl`))).toBe(expected);
  });

  it.each(['hook-deny-json', 'hook-deny-exit2', 'hook-deny-edit'])('%s: a PreToolUse hook denial is visible', (name) => {
    const lines = jsonl(`${CLAUDE}${name}.jsonl`);
    const denied = contentBlocks(lines, 'user').filter((block) => block.type === 'tool_result' && block.is_error === true);
    expect(denied).toHaveLength(1);
    expect(String(denied[0]?.content)).toContain('PreToolUse:');
    const denials = first(lines, 'result').permission_denials as Array<{ tool_name: string }>;
    expect(denials.map((denial) => denial.tool_name)).toEqual([name === 'hook-deny-edit' ? 'Edit' : 'Write']);
    expect(only(lines, 'system', 'hook_response')).toHaveLength(1);
  });

  it('marks a failed run with is_error, not with subtype', () => {
    const result = first(jsonl(`${CLAUDE}error-unknown-model.jsonl`), 'result');
    expect(result).toMatchObject({ subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 404 });
  });
});

describe('Codex CLI 0.163.0 exec --json', () => {
  it('announces the thread id once, first', () => {
    const lines = jsonl(`${CODEX}simple.jsonl`);
    expect(lines.map((line) => line.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(typeof lines[0]?.thread_id).toBe('string');
  });

  it('reports tokens per turn and no cost', () => {
    const completed = first(jsonl(`${CODEX}simple.jsonl`), 'turn.completed');
    expect(Object.keys(completed.usage as object).sort()).toEqual([
      'cache_write_input_tokens',
      'cached_input_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ]);
  });

  it('reports tool calls as items that start and complete', () => {
    const lines = jsonl(`${CODEX}tools-read-write.jsonl`);
    const started = lines.filter((line) => line.type === 'item.started').map((line) => (line.item as { type: string }).type);
    expect(started).toEqual(['command_execution', 'file_change']);
    expect(items(lines, 'command_execution')[0]).toMatchObject({ exit_code: 0, status: 'completed' });
    expect(items(lines, 'file_change')[0]).toMatchObject({ status: 'completed', changes: [{ kind: 'add' }] });
  });

  it('keeps the thread id when resuming', () => {
    const original = first(jsonl(`${CODEX}simple.jsonl`), 'thread.started');
    expect(first(jsonl(`${CODEX}resume.jsonl`), 'thread.started').thread_id).toBe(original.thread_id);
  });

  it('leaves no trace of a hook-denied apply_patch on stdout', () => {
    const lines = jsonl(`${CODEX}hook-deny-apply-patch.jsonl`);
    expect(lines.filter((line) => line.type === 'item.started')).toEqual([]);
    expect(items(lines, 'file_change')).toEqual([]);
    expect(text(`${CODEX}hook-deny-apply-patch.stderr.txt`)).toContain('Command blocked by PreToolUse hook');
  });

  it('exit 2 does not block: the hook ran (log) and the patch still went through', () => {
    const log = hookLog(`${CODEX}hook-exit2-not-blocked.hook-log.jsonl`);
    expect(log).toMatchObject([{ hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }]);
    const lines = jsonl(`${CODEX}hook-exit2-not-blocked.jsonl`);
    expect(log[0]?.session_id).toBe(first(lines, 'thread.started').thread_id);
    expect(items(lines, 'file_change')).toMatchObject([{ status: 'completed' }]);
  });

  it('without hook trust the injected hook is never called', () => {
    expect(text(`${CODEX}hook-untrusted-not-run.hook-log.jsonl`)).toBe('');
    expect(items(jsonl(`${CODEX}hook-untrusted-not-run.jsonl`), 'file_change')).toMatchObject([{ status: 'completed' }]);
  });

  it('hook tool_use_id and stream item.id of the same allowed call differ (not a join key)', () => {
    const [call] = hookLog(`${CODEX}hook-allowed-apply-patch.hook-log.jsonl`);
    const lines = jsonl(`${CODEX}hook-allowed-apply-patch.jsonl`);
    const [change] = items(lines, 'file_change');
    expect(call).toMatchObject({ tool_name: 'apply_patch', tool_use_id: expect.stringMatching(/^exec-/) as string });
    expect(change).toMatchObject({ id: expect.stringMatching(/^item_\d+$/) as string, status: 'completed' });
    expect(call?.tool_use_id).not.toBe(change?.id);
    // Only the session joins them: the hook's session_id is the stream's thread_id.
    expect(call?.session_id).toBe(first(lines, 'thread.started').thread_id);
  });

  it('reports a failing command as a failed item without failing the turn', () => {
    const lines = jsonl(`${CODEX}tool-failure.jsonl`);
    expect(items(lines, 'command_execution')).toMatchObject([{ status: 'failed', exit_code: 1 }]);
    expect(codexSettle(lines)).toBe('succeeded');
  });

  it.each([
    ['simple', 'succeeded'],
    ['error-unknown-model', 'failed'],
    ['synthetic-truncated-no-turn-end', 'unsettled'],
  ] as const)('settles %s as %s', (name, expected) => {
    expect(codexSettle(jsonl(`${CODEX}${name}.jsonl`))).toBe(expected);
  });

  it('names hooked tools apply_patch and Bash', () => {
    const patch = JSON.parse(text(`${CODEX}hook-input-pretooluse-apply-patch.json`)) as Record<string, unknown>;
    const shell = JSON.parse(text(`${CODEX}hook-input-pretooluse-bash.json`)) as Record<string, unknown>;
    expect(patch).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch' });
    expect(shell).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  });

  it('settles a failed run with turn.failed', () => {
    const lines = jsonl(`${CODEX}error-unknown-model.jsonl`);
    expect(lines.at(-1)?.type).toBe('turn.failed');
    expect(only(lines, 'turn.completed')).toEqual([]);
  });
});

/**
 * M7a: the real `vuyro hook pretooluse` in each real CLI, next to a hook that logs what its process sees (the
 * VUYRO_* names, the run token's shape, its parent processes). The run variables pointed at no engine, so the
 * Vuyro hook had to deny ([[초기 검증 결과]] M7a).
 */
describe('real vuyro checkout hook (M7a)', () => {
  const RUN_VARIABLES = ['VUYRO_DATA_DIR', 'VUYRO_LANE', 'VUYRO_NODE', 'VUYRO_PIPE', 'VUYRO_RUN_ID', 'VUYRO_RUN_TOKEN', 'VUYRO_TICKET'];

  it('Claude 2.1.310 runs hooks through Git Bash with every run variable, and the deny blocks the Write', () => {
    for (const entry of hookLog(`${CLAUDE_2_1_310}hook-deny-vuyro.hook-log.jsonl`)) {
      expect(entry).toMatchObject({ tool: 'Write', vuyro: RUN_VARIABLES, runTokenShape: true });
      expect((entry.parents as string[]).slice(0, 3)).toEqual(['bash.exe', 'bash.exe', 'claude.exe']);
    }
    const lines = jsonl(`${CLAUDE_2_1_310}hook-deny-vuyro.jsonl`);
    const results = contentBlocks(lines, 'user').filter((block) => block.type === 'tool_result');
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain('Vuyro: the checkout could not be made');
    }
    expect((first(lines, 'result').permission_denials as unknown[]).length).toBe(results.length);
    expect(claudeSettle(lines)).toBe('succeeded');
  });

  it('Codex 0.163.0 runs commandWindows through PowerShell with every run variable, and the deny blocks the patch', () => {
    const log = hookLog(`${CODEX}hook-deny-vuyro.hook-log.jsonl`);
    expect(log).toMatchObject([{ tool: 'apply_patch', vuyro: RUN_VARIABLES, runTokenShape: true }]);
    expect((log[0]?.parents as string[]).slice(0, 2)).toEqual(['powershell.exe', 'codex.exe']);
    const lines = jsonl(`${CODEX}hook-deny-vuyro.jsonl`);
    expect(items(lines, 'file_change')).toEqual([]);
    expect(text(`${CODEX}hook-deny-vuyro.stderr.txt`)).toContain('Command blocked by PreToolUse hook: Vuyro: the checkout could not be made');
    expect(codexSettle(lines)).toBe('succeeded');
  });

  it('Codex lets the edit through when the hook line does not run (a quoted path first, in PowerShell)', () => {
    expect(text(`${CODEX}hook-quoted-not-run.hook-log.jsonl`)).toBe('');
    expect(items(jsonl(`${CODEX}hook-quoted-not-run.jsonl`), 'file_change')).toMatchObject([{ status: 'completed' }]);
  });
});
