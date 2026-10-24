import { execFile } from 'node:child_process';
import { resolveExecutable } from '@vuyro/agent-adapters';

/**
 * The git commands the engine runs, and nothing else ([[공유·권한·BlackBoard 설계]] §3.8, §3.9):
 * - read-only queries for change detection (`status`, `rev-parse`, `merge-base`, `diff --name-only`), with optional
 *   locks off so a query never writes the index;
 * - worktree mode only: making, merging and removing the engine's own worktrees and `vuyro/…` branches.
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

/** Environment for git: no prompts, no optional locks (status must not write the index), stable output. */
export function gitEnvironment(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    // The engine's own variables never reach git (or the hooks a repository might run).
    if (value !== undefined && !/^vuyro_/i.test(name)) env[name] = value;
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

  constructor(exec: GitExec = nodeGitExec()) {
    this.exec = exec;
  }

  async run(cwd: string, args: readonly string[], options: { allow?: readonly number[] } = {}): Promise<GitResult> {
    const result = await this.exec(args, cwd);
    if (result.code !== 0 && !(options.allow ?? []).includes(result.code)) throw new GitError(args, result);
    return result;
  }

  /** The top folder of the repository `cwd` is in, or undefined when it is not in one. */
  async topLevel(cwd: string): Promise<string | undefined> {
    const result = await this.exec(['rev-parse', '--show-toplevel'], cwd);
    return result.code === 0 ? result.stdout.trim() : undefined;
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

  /** Makes a worktree on a new branch at `start`, or on the existing branch. */
  async addWorktree(repo: string, path: string, branch: string, start: string): Promise<void> {
    if (await this.branchExists(repo, branch)) await this.run(repo, ['worktree', 'add', path, branch]);
    else await this.run(repo, ['worktree', 'add', '-b', branch, path, start]);
  }

  async removeWorktree(repo: string, path: string): Promise<void> {
    await this.run(repo, ['worktree', 'remove', '--force', path]);
  }

  async prune(repo: string): Promise<void> {
    await this.run(repo, ['worktree', 'prune']);
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.run(repo, ['branch', '-D', branch]);
  }

  /** Commits everything in a worktree (its own branch). Returns the new head, or undefined when nothing changed. */
  async commitAll(cwd: string, message: string): Promise<string | undefined> {
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

  /** Files with unresolved conflicts. */
  async unmerged(cwd: string): Promise<string[]> {
    const { stdout } = await this.run(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
    return stdout.split('\0').filter((path) => path !== '');
  }

  async mergeInProgress(cwd: string): Promise<boolean> {
    return (await this.revParse(cwd, 'MERGE_HEAD')) !== undefined;
  }

  async abortMerge(cwd: string): Promise<void> {
    await this.run(cwd, ['merge', '--abort']);
  }

  /** Concludes a merge whose conflicts were resolved (and staged by whoever resolved them). */
  async concludeMerge(cwd: string): Promise<void> {
    await this.run(cwd, ['add', '--all']);
    await this.run(cwd, [...(await this.identityArgs(cwd)), 'commit', '--no-verify', '--no-edit', '--quiet']);
  }

  /** Moves the worktree's branch to `commit` and drops local changes (the engine's own lane worktrees only). */
  async resetHard(cwd: string, commit: string): Promise<void> {
    await this.run(cwd, ['reset', '--hard', '--quiet', commit]);
    await this.run(cwd, ['clean', '-fd', '--quiet']);
  }

  async fastForward(cwd: string, ref: string): Promise<boolean> {
    const result = await this.run(cwd, ['merge', '--ff-only', '--quiet', ref], { allow: [1, 128] });
    return result.code === 0;
  }

  private async identityArgs(cwd: string): Promise<readonly string[]> {
    const known = this.identity.get(cwd);
    if (known !== undefined) return known;
    const email = await this.exec(['config', 'user.email'], cwd);
    const name = await this.exec(['config', 'user.name'], cwd);
    const args = email.code === 0 && email.stdout.trim() !== '' && name.code === 0 && name.stdout.trim() !== '' ? [] : FALLBACK_IDENTITY;
    this.identity.set(cwd, args);
    return args;
  }
}
