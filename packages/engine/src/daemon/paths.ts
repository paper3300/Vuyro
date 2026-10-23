import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getCurrentUserSid } from '../platform/win32/security.ts';

/** Where an engine keeps its files. One data directory = one engine (see `lockDataDirectory`). */
export interface EnginePaths {
  readonly dataDir: string;
  readonly db: string;
  readonly token: string;
  readonly lock: string;
  readonly definitions: string;
  readonly log: string;
}

/** `%LOCALAPPDATA%\Vuyro` (local to this PC, not roamed). */
export function defaultDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Vuyro');
}

export function enginePaths(dataDir: string): EnginePaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    db: join(root, 'engine', 'engine.db'),
    // The default data directory gives the token path the pipe authentication has always used.
    token: join(root, 'engine', 'engine.token'),
    lock: join(root, 'engine', 'engine.lock'),
    definitions: join(root, 'definitions'),
    log: join(root, 'logs', 'engine.log'),
  };
}

/**
 * Pipe name of the engine for a data directory: per OS user (named pipes are one namespace for the whole PC)
 * and per data directory, so a test engine never answers for the real one. Clients compute the same name.
 */
export function defaultPipePath(dataDir: string): string {
  const user = process.platform === 'win32' ? getCurrentUserSid() : String(process.getuid?.() ?? 'user');
  const digest = createHash('sha256').update(`${user}\u0000${resolve(dataDir).toLowerCase()}`).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\vuyro-engine-${digest}`;
}
