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
 * A `VerifiedEngineToken` can only come from committing a `PendingEngineToken`,
 * which fails unless the file's DACL was applied and read back as
 * current-user-only. The engine replaces the token only after it holds the pipe
 * (see `startEnginePipe`), so a second start cannot cut off a running engine.
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
 * A new token whose file is ready but not yet in place: written next to the
 * final path, restricted to the current user and verified. Nothing at the final
 * path has changed yet, so a running engine keeps its token until `commit`.
 */
export class PendingEngineToken {
  readonly path: string;
  readonly temporaryPath: string;
  readonly secret: Buffer;
  #done = false;

  private constructor(path: string, temporaryPath: string, secret: Buffer) {
    this.path = path;
    this.temporaryPath = temporaryPath;
    this.secret = secret;
  }

  /** Module-private factory: the symbol is not exported. */
  static [ISSUE](path: string, temporaryPath: string, secret: Buffer): PendingEngineToken {
    return new PendingEngineToken(path, temporaryPath, secret);
  }

  /**
   * Moves the file into place (a rename keeps the file's own DACL) and verifies
   * it again. On failure nothing with this secret is left behind.
   */
  commit(): VerifiedEngineToken {
    if (this.#done) throw new Error('Engine token was already committed or discarded');
    this.#done = true;
    let moved = false;
    try {
      renameSync(this.temporaryPath, this.path);
      moved = true;
      verifyFile(this.path, this.secret);
      return VerifiedEngineToken[ISSUE](this.path, this.secret);
    } catch (error) {
      rmSync(moved ? this.path : this.temporaryPath, { force: true });
      throw error;
    }
  }

  /** Removes the temporary file; the token at the final path is untouched. */
  discard(): void {
    if (this.#done) return;
    this.#done = true;
    rmSync(this.temporaryPath, { force: true });
  }
}

/**
 * Prepares a fresh token without touching the final path: the temporary file
 * is created empty, restricted to the current user and verified before the
 * secret is written, then verified again with its content. Any failure throws
 * and leaves no secret behind (fail closed).
 */
export function prepareEngineToken(path: string = defaultTokenPath()): PendingEngineToken {
  if (process.platform !== 'win32') throw new Error('Engine tokens are only implemented for Windows');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, '', { flag: 'wx' });
  try {
    restrictFileToCurrentUser(temporary);
    const secret = randomBytes(TOKEN_BYTES);
    writeFileSync(temporary, secret.toString('hex'), { flag: 'r+' });
    verifyFile(temporary, secret);
    return PendingEngineToken[ISSUE](path, temporary, secret);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Prepares and commits a token at once (no pipe involved). */
export function createEngineToken(path: string = defaultTokenPath()): VerifiedEngineToken {
  return prepareEngineToken(path).commit();
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
