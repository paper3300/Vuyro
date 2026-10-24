import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardResult } from '@vuyro/contracts';
import { EngineConnection, type EventBatch } from '../../src/main/engine-connection.ts';
import { engineConnector } from '../../src/main/engine-connector.ts';

/**
 * The connection against real engine processes (Windows): the app starts a detached engine and hands it its
 * credential on stdin, writes through it, keeps its subscription across an engine restart, and drives a ticket of the
 * default template through the spec approval gate with the development engine's scripted agents.
 */

const devEngine = fileURLToPath(new URL('../../scripts/dev-engine.ts', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for an engine to end on its own (it was asked to stop), and ends it if it does not. */
async function endProcess(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(pid)) process.kill(pid);
}

let counter = 0;
function open(entryPath?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vuyro-desktop-'));
  const pipePath = `\\\\.\\pipe\\vuyro-test-desktop-${process.pid}-${Date.now()}-${++counter}`;
  const base = engineConnector({ dataDir, pipePath, nodePath: process.execPath, ...(entryPath === undefined ? {} : { entryPath }) });
  // Every engine this connection started: a test that ends while the connection is starting one again (it restarts a
  // vanished engine) must not leave it running (seen once under a loaded full run).
  const launched = new Set<number>();
  const connection = new EngineConnection({
    connector: {
      ...base,
      launch: async (credential) => {
        const result = await base.launch(credential);
        launched.add(result.pid);
        return result;
      },
    },
    backoffMs: [200],
    statusEveryMs: 500,
  });
  cleanups.push(async () => {
    if (connection.current.access === 'write') await connection.shutdownEngine();
    connection.stop();
    for (const pid of launched) await endProcess(pid);
    // The engine releases its files when its process ends.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  return { connection, dataDir, pipePath };
}

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition never held: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let requests = 0;
async function command<T>(connection: EngineConnection, type: string, payload: unknown): Promise<T> {
  const result = await connection.request<{ result: T }>('command.execute', { requestId: `desktop-it-${String(++requests).padStart(6, '0')}`, type, payload });
  if (!result.ok) throw new Error(`${type}: ${result.error.code} ${result.error.message}`);
  return result.value.result;
}

describe.runIf(process.platform === 'win32')('engine connection with real engine processes', () => {
  it('starts the engine, writes as the person, and resumes the subscription after the engine restarts', async () => {
    const { connection } = open();
    await connection.start();
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    await until(() => connection.current.engine, (engine) => engine?.startedByApp === true);

    const seen: number[] = [];
    connection.subscribe(0, (events: EventBatch) => seen.push(...events.map((event) => event.sequence)));
    const { projectId } = await command<{ projectId: string }>(connection, 'project.create', { name: 'sample' });
    await command(connection, 'ticket.create', { projectId, title: 'Before restart' });
    const before = await until(() => [...seen], (list) => list.length >= 2);

    // The engine goes away (as if it crashed or was stopped elsewhere); the app starts a new one with its credential.
    const firstPid = connection.current.engine?.pid;
    const stopped = await connection.request('engine.shutdown', {});
    expect(stopped.ok).toBe(true);
    await until(() => connection.current, (state) => state.phase === 'connected' && state.engine !== undefined && state.engine.pid !== firstPid, 30_000);
    expect(connection.current.access).toBe('write');

    await command(connection, 'ticket.create', { projectId, title: 'After restart' });
    const after = await until(() => [...seen], (list) => list.length > before.length);
    // Every event once, in order, with no gap across the restart.
    expect(after).toEqual(Array.from({ length: after.length }, (_, index) => index + 1));
    const board = await connection.request<BoardResult>('query.board', { projectId });
    expect(board.ok && board.value.tickets.map((ticket) => ticket.title)).toEqual(['Before restart', 'After restart']);
  }, 60_000);

  it('a second app connection to the same engine without the credential is read-only', async () => {
    const { connection, dataDir, pipePath } = open();
    await connection.start();
    const other = new EngineConnection({ connector: engineConnector({ dataDir, pipePath, nodePath: process.execPath }) });
    await other.start();
    try {
      expect(other.current).toMatchObject({ phase: 'connected', access: 'read-only' });
      const refused = await other.request('command.execute', { requestId: 'desktop-it-readonly-1', type: 'project.create', payload: { name: 'x' } });
      expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await other.shutdownEngine()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    } finally {
      other.stop();
    }
  }, 60_000);

  it('drives a default-template ticket through the spec approval gate (development engine, scripted agents)', async () => {
    const { connection } = open(devEngine);
    await connection.start();
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    const { projectId } = await command<{ projectId: string }>(connection, 'project.create', { name: 'sample' });
    const { ticketId } = await command<{ ticketId: string }>(connection, 'ticket.create', { projectId, title: 'Notepad save', template: { id: 'vuyro/ai-sdlc' } });
    type Detail = { reviews: { nodeId: string; kind: string }[]; executions: { nodeId: string; port: string | null }[] };
    const detail = async () => {
      const result = await connection.request<Detail>('query.ticket', { ticketId });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    expect((await detail()).reviews).toMatchObject([{ nodeId: 'brainstorming', kind: 'task' }]);
    await command(connection, 'node.done', { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'Save notes with Ctrl+S' });
    await until(detail, (value) => value.reviews.some((review) => review.nodeId === 'specApproval' && review.kind === 'approval'));
    await command(connection, 'node.approve', { ticketId, nodeId: 'specApproval', comment: 'OK' });
    const passed = await until(detail, (value) => value.executions.some((execution) => execution.nodeId === 'plan'));
    expect(passed.executions.find((execution) => execution.nodeId === 'specApproval')?.port).toBe('approve');
    const stats = await connection.request<{ nodes: { nodeId: string; tokens: { input: number } }[] }>('query.ticketStats', { ticketId });
    expect(stats.ok && stats.value.nodes.find((node) => node.nodeId === 'spec')?.tokens.input).toBe(1800);
  }, 60_000);

  it("work goes on while no window listens; a window opened again starts at the engine's last event and misses none after it", async () => {
    const { connection } = open(devEngine);
    await connection.start();
    const { projectId } = await command<{ projectId: string }>(connection, 'project.create', { name: 'sample' });
    const { ticketId } = await command<{ ticketId: string }>(connection, 'ticket.create', { projectId, title: 'Tray', template: { id: 'vuyro/ai-sdlc' } });
    type Detail = { reviews: { nodeId: string }[] };
    const detail = async () => {
      const result = await connection.request<Detail>('query.ticket', { ticketId });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const status = async () => {
      const result = await connection.request<{ lastSequence: number }>('engine.status', {});
      if (!result.ok) throw new Error(result.error.message);
      return result.value.lastSequence;
    };
    // The first window listens, then closes (its subscription ends) right after the person approves the spec.
    const first: number[] = [];
    const closeFirst = connection.subscribe(await status(), (events) => first.push(...events.map((event) => event.sequence)));
    await command(connection, 'node.done', { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'idea' });
    await until(detail, (value) => value.reviews.some((review) => review.nodeId === 'specApproval'));
    await command(connection, 'node.approve', { ticketId, nodeId: 'specApproval' });
    closeFirst();
    const heardBeforeClosing = first.length;
    const closedAt = await status();

    // Nobody listens: plan, the parallel devs, the join and QA still run until QA waits for the person.
    await until(detail, (value) => value.reviews.some((review) => review.nodeId === 'qa'), 40_000);
    const reopenedAt = await status();
    expect(reopenedAt).toBeGreaterThan(closedAt);

    // The window opens again like the screen does: reads where the engine is, reads the state, subscribes from there.
    const second: number[] = [];
    connection.subscribe(reopenedAt, (events) => second.push(...events.map((event) => event.sequence)));
    await command(connection, 'node.approve', { ticketId, nodeId: 'qa' });
    const board = await until(
      async () => connection.request<BoardResult>('query.board', { projectId }),
      (result) => result.ok && result.value.tickets[0]?.status === 'done',
    );
    expect(board.ok).toBe(true);
    const last = await status();
    await until(() => [...second], (list) => list.at(-1) === last);
    // Every event after the reopening point, once, in order.
    expect(second).toEqual(Array.from({ length: last - reopenedAt }, (_, index) => reopenedAt + 1 + index));
    // The closed window heard nothing more.
    expect(first).toHaveLength(heardBeforeClosing);
  }, 90_000);
});
