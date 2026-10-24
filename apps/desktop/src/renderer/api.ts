import type { BridgeError, RendererMethod, VuyroBridge } from '../shared/bridge.ts';

/**
 * The page's only way out: `window.vuyro` from the preload. Every change goes through `command.execute`, the same
 * command API the CLI and agents use; the page never touches files or the database.
 */

declare global {
  interface Window {
    vuyro: VuyroBridge;
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export function bridge(): VuyroBridge {
  return window.vuyro;
}

export async function call<T>(method: RendererMethod, params?: unknown): Promise<T> {
  const result = await bridge().request(method, params);
  if (!result.ok) throw new ApiError(result.error);
  return result.value as T;
}

/** A fresh idempotency key per user action (명령·이벤트 계약 §2). */
export function newRequestId(): string {
  return `ui-${crypto.randomUUID()}`;
}

/** Sends a command as the person; resolves with its result. */
export async function execute<T = unknown>(type: string, payload: unknown): Promise<T> {
  const response = await call<{ result: T }>('command.execute', { requestId: newRequestId(), type, payload });
  return response.result;
}
