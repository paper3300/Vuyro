import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../../src/shared/bridge.ts';
import { EngineConnection, type EventBatch, toBridgeError } from '../../src/main/engine-connection.ts';
import { quitForGood } from '../../src/main/tray-model.ts';
import { FakeEngine, ManualScheduler, settle } from './fake-engine.ts';

/**
 * The app's engine connection (명령·이벤트 계약 §3, §11) against a fake engine: who gets write access, starting the
 * engine with the app's credential, pairing with an engine started elsewhere, and reconnecting without losing or
 * repeating events.
 */

function setup(prepare?: (engine: FakeEngine) => void) {
  const engine = new FakeEngine();
  prepare?.(engine);
  const connector = engine.connector();
  const scheduler = new ManualScheduler();
  const errors: string[] = [];
  const connection = new EngineConnection({ connector, scheduler, backoffMs: [100, 1000], statusEveryMs: 3000, onError: (error) => errors.push(error.message) });
  const states: ConnectionState[] = [];
  connection.onState((state) => states.push(state));
  return { engine, connector, scheduler, connection, states, errors };
}

function collect(connection: EngineConnection, after = 0) {
  const seen: number[] = [];
  const off = connection.subscribe(after, (events: EventBatch) => seen.push(...events.map((event) => event.sequence)));
  return { seen, off };
}

describe('engine connection', () => {
  it('starts the engine with a fresh credential and gets write access', async () => {
    const { engine, connector, connection, states } = setup();
    await connection.start();
    expect(engine.launches).toHaveLength(1);
    const credential = engine.launches[0];
    expect(credential).toMatch(/^vuc_/);
    // The credential first (no engine), then again after the launch with the same credential.
    expect(connector.connects).toEqual([credential, credential]);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    expect(states.map((state) => state.phase)).toContain('launching');
    await settle();
    expect(connection.current.engine).toMatchObject({ pid: 1, startedByApp: true });
  });

  it('a dropped connection to a live engine comes back with the same credential, without starting another', async () => {
    const { engine, connector, scheduler, connection } = setup();
    await connection.start();
    [...engine.links][0]?.cut(new Error('pipe broken'));
    await settle();
    expect(connection.current).toMatchObject({ phase: 'offline', message: '엔진 연결이 끊겼습니다. 다시 연결합니다.' });
    await scheduler.advance(100);
    expect(engine.launches).toHaveLength(1);
    expect(connector.connects.at(-1)).toBe(engine.launches[0]);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
  });

  it('an engine started elsewhere gives read-only access until the person pairs', async () => {
    const { engine, connector, connection } = setup((fake) => {
      fake.running = true; // e.g. `vuyro engine start` in a terminal
    });
    await connection.start();
    expect(engine.launches).toEqual([]);
    expect(connector.connects).toEqual([expect.stringMatching(/^vuc_/), undefined]);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'read-only' });
    expect(connection.current.message).toMatch(/읽기 전용/);

    const states: ConnectionState[] = [];
    connection.onState((state) => states.push(state));
    const paired = await connection.pair();
    expect(paired).toEqual({ ok: true, value: null });
    // The app showed the engine dialog's code while waiting.
    expect(states.some((state) => state.pairing?.code === '4821')).toBe(true);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    expect(connection.current.pairing).toBeUndefined();
    expect(connector.connects.at(-1)).toMatch(/^vuc_paired-/);
  });

  it('a refused pairing stays read-only and says so; pairing is not offered to a writing session', async () => {
    const { engine, connection } = setup((fake) => {
      fake.running = true;
      fake.pairing = 'refuse';
    });
    await connection.start();
    const refused = await connection.pair();
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(connection.current).toMatchObject({ access: 'read-only', message: '승인되지 않았습니다. 다시 요청할 수 있습니다.' });
    expect(connection.current.pairing).toBeUndefined();

    engine.pairing = 'approve';
    expect((await connection.pair()).ok).toBe(true);
    const asked = [...engine.links][0]?.requests.filter((request) => request.method === 'auth.pair') ?? [];
    expect(await connection.pair()).toEqual({ ok: true, value: null });
    expect([...engine.links][0]?.requests.filter((request) => request.method === 'auth.pair')).toEqual(asked);
  });

  it('when another engine wins the launch race, the app falls back to read-only instead of failing', async () => {
    const { connection } = setup((fake) => {
      fake.launchRace = true;
    });
    await connection.start();
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'read-only' });
  });

  it('a lost engine is started again with the same credential and subscriptions resume where they stopped', async () => {
    const { engine, connector, scheduler, connection } = setup();
    await connection.start();
    engine.append('ticket.created');
    const { seen } = collect(connection, 0);
    await settle();
    expect(seen).toEqual([1]);
    engine.append('node.activated');
    await settle();
    expect(seen).toEqual([1, 2]);

    engine.crash();
    await settle();
    expect(connection.current).toMatchObject({ phase: 'offline', access: 'none' });
    // Written while the app was disconnected (e.g. by the CLI before the crash was noticed).
    engine.events.push({ sequence: 3, type: 'node.completed', aggregateId: 'ticket-1', aggregateType: 'ticket', data: {} });
    expect(await connection.request('query.projects', {})).toMatchObject({ ok: false, error: { code: 'engine_offline' } });

    await scheduler.advance(100);
    expect(engine.launches).toHaveLength(2);
    expect(engine.launches[1]).toBe(engine.launches[0]);
    expect(connector.connects.at(-1)).toBe(engine.launches[0]);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    engine.append('ticket.completed');
    await settle();
    // Every event once, in order, across the restart.
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('a subscription that fails to start on a live connection is tried again with backoff', async () => {
    const { engine, scheduler, connection, errors } = setup();
    await connection.start();
    engine.append('a');
    engine.failSubscriptions = 2;
    const { seen } = collect(connection, 0);
    await settle();
    expect(seen).toEqual([]);
    expect(errors).toEqual(['subscription refused']);
    await scheduler.advance(100);
    expect(seen).toEqual([]);
    await scheduler.advance(1000);
    expect(seen).toEqual([1]);
    engine.append('b');
    await settle();
    expect(seen).toEqual([1, 2]);
    expect([...engine.links][0]?.subscriptionCount).toBe(1);
  });

  it('backs off between failed attempts and reports a launch that fails', async () => {
    const { engine, scheduler, connection, errors } = setup((fake) => {
      fake.failLaunch = new Error('Node 24를 찾지 못했습니다.');
    });
    await connection.start();
    expect(connection.current).toMatchObject({ phase: 'failed', message: 'Node 24를 찾지 못했습니다.' });
    expect(errors).toEqual(['Node 24를 찾지 못했습니다.']);
    await scheduler.advance(99);
    expect(engine.launches).toHaveLength(1);
    await scheduler.advance(1);
    expect(engine.launches).toHaveLength(2);
    await scheduler.advance(999);
    expect(engine.launches).toHaveLength(2);
    engine.failLaunch = undefined;
    await scheduler.advance(1);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
  });

  it('retry tries at once instead of waiting', async () => {
    const { engine, connection } = setup((fake) => {
      fake.failLaunch = new Error('boom');
    });
    await connection.start();
    engine.failLaunch = undefined;
    await connection.retry();
    expect(connection.current.phase).toBe('connected');
  });

  it('an unsubscribed listener hears nothing more, before or after a reconnect', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    const { seen, off } = collect(connection, 0);
    engine.append('a');
    await settle();
    off();
    engine.append('b');
    engine.crash();
    await scheduler.advance(100);
    engine.append('c');
    await settle();
    expect(seen).toEqual([1]);
    expect([...engine.links].every((link) => link.subscriptionCount === 0)).toBe(true);
  });

  it('polls how many runs are going, for the tray', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    await settle();
    expect(connection.current.running).toBe(0);
    engine.runningJobs = 2;
    await scheduler.advance(3000);
    expect(connection.current.running).toBe(2);
    expect(await connection.running()).toBe(2);
  });

  it('stop ends the connection and never reconnects', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    connection.stop();
    await scheduler.advance(10_000);
    expect(engine.launches).toHaveLength(1);
    expect(engine.links.size).toBe(0);
  });

  it('shutting the engine down needs write access and does not bring it back', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    expect((await connection.shutdownEngine()).ok).toBe(true);
    await settle();
    await scheduler.advance(10_000);
    expect(engine.shutdowns).toBe(1);
    expect(engine.launches).toHaveLength(1);

    const readOnly = setup((fake) => {
      fake.running = true;
    });
    await readOnly.connection.start();
    expect(await readOnly.connection.shutdownEngine()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(readOnly.engine.running).toBe(true);
  });

  it('quitting for good: the engine closing the pipe before it answers does not bring a new engine up', async () => {
    // Race: the engine stops and drops the link before the shutdown answer arrives. The request fails, the person
    // reads "엔진을 멈추지 못했습니다" for as long as they like, and meanwhile nothing reconnects or launches.
    const { engine, connector, scheduler, connection } = setup((fake) => {
      fake.shutdownClosesFirst = true;
    });
    await connection.start();
    let dismiss: () => void = () => undefined;
    const notices: string[] = [];
    let exited = false;
    const quitting = quitForGood({
      running: () => connection.running(),
      access: () => connection.current.access,
      beginQuit: () => {
        connection.beginQuit();
      },
      confirm: () => Promise.resolve(true),
      notify: ({ message }) => {
        notices.push(message);
        return new Promise<void>((resolve) => {
          dismiss = resolve;
        });
      },
      shutdownEngine: () => connection.shutdownEngine(),
      exitApp: () => {
        exited = true;
        connection.stop();
      },
    });
    await settle();
    expect(engine.shutdowns).toBe(1);
    expect(notices).toEqual(['엔진을 멈추지 못했습니다.']);
    const connects = connector.connects.length;
    await scheduler.advance(60_000);
    expect(engine.launches).toHaveLength(1);
    expect(connector.connects).toHaveLength(connects);
    expect(engine.running).toBe(false);
    expect(connection.current).toMatchObject({ phase: 'offline', message: '종료하는 중입니다.' });
    await connection.retry();
    expect(engine.launches).toHaveLength(1);
    dismiss();
    expect(await quitting).toBe('quit-engine-kept');
    expect(exited).toBe(true);
  });

  it('a link lost after the person chose to quit stays lost, before the shutdown is even sent', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    connection.beginQuit();
    engine.crash();
    await settle();
    await scheduler.advance(60_000);
    expect(engine.launches).toHaveLength(1);
    expect(engine.running).toBe(false);
  });

  it('an engine launch still on its way when the person quits is stopped again, not left behind', async () => {
    let open: () => void = () => undefined;
    const { engine, connection } = setup((fake) => {
      fake.launchGate = new Promise<void>((resolve) => {
        open = resolve;
      });
    });
    const starting = connection.start();
    await settle();
    expect(engine.launches).toHaveLength(1);
    connection.beginQuit();
    open();
    await starting;
    // The fake engine stops on a real timer after it answers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.shutdowns).toBe(1);
    expect(engine.running).toBe(false);
    expect(engine.links.size).toBe(0);
  });

  it('an engine it started but could not reach is ended when the person quits, and nothing starts again', async () => {
    const { engine, scheduler, connection } = setup((fake) => {
      fake.connectFailures = 1;
    });
    await connection.start();
    expect(engine.launches).toHaveLength(1);
    expect(connection.current.phase).toBe('failed');
    connection.beginQuit();
    expect(engine.killed).toEqual([1]);
    expect(engine.running).toBe(false);
    await scheduler.advance(60_000);
    expect(engine.launches).toHaveLength(1);
  });

  it('quitting while that engine is still being reached: the attempt ends it once it fails', async () => {
    let open: () => void = () => undefined;
    const { engine, connection } = setup((fake) => {
      fake.launchGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      fake.connectFailures = 1;
    });
    const starting = connection.start();
    await settle();
    connection.beginQuit();
    // The attempt is under way: it, not beginQuit, decides (it may still reach the engine and stop it properly).
    expect(engine.killed).toEqual([]);
    open();
    await starting;
    expect(engine.killed).toEqual([1]);
    expect(engine.running).toBe(false);
  });

  it('an engine it started and reached later is stopped through the link, not ended', async () => {
    const { engine, scheduler, connection } = setup((fake) => {
      fake.connectFailures = 1;
    });
    await connection.start();
    await scheduler.advance(100);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
    connection.beginQuit();
    expect((await connection.shutdownEngine()).ok).toBe(true);
    expect(engine.killed).toEqual([]);
    expect(engine.shutdowns).toBe(1);
  });

  it('a person who has not quit yet still gets a lost engine back (the quit state starts with the confirmation)', async () => {
    const { engine, scheduler, connection } = setup();
    await connection.start();
    engine.crash();
    await settle();
    await scheduler.advance(100);
    expect(engine.launches).toHaveLength(2);
    expect(connection.current).toMatchObject({ phase: 'connected', access: 'write' });
  });

  it('turns engine refusals into bridge errors with their code', () => {
    expect(toBridgeError(Object.assign(new Error('x'), { data: { code: 'forbidden', message: 'no', retryable: false, details: { a: 1 } } }))).toEqual({ code: 'forbidden', message: 'no', retryable: false, details: { a: 1 } });
    expect(toBridgeError(new Error('socket hang up'))).toEqual({ code: 'internal', message: 'socket hang up', retryable: true });
  });
});
