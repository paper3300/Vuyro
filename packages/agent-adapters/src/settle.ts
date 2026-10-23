import type { RunObservation, RunOutcome } from '@vuyro/contracts';
import { clip, LIMITS } from './limits.ts';
import type { ProcessExit } from './process.ts';

/** How a run ended, as the adapter saw it. */
export interface AgentSettlement {
  readonly outcome: RunOutcome;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly terminalReason?: string;
  readonly error?: string;
}

/** The provider's own verdict from its final line (Claude `result`, Codex `turn.completed`/`turn.failed`). */
export interface ProviderTerminal {
  readonly ok: boolean;
  readonly terminalReason?: string;
  readonly error?: string;
}

/** Turns one provider's output lines into normalized observations and remembers its final verdict. */
export interface StreamNormalizer {
  stdout(line: string, observedAt: number): RunObservation[];
  stderr(line: string, observedAt: number): RunObservation[];
  /** Set once the final line arrived. A later final line (another turn) replaces it. */
  readonly terminal: ProviderTerminal | undefined;
}

export interface SettleInput {
  readonly terminal: ProviderTerminal | undefined;
  readonly exit: ProcessExit;
  /** The engine stopped the run (pause, superseded input, shutdown). */
  readonly cancelled: boolean;
  /** The adapter killed the run because it ran past its time limit. */
  readonly timedOut: boolean;
  /** The adapter killed the run because it kept running after its final line. */
  readonly lingered: boolean;
  readonly timeoutMs?: number;
  /** Last stderr lines, for the error text of an unexplained exit. */
  readonly stderrTail?: string;
}

const exitFields = (exit: ProcessExit) => ({ exitCode: exit.code, signal: exit.signal });

/**
 * Settlement rule ([[초기 검증 결과]] M0b #4): the provider's final line decides success or failure, and the
 * process exit is read with it.
 *
 * | situation | outcome |
 * |---|---|
 * | could not start | failed (`start_failed`) |
 * | killed for the time limit | failed (`timeout`) |
 * | stopped by the engine | cancelled |
 * | final line ok, exit 0 (or killed only for lingering after it) | succeeded |
 * | final line ok, other exit | failed (`exit_code`) |
 * | final line not ok | failed (provider reason), whatever the exit code |
 * | no final line (any exit code or signal) | abnormal_exit |
 */
export function settleRun(input: SettleInput): AgentSettlement {
  const { exit, terminal } = input;
  if (exit.error !== undefined) {
    return { outcome: 'failed', exitCode: null, signal: null, terminalReason: 'start_failed', error: clip(exit.error.message, LIMITS.settleError) };
  }
  if (input.timedOut) {
    const limit = input.timeoutMs === undefined ? '' : ` of ${input.timeoutMs} ms`;
    return { outcome: 'failed', ...exitFields(exit), terminalReason: 'timeout', error: `stopped after the time limit${limit}` };
  }
  if (input.cancelled) return { outcome: 'cancelled', ...exitFields(exit), ...(terminal === undefined ? {} : reason(terminal)) };
  if (terminal === undefined) {
    const tail = input.stderrTail === undefined || input.stderrTail === '' ? '' : `\n${input.stderrTail}`;
    const how = exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`;
    return { outcome: 'abnormal_exit', ...exitFields(exit), error: clip(`the process ended (${how}) without a final result line${tail}`, LIMITS.settleError) };
  }
  if (!terminal.ok) {
    return { outcome: 'failed', ...exitFields(exit), ...reason(terminal), ...(terminal.error === undefined ? {} : { error: clip(terminal.error, LIMITS.settleError) }) };
  }
  if (exit.code === 0 || input.lingered) return { outcome: 'succeeded', ...exitFields(exit), ...reason(terminal) };
  const how = exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`;
  return { outcome: 'failed', ...exitFields(exit), terminalReason: 'exit_code', error: `the process reported success but ended with ${how}` };
}

function reason(terminal: ProviderTerminal): { terminalReason?: string } {
  return terminal.terminalReason === undefined ? {} : { terminalReason: clip(terminal.terminalReason, LIMITS.terminalReason) };
}
