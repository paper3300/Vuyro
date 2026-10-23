import { Worker } from 'node:worker_threads';
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

export class SqliteWorkerError extends Error {
  readonly code: string | undefined;
  readonly errcode: number | undefined;
  readonly errstr: string | undefined;

  constructor(info: SqliteErrorInfo) {
    super(info.message);
    this.name = 'SqliteWorkerError';
    this.code = info.code;
    this.errcode = info.errcode;
    this.errstr = info.errstr;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type Request = SqliteRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

// Running from source (tests, spikes) loads the .ts worker through Node's type stripping.
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './sqlite-worker.ts' : './sqlite-worker.js', import.meta.url);

/**
 * One `node:sqlite` connection living in its own worker thread.
 * Requests run in order; a writer and any number of readers can share a WAL database.
 */
export class SqliteWorker {
  readonly journalMode: string;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exitError: Error | undefined;

  private constructor(worker: Worker, journalMode: string) {
    this.worker = worker;
    this.journalMode = journalMode;
    worker.on('message', (response: SqliteResponse) => {
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new SqliteWorkerError(response.error));
    });
    const fail = (error: Error): void => {
      this.exitError ??= error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      fail(new Error(`sqlite worker exited (code ${code})`));
    });
  }

  static open(config: SqliteWorkerConfig): Promise<SqliteWorker> {
    const worker = new Worker(workerUrl, { workerData: config });
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      worker.once('error', onError);
      worker.once('message', (ready: SqliteReady) => {
        worker.off('error', onError);
        if (ready.ready) {
          resolve(new SqliteWorker(worker, ready.journalMode));
        } else {
          reject(new SqliteWorkerError(ready.error));
        }
      });
    });
  }

  exec(sql: string): Promise<void> {
    return this.request({ op: 'exec', sql }).then(() => undefined);
  }

  run(sql: string, params?: SqliteParams): Promise<SqliteRunResult> {
    return this.request(withParams({ op: 'run', sql }, params)) as Promise<SqliteRunResult>;
  }

  all<T>(sql: string, params?: SqliteParams): Promise<T[]> {
    return this.request(withParams({ op: 'all', sql }, params)) as Promise<T[]>;
  }

  get<T>(sql: string, params?: SqliteParams): Promise<T | undefined> {
    return this.request(withParams({ op: 'get', sql }, params)) as Promise<T | undefined>;
  }

  /** Runs the statements inside BEGIN IMMEDIATE … COMMIT; rolls back on the first error. */
  transaction(statements: readonly SqliteStatement[]): Promise<SqliteRunResult[]> {
    return this.request({ op: 'transaction', statements }) as Promise<SqliteRunResult[]>;
  }

  async close(): Promise<void> {
    if (this.exitError !== undefined) return;
    const exited = new Promise<void>((resolve) => this.worker.once('exit', () => { resolve(); }));
    await this.request({ op: 'close' });
    await exited;
  }

  private request(request: Request): Promise<unknown> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }
}

function withParams<T extends object>(request: T, params: SqliteParams | undefined): T & { params?: SqliteParams } {
  return params === undefined ? request : { ...request, params };
}
