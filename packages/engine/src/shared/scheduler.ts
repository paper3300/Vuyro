import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type ArtifactRef, type CommandResponse, type CommandType, type DomainEvent, type ExpressionContext, resolveTemplateValue } from '@vuyro/contracts';
import { projectAggregate, type ProjectState } from '../commands/aggregates.ts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { TransportIdentity } from '../commands/caller.ts';
import type { ActivityTracker } from '../runtime/activity.ts';
import type { Clock, TimerHandle } from '../runtime/clock.ts';
import type { FileSystem } from '../runtime/fs.ts';
import type { ProcessRunner } from '../runtime/process.ts';
import type { EventStore } from '../store/event-store.ts';
import { type CompiledNode, compileSharedNode } from '../workflow/compile.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';
import { resolveScript, type ScriptExit, startScript } from '../workflow/script-runner.ts';
import { EMPTY_TICKET, evolveTicket, execution, type TicketWorkflow } from '../workflow/state.ts';
import { EMPTY_SHARED_NODE, evolveSharedNode, type RunningBatch, runningBatches, type SharedNodeState } from './state.ts';

/**
 * The engine's side of shared nodes (M5): it asks for a batch whenever one may start (a request joined, a batch ended,
 * the node was unblocked, protected paths were released, a `window` came due), runs the node type of a batch that
 * started, and reports the end with `sharedNode.finish`. It decides nothing itself; the commands do.
 *
 * It lives in the engine process, not in the app: closing the window leaves the queue and its batches running
 * (the engine daemon is detached, [[명령·이벤트 계약]] §11). When the engine starts again, a batch that was running
 * is reported as interrupted (its requests go back to the front of the queue and a person decides, D-011) and the
 * queue picks up where it was.
 */

export interface SharedNodeSchedulerOptions {
  readonly bus: CommandBus;
  readonly store: EventStore;
  readonly definitions: DefinitionResolver;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly activity: ActivityTracker;
  readonly scriptEnv: Readonly<Record<string, string>>;
  /** Where batch output is written (`<dir>/<project>/<name>/<batchId>.log`), linked to every ticket as `log`. */
  readonly logs?: { readonly dir: string; readonly fs: FileSystem };
  readonly reportError: (error: Error, context: string) => void;
}

interface LiveBatch {
  kill?: () => void;
  /** The engine is stopping: the batch's end is an interruption, not a result. */
  stopping: boolean;
}

const SYSTEM: TransportIdentity = { kind: 'internal', component: 'shared' };

function batchKey(aggregateId: string, batch: number): string {
  return `${aggregateId}#${batch}`;
}

export class SharedNodeScheduler {
  private readonly options: SharedNodeSchedulerOptions;
  private readonly live = new Map<string, LiveBatch>();
  /** Batches started in this process (running or ended). */
  private readonly launched = new Set<string>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly pending = new Set<string>();
  private readonly cache = new Map<string, { revision: number; state: SharedNodeState }>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: SharedNodeSchedulerOptions) {
    this.options = options;
  }

  /** Reports batches a previous engine left running as interrupted, then looks at every shared node. */
  async start(): Promise<void> {
    this.stopped = false;
    const rows = await this.options.store.query<{ aggregate_id: string }>('SELECT aggregate_id FROM p_shared_nodes ORDER BY aggregate_id');
    this.enqueue(async () => {
      for (const { aggregate_id: id } of rows) {
        const state = await this.state(id);
        for (const batch of runningBatches(state)) {
          if (this.live.has(batchKey(id, batch.batch))) continue;
          await this.command('recover', 'sharedNode.finish', { projectId: state.projectId, name: state.name, batch: batch.batch, result: { kind: 'interrupted', reason: 'the engine restarted while the batch ran' } }, id, batch.batch);
        }
      }
    });
    for (const { aggregate_id: id } of rows) this.touch(id);
    await this.chain;
  }

  /** Stops asking for batches. A running batch is killed when `cancelRunning` is set; it is then reported as interrupted. */
  stop(options: { cancelRunning?: boolean } = {}): void {
    this.stopped = true;
    for (const timer of this.timers.values()) this.options.clock.clearTimeout(timer);
    this.timers.clear();
    if (options.cancelRunning === true) {
      for (const live of this.live.values()) {
        live.stopping = true;
        live.kill?.();
      }
    }
  }

  /** Batches running in this process. */
  get running(): number {
    return this.live.size;
  }

  onEvents(events: readonly DomainEvent[]): void {
    if (this.stopped) return;
    const released = new Set<string>();
    const resumed = new Set<string>();
    for (const event of events) {
      if (event.aggregateType === 'shared') this.touch(event.aggregateId);
      // Released paths may be what a waiting batch needs.
      else if (event.type === 'checkout.released') released.add(event.data.projectId);
      // A paused request that goes on keeps its place in the queue: it may complete a batch.
      else if (event.type === 'node.resumed') resumed.add(event.aggregateId);
    }
    if (released.size === 0 && resumed.size === 0) return;
    this.enqueue(async () => {
      const projects = new Map<string, (state: SharedNodeState) => boolean>();
      for (const projectId of released) projects.set(projectId, (state) => state.waiting !== undefined);
      for (const ticketId of resumed) {
        const row = await this.options.store.queryOne<{ project_id: string }>('SELECT project_id FROM p_tickets WHERE ticket_id = ?', [ticketId]);
        if (row !== undefined && !projects.has(row.project_id)) projects.set(row.project_id, (state) => state.queue.some((entry) => entry.ticketId === ticketId));
      }
      for (const [projectId, wanted] of projects) {
        const rows = await this.options.store.query<{ aggregate_id: string }>('SELECT aggregate_id FROM p_shared_nodes WHERE project_id = ?', [projectId]);
        for (const { aggregate_id: id } of rows) {
          if (wanted(await this.state(id))) this.touch(id);
        }
      }
    });
  }

  private touch(id: string): void {
    if (this.stopped || this.pending.has(id)) return;
    this.pending.add(id);
    this.enqueue(async () => {
      this.pending.delete(id);
      await this.evaluate(id);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    const done = this.options.activity.begin();
    this.chain = this.chain
      .then(work)
      .catch((error: unknown) => {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), 'shared node scheduling');
      })
      .finally(done);
  }

  private async state(id: string): Promise<SharedNodeState> {
    const cached = this.cache.get(id);
    let revision = cached?.revision ?? 0;
    let state = cached?.state ?? EMPTY_SHARED_NODE;
    for (const event of await this.options.store.readAggregate(id, revision)) {
      state = evolveSharedNode(state, event);
      revision = event.revision;
    }
    this.cache.set(id, { revision, state });
    return state;
  }

  /** Runs batches that started and are not running here yet, then asks for a new batch if one may start. */
  private async evaluate(id: string): Promise<void> {
    if (this.stopped) return;
    const state = await this.state(id);
    if (!state.exists) return;
    for (const batch of runningBatches(state)) {
      const key = batchKey(id, batch.batch);
      // A batch runs at most once per engine: one whose end is not recorded yet is never started again.
      if (!this.live.has(key) && !this.launched.has(key)) this.launch(id, state, batch);
    }
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      this.options.clock.clearTimeout(timer);
      this.timers.delete(id);
    }
    const definition = Object.hasOwn(state.definitions, state.version) ? state.definitions[state.version] : undefined;
    if (state.blocked !== undefined || state.queue.length === 0 || definition === undefined) return;
    if (runningBatches(state).length >= definition.spec.maxConcurrent) return;
    // Every attempt is a new question (its answer depends on the tickets, the ledger and the clock, not only on this
    // aggregate), so it never gets an earlier "not yet" back. A start the engine resends after a crash is decided again
    // from the state, which already holds the batch it started.
    const response = await this.command('start', 'sharedNode.start', { projectId: state.projectId, name: state.name }, id, randomUUID());
    if (!response.ok) return;
    const result = response.result as { started: boolean; nextCheckAt?: number };
    // (A timer that fires after `stop` does nothing: `touch` checks.)
    if (!result.started && result.nextCheckAt !== undefined) {
      this.timers.set(
        id,
        this.options.clock.setTimeout(() => {
          this.timers.delete(id);
          this.touch(id);
        }, Math.max(0, result.nextCheckAt - this.options.clock.now())),
      );
    }
  }

  private launch(id: string, state: SharedNodeState, batch: RunningBatch): void {
    const key = batchKey(id, batch.batch);
    const live: LiveBatch = { stopping: false };
    this.live.set(key, live);
    this.launched.add(key);
    const done = this.options.activity.begin();
    void this.runBatch(id, state, batch, live, done)
      .catch((error: unknown) => {
        this.options.reportError(error instanceof Error ? error : new Error(String(error)), `running batch ${batch.batchId}`);
      })
      .finally(() => {
        done();
        this.live.delete(key);
        this.touch(id);
      });
  }

  private async runBatch(id: string, state: SharedNodeState, batch: RunningBatch, live: LiveBatch, endSpan: () => void): Promise<void> {
    const fields = { projectId: state.projectId, name: state.name, batch: batch.batch };
    const finish = async (result: Record<string, unknown>): Promise<void> => {
      const response = await this.command('finish', 'sharedNode.finish', { ...fields, result }, id, batch.batch);
      if (response.ok) return;
      // Never run the batch again because its result could not be recorded (it may have side effects): it ends as
      // interrupted, its requests go back to the queue and a person decides.
      await this.command('finish-fallback', 'sharedNode.finish', { ...fields, result: { kind: 'interrupted', reason: `the batch result could not be recorded: ${response.error.message}`.slice(0, 1024) } }, id, batch.batch);
    };
    const definition = Object.hasOwn(state.definitions, batch.definition) ? state.definitions[batch.definition] : undefined;
    let node: CompiledNode | undefined;
    let problem: string | undefined;
    try {
      if (definition === undefined) throw new Error(`definition ${batch.definition} is unknown`);
      const pinned = await this.options.definitions.pinnedNodeType(definition.nodeType.type, definition.nodeType.version, definition.nodeType.hash);
      if (pinned === undefined) throw new Error(`node type ${definition.nodeType.type}@${definition.nodeType.version} is not active`);
      const compiled = compileSharedNode(definition.spec, pinned.nodeType, this.options.definitions.dataValidator);
      node = compiled.node;
      if (node === undefined) throw new Error(compiled.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
    } catch (error) {
      problem = `the shared node cannot run its node type: ${(error as Error).message}`;
    }
    const script = node?.type.script;
    if (node === undefined || script === undefined) {
      await finish({ kind: 'script', exitCode: null, error: problem ?? 'the node type has no script' });
      return;
    }
    const project = await this.project(state.projectId);
    const context = await this.context(node, state, batch);
    const invocation = resolveScript(script, context, this.options.scriptEnv);
    if (invocation.program === '') {
      await finish({ kind: 'script', exitCode: null, error: 'the program resolved to an empty string' });
      return;
    }
    const child = startScript(this.options.processRunner, this.options.clock, invocation, project.root);
    live.kill = () => {
      child.kill();
    };
    if (live.stopping) child.kill();
    // Waiting on the process is not engine work; reporting it is.
    endSpan();
    const exit = await child.exited;
    await this.options.activity.track(async () => {
      if (live.stopping) {
        await finish({ kind: 'interrupted', reason: 'the engine stopped while the batch ran' });
        return;
      }
      const log = await this.writeLog(state, batch, exit);
      await finish({ kind: 'script', ...exit, ...(log === undefined ? {} : { log }) });
    });
  }

  /** What the batch's expressions read: every request's items (with their ticket), the params and the batch. */
  private async context(node: CompiledNode, state: SharedNodeState, batch: RunningBatch): Promise<ExpressionContext> {
    const items: Record<string, unknown>[] = [];
    const tickets: { id: string; title: string }[] = [];
    for (const member of batch.members) {
      const ticket = await this.ticket(member.ticketId);
      if (!tickets.some((entry) => entry.id === member.ticketId)) tickets.push({ id: member.ticketId, title: ticket.title });
      const exec = execution(ticket, member.nodeId, member.run);
      if (exec === undefined) continue;
      const inputs = Object.values(exec.inputs).flat();
      for (const [index, item] of inputs.entries()) {
        items.push({
          data: item.data,
          ...(item.summary === undefined ? {} : { summary: item.summary }),
          ...(item.artifacts === undefined ? {} : { artifacts: item.artifacts }),
          ticket: { id: member.ticketId, title: ticket.title },
          request: { nodeId: member.nodeId, lane: member.lane, run: member.run, item: index },
        });
      }
    }
    const ports = node.inputs.length === 0 ? ['in'] : node.inputs.map((port) => port.name);
    const base: Record<string, unknown> = {
      input: items[0] ?? { data: {} },
      inputs: Object.fromEntries(ports.map((port) => [port, items])),
      nodes: {},
      node: { id: node.id, label: node.label, lane: 'main', run: batch.batch, attempt: 1, batch: batch.batch, batchId: batch.batchId, sharedNode: state.name, tickets },
    };
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.params)) {
      const template = node.paramTemplates.get(name);
      params[name] = template === undefined ? value : resolveTemplateValue(template, base);
    }
    return { ...base, params };
  }

  private async writeLog(state: SharedNodeState, batch: RunningBatch, exit: ScriptExit): Promise<ArtifactRef | undefined> {
    const logs = this.options.logs;
    if (logs === undefined) return undefined;
    const dir = join(logs.dir, state.projectId, state.name);
    const path = join(dir, `${batch.batchId}.log`);
    try {
      await logs.fs.mkdir(dir, { recursive: true });
      await logs.fs.writeFile(path, `# ${batch.batchId}: exit ${String(exit.exitCode)}${exit.signal === null ? '' : ` (${exit.signal})`}\n\n## stdout\n${exit.stdout}\n\n## stderr\n${exit.stderr}\n`);
      return { kind: 'file', uri: path, title: `${batch.batchId} log`, mimeType: 'text/plain' };
    } catch (error) {
      this.options.reportError(error instanceof Error ? error : new Error(String(error)), `writing the log of batch ${batch.batchId}`);
      return undefined;
    }
  }

  private async ticket(ticketId: string): Promise<TicketWorkflow> {
    let state = EMPTY_TICKET;
    for (const event of await this.options.store.readAggregate(ticketId)) state = evolveTicket(state, event);
    return state;
  }

  private async project(projectId: string): Promise<ProjectState> {
    let state = projectAggregate.initial;
    for (const event of await this.options.store.readAggregate(projectId)) state = projectAggregate.evolve(state, event);
    return state;
  }

  private async command(step: string, type: CommandType, payload: unknown, ...idParts: (string | number)[]): Promise<CommandResponse> {
    const response = await this.options.bus.execute({ requestId: requestId(step, ...idParts), type, payload }, SYSTEM);
    if (!response.ok) this.options.reportError(new Error(`${type}: ${response.error.code} ${response.error.message}`), `shared node step '${step}'`);
    return response;
  }
}

/** Deterministic: a step retried after a crash is the same command. */
function requestId(step: string, ...parts: (string | number)[]): string {
  return `sh-${step}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
}
