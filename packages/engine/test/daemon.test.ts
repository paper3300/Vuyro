import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DomainEvent, RPC_METHODS, RPC_NOTIFICATIONS } from '@vuyro/contracts';
import { EngineClient, EngineRequestError, EngineUnavailableError } from '../src/client/engine-client.ts';
import { startEngineDaemon } from '../src/daemon/daemon.ts';
import { enginePaths } from '../src/daemon/paths.ts';
import { DataDirectoryLockedError, lockDataDirectory } from '../src/platform/win32/process-guard.ts';
import { systemClock } from '../src/runtime/clock.ts';
import { createUuidV7Generator } from '../src/runtime/ids.ts';
import { CommandBus } from '../src/commands/command-bus.ts';
import { EventStore } from '../src/store/event-store.ts';
import { type DaemonHarness, dbPath, openDaemonHarness, testPipe, UI_CREDENTIAL } from './helpers/daemon-harness.ts';
import { tempDir } from './helpers/engine-harness.ts';

/**
 * The engine daemon ([[명령·이벤트 계약]] §11): JSON-RPC on the authenticated pipe, who a connection is,
 * how a person gets a human credential without restarting the engine, event subscriptions, single instance
 * and the startup order.
 */

let h: DaemonHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function refused(promise: Promise<unknown>): Promise<EngineRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineRequestError) return error;
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

let requests = 0;
const rid = () => `test-req-${String(++requests).padStart(6, '0')}`;

describe.runIf(process.platform === 'win32')('engine daemon', () => {
  describe('session identity', () => {
    it('a connection without a credential is unverified and read-only', async () => {
      h = await openDaemonHarness();
      const cli = await h.connect();
      expect(cli.hello).toMatchObject({ protocol: 1, identity: 'unverified' });
      const error = await refused(cli.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } }));
      expect(error.data.code).toBe('forbidden');
      expect(error.rpcCode).toBe(-32002);
      expect(await cli.request<{ projects: unknown[] }>(RPC_METHODS.projects, {})).toEqual({ projects: [] });
      // Saying "I am the UI" without the credential changes nothing.
      const claimsUi = await h.connect({ client: 'ui' });
      expect(claimsUi.hello.identity).toBe('unverified');
      expect((await refused(claimsUi.execute({ requestId: rid(), type: 'project.create', payload: { name: 'x' } }))).data.code).toBe('forbidden');
    });

    it('the launch UI credential makes a ui-session that can write', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      expect(ui.hello.identity).toBe('ui');
      const created = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
      expect(created.ok).toBe(true);
      const events = await h.daemon.store.readEvents();
      expect(events.at(-1)?.actor).toEqual({ kind: 'human', userId: 'local', via: 'ui' });
    });

    it('a wrong UI credential is refused, not downgraded', async () => {
      h = await openDaemonHarness();
      await expect(h.connect({ client: 'ui', uiCredential: `${UI_CREDENTIAL}x` })).rejects.toMatchObject({ data: { code: 'unauthenticated' } });
    });

    it('a UI credential does not work as a CLI human credential and the reverse', async () => {
      h = await openDaemonHarness();
      await expect(h.connect({ humanCredential: UI_CREDENTIAL })).rejects.toMatchObject({ data: { code: 'unauthenticated' } });
      const cli = await h.connect();
      const { credential } = await cli.request<{ credential: string }>(RPC_METHODS.pair, { kind: 'cli' });
      await expect(h.connect({ client: 'ui', uiCredential: credential })).rejects.toMatchObject({ data: { code: 'unauthenticated' } });
    });

    it('requires hello first, allows it once, and refuses both credentials at once', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      await expect(ui.request(RPC_METHODS.hello, { protocol: 1, client: 'cli' })).rejects.toMatchObject({ data: { code: 'invariant_violated' } });
      await expect(h.connect({ uiCredential: UI_CREDENTIAL, humanCredential: 'vhc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })).rejects.toMatchObject({ data: { code: 'validation_failed' } });
      await expect(h.connect({ client: 'cli' }).then((client) => client.request(RPC_METHODS.hello, { protocol: 2, client: 'cli' }))).rejects.toBeInstanceOf(EngineRequestError);
    });

    it('refuses requests before hello', async () => {
      h = await openDaemonHarness();
      const { readEngineToken } = await import('../src/ipc/engine-token.ts');
      const { connectAuthenticatedPipe } = await import('../src/ipc/pipe-auth.ts');
      const socket = await connectAuthenticatedPipe(h.pipePath, readEngineToken(enginePaths(h.dataDir).token));
      socket.setEncoding('utf8');
      const reply = new Promise<string>((resolve) => socket.once('data', (chunk: string) => { resolve(chunk); }));
      socket.resume();
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: RPC_METHODS.execute, params: { requestId: rid(), type: 'project.create', payload: { name: 'x' } } })}\n`);
      expect(JSON.parse(await reply)).toMatchObject({ id: 1, error: { data: { code: 'unauthenticated' } } });
      socket.destroy();
      expect(await h.daemon.store.query('SELECT COUNT(*) AS n FROM p_projects')).toEqual([{ n: 0 }]);
    });

    it('a run token narrows even a UI session to that node agent', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      const error = await refused(ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'x' }, auth: { runToken: `vrt_${'A'.repeat(43)}` } }));
      expect(error.data.code).toBe('unauthenticated');
    });
  });

  describe('human credential for the CLI (pairing)', () => {
    it('an approved pairing issues a time-limited credential that makes the CLI the human', async () => {
      h = await openDaemonHarness({ cliCredentialTtlMs: 60_000 });
      const cli = await h.connect();
      const codes: string[] = [];
      cli.on(RPC_NOTIFICATIONS.pairingCode, (params) => codes.push((params as { code: string }).code));
      const issued = await cli.request<{ kind: string; credential: string; expiresAt: number }>(RPC_METHODS.pair, { kind: 'cli' });
      expect(issued.kind).toBe('cli');
      expect(issued.credential).toMatch(/^vhc_/);
      expect(issued.expiresAt).toBeGreaterThan(Date.now());
      // The dialog showed the same code the requester saw.
      expect(h.approver.requests.map((request) => request.code)).toEqual(codes);
      expect(h.approver.requests[0]?.kind).toBe('cli');

      const human = await h.connect({ humanCredential: issued.credential });
      expect(human.hello.identity).toBe('human-cli');
      await human.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
      const events = await h.daemon.store.readEvents();
      expect(events.at(-1)?.actor).toEqual({ kind: 'human', userId: 'local', via: 'cli' });
    });

    it('the CLI credential expires', async () => {
      h = await openDaemonHarness({ cliCredentialTtlMs: 150 });
      const { credential } = await (await h.connect()).request<{ credential: string }>(RPC_METHODS.pair, { kind: 'cli' });
      const human = await h.connect({ humanCredential: credential });
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Checked again on every command, not only at hello.
      expect((await refused(human.execute({ requestId: rid(), type: 'project.create', payload: { name: 'x' } }))).data.code).toBe('unauthenticated');
      expect((await refused(human.request(RPC_METHODS.shutdown, {}))).data.code).toBe('forbidden');
      await expect(h.connect({ humanCredential: credential })).rejects.toMatchObject({ data: { code: 'unauthenticated' } });
    });

    it.each([
      ['denied', false],
      ['the dialog failed', 'throw'],
    ] as const)('a pairing that is %s issues nothing', async (_name, answer) => {
      h = await openDaemonHarness();
      h.approver.answer = answer;
      const cli = await h.connect();
      expect((await refused(cli.request(RPC_METHODS.pair, { kind: 'cli' }))).data.code).toBe('forbidden');
      expect((await refused(cli.execute({ requestId: rid(), type: 'project.create', payload: { name: 'x' } }))).data.code).toBe('forbidden');
    });

    it('a pairing nobody answers times out, and one pairing at a time', async () => {
      h = await openDaemonHarness({ pairingTimeoutMs: 100 });
      h.approver.answer = 'never';
      const first = await h.connect();
      const second = await h.connect();
      const waiting = refused(first.request(RPC_METHODS.pair, { kind: 'ui' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await refused(second.request(RPC_METHODS.pair, { kind: 'cli' }))).data.code).toBe('invariant_violated');
      expect((await waiting).data.code).toBe('forbidden');
      h.approver.answer = true;
      expect((await second.request<{ kind: string }>(RPC_METHODS.pair, { kind: 'ui' })).kind).toBe('ui');
    }, 15_000);

    it('a paired UI credential opens a ui-session on the running engine (no restart)', async () => {
      h = await openDaemonHarness({ withoutUiCredential: true });
      const before = h.daemon.startedAt;
      const { credential } = await (await h.connect({ client: 'ui' })).request<{ credential: string }>(RPC_METHODS.pair, { kind: 'ui' });
      const ui = await h.connect({ client: 'ui', uiCredential: credential });
      expect(ui.hello.identity).toBe('ui');
      expect(h.daemon.startedAt).toBe(before);
    });
  });

  describe('engine control', () => {
    it('only a person may stop the engine', async () => {
      h = await openDaemonHarness();
      const cli = await h.connect();
      expect((await refused(cli.request(RPC_METHODS.shutdown, {}))).data.code).toBe('forbidden');
      const status = await cli.request<{ pid: number; running: number }>(RPC_METHODS.status, {});
      expect(status).toMatchObject({ pid: process.pid, running: 0 });
    });

    it('a second engine on the same data directory fails before reading anything', async () => {
      h = await openDaemonHarness();
      await expect(startEngineDaemon({ dataDir: h.dataDir, pipePath: testPipe(), adapters: {} })).rejects.toBeInstanceOf(DataDirectoryLockedError);
      // The first engine still answers with its own token.
      expect((await h.connect()).hello.identity).toBe('unverified');
    });

    it('a second engine on the same pipe fails and leaves the first one alone', async () => {
      h = await openDaemonHarness();
      const other = tempDir('vuyro-daemon-other-');
      try {
        await expect(startEngineDaemon({ dataDir: other.dir, pipePath: h.pipePath, adapters: {} })).rejects.toThrow(/EADDRINUSE/);
        expect((await h.connect()).hello.identity).toBe('unverified');
        // Its lock was released: the directory can be used again.
        lockDataDirectory(enginePaths(other.dir).lock).release();
      } finally {
        other.dispose();
      }
    });

    it('reports a missing engine as unavailable', async () => {
      const temp = tempDir('vuyro-daemon-none-');
      try {
        await expect(EngineClient.connect({ client: 'cli', dataDir: temp.dir, pipePath: testPipe() })).rejects.toBeInstanceOf(EngineUnavailableError);
      } finally {
        temp.dispose();
      }
    });
  });

  describe('startup', () => {
    async function seedOrphan(dataDir: string): Promise<string> {
      mkdirSync(dirname(dbPath(dataDir)), { recursive: true });
      const store = await EventStore.open({ path: dbPath(dataDir), clock: systemClock, ids: createUuidV7Generator({ clock: systemClock }) });
      const bus = new CommandBus({ store, ids: createUuidV7Generator({ clock: systemClock }) });
      const human = { kind: 'ui-session' } as const;
      const project = await bus.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } }, human);
      const projectId = (project.ok ? project.result : {}) as { projectId: string };
      const ticket = await bus.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: projectId.projectId, title: 't' } }, human);
      const { ticketId } = (ticket.ok ? ticket.result : {}) as { ticketId: string };
      const run = await bus.execute({ requestId: rid(), type: 'run.start', payload: { ticketId, nodeId: 'dev', provider: 'claude' } }, { kind: 'internal', component: 'test' });
      await store.close();
      return ((run.ok ? run.result : {}) as { runId: string }).runId;
    }

    it('settles runs orphaned by a previous engine before serving', async () => {
      const temp = tempDir('vuyro-daemon-orphan-');
      try {
        const runId = await seedOrphan(temp.dir);
        const daemon = await startEngineDaemon({ dataDir: temp.dir, pipePath: testPipe(), adapters: {}, approver: { confirm: () => Promise.resolve(false) } });
        try {
          expect(await daemon.store.queryOne('SELECT status, terminal_reason FROM p_runs WHERE run_id = ?', [runId])).toEqual({ status: 'abnormal_exit', terminal_reason: 'engine_restarted' });
        } finally {
          await daemon.close();
        }
      } finally {
        temp.dispose();
      }
    });

    it('starts again on its own data: the built-ins it installed last time do not hold up the start', async () => {
      // Regression: installing the built-ins again replayed the first 'staged' answer and waited forever.
      h = await openDaemonHarness();
      const ui = await h.ui();
      const { result } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
      const started = Date.now();
      await h.restart();
      expect(Date.now() - started).toBeLessThan(10_000);
      const again = await h.ui();
      expect(await again.request(RPC_METHODS.projects, {})).toMatchObject({ projects: [{ projectId: (result as { projectId: string }).projectId }] });
      const templates = await h.daemon.store.query<{ status: string }>("SELECT status FROM p_definitions WHERE kind = 'template'");
      expect(templates.map((row) => row.status)).toEqual(['active', 'active']);
      await h.restart();
      expect((await (await h.ui()).request<{ projects: unknown[] }>(RPC_METHODS.projects, {})).projects).toHaveLength(1);
    }, 30_000);

    it('writes the vuyro shims for agents at every start, from the CLI it was given', async () => {
      h = await openDaemonHarness({ vuyroCli: { command: 'C:\\node\\node.exe', args: ['C:\\app\\cli\\bin.js'] } });
      const bin = enginePaths(h.dataDir).bin;
      expect(readFileSync(join(bin, 'vuyro.cmd'), 'utf8')).toBe('@"C:\\node\\node.exe" "C:\\app\\cli\\bin.js" %*\r\n');
      expect(readFileSync(join(bin, 'vuyro'), 'utf8')).toContain("exec 'C:/node/node.exe' 'C:/app/cli/bin.js' \"$@\"");
      await h.restart({ vuyroCli: { command: 'C:\\node\\node.exe', args: ['C:\\moved\\bin.js'] } });
      expect(readFileSync(join(bin, 'vuyro.cmd'), 'utf8')).toContain('C:\\moved\\bin.js');
      expect(readdirSync(bin).sort()).toEqual(['vuyro', 'vuyro.cmd']);
    }, 30_000);

    it('does not touch the runs while another engine holds the data directory', async () => {
      const temp = tempDir('vuyro-daemon-held-');
      try {
        const runId = await seedOrphan(temp.dir);
        const held = lockDataDirectory(enginePaths(temp.dir).lock);
        await expect(startEngineDaemon({ dataDir: temp.dir, pipePath: testPipe(), adapters: {} })).rejects.toBeInstanceOf(DataDirectoryLockedError);
        held.release();
        const store = await EventStore.open({ path: dbPath(temp.dir), clock: systemClock, ids: createUuidV7Generator({ clock: systemClock }) });
        expect(await store.queryOne('SELECT status FROM p_runs WHERE run_id = ?', [runId])).toEqual({ status: 'running' });
        await store.close();
      } finally {
        temp.dispose();
      }
    });
  });

  describe('event subscription', () => {
    it('delivers every event after the cursor once, in order, across catch-up and live writes', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      for (let i = 0; i < 30; i++) await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: `p${i}` } });
      const start = (await h.daemon.store.lastSequence()) - 10;
      const received: DomainEvent[] = [];
      const writes = (async () => {
        for (let i = 0; i < 40; i++) await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: `q${i}` } });
      })();
      const watcher = await h.connect();
      await watcher.subscribe(start, (events) => received.push(...events));
      await writes;
      const last = await h.daemon.store.lastSequence();
      for (let i = 0; i < 200 && received.at(-1)?.sequence !== last; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received.map((event) => event.sequence)).toEqual(Array.from({ length: last - start }, (_, index) => start + index + 1));
    });

    it('resumes from the last delivered sequence on a new connection', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'a' } });
      const first = await h.connect();
      const seen: number[] = [];
      const subscription = await first.subscribe(0, (events) => seen.push(...events.map((event) => event.sequence)));
      for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const cursor = subscription.last();
      first.close();
      await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'b' } });
      const again: number[] = [];
      await (await h.connect()).subscribe(cursor, (events) => again.push(...events.map((event) => event.sequence)));
      for (let i = 0; i < 100 && again.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(again[0]).toBe(cursor + 1);
    });
  });

  describe('queries', () => {
    it('answers projects, tickets, ticket detail, artifacts and statistics', async () => {
      h = await openDaemonHarness();
      const ui = await h.ui();
      const { projectId } = (await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } })).result as { projectId: string };
      const { ticketId } = (await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId, title: 'Notepad' } })).result as { ticketId: string };
      await ui.execute({ requestId: rid(), type: 'artifact.add', payload: { ticketId, nodeId: 'spec', slot: 'doc', ref: { kind: 'file', uri: 'spec.md', version: '1' } } });
      await ui.execute({ requestId: rid(), type: 'artifact.add', payload: { ticketId, nodeId: 'spec', slot: 'doc', ref: { kind: 'file', uri: 'spec.md', version: '2' } } });
      expect(await ui.request(RPC_METHODS.projects, {})).toMatchObject({ projects: [{ projectId, name: 'sample' }] });
      expect(await ui.request(RPC_METHODS.tickets, { projectId })).toMatchObject({ tickets: [{ ticketId, title: 'Notepad', status: 'open' }] });
      expect(await ui.request(RPC_METHODS.ticket, { ticketId })).toMatchObject({ ticket: { ticketId }, lanes: [], runs: [] });
      const { artifacts } = await ui.request<{ artifacts: { version: string; current: boolean }[] }>(RPC_METHODS.artifacts, { ticketId });
      expect(artifacts.map((artifact) => [artifact.version, artifact.current])).toEqual([
        ['1', false],
        ['2', true],
      ]);
      expect(await ui.request(RPC_METHODS.ticketStats, { ticketId })).toMatchObject({ ticketId, status: 'open', nodes: [] });
      expect((await refused(ui.request(RPC_METHODS.ticket, { ticketId: projectId }))).data.code).toBe('not_found');
      expect((await refused(ui.request(RPC_METHODS.ticket, { ticketId: 'nope' }))).data.code).toBe('validation_failed');
      expect((await refused(ui.request('query.nothing', {}))).rpcCode).toBe(-32601);
    });
  });
});
