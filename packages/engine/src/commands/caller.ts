import { type CommandError, commandError, type Principal } from '@vuyro/contracts';
import { hashRunToken, isWellFormedRunToken } from './run-token.ts';

/**
 * What the transport vouches for about a connection. The bus derives the principal from this
 * plus the run token; nothing in the request body can raise it.
 *
 * - 'internal': engine code calling the bus in-process (scheduler, adapters, recovery) → system.
 * - 'ui-session': a pipe connection that also proved the UI credential (M3: handed to the app
 *   outside the file system) → the human.
 * - 'engine-token': a pipe connection that proved only the engine token. Any process of the same
 *   OS user can read that file, agents included, so this is never treated as the human.
 */
export type TransportIdentity =
  | { readonly kind: 'internal'; readonly component: string }
  | { readonly kind: 'ui-session' }
  | { readonly kind: 'engine-token'; readonly client: 'cli' | 'mcp' | 'unknown' };

/** The node a run token is bound to. */
export interface RunBinding {
  readonly runId: string;
  readonly ticketId: string;
  readonly nodeId: string;
}

export interface CallerContext {
  readonly principal: Principal;
  readonly binding?: RunBinding;
  /** What the request said it works on (`context`). Checked against the binding during authorization. */
  readonly declared: { readonly ticketId?: string; readonly nodeId?: string };
}

export interface RunTokenRecord {
  readonly runId: string;
  readonly ticketId: string;
  readonly nodeId: string;
  readonly provider: string;
  readonly status: string;
}

export type RunTokenLookup = (tokenHash: string) => Promise<RunTokenRecord | undefined>;

export const LOCAL_USER_ID = 'local';

/**
 * Resolves the caller of one command. A run token always narrows the caller to that node's agent,
 * whatever the transport; a bad token fails instead of falling back to a wider identity.
 */
export async function resolveCaller(
  transport: TransportIdentity,
  request: { auth?: { runToken?: string }; context?: { ticketId?: string; nodeId?: string } },
  lookup: RunTokenLookup,
): Promise<{ ok: true; caller: CallerContext } | { ok: false; error: CommandError }> {
  const declared = {
    ...(request.context?.ticketId === undefined ? {} : { ticketId: request.context.ticketId }),
    ...(request.context?.nodeId === undefined ? {} : { nodeId: request.context.nodeId }),
  };
  const token = request.auth?.runToken;
  if (token !== undefined) {
    if (transport.kind === 'internal') {
      return { ok: false, error: commandError('unauthenticated', 'in-process callers do not use run tokens') };
    }
    if (!isWellFormedRunToken(token)) {
      return { ok: false, error: commandError('unauthenticated', 'malformed run token') };
    }
    const run = await lookup(hashRunToken(token));
    if (run === undefined) return { ok: false, error: commandError('unauthenticated', 'unknown run token') };
    if (run.status !== 'running') {
      return { ok: false, error: commandError('unauthenticated', `run token revoked: run ${run.runId} is ${run.status}`) };
    }
    const principal: Principal = {
      kind: 'agent',
      role: 'node.agent',
      runId: run.runId,
      ticketId: run.ticketId,
      nodeId: run.nodeId,
      ...(run.provider === 'claude' || run.provider === 'codex' ? { provider: run.provider } : {}),
    };
    return { ok: true, caller: { principal, binding: { runId: run.runId, ticketId: run.ticketId, nodeId: run.nodeId }, declared } };
  }
  switch (transport.kind) {
    case 'internal':
      return { ok: true, caller: { principal: { kind: 'system', component: transport.component }, declared } };
    case 'ui-session':
      return { ok: true, caller: { principal: { kind: 'human', userId: LOCAL_USER_ID, via: 'ui' }, declared } };
    case 'engine-token':
      if (transport.client === 'mcp') {
        return { ok: true, caller: { principal: { kind: 'agent', role: 'mcp.external' }, declared } };
      }
      return { ok: true, caller: { principal: { kind: 'unverified', client: transport.client }, declared } };
  }
}
