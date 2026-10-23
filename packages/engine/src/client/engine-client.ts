import type net from 'node:net';
import {
  type ClientKind,
  type CommandError,
  type CommandSuccess,
  type DomainEvent,
  type HelloResult,
  PROTOCOL_VERSION,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
} from '@vuyro/contracts';
import { readEngineToken } from '../ipc/engine-token.ts';
import { connectAuthenticatedPipe } from '../ipc/pipe-auth.ts';
import { defaultDataDir, defaultPipePath, enginePaths } from '../daemon/paths.ts';

/**
 * Client side of the engine protocol ([[명령·이벤트 계약]] §11), for the `vuyro` CLI and the app's main process:
 * finds the engine of a data directory, proves the engine token, says hello, then sends JSON-RPC requests.
 */

export interface EngineClientOptions {
  readonly client: ClientKind;
  /** Default: `VUYRO_DATA_DIR` or `%LOCALAPPDATA%\Vuyro`. */
  readonly dataDir?: string;
  /** Default: `VUYRO_PIPE` or the data directory's pipe name. */
  readonly pipePath?: string;
  readonly uiCredential?: string;
  readonly humanCredential?: string;
  /** Handshake time limit. Default 5 s. */
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** No engine answers for this data directory (not running, or its files are missing). */
export class EngineUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineUnavailableError';
  }
}

/** A request the engine refused. `data` is the command error object (same as in-process and in the CLI). */
export class EngineRequestError extends Error {
  readonly rpcCode: number;
  readonly data: CommandError;

  constructor(rpcCode: number, message: string, data: CommandError | undefined) {
    super(message);
    this.name = 'EngineRequestError';
    this.rpcCode = rpcCode;
    this.data = data ?? { code: 'internal', message, retryable: false };
  }
}

/** Where the engine of these options listens. */
export function resolveEngineLocation(options: Pick<EngineClientOptions, 'dataDir' | 'pipePath' | 'env'> = {}): { dataDir: string; pipePath: string; tokenPath: string } {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? (env.VUYRO_DATA_DIR !== undefined && env.VUYRO_DATA_DIR !== '' ? env.VUYRO_DATA_DIR : defaultDataDir(env));
  const paths = enginePaths(dataDir);
  const pipePath = options.pipePath ?? (env.VUYRO_PIPE !== undefined && env.VUYRO_PIPE !== '' ? env.VUYRO_PIPE : defaultPipePath(paths.dataDir));
  return { dataDir: paths.dataDir, pipePath, tokenPath: paths.token };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type NotificationHandler = (params: unknown) => void;

export class EngineClient {
  readonly hello: HelloResult;
  private readonly socket: net.Socket;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private nextId = 1;
  private buffer = '';
  private closedError: Error | undefined;

  private constructor(socket: net.Socket, hello: HelloResult) {
    this.socket = socket;
    this.hello = hello;
  }

  static async connect(options: EngineClientOptions): Promise<EngineClient> {
    const location = resolveEngineLocation(options);
    let token: Buffer;
    try {
      token = readEngineToken(location.tokenPath);
    } catch (error) {
      throw new EngineUnavailableError(`no engine token at ${location.tokenPath} (is the engine running?)`, { cause: error });
    }
    let socket: net.Socket;
    try {
      socket = await connectAuthenticatedPipe(location.pipePath, token, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
    } catch (error) {
      throw new EngineUnavailableError(`cannot reach the engine at ${location.pipePath}: ${(error as Error).message}`, { cause: error });
    }
    const client = new EngineClient(socket, { protocol: 0, engineVersion: '', identity: 'unverified', lastSequence: 0 });
    client.attach();
    try {
      const hello = await client.request<HelloResult>(RPC_METHODS.hello, {
        protocol: PROTOCOL_VERSION,
        client: options.client,
        ...(options.uiCredential === undefined ? {} : { uiCredential: options.uiCredential }),
        ...(options.humanCredential === undefined ? {} : { humanCredential: options.humanCredential }),
      });
      (client as { hello: HelloResult }).hello = hello;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closedError !== undefined) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => { resolve(value as T); }, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  /** Sends a command envelope; resolves with the success response, rejects with EngineRequestError. */
  execute(envelope: unknown): Promise<CommandSuccess> {
    return this.request<CommandSuccess>(RPC_METHODS.execute, envelope);
  }

  on(method: string, handler: NotificationHandler): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Receives every event after `afterSequence`, in order, then live. On overflow (the client fell behind) the
   * engine drops the subscription; this resubscribes from the last event it delivered.
   */
  async subscribe(afterSequence: number, onEvents: (events: readonly DomainEvent[]) => void): Promise<{ unsubscribe(): Promise<void>; readonly last: () => number }> {
    let last = afterSequence;
    let subscription: string | undefined;
    let stopped = false;
    const offEvents = this.on(RPC_NOTIFICATIONS.events, (params) => {
      const { subscription: id, events } = params as { subscription: string; events: DomainEvent[] };
      if (id !== subscription || stopped) return;
      const fresh = events.filter((event) => event.sequence > last);
      if (fresh.length === 0) return;
      last = fresh.at(-1)?.sequence ?? last;
      onEvents(fresh);
    });
    const start = async (): Promise<void> => {
      subscription = undefined;
      const result = await this.request<{ subscription: string }>(RPC_METHODS.subscribe, { afterSequence: last });
      subscription = result.subscription;
    };
    const offOverflow = this.on(RPC_NOTIFICATIONS.overflow, (params) => {
      const { subscription: id } = params as { subscription: string };
      if (id !== subscription || stopped) return;
      void start().catch(() => undefined);
    });
    await start();
    return {
      last: () => last,
      unsubscribe: async () => {
        stopped = true;
        offEvents();
        offOverflow();
        if (subscription !== undefined && this.closedError === undefined) await this.request(RPC_METHODS.unsubscribe, { subscription });
      },
    };
  }

  close(): void {
    this.fail(new Error('the connection was closed'));
    this.socket.destroy();
  }

  /** True once the connection is gone (closed here or by the engine). */
  get closed(): boolean {
    return this.closedError !== undefined;
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim() !== '') this.onLine(line);
        newline = this.buffer.indexOf('\n');
      }
    });
    this.socket.on('close', () => {
      this.fail(new EngineUnavailableError('the engine closed the connection'));
    });
    this.socket.on('error', (error) => {
      this.fail(new EngineUnavailableError(`engine connection error: ${error.message}`, { cause: error }));
    });
    this.socket.resume();
  }

  private onLine(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: CommandError } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.method === 'string') {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new EngineRequestError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closedError !== undefined) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
