import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { allowedTrustees, getCurrentUserSid, readFileSecurity, restrictFileToCurrentUser } from '../platform/win32/security.ts';

/**
 * The engine token: a random secret that the engine writes at startup into a
 * file only the current user can read. Clients prove they know it before any
 * command is processed (see pipe-auth.ts).
 */

export const TOKEN_BYTES = 32;

export interface EngineToken {
  readonly path: string;
  readonly secret: Buffer;
}

/** `%LOCALAPPDATA%\Vuyro\engine\engine.token` (local to this PC, not roamed). */
export function defaultTokenPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Vuyro', 'engine', 'engine.token');
}

/**
 * Writes a fresh token. The file is created empty, restricted to the current
 * user and verified before the secret is written, then moved into place
 * (a rename keeps the file's own DACL). Any failure throws and leaves no
 * secret behind, so the engine does not start (fail closed).
 */
export function createEngineToken(path: string = defaultTokenPath()): EngineToken {
  if (process.platform !== 'win32') throw new Error('createEngineToken is only implemented for Windows');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, '', { flag: 'wx' });
  let moved = false;
  try {
    restrictFileToCurrentUser(temporary);
    const secret = randomBytes(TOKEN_BYTES);
    writeFileSync(temporary, secret.toString('hex'), { flag: 'r+' });
    renameSync(temporary, path);
    moved = true;
    verifyCurrentUserOnly(path);
    return { path, secret };
  } catch (error) {
    rmSync(moved ? path : temporary, { force: true });
    throw error;
  }
}

/** Reads a token written by `createEngineToken`. */
export function readEngineToken(path: string = defaultTokenPath()): Buffer {
  const text = readFileSync(path, 'utf8').trim();
  if (!new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(text)) throw new Error(`Malformed engine token: ${path}`);
  return Buffer.from(text, 'hex');
}

function verifyCurrentUserOnly(path: string): void {
  const { sddl } = readFileSecurity(path);
  const trustees = allowedTrustees(sddl);
  if (trustees.length !== 1 || trustees[0] !== getCurrentUserSid() || !sddl.includes('D:P')) {
    throw new Error(`Engine token DACL is not current-user-only: ${path}`);
  }
}
