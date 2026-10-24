import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hookCommandLine, hookCommandLineWindows } from '../src/index.ts';

/**
 * The checkout hook's command lines run in the shells that really run them ([[초기 검증 결과]] M7a): Codex runs
 * `commandWindows` through Windows PowerShell, Claude runs hook commands through Git Bash. Measured failure: a
 * PowerShell line that starts with a quoted path (Node's default folder has a space) never ran, and Codex let the
 * edit through. A stand-in CLI prints the arguments it got, from a folder with a space and a quote in its name.
 */

const root = mkdtempSync(join(tmpdir(), 'vuyro-hook-shells-'));
const folder = join(root, "it's a folder $HOME");
mkdirSync(folder, { recursive: true });
const script = join(folder, 'bin.js');
writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
const cli = { command: process.execPath, args: [script] };
const expected = ['hook', 'pretooluse', '--provider', 'codex'];

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('hook command lines in real shells', () => {
  it('Windows PowerShell runs the commandWindows line (Node under "Program Files" included)', () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', hookCommandLineWindows(cli, 'codex')], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(expected);
  });

  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((path) => existsSync(path));
  it.runIf(bash !== undefined)('Git Bash runs the POSIX line', () => {
    const out = execFileSync(bash ?? 'bash', ['-c', hookCommandLine(cli, 'codex')], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(expected);
  });

  it('a quoted path at the start is what PowerShell refused (the old line)', () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const old = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" hook`;
    expect(() => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', old], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
