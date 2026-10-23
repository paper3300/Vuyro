/**
 * Counts work in flight (commands being decided, executors pumping output, files being written),
 * so tests on a virtual clock can wait until the engine has nothing left to do except wait for time.
 * Work that only waits on the clock ends its span before sleeping.
 */
export class ActivityTracker {
  private active = 0;
  private waiters: (() => void)[] = [];

  /** Marks the start of some work. Call the returned function exactly once when it ends. */
  begin(): () => void {
    this.active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active -= 1;
      if (this.active === 0) this.wake();
    };
  }

  /** Runs `task` inside a span. */
  async track<T>(task: () => Promise<T>): Promise<T> {
    const end = this.begin();
    try {
      return await task();
    } finally {
      end();
    }
  }

  get busy(): boolean {
    return this.active > 0;
  }

  /** Resolves once nothing is active and nothing new started over a few event-loop turns. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.active > 0) {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
        continue;
      }
      // Let continuations that are about to begin new work run first.
      for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.active === 0) return;
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
