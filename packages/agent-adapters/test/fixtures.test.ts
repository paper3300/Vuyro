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

describe('fixture files', () => {
  const files = [CLAUDE, CODEX].flatMap((dir) => readdirSync(new URL(dir, fixtures)).map((name) => dir + name));

  it.each(files)('%s is sanitized', (file) => {
    const content = text(file);
    const user = userInfo().username;
    if (user !== 'sample') expect(content.toLowerCase()).not.toContain(user.toLowerCase());
    expect(content).not.toMatch(/vuyro-m0b-\d+/);
  });

  it.each(files.filter((file) => file.endsWith('.jsonl')))('%s is JSONL with a type on every line', (file) => {
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

  it.each(['hook-exit2-not-blocked', 'hook-untrusted-not-run'])('%s: the patch went through', (name) => {
    expect(items(jsonl(`${CODEX}${name}.jsonl`), 'file_change')).toHaveLength(1);
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
