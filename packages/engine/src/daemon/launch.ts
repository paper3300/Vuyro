import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentEnvironment } from '@vuyro/agent-adapters';
import { type ClientKind, RPC_METHODS } from '@vuyro/contracts';
import { EngineClient, EngineUnavailableError, resolveEngineLocation } from '../client/engine-client.ts';

/** The daemon entry point next to this module (source while developing, `dist` once built). */
export function daemonEntryPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './main.ts' : './main.js', import.meta.url));
}

export interface LaunchOptions {
  readonly dataDir?: string;
  readonly pipePath?: string;
  /** The app's UI credential, written to the daemon's stdin (the app is the launcher). */
  readonly uiCredential?: string;
  /** How long to wait for the engine to answer. Default `ENGINE_READY_TIMEOUT_MS`. */
  readonly readyTimeoutMs?: number;
  /**
   * Takes the spawned process's handle right after the spawn, before the engine answers. Whoever takes it owns the
   * process from then on: a launch that fails (no answer in time, an unexpected error) leaves it to them. Without an
   * owner the launch ends the process itself when it fails.
   */
  readonly onSpawn?: (child: LaunchedChild) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Client kind for the readiness check. */
  readonly client?: ClientKind;
  /** The `vuyro` CLI script; agents that cannot reach the pipe from their sandbox run `vuyro mcp` from it. */
  readonly cliEntry?: string;
  /**
   * The Node executable that runs the engine. Default: this process's. A host that is not Node itself (the Electron
   * app) must pass one: the engine runs on its own pinned Node, never on Electron's ([[기술 스택 결정]] §2).
   */
  readonly nodePath?: string;
  /** The daemon entry script. Default `daemonEntryPath()`. Development hosts point it at a wrapper (fake agents). */
  readonly entryPath?: string;
}

/** How long a launch waits for the engine to answer by default. */
export const ENGINE_READY_TIMEOUT_MS = 20_000;

/** The process a launch spawned, through its own handle (never a bare pid that another process may have taken over). */
export interface LaunchedChild {
  readonly pid: number | undefined;
  /** Ends it, unless it already exited (then the handle reaches nothing). False when there was nothing to end. */
  stop(): boolean;
}

export interface LaunchResult {
  /** The engine that answers (this launch's process, or one that was already running). */
  readonly pid: number;
  /** False when another engine already served this data directory (the new process gave up). */
  readonly started: boolean;
  readonly pipePath: string;
  readonly dataDir: string;
}

/** Ends a spawned process through its handle, unless it already exited (then the handle no longer reaches anything). */
export function stopChild(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return false;
  return child.kill();
}

/**
 * Starts the engine daemon as a detached process (it outlives whoever started it: closing the app window or the
 * terminal does not stop the work) and waits until an engine answers for the data directory. Fails if none does.
 */
export async function launchEngineDaemon(options: LaunchOptions = {}): Promise<LaunchResult> {
  const location = resolveEngineLocation(options);
  const args = [options.entryPath ?? daemonEntryPath(), '--data-dir', location.dataDir, '--pipe', location.pipePath];
  if (options.uiCredential !== undefined) args.push('--ui-credential-stdin');
  if (options.cliEntry !== undefined) args.push('--vuyro-cli', options.cliEntry);
  const child = spawn(options.nodePath ?? process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: [options.uiCredential === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
    // Nothing of the launcher's own Vuyro context (a credential, a run token) is handed to the engine.
    env: agentEnvironment(options.env ?? process.env, {}),
  });
  let exited: number | null | undefined;
  child.once('exit', (code) => {
    exited = code;
  });
  child.once('error', () => {
    exited = -1;
  });
  if (options.uiCredential !== undefined) {
    child.stdin?.end(`${options.uiCredential}\n`);
  }
  child.unref();
  options.onSpawn?.({ pid: child.pid, stop: () => stopChild(child) });
  // A launch that fails must not leave a process nobody can reach: its owner ends it, or the launch does.
  const failed = (error: Error): Error => {
    if (options.onSpawn === undefined) stopChild(child);
    return error;
  };
  const deadline = Date.now() + (options.readyTimeoutMs ?? ENGINE_READY_TIMEOUT_MS);
  for (;;) {
    try {
      const client = await EngineClient.connect({ client: options.client ?? 'cli', dataDir: location.dataDir, pipePath: location.pipePath, timeoutMs: 2000 });
      try {
        const { pid } = await client.request<{ pid: number }>(RPC_METHODS.status, {});
        return { pid, started: pid === child.pid, pipePath: location.pipePath, dataDir: location.dataDir };
      } finally {
        client.close();
      }
    } catch (error) {
      if (!(error instanceof EngineUnavailableError)) throw failed(error as Error);
      if (exited !== undefined) throw new EngineUnavailableError(`the engine exited during startup (code ${String(exited)}); see ${location.dataDir}\\logs\\engine.log`);
      if (Date.now() > deadline) throw failed(new EngineUnavailableError('the engine did not answer in time'));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
