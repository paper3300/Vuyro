/**
 * Shared contracts between the engine and its clients (UI, CLI, MCP, plugins).
 * Commands, events, envelopes and node declarations land here in M1.
 */

/** Version of the engine wire protocol (JSON-RPC 2.0 over NDJSON). */
export const PROTOCOL_VERSION = 1;

/** Agent CLIs that Vuyro can run as node executors. */
export const AGENT_PROVIDERS = ['claude', 'codex'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}
