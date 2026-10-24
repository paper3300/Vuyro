import { createHash } from 'node:crypto';
import { AGENT_ENV, type AgentAdapter, type AgentRunHandle, type AgentSettlement } from '@vuyro/agent-adapters';
import {
  type AgentProvider,
  type CommandResponse,
  type CommandType,
  type DomainEvent,
} from '@vuyro/contracts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { TransportIdentity } from '../commands/caller.ts';
import { settleOrphanedRuns } from '../commands/recovery.ts';
import { ActivityTracker } from '../runtime/activity.ts';
import type { Clock } from '../runtime/clock.ts';
import type { ProcessRunner } from '../runtime/process.ts';
import type { EventStore } from '../store/event-store.ts';
import { type MergeAgentRequest, type Prepared, WorkspaceCoordinator } from '../workspace/coordinator.ts';
import { GitClient } from '../workspace/git.ts';
import type { WorkspaceServices } from '../workspace/services.ts';
import { mergingJoins } from '../workspace/settings.ts';
import type { FileWatcher } from '../workspace/watcher.ts';
import type { FileSystem } from '../runtime/fs.ts';
import { SharedNodeScheduler } from '../shared/scheduler.ts';
import { type CompiledNode, type CompiledWorkflow, SHARED_NODE_PARAM } from './compile.ts';
import { executionContext } from './context.ts';
import type { DefinitionResolver } from './definitions.ts';
import { agentPrompt } from './prompt.ts';
import { resolveScript, startScript } from './script-runner.ts';
import { currentExecution, EMPTY_TICKET, evolveTicket, type Execution, nodeProgress, type TicketWorkflow } from './state.ts';

export interface WorkflowEngineOptions {
  readonly bus: CommandBus;
  readonly store: EventStore;
  readonly definitions: DefinitionResolver;
  readonly clock: Clock;
  readonly adapters: Partial<Record<AgentProvider, AgentAdapter>>;
  readonly processRunner: ProcessRunner;
  /** Agents and scripts running at the same time, over all tickets. Default 4. Others wait as Queued. */
  readonly maxConcurrent?: number;
  readonly activity?: ActivityTracker;
  /**
   * Base environment for script nodes. Default: PATH, SystemRoot, TEMP/TMP, HOME/USERPROFILE from the engine.
   * Nothing else is inherited, so engine secrets never reach a script.
   */
  readonly scriptEnv?: Readonly<Record<string, string>>;
  /**
   * Working directory of one execution (M4: the shared folder, or a worktree per ticket or per node run).
   * Undefined = the process default.
   */
  readonly workspace?: (target: WorkspaceTarget) => string | undefined;
  /** Time limit of one agent run (the adapter stops it and it settles as failed, `timeout`). Default none. */
  readonly agentTimeoutMs?: number;
  /**
   * Extra environment for agents, e.g. where the engine listens (`VUYRO_PIPE`, `VUYRO_DATA_DIR`) so the agent's
   * `vuyro` calls reach this engine. The run variables (token, ticket, node, lane, run id) always win.
   */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /**
   * Workspace layout, clock and hashes (M4). Pass the bus's (`bus.workspaces`, the default) so both agree on where
   * executions work.
   */
  readonly workspaces?: WorkspaceServices;
  /** Git for worktrees, merges and read-only status. Default: git on PATH, no shell. */
  readonly git?: GitClient;
  /** Watches spaces while executions run (candidates for change detection). Default none: scans at start and finish. */
  readonly watcher?: FileWatcher;
  /** The user's Codex folder, read for the checkout hook's safety check. Default `CODEX_HOME`, else `~/.codex`. */
  readonly codexHome?: string;
  /** Where shared nodes write each batch's output (M5). Default: not written (the tickets get its tail). */
  readonly sharedLogs?: { readonly dir: string; readonly fs: FileSystem };
  readonly reportError?: (error: Error, context: string) => void;
}

/** Which execution needs a working directory. `run` is the node's execution number (ItemRef.run). */
export interface WorkspaceTarget {
  readonly ticketId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly attempt: number;
}

interface LiveExecution {
  readonly ticketId: string;
  /**
   * Ticket revision the launch was decided from. Part of the start request id: a lane that paused for a claim and
   * was resumed starts again with the same run and attempt, and must not get the stored "blocked" answer back.
   */
  readonly revision: number;
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly kind: 'agent' | 'script' | 'merge';
  cancel?: () => void;
  cancelled: boolean;
}

const SYSTEM: TransportIdentity = { kind: 'internal', component: 'workflow' };
const INHERITED_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];

function defaultScriptEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Deterministic request ids: a retried step after a crash is the same command (idempotent). */
function requestId(step: string, ...parts: (string | number)[]): string {
  return `wf-${step}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
}

function keyOf(ticketId: string, nodeId: string, lane: string, run: number): string {
  return `${ticketId}/${nodeId}/${lane}/${run}`;
}

/**
 * Runs tickets: watches the event log, starts queued executions (agents through their adapter, scripts
 * through the process runner) within the concurrency limit, and reports their results with `node.finish`.
 * It decides nothing itself: every state change is a command on the bus (as the `workflow` system component),
 * and the routing happens inside those commands.
 */
export class WorkflowEngine {
  readonly activity: ActivityTracker;
  /** The engine's file and git work for workspaces (M4). */
  readonly workspaces: WorkspaceCoordinator;
  /** Shared nodes' batches (M5). */
  readonly shared: SharedNodeScheduler;
  private readonly options: WorkflowEngineOptions;
  private readonly maxConcurrent: number;
  private readonly scriptEnv: Readonly<Record<string, string>>;
  private readonly live = new Map<string, LiveExecution>();
  private readonly tickets = new Map<string, { revision: number; state: TicketWorkflow }>();
  private readonly scheduled = new Set<string>();
  /** Requests known to be in their shared node's queue (or batch), so ticks do not ask again. */
  private readonly enqueued = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(options: WorkflowEngineOptions) {
    this.options = options;
    this.activity = options.activity ?? new ActivityTracker();
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.scriptEnv = options.scriptEnv ?? defaultScriptEnv();
    this.workspaces = new WorkspaceCoordinator({
      bus: options.bus,
      store: options.store,
      definitions: options.definitions,
      services: options.workspaces ?? options.bus.workspaces,
      git: options.git ?? new GitClient(),
      activity: this.activity,
      ...(options.watcher === undefined ? {} : { watcher: options.watcher }),
      ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      resolveConflicts: (request) => this.resolveConflicts(request),
      reportError: (error, context) => {
        this.report(error, context);
      },
    });
    this.shared = new SharedNodeScheduler({
      bus: options.bus,
      store: options.store,
      definitions: options.definitions,
      clock: options.clock,
      processRunner: options.processRunner,
      activity: this.activity,
      scriptEnv: this.scriptEnv,
      ...(options.sharedLogs === undefined ? {} : { logs: options.sharedLogs }),
      reportError: (error, context) => {
        this.report(error, context);
      },
    });
  }

  /** Settles runs orphaned by a previous engine, then picks up every ticket with work left. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe ??= this.options.store.subscribe((events) => {
      this.onEvents(events);
      this.workspaces.onEvents(events);
      this.shared.onEvents(events);
    });
    await this.activity.track(async () => {
      await settleOrphanedRuns(this.options.bus, this.options.store);
      // Entries of executions that ended while the engine was down go; spaces are checked for unwatched changes.
      await this.workspaces.recover();
      // Batches that ran when the engine stopped are interrupted; the queues go on.
      await this.shared.start();
      await this.scheduleWaiting(true);
    });
  }

  /** Stops scheduling. Running executors are cancelled when `cancelRunning` is set. */
  stop(options: { cancelRunning?: boolean } = {}): void {
    this.stopped = true;
    this.workspaces.stop();
    this.shared.stop(options);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (options.cancelRunning === true) for (const live of this.live.values()) this.cancel(live);
  }

  /** Executions and shared-node batches running in this process right now. */
  get running(): number {
    return this.live.size + this.shared.running;
  }

  idle(): Promise<void> {
    return this.activity.idle();
  }

  // -------------------------------------------------------------------------

  private onEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      if (event.aggregateType === 'ticket' && (event.type.startsWith('node.') || event.type === 'ticket.created')) this.schedule(event.aggregateId);
    }
  }

  private schedule(ticketId: string): void {
    if (this.stopped || this.scheduled.has(ticketId)) return;
    this.scheduled.add(ticketId);
    const done = this.activity.begin();
    this.chain = this.chain
      .then(async () => {
        this.scheduled.delete(ticketId);
        await this.tick(ticketId);
      })
      .catch((error: unknown) => {
        this.report(error, `scheduling ticket ${ticketId}`);
      })
      .finally(done);
  }

  /** Schedules tickets that have executions waiting for a slot (or, at start, anything unfinished). */
  private async scheduleWaiting(includeRunning = false): Promise<void> {
    const statuses = includeRunning ? "('queued', 'rejected', 'running')" : "('queued', 'rejected')";
    const rows = await this.options.store.query<{ ticket_id: string }>(
      `SELECT ticket_id, MIN(updated_at) AS since FROM p_node_lanes WHERE status IN ${statuses} GROUP BY ticket_id ORDER BY since`,
    );
    for (const row of rows) this.schedule(row.ticket_id);
  }

  private async ticket(ticketId: string): Promise<TicketWorkflow> {
    const cached = this.tickets.get(ticketId);
    let revision = cached?.revision ?? 0;
    let state = cached?.state ?? EMPTY_TICKET;
    for (const event of await this.options.store.readAggregate(ticketId, revision)) {
      state = evolveTicket(state, event);
      revision = event.revision;
    }
    this.tickets.set(ticketId, { revision, state });
    return state;
  }

  private async tick(ticketId: string): Promise<void> {
    if (this.stopped) return;
    const state = await this.ticket(ticketId);
    // Cancel what no longer matters: superseded executions and lanes a person asked to pause.
    for (const live of this.live.values()) {
      if (live.ticketId !== ticketId || live.cancelled) continue;
      const current = currentExecution(state, live.nodeId, live.lane);
      const exec = nodeProgress(state, live.nodeId).executions[live.run - 1];
      if (current?.run !== live.run || exec?.status === 'superseded' || exec?.pauseRequested === true) this.cancel(live);
    }
    // A ticket that needs attention (events in a retired format) is not resumed (fail closed).
    if (state.template === undefined || state.status !== 'open' || state.attention !== undefined) return;
    let workflow: CompiledWorkflow;
    try {
      workflow = await this.options.definitions.workflow(state.template);
    } catch (error) {
      this.report(error, `loading the workflow of ticket ${ticketId}`);
      return;
    }
    // Request nodes (M5): a queued request joins its shared node's queue; the batch decides when it runs.
    for (const node of workflow.nodes.values()) {
      if (node.completion === 'shared') await this.enqueueRequests(ticketId, state, node);
    }
    const merging = mergingJoins(state, workflow);
    for (const node of workflow.nodes.values()) {
      if (node.completion !== 'agent' && node.completion !== 'script' && !merging.has(node.id)) continue;
      for (const lane of nodeProgress(state, node.id).laneOrder) {
        const exec = currentExecution(state, node.id, lane);
        if (exec === undefined) continue;
        const key = keyOf(ticketId, node.id, lane, exec.run);
        if (exec.status === 'running' && !this.live.has(key)) {
          if (exec.executor === 'merge') this.launch(ticketId, state, workflow, node, exec, true);
          else await this.reconcile(ticketId, node, exec);
        } else if ((exec.status === 'queued' || exec.status === 'rejected') && !this.live.has(key) && this.live.size < this.maxConcurrent) {
          this.launch(ticketId, state, workflow, node, exec);
        }
      }
    }
  }

  private async enqueueRequests(ticketId: string, state: TicketWorkflow, node: CompiledNode): Promise<void> {
    const revision = this.tickets.get(ticketId)?.revision ?? 0;
    for (const lane of nodeProgress(state, node.id).laneOrder) {
      const exec = currentExecution(state, node.id, lane);
      if (exec?.status !== 'queued') continue;
      const key = keyOf(ticketId, node.id, lane, exec.run);
      if (this.enqueued.has(key)) continue;
      const payload = { projectId: state.projectId, name: node.params[SHARED_NODE_PARAM], ticketId, nodeId: node.id, lane, run: exec.run };
      // The revision is part of the id: a request that was not queued yet (paused) is asked again once it is.
      const response = await this.command('shared-enqueue', 'sharedNode.enqueue', payload, ticketId, node.id, lane, exec.run, revision);
      if (response.ok && (response.result as { queued: boolean }).queued) this.enqueued.add(key);
    }
  }

  /** A running execution with no executor in this process: the engine restarted while it ran. */
  private async reconcile(ticketId: string, node: CompiledNode, exec: Execution): Promise<void> {
    const fields = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt: exec.attempts };
    if (exec.executor === 'agent') {
      const runId = exec.runIds.at(-1);
      if (runId === undefined) return;
      const row = await this.options.store.queryOne<{ status: string }>('SELECT status FROM p_runs WHERE run_id = ?', [runId]);
      if (row?.status === 'running') {
        await this.command('settle', 'run.settle', { runId, outcome: 'abnormal_exit', terminalReason: 'engine_restarted', error: 'no executor for this run' }, runId);
      }
      await this.command('finish', 'node.finish', { ...fields, result: { kind: 'agent', runId } }, runId);
      return;
    }
    await this.command('finish', 'node.finish', {
      ...fields,
      result: { kind: 'script', exitCode: null, error: 'the engine restarted while the script was running' },
    }, ticketId, node.id, exec.lane, exec.run, exec.attempts);
  }

  private launch(ticketId: string, state: TicketWorkflow, workflow: CompiledWorkflow, node: CompiledNode, exec: Execution, resumeMerge = false): void {
    const live: LiveExecution = {
      ticketId,
      revision: this.tickets.get(ticketId)?.revision ?? 0,
      nodeId: node.id,
      lane: exec.lane,
      run: exec.run,
      kind: node.completion === 'agent' ? 'agent' : node.completion === 'script' ? 'script' : 'merge',
      cancelled: false,
    };
    const key = keyOf(ticketId, node.id, exec.lane, exec.run);
    this.live.set(key, live);
    const done = this.activity.begin();
    const work =
      live.kind === 'agent'
        ? this.runAgent(state, workflow, node, exec, live, done)
        : live.kind === 'script'
          ? this.runScript(state, workflow, node, exec, live, done)
          : this.runMerge(state, workflow, node, exec, live, resumeMerge, done);
    void work
      .catch((error: unknown) => {
        this.report(error, `running ${node.id} lane ${exec.lane} of ticket ${ticketId}`);
      })
      .finally(() => {
        done();
        this.live.delete(key);
        if (!this.stopped) {
          this.schedule(ticketId);
          void this.activity.track(() => this.scheduleWaiting()).catch((error: unknown) => {
            this.report(error, 'scheduling waiting tickets');
          });
        }
      });
  }

  private async runAgent(
    state: TicketWorkflow,
    workflow: CompiledWorkflow,
    node: CompiledNode,
    exec: Execution,
    live: LiveExecution,
    endSpan: () => void,
  ): Promise<void> {
    const ticketId = live.ticketId;
    const attempt = exec.attempts + 1;
    const fields = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt };
    const started = await this.command('start', 'node.start', fields, ticketId, node.id, exec.lane, exec.run, attempt, live.revision);
    if (!started.ok) return;
    const { runId, runToken, blocked } = started.result as { runId?: string; runToken?: string; blocked?: string };
    // Its claims conflict: the lane paused (or failed) instead of starting.
    if (blocked !== undefined || runId === undefined) return;
    const finish = async (): Promise<void> => {
      await this.command('finish', 'node.finish', { ...fields, result: { kind: 'agent', runId } }, runId);
    };
    const settle = async (settlement: AgentSettlement): Promise<void> => {
      await this.command('settle', 'run.settle', { runId, ...settlement }, runId);
    };
    if (runToken === undefined) {
      // Only an idempotent replay comes back without the token, and then no agent may run with it.
      await settle({ outcome: 'abnormal_exit', terminalReason: 'engine_restarted', error: 'run token lost before the agent started' });
      await finish();
      return;
    }
    const provider = typeof node.params.provider === 'string' ? (node.params.provider as AgentProvider) : 'claude';
    const adapter = this.options.adapters[provider];
    if (adapter === undefined) {
      await settle({ outcome: 'failed', terminalReason: 'no_adapter', error: `no agent adapter for '${provider}'` });
      await finish();
      return;
    }
    const target = { ticketId, state, workflow, node, exec, provider };
    let prepared: Prepared;
    try {
      prepared = await this.workspaces.prepare(target);
    } catch (error) {
      await settle({ outcome: 'failed', terminalReason: 'workspace_failed', error: `could not prepare the workspace: ${(error as Error).message}` });
      await finish();
      return;
    }
    const context = executionContext(state, workflow, ticketId, node, { ...exec, attempts: attempt });
    const prompt = [agentPrompt(node, context, state.title, exec.lane, exec.run), ...prepared.notes].join('\n\n');
    const resume = await this.resumeTarget(runId);
    const model = typeof context.params === 'object' && context.params !== null ? (context.params as Record<string, unknown>).model : undefined;
    const cwd = prepared.cwd ?? this.options.workspace?.({ ticketId, projectId: state.projectId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt });
    for (const [index, message] of prepared.warnings.entries()) {
      await this.command('observe', 'run.observe', { runId, observations: [{ kind: 'warning', message, source: 'vuyro.workspace' }] }, runId, 'workspace', index);
    }
    let handle: AgentRunHandle;
    try {
      handle = adapter.start({
        runId,
        provider,
        ticketId,
        nodeId: node.id,
        lane: exec.lane,
        run: exec.run,
        prompt,
        env: {
          ...this.options.agentEnv,
          [AGENT_ENV.runToken]: runToken,
          [AGENT_ENV.ticket]: ticketId,
          [AGENT_ENV.node]: node.id,
          [AGENT_ENV.lane]: exec.lane,
          [AGENT_ENV.runId]: runId,
        },
        ...(typeof model === 'string' && model !== '' ? { model } : {}),
        ...(cwd === undefined ? {} : { cwd }),
        ...(this.options.agentTimeoutMs === undefined ? {} : { timeoutMs: this.options.agentTimeoutMs }),
        ...(resume === undefined ? {} : { resume }),
        ...(prepared.checkoutHook ? { checkoutHook: true } : {}),
      });
    } catch (error) {
      await this.afterRun(target);
      await settle({ outcome: 'failed', terminalReason: 'start_failed', error: (error as Error).message });
      await finish();
      return;
    }
    live.cancel = () => {
      handle.cancel();
    };
    if (live.cancelled) handle.cancel();
    // Waiting on the agent is not engine work; only the commands are.
    endSpan();
    let index = 0;
    for await (const observation of handle.observations) {
      index += 1;
      await this.activity.track(() => this.command('observe', 'run.observe', { runId, observations: [observation] }, runId, index));
    }
    const settlement = await handle.settled;
    await this.activity.track(async () => {
      await this.afterRun(target);
      await settle(settlement);
      await finish();
    });
  }

  /** After an executor's process ended: the engine's commit in its worktree and the finish scan. Never throws. */
  private async afterRun(target: Parameters<WorkspaceCoordinator['finish']>[0]): Promise<void> {
    try {
      await this.workspaces.finish(target);
    } catch (error) {
      this.report(error, `checking the workspace after ${target.node.id} lane ${target.exec.lane}`);
    }
  }

  /**
   * The merge step of a join in worktree mode: merges the lanes' branches into the ticket branch and reports it with
   * `node.finish` (kind merge). `resume`: the engine restarted while it ran; it runs again (merged branches are skipped).
   */
  private async runMerge(
    state: TicketWorkflow,
    workflow: CompiledWorkflow,
    node: CompiledNode,
    exec: Execution,
    live: LiveExecution,
    resume: boolean,
    endSpan: () => void,
  ): Promise<void> {
    const ticketId = live.ticketId;
    const attempt = resume ? exec.attempts : exec.attempts + 1;
    const fields = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt };
    if (!resume) {
      // The revision is part of the id: a merge that waited for a claim starts again with the same run and attempt.
      const started = await this.command('start', 'node.start', fields, ticketId, node.id, exec.lane, exec.run, attempt, live.revision);
      if (!started.ok || (started.result as { blocked?: string }).blocked !== undefined) return;
    }
    // The merge tracks its own git work; an agent resolving conflicts may wait on the clock in between.
    endSpan();
    const result = await this.workspaces.merge({ ticketId, state, workflow, node, exec });
    await this.activity.track(() => this.command('finish', 'node.finish', { ...fields, result }, ticketId, node.id, exec.lane, exec.run, attempt, 'merge'));
  }

  /** An agent run that resolves merge conflicts (`onMergeConflict: agent`). Resolves true when it ended normally. */
  private async resolveConflicts(request: MergeAgentRequest): Promise<boolean> {
    const adapter = this.options.adapters[request.provider];
    if (adapter === undefined) return false;
    const started = await this.activity.track(() =>
      this.command('merge-agent', 'run.start', { ticketId: request.ticketId, nodeId: request.nodeId, provider: request.provider }, request.ticketId, request.nodeId, request.run, request.cwd, this.options.clock.now()),
    );
    if (!started.ok) return false;
    const { runId, runToken } = started.result as { runId: string; runToken?: string };
    if (runToken === undefined) return false;
    let handle: AgentRunHandle;
    try {
      handle = adapter.start({
        runId,
        provider: request.provider,
        ticketId: request.ticketId,
        nodeId: request.nodeId,
        lane: request.lane,
        run: request.run,
        prompt: request.prompt,
        cwd: request.cwd,
        env: {
          ...this.options.agentEnv,
          [AGENT_ENV.runToken]: runToken,
          [AGENT_ENV.ticket]: request.ticketId,
          [AGENT_ENV.node]: request.nodeId,
          [AGENT_ENV.lane]: request.lane,
          [AGENT_ENV.runId]: runId,
        },
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(this.options.agentTimeoutMs === undefined ? {} : { timeoutMs: this.options.agentTimeoutMs }),
      });
    } catch (error) {
      await this.activity.track(() => this.command('settle', 'run.settle', { runId, outcome: 'failed', terminalReason: 'start_failed', error: (error as Error).message }, runId));
      return false;
    }
    let index = 0;
    for await (const observation of handle.observations) {
      index += 1;
      await this.activity.track(() => this.command('observe', 'run.observe', { runId, observations: [observation] }, runId, index));
    }
    const settlement = await handle.settled;
    await this.activity.track(() => this.command('settle', 'run.settle', { runId, ...settlement }, runId));
    return settlement.outcome === 'succeeded';
  }

  private async resumeTarget(runId: string): Promise<{ runId: string; providerSessionId: string } | undefined> {
    const row = await this.options.store.queryOne<{ resumed_from_run_id: string | null }>('SELECT resumed_from_run_id FROM p_runs WHERE run_id = ?', [runId]);
    const previous = row?.resumed_from_run_id ?? null;
    if (previous === null) return undefined;
    const session = await this.options.store.queryOne<{ provider_session_id: string | null }>('SELECT provider_session_id FROM p_runs WHERE run_id = ?', [previous]);
    const id = session?.provider_session_id ?? null;
    return id === null ? undefined : { runId: previous, providerSessionId: id };
  }

  private async runScript(
    state: TicketWorkflow,
    workflow: CompiledWorkflow,
    node: CompiledNode,
    exec: Execution,
    live: LiveExecution,
    endSpan: () => void,
  ): Promise<void> {
    const ticketId = live.ticketId;
    const attempt = exec.attempts + 1;
    const fields = { ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt };
    const finish = async (result: Record<string, unknown>): Promise<void> => {
      await this.command('finish', 'node.finish', { ...fields, result: { kind: 'script', ...result } }, ticketId, node.id, exec.lane, exec.run, attempt);
    };
    const started = await this.command('start', 'node.start', fields, ticketId, node.id, exec.lane, exec.run, attempt, live.revision);
    if (!started.ok || (started.result as { blocked?: string }).blocked !== undefined) return;
    const script = node.type.script;
    if (script === undefined) return;
    const target = { ticketId, state, workflow, node, exec };
    let prepared: Prepared;
    try {
      prepared = await this.workspaces.prepare(target);
    } catch (error) {
      await finish({ exitCode: null, error: `could not prepare the workspace: ${(error as Error).message}` });
      return;
    }
    const context = executionContext(state, workflow, ticketId, node, { ...exec, attempts: attempt });
    const invocation = resolveScript(script, context, this.scriptEnv);
    if (invocation.program === '') {
      await this.afterRun(target);
      await finish({ exitCode: null, error: 'the program resolved to an empty string' });
      return;
    }
    const cwd = prepared.cwd ?? this.options.workspace?.({ ticketId, projectId: state.projectId, nodeId: node.id, lane: exec.lane, run: exec.run, attempt });
    const child = startScript(this.options.processRunner, this.options.clock, invocation, cwd);
    live.cancel = () => {
      child.kill();
    };
    if (live.cancelled) child.kill();
    endSpan();
    const exit = await child.exited;
    await this.activity.track(async () => {
      await this.afterRun(target);
      await finish({ ...exit });
    });
  }

  private cancel(live: LiveExecution): void {
    if (live.cancelled) return;
    live.cancelled = true;
    live.cancel?.();
  }

  private async command(step: string, type: CommandType, payload: unknown, ...idParts: (string | number)[]): Promise<CommandResponse> {
    const response = await this.options.bus.execute({ requestId: requestId(step, type, ...idParts), type, payload }, SYSTEM);
    if (!response.ok && response.error.code !== 'invariant_violated') {
      this.report(new Error(`${type}: ${response.error.code} ${response.error.message}`), `workflow step '${step}'`);
    }
    return response;
  }

  private report(error: unknown, context: string): void {
    const failed = error instanceof Error ? error : new Error(String(error));
    if (this.options.reportError !== undefined) this.options.reportError(failed, context);
    else process.stderr.write(`[vuyro] ${context}: ${failed.message}\n`);
  }
}
