import type { RunObservation } from '@vuyro/contracts';
import { parseJsonLine, rawObservation } from './claude.ts';
import { clip, fitValue, LIMITS } from './limits.ts';
import type { ProviderTerminal, StreamNormalizer } from './settle.ts';

/**
 * Codex CLI `exec --json` → normalized observations
 * (recorded facts: [[초기 검증 결과]] M0b, fixtures `fixtures/codex/0.163.0/`).
 *
 * - Session: `thread.started.thread_id`, once (again on resume, with the same id). No model in the stream:
 *   the model the run asked for is reported instead.
 * - Messages: `item.completed` with `item.type = "agent_message"`.
 * - Tool calls: one `item.id` from `item.started` to `item.completed`: `command_execution` (failed status or a
 *   non-zero exit code is an error result), `file_change`, `mcp_tool_call`, `web_search`.
 * - `item.type = "error"` and the top-level `error` line are warnings, not failures.
 * - Usage: `turn.completed.usage` per turn (scope 'turn'). `input_tokens` includes cached input:
 *   input = input_tokens − cached_input_tokens. No cost.
 * - Final verdict: the last `turn.completed` (ok) or `turn.failed` (error message).
 * - Everything else is kept raw. A hook denial leaves nothing on stdout; stderr lines are kept raw.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

export interface CodexNormalizerOptions {
  /** The model the run was started with (Codex does not print it). */
  readonly model?: string;
}

export class CodexStreamNormalizer implements StreamNormalizer {
  private final: ProviderTerminal | undefined;
  private lastError: string | undefined;
  private readonly started = new Set<string>();
  private readonly model: string | undefined;

  constructor(options: CodexNormalizerOptions = {}) {
    this.model = options.model === undefined || options.model === '' ? undefined : clip(options.model, LIMITS.model);
  }

  get terminal(): ProviderTerminal | undefined {
    return this.final;
  }

  stdout(line: string, observedAt: number): RunObservation[] {
    if (line.trim() === '') return [];
    const json = parseJsonLine(line);
    if (json === undefined) return [rawObservation('stdout', line, observedAt)];
    const type = str(json.type) ?? 'unknown';
    switch (type) {
      case 'thread.started': {
        const id = str(json.thread_id);
        if (id === undefined || id === '') return [rawObservation('stdout', json, observedAt, type)];
        return [{ kind: 'session', providerSessionId: clip(id, LIMITS.id), ...(this.model === undefined ? {} : { model: this.model }), observedAt }];
      }
      case 'turn.started':
        return [];
      case 'item.started':
        return this.itemStarted(json, observedAt);
      case 'item.completed':
        return this.itemCompleted(json, observedAt);
      case 'turn.completed': {
        this.final = { ok: true, terminalReason: 'completed' };
        const usage = isObject(json.usage) ? json.usage : undefined;
        if (usage === undefined) return [rawObservation('stdout', json, observedAt, type)];
        const input = count(usage.input_tokens);
        const cached = count(usage.cached_input_tokens);
        return [
          {
            kind: 'usage',
            scope: 'turn',
            tokens: {
              input: Math.max(0, input - cached),
              cacheRead: cached,
              cacheWrite: count(usage.cache_write_input_tokens),
              output: count(usage.output_tokens),
              reasoning: count(usage.reasoning_output_tokens),
            },
            ...(this.model === undefined ? {} : { model: this.model }),
            observedAt,
          },
        ];
      }
      case 'turn.failed': {
        const error = isObject(json.error) ? str(json.error.message) : undefined;
        this.final = { ok: false, terminalReason: 'turn_failed', error: error ?? this.lastError ?? 'the turn failed' };
        return [rawObservation('stdout', json, observedAt, type)];
      }
      case 'error': {
        const message = str(json.message) ?? JSON.stringify(json);
        this.lastError = message;
        return [{ kind: 'warning', message: clip(message, LIMITS.warning), source: 'codex.error', observedAt }];
      }
      default:
        return [rawObservation('stdout', json, observedAt, type)];
    }
  }

  stderr(line: string, observedAt: number): RunObservation[] {
    return line.trim() === '' ? [] : [rawObservation('stderr', line, observedAt)];
  }

  private itemStarted(json: Json, observedAt: number): RunObservation[] {
    const item = isObject(json.item) ? json.item : undefined;
    const id = str(item?.id);
    const kind = str(item?.type);
    if (item === undefined || id === undefined || kind === undefined) return [rawObservation('stdout', json, observedAt, 'item.started')];
    if (!TOOL_ITEMS.has(kind)) return [rawObservation('stdout', json, observedAt, `item.started/${kind}`)];
    this.started.add(id);
    return [this.toolStarted(id, kind, item, observedAt)];
  }

  private itemCompleted(json: Json, observedAt: number): RunObservation[] {
    const item = isObject(json.item) ? json.item : undefined;
    const id = str(item?.id);
    const kind = str(item?.type);
    if (item === undefined || id === undefined || kind === undefined) return [rawObservation('stdout', json, observedAt, 'item.completed')];
    switch (kind) {
      case 'agent_message': {
        const text = str(item.text) ?? '';
        return text === '' ? [] : [{ kind: 'message', role: 'assistant', messageId: clip(id, LIMITS.id), text: clip(text, LIMITS.text), observedAt }];
      }
      case 'error':
        // e.g. "Model metadata … not found", "--dangerously-bypass-hook-trust is enabled": warnings.
        return [{ kind: 'warning', message: clip(str(item.message) ?? JSON.stringify(item), LIMITS.warning), source: 'codex.item.error', observedAt }];
      default:
        if (!TOOL_ITEMS.has(kind)) return [rawObservation('stdout', json, observedAt, `item.completed/${kind}`)];
    }
    const out: RunObservation[] = [];
    // A tool item may complete without a start line; the call still gets both halves.
    if (!this.started.has(id)) out.push(this.toolStarted(id, kind, item, observedAt));
    this.started.delete(id);
    const status = str(item.status);
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const failed = status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0) || item.error !== undefined;
    const output = toolOutput(kind, item);
    out.push({
      kind: 'toolCallFinished',
      toolCallId: clip(id, LIMITS.id),
      ...(failed ? { isError: true } : {}),
      ...(output === undefined ? {} : { output: clip(output, LIMITS.toolOutput) }),
      observedAt,
    });
    return out;
  }

  private toolStarted(id: string, kind: string, item: Json, observedAt: number): RunObservation {
    const name = kind === 'mcp_tool_call' ? `mcp:${str(item.server) ?? '?'}/${str(item.tool) ?? '?'}` : kind;
    let input: unknown;
    if (kind === 'command_execution') input = { command: item.command };
    else if (kind === 'file_change') input = { changes: item.changes };
    else if (kind === 'mcp_tool_call') input = item.arguments;
    else input = { query: item.query };
    return { kind: 'toolCallStarted', toolCallId: clip(id, LIMITS.id), name: clip(name, LIMITS.name), ...(input === undefined ? {} : { input: fitValue(input) }), observedAt };
  }
}

function toolOutput(kind: string, item: Json): string | undefined {
  switch (kind) {
    case 'command_execution':
      return str(item.aggregated_output);
    case 'file_change':
      return Array.isArray(item.changes)
        ? item.changes.map((change) => (isObject(change) ? `${str(change.kind) ?? '?'} ${str(change.path) ?? '?'}` : '?')).join('\n')
        : undefined;
    default: {
      const value = item.result ?? item.error;
      return value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
}

export interface CodexArgsInput {
  readonly model?: string;
  readonly resumeSessionId?: string;
  readonly extraArgs?: readonly string[];
}

/** Arguments for one run. `-` makes Codex read the prompt from stdin (never the command line). */
export function codexArgs(input: CodexArgsInput): string[] {
  return [
    'exec',
    '--json',
    ...(input.model === undefined || input.model === '' ? [] : ['-m', input.model]),
    ...(input.extraArgs ?? []),
    ...(input.resumeSessionId === undefined ? ['-'] : ['resume', input.resumeSessionId, '-']),
  ];
}
