import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vuyroShims } from '@vuyro/agent-adapters';
import {
  isCurrentUserOnly,
  readDirectorySecurity,
  readFileSecurity,
  restrictDirectoryToCurrentUser,
  restrictFileToCurrentUser,
} from '../platform/win32/security.ts';

/** How the folder and its files are kept to the current user. Tests replace it; elsewhere than Windows it does nothing. */
export interface ShimSecurity {
  /** Whether the folder is already the current user's alone. */
  directoryIsPrivate(dir: string): boolean;
  restrictDirectory(dir: string): void;
  fileIsPrivate(file: string): boolean;
  /** Restricts the file and throws unless it reads back as the current user's alone. */
  restrictFile(file: string): void;
}

export const win32ShimSecurity: ShimSecurity = {
  directoryIsPrivate: (dir) => isCurrentUserOnly(readDirectorySecurity(dir).sddl),
  restrictDirectory: (dir) => {
    restrictDirectoryToCurrentUser(dir);
  },
  fileIsPrivate: (file) => isCurrentUserOnly(readFileSecurity(file).sddl),
  restrictFile: (file) => {
    restrictFileToCurrentUser(file);
  },
};

const noSecurity: ShimSecurity = {
  directoryIsPrivate: () => true,
  restrictDirectory: () => undefined,
  fileIsPrivate: () => true,
  restrictFile: () => undefined,
};

/**
 * The `vuyro` shims first on every agent's PATH (`vuyroShims`, [[명령·이벤트 계약]] §13). Whoever can replace them
 * runs in the next agent with its run token, so the engine checks them right before it starts each agent (`ensure`),
 * rewrites any file whose content or DACL is not what it wrote, and keeps the folder and files to the current user
 * (the token file's way). Other users cannot change them; a process of the same user still could between the check
 * and the agent's lookup, but such a process is outside the boundary anyway (D-001: it can read the agent's memory
 * and the engine token too, [[결정 대기]] D-071).
 */
export class VuyroShims {
  readonly dir: string;
  private readonly files: ReadonlyMap<string, string>;
  private readonly security: ShimSecurity;

  constructor(dir: string, cli: { readonly command: string; readonly args: readonly string[] }, security: ShimSecurity = process.platform === 'win32' ? win32ShimSecurity : noSecurity) {
    this.dir = dir;
    this.files = new Map(Object.entries(vuyroShims(cli)));
    this.security = security;
  }

  /** Makes the folder and shims exactly what the engine wrote, and returns the folder. Throws when it cannot (fail closed). */
  ensure(): string {
    mkdirSync(this.dir, { recursive: true });
    if (!this.security.directoryIsPrivate(this.dir)) this.security.restrictDirectory(this.dir);
    for (const [name, content] of this.files) {
      const file = join(this.dir, name);
      if (this.holds(file, content)) continue;
      this.replace(file, content);
      if (!this.holds(file, content)) throw new Error(`could not put the vuyro shim in place: ${file}`);
    }
    return this.dir;
  }

  private holds(file: string, content: string): boolean {
    try {
      return readFileSync(file, 'utf8') === content && this.security.fileIsPrivate(file);
    } catch {
      return false;
    }
  }

  /** A new file restricted before it gets its content, then renamed over the old one (a rename keeps its DACL). */
  private replace(file: string, content: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, '', { flag: 'wx' });
    try {
      this.security.restrictFile(temporary);
      writeFileSync(temporary, content, { flag: 'r+' });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
