import { duplexPair } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type DomainEvent, RPC_METHODS, RPC_NOTIFICATIONS, SchemaValidator } from '@vuyro/contracts';
import type { CommandBus } from '../src/commands/command-bus.ts';
import { denyingApprover } from '../src/daemon/approver.ts';
import { HumanCredentials } from '../src/daemon/credentials.ts';
import type { EngineQueries } from '../src/daemon/queries.ts';
import { PairingGate, RpcConnection } from '../src/daemon/rpc-server.ts';
import { systemClock } from '../src/runtime/clock.ts';
import { cryptoRandom } from '../src/runtime/ids.ts';
import type { EventStore } from '../src/store/event-store.ts';

/**
 * The server side of `events.subscribe` on its own (the client also drops repeats, which would hide a server
 * that sends them): every event after the cursor exactly once, including one committed while the catch-up read
 * was finishing, and nothing at or before the cursor.
 */

const event = (sequence: number): DomainEvent => ({ sequence, type: 'project.created', aggregateId: `p${sequence}` }) as unknown as DomainEvent;

class FakeStore {
  readonly log: DomainEvent[] = [];
  private listener: ((events: readonly DomainEvent[]) => void) | undefined;
  /** Runs inside the next read that finds nothing new, before it answers (a commit landing in that window). */
  beforeEmptyRead: (() => void) | undefined;

  subscribe(listener: (events: readonly DomainEvent[]) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  commit(...events: DomainEvent[]): void {
    this.log.push(...events);
    this.listener?.(events);
  }

  notify(events: DomainEvent[]): void {
    this.listener?.(events);
  }

  readEvents(options: { afterSequence?: number; limit?: number }): Promise<DomainEvent[]> {
    const page = this.log.filter((item) => item.sequence > (options.afterSequence ?? 0)).slice(0, options.limit ?? 500);
    if (page.length === 0 && this.beforeEmptyRead !== undefined) {
      const hook = this.beforeEmptyRead;
      this.beforeEmptyRead = undefined;
      hook();
    }
    return Promise.resolve(page);
  }

  lastSequence(): Promise<number> {
    return Promise.resolve(this.log.at(-1)?.sequence ?? 0);
  }
}

function open(store: FakeStore) {
  const [server, client] = duplexPair();
  new RpcConnection(server, {
    bus: {} as CommandBus,
    store: store as unknown as EventStore,
    queries: {} as EngineQueries,
    credentials: new HumanCredentials({ clock: systemClock, random: cryptoRandom }),
    approver: denyingApprover,
    pairing: new PairingGate(),
    clock: systemClock,
    random: cryptoRandom,
    validator: new SchemaValidator(),
    engineVersion: 'test',
    cliCredentialTtlMs: 1000,
    pairingTimeoutMs: 1000,
    status: () => Promise.reject(new Error('unused')),
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const received: number[] = [];
  let buffer = '';
  client.setEncoding('utf8');
  client.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)) as { method?: string; params?: { events: DomainEvent[] } };
      buffer = buffer.slice(newline + 1);
      if (message.method === RPC_NOTIFICATIONS.events) received.push(...(message.params?.events ?? []).map((item) => item.sequence));
    }
  });
  let id = 0;
  const send = (method: string, params: unknown) => {
    id += 1;
    client.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  };
  send(RPC_METHODS.hello, { protocol: 1, client: 'cli' });
  return { received, send, close: () => client.destroy() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('events.subscribe (server)', () => {
  it('delivers an event committed while the last catch-up read was answering', async () => {
    const store = new FakeStore();
    store.commit(event(1), event(2), event(3));
    store.beforeEmptyRead = () => {
      store.commit(event(4));
    };
    const connection = open(store);
    await settle();
    connection.send(RPC_METHODS.subscribe, { afterSequence: 1 });
    await settle();
    store.commit(event(5));
    await settle();
    expect(connection.received).toEqual([2, 3, 4, 5]);
    connection.close();
  });

  it('never sends an event at or before what it already delivered', async () => {
    const store = new FakeStore();
    store.commit(event(1), event(2));
    const connection = open(store);
    await settle();
    connection.send(RPC_METHODS.subscribe, { afterSequence: 0 });
    await settle();
    store.notify([event(2), event(3)]);
    store.log.push(event(3));
    await settle();
    expect(connection.received).toEqual([1, 2, 3]);
    connection.close();
  });
});
