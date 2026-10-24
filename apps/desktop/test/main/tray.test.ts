import { describe, expect, it } from 'vitest';
import type { BridgeResult, ConnectionState } from '../../src/shared/bridge.ts';
import { type QuitDeps, quitForGood, trayItems, trayTooltip } from '../../src/main/tray-model.ts';

/** The tray menu and "완전 종료" (기획 결정 2026-10-23): ask first when something runs; the engine stops with the app. */

describe('tray menu', () => {
  it('opens the window, shows the running count, quits for good', () => {
    const state: ConnectionState = { phase: 'connected', access: 'write', running: 3 };
    expect(trayItems(state)).toEqual([
      { kind: 'action', id: 'open', label: '창 열기' },
      { kind: 'info', label: '실행 중 작업: 3개' },
      { kind: 'separator' },
      { kind: 'action', id: 'quit', label: '완전 종료' },
    ]);
    expect(trayTooltip(state)).toBe('Vuyro · 실행 중 작업: 3개');
  });

  it('while quitting it says so and offers nothing else', () => {
    const state: ConnectionState = { phase: 'connected', access: 'write', running: 2, quitting: true };
    expect(trayItems(state)).toEqual([{ kind: 'info', label: '종료 중…' }]);
    expect(trayTooltip(state)).toBe('Vuyro · 종료 중…');
  });

  it('says when there is no engine to count', () => {
    expect(trayItems({ phase: 'offline', access: 'none' })[1]).toEqual({ kind: 'info', label: '엔진 연결 안 됨' });
    expect(trayItems({ phase: 'launching', access: 'none' })[1]).toEqual({ kind: 'info', label: '엔진 시작 중' });
    expect(trayItems({ phase: 'connected', access: 'read-only' })[1]).toEqual({ kind: 'info', label: '실행 중 작업: 0개' });
  });
});

function deps(options: { running: number | undefined; access: ConnectionState['access']; answer?: boolean; shutdown?: BridgeResult<unknown>; settle?: 'settled' | 'timeout' }) {
  const calls: string[] = [];
  const questions: string[] = [];
  const notices: string[] = [];
  const quit: QuitDeps = {
    running: () => {
      calls.push('running');
      return Promise.resolve(options.running);
    },
    access: () => options.access,
    beginQuit: () => {
      calls.push('beginQuit');
    },
    confirm: ({ message }) => {
      calls.push('confirm');
      questions.push(message);
      return Promise.resolve(options.answer ?? false);
    },
    notify: ({ message }) => {
      calls.push('notify');
      notices.push(message);
      return Promise.resolve();
    },
    shutdownEngine: () => {
      calls.push('shutdown');
      return Promise.resolve(options.shutdown ?? { ok: true, value: { stopping: true } });
    },
    settleConnection: () => {
      calls.push('settle');
      return Promise.resolve(options.settle ?? 'settled');
    },
    exitApp: () => {
      calls.push('exit');
    },
  };
  return { quit, calls, questions, notices };
}

describe('quitting for good', () => {
  it('nothing running: stops the engine and quits without asking', async () => {
    const { quit, calls } = deps({ running: 0, access: 'write' });
    expect(await quitForGood(quit)).toBe('quit-with-engine');
    expect(calls).toEqual(['running', 'beginQuit', 'shutdown', 'settle', 'exit']);
  });

  it('work running: asks first; "취소" leaves everything running', async () => {
    const { quit, calls, questions } = deps({ running: 2, access: 'write', answer: false });
    expect(await quitForGood(quit)).toBe('cancelled');
    // Not quitting: the connection keeps reconnecting and restarting the engine as before.
    expect(calls).toEqual(['running', 'confirm']);
    expect(questions).toEqual(['실행 중인 작업 2개가 있습니다. 완전히 종료할까요?']);
  });

  it('work running and confirmed: stops the engine, then quits', async () => {
    const { quit, calls } = deps({ running: 1, access: 'write', answer: true });
    expect(await quitForGood(quit)).toBe('quit-with-engine');
    expect(calls).toEqual(['running', 'confirm', 'beginQuit', 'shutdown', 'settle', 'exit']);
  });

  it('a read-only app cannot stop an engine started elsewhere: it says so and quits alone', async () => {
    const { quit, calls, notices } = deps({ running: 0, access: 'read-only' });
    expect(await quitForGood(quit)).toBe('quit-engine-kept');
    expect(calls).toEqual(['running', 'beginQuit', 'notify', 'settle', 'exit']);
    expect(notices).toEqual(['엔진은 계속 실행됩니다.']);
  });

  it('when it cannot tell what runs, it still asks first', async () => {
    const unknown = deps({ running: undefined, access: 'write', answer: false });
    expect(await quitForGood(unknown.quit)).toBe('cancelled');
    expect(unknown.calls).toEqual(['running', 'confirm']);
    expect(unknown.questions).toEqual(['실행 중인 작업이 있는지 확인하지 못했습니다. 완전히 종료할까요?']);
    // Confirmed: a writing app still stops the engine.
    const confirmed = deps({ running: undefined, access: 'write', answer: true });
    expect(await quitForGood(confirmed.quit)).toBe('quit-with-engine');
    expect(confirmed.calls).toEqual(['running', 'confirm', 'beginQuit', 'shutdown', 'settle', 'exit']);
    // No engine at all: confirmed, only the app quits.
    const offline = deps({ running: undefined, access: 'none', answer: true });
    expect(await quitForGood(offline.quit)).toBe('quit-engine-kept');
    expect(offline.calls).toEqual(['running', 'confirm', 'beginQuit', 'settle', 'exit']);
  });

  it('when the wait for the engine runs out, the person is told before the app exits', async () => {
    const { quit, calls, notices } = deps({ running: 0, access: 'write', settle: 'timeout' });
    expect(await quitForGood(quit)).toBe('quit-with-engine');
    expect(calls).toEqual(['running', 'beginQuit', 'shutdown', 'settle', 'notify', 'exit']);
    expect(notices).toEqual(['엔진 정리를 기다리다 시간이 지났습니다.']);
  });

  it('when the engine refuses to stop, the person is told and the app still quits', async () => {
    const { quit, calls, notices } = deps({ running: 0, access: 'write', shutdown: { ok: false, error: { code: 'forbidden', message: 'only the human', retryable: false } } });
    expect(await quitForGood(quit)).toBe('quit-engine-kept');
    expect(calls).toEqual(['running', 'beginQuit', 'shutdown', 'notify', 'settle', 'exit']);
    expect(notices).toEqual(['엔진을 멈추지 못했습니다.']);
  });
});
