import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteWorker, SqliteWorkerError } from '../src/db/sqlite-worker-client.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (aggregate_id, revision)
  )`;

const INSERT = 'INSERT INTO events (aggregate_id, revision, type, payload) VALUES (?, ?, ?, ?)';

function insert(aggregate: string, revision: number) {
  return { sql: INSERT, params: [aggregate, revision, 'node.updated', JSON.stringify({ revision })] };
}

async function count(db: SqliteWorker): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT count(*) AS n FROM events');
  return row?.n ?? -1;
}

describe('SqliteWorker (node:sqlite in a worker thread)', () => {
  let dir: string;
  let path: string;
  const open: SqliteWorker[] = [];

  async function openWorker(readOnly = false): Promise<SqliteWorker> {
    const db = await SqliteWorker.open({ path, readOnly });
    open.push(db);
    return db;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vuyro-sqlite-'));
    path = join(dir, 'engine.db');
  });

  afterEach(async () => {
    for (const db of open.splice(0)) await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the writer in WAL mode', async () => {
    const writer = await openWorker();
    expect(writer.journalMode).toBe('wal');
    await writer.exec(SCHEMA);
    await writer.run(INSERT, ['t1', 1, 'created', '{}']);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(await writer.get('PRAGMA synchronous')).toEqual({ synchronous: 2 }); // FULL
  });

  it('commits a transaction atomically and rolls back on error', async () => {
    const writer = await openWorker();
    await writer.exec(SCHEMA);
    const results = await writer.transaction([insert('t1', 1), insert('t1', 2)]);
    expect(results.map((r) => r.lastInsertRowid)).toEqual([1, 2]);

    const duplicate = writer.transaction([insert('t1', 3), insert('t1', 2)]);
    await expect(duplicate).rejects.toBeInstanceOf(SqliteWorkerError);
    await expect(duplicate).rejects.toMatchObject({ errcode: 2067 }); // SQLITE_CONSTRAINT_UNIQUE
    expect(await count(writer)).toBe(2);
  });

  it('serves reads from another worker while a write transaction is open', async () => {
    const writer = await openWorker();
    await writer.exec(SCHEMA);
    await writer.transaction([insert('t1', 1)]);
    const reader = await openWorker(true);

    await writer.exec('BEGIN IMMEDIATE');
    const pending = insert('t1', 2);
    await writer.run(pending.sql, pending.params);

    const started = performance.now();
    expect(await count(reader)).toBe(1); // last committed snapshot, no lock wait
    expect(performance.now() - started).toBeLessThan(500);

    await writer.exec('COMMIT');
    expect(await count(reader)).toBe(2);
  });

  it('keeps readers consistent during continuous appends', async () => {
    const writer = await openWorker();
    await writer.exec(SCHEMA);
    const readers = [await openWorker(true), await openWorker(true)];

    let writing = true;
    const observed: number[][] = readers.map(() => []);
    const readLoops = readers.map(async (reader, i) => {
      while (writing) {
        const n = await count(reader);
        observed[i]?.push(n);
        const tail = await reader.all<{ revision: number }>(
          'SELECT revision FROM events WHERE aggregate_id = ? ORDER BY revision DESC LIMIT 20',
          ['t1'],
        );
        // A snapshot never shows a gap: revisions are contiguous.
        tail.forEach((row, k) => {
          expect(row.revision).toBe((tail[0]?.revision ?? 0) - k);
        });
      }
    });

    const batches = 50;
    const perBatch = 100;
    for (let b = 0; b < batches; b++) {
      await writer.transaction(Array.from({ length: perBatch }, (_, k) => insert('t1', b * perBatch + k + 1)));
    }
    writing = false;
    await Promise.all(readLoops);

    expect(await count(writer)).toBe(batches * perBatch);
    for (const series of observed) {
      expect(series.length).toBeGreaterThan(0);
      // Each committed batch is all-or-nothing and counts never go backwards.
      for (let k = 1; k < series.length; k++) expect(series[k]).toBeGreaterThanOrEqual(series[k - 1] ?? 0);
      for (const n of series) expect(n % perBatch).toBe(0);
    }
  }, 30_000);

  it('rejects writes on a read-only connection', async () => {
    const writer = await openWorker();
    await writer.exec(SCHEMA);
    const reader = await openWorker(true);
    await expect(reader.run(INSERT, ['t1', 1, 'x', '{}'])).rejects.toMatchObject({ errcode: 8 }); // SQLITE_READONLY
  });

  it('does not block the caller thread during a long query', async () => {
    const writer = await openWorker();
    await writer.exec(SCHEMA);
    // Longest gap between setImmediate turns (timers only have ~15.6 ms resolution on Windows).
    let maxGap = 0;
    let last = performance.now();
    let running = true;
    const tick = (): void => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const started = performance.now();
    await writer.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000)
      INSERT INTO events (aggregate_id, revision, type, payload)
      SELECT 'bulk', i, 'node.updated', printf('{"i":%d}', i) FROM n`);
    const elapsed = performance.now() - started;
    running = false;

    expect(elapsed).toBeGreaterThan(100); // the worker was actually busy
    expect(maxGap).toBeLessThan(elapsed / 2); // ...but this thread never stalled for that long
  }, 30_000);
});
