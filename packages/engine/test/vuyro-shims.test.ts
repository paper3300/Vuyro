import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vuyroShims } from '@vuyro/agent-adapters';
import { enginePaths } from '../src/daemon/paths.ts';
import { type ShimSecurity, VuyroShims, win32ShimSecurity } from '../src/daemon/vuyro-shims.ts';
import { allowedTrustees, getCurrentUserSid, readFileSecurity, setFileDacl } from '../src/platform/win32/security.ts';
import { systemClock } from '../src/runtime/clock.ts';
import { FakeProcessRunner } from '../src/runtime/process.ts';
import { type DaemonHarness, oneAgentTemplate, openDaemonHarness } from './helpers/daemon-harness.ts';
import { tempDir } from './helpers/engine-harness.ts';

/**
 * The `vuyro` shims first on every agent's PATH (M7a review): whoever replaces them runs inside the next agent with
 * its run token, so the engine checks content and DACL right before each agent starts and rewrites what changed.
 */

const CLI = { command: 'C:\\node\\node.exe', args: ['C:\\app\\cli\\bin.js'] };
const EXPECTED = vuyroShims(CLI);
const disposers: (() => void)[] = [];
let h: DaemonHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dispose of disposers.splice(0)) dispose();
});

function folder(): string {
  const temp = tempDir('vuyro-shims-');
  disposers.push(temp.dispose);
  return join(temp.dir, 'bin');
}

const trustees = (path: string): string[] => allowedTrustees(readFileSecurity(path).sddl);

describe.runIf(process.platform === 'win32')('vuyro shims', () => {
  it('writes both shims, the folder and each file for the current user alone', () => {
    const dir = folder();
    expect(new VuyroShims(dir, CLI).ensure()).toBe(dir);
    expect(readdirSync(dir).sort()).toEqual(['vuyro', 'vuyro.cmd']);
    for (const [name, content] of Object.entries(EXPECTED)) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(content);
      expect(trustees(join(dir, name))).toEqual([getCurrentUserSid()]);
    }
    expect(win32ShimSecurity.directoryIsPrivate(dir)).toBe(true);
  });

  it('puts back a shim whose content was replaced, and one whose DACL was opened', () => {
    const dir = folder();
    const shims = new VuyroShims(dir, CLI);
    shims.ensure();
    writeFileSync(join(dir, 'vuyro.cmd'), '@evil.exe %*\r\n');
    setFileDacl(join(dir, 'vuyro'), `D:P(A;;FA;;;${getCurrentUserSid()})(A;;FA;;;WD)`);
    expect(trustees(join(dir, 'vuyro'))).toContain('WD');
    shims.ensure();
    expect(readFileSync(join(dir, 'vuyro.cmd'), 'utf8')).toBe(EXPECTED['vuyro.cmd']);
    expect(trustees(join(dir, 'vuyro'))).toEqual([getCurrentUserSid()]);
    expect(readdirSync(dir).sort()).toEqual(['vuyro', 'vuyro.cmd']);
  });

  it('fails closed when a file cannot be restricted, leaving neither a temporary file nor a replaced shim', () => {
    const dir = folder();
    new VuyroShims(dir, CLI).ensure();
    writeFileSync(join(dir, 'vuyro.cmd'), '@evil.exe %*\r\n');
    const failing: ShimSecurity = { ...win32ShimSecurity, restrictFile: () => { throw new Error('no WRITE_DAC'); } };
    expect(() => new VuyroShims(dir, CLI, failing).ensure()).toThrow('no WRITE_DAC');
    expect(readdirSync(dir).sort()).toEqual(['vuyro', 'vuyro.cmd']);
  });

  it('refuses a shim that is still not right after rewriting it', () => {
    const dir = folder();
    const lying: ShimSecurity = { ...win32ShimSecurity, fileIsPrivate: () => false };
    expect(() => new VuyroShims(dir, CLI, lying).ensure()).toThrow(/could not put the vuyro shim in place/);
  });

  it('the engine checks them right before it starts an agent: a replaced shim is back and first on its PATH', async () => {
    // A stand-in `claude.exe` to find on PATH; the fake runner never starts it.
    const fakeBin = folder();
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'claude.exe'), '');
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin};${savedPath ?? ''}`;
    disposers.push(() => {
      process.env.PATH = savedPath;
    });
    const runner = new FakeProcessRunner(systemClock);
    runner.enqueue({ steps: [{ exit: 0 }] });
    h = await openDaemonHarness({ vuyroCli: CLI, processRunner: runner, ...({ adapters: undefined } as object) });
    const bin = enginePaths(h.dataDir).bin;
    writeFileSync(join(bin, 'vuyro.cmd'), '@evil.exe %*\r\n');
    await h.saveDefinition(oneAgentTemplate());
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: 'shim-project', type: 'project.create', payload: { name: 'sample' } });
    await ui.execute({ requestId: 'shim-ticket', type: 'ticket.create', payload: { projectId: (project as { projectId: string }).projectId, title: 'Shims', template: { id: 'test/one-agent' } } });
    for (let attempt = 0; attempt < 500 && runner.spawned.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.spawned).toHaveLength(1);
    expect(readFileSync(join(bin, 'vuyro.cmd'), 'utf8')).toBe(EXPECTED['vuyro.cmd']);
    const env = runner.spawned[0]?.spec.env ?? {};
    const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    expect(env[pathKey]?.split(';')[0]).toBe(bin);
  }, 30_000);
});
