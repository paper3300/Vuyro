import type { AgentProvider, RunObservation, RunOutcome } from '@vuyro/contracts';

/**
 * An adapter runs one agent CLI and turns its structured output (Claude `stream-json`,
 * Codex `exec --json`) into normalized observations. The engine's agent executor drives it:
 * it records every observation with `run.observe`, settles the run with `run.settle`, and then
 * finishes the node from what the agent reported through `vuyro node done`.
 *
 * M2 fixes this interface; M3 implements the Claude and Codex adapters behind it.
 */

/** What the engine hands an adapter to start one run. */
export interface AgentStartRequest {
  readonly runId: string;
  readonly provider: AgentProvider;
  readonly ticketId: string;
  readonly nodeId: string;
  readonly lane: string;
  /** Execution number of the node (ItemRef.run). */
  readonly run: number;
  readonly model?: string;
  /** The full prompt: the node's rendered template plus the reporting instructions. */
  readonly prompt: string;
  /** Working directory of the agent (the workspace; worktrees arrive in M4). */
  readonly cwd?: string;
  /**
   * Environment the agent process must get, including VUYRO_RUN_TOKEN (a secret: pass it only through
   * the environment, never on the command line or in logs), VUYRO_TICKET, VUYRO_NODE, VUYRO_LANE, VUYRO_RUN_ID.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Continue this provider session (after a pause or an engine restart). */
  readonly resume?: { readonly runId: string; readonly providerSessionId: string };
}

/** How a run ended, as the adapter saw it. */
export interface AgentSettlement {
  readonly outcome: RunOutcome;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly terminalReason?: string;
  readonly error?: string;
}

export interface AgentRunHandle {
  /** Normalized observations in output order. Ends when the process output ends. */
  readonly observations: AsyncIterable<RunObservation>;
  /** Resolves once the run is over and `observations` has ended. Never rejects. */
  readonly settled: Promise<AgentSettlement>;
  /** Stops the run (pause, superseded input). The settlement then reports `cancelled`. */
  cancel(): void;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  start(request: AgentStartRequest): AgentRunHandle;
}

export function describeAdapter(adapter: Pick<AgentAdapter, 'provider'>): string {
  return `agent-adapter:${adapter.provider}`;
}

/** Environment variable names the engine sets for node agents. */
export const AGENT_ENV = {
  runToken: 'VUYRO_RUN_TOKEN',
  ticket: 'VUYRO_TICKET',
  node: 'VUYRO_NODE',
  lane: 'VUYRO_LANE',
  runId: 'VUYRO_RUN_ID',
} as const;
