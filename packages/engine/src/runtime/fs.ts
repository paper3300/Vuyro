import { promises as fsp } from 'node:fs';
import { posix } from 'node:path';

/**
 * File access used by the engine (definition files, worktrees, checkout scans).
 * Tests use `MemoryFileSystem`, which can also inject failures.
 */
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Creates or replaces the file. The parent directory must exist. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Replaces `to` if it exists (same as fs.rename). */
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Entry names, sorted. */
  readdir(path: string): Promise<string[]>;
}

export const nodeFileSystem: FileSystem = {
  readFile: async (path) => new Uint8Array(await fsp.readFile(path)),
  readText: (path) => fsp.readFile(path, 'utf8'),
  writeFile: (path, data) => fsp.writeFile(path, data),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (path, options) => {
    await fsp.mkdir(path, { recursive: options?.recursive ?? false });
  },
  rm: (path, options) => fsp.rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
  exists: async (path) => {
    try {
      await fsp.stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  readdir: async (path) => (await fsp.readdir(path)).sort(),
};

export type FileSystemOperation = 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'rm' | 'readdir';

export class FileSystemError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message = `${code}: ${path}`) {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
    this.path = path;
  }
}

interface InjectedFailure {
  readonly operation: FileSystemOperation;
  readonly matches: (path: string) => boolean;
  readonly error: Error;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * In-memory file system. Paths use '/' or '\' and are compared case-sensitively after normalization.
 * `failNext` makes the next matching operation throw, to test recovery paths.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['/']);
  private readonly failures: InjectedFailure[] = [];

  failNext(operation: FileSystemOperation, path?: string, error?: Error): void {
    const target = path === undefined ? undefined : normalize(path);
    this.failures.push({
      operation,
      matches: (candidate) => target === undefined || candidate === target,
      error: error ?? new FileSystemError('EIO', target ?? '*', `injected ${operation} failure`),
    });
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.op('readFile', path, (p) => {
      const data = this.files.get(p);
      if (data === undefined) throw new FileSystemError('ENOENT', p);
      return data.slice();
    });
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.op('writeFile', path, (p) => {
      this.requireDir(parentOf(p));
      if (this.dirs.has(p)) throw new FileSystemError('EISDIR', p);
      this.files.set(p, typeof data === 'string' ? encoder.encode(data) : data.slice());
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.op('rename', from, (source) => {
      const target = normalize(to);
      const data = this.files.get(source);
      if (data === undefined) throw new FileSystemError('ENOENT', source);
      this.requireDir(parentOf(target));
      this.files.delete(source);
      this.files.set(target, data);
    });
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.op('mkdir', path, (p) => {
      if (this.files.has(p)) throw new FileSystemError('EEXIST', p);
      if (this.dirs.has(p)) {
        if (options?.recursive === true) return;
        throw new FileSystemError('EEXIST', p);
      }
      const parent = parentOf(p);
      if (!this.dirs.has(parent)) {
        if (options?.recursive !== true) throw new FileSystemError('ENOENT', parent);
        this.mkdirAll(parent);
      }
      this.dirs.add(p);
    });
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return this.op('rm', path, (p) => {
      if (this.files.delete(p)) return;
      if (!this.dirs.has(p)) {
        if (options?.force === true) return;
        throw new FileSystemError('ENOENT', p);
      }
      const children = this.childrenOf(p);
      if (children.length > 0 && options?.recursive !== true) throw new FileSystemError('ENOTEMPTY', p);
      const prefix = p === '/' ? '/' : `${p}/`;
      for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file);
      for (const dir of [...this.dirs]) if (dir.startsWith(prefix)) this.dirs.delete(dir);
      if (p !== '/') this.dirs.delete(p);
    });
  }

  exists(path: string): Promise<boolean> {
    const p = normalize(path);
    return Promise.resolve(this.files.has(p) || this.dirs.has(p));
  }

  readdir(path: string): Promise<string[]> {
    return this.op('readdir', path, (p) => {
      if (!this.dirs.has(p)) throw new FileSystemError(this.files.has(p) ? 'ENOTDIR' : 'ENOENT', p);
      return this.childrenOf(p).sort();
    });
  }

  private childrenOf(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set<string>();
    for (const entry of [...this.files.keys(), ...this.dirs]) {
      if (entry !== dir && entry.startsWith(prefix)) {
        const name = entry.slice(prefix.length).split('/')[0];
        if (name !== undefined && name !== '') names.add(name);
      }
    }
    return [...names];
  }

  private mkdirAll(dir: string): void {
    if (this.dirs.has(dir)) return;
    if (this.files.has(dir)) throw new FileSystemError('ENOTDIR', dir);
    this.mkdirAll(parentOf(dir));
    this.dirs.add(dir);
  }

  private requireDir(dir: string): void {
    if (!this.dirs.has(dir)) throw new FileSystemError('ENOENT', dir);
  }

  private op<T>(operation: FileSystemOperation, path: string, action: (normalized: string) => T): Promise<T> {
    const p = normalize(path);
    const index = this.failures.findIndex((failure) => failure.operation === operation && failure.matches(p));
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      if (failure !== undefined) return Promise.reject(failure.error);
    }
    try {
      return Promise.resolve(action(p));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function normalize(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`;
  const normalized = posix.normalize(rooted);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function parentOf(path: string): string {
  return posix.dirname(path);
}
