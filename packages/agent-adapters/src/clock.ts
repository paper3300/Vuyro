/**
 * Time source shared by the adapters and the engine. Everything that reads the time or waits goes through
 * a Clock, so tests drive time with a virtual clock (the engine's `VirtualClock`) instead of sleeping.
 */
export interface TimerHandle {
  readonly timerId: number;
}

export interface Clock {
  /** Epoch milliseconds (UTC). */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Resolves after `delayMs` on this clock. */
  sleep(delayMs: number): Promise<void>;
}
