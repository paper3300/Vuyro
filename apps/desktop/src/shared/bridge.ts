/**
 * The narrow API between the renderer and the main process (기술 스택 결정 §1, §6). The renderer has no Node access;
 * the preload exposes exactly this as `window.vuyro`, and the main process forwards it to the engine pipe. Shared by
 * main and renderer, so it stays runtime-neutral (types and constants only).
 *
 * The sandboxed preload cannot import this file; it repeats the channel names, and a test keeps the two in step.
 */

export const BRIDGE_CHANNELS = {
  /** invoke: `{method, params}` → BridgeResult. */
  request: 'vuyro:request',
  /** send: `{id, afterSequence}`; events arrive on `events` as `{id, events}`. */
  subscribe: 'vuyro:subscribe',
  /** send: `{id}`. */
  unsubscribe: 'vuyro:unsubscribe',
  events: 'vuyro:events',
  /** invoke: → ConnectionState. */
  connection: 'vuyro:connection',
  /** main → renderer whenever the connection state changes. */
  connectionChanged: 'vuyro:connection-changed',
  /** invoke: ask the running engine for a UI credential (the engine shows the person a dialog). → BridgeResult. */
  pair: 'vuyro:pair',
  /** invoke: try to reach (or start) the engine now. */
  retry: 'vuyro:retry',
} as const;

/**
 * Engine methods the renderer may call. Everything that changes state is `command.execute` (the same command API as
 * the CLI and agents). Session, pairing, subscription and engine shutdown stay with the main process.
 */
export const RENDERER_METHODS = [
  'command.execute',
  'query.projects',
  'query.tickets',
  'query.ticket',
  'query.artifacts',
  'query.ticketStats',
  'query.templates',
  'query.board',
  'query.workspace',
  'query.sharedNodes',
  'events.read',
  'engine.status',
] as const;

export type RendererMethod = (typeof RENDERER_METHODS)[number];

export function isRendererMethod(method: unknown): method is RendererMethod {
  return typeof method === 'string' && (RENDERER_METHODS as readonly string[]).includes(method);
}

export interface BridgeError {
  /** A command error code (명령·이벤트 계약 §5), or `engine_offline` / `bridge_refused` from the main process. */
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export type BridgeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BridgeError };

/**
 * - `connecting`: looking for the engine; `launching`: starting one; `connected`: talking to it;
 *   `offline`: lost it, trying again; `failed`: could not start one (see `message`).
 * - `access`: `write` = a UI session (the person); `read-only` = the engine is up but does not know this app
 *   (started elsewhere, or restarted) until the person pairs.
 */
export interface ConnectionState {
  readonly phase: 'connecting' | 'launching' | 'connected' | 'offline' | 'failed';
  readonly access: 'write' | 'read-only' | 'none';
  readonly message?: string;
  /** While pairing: the code the engine's dialog shows. */
  readonly pairing?: { readonly code: string; readonly expiresAt: number };
  readonly engine?: { readonly pid: number; readonly version: string; readonly dataDir: string; readonly startedByApp: boolean };
  /** Last event sequence when the connection said hello (where a fresh screen starts its subscription). */
  readonly lastSequence?: number;
  /** Agents and scripts running now (polled). */
  readonly running?: number;
}

/** A batch of engine events for one renderer subscription (DomainEvent objects as the engine sent them). */
export interface EventsMessage {
  readonly id: string;
  readonly events: readonly { readonly sequence: number; readonly type: string; readonly aggregateId: string; readonly data: unknown; readonly [key: string]: unknown }[];
}

/** `window.vuyro`. */
export interface VuyroBridge {
  request(method: RendererMethod, params?: unknown): Promise<BridgeResult<unknown>>;
  /** Every event after `afterSequence`, in order, then live; survives engine reconnects. Returns the unsubscribe. */
  subscribe(afterSequence: number, onEvents: (events: EventsMessage['events']) => void): () => void;
  connection(): Promise<ConnectionState>;
  onConnection(listener: (state: ConnectionState) => void): () => void;
  pair(): Promise<BridgeResult<null>>;
  retry(): Promise<void>;
}
