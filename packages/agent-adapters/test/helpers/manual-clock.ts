import type { Clock, TimerHandle } from '../../src/clock.ts';

/** Minimal virtual clock for adapter tests (the engine's VirtualClock lives above this package). */
export class ManualClock implements Clock {
  private current: number;
  private timers: { timerId: number; dueAt: number; callback: () => void }[] = [];
  private nextId = 1;

  constructor(start = 1_000_000) {
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

  get pending(): number {
    return this.timers.length;
  }

  /** Fires timers due up to now + ms, letting promise continuations run between them. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await turns();
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.dueAt - b.dueAt || a.timerId - b.timerId)[0];
      if (next === undefined || next.dueAt > target) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.current = Math.max(this.current, next.dueAt);
      next.callback();
      await turns();
    }
    this.current = target;
  }
}

async function turns(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
