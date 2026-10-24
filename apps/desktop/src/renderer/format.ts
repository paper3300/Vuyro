/** Words and numbers as the screens show them (Korean UI). */

export const STATUS_LABELS: Readonly<Record<string, string>> = {
  wait: '대기',
  queued: '차례 대기',
  running: '실행 중',
  review: '사람 차례',
  done: '완료',
  failed: '실패',
  rejected: '반려됨',
  paused: '일시정지',
  stale: '낡음',
  superseded: '밀려남',
  discarded: '버려짐',
  open: '진행 중',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const CAUSE_LABELS: Readonly<Record<string, string>> = {
  start: '시작',
  input: '입력',
  rework: '재작업',
  review: '검토 반려',
  retry: '다시 시도',
};

export function causeLabel(cause: string): string {
  return CAUSE_LABELS[cause] ?? cause;
}

/** Why an execution was cut short (`superseded_by`). */
export function supersedeLabel(reason: unknown): string | undefined {
  if (reason === 'new-input') return '새 입력이 와서 밀려남';
  if (reason === 'replaced') return '계획이 다시 짜여 밀려남';
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

/** `2시간 14분`, `35분`, `12초`, `3일 4시간`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}시간` : `${hours}시간 ${minutes % 60}분`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}일` : `${days}일 ${hours % 24}시간`;
}

/** `950`, `12.3k`, `1.2M`. */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return '—';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return '—';
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Short ticket handle for cards: the id's last six characters (UUIDv7 ids start with the time, so they look alike). */
export function shortId(id: string): string {
  return `T-${id.replace(/-/g, '').slice(-6)}`;
}

export function totalTokens(tokens: { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined): number {
  if (tokens === undefined) return 0;
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** Engine error codes in words; the engine's own message follows. */
export function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code, message } = error as { code: string; message?: string };
    const prefix: Readonly<Record<string, string>> = {
      forbidden: '권한이 없습니다',
      engine_offline: '엔진에 연결되어 있지 않습니다',
      invariant_violated: '지금 상태에서는 할 수 없습니다',
      validation_failed: '입력이 맞지 않습니다',
      not_found: '찾을 수 없습니다',
      revision_conflict: '그 사이 바뀌었습니다. 다시 시도하세요',
      unauthenticated: '인증되지 않았습니다',
      bridge_refused: '앱이 이 요청을 막았습니다',
    };
    const head = prefix[code];
    if (head === undefined) return message ?? code;
    return message === undefined || message === '' ? head : `${head}: ${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
