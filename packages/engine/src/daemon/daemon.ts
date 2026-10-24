import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type net from 'node:net';
import { AGENT_ENV, type AgentAdapter, CliAgentAdapter } from '@vuyro/agent-adapters';
import { type AgentProvider, type EngineStatus, SchemaValidator } from '@vuyro/contracts';
import { CommandBus } from '../commands/command-bus.ts';
import { startEnginePipe, type AuthenticatedPipeServer } from '../ipc/pipe-auth.ts';
import { type DirectoryLock, lockDataDirectory } from '../platform/win32/process-guard.ts';
import { ActivityTracker } from '../runtime/activity.ts';
import { type Clock, systemClock } from '../runtime/clock.ts';
import { type FileSystem, nodeFileSystem } from '../runtime/fs.ts';
import { createUuidV7Generator, cryptoRandom, type IdGenerator, type RandomSource } from '../runtime/ids.ts';
import { nodeProcessRunner, type ProcessRunner } from '../runtime/process.ts';
import { EventStore } from '../store/event-store.ts';
import { installBuiltins } from '../workflow/builtins.ts';
import { DefinitionWriter } from '../workflow/definition-writer.ts';
import { DefinitionRegistry } from '../workflow/definitions.ts';
import { WorkflowEngine, type WorkflowEngineOptions } from '../workflow/engine.ts';
import type { GitClient } from '../workspace/git.ts';
import { workspaceServices } from '../workspace/services.ts';
import { type FileWatcher, parcelWatcher } from '../workspace/watcher.ts';
import { denyingApprover, type HumanApprover, windowsDialogApprover } from './approver.ts';
import { HumanCredentials } from './credentials.ts';
import { defaultDataDir, defaultPipePath, type EnginePaths, enginePaths } from './paths.ts';
import { EngineQueries } from './queries.ts';
import { PairingGate, RpcConnection } from './rpc-server.ts';

export interface EngineDaemonOptions {
  /** Default `%LOCALAPPDATA%\Vuyro`. */
  readonly dataDir?: string;
  /** Default `defaultPipePath(dataDir)`. */
  readonly pipePath?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly random?: RandomSource;
  readonly fs?: FileSystem;
  /** Default: the Claude and Codex CLI adapters on real processes. */
  readonly adapters?: Partial<Record<AgentProvider, AgentAdapter>>;
  readonly processRunner?: ProcessRunner;
  /** Default: a Windows dialog on this PC. */
  readonly approver?: HumanApprover;
  /**
   * How to run the `vuyro` CLI (e.g. node + its bin.js). Codex agents get `vuyro mcp` from it as an MCP server,
   * because their sandboxed shell cannot open the engine pipe. Absent = Codex agents can only use the shell.
   */
  readonly vuyroCli?: { readonly command: string; readonly args: readonly string[] };
  /** The app's credential when the app launched this engine (read from stdin by the entry point). */
  readonly uiCredential?: string;
  readonly maxConcurrent?: number;
  /** Time limit of one agent run. Default 60 minutes ([[결정 대기]] D-026). */
  readonly agentTimeoutMs?: number;
  readonly workspace?: WorkflowEngineOptions['workspace'];
  /** Git for worktree mode and read-only status. Default: git on PATH. */
  readonly git?: GitClient;
  /** Watches workspaces while executions run. Default @parcel/watcher; `null` = no watching (scans only). */
  readonly watcher?: FileWatcher | null;
  /** Time limit of a CLI human credential. Default 8 hours ([[결정 대기]] D-023). */
  readonly cliCredentialTtlMs?: number;
  /** How long a pairing waits for the person. Default 2 minutes. */
  readonly pairingTimeoutMs?: number;
  readonly engineVersion?: string;
  /** Called when a client asked the engine to stop (the entry point exits after `close`). */
  readonly onShutdownRequest?: () => void;
  readonly reportError?: (error: Error, context: string) => void;
}

export interface EngineDaemon {
  readonly paths: EnginePaths;
  readonly pipePath: string;
  readonly startedAt: number;
  readonly store: EventStore;
  readonly bus: CommandBus;
  readonly engine: WorkflowEngine;
  readonly registry: DefinitionRegistry;
  readonly credentials: HumanCredentials;
  readonly activity: ActivityTracker;
  /** Stops listening, cancels running executors, closes the database and releases the data directory. */
  close(): Promise<void>;
}

const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_CLI_CREDENTIAL_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_PAIRING_TIMEOUT_MS = 2 * 60_000;
const CLOSE_GRACE_MS = 10_000;

export function engineVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/**
 * Starts the engine daemon ([[명령·이벤트 계약]] §11). The order matters:
 *
 * 1. Lock the data directory. A second engine on the same data fails here, before it reads anything, so it can
 *    never settle the runs of the engine that is still running as orphans.
 * 2. Listen on the pipe (`startEnginePipe`: new token, single instance per pipe name). Connections that arrive
 *    early wait until the engine is ready.
 * 3. Open the log, the definitions and the bus; finish staged definitions; install the built-ins.
 * 4. Start the workflow engine, which settles orphaned runs first (§4 "실행 복구") and picks up the work left.
 * 5. Serve the waiting connections.
 */
export async function startEngineDaemon(options: EngineDaemonOptions = {}): Promise<EngineDaemon> {
  const paths = enginePaths(options.dataDir ?? defaultDataDir());
  const pipePath = options.pipePath ?? defaultPipePath(paths.dataDir);
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  const ids = options.ids ?? createUuidV7Generator({ clock, random });
  const fs = options.fs ?? nodeFileSystem;
  const version = options.engineVersion ?? engineVersion();
  const reportError =
    options.reportError ??
    ((error: Error, context: string) => {
      const line = `${new Date(clock.now()).toISOString()} ${context}: ${error.stack ?? error.message}\n`;
      try {
        appendFileSync(paths.log, line);
      } catch {
        process.stderr.write(line);
      }
    });
  mkdirSync(dirname(paths.db), { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });

  const lock: DirectoryLock = lockDataDirectory(paths.lock);
  const credentials = new HumanCredentials({ clock, random });
  if (options.uiCredential !== undefined) credentials.register('ui', options.uiCredential);
  const activity = new ActivityTracker();
  const connections = new Set<RpcConnection>();
  const sockets = new Set<net.Socket>();
  let closing = false;
  let resolveReady!: (services: ConstructorParameters<typeof RpcConnection>[1]) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<ConstructorParameters<typeof RpcConnection>[1]>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  let server: AuthenticatedPipeServer;
  try {
    server = await startEnginePipe(
      pipePath,
      async (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        const services = await ready;
        if (closing) {
          socket.destroy();
          return;
        }
        const connection = new RpcConnection(socket, services);
        connections.add(connection);
        socket.once('close', () => connections.delete(connection));
      },
      { tokenPath: paths.token },
    );
  } catch (error) {
    lock.release();
    throw error;
  }

  let store: EventStore | undefined;
  let writer: DefinitionWriter | undefined;
  let engine: WorkflowEngine | undefined;
  const closeParts = async (): Promise<void> => {
    closing = true;
    for (const connection of connections) connection.close();
    for (const socket of sockets) socket.destroy();
    await server.close();
    engine?.stop({ cancelRunning: true });
    // Cancelled runs settle and report through the bus before the store closes (bounded in real time).
    await Promise.race([activity.idle(), new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
    writer?.stop();
    await store?.close();
    lock.release();
  };
  try {
    store = await EventStore.open({ path: paths.db, clock, ids });
    const registry = new DefinitionRegistry({ root: paths.definitions, fs, store });
    const workspaces = workspaceServices({ worktreeRoot: paths.worktrees, clock });
    const bus = new CommandBus({ store, ids, random, definitions: registry, humanCredential: credentials.cliVerifier(), reportError, workspaces });
    writer = new DefinitionWriter({ registry, fs, bus, store, activity, reportError });
    writer.start();
    await writer.recover();
    for (const response of await installBuiltins(writer)) {
      if (!response.ok) reportError(new Error(`${response.error.code}: ${response.error.message}`), 'installing a built-in definition');
    }
    const processRunner = options.processRunner ?? nodeProcessRunner;
    // The checkout hook runs `vuyro hook pretooluse` with the same CLI.
    const vuyroHook = options.vuyroCli === undefined ? {} : { vuyroHook: { command: options.vuyroCli.command, args: options.vuyroCli.args } };
    const adapters = options.adapters ?? {
      claude: CliAgentAdapter.claude({ runner: processRunner, clock, ...vuyroHook }),
      codex: CliAgentAdapter.codex({
        runner: processRunner,
        clock,
        ...vuyroHook,
        ...(options.vuyroCli === undefined ? {} : { vuyroMcp: { command: options.vuyroCli.command, args: [...options.vuyroCli.args, 'mcp'] } }),
      }),
    };
    const watcher = options.watcher === undefined ? parcelWatcher() : options.watcher;
    engine = new WorkflowEngine({
      bus,
      store,
      definitions: registry,
      clock,
      adapters,
      processRunner,
      activity,
      reportError,
      agentTimeoutMs: options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      // The agent's `vuyro` calls must reach this engine, whatever its data directory and pipe.
      agentEnv: { [AGENT_ENV.pipe]: pipePath, [AGENT_ENV.dataDir]: paths.dataDir },
      ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      workspaces,
      ...(options.git === undefined ? {} : { git: options.git }),
      ...(watcher === null ? {} : { watcher }),
      sharedLogs: { dir: paths.sharedLogs, fs },
    });
    await engine.start();

    const startedAt = clock.now();
    const workspaceEngine = engine;
    const queries = new EngineQueries({ store, definitions: registry, clock, cleanup: (projectId, ticketId) => workspaceEngine.workspaces.cleanupCandidates(projectId, ticketId) });
    const runningEngine = engine;
    const openStore = store;
    let closePromise: Promise<void> | undefined;
    const daemon: EngineDaemon = {
      paths,
      pipePath,
      startedAt,
      store,
      bus,
      engine,
      registry,
      credentials,
      activity,
      close: () => (closePromise ??= closeParts()),
    };
    resolveReady({
      bus,
      store,
      queries,
      credentials,
      approver: options.approver ?? (process.platform === 'win32' ? windowsDialogApprover() : denyingApprover),
      pairing: new PairingGate(),
      clock,
      random,
      validator: new SchemaValidator(),
      engineVersion: version,
      cliCredentialTtlMs: options.cliCredentialTtlMs ?? DEFAULT_CLI_CREDENTIAL_TTL_MS,
      pairingTimeoutMs: options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
      status: async (): Promise<EngineStatus> => ({
        pid: process.pid,
        engineVersion: version,
        startedAt,
        dataDir: paths.dataDir,
        running: runningEngine.running,
        lastSequence: await openStore.lastSequence(),
      }),
      shutdown: () => {
        if (options.onShutdownRequest !== undefined) options.onShutdownRequest();
        else void daemon.close();
      },
      reportError,
    });
    return daemon;
  } catch (error) {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
    await closeParts().catch(() => undefined);
    throw error;
  }
}
