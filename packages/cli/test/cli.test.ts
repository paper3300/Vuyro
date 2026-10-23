import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../src/index.ts';

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

describe('vuyro cli', () => {
  it('prints versions', () => {
    const io = capture();
    expect(runCli(['--version'], io)).toBe(0);
    expect(io.stdout).toEqual(['vuyro 0.0.0 (protocol 1)']);
  });

  it('prints usage without a command', () => {
    const io = capture();
    expect(runCli([], io)).toBe(0);
    expect(io.stdout[0]).toMatch(/^Usage: vuyro/);
  });

  it('fails with exit code 2 on an unknown command', () => {
    const io = capture();
    expect(runCli(['nope'], io)).toBe(2);
    expect(io.stderr[0]).toMatch(/unknown command 'nope'/);
  });

  it('runs as a plain Node process', () => {
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    expect(execFileSync(process.execPath, [bin, '-v'], { encoding: 'utf8' }).trim()).toBe('vuyro 0.0.0 (protocol 1)');
  });
});
