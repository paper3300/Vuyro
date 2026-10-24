import { type BridgeError, isRendererMethod, type RendererMethod } from '../shared/bridge.ts';
import { APP_ORIGIN } from './app-protocol.ts';

/**
 * Checks on what the renderer asks the main process (Electron security checklist: validate the sender and every
 * argument of IPC). The renderer is our own page, but agent output is shown in it, so a hole there must not
 * become more than what the page can already do.
 */

/** Only our app page (served from the app protocol) may use the bridge; not other frames or navigated pages. */
export function isTrustedSender(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === APP_ORIGIN || `${parsed.protocol}//${parsed.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}

const refused = (message: string): BridgeError => ({ code: 'bridge_refused', message, retryable: false });

export type CheckedRequest = { readonly ok: true; readonly method: RendererMethod; readonly params: unknown } | { readonly ok: false; readonly error: BridgeError };

/**
 * A request from the renderer: an allowed method, plain JSON params, and for commands no run token. The UI acts as
 * the person; a run token would narrow the caller to an agent, which the UI never is (and never holds a token).
 */
export function checkRendererRequest(message: unknown): CheckedRequest {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return { ok: false, error: refused('malformed request') };
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (!isRendererMethod(method)) return { ok: false, error: refused(`the window may not call '${String(method)}'`) };
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return { ok: false, error: refused('params must be an object') };
  if (method === 'command.execute') {
    const envelope = params as Record<string, unknown> | undefined;
    if (envelope === undefined) return { ok: false, error: refused('command envelope missing') };
    if ('auth' in envelope) return { ok: false, error: refused('the window does not send run tokens') };
  }
  return { ok: true, method, params };
}

/** `{id, afterSequence}` from the renderer's subscribe. */
export function checkSubscribe(message: unknown): { id: string; afterSequence: number } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { id, afterSequence } = message as { id?: unknown; afterSequence?: unknown };
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
  if (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0) return undefined;
  return { id, afterSequence };
}
