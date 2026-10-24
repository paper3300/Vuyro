import type { LogText, RunLogEntry } from '@vuyro/contracts';
import { formatTokens } from './format.ts';

/**
 * A run's log entries as rows (M6b node detail): a tool call's start and end become one row with how long it took and
 * the first line of its result; message lines that share a provider message id become one message. Pure, so the
 * screen only draws.
 */

export type LogRow =
  | { readonly key: string; readonly kind: 'message'; readonly at: number; readonly role: string; readonly text: LogText; readonly revisions: readonly number[] }
  | {
      readonly key: string;
      readonly kind: 'tool';
      readonly at: number;
      readonly name: string;
      readonly input?: LogText;
      readonly output?: LogText;
      /** Revision of the finish entry (to fetch its output in full). */
      readonly outputRevision?: number;
      readonly inputRevision?: number;
      readonly isError: boolean;
      readonly finished: boolean;
      readonly durationMs?: number;
      /** First non-empty line of the result. */
      readonly summary?: string;
    }
  | { readonly key: string; readonly kind: 'note'; readonly at: number; readonly tone: 'info' | 'warn' | 'error' | 'done'; readonly text: string; readonly detail?: LogText }
  | { readonly key: string; readonly kind: 'raw'; readonly at: number; readonly stream: string; readonly providerType?: string; readonly text: LogText };

const SUMMARY = 160;

export function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== '');
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  return trimmed.length > SUMMARY ? `${trimmed.slice(0, SUMMARY)}…` : trimmed;
}

const OUTCOME: Readonly<Record<string, { text: string; tone: 'done' | 'error' | 'warn' }>> = {
  succeeded: { text: '실행이 끝났습니다 (성공)', tone: 'done' },
  failed: { text: '실행이 실패로 끝났습니다', tone: 'error' },
  abnormal_exit: { text: '프로세스가 마지막 보고 없이 끝났습니다', tone: 'error' },
  cancelled: { text: '실행이 취소되었습니다', tone: 'warn' },
};

export function buildLogRows(entries: readonly RunLogEntry[]): LogRow[] {
  const rows: LogRow[] = [];
  const tools = new Map<string, number>();
  for (const entry of entries) {
    const key = `r${String(entry.revision)}`;
    switch (entry.kind) {
      case 'message': {
        const last = rows.at(-1);
        if (entry.messageId !== undefined && last?.kind === 'message' && last.key.startsWith(`m:${entry.messageId}:`)) {
          const text = `${last.text.text}\n${entry.text.text}`;
          rows[rows.length - 1] = { ...last, text: { text, length: last.text.length + 1 + entry.text.length }, revisions: [...last.revisions, entry.revision] };
        } else {
          rows.push({ key: entry.messageId === undefined ? key : `m:${entry.messageId}:${key}`, kind: 'message', at: entry.at, role: entry.role, text: entry.text, revisions: [entry.revision] });
        }
        break;
      }
      case 'toolStarted':
        tools.set(entry.toolCallId, rows.length);
        rows.push({ key, kind: 'tool', at: entry.at, name: entry.name, ...(entry.input === undefined ? {} : { input: entry.input, inputRevision: entry.revision }), isError: false, finished: false });
        break;
      case 'toolFinished': {
        const index = tools.get(entry.toolCallId);
        const started = index === undefined ? undefined : rows[index];
        const summary = entry.output === undefined ? undefined : firstLine(entry.output.text);
        const finish = {
          ...(entry.output === undefined ? {} : { output: entry.output, outputRevision: entry.revision }),
          isError: entry.isError,
          finished: true,
          ...(summary === undefined ? {} : { summary }),
        };
        if (started?.kind === 'tool' && index !== undefined) {
          rows[index] = { ...started, ...finish, durationMs: Math.max(0, entry.at - started.at) };
          tools.delete(entry.toolCallId);
        } else {
          rows.push({ key, kind: 'tool', at: entry.at, name: entry.toolCallId, ...finish });
        }
        break;
      }
      case 'started':
        rows.push({ key, kind: 'note', at: entry.at, tone: 'info', text: `실행 시작 (${entry.provider})${entry.resumedFromRunId === undefined ? '' : ' · 이전 세션에서 이어서'}` });
        break;
      case 'session':
        rows.push({ key, kind: 'note', at: entry.at, tone: 'info', text: `세션 연결${entry.model === undefined ? '' : ` · 모델 ${entry.model}`}${entry.cliVersion === undefined ? '' : ` · CLI ${entry.cliVersion}`}` });
        break;
      case 'usage': {
        const tokens = entry.tokens;
        rows.push({
          key,
          kind: 'note',
          at: entry.at,
          tone: 'info',
          text: `${entry.scope === 'run' ? '실행 전체' : '한 턴'} 토큰 · 입력 ${formatTokens(tokens.input)} · 캐시 ${formatTokens(tokens.cacheRead + tokens.cacheWrite)} · 출력 ${formatTokens(tokens.output)}`,
        });
        break;
      }
      case 'warning':
        rows.push({ key, kind: 'note', at: entry.at, tone: 'warn', text: `경고${entry.source === undefined ? '' : ` (${entry.source})`}`, detail: entry.message });
        break;
      case 'raw':
        rows.push({ key, kind: 'raw', at: entry.at, stream: entry.stream, ...(entry.providerType === undefined ? {} : { providerType: entry.providerType }), text: entry.text });
        break;
      case 'settled': {
        const outcome = OUTCOME[entry.outcome] ?? { text: `실행 끝 (${entry.outcome})`, tone: 'warn' as const };
        const reason = entry.terminalReason === undefined ? '' : ` · ${entry.terminalReason}`;
        rows.push({ key, kind: 'note', at: entry.at, tone: outcome.tone, text: `${outcome.text}${reason}`, ...(entry.error === undefined ? {} : { detail: entry.error }) });
        break;
      }
    }
  }
  return rows;
}

/** `850ms`, `12.4s`, `2m 10s`. */
export function formatToolDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}
