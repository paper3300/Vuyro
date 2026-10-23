import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLines } from '../src/runtime/process.ts';
import { BUILTIN_PROJECTORS } from '../src/store/projections.ts';
import { type Harness, openHarness, SYSTEM, tempDir } from './helpers/engine-harness.ts';

const writerScript = fileURLToPath(new URL('./helpers/crash-writer.ts', import.meta.url));

/**
 * Runs the writer in a child process. Its writer worker kills the process right after the
 * `crashAfter`-th event insert, i.e. inside a transaction, before COMMIT.
 */
async function writeUntilCrash(path: string, crashAfter: number): Promise<{ acknowledged: number; code: number | null }> {
  const child = spawn(process.execPath, [writerScript, path, String(crashAfter)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => { resolve(code); }));
  let acknowledged = 0;
  for await (const line of readLines(child.stdout)) acknowledged = Number(line);
  const code = await exited;
  if (stderr.includes('Error')) throw new Error(`writer failed: ${stderr}`);
  return { acknowledged, code };
}

async function dumpProjections(h: Harness): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of BUILTIN_PROJECTORS.flatMap((projector) => projector.tables)) {
    out[table] = await h.store.query(`SELECT * FROM ${table} ORDER BY 1`);
  }
  return out;
}

describe('crash recovery', () => {
  let temp: ReturnType<typeof tempDir>;
  let h: Harness | undefined;

  beforeEach(() => {
    temp = tempDir('vuyro-crash-');
  });

  afterEach(async () => {
    await h?.close();
    temp.dispose();
  });

  it('keeps log, projections and idempotency records consistent after a kill inside a transaction', { timeout: 60_000 }, async () => {
    const path = join(temp.dir, 'engine.db');
    // 3 setup events + 20 observe commands × 5 events = 103; the kill lands after the 3rd event of the 21st command.
    const { acknowledged, code } = await writeUntilCrash(path, 3 + 20 * 5 + 3);
    expect(code).not.toBe(0);
    expect(acknowledged).toBe(20);
    h = await openHarness(path);

    // Exactly the 20 acknowledged commands are there; the interrupted one left nothing behind.
    expect(await h.store.lastSequence()).toBe(103);
    // Log: gapless sequence and per-aggregate revisions.
    const [log] = await h.store.query<{ n: number; last: number }>('SELECT COUNT(*) AS n, MAX(sequence) AS last FROM events');
    expect(log?.n).toBe(log?.last);
    const gaps = await h.store.query('SELECT aggregate_id FROM events GROUP BY aggregate_id HAVING COUNT(*) <> MAX(revision)');
    expect(gaps).toEqual([]);

    // Each command is all-or-nothing: its events and its idempotency record exist together.
    const orphans = await h.store.query(
      `SELECT DISTINCT request_id FROM events WHERE request_id IS NOT NULL
       AND request_id NOT IN (SELECT request_id FROM commands)`,
    );
    expect(orphans).toEqual([]);
    const [observed] = await h.store.query<{ commands: number; messages: number }>(
      `SELECT (SELECT COUNT(*) FROM commands WHERE type = 'run.observe') AS commands,
              (SELECT COUNT(*) FROM events WHERE type = 'run.messageRecorded') AS messages`,
    );
    expect(observed?.messages).toBe((observed?.commands ?? 0) * 5);
    expect(observed).toEqual({ commands: 20, messages: 100 });

    // Projections match the log: the incremental tables equal a full replay.
    const [run] = await h.store.query<{ run_id: string; messages: number; revision: number }>('SELECT run_id, messages, revision FROM p_runs');
    expect(run?.messages).toBe(observed?.messages);
    const before = await dumpProjections(h);
    await h.store.rebuildProjections();
    expect(await dumpProjections(h)).toEqual(before);

    // And the engine carries on from where the log ends.
    const next = await h.ok('run.observe', { runId: run?.run_id, observations: [{ kind: 'message', role: 'assistant', text: 'after crash' }] }, SYSTEM);
    expect(next.revision).toBe((run?.revision ?? 0) + 1);
  });
});
