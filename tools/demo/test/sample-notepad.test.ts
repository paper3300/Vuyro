import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSampleRepository } from '../src/create-sample.ts';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const made: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vuyro-sample-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sample notepad repository', () => {
  it('is a git repository with one commit whose own test and build pass', () => {
    const root = join(scratch(), 'notepad');
    const { commit } = createSampleRepository(root, repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'HEAD')).toBe(commit);
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('Sample <sample@example.invalid>');
    expect(git('status', '--porcelain')).toBe('');
    execFileSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' });
    expect(execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' })).toContain('files in dist/');
    expect(existsSync(join(root, 'dist', 'index.html'))).toBe(true);
    // The build output is ignored, so the tree stays clean.
    expect(git('status', '--porcelain')).toBe('');
  }, 30_000);

  it('the build reports a syntax error compiler-style and fails', () => {
    const root = join(scratch(), 'notepad');
    createSampleRepository(root, repo);
    writeFileSync(join(root, 'src', 'broken.js'), 'export const ok = 1;\nexport const broken = ;\n');
    let stderr = '';
    try {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      stderr = (error as { stderr: string }).stderr;
    }
    // `error` as a word: what a shared build's blame reads (`SyntaxError` alone is not an error line to it).
    expect(stderr).toMatch(/^src\/broken\.js:2: error: SyntaxError/m);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  }, 30_000);

  it('refuses a folder that is not empty', () => {
    const root = scratch();
    writeFileSync(join(root, 'keep.txt'), 'mine');
    expect(() => createSampleRepository(root, repo)).toThrow(/not empty/);
  });

  it('refuses a folder inside the Vuyro repository', () => {
    expect(() => createSampleRepository(join(repo, 'tools', 'demo', 'never-made'), repo)).toThrow(/inside/);
    expect(existsSync(join(repo, 'tools', 'demo', 'never-made'))).toBe(false);
  });
});
