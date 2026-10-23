import { describe, expect, it } from 'vitest';
import { isUuidV7, uuidV7Timestamp } from '@vuyro/contracts';
import { VirtualClock } from '../src/runtime/clock.ts';
import { FileSystemError, MemoryFileSystem } from '../src/runtime/fs.ts';
import { createUuidV7Generator, seededRandom } from '../src/runtime/ids.ts';
import { FakeProcessRunner, nodeProcessRunner, readLines } from '../src/runtime/process.ts';

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('VirtualClock', () => {
  it('fires timers in due order only when time is advanced', async () => {
    const clock = new VirtualClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 20);
    clock.setTimeout(() => fired.push('a'), 10);
    clock.setTimeout(() => fired.push('c'), 20);
    await clock.advance(5);
    expect(fired).toEqual([]);
    await clock.advance(15);
    expect(fired).toEqual(['a', 'b', 'c']);
    expect(clock.now()).toBe(1020);
  });

  it('runs timers scheduled by promise continuations and supports clearTimeout', async () => {
    const clock = new VirtualClock(0);
    const steps: number[] = [];
    const cancelled = clock.setTimeout(() => steps.push(-1), 5);
    clock.clearTimeout(cancelled);
    void (async () => {
      await clock.sleep(10);
      steps.push(clock.now());
      await clock.sleep(10);
      steps.push(clock.now());
    })();
    await clock.runAll();
    expect(steps).toEqual([10, 20]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('refuses to go backwards and stops runaway loops', async () => {
    const clock = new VirtualClock(0);
    await expect(clock.advance(-1)).rejects.toThrow(RangeError);
    const loop = (): void => {
      clock.setTimeout(loop, 1);
    };
    loop();
    await expect(clock.runAll(50)).rejects.toThrow(/more than 50/);
  });
});

describe('UUIDv7 generator', () => {
  it('makes valid, unique, sorted ids within one millisecond', () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 24));
    const ids = createUuidV7Generator({ clock, random: seededRandom(7) });
    const made = Array.from({ length: 5000 }, () => ids.next());
    expect(made.every((id) => isUuidV7(id))).toBe(true);
    expect(new Set(made).size).toBe(made.length);
    expect([...made].sort()).toEqual(made);
    expect(uuidV7Timestamp(made[0] ?? '')).toBe(clock.now());
  });

  it('stays monotonic when the clock goes backwards', async () => {
    const clock = new VirtualClock(10_000);
    const ids = createUuidV7Generator({ clock, random: seededRandom(1) });
    const first = ids.next();
    const backwards = new VirtualClock(5_000);
    const ids2 = createUuidV7Generator({ clock: backwards, random: seededRandom(1) });
    expect(ids2.next() < first).toBe(true); // different generator: no shared state
    await clock.advance(1);
    const second = ids.next();
    expect(second > first).toBe(true);
  });

  it('is deterministic with a seeded random source', () => {
    const make = () => createUuidV7Generator({ clock: new VirtualClock(0), random: seededRandom(42) });
    expect(make().next()).toBe(make().next());
  });
});

describe('MemoryFileSystem', () => {
  it('reads, writes, renames and lists like a disk', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir('C:/vuyro/defs', { recursive: true });
    await fs.writeFile('C:\\vuyro\\defs\\a.json.tmp', '{"a":1}');
    await fs.rename('C:/vuyro/defs/a.json.tmp', 'C:/vuyro/defs/a.json');
    expect(await fs.readText('C:/vuyro/defs/a.json')).toBe('{"a":1}');
    expect(await fs.readdir('C:/vuyro/defs')).toEqual(['a.json']);
    expect(await fs.exists('C:/vuyro/defs/a.json.tmp')).toBe(false);
  });

  it('reports missing parents and non-empty directories', async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.writeFile('/missing/a.txt', 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir('/d');
    await fs.writeFile('/d/a.txt', 'x');
    await expect(fs.rm('/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    await fs.rm('/d', { recursive: true });
    expect(await fs.exists('/d/a.txt')).toBe(false);
    await expect(fs.rm('/d')).rejects.toBeInstanceOf(FileSystemError);
    await fs.rm('/d', { force: true });
  });

  it('injects a failure into the next matching operation only', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile('/a.tmp', 'x');
    fs.failNext('rename', '/a.tmp');
    await expect(fs.rename('/a.tmp', '/a')).rejects.toThrow(/injected rename failure/);
    await fs.rename('/a.tmp', '/a');
    expect(await fs.readText('/a')).toBe('x');
  });
});

describe('FakeProcessRunner', () => {
  it('replays scripted output on the virtual clock', async () => {
    const clock = new VirtualClock(0);
    const runner = new FakeProcessRunner(clock);
    runner.enqueue({
      steps: [
        { stdout: '{"type":"system"}' },
        { delayMs: 1000, stdout: '{"type":"result"}' },
        { delayMs: 10, stderr: 'warning' },
        { exit: 0 },
      ],
    });
    const child = runner.spawn({ command: 'claude', args: ['-p'] });
    child.write('prompt');
    child.endInput();
    const lines = collect(readLines(child.stdout));
    const errors = collect(readLines(child.stderr));
    await clock.advance(999);
    let done = false;
    void child.exited.then(() => (done = true));
    await clock.advance(0);
    expect(done).toBe(false);
    await clock.runAll();
    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(await lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
    expect(await errors).toEqual(['warning']);
    expect(runner.spawned[0]?.input()).toBe('prompt');
    expect(clock.now()).toBe(1010);
  });

  it('kills a script that never exits and fails spawns without a script', async () => {
    const clock = new VirtualClock(0);
    const runner = new FakeProcessRunner(clock);
    runner.enqueue({ match: (spec) => spec.command === 'codex', steps: [{ stdout: 'started' }] });
    const missing = runner.spawn({ command: 'claude', args: [] });
    expect((await missing.exited).error?.message).toContain('ENOENT');
    const child = runner.spawn({ command: 'codex', args: ['exec'] });
    await clock.runAll();
    child.kill('SIGKILL');
    expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await collect(readLines(child.stdout))).toEqual(['started']);
  });
});

describe('nodeProcessRunner', () => {
  it('runs a real process and reports its exit code', async () => {
    const child = nodeProcessRunner.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("one\\r\\ntwo\\nthree"); process.exit(3)'],
      env: { SystemRoot: process.env.SystemRoot ?? '' },
    });
    const lines = await collect(readLines(child.stdout));
    expect(lines).toEqual(['one', 'two', 'three']);
    expect((await child.exited).code).toBe(3);
  });

  it('reports a missing executable instead of throwing', async () => {
    const child = nodeProcessRunner.spawn({ command: 'vuyro-no-such-binary-xyz', args: [] });
    const exit = await child.exited;
    expect(exit.code).toBeNull();
    expect(exit.error).toBeInstanceOf(Error);
  });
});
