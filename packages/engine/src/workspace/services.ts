import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Clock, systemClock } from '../runtime/clock.ts';
import type { LayoutOptions } from './layout.ts';
import { CASE_INSENSITIVE } from './paths.ts';

/**
 * What the command handlers need from the file system to decide workspace commands: where executions work, the
 * clock (claim deadlines) and file hashes (a checkout's `baseHash`). Hashes are SHA-256 computed by Vuyro itself;
 * external tools' revisions are never used.
 */
export interface WorkspaceServices {
  readonly layout: LayoutOptions;
  readonly caseInsensitive: boolean;
  readonly clock: Clock;
  /** `sha256:<hex>` of a workspace file, `null` when there is no such file. */
  hash(root: string, path: string): Promise<string | null>;
}

export async function hashFile(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error: NodeJS.ErrnoException) => {
      // Deleted between the stat and the read: it no longer exists.
      if (error.code === 'ENOENT') resolve(null);
      else reject(error);
    });
    stream.on('end', () => {
      resolve(`sha256:${hash.digest('hex')}`);
    });
  });
}

export function workspaceServices(options: { worktreeRoot?: string; clock?: Clock; caseInsensitive?: boolean } = {}): WorkspaceServices {
  return {
    layout: { worktreeRoot: options.worktreeRoot ?? join(tmpdir(), 'vuyro-worktrees') },
    caseInsensitive: options.caseInsensitive ?? CASE_INSENSITIVE,
    clock: options.clock ?? systemClock,
    hash: (root, path) => hashFile(join(root, ...path.split('/'))),
  };
}
