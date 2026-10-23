/** Messages between `SqliteWorker` (caller thread) and `sqlite-worker.ts` (DB thread). */

export type SqliteValue = null | number | bigint | string | Uint8Array;

export type SqliteParams = readonly SqliteValue[] | Readonly<Record<string, SqliteValue>>;

export interface SqliteStatement {
  readonly sql: string;
  readonly params?: SqliteParams;
}

export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export type JournalMode = 'wal' | 'delete';
export type SynchronousMode = 'off' | 'normal' | 'full';

export interface SqliteWorkerConfig {
  readonly path: string;
  /** Read-only connection (for reader workers). Default false. */
  readonly readOnly?: boolean;
  /** Applied by writable connections only. Default 'wal'. */
  readonly journalMode?: JournalMode;
  /** Default 'full'. In WAL mode 'normal' can lose the last commits on power loss, never on a process crash. */
  readonly synchronous?: SynchronousMode;
  /** Default 5000 ms. */
  readonly busyTimeoutMs?: number;
}

export type SqliteRequest =
  | { readonly id: number; readonly op: 'exec'; readonly sql: string }
  | { readonly id: number; readonly op: 'run' | 'all' | 'get'; readonly sql: string; readonly params?: SqliteParams }
  | { readonly id: number; readonly op: 'transaction'; readonly statements: readonly SqliteStatement[] }
  | { readonly id: number; readonly op: 'close' };

export interface SqliteErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly errcode?: number;
  readonly errstr?: string;
}

export type SqliteResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SqliteErrorInfo };

export type SqliteReady =
  | { readonly ready: true; readonly journalMode: string }
  | { readonly ready: false; readonly error: SqliteErrorInfo };
