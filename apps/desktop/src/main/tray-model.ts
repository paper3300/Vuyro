import type { BridgeResult, ConnectionState } from '../shared/bridge.ts';

/**
 * The tray (기술 스택 결정 §3, 기획 결정 2026-10-23): closing the window leaves the app in the tray and the work goes on.
 * The tray menu opens the window, shows how many runs are going, and quits for good, asking first when something
 * runs. Electron-free so tests can check the menu and the quit flow.
 */

export type TrayItem =
  | { readonly kind: 'action'; readonly id: 'open' | 'quit'; readonly label: string }
  | { readonly kind: 'info'; readonly label: string }
  | { readonly kind: 'separator' };

export function trayItems(state: ConnectionState): TrayItem[] {
  return [
    { kind: 'action', id: 'open', label: '창 열기' },
    { kind: 'info', label: runningLabel(state) },
    { kind: 'separator' },
    { kind: 'action', id: 'quit', label: '완전 종료' },
  ];
}

export function runningLabel(state: ConnectionState): string {
  if (state.phase !== 'connected') return state.phase === 'launching' ? '엔진 시작 중' : '엔진 연결 안 됨';
  return `실행 중 작업: ${state.running ?? 0}개`;
}

export function trayTooltip(state: ConnectionState): string {
  return `Vuyro · ${runningLabel(state)}`;
}

export interface QuitDeps {
  /** A fresh count of running agents and scripts; undefined when the engine cannot be asked. */
  running(): Promise<number | undefined>;
  access(): ConnectionState['access'];
  /** Shows the person the question; true = quit. */
  confirm(question: { readonly message: string; readonly detail: string }): Promise<boolean>;
  /** Tells the person something (no answer needed). */
  notify(message: { readonly message: string; readonly detail: string }): Promise<void>;
  shutdownEngine(): Promise<BridgeResult<unknown>>;
  exitApp(): void;
}

export type QuitOutcome = 'cancelled' | 'quit-with-engine' | 'quit-engine-kept';

/**
 * "완전 종료": the app and the engine both stop. Running agents are cancelled; the engine records them and they queue
 * again the next time it starts (명령·이벤트 계약 §11 "멈추기"). With work running the person confirms first.
 * When the engine cannot be stopped from here (no UI session, or no engine), only the app quits and the person is told.
 */
export async function quitForGood(deps: QuitDeps): Promise<QuitOutcome> {
  const running = await deps.running();
  if (running !== undefined && running > 0) {
    const ok = await deps.confirm({
      message: `실행 중인 작업 ${running}개가 있습니다. 완전히 종료할까요?`,
      detail: '엔진도 함께 멈춥니다. 실행 중이던 에이전트는 취소되고, 다음에 Vuyro를 시작하면 다시 줄을 섭니다.',
    });
    if (!ok) return 'cancelled';
  }
  if (deps.access() !== 'write') {
    if (running !== undefined) {
      await deps.notify({
        message: '엔진은 계속 실행됩니다.',
        detail: '이 앱은 엔진을 멈출 권한이 없습니다(다른 곳에서 시작한 엔진). 터미널에서 `vuyro engine stop`으로 멈출 수 있습니다.',
      });
    }
    deps.exitApp();
    return 'quit-engine-kept';
  }
  const stopped = await deps.shutdownEngine();
  if (!stopped.ok) {
    await deps.notify({ message: '엔진을 멈추지 못했습니다.', detail: `${stopped.error.message} 앱만 종료합니다.` });
    deps.exitApp();
    return 'quit-engine-kept';
  }
  deps.exitApp();
  return 'quit-with-engine';
}
