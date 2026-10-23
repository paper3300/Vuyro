import { createRequire } from 'node:module';

/**
 * Asks the person at this PC to approve a request for a human credential ([[명령·이벤트 계약]] §3 "사람 자격").
 * The approval happens outside the pipe, in front of the person, so a process that only speaks the pipe
 * (an agent using `vuyro` without its run token) cannot approve itself.
 */
export interface PairingRequest {
  readonly kind: 'ui' | 'cli';
  /** Shown both in the dialog and to the requester, so the person can tell the two belong together. */
  readonly code: string;
  readonly timeoutMs: number;
}

export interface HumanApprover {
  /** True only on an explicit yes. Errors, timeouts and anything else are a no (fail closed). */
  confirm(request: PairingRequest): Promise<boolean>;
}

/** Refuses everything: for engines nobody may pair with (and the default off Windows). */
export const denyingApprover: HumanApprover = {
  confirm: () => Promise.resolve(false),
};

const MB_YESNO = 0x4;
const MB_ICONWARNING = 0x30;
const MB_DEFBUTTON2 = 0x100;
const MB_SYSTEMMODAL = 0x1000;
const MB_SETFOREGROUND = 0x10000;
const MB_TOPMOST = 0x40000;
const IDYES = 6;

interface AsyncFunction {
  async(...args: unknown[]): void;
}

/**
 * A Windows message box shown by the engine process itself (system modal, "No" is the default button).
 * It runs on a koffi worker thread, so the engine keeps working while it is open, and closes itself after
 * the timeout (`MessageBoxTimeoutW`, exported by user32 since Windows XP though not documented).
 */
export function windowsDialogApprover(): HumanApprover {
  let messageBox: AsyncFunction | undefined;
  return {
    confirm: (request) =>
      new Promise((resolve) => {
        try {
          if (messageBox === undefined) {
            const require = createRequire(import.meta.url);
            const koffi = require('koffi') as { load(path: string): { func(definition: string): AsyncFunction } };
            messageBox = koffi
              .load('user32.dll')
              .func('int MessageBoxTimeoutW(intptr_t hwnd, const char16_t *text, const char16_t *caption, uint32_t type, uint16_t lang, uint32_t ms)');
          }
          const who = request.kind === 'ui' ? 'Vuyro 앱 창' : '터미널의 vuyro CLI (vuyro auth login)';
          const text = [
            `${who}이(가) 사람 권한을 요청했습니다.`,
            '',
            `확인 코드: ${request.code}`,
            '',
            '직접 요청한 것이 맞고, 요청한 화면에도 같은 코드가 보이면 [예]를 누르세요.',
            '요청한 적이 없다면 [아니요]를 누르세요. 에이전트가 사람 권한을 얻으려는 시도일 수 있습니다.',
          ].join('\n');
          messageBox.async(
            0,
            text,
            'Vuyro: 사람 권한 요청',
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SYSTEMMODAL | MB_SETFOREGROUND | MB_TOPMOST,
            0,
            request.timeoutMs,
            (error: unknown, result: unknown) => {
              resolve(error === null || error === undefined ? result === IDYES : false);
            },
          );
        } catch {
          resolve(false);
        }
      }),
  };
}
