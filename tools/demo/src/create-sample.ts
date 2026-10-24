import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SAMPLE_FILES } from './sample-notepad.ts';

/**
 * Makes the demo's sample repository: writes the notepad files into an empty (or new) folder, then `git init` and
 * one initial commit. It never writes into a folder that already has something in it, nor inside `outside` (the
 * Vuyro repository: the sample must not land in it).
 */
export function createSampleRepository(target: string, outside: string): { readonly root: string; readonly commit: string } {
  const root = resolve(target);
  const within = relative(resolve(outside), root);
  if (!within.startsWith('..') && !isAbsolute(within)) throw new Error(`${root} is inside ${resolve(outside)}; make the sample outside it`);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} is not empty; the sample is only made in an empty folder`);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  // A fixed author so the sample does not carry whoever made it.
  git('-c', 'user.name=Sample', '-c', 'user.email=sample@example.invalid', 'add', '--all');
  git('-c', 'user.name=Sample', '-c', 'user.email=sample@example.invalid', 'commit', '--quiet', '-m', 'Initial notepad');
  return { root, commit: git('rev-parse', 'HEAD') };
}
