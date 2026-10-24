import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../src/workspace/git.ts';
import { tempDir } from './helpers/engine-harness.ts';
import { git, gitRepo } from './helpers/workspace-fixtures.ts';

/**
 * The engine never throws work away on its own initiative ([[결정 대기]] D-042, [[명령·이벤트 계약]] §14.9): its git
 * client deletes a branch only while it still is the commit found merged, and finds merge conflicts without touching a
 * worktree. A source check keeps destructive git arguments out of the engine.
 */

describe('the git client never throws work away', { timeout: 60_000 }, () => {
  const temps: { dispose(): void }[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) temp.dispose();
  });

  function repo(): string {
    const temp = tempDir('vuyro-git-');
    temps.push(temp);
    return gitRepo(join(temp.dir, 'repo'));
  }

  it('deletes a branch only while it still points at the commit that was checked (a new commit keeps it)', async () => {
    const dir = repo();
    const client = new GitClient();
    git(dir, 'branch', 'vuyro/t/dev-1');
    const checked = git(dir, 'rev-parse', 'vuyro/t/dev-1');
    // Someone commits on the branch after it was found merged.
    git(dir, 'checkout', '--quiet', 'vuyro/t/dev-1');
    writeFileSync(join(dir, 'late.txt'), 'late work\n');
    git(dir, 'add', 'late.txt');
    git(dir, 'commit', '--quiet', '-m', 'late');
    git(dir, 'checkout', '--quiet', 'main');
    expect(await client.deleteBranch(dir, 'vuyro/t/dev-1', checked)).toBe(false);
    expect(git(dir, 'show', 'vuyro/t/dev-1:late.txt')).toBe('late work');
    // Unchanged since the check: deleted.
    expect(await client.deleteBranch(dir, 'vuyro/t/dev-1', git(dir, 'rev-parse', 'vuyro/t/dev-1'))).toBe(true);
    expect(git(dir, 'branch', '--list', 'vuyro/t/dev-1')).toBe('');
  });

  it('predicts merge conflicts without touching the worktree or the index', async () => {
    const dir = repo();
    const client = new GitClient();
    git(dir, 'checkout', '--quiet', '-b', 'other');
    writeFileSync(join(dir, 'src', 'app.txt'), 'line 1\nline 2 other\nline 3\n');
    git(dir, 'commit', '--quiet', '-am', 'other');
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'checkout', '--quiet', '-b', 'clean');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    git(dir, 'add', 'new.txt');
    git(dir, 'commit', '--quiet', '-m', 'clean');
    git(dir, 'checkout', '--quiet', 'main');
    writeFileSync(join(dir, 'src', 'app.txt'), 'line 1\nline 2 main\nline 3\n');
    git(dir, 'commit', '--quiet', '-am', 'main');
    // A person's uncommitted edit in the worktree stays exactly as it is.
    writeFileSync(join(dir, 'README.md'), '# being edited\n');
    expect(await client.mergePreview(dir, 'other')).toEqual(['src/app.txt']);
    expect(await client.mergePreview(dir, 'clean')).toEqual([]);
    expect(git(dir, 'status', '--porcelain')).toBe('M README.md');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# being edited\n');
  });

  it('the engine source passes no destructive git arguments (only a person-confirmed removal may force)', () => {
    const source = readFileSync(new URL('../src/workspace/git.ts', import.meta.url), 'utf8');
    // Argument lists only: the strings the engine hands to git.
    const args = [...source.matchAll(/\[\s*('[^\]]*')\s*\]/g)].map((match) => match[1] ?? '').join(' ');
    for (const word of ["'reset'", "'clean'", "'stash'", "'push'", "'restore'", "'checkout'", "'--abort'", "'-D'", "'-f'", "'--hard'", "'switch'"]) {
      expect(args, word).not.toContain(word);
    }
    expect(source.match(/'--force'/g)).toHaveLength(1);
    expect(source).toContain("options.approvedByPerson === true ? ['--force'] : []");
    // Nothing else in the engine runs git itself: every call goes through the client above.
    const coordinator = readFileSync(new URL('../src/workspace/coordinator.ts', import.meta.url), 'utf8');
    expect(coordinator).not.toMatch(/git\.run\(|\.exec\(\[/);
  });
});
