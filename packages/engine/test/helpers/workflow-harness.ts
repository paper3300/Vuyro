import { join } from 'node:path';
import type { CommandResponse, CommandSuccess } from '@vuyro/contracts';
import { CommandBus } from '../../src/commands/command-bus.ts';
import type { TransportIdentity } from '../../src/commands/caller.ts';
import { ActivityTracker } from '../../src/runtime/activity.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { type FileSystem, nodeFileSystem } from '../../src/runtime/fs.ts';
import { createUuidV7Generator, seededRandom } from '../../src/runtime/ids.ts';
import { FakeProcessRunner } from '../../src/runtime/process.ts';
import { EventStore } from '../../src/store/event-store.ts';
import { installBuiltins } from '../../src/workflow/builtins.ts';
import { DefinitionWriter } from '../../src/workflow/definition-writer.ts';
import { DefinitionRegistry } from '../../src/workflow/definitions.ts';
import { WorkflowEngine, type WorkflowEngineOptions } from '../../src/workflow/engine.ts';
import { endReached, ticketWaitReasons } from '../../src/workflow/machine.ts';
import { type ScriptedBehavior, ScriptedAgentAdapter } from '../../src/workflow/scripted-agent.ts';
import { currentExecution, evolveTicket, EMPTY_TICKET, laneStatus, nodeProgress, type TicketWorkflow } from '../../src/workflow/state.ts';
import type { GitClient } from '../../src/workspace/git.ts';
import { type WorkspaceServices, workspaceServices } from '../../src/workspace/services.ts';
import type { FileWatcher } from '../../src/workspace/watcher.ts';
import { HUMAN, nextRequestId, SYSTEM, tempDir } from './engine-harness.ts';

export interface WorkflowHarnessOptions {
  readonly behavior?: ScriptedBehavior;
  readonly maxConcurrent?: number;
  readonly fs?: FileSystem;
  /** Skip installing the built-in definitions. */
  readonly bare?: boolean;
  /** Do not start the workflow engine (scheduler). */
  readonly noEngine?: boolean;
  readonly workspace?: WorkflowEngineOptions['workspace'];
  /** Real adapters instead of the scripted one (e.g. CliAgentAdapter on the fake process runner). */
  readonly adapters?: (parts: { clock: VirtualClock; processes: FakeProcessRunner; bus: CommandBus }) => WorkflowEngineOptions['adapters'];
  readonly agentTimeoutMs?: number;
  readonly agentEnv?: Readonly<Record<string, string>>;
  /** Git for worktree tests (default: git on PATH). */
  readonly git?: GitClient;
  readonly watcher?: FileWatcher;
}

export interface WorkflowHarness {
  readonly dir: string;
  /** Workspace layout (worktrees under `<dir>/wt`), the virtual clock and real file hashes; shared by bus and engine. */
  readonly workspaces: WorkspaceServices;
  readonly clock: VirtualClock;
  readonly activity: ActivityTracker;
  readonly processes: FakeProcessRunner;
  readonly errors: { error: Error; context: string }[];
  store: EventStore;
  bus: CommandBus;
  registry: DefinitionRegistry;
  writer: DefinitionWriter;
  engine: WorkflowEngine | undefined;
  adapter: ScriptedAgentAdapter;
  setBehavior(behavior: ScriptedBehavior): void;
  exec(type: string, payload: unknown, transport?: TransportIdentity, extra?: Record<string, unknown>): Promise<CommandResponse>;
  ok(type: string, payload: unknown, transport?: TransportIdentity, extra?: Record<string, unknown>): Promise<CommandSuccess>;
  /**
   * Runs until nothing is left to do but wait for time that no timer will bring, then checks the
   * ticket-end invariant on every ticket (see `checkTicketEnds`).
   */
  drive(limit?: number): Promise<void>;
  /**
   * Ticket-end invariant: an open ticket always has a wait reason (active work or an unhandled failure).
   * In particular a ticket whose end node finished is either completed or waits for something named.
   */
  checkTicketEnds(): Promise<void>;
  ticket(ticketId: string): Promise<TicketWorkflow>;
  status(ticketId: string, nodeId: string, lane?: string): Promise<string>;
  /** Closes and reopens everything on the same database and files (an engine restart). */
  restart(options?: { behavior?: ScriptedBehavior; noEngine?: boolean; whileClosed?: (dbPath: string) => void | Promise<void> }): Promise<void>;
  close(): Promise<void>;
}

export async function openWorkflowHarness(options: WorkflowHarnessOptions = {}): Promise<WorkflowHarness> {
  const temp = tempDir('vuyro-wf-');
  const clock = new VirtualClock();
  const ids = createUuidV7Generator({ clock, random: seededRandom(7) });
  const random = seededRandom(8);
  const activity = new ActivityTracker();
  const processes = new FakeProcessRunner(clock);
  const fs = options.fs ?? nodeFileSystem;
  const workspaces = workspaceServices({ worktreeRoot: join(temp.dir, 'wt'), clock });
  const errors: { error: Error; context: string }[] = [];
  const reportError = (error: Error, context: string) => {
    errors.push({ error, context });
  };
  let behavior: ScriptedBehavior = options.behavior ?? (() => Promise.resolve(undefined));

  const build = async (start: { engine: boolean }) => {
    const store = await EventStore.open({ path: join(temp.dir, 'engine.db'), clock, ids });
    const registry = new DefinitionRegistry({ root: join(temp.dir, 'definitions'), fs, store });
    const bus = new CommandBus({ store, ids, random, definitions: registry, reportError, workspaces });
    const writer = new DefinitionWriter({ registry, fs, bus, store, activity, reportError });
    writer.start();
    const adapter = new ScriptedAgentAdapter({ provider: 'claude', clock, bus, activity, behavior: (session) => behavior(session) });
    const engine = start.engine
      ? new WorkflowEngine({
          bus,
          store,
          definitions: registry,
          clock,
          adapters: options.adapters?.({ clock, processes, bus }) ?? { claude: adapter },
          processRunner: processes,
          activity,
          scriptEnv: { PATH: '/bin' },
          reportError,
          ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
          ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
          ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
          ...(options.agentEnv === undefined ? {} : { agentEnv: options.agentEnv }),
          ...(options.git === undefined ? {} : { git: options.git }),
          ...(options.watcher === undefined ? {} : { watcher: options.watcher }),
          workspaces,
        })
      : undefined;
    return { store, registry, bus, writer, adapter, engine };
  };

  let parts = await build({ engine: options.noEngine !== true });
  if (options.bare !== true) {
    for (const response of await installBuiltins(parts.writer)) {
      if (!response.ok) throw new Error(`installing built-ins failed: ${JSON.stringify(response.error)}`);
    }
  }
  await parts.engine?.start();

  const harness: WorkflowHarness = {
    dir: temp.dir,
    workspaces,
    clock,
    activity,
    processes,
    errors,
    get store() {
      return parts.store;
    },
    get bus() {
      return parts.bus;
    },
    get registry() {
      return parts.registry;
    },
    get writer() {
      return parts.writer;
    },
    get engine() {
      return parts.engine;
    },
    get adapter() {
      return parts.adapter;
    },
    setBehavior(next) {
      behavior = next;
    },
    exec: (type, payload, transport = HUMAN, extra = {}) => parts.bus.execute({ requestId: nextRequestId(), type, payload, ...extra }, transport),
    async ok(type, payload, transport = HUMAN, extra = {}) {
      const response = await harness.exec(type, payload, transport, extra);
      if (!response.ok) throw new Error(`${type} failed: ${JSON.stringify(response.error)}`);
      return response;
    },
    async drive(limit = 10_000) {
      for (let step = 0; step < limit; step++) {
        await activity.idle();
        const next = clock.nextDueAt();
        if (next === undefined) {
          await harness.checkTicketEnds();
          return;
        }
        await clock.advanceTo(next);
      }
      throw new Error('drive: too many steps');
    },
    async checkTicketEnds() {
      const rows = await parts.store.query<{ ticket_id: string }>("SELECT ticket_id FROM p_tickets WHERE status = 'open' AND template_id IS NOT NULL");
      for (const { ticket_id: ticketId } of rows) {
        const state = await harness.ticket(ticketId);
        if (state.template === undefined) continue;
        let workflow;
        try {
          workflow = await parts.registry.workflow(state.template);
        } catch {
          continue; // Tests that tamper with definition files check that on their own.
        }
        if (ticketWaitReasons(state, workflow).length === 0) {
          const where = endReached(state, workflow) ? 'a path ended' : 'no path ended';
          const runs = Object.entries(state.nodes).flatMap(([nodeId, progress]) =>
            progress.executions.map((exec) => `${nodeId}/${exec.lane}#${exec.run}:${exec.status}:${exec.output?.port ?? '-'}:${JSON.stringify(exec.routes)}`),
          );
          throw new Error(`ticket ${ticketId}: ${where} and nothing is waiting, but the ticket is still open (stuck) [${runs.join(' ')}]`);
        }
      }
    },
    async ticket(ticketId) {
      let state = EMPTY_TICKET;
      for (const event of await parts.store.readAggregate(ticketId)) state = evolveTicket(state, event);
      return state;
    },
    async status(ticketId, nodeId, lane = 'main') {
      return laneStatus(await harness.ticket(ticketId), nodeId, lane);
    },
    async restart(next = {}) {
      parts.engine?.stop();
      parts.writer.stop();
      await activity.idle();
      await parts.store.close();
      await next.whileClosed?.(join(temp.dir, 'engine.db'));
      if (next.behavior !== undefined) behavior = next.behavior;
      parts = await build({ engine: next.noEngine !== true });
      await parts.writer.recover();
      await parts.engine?.start();
    },
    async close() {
      parts.engine?.stop({ cancelRunning: true });
      parts.writer.stop();
      await activity.idle();
      await parts.store.close();
      temp.dispose();
    },
  };
  return harness;
}

/** Creates a project and a ticket running the default template. */
export async function startSdlcTicket(h: WorkflowHarness, title = 'Add a notepad'): Promise<{ projectId: string; ticketId: string }> {
  const project = await h.ok('project.create', { name: 'sample' });
  const { projectId } = project.result as { projectId: string };
  const ticket = await h.ok('ticket.create', { projectId, title, template: { id: 'vuyro/ai-sdlc' } });
  return { projectId, ticketId: (ticket.result as { ticketId: string }).ticketId };
}

export { currentExecution, HUMAN, nodeProgress, SYSTEM };
