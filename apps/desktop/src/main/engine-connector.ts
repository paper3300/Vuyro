import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, EngineRequestError, EngineUnavailableError, launchEngineDaemon } from '@vuyro/engine';
import { EngineConnectError, type EngineConnector, type EngineLink } from './engine-connection.ts';

/**
 * The real engine behind EngineConnection: the authenticated pipe (`EngineClient`) and the detached daemon
 * (`launchEngineDaemon`). The data directory and pipe follow `VUYRO_DATA_DIR` / `VUYRO_PIPE` like the CLI.
 */
export interface EngineConnectorOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataDir?: string;
  readonly pipePath?: string;
  /** Node that runs the engine. Default: `findNode(env)`. */
  readonly nodePath?: string;
  /** Daemon entry. Default: the engine's own (`VUYRO_ENGINE_ENTRY` overrides it for development). */
  readonly entryPath?: string;
  /** The `vuyro` CLI script handed to the engine (`--vuyro-cli`). Default: the bundled CLI. */
  readonly cliEntry?: string;
}

export function engineConnector(options: EngineConnectorOptions = {}): EngineConnector {
  const env = options.env ?? process.env;
  const location = {
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.pipePath === undefined ? {} : { pipePath: options.pipePath }),
    env,
  };
  return {
    newCredential: () => `vuc_${randomBytes(32).toString('base64url')}`,
    async connect(uiCredential) {
      try {
        const client = await EngineClient.connect({ client: 'ui', ...location, ...(uiCredential === undefined ? {} : { uiCredential }) });
        return client satisfies EngineLink;
      } catch (error) {
        if (error instanceof EngineUnavailableError) throw new EngineConnectError('unavailable', error.message);
        if (error instanceof EngineRequestError && error.data.code === 'unauthenticated') throw new EngineConnectError('unauthenticated', error.message);
        throw error;
      }
    },
    async launch(uiCredential) {
      const nodePath = options.nodePath ?? findNode(env);
      const entryPath = options.entryPath ?? nonEmpty(env.VUYRO_ENGINE_ENTRY);
      const launched = await launchEngineDaemon({
        ...location,
        uiCredential,
        client: 'ui',
        nodePath,
        cliEntry: options.cliEntry ?? bundledCliEntry(),
        ...(entryPath === undefined ? {} : { entryPath }),
      });
      return { started: launched.started, pid: launched.pid };
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The Node that runs the engine: `VUYRO_NODE`, else `node` on PATH. Never Electron's own runtime: the engine is a
 * separate pinned Node so the CLI runs without Electron (기술 스택 결정 §2). The installer will bundle one (M7).
 */
export function findNode(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): string {
  const configured = nonEmpty(env.VUYRO_NODE);
  if (configured !== undefined) return configured;
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  const path = env.PATH ?? env.Path ?? '';
  for (const folder of path.split(delimiter)) {
    if (folder === '') continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error('Node 24를 찾지 못했습니다. PATH에 node를 두거나 VUYRO_NODE에 경로를 지정하세요.');
}

/** `bin.js` of the `vuyro` CLI package next to the app (agents run `vuyro mcp` and hooks from it). */
export function bundledCliEntry(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('@vuyro/cli'))), 'bin.js');
}
