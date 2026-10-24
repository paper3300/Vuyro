import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveExecutable } from '@vuyro/agent-adapters';

/**
 * The git commands the engine runs, and nothing else ([[공유·권한·BlackBoard 설계]] §3.8, §3.9):
 * - read-only queries for change detection (`status`, `rev-parse`, `merge-base`, `diff --name-only`, `merge-tree`),
 *   with optional locks off so a query never writes the index;
 * - worktree mode only: making, merging and removing the engine's own worktrees and `vuyro/…` branches.
 *
 * **Nothing that throws work away on the engine's own initiative** ([[결정 대기]] D-042, [[명령·이벤트 계약]] §14.9).
 * No `reset`, `clean`, `checkout -f`/`checkout --`, `restore`, `stash`, `merge --abort`, `branch -D`, `push`.
 * Every call that changes something, and why it cannot lose work:
 * - `worktree add` (`-b` new branch at a commit, or an existing branch): makes a new folder; git refuses an existing one.
 * - `worktree prune`: forgets registrations whose folder is already gone (metadata only, no file).
 * - `worktree remove` without `--force`: only after `contents` found nothing (ignored files included); git refuses a
 *   changed or untracked file anyway. With `--force` only for a person's confirmed clean-up whose fingerprint still matches.
 * - `update-ref -d <branch> <commit>`: deletes a branch only while it still is the commit found merged into the ticket
 *   branch (atomic compare-and-delete); a new commit on it makes git refuse, and the branch stays.
 * - `add --all` + `commit`: records what is there on the engine's own branch; nothing is dropped.
 * - `merge --no-ff`: only after `merge-tree` predicted no conflict, or under a policy that leaves the conflict for a
 *   person or an agent to resolve (never aborted); git refuses when it would overwrite local changes.
 * - `merge --ff-only`: moves a branch forward only; git refuses when local changes would be overwritten.
 * No shell: git is started directly with an argument list. Nothing here locks or checks out anything for the person.
 */

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git with `args` in `cwd`. Tests replace it to inject failures. */
export type GitExec = (args: readonly string[], cwd: string) => Promise<GitResult>;

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
    this.name = 'GitError';
    this.args = args;
    this.result = result;
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Variables that move where git finds the repository, its index or its objects. Inherited from whoever started the
 * engine (a terminal inside another repository, a git hook), they would point every engine git call, and the "is this a
 * repository" check, somewhere other than the folder the engine names. The engine always names the folder (`cwd`).
 */
export const GIT_LOCATION_VARIABLES: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
];

/** Environment for git: no prompts, no optional locks (status must not write the index), stable output. */
export function gitEnvironment(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const location = new Set(GIT_LOCATION_VARIABLES);
  for (const [name, value] of Object.entries(base)) {
    // The engine's own variables never reach git (or the hooks a repository might run), nor ones that relocate the repository.
    if (value !== undefined && !/^vuyro_/i.test(name) && !location.has(name.toUpperCase())) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

export function nodeGitExec(options: { readonly command?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {}): GitExec {
  const env = gitEnvironment(options.env);
  let command: string | undefined = options.command;
  return (args, cwd) =>
    new Promise((resolve) => {
      command ??= resolveExecutable('git', env);
      execFile(command, [...args], { cwd, env, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: error !== null && typeof error.code !== 'number' ? `${stderr}${error.message}` : stderr });
      });
    });
}

let defaultExec: GitExec | undefined;

/**
 * Whether `folder` is the top folder of a git working tree, asked of git itself (`rev-parse --show-toplevel`: read-only,
 * no shell). An empty or broken `.git`, a plain folder inside another repository, or no git at all is not one. The app
 * and the engine use this one rule before they allow worktree mode (D-072).
 */
export async function isRepositoryTop(folder: string, exec?: GitExec): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(folder);
  } catch {
    return false;
  }
  const result = await (exec ?? (defaultExec ??= nodeGitExec()))(['rev-parse', '--show-toplevel'], real);
  const top = result.code === 0 ? result.stdout.trim() : '';
  if (top === '') return false;
  const realTop = await realpath(top).catch(() => top);
  const key = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  return key(real) === key(realTop);
}

/** One porcelain status entry: the path (and the old path of a rename). */
export interface StatusEntry {
  readonly path: string;
  readonly code: string;
}

/** Identity for the engine's own commits when the repository has none configured. */
const FALLBACK_IDENTITY = ['-c', 'user.name=Vuyro', '-c', 'user.email=vuyro@localhost'];

export class GitClient {
  private readonly exec: GitExec;
  private readonly identity = new Map<string, readonly string[]>();
  private readonly tops = new Map<string, string | undefined>();

  constructor(exec: GitExec = nodeGitExec()) {
    this.exec = exec;
  }

  async run(cwd: string, args: readonly string[], options: { allow?: readonly number[] } = {}): Promise<GitResult> {
    const result = await this.exec(args, cwd);
    if (result.code !== 0 && !(options.allow ?? []).includes(result.code)) throw new GitError(args, result);
    return result;
  }

  /** The top folder of the repository `cwd` is in, or undefined when it is not in one. Remembered per folder. */
  async topLevel(cwd: string): Promise<string | undefined> {
    if (this.tops.has(cwd)) return this.tops.get(cwd);
    const result = await this.exec(['rev-parse', '--show-toplevel'], cwd);
    const top = result.code === 0 ? result.stdout.trim() : undefined;
    // A folder that is not a repository yet may become one; only a positive answer is kept.
    if (top !== undefined) this.tops.set(cwd, top);
    return top;
  }

  /** Read-only: changed and untracked files (no renames, so each side shows up as a path). */
  async status(cwd: string): Promise<StatusEntry[]> {
    const { stdout } = await this.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    const entries: StatusEntry[] = [];
    for (const record of stdout.split('\0')) {
      if (record.length < 4) continue;
      entries.push({ code: record.slice(0, 2), path: record.slice(3) });
    }
    return entries;
  }

  async revParse(cwd: string, ref: string): Promise<string | undefined> {
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    return (await this.revParse(cwd, `refs/heads/${branch}`)) !== undefined;
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allow: [1] });
    return result.code === 0;
  }

  /** Worktree folders git knows for the repository (absolute, as git prints them). */
  async worktrees(cwd: string): Promise<{ path: string; branch?: string }[]> {
    const { stdout } = await this.run(cwd, ['worktree', 'list', '--porcelain', '-z']);
    const list: { path: string; branch?: string }[] = [];
    let current: { path: string; branch?: string } | undefined;
    for (const field of stdout.split('\0')) {
      if (field.startsWith('worktree ')) {
        current = { path: field.slice('worktree '.length) };
        list.push(current);
      } else if (field.startsWith('branch ') && current !== undefined) {
        current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    return list;
  }

  /**
   * Makes a worktree on a new branch at `start`, or on the existing branch. A stale registration of the same folder
   * (its folder was deleted by hand) is pruned and the add tried once more.
   */
  async addWorktree(repo: string, path: string, branch: string, start: string): Promise<void> {
    const args = (await this.branchExists(repo, branch)) ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, start];
    const first = await this.exec(args, repo);
    if (first.code === 0) return;
    await this.prune(repo);
    await this.run(repo, args);
  }

  /**
   * Whether a merge is in progress in a worktree, from its git folder (no process): the `.git` file of a worktree
   * names its folder under the repository's `.git/worktrees`.
   */
  mergeInProgress(cwd: string): Promise<boolean> {
    const dir = gitDir(cwd);
    return dir === undefined ? this.revParse(cwd, 'MERGE_HEAD').then((head) => head !== undefined) : Promise.resolve(existsSync(join(dir, 'MERGE_HEAD')));
  }

  /**
   * Removes a worktree without `--force`: git refuses when it has changed or untracked files, so nothing uncommitted
   * is ever deleted (the caller checks first and keeps such worktrees, D-041). Ignored files (build output) go with it.
   */
  async removeWorktree(repo: string, path: string, options: { readonly approvedByPerson?: boolean } = {}): Promise<void> {
    this.tops.delete(path);
    // `--force` only for a person's confirmed clean-up (`worktree.cleanup`), never on the engine's own initiative.
    await this.run(repo, ['worktree', 'remove', ...(options.approvedByPerson === true ? ['--force'] : []), path]);
  }

  /**
   * Read-only: everything a worktree holds beyond its commit — changed and untracked files, and ignored files (build
   * output, local settings), each file listed. Empty lists: removing the folder loses nothing.
   */
  async contents(cwd: string): Promise<{ changed: string[]; ignored: string[] }> {
    const { stdout } = await this.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--no-renames']);
    const changed: string[] = [];
    const ignored: string[] = [];
    for (const record of stdout.split('\0')) {
      if (record.length < 4) continue;
      (record.startsWith('!!') ? ignored : changed).push(record.slice(3));
    }
    return { changed, ignored };
  }

  async prune(repo: string): Promise<void> {
    await this.run(repo, ['worktree', 'prune']);
  }

  /**
   * Deletes a branch only if it still points at `expected` (the commit the caller found merged), atomically. Returns
   * false (and keeps the branch) when it moved or anything else went wrong.
   */
  async deleteBranch(repo: string, branch: string, expected: string): Promise<boolean> {
    const result = await this.exec(['update-ref', '-d', `refs/heads/${branch}`, expected], repo);
    return result.code === 0;
  }

  /** Commits everything in a worktree (its own branch). Returns the new head, or undefined when nothing changed. */
  async commitAll(cwd: string, message: string): Promise<string | undefined> {
    if ((await this.status(cwd)).length === 0) return undefined;
    await this.run(cwd, ['add', '--all']);
    const staged = await this.run(cwd, ['diff', '--cached', '--quiet'], { allow: [1] });
    if (staged.code === 0) return undefined;
    await this.run(cwd, [...(await this.identityArgs(cwd)), 'commit', '--no-verify', '--quiet', '-m', message]);
    return this.revParse(cwd, 'HEAD');
  }

  /** Merges `branch` into the worktree's branch. Returns the conflicting files ([] = merged). */
  async merge(cwd: string, branch: string, message: string): Promise<string[]> {
    const result = await this.run(cwd, [...(await this.identityArgs(cwd)), 'merge', '--no-ff', '--no-edit', '-m', message, branch], { allow: [1] });
    if (result.code === 0) return [];
    const conflicts = await this.unmerged(cwd);
    // A failure that left no conflicts (e.g. untracked files in the way) is an error, not a conflict.
    if (conflicts.length === 0) throw new GitError(['merge', branch], result);
    return conflicts;
  }

  /**
   * Read-only: the files that would conflict if `branch` were merged into the worktree's HEAD ([] = it merges cleanly).
   * Touches no worktree and no index (`merge-tree --write-tree`, git 2.38+).
   */
  async mergePreview(cwd: string, branch: string): Promise<string[]> {
    const result = await this.run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', branch], { allow: [1] });
    if (result.code === 0) return [];
    // The first field is the tree written; the rest name the conflicting files.
    const files = result.stdout.split('\0').slice(1).filter((path) => path !== '');
    return [...new Set(files)];
  }

  /** Files with unresolved conflicts. */
  async unmerged(cwd: string): Promise<string[]> {
    const { stdout } = await this.run(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
    return stdout.split('\0').filter((path) => path !== '');
  }

  /** Concludes a merge whose conflicts were resolved (and staged by whoever resolved them). */
  async concludeMerge(cwd: string): Promise<void> {
    await this.run(cwd, ['add', '--all']);
    await this.run(cwd, [...(await this.identityArgs(cwd)), 'commit', '--no-verify', '--no-edit', '--quiet']);
  }

  async fastForward(cwd: string, ref: string): Promise<boolean> {
    const result = await this.run(cwd, ['merge', '--ff-only', '--quiet', ref], { allow: [1, 128] });
    return result.code === 0;
  }

  private async identityArgs(cwd: string): Promise<readonly string[]> {
    const known = this.identity.get(cwd);
    if (known !== undefined) return known;
    // Fails when git has no name or email to commit with (it would not guess one for us either).
    const ident = await this.exec(['var', 'GIT_COMMITTER_IDENT'], cwd);
    const args = ident.code === 0 ? [] : FALLBACK_IDENTITY;
    this.identity.set(cwd, args);
    return args;
  }
}

/** The git folder of a worktree or repository folder, read from its `.git` (no process). */
export function gitDir(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git');
  try {
    const text = readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (match?.[1] === undefined) return undefined;
    const dir = match[1].trim();
    return isAbsolute(dir) ? dir : resolve(cwd, dir);
  } catch (error) {
    // A repository's own folder: `.git` is the directory.
    return (error as NodeJS.ErrnoException).code === 'EISDIR' ? dotGit : undefined;
  }
}
