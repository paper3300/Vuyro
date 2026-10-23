import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DomainEvent, isUuidV7, type Principal, UnsupportedSchemaVersionError } from '@vuyro/contracts';
import { SqliteWorker } from '../src/db/sqlite-worker-client.ts';
import { VirtualClock } from '../src/runtime/clock.ts';
import { createUuidV7Generator, seededRandom } from '../src/runtime/ids.ts';
import { EventStore, type EventStoreOptions, RevisionConflictError, type StreamAppend } from '../src/store/event-store.ts';
import { BUILTIN_PROJECTORS, type Projector } from '../src/store/projections.ts';
import { tempDir } from './helpers/engine-harness.ts';

const ACTOR: Principal = { kind: 'system', component: 'test' };
const PROJECT = '0192f3a0-0000-7000-8000-00000000000a';

function ticketId(n: number): string {
  return `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function created(id: string, expectedRevision = 0): StreamAppend {
  return {
    aggregateType: 'ticket',
    aggregateId: id,
    expectedRevision,
    events: [{ type: 'ticket.created', data: { ticketId: id, projectId: PROJECT, title: `ticket ${id.slice(-4)}` } }],
  };
}

function renamed(id: string, expectedRevision: number, title: string): StreamAppend {
  return { aggregateType: 'ticket', aggregateId: id, expectedRevision, events: [{ type: 'ticket.updated', data: { ticketId: id, title } }] };
}

async function dumpProjections(store: EventStore): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of BUILTIN_PROJECTORS.flatMap((projector) => projector.tables)) {
    out[table] = await store.query(`SELECT * FROM ${table} ORDER BY 1`);
  }
  return out;
}

describe('EventStore', () => {
  let temp: ReturnType<typeof tempDir>;
  let path: string;
  let clock: VirtualClock;
  const opened: EventStore[] = [];

  async function open(options: Partial<EventStoreOptions> = {}): Promise<EventStore> {
    const store = await EventStore.open({
      path,
      clock,
      ids: createUuidV7Generator({ clock, random: seededRandom(opened.length + 1) }),
      ...options,
    });
    opened.push(store);
    return store;
  }

  async function raw(): Promise<SqliteWorker> {
    return SqliteWorker.open({ path });
  }

  beforeEach(() => {
    temp = tempDir('vuyro-store-');
    path = join(temp.dir, 'engine.db');
    clock = new VirtualClock(Date.UTC(2026, 9, 24, 9));
  });

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
    temp.dispose();
  });

  it('assigns gapless sequences and revisions and updates projections in the same commit', async () => {
    const store = await open();
    const id = ticketId(1);
    const first = await store.append({ streams: [created(id)], actor: ACTOR });
    await clock.advance(1000);
    const second = await store.append({ streams: [renamed(id, 1, 'Renamed')], actor: ACTOR, requestId: 'req-test-0001' });

    const [a] = first.events;
    const [b] = second.events;
    expect(a).toMatchObject({ sequence: 1, revision: 1, aggregateType: 'ticket', timestamp: clock.now() - 1000, actor: ACTOR });
    expect(b).toMatchObject({ sequence: 2, revision: 2, requestId: 'req-test-0001', timestamp: clock.now() });
    expect(isUuidV7(a?.eventId)).toBe(true);
    expect(a?.replicaId).toBe(store.replicaId);
    expect(await store.query('SELECT title, revision, updated_at FROM p_tickets')).toEqual([
      { title: 'Renamed', revision: 2, updated_at: clock.now() },
    ]);
    expect((await store.readAggregate(id)).map((event) => event.type)).toEqual(['ticket.created', 'ticket.updated']);
  });

  it('rejects a stale expected revision and writes nothing', async () => {
    const store = await open();
    const id = ticketId(1);
    await store.append({ streams: [created(id)], actor: ACTOR });
    await store.append({ streams: [renamed(id, 1, 'first')], actor: ACTOR });
    await expect(store.append({ streams: [renamed(id, 1, 'stale')], actor: ACTOR })).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(store.append({ streams: [created(id)], actor: ACTOR })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await store.lastSequence()).toBe(2);
    expect(await store.query('SELECT title FROM p_tickets')).toEqual([{ title: 'first' }]);
    // The store keeps working after a failed transaction.
    await store.append({ streams: [renamed(id, 2, 'second')], actor: ACTOR });
    expect(await store.lastSequence()).toBe(3);
  });

  it('groups concurrent commits and isolates the one that fails', async () => {
    const store = await open();
    const appends = Array.from({ length: 40 }, (_, n) => store.append({ streams: [created(ticketId(n + 1))], actor: ACTOR }));
    // Same aggregate created twice in the same burst: exactly one must win.
    appends.push(store.append({ streams: [created(ticketId(7))], actor: ACTOR }));
    const results = await Promise.allSettled(appends);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(40);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    const sequences = (await store.readEvents({ limit: 100 })).map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: 40 }, (_, n) => n + 1));
  });

  it('commits a burst of appends in fewer transactions than commits', async () => {
    const store = await open();
    await Promise.all(Array.from({ length: 40 }, (_, n) => store.append({ streams: [created(ticketId(n + 1))], actor: ACTOR })));
    expect(store.stats.commits).toBe(40);
    expect(store.stats.transactions).toBeLessThan(40);
    expect(await store.lastSequence()).toBe(40);
  });

  it('validates event data before writing', async () => {
    const store = await open();
    const bad = { aggregateType: 'ticket', aggregateId: ticketId(1), expectedRevision: 0, events: [{ type: 'ticket.created', data: { ticketId: 'x' } }] };
    await expect(store.append({ streams: [bad as StreamAppend], actor: ACTOR })).rejects.toThrow(/invalid 'ticket.created'/);
    const wrongAggregate = { ...created(ticketId(1)), aggregateType: 'run' };
    await expect(store.append({ streams: [wrongAggregate], actor: ACTOR })).rejects.toThrow(/belongs to aggregate type 'ticket'/);
    expect(await store.lastSequence()).toBe(0);
  });

  it('enforces append-only and gapless numbering in the database itself', async () => {
    const store = await open();
    await store.append({ streams: [created(ticketId(1))], actor: ACTOR });
    const db = await raw();
    try {
      await expect(db.run("UPDATE events SET data = '{}'")).rejects.toThrow(/append_only/);
      await expect(db.run('DELETE FROM events')).rejects.toThrow(/append_only/);
      const insert = `INSERT INTO events (sequence, event_id, type, schema_version, aggregate_type, aggregate_id, revision,
        timestamp, replica_id, actor, data) VALUES (?, ?, 'ticket.updated', 1, 'ticket', ?, ?, 0, 'r', '{}', '{}')`;
      await expect(db.run(insert, [2, 'e2', ticketId(1), 3])).rejects.toThrow(/revision_conflict/);
      await expect(db.run(insert, [5, 'e5', ticketId(1), 2])).rejects.toThrow(/sequence_conflict/);
    } finally {
      await db.close();
    }
  });

  it('notifies subscribers after commit', async () => {
    const store = await open();
    const seen: DomainEvent[] = [];
    const unsubscribe = store.subscribe((events) => seen.push(...events));
    await store.append({ streams: [created(ticketId(1)), created(ticketId(2))], actor: ACTOR });
    unsubscribe();
    await store.append({ streams: [created(ticketId(3))], actor: ACTOR });
    expect(seen.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('keeps the replica id across reopen and refuses a newer database schema', async () => {
    const store = await open();
    const { replicaId } = store;
    await store.close();
    opened.pop();
    expect((await open()).replicaId).toBe(replicaId);
    await opened.pop()?.close();
    const db = await raw();
    await db.exec('PRAGMA user_version = 99');
    await db.close();
    await expect(open()).rejects.toThrow(/newer than this engine/);
  });

  it('fails closed when reading an event newer than this engine', async () => {
    const store = await open();
    const db = await raw();
    await db.run(
      `INSERT INTO events (sequence, event_id, type, schema_version, aggregate_type, aggregate_id, revision,
        timestamp, replica_id, actor, data) VALUES (1, 'e1', 'ticket.created', 2, 'ticket', ?, 1, 0, 'r', '{}', '{}')`,
      [ticketId(1)],
    );
    await db.close();
    await expect(store.readAggregate(ticketId(1))).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);
  });

  describe('projections', () => {
    async function seed(store: EventStore): Promise<void> {
      for (let n = 1; n <= 30; n++) await store.append({ streams: [created(ticketId(n))], actor: ACTOR });
      for (let n = 1; n <= 30; n += 3) await store.append({ streams: [renamed(ticketId(n), 1, `renamed ${n}`)], actor: ACTOR });
    }

    it('rebuilds to exactly the incrementally maintained tables', async () => {
      const store = await open({ rebuildBatch: 7 });
      await seed(store);
      const before = await dumpProjections(store);
      await store.rebuildProjections();
      expect(await dumpProjections(store)).toEqual(before);
    });

    it('rebuilds on open after an interrupted rebuild or a lagging checkpoint', async () => {
      let store = await open();
      await seed(store);
      const before = await dumpProjections(store);
      await store.close();
      opened.pop();

      const db = await raw();
      await db.run("UPDATE meta SET value = 'rebuilding' WHERE key = 'projection_state'");
      await db.run('DELETE FROM p_tickets');
      await db.close();
      store = await open();
      expect(await dumpProjections(store)).toEqual(before);
      await store.close();
      opened.pop();

      const db2 = await raw();
      await db2.run("UPDATE meta SET value = '3' WHERE key = 'projection_sequence'");
      await db2.run("UPDATE p_tickets SET title = 'corrupted'");
      await db2.close();
      store = await open();
      expect(await dumpProjections(store)).toEqual(before);
    });

    it('builds a new projection from history when the projector set changes', async () => {
      const store = await open();
      await seed(store);
      await store.close();
      opened.pop();
      const counter: Projector = {
        name: 'type-counts',
        version: 1,
        tables: ['p_type_counts'],
        ddl: ['CREATE TABLE p_type_counts (type TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT'],
        apply: (event) => [
          { sql: 'INSERT INTO p_type_counts (type, n) VALUES (?, 1) ON CONFLICT (type) DO UPDATE SET n = n + 1', params: [event.type] },
        ],
      };
      const reopened = await open({ projectors: [...BUILTIN_PROJECTORS, counter] });
      expect(await reopened.query('SELECT type, n FROM p_type_counts ORDER BY type')).toEqual([
        { type: 'ticket.created', n: 30 },
        { type: 'ticket.updated', n: 10 },
      ]);
    });
  });
});
