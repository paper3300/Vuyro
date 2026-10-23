import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { allowedTrustees, getCurrentUserSid, readFileSecurity, restrictFileToCurrentUser } from '../platform/win32/security.ts';

/**
 * The engine token: a random secret that the engine writes at startup into a
 * file only the current user can read. Clients prove they know it before any
 * command is processed (see pipe-auth.ts).
 *
 * A `VerifiedEngineToken` can only come from `createEngineToken`, which fails
 * unless the file's DACL was applied and read back as current-user-only. The
 * pipe server only accepts such a token and re-verifies the file right before
 * it listens (`reverifyEngineToken`), so it cannot run on an unverified secret.
 */

export const TOKEN_BYTES = 32;

const ISSUE = Symbol('issue');
const issued = new WeakSet<VerifiedEngineToken>();

export class VerifiedEngineToken {
  readonly path: string;
  readonly secret: Buffer;

  private constructor(path: string, secret: Buffer) {
    this.path = path;
    this.secret = secret;
    issued.add(this);
  }

  /** Module-private factory: the symbol is not exported. */
  static [ISSUE](path: string, secret: Buffer): VerifiedEngineToken {
    return new VerifiedEngineToken(path, secret);
  }
}

/** `%LOCALAPPDATA%\Vuyro\engine\engine.token` (local to this PC, not roamed). */
export function defaultTokenPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Vuyro', 'engine', 'engine.token');
}

/**
 * Writes a fresh token. The file is created empty, restricted to the current
 * user and verified before the secret is written, then moved into place
 * (a rename keeps the file's own DACL) and verified again. Any failure throws
 * and leaves no secret behind, so the engine does not start (fail closed).
 */
export function createEngineToken(path: string = defaultTokenPath()): VerifiedEngineToken {
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
    verifyFile(path, secret);
    return VerifiedEngineToken[ISSUE](path, secret);
  } catch (error) {
    rmSync(moved ? path : temporary, { force: true });
    throw error;
  }
}

/**
 * Throws unless `token` was issued by `createEngineToken` and its file is still
 * current-user-only and still holds the same secret.
 */
export function reverifyEngineToken(token: VerifiedEngineToken): void {
  if (!(token instanceof VerifiedEngineToken) || !issued.has(token)) {
    throw new Error('Not an engine token issued by createEngineToken');
  }
  verifyFile(token.path, token.secret);
}

/** Reads a token written by `createEngineToken` (client side). */
export function readEngineToken(path: string = defaultTokenPath()): Buffer {
  const text = readFileSync(path, 'utf8').trim();
  if (!new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(text)) throw new Error(`Malformed engine token: ${path}`);
  return Buffer.from(text, 'hex');
}

function verifyFile(path: string, secret: Buffer): void {
  const { sddl } = readFileSecurity(path);
  const trustees = allowedTrustees(sddl);
  if (trustees.length !== 1 || trustees[0] !== getCurrentUserSid() || !sddl.includes('D:P')) {
    throw new Error(`Engine token DACL is not current-user-only: ${path}`);
  }
  const stored = readEngineToken(path);
  if (stored.length !== secret.length || !timingSafeEqual(stored, secret)) {
    throw new Error(`Engine token file no longer holds this token: ${path}`);
  }
}
