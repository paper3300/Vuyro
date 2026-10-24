import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LaunchedChild, launchEngineDaemon, stopChild } from '../src/daemon/launch.ts';

/**
 * The process a launch spawns is reached only through its own handle: a process that already exited is not signalled
 * (its pid may belong to someone else by now), and a launch that fails never leaves one behind that nobody owns.
 */
describe('stopping a launched engine', () => {
  it('ends a process that still runs, through its handle', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    expect(stopChild(child)).toBe(true);
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('does nothing to a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'exit');
    expect(stopChild(child)).toBe(false);
  });
});

describe('a launch that times out', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An "engine" that starts, writes its pid into the data folder, and never answers. */
  function silentEngine(): { entryPath: string; dataDir: string; pid: () => number } {
    dir = mkdtempSync(join(tmpdir(), 'vuyro-launch-'));
    const entryPath = join(dir, 'silent.mjs');
    writeFileSync(
      entryPath,
      "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst at = process.argv.indexOf('--data-dir');\nwriteFileSync(join(process.argv[at + 1], 'pid'), String(process.pid));\nsetTimeout(() => {}, 120000);\n",
    );
    return { entryPath, dataDir: dir, pid: () => Number(readFileSync(join(dir, 'pid'), 'utf8')) };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function gone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    return !alive(pid);
  }

  it('hands the handle over at spawn: the owner, not the launch, ends the process it left', { timeout: 30_000 }, async () => {
    const engine = silentEngine();
    let handle: LaunchedChild | undefined;
    await expect(
      launchEngineDaemon({ entryPath: engine.entryPath, dataDir: engine.dataDir, pipePath: `\\\\.\\pipe\\vuyro-silent-${String(process.pid)}-a`, readyTimeoutMs: 1500, onSpawn: (child) => (handle = child) }),
    ).rejects.toThrow('the engine did not answer in time');
    expect(handle?.pid).toBe(engine.pid());
    expect(alive(engine.pid())).toBe(true);
    expect(handle?.stop()).toBe(true);
    expect(await gone(engine.pid())).toBe(true);
    expect(handle?.stop()).toBe(false);
  });

  it('without an owner the launch ends it itself', { timeout: 30_000 }, async () => {
    const engine = silentEngine();
    await expect(
      launchEngineDaemon({ entryPath: engine.entryPath, dataDir: engine.dataDir, pipePath: `\\\\.\\pipe\\vuyro-silent-${String(process.pid)}-b`, readyTimeoutMs: 1500 }),
    ).rejects.toThrow('the engine did not answer in time');
    expect(await gone(engine.pid())).toBe(true);
  });
});
