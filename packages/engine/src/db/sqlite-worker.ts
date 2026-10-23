/**
 * Worker thread entry that owns one `node:sqlite` connection.
 * `DatabaseSync` blocks its thread, so the engine never opens it on the main thread.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  SqliteErrorInfo,
  SqliteParams,
  SqliteReady,
  SqliteRequest,
  SqliteResponse,
  SqliteRunResult,
  SqliteStatement,
  SqliteWorkerConfig,
} from './sqlite-worker-protocol.ts';

const STATEMENT_CACHE_LIMIT = 256;

const port = parentPort;
if (port === null) throw new Error('sqlite-worker must run in a worker thread');

const config = workerData as SqliteWorkerConfig;
let db: DatabaseSync;
try {
  db = open(config);
  const ready: SqliteReady = { ready: true, journalMode: journalMode(db) };
  port.postMessage(ready);
} catch (error) {
  const failed: SqliteReady = { ready: false, error: toErrorInfo(error) };
  port.postMessage(failed);
  process.exit(1);
}

const statements = new Map<string, StatementSync>();

port.on('message', (request: SqliteRequest) => {
  let response: SqliteResponse;
  try {
    response = { id: request.id, ok: true, result: handle(request) };
  } catch (error) {
    response = { id: request.id, ok: false, error: toErrorInfo(error) };
  }
  port.postMessage(response);
  if (request.op === 'close' && response.ok) port.close();
});

function open(options: SqliteWorkerConfig): DatabaseSync {
  const readOnly = options.readOnly ?? false;
  const database = new DatabaseSync(options.path, { readOnly });
  database.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  if (!readOnly) {
    database.exec(`PRAGMA journal_mode = ${options.journalMode ?? 'wal'}`);
    database.exec(`PRAGMA synchronous = ${options.synchronous ?? 'full'}`);
    database.exec('PRAGMA foreign_keys = ON');
  }
  return database;
}

function journalMode(database: DatabaseSync): string {
  const row = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
  return row?.journal_mode ?? 'unknown';
}

function handle(request: SqliteRequest): unknown {
  switch (request.op) {
    case 'exec':
      db.exec(request.sql);
      return null;
    case 'run':
      return runResult(bind(prepare(request.sql), 'run', request.params));
    case 'all':
      return bind(prepare(request.sql), 'all', request.params);
    case 'get':
      return bind(prepare(request.sql), 'get', request.params);
    case 'transaction':
      return transaction(request.statements);
    case 'close':
      statements.clear();
      db.close();
      return null;
  }
}

let crashCountdown = config.testCrash?.occurrence ?? 0;

/** See SqliteWorkerConfig.testCrash. Terminates the process mid-transaction, before COMMIT. */
function maybeCrash(sql: string): void {
  const crash = config.testCrash;
  if (crash === undefined || !sql.trimStart().startsWith(crash.afterStatement)) return;
  crashCountdown -= 1;
  if (crashCountdown === 0) process.kill(process.pid, 'SIGKILL');
}

function transaction(batch: readonly SqliteStatement[]): SqliteRunResult[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const results = batch.map((statement) => {
      const result = runResult(bind(prepare(statement.sql), 'run', statement.params));
      maybeCrash(statement.sql);
      return result;
    });
    db.exec('COMMIT');
    return results;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function prepare(sql: string): StatementSync {
  let statement = statements.get(sql);
  if (statement === undefined) {
    if (statements.size >= STATEMENT_CACHE_LIMIT) statements.clear();
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

function bind(statement: StatementSync, method: 'run' | 'all' | 'get', params: SqliteParams | undefined): unknown {
  if (params === undefined) return statement[method]();
  if (Array.isArray(params)) return statement[method](...(params as SQLInputValue[]));
  return statement[method](params as Record<string, SQLInputValue>);
}

function runResult(value: unknown): SqliteRunResult {
  const { changes, lastInsertRowid } = value as SqliteRunResult;
  return { changes, lastInsertRowid };
}

function toErrorInfo(error: unknown): SqliteErrorInfo {
  if (!(error instanceof Error)) return { message: String(error) };
  const details = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return {
    message: error.message,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(typeof details.errcode === 'number' ? { errcode: details.errcode } : {}),
    ...(typeof details.errstr === 'string' ? { errstr: details.errstr } : {}),
  };
}
