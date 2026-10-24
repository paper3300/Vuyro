import type { AgentProvider, RunObservation } from '@vuyro/contracts';
import type { AgentSettlement } from './settle.ts';

/**
 * An adapter runs one agent CLI and turns its structured output (Claude `stream-json`,
 * Codex `exec --json`) into normalized observations. The engine's agent executor drives it:
 * it records every observation with `run.observe`, settles the run with `run.settle`, and then
 * finishes the node from what the agent reported through `vuyro node done`.
 *
 * M2 fixed this interface; M3 implements the Claude and Codex adapters behind it (`CliAgentAdapter`).
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
  /** Stop the run after this long (settles as failed, `timeout`). */
  readonly timeoutMs?: number;
  /**
   * Install the automatic checkout hook (M4): before each file edit the CLI runs `vuyro hook pretooluse`, which
   * checks the file out for this run and blocks the edit when Vuyro's ledger refuses.
   */
  readonly checkoutHook?: boolean;
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

export { AGENT_ENV } from './agent-env.ts';

export type { AgentSettlement, ProviderTerminal, SettleInput, StreamNormalizer } from './settle.ts';
export { settleRun } from './settle.ts';
export type { Clock, TimerHandle } from './clock.ts';
export { AsyncQueue, FakeProcessRunner, nodeProcessRunner, readLines } from './process.ts';
export type { FakeProcessContext, FakeScript, FakeSpawn, FakeStep, ManagedProcess, ProcessExit, ProcessRunner, SpawnSpec } from './process.ts';
export { ClaudeStreamNormalizer, claudeArgs } from './claude.ts';
export { CodexStreamNormalizer, codexArgs } from './codex.ts';
export { CliAgentAdapter, codexMcpArgs, DEFAULT_CLAUDE_ARGS, DEFAULT_CODEX_ARGS } from './cli-adapter.ts';
export type { CliAgentAdapterOptions } from './cli-adapter.ts';
export { prependPath, vuyroShims } from './cli-shims.ts';
export { agentEnvironment, envValue, ExecutableNotFoundError, resolveExecutable } from './environment.ts';
export { codexHome, codexUserHooks, codexWindowsSandbox } from './codex-home.ts';
export { CLAUDE_EDIT_TOOLS, claudeHookArgs, CODEX_EDIT_TOOLS, codexHookArgs, hookCommandLine, hookCommandLineWindows } from './hooks.ts';
export type { HookCli } from './hooks.ts';
export { clip, fitValue, LIMITS } from './limits.ts';
