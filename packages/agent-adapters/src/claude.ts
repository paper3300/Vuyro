import type { RunObservation } from '@vuyro/contracts';
import { clip, fitValue, LIMITS } from './limits.ts';
import type { ProviderTerminal, StreamNormalizer } from './settle.ts';

/**
 * Claude Code `-p --output-format stream-json --verbose` → normalized observations
 * (recorded facts: [[초기 검증 결과]] M0b, fixtures `fixtures/claude/2.1.309/`).
 *
 * - Session: `session_id` on every line; `system/init` also has the model and CLI version.
 * - Messages: `assistant.message.content[]` text blocks. One message id spans several lines (one block each).
 * - Tool calls: `tool_use {id, name, input}` → later `user` line `tool_result {tool_use_id, content, is_error?}`.
 *   `is_error` is absent on success.
 * - Usage: only the final `result.usage` is exact (per-message usage is a streaming snapshot). Recorded once
 *   with scope 'run'. Cost `total_cost_usd` is computed from list prices: basis 'list'.
 * - Final verdict: `result.is_error` and `terminal_reason`, never `subtype` (it says 'success' on failures too).
 * - Everything else (rate limits, hook events, thinking token counts, unknown lines) is kept raw.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const count = (value: unknown): number => {
  const n = num(value);
  return n === undefined || n < 0 ? 0 : Math.floor(n);
};

export function parseJsonLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rawObservation(stream: 'stdout' | 'stderr', raw: unknown, observedAt: number, providerType?: string): RunObservation {
  return {
    kind: 'raw',
    stream,
    raw: typeof raw === 'string' ? clip(raw, LIMITS.preview) : fitValue(raw),
    ...(providerType === undefined ? {} : { providerType: clip(providerType, LIMITS.providerType) }),
    observedAt,
  };
}

/** Text of a tool_result `content`: a string, or blocks of which the text ones are joined. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? undefined : JSON.stringify(content);
  const parts = content.map((block) => (isObject(block) && block.type === 'text' ? (str(block.text) ?? '') : `[${isObject(block) ? String(block.type) : 'item'}]`));
  return parts.join('\n');
}

export class ClaudeStreamNormalizer implements StreamNormalizer {
  private sessionId: string | undefined;
  private final: ProviderTerminal | undefined;

  get terminal(): ProviderTerminal | undefined {
    return this.final;
  }

  stdout(line: string, observedAt: number): RunObservation[] {
    if (line.trim() === '') return [];
    const json = parseJsonLine(line);
    if (json === undefined) return [rawObservation('stdout', line, observedAt)];
    const type = str(json.type);
    const out: RunObservation[] = [];
    this.session(json, observedAt, out);
    switch (type) {
      case 'system':
        // init is fully covered by the session observation; other subtypes (hooks, thinking tokens) stay raw.
        if (json.subtype !== 'init') out.push(rawObservation('stdout', json, observedAt, `system/${str(json.subtype) ?? '?'}`));
        break;
      case 'assistant':
        this.assistant(json, observedAt, out);
        break;
      case 'user':
        this.user(json, observedAt, out);
        break;
      case 'result':
        this.result(json, observedAt, out);
        break;
      default:
        out.push(rawObservation('stdout', json, observedAt, type ?? 'unknown'));
    }
    return out;
  }

  stderr(line: string, observedAt: number): RunObservation[] {
    return line.trim() === '' ? [] : [rawObservation('stderr', line, observedAt)];
  }

  private session(json: Json, observedAt: number, out: RunObservation[]): void {
    const id = str(json.session_id);
    if (id === undefined || id === '' || id === this.sessionId) return;
    this.sessionId = id;
    const init = json.type === 'system' && json.subtype === 'init';
    const model = init ? str(json.model) : undefined;
    const cliVersion = init ? str(json.claude_code_version) : undefined;
    out.push({
      kind: 'session',
      providerSessionId: clip(id, LIMITS.id),
      ...(model === undefined ? {} : { model: clip(model, LIMITS.model) }),
      ...(cliVersion === undefined ? {} : { cliVersion: clip(cliVersion, LIMITS.cliVersion) }),
      observedAt,
    });
  }

  private assistant(json: Json, observedAt: number, out: RunObservation[]): void {
    const message = isObject(json.message) ? json.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : undefined;
    if (message === undefined || content === undefined) {
      out.push(rawObservation('stdout', json, observedAt, 'assistant'));
      return;
    }
    const messageId = str(message.id);
    for (const block of content) {
      if (!isObject(block)) continue;
      switch (block.type) {
        case 'text': {
          const text = str(block.text) ?? '';
          if (text === '') break;
          out.push({ kind: 'message', role: 'assistant', ...(messageId === undefined ? {} : { messageId: clip(messageId, LIMITS.id) }), text: clip(text, LIMITS.text), observedAt });
          break;
        }
        case 'tool_use': {
          const id = str(block.id);
          const name = str(block.name);
          if (id === undefined || id === '' || name === undefined || name === '') {
            out.push(rawObservation('stdout', block, observedAt, 'assistant/tool_use'));
            break;
          }
          out.push({
            kind: 'toolCallStarted',
            toolCallId: clip(id, LIMITS.id),
            name: clip(name, LIMITS.name),
            ...(block.input === undefined ? {} : { input: fitValue(block.input) }),
            observedAt,
          });
          break;
        }
        case 'thinking':
          // Claude sends the signature only (the text is empty); a non-empty one is kept raw.
          if ((str(block.thinking) ?? '') !== '') out.push(rawObservation('stdout', block, observedAt, 'assistant/thinking'));
          break;
        default:
          out.push(rawObservation('stdout', block, observedAt, `assistant/${String(block.type)}`));
      }
    }
  }

  private user(json: Json, observedAt: number, out: RunObservation[]): void {
    const message = isObject(json.message) ? json.message : undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      if (content !== '') out.push({ kind: 'message', role: 'user', text: clip(content, LIMITS.text), observedAt });
      return;
    }
    if (!Array.isArray(content)) {
      out.push(rawObservation('stdout', json, observedAt, 'user'));
      return;
    }
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_result') {
        const id = str(block.tool_use_id);
        if (id === undefined || id === '') {
          out.push(rawObservation('stdout', block, observedAt, 'user/tool_result'));
          continue;
        }
        const output = toolResultText(block.content);
        out.push({
          kind: 'toolCallFinished',
          toolCallId: clip(id, LIMITS.id),
          // Absent means success (Claude sends is_error only on failures and denials).
          ...(block.is_error === true ? { isError: true } : {}),
          ...(output === undefined ? {} : { output: clip(output, LIMITS.toolOutput) }),
          observedAt,
        });
      } else if (block.type === 'text') {
        const text = str(block.text) ?? '';
        if (text !== '') out.push({ kind: 'message', role: 'user', text: clip(text, LIMITS.text), observedAt });
      } else {
        out.push(rawObservation('stdout', block, observedAt, `user/${String(block.type)}`));
      }
    }
  }

  private result(json: Json, observedAt: number, out: RunObservation[]): void {
    const usage = isObject(json.usage) ? json.usage : undefined;
    const models = isObject(json.modelUsage) ? Object.keys(json.modelUsage) : [];
    const model = models.length === 1 ? models[0] : undefined;
    const cost = num(json.total_cost_usd);
    if (usage !== undefined) {
      out.push({
        kind: 'usage',
        scope: 'run',
        tokens: {
          input: count(usage.input_tokens),
          cacheRead: count(usage.cache_read_input_tokens),
          cacheWrite: count(usage.cache_creation_input_tokens),
          output: count(usage.output_tokens),
        },
        ...(cost === undefined || cost < 0 ? {} : { cost: { usd: cost, basis: 'list' as const } }),
        ...(model === undefined ? {} : { model: clip(model, LIMITS.model) }),
        observedAt,
      });
    }
    // The rest of the line (durations, permission denials, turn count) is kept as it came.
    out.push(rawObservation('stdout', json, observedAt, 'result'));
    const terminalReason = str(json.terminal_reason);
    const ok = json.is_error === false && (terminalReason === undefined || terminalReason === 'completed');
    const status = num(json.api_error_status);
    const text = str(json.result);
    const reasonOrSubtype = terminalReason ?? str(json.subtype);
    this.final = {
      ok,
      ...(reasonOrSubtype === undefined ? {} : { terminalReason: reasonOrSubtype }),
      ...(ok ? {} : { error: [status === undefined ? undefined : `API error ${status}`, text].filter((part) => part !== undefined && part !== '').join(': ') || 'the run reported an error' }),
    };
  }
}

export interface ClaudeArgsInput {
  readonly model?: string;
  readonly resumeSessionId?: string;
  readonly extraArgs?: readonly string[];
}

/**
 * Arguments for one run. The prompt goes through stdin, never the command line (length limits, and the
 * command line of a process is visible to every other process).
 */
export function claudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(input.model === undefined || input.model === '' ? [] : ['--model', input.model]),
    ...(input.resumeSessionId === undefined ? [] : ['--resume', input.resumeSessionId]),
    ...(input.extraArgs ?? []),
  ];
}
