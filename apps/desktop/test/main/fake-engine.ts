import type { HelloResult } from '@vuyro/contracts';
import { EngineConnectError, type EngineConnector, type EngineLink, type EventBatch, type Scheduler } from '../../src/main/engine-connection.ts';

/**
 * A fake engine for EngineConnection tests: a growing event log, the UI credentials it knows, pairing that the test
 * approves or refuses, and links the test can cut. Subscriptions replay from `afterSequence` like the real one.
 */

type Event = EventBatch[number];

export class FakeEngine {
  running = false;
  readonly known = new Set<string>();
  readonly events: Event[] = [];
  readonly links = new Set<FakeLink>();
  launches: string[] = [];
  /** What `auth.pair` answers: issue a credential, refuse, or hang. */
  pairing: 'approve' | 'refuse' = 'approve';
  /** When set, `launch` starts nothing and another engine "already" runs without our credential. */
  launchRace = false;
  failLaunch: Error | undefined;
  /** The next N connects to a running engine fail as if it did not answer (an engine that started but is not reachable). */
  connectFailures = 0;
  /** Pids of launched engines ended through their handle (`stop`). */
  readonly killed: number[] = [];
  /** When set, `launch` waits for it (a launch still on its way). */
  launchGate: Promise<void> | undefined;
  /** `engine.shutdown` closes the pipe before its answer arrives (the engine stopping fast). */
  shutdownClosesFirst = false;
  runningJobs = 0;
  shutdowns = 0;
  /** The next N `events.subscribe` requests fail (the connection stays up). */
  failSubscriptions = 0;
  private nextCredential = 1;

  append(type: string, aggregateId = 'ticket-1', aggregateType = 'ticket'): Event {
    const event = { sequence: this.events.length + 1, type, aggregateId, aggregateType, data: {} };
    this.events.push(event);
    for (const link of this.links) link.deliver([event]);
    return event;
  }

  /** The engine process dies: every link closes, credentials are forgotten. */
  crash(): void {
    this.running = false;
    this.known.clear();
    for (const link of [...this.links]) link.cut(new Error('engine gone'));
  }

  /** The handle of a launched engine: ends it only while it still runs (a handle of an exited process reaches nothing). */
  endLaunched(pid: number): boolean {
    if (!this.running) return false;
    this.killed.push(pid);
    this.crash();
    return true;
  }

  issueCredential(): string {
    const credential = `vuc_paired-${String(this.nextCredential++)}-0123456789abcdefghijklmnopqrstuvwxyz`;
    this.known.add(credential);
    return credential;
  }

  connector(): EngineConnector & { connects: (string | undefined)[] } {
    const connects: (string | undefined)[] = [];
    let issued = 0;
    return {
      connects,
      newCredential: () => `vuc_app-${String(++issued)}-0123456789abcdefghijklmnopqrstuvwxyz`,
      connect: (credential) => {
        connects.push(credential);
        if (!this.running) return Promise.reject(new EngineConnectError('unavailable', 'no engine'));
        if (this.connectFailures > 0) {
          this.connectFailures -= 1;
          return Promise.reject(new EngineConnectError('unavailable', 'the engine does not answer yet'));
        }
        if (credential !== undefined && !this.known.has(credential)) return Promise.reject(new EngineConnectError('unauthenticated', 'invalid UI credential'));
        const link = new FakeLink(this, credential === undefined ? 'unverified' : 'ui');
        this.links.add(link);
        return Promise.resolve(link);
      },
      launch: async (credential) => {
        this.launches.push(credential);
        if (this.launchGate !== undefined) await this.launchGate;
        if (this.failLaunch !== undefined) return Promise.reject(this.failLaunch);
        if (this.launchRace) {
          this.running = true;
          return Promise.resolve({ started: false, pid: 2, stop: () => false });
        }
        if (!this.running) {
          this.running = true;
          this.known.add(credential);
          return Promise.resolve({ started: true, pid: 1, stop: () => this.endLaunched(1) });
        }
        return Promise.resolve({ started: false, pid: 1, stop: () => false });
      },
    };
  }
}

export class FakeLink implements EngineLink {
  readonly hello: HelloResult;
  closed = false;
  private readonly engine: FakeEngine;
  private readonly subscriptions = new Map<number, { last: number; onEvents: (events: EventBatch) => void }>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private nextSubscription = 1;
  readonly requests: { method: string; params: unknown }[] = [];

  constructor(engine: FakeEngine, identity: HelloResult['identity']) {
    this.engine = engine;
    this.hello = { protocol: 1, engineVersion: '0.0.0', identity, lastSequence: engine.events.length };
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the connection was closed'));
    this.requests.push({ method, params });
    switch (method) {
      case 'engine.status':
        return Promise.resolve({ pid: 1, engineVersion: '0.0.0', dataDir: 'C:\\data', running: this.engine.runningJobs, lastSequence: this.engine.events.length } as T);
      case 'engine.shutdown':
        if (this.hello.identity !== 'ui') return Promise.reject(Object.assign(new Error('only the human'), { data: { code: 'forbidden', message: 'only the human', retryable: false } }));
        this.engine.shutdowns += 1;
        if (this.engine.shutdownClosesFirst) {
          this.engine.crash();
          return Promise.reject(new Error('the connection was closed'));
        }
        setTimeout(() => {
          this.engine.crash();
        }, 0);
        return Promise.resolve({ stopping: true } as T);
      case 'auth.pair': {
        for (const handler of this.handlers.get('auth.pairingCode') ?? []) handler({ code: '4821', expiresInMs: 120_000 });
        if (this.engine.pairing === 'refuse') return Promise.reject(Object.assign(new Error('not approved'), { data: { code: 'forbidden', message: 'the request was not approved', retryable: false } }));
        return Promise.resolve({ kind: 'ui', credential: this.engine.issueCredential() } as T);
      }
      case 'query.projects':
        return Promise.resolve({ projects: [] } as T);
      default:
        return Promise.reject(Object.assign(new Error(`unknown method '${method}'`), { data: { code: 'unknown_command', message: `unknown method '${method}'`, retryable: false } }));
    }
  }

  subscribe(afterSequence: number, onEvents: (events: EventBatch) => void): Promise<{ unsubscribe(): Promise<void> }> {
    if (this.closed) return Promise.reject(new Error('the connection was closed'));
    if (this.engine.failSubscriptions > 0) {
      this.engine.failSubscriptions -= 1;
      return Promise.reject(new Error('subscription refused'));
    }
    const id = this.nextSubscription++;
    const entry = { last: afterSequence, onEvents };
    this.subscriptions.set(id, entry);
    // Catch up from the log, like the engine (events.subscribe).
    const backlog = this.engine.events.filter((event) => event.sequence > afterSequence);
    if (backlog.length > 0) {
      queueMicrotask(() => {
        if (this.subscriptions.has(id)) this.deliverTo(entry, backlog);
      });
    }
    return Promise.resolve({
      unsubscribe: () => {
        this.subscriptions.delete(id);
        return Promise.resolve();
      },
    });
  }

  deliver(events: EventBatch): void {
    for (const entry of this.subscriptions.values()) this.deliverTo(entry, events);
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private deliverTo(entry: { last: number; onEvents: (events: EventBatch) => void }, events: EventBatch): void {
    const fresh = events.filter((event) => event.sequence > entry.last);
    if (fresh.length === 0) return;
    entry.last = fresh.at(-1)?.sequence ?? entry.last;
    entry.onEvents(fresh);
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  cut(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.links.delete(this);
    this.subscriptions.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  close(): void {
    this.cut(new Error('the connection was closed'));
  }
}

/** Timers the test fires by hand. */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private next = 1;

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  /** Moves time forward and fires what is due (in order). */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** Lets queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}
