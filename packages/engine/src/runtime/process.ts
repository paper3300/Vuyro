import { spawn } from 'node:child_process';
import type { Clock } from './clock.ts';

/**
 * Child processes (agent CLIs, scripts). The engine never calls child_process directly,
 * so tests can replay recorded CLI output with `FakeProcessRunner` on a virtual clock.
 */
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Full environment of the child. Nothing is inherited implicitly. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  /** null when the process was killed by a signal or never started. */
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started (e.g. ENOENT). */
  readonly error?: Error;
}

export interface ManagedProcess {
  readonly pid: number | undefined;
  /** UTF-8 text chunks (not lines; see `readLines`). Ends when the stream closes. */
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  write(data: string): void;
  endInput(): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** Resolves after the process ended and its output streams closed. Never rejects. */
  readonly exited: Promise<ProcessExit>;
}

export interface ProcessRunner {
  spawn(spec: SpawnSpec): ManagedProcess;
}

/** Splits text chunks into lines (without the newline; a trailing '\r' is removed). */
export async function* readLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** Single-consumer async queue of text chunks. */
class ChunkQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;

  push(item: string): void {
    if (this.ended) return;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export const nodeProcessRunner: ProcessRunner = {
  spawn(spec: SpawnSpec): ManagedProcess {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = new ChunkQueue();
    const stderr = new ChunkQueue();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    child.stdout.on('close', () => {
      stdout.end();
    });
    child.stderr.on('close', () => {
      stderr.end();
    });
    // A closed stdin (child exited first) must not crash the engine.
    child.stdin.on('error', () => undefined);
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('error', (error) => {
        stdout.end();
        stderr.end();
        resolve({ code: null, signal: null, error });
      });
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });
    return {
      pid: child.pid,
      stdout,
      stderr,
      write: (data) => {
        child.stdin.write(data);
      },
      endInput: () => {
        child.stdin.end();
      },
      kill: (signal = 'SIGTERM') => {
        child.kill(signal);
      },
      exited,
    };
  },
};

// ---------------------------------------------------------------------------
// Fake

export type FakeStep =
  | { readonly delayMs?: number; readonly stdout: string }
  | { readonly delayMs?: number; readonly stderr: string }
  | { readonly delayMs?: number; readonly exit: number | null; readonly signal?: string };

export interface FakeScript {
  /** Picks the script for a spawn. Scripts without `match` are used in order. */
  readonly match?: (spec: SpawnSpec) => boolean;
  readonly steps: readonly FakeStep[];
  /** pid reported by the fake process. */
  readonly pid?: number;
}

export interface FakeSpawn {
  readonly spec: SpawnSpec;
  readonly process: ManagedProcess;
  /** Everything written to stdin so far. */
  readonly input: () => string;
  readonly inputEnded: () => boolean;
}

/**
 * Replays scripted output. `stdout`/`stderr` steps emit one line each (a newline is added).
 * Delays run on the given clock, so a VirtualClock controls the timing.
 * A script without an exit step keeps running until `kill`.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly spawned: FakeSpawn[] = [];
  private readonly scripts: FakeScript[] = [];
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  enqueue(script: FakeScript): void {
    this.scripts.push(script);
  }

  spawn(spec: SpawnSpec): ManagedProcess {
    const index = this.scripts.findIndex((script) => script.match === undefined || script.match(spec));
    const script = index >= 0 ? this.scripts.splice(index, 1)[0] : undefined;
    const stdout = new ChunkQueue();
    const stderr = new ChunkQueue();
    let input = '';
    let inputEnded = false;
    const state = { finished: false };
    let finish!: (exit: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => {
      finish = (exit) => {
        if (state.finished) return;
        state.finished = true;
        stdout.end();
        stderr.end();
        resolve(exit);
      };
    });

    if (script === undefined) {
      finish({ code: null, signal: null, error: Object.assign(new Error(`spawn ${spec.command} ENOENT`), { code: 'ENOENT' }) });
    } else {
      void (async () => {
        for (const step of script.steps) {
          if (step.delayMs !== undefined && step.delayMs > 0) await this.clock.sleep(step.delayMs);
          if (state.finished) return;
          if ('stdout' in step) stdout.push(`${step.stdout}\n`);
          else if ('stderr' in step) stderr.push(`${step.stderr}\n`);
          else {
            finish({ code: step.exit, signal: step.signal ?? null });
            return;
          }
        }
      })();
    }

    const process: ManagedProcess = {
      pid: script === undefined ? undefined : (script.pid ?? 10_000 + this.spawned.length),
      stdout,
      stderr,
      write: (data) => {
        if (!inputEnded) input += data;
      },
      endInput: () => {
        inputEnded = true;
      },
      kill: (signal = 'SIGTERM') => {
        finish({ code: null, signal });
      },
      exited,
    };
    this.spawned.push({ spec, process, input: () => input, inputEnded: () => inputEnded });
    return process;
  }
}
