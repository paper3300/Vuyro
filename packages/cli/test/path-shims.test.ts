import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { prependPath } from '@vuyro/agent-adapters';
import { nodeFileSystem, writeVuyroShims } from '@vuyro/engine';
import { cliVersion } from '../src/index.ts';

/**
 * The `vuyro` command the engine puts first on every agent's PATH ([[초기 검증 결과]] M7a): the shells agents
 * use find it by name and it runs this CLI. Real shells, a folder with a space and a quote-free command line.
 */

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'vuyro-shims-'));
const dir = join(root, 'data with space', 'bin');
mkdirSync(dir, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The agent's environment: the shims first, then what the engine inherited (minus nothing that matters here). */
function agentEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^VUYRO_/i.test(name)) base[name] = value;
  return prependPath(base, [dir]);
}

const expected = `vuyro ${cliVersion()}`;

describe.runIf(process.platform === 'win32')('vuyro on the agent PATH', () => {
  it('writes vuyro.cmd and the Git Bash script, and nothing else', async () => {
    await writeVuyroShims(nodeFileSystem, dir, { command: process.execPath, args: [bin] });
    expect(readdirSync(dir).sort()).toEqual(['vuyro', 'vuyro.cmd']);
  });

  it('cmd finds it', () => {
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'vuyro --version'], { env: agentEnv(), encoding: 'utf8' });
    expect(out.trim()).toContain(expected);
  });

  it('PowerShell finds it', () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'vuyro --version'], { env: agentEnv(), encoding: 'utf8' });
    expect(out.trim()).toContain(expected);
  });

  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((path) => existsSync(path));
  it.runIf(bash !== undefined)('Git Bash (Claude\'s Bash tool) finds it', () => {
    const out = execFileSync(bash ?? 'bash', ['-c', 'vuyro --version'], { env: agentEnv(), encoding: 'utf8' });
    expect(out.trim()).toContain(expected);
  });

  it('keeps the rest of PATH in order, whatever the case of its name', () => {
    expect(prependPath({ Path: `C:\\a${delimiter}C:\\b` }, ['C:\\vuyro'])).toEqual({ Path: `C:\\vuyro${delimiter}C:\\a${delimiter}C:\\b` });
    expect(prependPath({ PATH: `C:\\vuyro${delimiter}C:\\a` }, ['C:\\vuyro'])).toEqual({ PATH: `C:\\vuyro${delimiter}C:\\a` });
    expect(prependPath({}, ['C:\\vuyro'])).toEqual({ PATH: 'C:\\vuyro' });
    expect(prependPath({ PATH: 'C:\\a' }, [])).toEqual({ PATH: 'C:\\a' });
  });
});
