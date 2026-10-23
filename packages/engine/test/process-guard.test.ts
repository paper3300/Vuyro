import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@vuyro/contracts';
import { EngineClient, EngineUnavailableError } from '../src/client/engine-client.ts';
import { launchEngineDaemon } from '../src/daemon/launch.ts';
import { tempDir } from './helpers/engine-harness.ts';
import { testPipe } from './helpers/daemon-harness.ts';

/**
 * Real processes ([[초기 검증 결과]] M3): the engine's job object ends every descendant when the engine dies, and
 * the daemon starts detached, takes the app's credential from stdin, and stops on a person's request.
 */

const temp = tempDir('vuyro-guard-');
const guard = fileURLToPath(new URL('../src/platform/win32/process-guard.ts', import.meta.url)).replaceAll('\\', '/');
const leftovers: number[] = [];

afterAll(() => {
  for (const pid of leftovers) {
    try {
      process.kill(pid);
    } catch {
      // gone
    }
  }
  temp.dispose();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An "engine" that (optionally) binds its descendants, then starts a shell that starts a tool. */
async function treeOfKilledParent(bind: boolean, name: string): Promise<number> {
  const pidFile = join(temp.dir, `${name}.pid`);
  const grand = join(temp.dir, 'grand.js');
  writeFileSync(grand, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);\n");
  const script = join(temp.dir, `${name}.mjs`);
  writeFileSync(
    script,
    [
      bind ? `const { bindDescendantsToProcess } = await import('file:///${guard}'); bindDescendantsToProcess();` : '',
      "import('node:child_process').then(({ spawn }) => {",
      `  spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'node', ${JSON.stringify(grand)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore', windowsHide: true });`,
      '});',
      'setTimeout(() => {}, 60000);',
    ].join('\n'),
  );
  const parent = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  leftovers.push(pid);
  // Killed hard, like a crash: no cleanup code runs in the parent.
  parent.kill('SIGKILL');
  await new Promise<void>((resolve) => parent.once('exit', () => { resolve(); }));
  return pid;
}

describe.runIf(process.platform === 'win32')('engine process lifetime', () => {
  it('a killed engine takes the tools its agents started with it', async () => {
    const pid = await treeOfKilledParent(true, 'bound');
    await waitFor(() => !alive(pid));
  }, 30_000);

  it('without the job the tool outlives the killed engine (why the daemon binds itself)', async () => {
    const pid = await treeOfKilledParent(false, 'unbound');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(pid)).toBe(true);
  }, 30_000);

  it('launches detached with the app credential on stdin and stops on the person request', async () => {
    const dataDir = join(temp.dir, 'daemon');
    const pipePath = testPipe();
    const uiCredential = 'vuc_launch-credential-for-the-test-0123456789';
    const launched = await launchEngineDaemon({ dataDir, pipePath, uiCredential, env: { ...process.env, VUYRO_HUMAN_CREDENTIAL: 'vhc_not-for-the-engine' } });
    expect(launched.started).toBe(true);
    leftovers.push(launched.pid);
    const ui = await EngineClient.connect({ client: 'ui', dataDir, pipePath, uiCredential });
    expect(ui.hello.identity).toBe('ui');
    const status = await ui.request<{ pid: number; dataDir: string }>(RPC_METHODS.status, {});
    expect(status).toMatchObject({ pid: launched.pid, dataDir });
    // A second launch on the same data directory does not replace the running engine.
    await expect(launchEngineDaemon({ dataDir, pipePath, readyTimeoutMs: 3000 })).resolves.toMatchObject({ pid: launched.pid, started: false });
    expect((await ui.request<{ pid: number }>(RPC_METHODS.status, {})).pid).toBe(launched.pid);
    await ui.request(RPC_METHODS.shutdown, {});
    await waitFor(() => !alive(launched.pid));
    await expect(EngineClient.connect({ client: 'cli', dataDir, pipePath })).rejects.toBeInstanceOf(EngineUnavailableError);
  }, 60_000);
});
