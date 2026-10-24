import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopChild } from '../src/daemon/launch.ts';

/**
 * Ending an engine the app launched but never reached goes through the spawned child's own handle: a process that
 * already exited is not signalled (its pid may belong to someone else by now).
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
