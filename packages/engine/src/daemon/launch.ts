import { spawn } from 'node:child_process';
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
  /** How long to wait for the engine to answer. Default 20 s. */
  readonly readyTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Client kind for the readiness check. */
  readonly client?: ClientKind;
  /** The `vuyro` CLI script; agents that cannot reach the pipe from their sandbox run `vuyro mcp` from it. */
  readonly cliEntry?: string;
}

export interface LaunchResult {
  /** The engine that answers (this launch's process, or one that was already running). */
  readonly pid: number;
  /** False when another engine already served this data directory (the new process gave up). */
  readonly started: boolean;
  readonly pipePath: string;
  readonly dataDir: string;
}

/**
 * Starts the engine daemon as a detached process (it outlives whoever started it: closing the app window or the
 * terminal does not stop the work) and waits until an engine answers for the data directory. Fails if none does.
 */
export async function launchEngineDaemon(options: LaunchOptions = {}): Promise<LaunchResult> {
  const location = resolveEngineLocation(options);
  const args = [daemonEntryPath(), '--data-dir', location.dataDir, '--pipe', location.pipePath];
  if (options.uiCredential !== undefined) args.push('--ui-credential-stdin');
  if (options.cliEntry !== undefined) args.push('--vuyro-cli', options.cliEntry);
  const child = spawn(process.execPath, args, {
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
  const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
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
      if (!(error instanceof EngineUnavailableError)) throw error;
      if (exited !== undefined) throw new EngineUnavailableError(`the engine exited during startup (code ${String(exited)}); see ${location.dataDir}\\logs\\engine.log`);
      if (Date.now() > deadline) throw new EngineUnavailableError('the engine did not answer in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
