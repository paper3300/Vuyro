import type { Clock, TimerHandle } from '@vuyro/agent-adapters';

/**
 * Time source for the engine. Everything that reads the time or waits goes through a Clock
 * (interface shared with the adapters), so tests can drive time with `VirtualClock` instead of sleeping.
 */
export type { Clock, TimerHandle };

class SystemClock implements Clock {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private nextId = 1;

  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timerId = this.nextId++;
    this.timers.set(
      timerId,
      setTimeout(() => {
        this.timers.delete(timerId);
        callback();
      }, delayMs),
    );
    return { timerId };
  }

  clearTimeout(handle: TimerHandle): void {
    clearTimeout(this.timers.get(handle.timerId));
    this.timers.delete(handle.timerId);
  }

  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, delayMs));
  }
}

export const systemClock: Clock = new SystemClock();

interface VirtualTimer {
  readonly timerId: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

/** Lets pending promise continuations (including ones that schedule timers) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Manually driven clock for tests. Time moves only through `advance`/`advanceTo`/`runAll`.
 * Timers fire in due order (ties in creation order), and promise continuations run between them.
 */
export class VirtualClock implements Clock {
  private current: number;
  private timers: VirtualTimer[] = [];
  private nextId = 1;

  /** Default start: 2026-01-01T00:00:00Z. */
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer = { timerId: this.nextId++, dueAt: this.current + Math.max(0, delayMs), callback };
    this.timers.push(timer);
    return { timerId: timer.timerId };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((timer) => timer.timerId !== handle.timerId);
  }

  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, delayMs));
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** When the next timer fires, if any. */
  nextDueAt(): number | undefined {
    return this.nextDue()?.dueAt;
  }

  /** Moves time forward by `ms`, firing every timer that comes due on the way. */
  advance(ms: number): Promise<void> {
    if (ms < 0) return Promise.reject(new RangeError('cannot move a clock backwards'));
    return this.advanceTo(this.current + ms);
  }

  async advanceTo(target: number): Promise<void> {
    await settle();
    for (;;) {
      const next = this.nextDue();
      if (next === undefined || next.dueAt > target) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.current = Math.max(this.current, next.dueAt);
      next.callback();
      await settle();
    }
    this.current = Math.max(this.current, target);
  }

  /** Fires timers until none are left. Throws after `limit` timers (runaway loop guard). */
  async runAll(limit = 10_000): Promise<void> {
    await settle();
    for (let fired = 0; ; fired++) {
      const next = this.nextDue();
      if (next === undefined) return;
      if (fired >= limit) throw new Error(`VirtualClock.runAll: more than ${limit} timers`);
      await this.advanceTo(next.dueAt);
    }
  }

  private nextDue(): VirtualTimer | undefined {
    let next: VirtualTimer | undefined;
    for (const timer of this.timers) {
      if (next === undefined || timer.dueAt < next.dueAt) next = timer;
    }
    return next;
  }
}
