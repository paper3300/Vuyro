import type { HelloResult } from '@vuyro/contracts';
import type { BridgeError, BridgeResult, ConnectionState, EventsMessage } from '../shared/bridge.ts';

/**
 * The app's connection to the engine daemon (명령·이벤트 계약 §3, §11). Electron-free so tests can drive it with a
 * fake engine.
 *
 * - Finds the engine of the data directory, or starts one and hands it this app's UI credential on stdin.
 * - The credential lives only in this process's memory. An engine that does not know it (started from a terminal,
 *   or restarted while the app was away) gives a read-only session until the person pairs (`pair()`), which makes
 *   the engine show its own approval dialog with a code the app shows too.
 * - Lost connections come back by themselves; subscriptions resume from the last event they delivered, so a screen
 *   sees every event once, in order, across engine restarts.
 */

export type EventBatch = EventsMessage['events'];

/** What the connection needs from one engine connection (EngineClient implements it). */
export interface EngineLink {
  readonly hello: HelloResult;
  request<T>(method: string, params?: unknown): Promise<T>;
  subscribe(afterSequence: number, onEvents: (events: EventBatch) => void): Promise<{ unsubscribe(): Promise<void> }>;
  on(method: string, handler: (params: unknown) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): void;
}

/** Why a connect failed: no engine answers, or it refused the credential. Anything else is unexpected. */
export class EngineConnectError extends Error {
  readonly reason: 'unavailable' | 'unauthenticated';

  constructor(reason: 'unavailable' | 'unauthenticated', message: string) {
    super(message);
    this.name = 'EngineConnectError';
    this.reason = reason;
  }
}

export interface EngineConnector {
  /** Connects to the running engine; throws EngineConnectError. Without a credential the session is read-only. */
  connect(uiCredential: string | undefined): Promise<EngineLink>;
  /** Starts an engine with this credential (stdin). `started` = false when another engine already served the data. */
  launch(uiCredential: string): Promise<{ readonly started: boolean; readonly pid: number }>;
  /** A fresh UI credential (`vuc_…`, at least 32 characters). */
  newCredential(): string;
  /**
   * Ends an engine this app started (`launch` said `started`) but never reached, when the app quits for good: there
   * is no link to ask it to shut down, and leaving it would keep it running with nobody to stop it.
   */
  stopLaunched(pid: number): void;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

export interface EngineConnectionOptions {
  readonly connector: EngineConnector;
  readonly scheduler?: Scheduler;
  /** Waits between reconnect attempts, then the last one repeats. */
  readonly backoffMs?: readonly number[];
  /** How often to ask the engine how many runs are going (the tray shows it). */
  readonly statusEveryMs?: number;
  readonly onError?: (error: Error, context: string) => void;
}

interface Subscriber {
  last: number;
  readonly listener: (events: EventBatch) => void;
  handle: { unsubscribe(): Promise<void> } | undefined;
  /** Which link the handle belongs to; a stale handle from an old link is ignored. */
  link: EngineLink | undefined;
  closed: boolean;
  /** Subscribe attempts that failed in a row on the current link. */
  failures: number;
}

const OFFLINE: BridgeError = { code: 'engine_offline', message: '엔진에 연결되어 있지 않습니다.', retryable: true };

export class EngineConnection {
  private readonly connector: EngineConnector;
  private readonly scheduler: Scheduler;
  private readonly backoffMs: readonly number[];
  private readonly statusEveryMs: number;
  private readonly onError: (error: Error, context: string) => void;
  private link: EngineLink | undefined;
  private credential: string | undefined;
  private state: ConnectionState = { phase: 'connecting', access: 'none' };
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly subscribers = new Set<Subscriber>();
  private establishing: Promise<void> | undefined;
  private retryTimer: unknown;
  private statusTimer: unknown;
  private attempt = 0;
  private stopped = false;
  /** Quitting for good: never reconnect or start an engine again, whatever happens to the link meanwhile. */
  private quitting = false;
  /** An engine this app started and has not reached yet (its pid). */
  private unreachedLaunch: number | undefined;
  private startedByApp = false;

  constructor(options: EngineConnectionOptions) {
    this.connector = options.connector;
    this.scheduler = options.scheduler ?? realScheduler;
    this.backoffMs = options.backoffMs ?? [500, 1000, 2000, 5000];
    this.statusEveryMs = options.statusEveryMs ?? 3000;
    this.onError = options.onError ?? (() => undefined);
  }

  get current(): ConnectionState {
    return this.state;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Connects (or starts the engine). Resolves when this attempt is over, connected or not; it retries on its own. */
  start(): Promise<void> {
    this.stopped = false;
    this.quitting = false;
    return this.establish();
  }

  /**
   * The app is about to quit for good (the person confirmed): from now on a lost link stays lost and no engine is
   * started, even while the shutdown request is on its way or a dialog waits for the person. Otherwise the engine
   * closing the pipe as it stops would make this connection start a new one. The current link stays usable.
   */
  beginQuit(): void {
    this.quitting = true;
    this.clearRetry();
    // An attempt still under way stops its engine itself (through the link, or here once it fails).
    if (this.establishing === undefined) this.stopUnreachedLaunch();
  }

  /** Tries again now instead of waiting for the next retry. */
  retry(): Promise<void> {
    if (this.link !== undefined) return Promise.resolve();
    this.clearRetry();
    this.attempt = 0;
    return this.establish();
  }

  /** Stops talking to the engine (the engine keeps running). */
  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.clearStatus();
    const link = this.link;
    this.link = undefined;
    link?.close();
  }

  async request<T>(method: string, params?: unknown): Promise<BridgeResult<T>> {
    const link = this.link;
    if (link === undefined) return { ok: false, error: OFFLINE };
    try {
      return { ok: true, value: await link.request<T>(method, params) };
    } catch (error) {
      return { ok: false, error: toBridgeError(error) };
    }
  }

  /** Every event after `afterSequence`, in order, then live, across reconnects. Returns the unsubscribe. */
  subscribe(afterSequence: number, listener: (events: EventBatch) => void): () => void {
    const subscriber: Subscriber = { last: afterSequence, listener, handle: undefined, link: undefined, closed: false, failures: 0 };
    this.subscribers.add(subscriber);
    if (this.link !== undefined) void this.attach(subscriber, this.link);
    return () => {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
      const { handle } = subscriber;
      subscriber.handle = undefined;
      if (handle !== undefined && subscriber.link === this.link) void handle.unsubscribe().catch(() => undefined);
    };
  }

  /**
   * Asks the running engine for a UI credential. The engine shows the person a dialog with a code; the app shows the
   * same code (`state.pairing`). Only from a read-only session: a connection that can write needs nothing.
   */
  async pair(): Promise<BridgeResult<null>> {
    const link = this.link;
    if (link === undefined) return { ok: false, error: OFFLINE };
    if (this.state.access === 'write') return { ok: true, value: null };
    const off = link.on('auth.pairingCode', (params) => {
      const { code, expiresInMs } = params as { code: string; expiresInMs: number };
      this.update({ pairing: { code, expiresAt: this.scheduler.now() + expiresInMs } });
    });
    let credential: string;
    try {
      ({ credential } = await link.request<{ credential: string }>('auth.pair', { kind: 'ui' }));
    } catch (error) {
      const failure = toBridgeError(error);
      this.update({ pairing: undefined, message: failure.code === 'forbidden' ? '승인되지 않았습니다. 다시 요청할 수 있습니다.' : failure.message });
      return { ok: false, error: failure };
    } finally {
      off();
    }
    this.credential = credential;
    this.update({ pairing: undefined, message: undefined });
    // Reconnect as the UI session; subscriptions move over from where they were.
    this.dropLink(link);
    link.close();
    await this.establish();
    return this.current.access === 'write' ? { ok: true, value: null } : { ok: false, error: { code: 'unauthenticated', message: '받은 자격으로 연결하지 못했습니다.', retryable: true } };
  }

  /** Stops the engine (only a UI session may). Running agents are cancelled and queue again at the next start. */
  async shutdownEngine(): Promise<BridgeResult<unknown>> {
    this.beginQuit();
    const result = await this.request('engine.shutdown', {});
    if (result.ok) this.stop();
    return result;
  }

  /** A fresh count of running agents and scripts, or undefined when the engine cannot say. */
  async running(): Promise<number | undefined> {
    const status = await this.request<{ running: number }>('engine.status', {});
    if (!status.ok) return undefined;
    if (status.value.running !== this.state.running) this.update({ running: status.value.running });
    return status.value.running;
  }

  private establish(): Promise<void> {
    this.establishing ??= this.connectOnce().finally(() => {
      this.establishing = undefined;
    });
    return this.establishing;
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.quitting || this.link !== undefined) return;
    this.update({ phase: this.state.phase === 'offline' ? 'offline' : 'connecting' });
    try {
      const { link, launched } = await this.open();
      if (this.isStopped()) {
        // An engine this attempt started while the person was quitting: stop it again instead of leaving it behind.
        if (this.isQuitting() && launched && link.hello.identity === 'ui') {
          this.unreachedLaunch = undefined;
          await link.request('engine.shutdown', {}).catch(() => undefined);
        }
        link.close();
        return;
      }
      this.adopt(link);
    } catch (error) {
      // Started an engine, could not reach it, and the person is quitting: nothing will come back to it.
      if (this.isQuitting()) this.stopUnreachedLaunch();
      this.onError(error instanceof Error ? error : new Error(String(error)), 'engine connection');
      const message = error instanceof Error ? error.message : String(error);
      this.update({ phase: this.state.phase === 'launching' ? 'failed' : 'offline', access: 'none', message });
      this.scheduleRetry();
    }
  }

  /**
   * 1. Our credential (making one first): the engine knows it → write access.
   * 2. No engine answers → start one with our credential, then connect with it.
   * 3. An engine answers but does not know the credential → read-only until the person pairs.
   */
  private async open(): Promise<{ link: EngineLink; launched: boolean }> {
    this.credential ??= this.connector.newCredential();
    const credential = this.credential;
    try {
      return { link: await this.connector.connect(credential), launched: false };
    } catch (error) {
      if (!(error instanceof EngineConnectError)) throw error;
      if (error.reason === 'unauthenticated') return { link: await this.connector.connect(undefined), launched: false };
    }
    // Read after the await: the person may have chosen to quit meanwhile.
    if (this.isQuitting()) throw new Error('the app is quitting: no engine is started');
    this.update({ phase: 'launching' });
    const launched = await this.connector.launch(credential);
    this.startedByApp = launched.started;
    if (launched.started) this.unreachedLaunch = launched.pid;
    try {
      return { link: await this.connector.connect(credential), launched: launched.started };
    } catch (error) {
      // Another engine won the race to the data directory: it never got our credential.
      if (error instanceof EngineConnectError && error.reason === 'unauthenticated') return { link: await this.connector.connect(undefined), launched: false };
      throw error;
    }
  }

  private adopt(link: EngineLink): void {
    this.link = link;
    this.unreachedLaunch = undefined;
    this.attempt = 0;
    const access = link.hello.identity === 'ui' ? 'write' : 'read-only';
    link.onClose(() => {
      if (this.link !== link) return;
      this.dropLink(link);
      if (this.stopped) return;
      if (this.quitting) {
        this.update({ phase: 'offline', access: 'none', message: '종료하는 중입니다.' });
        return;
      }
      this.update({ phase: 'offline', access: 'none', message: '엔진 연결이 끊겼습니다. 다시 연결합니다.' });
      this.scheduleRetry();
    });
    this.update({
      phase: 'connected',
      access,
      message: access === 'read-only' ? '이미 실행 중인 엔진에 읽기 전용으로 연결했습니다. 승인·생성을 하려면 권한을 연결하세요.' : undefined,
      lastSequence: link.hello.lastSequence,
      engine: undefined,
    });
    for (const subscriber of this.subscribers) void this.attach(subscriber, link);
    void this.describe(link);
    this.pollStatus(link);
  }

  private async describe(link: EngineLink): Promise<void> {
    try {
      const status = await link.request<{ pid: number; engineVersion: string; dataDir: string; running: number }>('engine.status', {});
      if (this.link !== link) return;
      this.update({ engine: { pid: status.pid, version: status.engineVersion, dataDir: status.dataDir, startedByApp: this.startedByApp }, running: status.running });
    } catch {
      // The status poll tries again.
    }
  }

  private pollStatus(link: EngineLink): void {
    this.clearStatus();
    this.statusTimer = this.scheduler.setTimeout(() => {
      if (this.link !== link) return;
      void this.running().finally(() => {
        if (this.link === link) this.pollStatus(link);
      });
    }, this.statusEveryMs);
  }

  private async attach(subscriber: Subscriber, link: EngineLink): Promise<void> {
    if (subscriber.closed || (subscriber.link === link && subscriber.handle !== undefined)) return;
    subscriber.link = link;
    subscriber.handle = undefined;
    try {
      const handle = await link.subscribe(subscriber.last, (events) => {
        if (subscriber.closed || subscriber.link !== link) return;
        const fresh = events.filter((event) => event.sequence > subscriber.last);
        if (fresh.length === 0) return;
        subscriber.last = fresh.at(-1)?.sequence ?? subscriber.last;
        subscriber.listener(fresh);
      });
      // Read again after the await: it may have been unsubscribed or moved to a newer link meanwhile.
      if (stale(subscriber, link)) {
        void handle.unsubscribe().catch(() => undefined);
        return;
      }
      subscriber.handle = handle;
      subscriber.failures = 0;
    } catch (error) {
      // A link that is going away: the next one attaches again from `last`. One that stays: try again with backoff,
      // or the screen would stop hearing events while the connection looks fine (검수 반영).
      if (stale(subscriber, link) || this.link !== link) return;
      this.onError(error instanceof Error ? error : new Error(String(error)), 'event subscription');
      const wait = this.backoffMs[Math.min(subscriber.failures, this.backoffMs.length - 1)] ?? 1000;
      subscriber.failures += 1;
      this.scheduler.setTimeout(() => {
        if (this.link === link && !subscriber.closed && subscriber.handle === undefined) void this.attach(subscriber, link);
      }, wait);
    }
  }

  private stopUnreachedLaunch(): void {
    const pid = this.unreachedLaunch;
    this.unreachedLaunch = undefined;
    if (pid === undefined) return;
    try {
      this.connector.stopLaunched(pid);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)), 'stopping an unreached engine');
    }
  }

  private dropLink(link: EngineLink): void {
    if (this.link !== link) return;
    this.link = undefined;
    this.clearStatus();
    for (const subscriber of this.subscribers) {
      if (subscriber.link === link) {
        subscriber.handle = undefined;
        subscriber.link = undefined;
        subscriber.failures = 0;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.quitting || this.retryTimer !== undefined) return;
    const wait = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)] ?? 1000;
    this.attempt += 1;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      void this.establish();
    }, wait);
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearStatus(): void {
    if (this.statusTimer === undefined) return;
    this.scheduler.clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
  }

  /** Read after an await: `stop()` or `beginQuit()` may have run meanwhile. */
  private isStopped(): boolean {
    return this.stopped || this.quitting;
  }

  private isQuitting(): boolean {
    return this.quitting;
  }

  /** Merges `patch` into the state; an `undefined` value removes that field. */
  private update(patch: { [K in keyof ConnectionState]?: ConnectionState[K] | undefined }): void {
    const merged: Record<string, unknown> = { ...this.state, ...patch };
    this.state = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as unknown as ConnectionState;
    for (const listener of this.listeners) listener(this.state);
  }
}

function stale(subscriber: Subscriber, link: EngineLink): boolean {
  return subscriber.closed || subscriber.link !== link;
}

/** A command error from the engine (`data` of EngineRequestError), or a plain failure. */
export function toBridgeError(error: unknown): BridgeError {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const { data } = error;
    if (typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'string') {
      const { code, message, retryable, details } = data as { code: string; message?: unknown; retryable?: unknown; details?: unknown };
      return { code, message: typeof message === 'string' ? message : code, retryable: retryable === true, ...(details === undefined ? {} : { details }) };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message, retryable: true };
}
