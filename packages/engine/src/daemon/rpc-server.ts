import type { Duplex } from 'node:stream';
import {
  ArtifactsQuerySchema,
  COMMAND_ERRORS,
  type CommandError,
  commandError,
  type DomainEvent,
  type EngineStatus,
  type HelloParams,
  HelloParamsSchema,
  type HelloResult,
  PairParamsSchema,
  type PairResult,
  ProjectsQuerySchema,
  PROTOCOL_VERSION,
  ReadEventsParamsSchema,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  RPC_PROTOCOL_ERRORS,
  type SchemaValidator,
  type Static,
  ShutdownParamsSchema,
  StatusParamsSchema,
  SubscribeParamsSchema,
  TicketQuerySchema,
  TicketsQuerySchema,
  type TSchema,
  UnsubscribeParamsSchema,
  WorkspaceQuerySchema,
  WorktreeCleanupQuerySchema,
  SharedNodesQuerySchema,
} from '@vuyro/contracts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { TransportIdentity } from '../commands/caller.ts';
import type { Clock } from '../runtime/clock.ts';
import type { RandomSource } from '../runtime/ids.ts';
import type { EventStore } from '../store/event-store.ts';
import type { HumanApprover } from './approver.ts';
import type { CredentialKind, HumanCredentials } from './credentials.ts';
import type { EngineQueries } from './queries.ts';

/**
 * JSON-RPC 2.0 over NDJSON on one authenticated pipe connection ([[명령·이벤트 계약]] §11).
 *
 * The connection is anonymous until `session.hello`, which fixes its transport identity for good: the UI
 * credential makes it a `ui-session`, a CLI human credential is attached as `humanProof` (checked again by the
 * bus on every command), anything else is an unverified (read-only) or MCP client. Every command then goes
 * through the same bus as everything else; a run token in a request narrows the caller to that node's agent.
 */

export interface RpcServices {
  readonly bus: CommandBus;
  readonly store: EventStore;
  readonly queries: EngineQueries;
  readonly credentials: HumanCredentials;
  readonly approver: HumanApprover;
  readonly pairing: PairingGate;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly validator: SchemaValidator;
  readonly engineVersion: string;
  /** Time limit of a CLI human credential. */
  readonly cliCredentialTtlMs: number;
  /** How long the approval dialog waits for the person. */
  readonly pairingTimeoutMs: number;
  status(): Promise<EngineStatus>;
  /** Stops the daemon (after the reply went out). */
  shutdown(): void;
  reportError(error: Error, context: string): void;
}

/** One pairing at a time over the whole engine: a second request while one waits is refused. */
export class PairingGate {
  private busy = false;

  tryEnter(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  leave(): void {
    this.busy = false;
  }
}

/** Longest line (one JSON-RPC message) a client may send. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** Unanswered requests per connection. */
const MAX_IN_FLIGHT = 64;
/** Queued output after which a subscription is dropped (the client resubscribes from its last sequence). */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const EVENT_PAGE = 500;

type Id = string | number | null;

class RpcError extends Error {
  readonly rpcCode: number;
  readonly data: CommandError;

  constructor(error: CommandError, rpcCode: number = COMMAND_ERRORS[error.code].rpcCode) {
    super(error.message);
    this.rpcCode = rpcCode;
    this.data = error;
  }
}

const invalidParams = (message: string, issues?: unknown): RpcError =>
  new RpcError(commandError('validation_failed', message, issues === undefined ? undefined : { issues }), RPC_PROTOCOL_ERRORS.invalidParams);

interface Subscription {
  readonly id: string;
  last: number;
  live: boolean;
  pending: DomainEvent[];
  stop(): void;
}

export class RpcConnection {
  private readonly socket: Duplex;
  private readonly services: RpcServices;
  private readonly maxLineBytes: number;
  private identity: TransportIdentity | undefined;
  private humanCredential: string | undefined;
  private buffer = '';
  private inFlight = 0;
  private closed = false;
  private readonly subscriptions = new Map<string, Subscription>();
  private nextSubscription = 1;

  constructor(socket: Duplex, services: RpcServices, limits: { maxLineBytes?: number } = {}) {
    this.socket = socket;
    this.services = services;
    this.maxLineBytes = limits.maxLineBytes ?? MAX_LINE_BYTES;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    socket.on('close', () => {
      this.close();
    });
    socket.on('error', () => {
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions.values()) subscription.stop();
    this.subscriptions.clear();
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      // A complete line is held to the same limit as an unfinished one, before anything parses it.
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.tooLarge();
        return;
      }
      if (line.trim() !== '') this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) this.tooLarge();
  }

  private tooLarge(): void {
    this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_PROTOCOL_ERRORS.invalidRequest, message: 'message too large' } });
    this.close();
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_PROTOCOL_ERRORS.parseError, message: 'parse error' } });
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_PROTOCOL_ERRORS.invalidRequest, message: 'invalid request' } });
      return;
    }
    const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
    if (jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && !validId)) {
      this.send({ jsonrpc: '2.0', id: validId ? id : null, error: { code: RPC_PROTOCOL_ERRORS.invalidRequest, message: 'invalid request' } });
      return;
    }
    if (id === undefined) return; // Client notifications mean nothing to the engine.
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.reply(id, undefined, new RpcError(commandError('invariant_violated', `more than ${MAX_IN_FLIGHT} requests in flight`)));
      return;
    }
    this.inFlight += 1;
    this.dispatch(method, params, id)
      .then(
        (result) => {
          this.reply(id, result);
        },
        (error: unknown) => {
          if (error instanceof RpcError) {
            this.reply(id, undefined, error);
            return;
          }
          this.services.reportError(error instanceof Error ? error : new Error(String(error)), `rpc ${method}`);
          this.reply(id, undefined, new RpcError(commandError('internal', error instanceof Error ? error.message : String(error))));
        },
      )
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  private reply(id: Id, result: unknown, error?: RpcError): void {
    if (error === undefined) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    else this.send({ jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.message, data: error.data } });
  }

  private send(message: unknown): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private params<S extends TSchema>(schema: S, params: unknown): Static<S> {
    const value = params ?? {};
    const issues = this.services.validator.validate(schema, value);
    if (issues.length > 0) throw invalidParams('invalid params', issues);
    return value;
  }

  private requireSession(): TransportIdentity {
    if (this.identity === undefined) throw new RpcError(commandError('unauthenticated', `send ${RPC_METHODS.hello} first`));
    return this.identity;
  }

  private async dispatch(method: string, params: unknown, id: Id): Promise<unknown> {
    if (method === RPC_METHODS.hello) return this.hello(this.params(HelloParamsSchema, params));
    const identity = this.requireSession();
    const { queries } = this.services;
    switch (method) {
      case RPC_METHODS.execute: {
        const response = await this.services.bus.execute(params, identity);
        if (response.ok) return response;
        throw new RpcError(response.error);
      }
      case RPC_METHODS.subscribe:
        return this.subscribe(this.params(SubscribeParamsSchema, params).afterSequence ?? 0);
      case RPC_METHODS.unsubscribe: {
        const { subscription } = this.params(UnsubscribeParamsSchema, params);
        const found = this.subscriptions.get(subscription);
        found?.stop();
        this.subscriptions.delete(subscription);
        return { removed: found !== undefined };
      }
      case RPC_METHODS.readEvents: {
        const { afterSequence, limit } = this.params(ReadEventsParamsSchema, params);
        return { events: await this.services.store.readEvents({ afterSequence: afterSequence ?? 0, limit: limit ?? EVENT_PAGE }) };
      }
      case RPC_METHODS.status:
        this.params(StatusParamsSchema, params);
        return this.services.status();
      case RPC_METHODS.shutdown:
        this.params(ShutdownParamsSchema, params);
        if (!this.isHuman()) throw new RpcError(commandError('forbidden', 'only the human (app or CLI human credential) may stop the engine'));
        setImmediate(() => {
          this.services.shutdown();
        });
        return { stopping: true };
      case RPC_METHODS.pair:
        return this.pair(this.params(PairParamsSchema, params).kind, id);
      case RPC_METHODS.projects:
        this.params(ProjectsQuerySchema, params);
        return { projects: await queries.projects() };
      case RPC_METHODS.tickets:
        return { tickets: await queries.tickets(this.params(TicketsQuerySchema, params).projectId) };
      case RPC_METHODS.ticket: {
        const detail = await queries.ticket(this.params(TicketQuerySchema, params).ticketId);
        if (detail === undefined) throw new RpcError(commandError('not_found', 'no such ticket'));
        return detail;
      }
      case RPC_METHODS.artifacts: {
        const query = this.params(ArtifactsQuerySchema, params);
        return { artifacts: await queries.artifacts(query.ticketId, query.nodeId) };
      }
      case RPC_METHODS.workspace: {
        const query = this.params(WorkspaceQuerySchema, params);
        return queries.workspace(query.projectId, { ...(query.ticketId === undefined ? {} : { ticketId: query.ticketId }), changes: query.changes ?? 'flagged', limit: query.limit ?? 200 });
      }
      case RPC_METHODS.sharedNodes: {
        const query = this.params(SharedNodesQuerySchema, params);
        return { sharedNodes: await queries.sharedNodes(query.projectId, query.name) };
      }
      case RPC_METHODS.worktreeCleanup: {
        const query = this.params(WorktreeCleanupQuerySchema, params);
        return { worktrees: await queries.worktreeCleanup(query.projectId, query.ticketId) };
      }
      case RPC_METHODS.ticketStats: {
        const stats = await queries.ticketStats(this.params(TicketQuerySchema, params).ticketId);
        if (stats === undefined) throw new RpcError(commandError('not_found', 'no such ticket'));
        return stats;
      }
      default:
        throw new RpcError(commandError('unknown_command', `unknown method '${method}'`), RPC_PROTOCOL_ERRORS.methodNotFound);
    }
  }

  private async hello(params: HelloParams): Promise<HelloResult> {
    if (this.identity !== undefined) throw new RpcError(commandError('invariant_violated', 'the session already started'), RPC_PROTOCOL_ERRORS.invalidRequest);
    if (params.protocol !== PROTOCOL_VERSION) {
      throw new RpcError(commandError('unsupported_schema_version', `protocol ${params.protocol} is not supported (engine speaks ${PROTOCOL_VERSION})`));
    }
    const { credentials } = this.services;
    if (params.uiCredential !== undefined && params.humanCredential !== undefined) throw invalidParams('send one credential, not both');
    let identity: TransportIdentity;
    let label: HelloResult['identity'];
    if (params.uiCredential !== undefined) {
      // A wrong credential is an error, not a quiet fallback to a read-only session.
      if (!credentials.verify('ui', params.uiCredential)) throw new RpcError(commandError('unauthenticated', 'invalid UI credential'));
      identity = { kind: 'ui-session' };
      label = 'ui';
    } else if (params.humanCredential !== undefined) {
      if (!credentials.verify('cli', params.humanCredential)) throw new RpcError(commandError('unauthenticated', 'invalid or expired human credential'));
      this.humanCredential = params.humanCredential;
      identity = { kind: 'engine-token', client: params.client === 'mcp' ? 'mcp' : 'cli', humanProof: params.humanCredential };
      label = 'human-cli';
    } else {
      const client = params.client === 'ui' ? 'unknown' : params.client;
      identity = { kind: 'engine-token', client };
      label = client === 'mcp' ? 'mcp' : 'unverified';
    }
    this.identity = identity;
    return { protocol: PROTOCOL_VERSION, engineVersion: this.services.engineVersion, identity: label, lastSequence: await this.services.store.lastSequence() };
  }

  private isHuman(): boolean {
    if (this.identity?.kind === 'ui-session') return true;
    return this.humanCredential !== undefined && this.services.credentials.verify('cli', this.humanCredential);
  }

  private async pair(kind: CredentialKind, id: Id): Promise<PairResult> {
    const { pairing, approver, credentials, random, pairingTimeoutMs } = this.services;
    if (!pairing.tryEnter()) throw new RpcError(commandError('invariant_violated', 'another request for a human credential is waiting for approval'));
    try {
      const code = String(Buffer.from(random(4)).readUInt32BE(0) % 10_000).padStart(4, '0');
      this.send({ jsonrpc: '2.0', method: RPC_NOTIFICATIONS.pairingCode, params: { request: id, code, expiresInMs: pairingTimeoutMs } });
      const approved = await withDeadline(
        approver.confirm({ kind, code, timeoutMs: pairingTimeoutMs }).catch(() => false),
        pairingTimeoutMs + 5000,
        this.services.clock,
      );
      if (approved !== true) throw new RpcError(commandError('forbidden', 'the request was not approved'));
      const issued = credentials.issue(kind, kind === 'cli' ? this.services.cliCredentialTtlMs : undefined);
      return { kind, credential: issued.secret, ...(issued.expiresAt === undefined ? {} : { expiresAt: issued.expiresAt }) };
    } finally {
      pairing.leave();
    }
  }

  private subscribe(afterSequence: number): Promise<{ subscription: string }> {
    const id = `s${this.nextSubscription++}`;
    const subscription: Subscription = { id, last: afterSequence, live: false, pending: [], stop: () => undefined };
    // Listen first, then catch up from the log: anything committed meanwhile is in `pending`, and sequences
    // dedupe what both paths saw. The client gets every event after `afterSequence` once, in order.
    const unsubscribe = this.services.store.subscribe((events) => {
      if (subscription.live) this.deliver(subscription, events);
      else subscription.pending.push(...events);
    });
    subscription.stop = unsubscribe;
    this.subscriptions.set(id, subscription);
    void (async () => {
      for (;;) {
        if (!this.subscriptions.has(id)) return;
        const page = await this.services.store.readEvents({ afterSequence: subscription.last, limit: EVENT_PAGE });
        if (page.length === 0) break;
        this.deliver(subscription, page);
      }
      subscription.live = true;
      const pending = subscription.pending;
      subscription.pending = [];
      this.deliver(subscription, pending);
    })().catch((error: unknown) => {
      this.services.reportError(error instanceof Error ? error : new Error(String(error)), 'event subscription catch-up');
      this.drop(subscription);
    });
    return Promise.resolve({ subscription: id });
  }

  private deliver(subscription: Subscription, events: readonly DomainEvent[]): void {
    if (!this.subscriptions.has(subscription.id)) return;
    const fresh = events.filter((event) => event.sequence > subscription.last);
    if (fresh.length === 0) return;
    for (let start = 0; start < fresh.length; start += EVENT_PAGE) {
      const batch = fresh.slice(start, start + EVENT_PAGE);
      this.send({ jsonrpc: '2.0', method: RPC_NOTIFICATIONS.events, params: { subscription: subscription.id, events: batch } });
      subscription.last = batch.at(-1)?.sequence ?? subscription.last;
      if (this.socket.writableLength > MAX_BUFFERED_BYTES) {
        this.drop(subscription);
        return;
      }
    }
  }

  private drop(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription.id)) return;
    subscription.stop();
    this.send({ jsonrpc: '2.0', method: RPC_NOTIFICATIONS.overflow, params: { subscription: subscription.id, lastSequence: subscription.last } });
  }
}

/** Resolves with the promise, or undefined once `ms` passed on the clock. */
function withDeadline<T>(promise: Promise<T>, ms: number, clock: Clock): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      resolve(undefined);
    }, ms);
    void promise.then((value) => {
      clock.clearTimeout(timer);
      resolve(value);
    });
  });
}
