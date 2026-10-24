import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vuyroShims } from '@vuyro/agent-adapters';
import {
  isPrivateToCurrentUser,
  readDirectorySecurity,
  readFileSecurity,
  restrictDirectoryToCurrentUser,
  restrictFileToCurrentUser,
} from '../platform/win32/security.ts';

/** How the folder and its files are kept to the current user. Tests replace it; elsewhere than Windows it does nothing. */
export interface ShimSecurity {
  /** Whether the current user owns the folder and its DACL allows only that user. */
  directoryIsPrivate(dir: string): boolean;
  restrictDirectory(dir: string): void;
  fileIsPrivate(file: string): boolean;
  /** Restricts the file and throws unless it reads back as the current user's alone. */
  restrictFile(file: string): void;
}

export const win32ShimSecurity: ShimSecurity = {
  directoryIsPrivate: (dir) => isPrivateToCurrentUser(readDirectorySecurity(dir)),
  restrictDirectory: (dir) => {
    restrictDirectoryToCurrentUser(dir);
  },
  fileIsPrivate: (file) => isPrivateToCurrentUser(readFileSecurity(file)),
  restrictFile: (file) => {
    restrictFileToCurrentUser(file);
  },
};

/** A temporary file of `replace` left by an interrupted rewrite. */
const LEFTOVER = /^(vuyro|vuyro\.cmd)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

const noSecurity: ShimSecurity = {
  directoryIsPrivate: () => true,
  restrictDirectory: () => undefined,
  fileIsPrivate: () => true,
  restrictFile: () => undefined,
};

/**
 * The `vuyro` shims first on every agent's PATH (`vuyroShims`, [[명령·이벤트 계약]] §13). Whoever can replace them
 * runs in the next agent with its run token, so the engine checks them right before it starts each agent (`ensure`),
 * rewrites any file whose content, owner or DACL is not what it wrote, and keeps the folder and files to the current
 * user (the token file's way). The folder is first on the agent's PATH, so it must hold nothing else: any other entry
 * (a `claude.exe`, `git.exe`, a folder, a link) would run with the token too, and the engine refuses to start agents
 * until a person removes it. The folder itself must be a real folder, not a link elsewhere. Other users cannot change them; a process of the same user still could between the check
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
    const folder = lstatSync(this.dir);
    // lstat: a link (symbolic link or junction) is not a directory.
    if (!folder.isDirectory()) throw new Error(`the vuyro shim folder is not a plain folder: ${this.dir}`);
    if (!this.security.directoryIsPrivate(this.dir)) {
      this.security.restrictDirectory(this.dir);
      if (!this.security.directoryIsPrivate(this.dir)) throw new Error(`the vuyro shim folder is not the current user's alone: ${this.dir}`);
    }
    this.checkEntries();
    for (const [name, content] of this.files) {
      const file = join(this.dir, name);
      if (this.holds(file, content)) continue;
      this.replace(file, content);
      if (!this.holds(file, content)) throw new Error(`could not put the vuyro shim in place: ${file}`);
    }
    return this.dir;
  }

  /**
   * Only the shims, as plain files. Temporary files of an interrupted rewrite (`<shim>.<uuid>.tmp`, never a command
   * name) are removed; anything else stops the start.
   */
  private checkEntries(): void {
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      // A link is not a file here either (the entry's own type, not its target's).
      if (this.files.has(entry.name) && entry.isFile()) continue;
      if (LEFTOVER.test(entry.name) && entry.isFile()) {
        rmSync(join(this.dir, entry.name), { force: true });
        continue;
      }
      throw new Error(`the vuyro shim folder holds something the engine did not put there (${entry.name}); remove it from ${this.dir}`);
    }
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
