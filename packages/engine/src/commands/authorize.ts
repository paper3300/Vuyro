import type { Authorization, CommandDefinition } from '@vuyro/contracts';
import type { CallerContext } from './caller.ts';

/** Ticket, node and run the command acts on, taken from its payload. */
export interface CommandTarget {
  readonly ticketId?: string;
  readonly nodeId?: string;
  readonly runId?: string;
}

export type AuthorizationResult =
  | { readonly ok: true; readonly authorization: Authorization }
  | { readonly ok: false; readonly code: 'forbidden' | 'out_of_scope'; readonly reason: string };

const allow = (rule: string): AuthorizationResult => ({ ok: true, authorization: { decision: 'allow', rule: `builtin:${rule}` } });
const forbidden = (reason: string): AuthorizationResult => ({ ok: false, code: 'forbidden', reason });
const outOfScope = (reason: string): AuthorizationResult => ({ ok: false, code: 'out_of_scope', reason });

/**
 * The M1 permission boundary. Fixed rules come first and cannot be overridden by any future policy:
 *
 * 1. Permission commands: only the verified human. AI principals (agents, unverified local clients)
 *    and the engine itself are always refused.
 * 2. System-only commands: only the engine.
 * 3. Node agents (run token): only commands open to node agents, only on their own ticket and node.
 *
 * 4. Unverified local clients (engine token only) and external MCP clients are read-only.
 *
 * Everything else is allowed until the configurable policy lands (after MVP).
 */
export function authorize(type: string, definition: CommandDefinition, caller: CallerContext, target: CommandTarget): AuthorizationResult {
  const { principal } = caller;

  if (definition.category === 'permission' || type.startsWith('permission.')) {
    if (principal.kind === 'human') return allow('permission-human-only');
    if (principal.kind === 'system') return forbidden('permission rules are changed only by the human, never by the engine');
    return forbidden('AI principals can never change permission rules (fixed rule)');
  }

  if (definition.access.systemOnly === true) {
    return principal.kind === 'system' ? allow('system') : forbidden(`'${type}' is run by the engine only`);
  }

  if (caller.binding !== undefined) {
    const { binding, declared } = caller;
    if (declared.ticketId !== undefined && declared.ticketId !== binding.ticketId) {
      return outOfScope('declared ticket does not match the run token');
    }
    if (declared.nodeId !== undefined && declared.nodeId !== binding.nodeId) {
      return outOfScope('declared node does not match the run token');
    }
  }

  switch (principal.kind) {
    case 'system':
      return allow('system');
    case 'human':
      return allow('human');
    case 'unverified':
      // Without a run token or the human credential nobody knows who this is: read-only.
      return forbidden('unverified local clients are read-only: present a run token or the human credential');
    case 'agent': {
      if (principal.role === 'mcp.external') return forbidden('external MCP clients are read-only');
      if (principal.role !== 'node.agent') return allow('panel-default');
      const { binding } = caller;
      if (binding === undefined) return forbidden('node agent without a run binding');
      if (definition.access.nodeAgent !== 'own-node') return forbidden(`node agents may not run '${type}'`);
      if (target.ticketId !== binding.ticketId || target.nodeId !== binding.nodeId) {
        return outOfScope(`run token is limited to node '${binding.nodeId}' of ticket ${binding.ticketId}`);
      }
      if (target.runId !== undefined && target.runId !== binding.runId) {
        return outOfScope('run token is limited to its own run');
      }
      return allow('node-agent-own-node');
    }
  }
}
