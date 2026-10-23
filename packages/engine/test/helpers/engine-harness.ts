import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResponse, CommandSuccess } from '@vuyro/contracts';
import { CommandBus, type CommandBusOptions } from '../../src/commands/command-bus.ts';
import type { TransportIdentity } from '../../src/commands/caller.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { createUuidV7Generator, seededRandom } from '../../src/runtime/ids.ts';
import { EventStore, type EventStoreOptions } from '../../src/store/event-store.ts';

export const HUMAN: TransportIdentity = { kind: 'ui-session' };
export const SYSTEM: TransportIdentity = { kind: 'internal', component: 'workflow' };
export const CLI: TransportIdentity = { kind: 'engine-token', client: 'cli' };
export const MCP: TransportIdentity = { kind: 'engine-token', client: 'mcp' };

export function tempDir(prefix = 'vuyro-engine-'): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export interface Harness {
  readonly path: string;
  readonly clock: VirtualClock;
  store: EventStore;
  bus: CommandBus;
  exec(type: string, payload: unknown, transport?: TransportIdentity, extra?: Record<string, unknown>): Promise<CommandResponse>;
  ok(type: string, payload: unknown, transport?: TransportIdentity, extra?: Record<string, unknown>): Promise<CommandSuccess>;
  reopen(options?: Partial<EventStoreOptions>): Promise<void>;
  close(): Promise<void>;
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

/** Event store + command bus on a temp database, a virtual clock and seeded randomness. */
export async function openHarness(
  path: string,
  options: Partial<EventStoreOptions> = {},
  busOptions: Partial<CommandBusOptions> = {},
): Promise<Harness> {
  const clock = new VirtualClock();
  const ids = createUuidV7Generator({ clock, random: seededRandom(1) });
  const random = seededRandom(2);
  const open = async (extra: Partial<EventStoreOptions>) => {
    const store = await EventStore.open({ path, clock, ids, ...options, ...extra });
    return { store, bus: new CommandBus({ store, ids, random, ...busOptions }) };
  };
  let current = await open({});
  const harness: Harness = {
    path,
    clock,
    get store() {
      return current.store;
    },
    get bus() {
      return current.bus;
    },
    exec: (type, payload, transport = HUMAN, extra = {}) =>
      current.bus.execute({ requestId: nextRequestId(), type, payload, ...extra }, transport),
    async ok(type, payload, transport = HUMAN, extra = {}) {
      const response = await harness.exec(type, payload, transport, extra);
      if (!response.ok) throw new Error(`${type} failed: ${JSON.stringify(response.error)}`);
      return response;
    },
    async reopen(extra = {}) {
      await current.store.close();
      current = await open(extra);
    },
    close: () => current.store.close(),
  };
  return harness;
}

/** Creates a project and a ticket; returns their ids. */
export async function seedTicket(harness: Harness): Promise<{ projectId: string; ticketId: string }> {
  const project = await harness.ok('project.create', { name: 'sample' });
  const { projectId } = project.result as { projectId: string };
  const ticket = await harness.ok('ticket.create', { projectId, title: 'Add a notepad' });
  const { ticketId } = ticket.result as { ticketId: string };
  return { projectId, ticketId };
}

/** Starts a run as the engine; returns the run id and its token. */
export async function startRun(
  harness: Harness,
  ticketId: string,
  nodeId: string,
): Promise<{ runId: string; runToken: string }> {
  const response = await harness.ok('run.start', { ticketId, nodeId, provider: 'claude' }, SYSTEM);
  return response.result as { runId: string; runToken: string };
}
