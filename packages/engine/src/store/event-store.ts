import {
  type Authorization,
  type CommandSuccess,
  type DomainEvent,
  EVENT_CATALOG,
  type EventData,
  type EventType,
  isEventType,
  type Principal,
  SchemaValidator,
  upcastEventData,
} from '@vuyro/contracts';
import { SqliteWorker, SqliteWorkerError } from '../db/sqlite-worker-client.ts';
import type { SqliteStatement, SynchronousMode } from '../db/sqlite-worker-protocol.ts';
import type { Clock } from '../runtime/clock.ts';
import type { IdGenerator } from '../runtime/ids.ts';
import { BUILTIN_PROJECTORS, type Projector, projectionVersion } from './projections.ts';
import { CORE_SCHEMA_VERSION, MIGRATIONS } from './schema.ts';

export type NewEventOf<T extends EventType> = { readonly type: T; readonly data: EventData<T> };
export type NewEvent = { [T in EventType]: NewEventOf<T> }[EventType];

/** Events for one aggregate. `expectedRevision` is the aggregate's revision before them (0 = new). */
export interface StreamAppend {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedRevision: number;
  readonly events: readonly NewEvent[];
}

/** Idempotency record stored with the command's events. */
export interface CommandRecord {
  readonly requestId: string;
  readonly type: string;
  readonly principalKey: string;
  readonly fingerprint: string;
  /** Builds the stored response once the events have their sequences. */
  readonly response: (events: readonly DomainEvent[]) => CommandSuccess;
}

export interface Commit {
  readonly streams: readonly StreamAppend[];
  readonly actor: Principal;
  readonly authorization?: Authorization;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly command?: CommandRecord;
}

export interface CommitResult {
  readonly events: readonly DomainEvent[];
  readonly response?: CommandSuccess;
}

export interface StoredCommand {
  readonly type: string;
  readonly principalKey: string;
  readonly fingerprint: string;
  readonly response: CommandSuccess;
}

export class RevisionConflictError extends Error {
  readonly aggregateIds: readonly string[];

  constructor(aggregateIds: readonly string[]) {
    super(`revision conflict on ${aggregateIds.join(', ')}`);
    this.name = 'RevisionConflictError';
    this.aggregateIds = aggregateIds;
  }
}

export class DuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`request id already recorded: ${requestId}`);
    this.name = 'DuplicateRequestError';
  }
}

export interface EventStoreOptions {
  readonly path: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Default 'full' (see 초기 검증 결과 #5). */
  readonly synchronous?: SynchronousMode;
  readonly projectors?: readonly Projector[];
  readonly validator?: SchemaValidator;
  /** Most commits grouped into one transaction. Default 64. */
  readonly maxBatch?: number;
  /** Events per transaction while rebuilding projections. Default 500. */
  readonly rebuildBatch?: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  revision: number;
  timestamp: number;
  replica_id: string;
  actor: string;
  authz: string | null;
  request_id: string | null;
  correlation_id: string | null;
  data: string;
}

interface Pending {
  readonly commit: Commit;
  resolve(result: CommitResult): void;
  reject(error: Error): void;
}

const INSERT_EVENT = `INSERT INTO events
  (sequence, event_id, type, schema_version, aggregate_type, aggregate_id, revision, timestamp,
   replica_id, actor, authz, request_id, correlation_id, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
const INSERT_COMMAND = `INSERT INTO commands (request_id, type, principal_key, fingerprint, response, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)`;

const META = {
  replicaId: 'replica_id',
  projectionVersion: 'projection_version',
  projectionState: 'projection_state',
  projectionSequence: 'projection_sequence',
} as const;

/**
 * Append-only event log with projections, on one writer worker and one read-only worker.
 *
 * - Every append runs in one transaction: events, projection updates, the projection checkpoint
 *   and the idempotency record commit together or not at all.
 * - Appends are queued and grouped: commits that arrive while a transaction is in flight share
 *   the next one (group commit). If a grouped transaction fails, its commits are retried one by one
 *   so only the offending commit fails.
 * - Revisions and sequences are checked by triggers, so a stale writer can never commit.
 */
export class EventStore {
  readonly replicaId: string;
  /** Successful append transactions and the commits they carried (group-commit ratio). */
  readonly stats = { transactions: 0, commits: 0 };
  private readonly writer: SqliteWorker;
  private readonly reader: SqliteWorker;
  private readonly options: EventStoreOptions;
  private readonly projectors: readonly Projector[];
  private readonly validator: SchemaValidator;
  private readonly listeners = new Set<(events: readonly DomainEvent[]) => void>();
  private readonly queue: Pending[] = [];
  private lock: Promise<void> = Promise.resolve();
  private nextSequence = 1;
  private closed = false;

  private constructor(
    writer: SqliteWorker,
    reader: SqliteWorker,
    replicaId: string,
    options: EventStoreOptions,
  ) {
    this.writer = writer;
    this.reader = reader;
    this.replicaId = replicaId;
    this.options = options;
    this.projectors = options.projectors ?? BUILTIN_PROJECTORS;
    this.validator = options.validator ?? new SchemaValidator();
  }

  static async open(options: EventStoreOptions): Promise<EventStore> {
    const writer = await SqliteWorker.open({ path: options.path, synchronous: options.synchronous ?? 'full' });
    let reader: SqliteWorker | undefined;
    try {
      await migrate(writer);
      const replicaId = await ensureReplicaId(writer, options.ids);
      reader = await SqliteWorker.open({ path: options.path, readOnly: true });
      const store = new EventStore(writer, reader, replicaId, options);
      await store.syncSequence();
      await store.ensureProjections();
      return store;
    } catch (error) {
      await reader?.close();
      await writer.close();
      throw error;
    }
  }

  /** Queues a commit. Resolves once it is durable (or rejects with the reason it was not). */
  append(commit: Commit): Promise<CommitResult> {
    if (this.closed) return Promise.reject(new Error('event store is closed'));
    try {
      for (const stream of commit.streams) this.checkStream(stream);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ commit, resolve, reject });
      this.withLock(() => this.drain());
    });
  }

  /** Called after each successful commit with the new events, in sequence order. */
  subscribe(listener: (events: readonly DomainEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readAggregate(aggregateId: string, afterRevision = 0): Promise<DomainEvent[]> {
    const rows = await this.reader.all<EventRow>(
      'SELECT * FROM events WHERE aggregate_id = ? AND revision > ? ORDER BY revision',
      [aggregateId, afterRevision],
    );
    return rows.map(toEvent);
  }

  async readEvents(options: { afterSequence?: number; limit?: number } = {}): Promise<DomainEvent[]> {
    const rows = await this.reader.all<EventRow>('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?', [
      options.afterSequence ?? 0,
      options.limit ?? 500,
    ]);
    return rows.map(toEvent);
  }

  async lastSequence(): Promise<number> {
    const row = await this.reader.get<{ last: number | null }>('SELECT MAX(sequence) AS last FROM events');
    return row?.last ?? 0;
  }

  async getCommand(requestId: string): Promise<StoredCommand | undefined> {
    const row = await this.reader.get<{ type: string; principal_key: string; fingerprint: string; response: string }>(
      'SELECT type, principal_key, fingerprint, response FROM commands WHERE request_id = ?',
      [requestId],
    );
    if (row === undefined) return undefined;
    return {
      type: row.type,
      principalKey: row.principal_key,
      fingerprint: row.fingerprint,
      response: JSON.parse(row.response) as CommandSuccess,
    };
  }

  /** Read-model query on the read-only worker (projection tables and the log). */
  query<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> {
    return this.reader.all<T>(sql, params);
  }

  async queryOne<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T | undefined> {
    return this.reader.get<T>(sql, params);
  }

  /**
   * Drops every projection table and replays the log into it. Appends wait meanwhile.
   * Crash-safe: the state flag stays 'rebuilding' until the end, so the next open rebuilds again.
   */
  rebuildProjections(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.withLock(() => this.rebuild().then(resolve, reject));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.lock;
    await this.reader.close();
    await this.writer.close();
  }

  // -------------------------------------------------------------------------

  private withLock(task: () => Promise<void>): void {
    this.lock = this.lock.then(task).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxBatch ?? 64);
      await this.commitBatch(batch);
    }
  }

  private async commitBatch(batch: Pending[]): Promise<void> {
    let built: { statements: SqliteStatement[]; results: CommitResult[] };
    try {
      built = this.build(batch.map((pending) => pending.commit));
    } catch (error) {
      if (batch.length === 1) {
        batch[0]?.reject(error as Error);
        return;
      }
      for (const pending of batch) await this.commitBatch([pending]);
      return;
    }
    try {
      await this.writer.transaction(built.statements);
    } catch (error) {
      await this.syncSequence();
      if (batch.length > 1) {
        for (const pending of batch) await this.commitBatch([pending]);
        return;
      }
      const [pending] = batch;
      pending?.reject(translate(error, pending.commit));
      return;
    }
    this.stats.transactions += 1;
    this.stats.commits += batch.length;
    const events: DomainEvent[] = [];
    batch.forEach((pending, index) => {
      const result = built.results[index];
      if (result === undefined) return;
      events.push(...result.events);
      pending.resolve(result);
    });
    this.nextSequence += events.length;
    if (events.length > 0) this.notify(events);
  }

  private build(commits: readonly Commit[]): { statements: SqliteStatement[]; results: CommitResult[] } {
    const statements: SqliteStatement[] = [];
    const results: CommitResult[] = [];
    const timestamp = this.options.clock.now();
    let sequence = this.nextSequence - 1;
    for (const commit of commits) {
      const events: DomainEvent[] = [];
      for (const stream of commit.streams) {
        let revision = stream.expectedRevision;
        for (const newEvent of stream.events) {
          sequence += 1;
          revision += 1;
          const event = this.createEvent(commit, stream, newEvent, sequence, revision, timestamp);
          events.push(event);
          statements.push({ sql: INSERT_EVENT, params: eventParams(event) });
          for (const projector of this.projectors) statements.push(...projector.apply(event));
        }
      }
      let response: CommandSuccess | undefined;
      if (commit.command !== undefined) {
        response = commit.command.response(events);
        statements.push({
          sql: INSERT_COMMAND,
          params: [
            commit.command.requestId,
            commit.command.type,
            commit.command.principalKey,
            commit.command.fingerprint,
            JSON.stringify(response),
            timestamp,
          ],
        });
      }
      results.push(response === undefined ? { events } : { events, response });
    }
    if (sequence >= this.nextSequence) {
      statements.push({ sql: SET_META, params: [META.projectionSequence, String(sequence)] });
    }
    return { statements, results };
  }

  private createEvent(
    commit: Commit,
    stream: StreamAppend,
    newEvent: NewEvent,
    sequence: number,
    revision: number,
    timestamp: number,
  ): DomainEvent {
    // Round-trip so the stored JSON and the returned object are identical (no undefined fields).
    const data = JSON.parse(JSON.stringify(newEvent.data)) as unknown;
    const issues = this.validator.validate(EVENT_CATALOG[newEvent.type].schema, data);
    if (issues.length > 0) {
      throw new Error(`invalid '${newEvent.type}' event data: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    }
    const event = {
      eventId: this.options.ids.next(),
      sequence,
      type: newEvent.type,
      schemaVersion: EVENT_CATALOG[newEvent.type].version,
      aggregateType: stream.aggregateType,
      aggregateId: stream.aggregateId,
      revision,
      timestamp,
      replicaId: this.replicaId,
      actor: commit.actor,
      ...(commit.authorization === undefined ? {} : { authorization: commit.authorization }),
      ...(commit.requestId === undefined ? {} : { requestId: commit.requestId }),
      ...(commit.correlationId === undefined ? {} : { correlationId: commit.correlationId }),
      data,
    };
    return event as DomainEvent;
  }

  private checkStream(stream: StreamAppend): void {
    if (!Number.isInteger(stream.expectedRevision) || stream.expectedRevision < 0) {
      throw new Error(`invalid expectedRevision ${stream.expectedRevision}`);
    }
    for (const event of stream.events) {
      if (!isEventType(event.type)) throw new Error(`unknown event type '${String(event.type)}'`);
      const expected = EVENT_CATALOG[event.type].aggregateType;
      if (expected !== stream.aggregateType) {
        throw new Error(`'${event.type}' belongs to aggregate type '${expected}', not '${stream.aggregateType}'`);
      }
    }
  }

  private notify(events: readonly DomainEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(events);
      } catch {
        // A failing subscriber must not affect the writer.
      }
    }
  }

  private async syncSequence(): Promise<void> {
    const row = await this.writer.get<{ last: number | null }>('SELECT MAX(sequence) AS last FROM events');
    this.nextSequence = (row?.last ?? 0) + 1;
  }

  private async ensureProjections(): Promise<void> {
    const meta = await this.readMeta();
    const last = this.nextSequence - 1;
    const upToDate =
      meta.get(META.projectionState) === 'ready' &&
      meta.get(META.projectionVersion) === projectionVersion(this.projectors) &&
      meta.get(META.projectionSequence) === String(last);
    if (!upToDate) await this.rebuild();
  }

  private async readMeta(): Promise<Map<string, string>> {
    const rows = await this.writer.all<{ key: string; value: string }>('SELECT key, value FROM meta');
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  private async rebuild(): Promise<void> {
    await this.writer.run(SET_META, [META.projectionState, 'rebuilding']);
    await this.writer.transaction([
      ...this.projectors.flatMap((projector) => projector.tables.map((table) => ({ sql: `DROP TABLE IF EXISTS ${table}` }))),
      ...this.projectors.flatMap((projector) => projector.ddl.map((sql) => ({ sql }))),
    ]);
    const batchSize = this.options.rebuildBatch ?? 500;
    let after = 0;
    for (;;) {
      const rows = await this.writer.all<EventRow>('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?', [
        after,
        batchSize,
      ]);
      const last = rows.at(-1);
      if (last === undefined) break;
      const statements = rows.flatMap((row) => {
        const event = toEvent(row);
        return this.projectors.flatMap((projector) => projector.apply(event));
      });
      statements.push({ sql: SET_META, params: [META.projectionSequence, String(last.sequence)] });
      await this.writer.transaction(statements);
      after = last.sequence;
    }
    await this.writer.transaction([
      { sql: SET_META, params: [META.projectionSequence, String(after)] },
      { sql: SET_META, params: [META.projectionVersion, projectionVersion(this.projectors)] },
      { sql: SET_META, params: [META.projectionState, 'ready'] },
    ]);
  }
}

async function migrate(writer: SqliteWorker): Promise<void> {
  const row = await writer.get<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current > CORE_SCHEMA_VERSION) {
    throw new Error(`database schema v${current} is newer than this engine (v${CORE_SCHEMA_VERSION})`);
  }
  for (let version = current; version < CORE_SCHEMA_VERSION; version++) {
    const steps = MIGRATIONS[version] ?? [];
    await writer.transaction([...steps.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${version + 1}` }]);
  }
}

async function ensureReplicaId(writer: SqliteWorker, ids: IdGenerator): Promise<string> {
  const row = await writer.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [META.replicaId]);
  if (row !== undefined) return row.value;
  const replicaId = ids.next();
  await writer.run('INSERT INTO meta (key, value) VALUES (?, ?)', [META.replicaId, replicaId]);
  return replicaId;
}

function eventParams(event: DomainEvent): (string | number | null)[] {
  return [
    event.sequence,
    event.eventId,
    event.type,
    event.schemaVersion,
    event.aggregateType,
    event.aggregateId,
    event.revision,
    event.timestamp,
    event.replicaId,
    JSON.stringify(event.actor),
    event.authorization === undefined ? null : JSON.stringify(event.authorization),
    event.requestId ?? null,
    event.correlationId ?? null,
    JSON.stringify(event.data),
  ];
}

function toEvent(row: EventRow): DomainEvent {
  const { schemaVersion, data } = upcastEventData(row.type, row.schema_version, JSON.parse(row.data));
  const event = {
    eventId: row.event_id,
    sequence: row.sequence,
    type: row.type,
    schemaVersion,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    revision: row.revision,
    timestamp: row.timestamp,
    replicaId: row.replica_id,
    actor: JSON.parse(row.actor) as Principal,
    ...(row.authz === null ? {} : { authorization: JSON.parse(row.authz) as Authorization }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    data,
  };
  return event as DomainEvent;
}

function translate(error: unknown, commit: Commit): Error {
  if (error instanceof SqliteWorkerError) {
    if (error.message.includes('vuyro:revision_conflict')) {
      return new RevisionConflictError(commit.streams.map((stream) => stream.aggregateId));
    }
    if (commit.command !== undefined && error.message.includes('commands.request_id')) {
      return new DuplicateRequestError(commit.command.requestId);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
