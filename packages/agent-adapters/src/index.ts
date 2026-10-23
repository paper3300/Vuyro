import type { AgentProvider } from '@vuyro/contracts';

/**
 * An adapter runs one agent CLI and turns its structured output
 * (Claude `stream-json`, Codex `exec --json`) into normalized events.
 * The event shape and the run API are defined in M3.
 */
export interface AgentAdapter {
  readonly provider: AgentProvider;
}

export function describeAdapter(adapter: AgentAdapter): string {
  return `agent-adapter:${adapter.provider}`;
}
