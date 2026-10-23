import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeProcessRunner, readLines } from '../src/index.ts';

/**
 * Real processes: the tree kill and the pipe grace period are what keep a cancelled or finished agent from
 * leaving tools behind or holding a run open. The grandchild is started by cmd.exe, not by Node, so it is in
 * no job of Node's (the case of a shell an agent CLI starts).
 */

const dir = mkdtempSync(join(tmpdir(), 'vuyro-proc-'));
const grand = join(dir, 'grand.js');
writeFileSync(grand, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);\n");
const leftovers: number[] = [];

afterAll(() => {
  for (const pid of leftovers) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startTree(killTree: boolean, name: string) {
  const pidFile = join(dir, `${name}.pid`);
  const child = nodeProcessRunner.spawn({
    command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    // Separate arguments without quotes: cmd.exe does not understand the quoting Node would add.
    args: ['/d', '/c', 'node', grand, pidFile],
    env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' },
    killTree,
  });
  return { child, pidFile };
}

describe.runIf(process.platform === 'win32')('nodeProcessRunner on Windows', () => {
  it('kill with killTree ends the grandchildren too', async () => {
    const { child, pidFile } = startTree(true, 'tree');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leftovers.push(pid);
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    const exit = await child.exited;
    expect(exit.code === null || exit.code !== 0).toBe(true);
    await waitFor(() => !alive(pid));
  }, 20_000);

  it('without killTree the grandchild outlives the child (why agents use it)', async () => {
    const { child, pidFile } = startTree(false, 'plain');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leftovers.push(pid);
    child.kill('SIGTERM');
    await child.exited;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(true);
  }, 20_000);

  it('ends a run whose grandchild holds the output pipe after the child exited', async () => {
    const pidFile = join(dir, 'holder.pid');
    // The child starts a grandchild that inherits stdout (detached, so Node's kill-on-exit job does not
    // take it down with the child), prints, and exits at once.
    const script = `require('child_process').spawn(process.execPath, [${JSON.stringify(grand)}, ${JSON.stringify(pidFile)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); console.log('child done'); process.exit(0);`;
    const started = Date.now();
    const child = nodeProcessRunner.spawn({ command: process.execPath, args: ['-e', script], env: { SystemRoot: process.env.SystemRoot ?? '' } });
    const lines: string[] = [];
    for await (const line of readLines(child.stdout)) lines.push(line);
    const exit = await child.exited;
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
    leftovers.push(Number(readFileSync(pidFile, 'utf8')));
    expect(lines).toEqual(['child done']);
    expect(exit.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});
