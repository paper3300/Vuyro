/** Agent CLIs that Vuyro can run as node executors. */
export const AGENT_PROVIDERS = ['claude', 'codex'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}
