/**
 * Spike for 기술 스택 결정 §13 #5: node:sqlite WAL in a worker, concurrent reads.
 * Run: node packages/engine/spikes/sqlite-wal-bench.ts
 * Prints Markdown tables; results are recorded in Docs/Design/초기 검증 결과.md.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorker } from '../src/db/sqlite-worker-client.ts';
import type { SqliteStatement, SynchronousMode } from '../src/db/sqlite-worker-protocol.ts';

const SCHEMA = `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (aggregate_id, revision)
  );
  CREATE INDEX events_type ON events (type, seq);`;

const INSERT =
  'INSERT INTO events (aggregate_id, revision, type, actor, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)';
const AGGREGATES = 200;
const PAYLOAD = JSON.stringify({ note: 'x'.repeat(220), tokens: { input: 1200, cached: 800, output: 300 } });

const revisions = new Map<string, number>();
function nextEvent(i: number): SqliteStatement {
  const aggregate = `ticket-${i % AGGREGATES}`;
  const revision = (revisions.get(aggregate) ?? 0) + 1;
  revisions.set(aggregate, revision);
  return { sql: INSERT, params: [aggregate, revision, 'node.updated', 'agent:claude', PAYLOAD, Date.now()] };
}

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? NaN };
}

const ms = (value: number) => value.toFixed(2);

async function withDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vuyro-bench-'));
  try {
    return await fn(join(dir, 'engine.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function writeThroughput(synchronous: SynchronousMode, batch: number, total: number): Promise<number> {
  return withDb(async (path) => {
    revisions.clear();
    const writer = await SqliteWorker.open({ path, synchronous });
    await writer.exec(SCHEMA);
    const started = performance.now();
    for (let i = 0; i < total; i += batch) {
      await writer.transaction(Array.from({ length: batch }, (_, k) => nextEvent(i + k)));
    }
    const seconds = (performance.now() - started) / 1000;
    await writer.close();
    return total / seconds;
  });
}

const READS: Array<[string, (db: SqliteWorker, i: number) => Promise<unknown>]> = [
  ['count', (db) => db.get('SELECT count(*) AS n FROM events')],
  [
    'aggregate tail',
    (db, i) =>
      db.all('SELECT * FROM events WHERE aggregate_id = ? ORDER BY revision DESC LIMIT 20', [`ticket-${i % AGGREGATES}`]),
  ],
  ['since seq', (db) => db.all('SELECT * FROM events WHERE seq > (SELECT max(seq) - 100 FROM events)')],
];

async function readLatency(mode: 'idle' | 'separate reader' | 'same worker'): Promise<Map<string, Stats>> {
  return withDb(async (path) => {
    revisions.clear();
    const writer = await SqliteWorker.open({ path, synchronous: 'full' });
    await writer.exec(SCHEMA);
    for (let i = 0; i < 50_000; i += 500) {
      await writer.transaction(Array.from({ length: 500 }, (_, k) => nextEvent(i + k)));
    }
    const reader = mode === 'same worker' ? writer : await SqliteWorker.open({ path, readOnly: true });

    let writing = mode !== 'idle';
    const writeLoop = (async () => {
      let i = 50_000;
      while (writing) {
        // A node run appends a handful of events per transaction.
        await writer.transaction(Array.from({ length: 10 }, (_, k) => nextEvent(i + k)));
        i += 10;
      }
    })();

    const samples = new Map<string, number[]>(READS.map(([name]) => [name, []]));
    for (let i = 0; i < 400; i++) {
      for (const [name, read] of READS) {
        const started = performance.now();
        await read(reader, i);
        samples.get(name)?.push(performance.now() - started);
      }
    }
    writing = false;
    await writeLoop;
    if (reader !== writer) await reader.close();
    await writer.close();
    return new Map([...samples].map(([name, values]) => [name, stats(values)]));
  });
}

async function checkpointWithLongReader(): Promise<{ walWhileHeldMb: number; walAfterMb: number; checkpoint: unknown }> {
  return withDb(async (path) => {
    revisions.clear();
    const writer = await SqliteWorker.open({ path });
    await writer.exec(SCHEMA);
    const reader = await SqliteWorker.open({ path, readOnly: true });
    await reader.exec('BEGIN');
    await reader.get('SELECT count(*) FROM events'); // pins a snapshot
    for (let i = 0; i < 20_000; i += 500) {
      await writer.transaction(Array.from({ length: 500 }, (_, k) => nextEvent(i + k)));
    }
    const walWhileHeldMb = statSync(`${path}-wal`).size / 2 ** 20;
    await reader.exec('COMMIT');
    const checkpoint = await writer.get('PRAGMA wal_checkpoint(TRUNCATE)');
    const walAfterMb = statSync(`${path}-wal`).size / 2 ** 20;
    await reader.close();
    await writer.close();
    return { walWhileHeldMb, walAfterMb, checkpoint };
  });
}

/**
 * Gaps between consecutive setImmediate turns on the main thread.
 * (monitorEventLoopDelay is timer based and only sees Windows' ~15.6 ms timer tick.)
 */
function measureLoopGaps(): () => number[] {
  const gaps: number[] = [];
  let last = performance.now();
  let running = true;
  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return () => {
    running = false;
    return gaps;
  };
}

async function eventLoopDelayUnderLoad(): Promise<Stats & { workerBusyMs: number }> {
  return withDb(async (path) => {
    const writer = await SqliteWorker.open({ path });
    await writer.exec(SCHEMA);
    const stop = measureLoopGaps();
    const started = performance.now();
    await writer.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500000)
      INSERT INTO events (aggregate_id, revision, type, actor, payload, created_at)
      SELECT 'bulk', i, 'node.updated', 'agent:codex', printf('{"i":%d}', i), 0 FROM n`);
    const workerBusyMs = performance.now() - started;
    const gaps = stop();
    await writer.close();
    return { ...stats(gaps), workerBusyMs };
  });
}

console.log(`Node ${process.version} (${process.platform} ${process.arch})`);
{
  const probe = await withDb(async (path) => {
    const db = await SqliteWorker.open({ path });
    const row = await db.get<{ v: string }>('SELECT sqlite_version() AS v');
    await db.close();
    return row?.v;
  });
  console.log(`sqlite_version() = ${probe ?? '?'}\n`);
}

console.log('## Write throughput (events/s, one transaction per batch)\n');
console.log('| synchronous | batch 1 | batch 10 | batch 100 |');
console.log('|---|---|---|---|');
for (const synchronous of ['full', 'normal'] as const) {
  const cells: string[] = [];
  for (const [batch, total] of [
    [1, 3000],
    [10, 20_000],
    [100, 50_000],
  ] as const) {
    cells.push(Math.round(await writeThroughput(synchronous, batch, total)).toString());
  }
  console.log(`| ${synchronous} | ${cells.join(' | ')} |`);
}

console.log('\n## Read latency (ms, 50k events, round trip from the main thread)\n');
console.log('| mode | query | p50 | p95 | p99 | max |');
console.log('|---|---|---|---|---|---|');
for (const mode of ['idle', 'separate reader', 'same worker'] as const) {
  for (const [query, s] of await readLatency(mode)) {
    console.log(`| ${mode} | ${query} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} |`);
  }
}

console.log('\n## WAL growth with a long-lived read transaction\n');
const wal = await checkpointWithLongReader();
console.log(
  `WAL while reader held a snapshot: ${wal.walWhileHeldMb.toFixed(1)} MB; after release + TRUNCATE checkpoint: ${wal.walAfterMb.toFixed(1)} MB; checkpoint = ${JSON.stringify(wal.checkpoint)}`,
);

console.log('\n## Main thread event loop delay while the worker runs a 500k-row insert\n');
const delay = await eventLoopDelayUnderLoad();
console.log(
  `worker busy ${ms(delay.workerBusyMs)} ms; main loop turn gap p50 ${ms(delay.p50)} / p99 ${ms(delay.p99)} / max ${ms(delay.max)} ms over ${delay.n} turns`,
);
