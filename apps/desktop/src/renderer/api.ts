import type { BridgeError, PickedFolder, RendererMethod, VuyroBridge } from '../shared/bridge.ts';

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

/** The person picks a project folder in a system dialog; undefined when cancelled. The page gets a grant, not a say in the path. */
export async function pickProjectFolder(): Promise<PickedFolder | undefined> {
  const result = await bridge().pickProjectFolder();
  if (!result.ok) throw new ApiError(result.error);
  return result.value ?? undefined;
}

/** Makes a picked folder the project's folder (`project.configure`, sent by main with the granted path). */
export async function setProjectFolder(projectId: string, token: string, settings?: Record<string, unknown>): Promise<void> {
  const result = await bridge().setProjectFolder(projectId, token, settings);
  if (!result.ok) throw new ApiError(result.error);
}

/** Sends a command as the person; resolves with its result. */
export async function execute<T = unknown>(type: string, payload: unknown): Promise<T> {
  const response = await call<{ result: T }>('command.execute', { requestId: newRequestId(), type, payload });
  return response.result;
}
