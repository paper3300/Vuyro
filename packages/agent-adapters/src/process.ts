import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Clock } from './clock.ts';

/**
 * Child processes (agent CLIs, scripts). Nothing calls child_process directly, so tests can replay
 * recorded CLI output with `FakeProcessRunner` on a virtual clock.
 */
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Full environment of the child. Nothing is inherited implicitly. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * `kill` ends the whole process tree, not just the child: agent CLIs and scripts start shells and tools
   * of their own. Windows: `taskkill /T /F` before the child itself. Elsewhere: the child's process group.
   */
  readonly killTree?: boolean;
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

/** Single-consumer async queue. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(item: T): void {
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

  /** Items queued and not yet read. */
  get size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * After the child exits, how long to wait for its output pipes to close. A grandchild that inherited them
 * (and outlived the child) would otherwise keep the run open forever.
 */
const PIPE_CLOSE_GRACE_MS = 2000;
/** How long `taskkill` may take before the child itself is killed anyway. */
const TREE_KILL_TIMEOUT_MS = 5000;

function taskkillPath(): string {
  // Not looked up on PATH: an agent's working folder must not be able to put its own taskkill first.
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

export const nodeProcessRunner: ProcessRunner = {
  spawn(spec: SpawnSpec): ManagedProcess {
    const posixGroup = spec.killTree === true && process.platform !== 'win32';
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      // A process group of its own lets POSIX kill the tree. On Windows `detached` would drop the console
      // (tools the agent starts would open windows) and leave libuv's kill-on-exit job, so it is not used.
      detached: posixGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = new AsyncQueue<string>();
    const stderr = new AsyncQueue<string>();
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
    let killing = false;
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('error', (error) => {
        stdout.end();
        stderr.end();
        resolve({ code: null, signal: null, error });
      });
      child.once('exit', () => {
        const grace = setTimeout(() => {
          // The pipes are still open: something else holds them. Stop reading; the run is over.
          child.stdout.destroy();
          child.stderr.destroy();
          stdout.end();
          stderr.end();
        }, PIPE_CLOSE_GRACE_MS);
        grace.unref();
        child.once('close', () => {
          clearTimeout(grace);
        });
      });
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });
    const killChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      if (posixGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the child alone.
        }
      }
      child.kill(signal);
    };
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
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (spec.killTree !== true || process.platform !== 'win32' || child.pid === undefined) {
          killChild(signal);
          return;
        }
        if (killing) return;
        killing = true;
        // The tree is found through parent process ids, so the child must still be alive while taskkill walks it.
        const killer = spawn(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        };
        const timer = setTimeout(finish, TREE_KILL_TIMEOUT_MS);
        timer.unref();
        killer.once('error', finish);
        killer.once('exit', finish);
      },
      exited,
    };
  },
};

// ---------------------------------------------------------------------------
// Fake

/** What a `run` step of a fake process can see and do. */
export interface FakeProcessContext {
  readonly spec: SpawnSpec;
  /** Everything written to stdin so far. */
  input(): string;
  inputEnded(): boolean;
  stdout(line: string): void;
  stderr(line: string): void;
  /** True once the process was killed (stop doing things). */
  readonly killed: boolean;
}

export type FakeStep =
  | { readonly delayMs?: number; readonly stdout: string }
  | { readonly delayMs?: number; readonly stderr: string }
  | { readonly delayMs?: number; readonly exit: number | null; readonly signal?: string }
  /** Runs code as the process (e.g. call the `vuyro` CLI with the spawn's environment), then goes on. */
  | { readonly delayMs?: number; readonly run: (process: FakeProcessContext) => Promise<void> | void };

export interface FakeScript {
  /** Picks the script for a spawn. Scripts without `match` are used in order. */
  readonly match?: (spec: SpawnSpec) => boolean;
  readonly steps: readonly FakeStep[];
  /** pid reported by the fake process. */
  readonly pid?: number;
  /** Exit reported when killed. Default: `{code: null, signal}`. Lets tests model a process that dies its own way. */
  readonly onKill?: (signal: string) => ProcessExit;
}

export interface FakeSpawn {
  readonly spec: SpawnSpec;
  readonly process: ManagedProcess;
  /** Everything written to stdin so far. */
  readonly input: () => string;
  readonly inputEnded: () => boolean;
  /** Signals `kill` was called with, in order. */
  readonly kills: readonly string[];
}

/**
 * Replays scripted output. `stdout`/`stderr` steps emit one line each (a newline is added).
 * Delays run on the given clock, so a virtual clock controls the timing.
 * A script without an exit step keeps running until `kill`.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly spawned: FakeSpawn[] = [];
  private readonly scripts: FakeScript[] = [];
  private readonly clock: Pick<Clock, 'sleep'>;

  constructor(clock: Pick<Clock, 'sleep'>) {
    this.clock = clock;
  }

  enqueue(script: FakeScript): void {
    this.scripts.push(script);
  }

  /** Scripts not used yet. */
  get pending(): number {
    return this.scripts.length;
  }

  spawn(spec: SpawnSpec): ManagedProcess {
    const index = this.scripts.findIndex((script) => script.match === undefined || script.match(spec));
    const script = index >= 0 ? this.scripts.splice(index, 1)[0] : undefined;
    const stdout = new AsyncQueue<string>();
    const stderr = new AsyncQueue<string>();
    let input = '';
    let inputEnded = false;
    const kills: string[] = [];
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
    const context: FakeProcessContext = {
      spec,
      input: () => input,
      inputEnded: () => inputEnded,
      stdout: (line) => {
        if (!state.finished) stdout.push(`${line}\n`);
      },
      stderr: (line) => {
        if (!state.finished) stderr.push(`${line}\n`);
      },
      get killed() {
        return kills.length > 0;
      },
    };

    if (script === undefined) {
      finish({ code: null, signal: null, error: Object.assign(new Error(`spawn ${spec.command} ENOENT`), { code: 'ENOENT' }) });
    } else {
      void (async () => {
        for (const step of script.steps) {
          if (step.delayMs !== undefined && step.delayMs > 0) await this.clock.sleep(step.delayMs);
          if (state.finished) return;
          if ('stdout' in step) context.stdout(step.stdout);
          else if ('stderr' in step) context.stderr(step.stderr);
          else if ('run' in step) await step.run(context);
          else {
            finish({ code: step.exit, signal: step.signal ?? null });
            return;
          }
        }
      })().catch((error: unknown) => {
        context.stderr(`fake process failed: ${error instanceof Error ? error.message : String(error)}`);
        finish({ code: 70, signal: null });
      });
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
        kills.push(signal);
        if (state.finished) return;
        finish(script?.onKill?.(signal) ?? { code: null, signal });
      },
      exited,
    };
    this.spawned.push({ spec, process, input: () => input, inputEnded: () => inputEnded, kills });
    return process;
  }
}
