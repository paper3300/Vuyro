import type { DomainEvent, LogText, RunLogEntry } from '@vuyro/contracts';

/**
 * A run's events as the node log shows them (M6b). Text is cut to `textLimit` characters with its full length kept,
 * so a long tool output never travels whole unless someone asks for that one entry. Tool input is shown as JSON.
 */

export const DEFAULT_LOG_TEXT_LIMIT = 4000;

export function clip(text: string, limit: number): LogText {
  return { text: text.length > limit ? text.slice(0, limit) : text, length: text.length };
}

function json(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The log entry for one run event, or undefined for events that are not part of the log. */
export function runLogEntry(event: DomainEvent, textLimit: number): RunLogEntry | undefined {
  const base = { revision: event.revision, sequence: event.sequence };
  const at = (observed: number | undefined) => observed ?? event.timestamp;
  switch (event.type) {
    case 'run.started':
      return { ...base, at: event.timestamp, kind: 'started', provider: event.data.provider, ...(event.data.resumedFromRunId === undefined ? {} : { resumedFromRunId: event.data.resumedFromRunId }) };
    case 'run.sessionIdentified':
      return {
        ...base,
        at: at(event.data.observedAt),
        kind: 'session',
        ...(event.data.model === undefined ? {} : { model: event.data.model }),
        ...(event.data.cliVersion === undefined ? {} : { cliVersion: event.data.cliVersion }),
      };
    case 'run.messageRecorded':
      return {
        ...base,
        at: at(event.data.observedAt),
        kind: 'message',
        role: event.data.role,
        ...(event.data.messageId === undefined ? {} : { messageId: event.data.messageId }),
        text: clip(event.data.text, textLimit),
      };
    case 'run.toolCallStarted':
      return {
        ...base,
        at: at(event.data.observedAt),
        kind: 'toolStarted',
        toolCallId: event.data.toolCallId,
        name: event.data.name,
        ...(event.data.input === undefined ? {} : { input: clip(json(event.data.input), textLimit) }),
      };
    case 'run.toolCallFinished':
      return {
        ...base,
        at: at(event.data.observedAt),
        kind: 'toolFinished',
        toolCallId: event.data.toolCallId,
        isError: event.data.isError === true,
        ...(event.data.output === undefined ? {} : { output: clip(event.data.output, textLimit) }),
      };
    case 'run.usageRecorded':
      return { ...base, at: at(event.data.observedAt), kind: 'usage', scope: event.data.scope, tokens: event.data.tokens, ...(event.data.model === undefined ? {} : { model: event.data.model }) };
    case 'run.warningRecorded':
      return { ...base, at: at(event.data.observedAt), kind: 'warning', message: clip(event.data.message, textLimit), ...(event.data.source === undefined ? {} : { source: event.data.source }) };
    case 'run.rawRecorded':
      return {
        ...base,
        at: at(event.data.observedAt),
        kind: 'raw',
        stream: event.data.stream,
        ...(event.data.providerType === undefined ? {} : { providerType: event.data.providerType }),
        text: clip(json(event.data.raw), textLimit),
      };
    case 'run.settled':
      return {
        ...base,
        at: event.timestamp,
        kind: 'settled',
        outcome: event.data.outcome,
        ...(event.data.exitCode === undefined ? {} : { exitCode: event.data.exitCode }),
        ...(event.data.terminalReason === undefined ? {} : { terminalReason: event.data.terminalReason }),
        ...(event.data.error === undefined ? {} : { error: clip(event.data.error, textLimit) }),
      };
    default:
      return undefined;
  }
}
