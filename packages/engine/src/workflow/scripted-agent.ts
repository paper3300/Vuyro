import type { AgentAdapter, AgentRunHandle, AgentSettlement, AgentStartRequest } from '@vuyro/agent-adapters';
import { AGENT_ENV } from '@vuyro/agent-adapters';
import type { AgentProvider, CommandResponse, RunObservation } from '@vuyro/contracts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { ActivityTracker } from '../runtime/activity.ts';
import type { Clock } from '../runtime/clock.ts';

/**
 * Test double for an agent CLI. Each run executes a behavior (an async function) that plays the agent:
 * it emits observations, waits on the (virtual) clock, and calls Vuyro commands the way the real agent
 * would through the `vuyro` CLI, with its run token. Engine tests use it instead of real CLIs.
 */

export interface ScriptedSession {
  readonly request: AgentStartRequest;
  /** Emits a normalized observation (message, tool call, usage, …). */
  observe(observation: RunObservation): void;
  /** Waits on the adapter's clock. Ends early when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  readonly cancelled: boolean;
  /** Sends a command as this agent (run token from the environment), like `vuyro <command>` would. */
  vuyro(type: string, payload: unknown): Promise<CommandResponse>;
}

/** Returns how the run ended; nothing = succeeded with exit code 0. Throwing = failed. */
export type ScriptedBehavior = (session: ScriptedSession) => Promise<AgentSettlement | undefined>;

export interface ScriptedAgentOptions {
  readonly provider: AgentProvider;
  readonly clock: Clock;
  readonly bus: CommandBus;
  readonly behavior: ScriptedBehavior;
  /** Counts the behavior as engine work except while it sleeps, so tests can wait for quiet. */
  readonly activity?: ActivityTracker;
}

class ObservationQueue implements AsyncIterable<RunObservation> {
  private readonly items: RunObservation[] = [];
  private waiting: ((result: IteratorResult<RunObservation>) => void) | undefined;
  private ended = false;

  push(item: RunObservation): void {
    if (this.ended) return;
    if (this.waiting === undefined) {
      this.items.push(item);
      return;
    }
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve({ value: item, done: false });
  }

  end(): void {
    this.ended = true;
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<RunObservation> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

let counter = 0;

export class ScriptedAgentAdapter implements AgentAdapter {
  readonly provider: AgentProvider;
  /** Every start request, in order (prompts, env, resume). */
  readonly started: AgentStartRequest[] = [];
  private readonly options: ScriptedAgentOptions;

  constructor(options: ScriptedAgentOptions) {
    this.provider = options.provider;
    this.options = options;
  }

  start(request: AgentStartRequest): AgentRunHandle {
    this.started.push(request);
    const { clock, bus, activity } = this.options;
    const observations = new ObservationQueue();
    let cancelled = false;
    let finished = false;
    let onCancel!: () => void;
    const cancelledSignal = new Promise<void>((resolve) => {
      onCancel = resolve;
    });
    let end = activity?.begin();
    const session: ScriptedSession = {
      request,
      observe: (observation) => {
        observations.push(observation);
      },
      sleep: async (ms) => {
        end?.();
        end = undefined;
        await Promise.race([clock.sleep(ms), cancelledSignal]);
        if (!cancelled && !finished) end = activity?.begin();
      },
      get cancelled() {
        return cancelled;
      },
      vuyro: (type, payload) => {
        counter += 1;
        const token = request.env[AGENT_ENV.runToken];
        return bus.execute(
          { requestId: `agent-${request.runId}-${counter}`, type, payload, ...(token === undefined ? {} : { auth: { runToken: token } }) },
          { kind: 'engine-token', client: 'cli' },
        );
      },
    };
    const behavior = this.options
      .behavior(session)
      .then((settlement): AgentSettlement => settlement ?? { outcome: 'succeeded', exitCode: 0, terminalReason: 'completed' })
      .catch((error: unknown): AgentSettlement => ({ outcome: 'failed', exitCode: 1, error: error instanceof Error ? error.message : String(error) }));
    const settled = Promise.race([behavior, cancelledSignal.then((): AgentSettlement => ({ outcome: 'cancelled', signal: 'SIGTERM' }))]).then(
      (settlement) => {
        finished = true;
        observations.end();
        end?.();
        end = undefined;
        return cancelled ? { outcome: 'cancelled' as const, signal: 'SIGTERM' } : settlement;
      },
    );
    return {
      observations,
      settled,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        onCancel();
      },
    };
  }
}
