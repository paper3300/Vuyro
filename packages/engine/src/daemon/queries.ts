import type {
  BoardResult,
  BoardTicketView,
  DefinitionListing,
  DomainEvent,
  ExportResult,
  ImportChoice,
  ImportPreview,
  RunEventsResult,
  RunLogEntry,
  HandoffItem,
  ItemView,
  PinnedTemplate,
  ReviewView,
  SharedNodeView,
  TemplateSummary,
  TicketStats,
  WorkflowView,
  WorkspaceSettings,
  WorktreeCleanupCandidate,
} from '@vuyro/contracts';
import type { Clock } from '../runtime/clock.ts';
import { currentDefinition, EMPTY_SHARED_NODE, evolveSharedNode, runningBatches } from '../shared/state.ts';
import { computeTicketStats, type NodeKind } from '../stats/ticket-stats.ts';
import type { EventStore } from '../store/event-store.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';
import { type ExchangeSource, exportDefinition, previewImport } from '../workflow/exchange.ts';
import type { CompiledWorkflow } from '../workflow/compile.ts';
import { ticketWaitReasons, type WaitReason } from '../workflow/machine.ts';
import { EMPTY_TICKET, evolveTicket } from '../workflow/state.ts';
import { isRepositoryTop } from '../workspace/git.ts';
import { DEFAULT_LOG_TEXT_LIMIT, runLogEntry } from './run-log.ts';
import { workflowView } from './workflow-view.ts';

/**
 * Read side of the daemon: what screens and the CLI ask for. Everything comes from the projections and the
 * log on the read-only worker; nothing here changes state. Statistics are computed from the events.
 */

export interface ProjectRow {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: number;
  /** The project folder (`project.configure` root), or null: agents then work in an empty folder per ticket. */
  readonly root: string | null;
  readonly baseRef: string | null;
  /** The project layer of the workspace settings (app → project → template → node), or null when never set. */
  readonly settings: WorkspaceSettings | null;
  /** Whether the folder is a git repository's own folder now (worktree mode needs one), as git says (`isRepositoryTop`). */
  readonly rootIsGitRepo: boolean;
}

export interface TicketRow {
  readonly ticketId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  /** Higher first when tickets compete for a claim; the board orders cards by it. */
  readonly priority: number;
  readonly template: { readonly id: string; readonly version: number; readonly hash: string } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly revision: number;
  readonly attention: string | null;
}

export interface ArtifactRow {
  readonly nodeId: string;
  readonly slot: string;
  readonly kind: string;
  readonly uri: string;
  readonly version: string | null;
  readonly title: string | null;
  readonly mimeType: string | null;
  readonly contentHash: string | null;
  /** 'added' = registered with `artifact.add`; 'output' = only in a finished execution's output. */
  readonly source: 'added' | 'output';
  readonly lane: string | null;
  readonly runId: string | null;
  /** Execution number (ItemRef.run) and item index, for output artifacts. */
  readonly execution: number | null;
  readonly item: number | null;
  readonly addedAt: number;
  readonly sequence: number;
  /** The latest entry for its node, lane and slot. */
  readonly current: boolean;
}

export interface WorkspaceView {
  readonly checkouts: readonly Record<string, unknown>[];
  readonly blocks: readonly Record<string, unknown>[];
  readonly changes: readonly Record<string, unknown>[];
  readonly overlaps: readonly Record<string, unknown>[];
  readonly worktrees: readonly Record<string, unknown>[];
}

export interface TicketDetail {
  readonly ticket: TicketRow;
  readonly lanes: readonly Record<string, unknown>[];
  readonly executions: readonly Record<string, unknown>[];
  /** Agent runs (no token hashes). */
  readonly runs: readonly Record<string, unknown>[];
  /** What the open ticket waits for (empty when done, undefined when the workflow cannot be read). */
  readonly waitingFor?: readonly WaitReason[];
  /** The pinned workflow as screens draw it (undefined when its files no longer match). */
  readonly workflow?: WorkflowView;
  /** What waits for a person now, with what they decide on. */
  readonly reviews: readonly ReviewView[];
}

interface RawTicket {
  ticket_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  template_id: string | null;
  template_version: number | null;
  template_hash: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  revision: number;
  attention: string | null;
}

const RUN_COLUMNS = `run_id AS runId, node_id AS nodeId, provider, status, resumed_from_run_id AS resumedFromRunId,
  provider_session_id AS providerSessionId, model, started_at AS startedAt, settled_at AS settledAt, exit_code AS exitCode,
  signal, terminal_reason AS terminalReason, tokens_input AS tokensInput, tokens_cache_read AS tokensCacheRead,
  tokens_cache_write AS tokensCacheWrite, tokens_output AS tokensOutput, tokens_reasoning AS tokensReasoning,
  cost_usd AS costUsd, cost_basis AS costBasis, messages, tool_calls AS toolCalls, tool_errors AS toolErrors, warnings`;

export class EngineQueries {
  private readonly store: EventStore;
  private readonly definitions: DefinitionResolver;
  private readonly clock: Clock;
  private readonly cleanup: ((projectId: string, ticketId?: string) => Promise<WorktreeCleanupCandidate[]>) | undefined;
  private readonly library: ExchangeSource | undefined;

  constructor(options: {
    store: EventStore;
    definitions: DefinitionResolver;
    clock: Clock;
    /** The engine's view of worktrees a person may clean up (it reads the worktrees on disk). */
    cleanup?: (projectId: string, ticketId?: string) => Promise<WorktreeCleanupCandidate[]>;
    /** The definition files, for listing, exporting and previewing imports (the registry). */
    library?: ExchangeSource;
  }) {
    this.store = options.store;
    this.definitions = options.definitions;
    this.clock = options.clock;
    this.cleanup = options.cleanup;
    this.library = options.library;
  }

  /**
   * One page of an agent run's log (M6b node detail), in order. Undefined when there is no such run. Text longer
   * than `textLimit` is cut; the entry keeps the full length.
   */
  async runEvents(runId: string, options: { after?: number; limit?: number; textLimit?: number; tail?: number } = {}): Promise<RunEventsResult | undefined> {
    const run = await this.store.queryOne<RunEventsResult['run']>(
      `SELECT run_id AS runId, ticket_id AS ticketId, node_id AS nodeId, provider, status, model, started_at AS startedAt, settled_at AS settledAt
         FROM p_runs WHERE run_id = ?`,
      [runId],
    );
    if (run === undefined) return undefined;
    const last = (await this.store.queryOne<{ last: number | null }>('SELECT MAX(revision) AS last FROM events WHERE aggregate_id = ?', [runId]))?.last ?? 0;
    const limit = options.tail ?? options.limit ?? 200;
    const after = options.tail === undefined ? (options.after ?? 0) : Math.max(0, last - options.tail);
    // One more than the page, to know whether more follow.
    const events = await this.store.readAggregatePage(runId, after, limit + 1);
    const page = events.slice(0, limit);
    const entries: RunLogEntry[] = [];
    for (const event of page) {
      const entry = runLogEntry(event, options.textLimit ?? DEFAULT_LOG_TEXT_LIMIT);
      if (entry !== undefined) entries.push(entry);
    }
    return { run, entries, cursor: page.at(-1)?.revision ?? after, more: events.length > limit, lastRevision: Math.max(last, page.at(-1)?.revision ?? 0) };
  }

  /** Registered definition versions with their names; `latest` marks the newest active version of each id. */
  async definitionList(kind?: 'nodeType' | 'template'): Promise<DefinitionListing[]> {
    const rows = await this.store.query<{ kind: 'nodeType' | 'template'; id: string; version: number; name: string; hash: string; status: DefinitionListing['status'] }>(
      `SELECT kind, id, version, name, hash, status FROM p_definitions${kind === undefined ? '' : ' WHERE kind = ?'} ORDER BY kind, id, version`,
      kind === undefined ? [] : [kind],
    );
    const latest = new Map<string, number>();
    for (const row of rows) if (row.status === 'active') latest.set(`${row.kind} ${row.id}`, Math.max(latest.get(`${row.kind} ${row.id}`) ?? 0, row.version));
    return rows.map((row) => ({ ...row, latest: latest.get(`${row.kind} ${row.id}`) === row.version }));
  }

  /** An active definition as a file to share: secrets left out, a template with its node types (bundle). */
  async exportDefinition(request: { kind: 'nodeType' | 'template'; id: string; version?: number; embedNodeTypes?: boolean }): Promise<ExportResult> {
    return exportDefinition(this.requireLibrary(), request);
  }

  /** What importing a file would do; saves nothing. */
  async importPreview(text: string, choices?: Readonly<Record<string, ImportChoice>>): Promise<ImportPreview> {
    return previewImport(this.requireLibrary(), text, choices);
  }

  private requireLibrary(): ExchangeSource {
    if (this.library === undefined) throw new Error('this engine has no definition files');
    return this.library;
  }

  /**
   * A project's shared nodes (M5): definition, status, queue (in order), running and recent batches. Folded from each
   * shared node's events, like the engine does.
   */
  async sharedNodes(projectId: string, name?: string): Promise<SharedNodeView[]> {
    const rows = await this.store.query<{ aggregate_id: string }>(
      `SELECT aggregate_id FROM p_shared_nodes WHERE project_id = ?${name === undefined ? '' : ' AND name = ?'} ORDER BY name`,
      name === undefined ? [projectId] : [projectId, name],
    );
    const views: SharedNodeView[] = [];
    for (const { aggregate_id: id } of rows) {
      let state = EMPTY_SHARED_NODE;
      for (const event of await this.store.readAggregate(id)) state = evolveSharedNode(state, event);
      const definition = currentDefinition(state);
      if (!state.exists || definition === undefined) continue;
      const running = runningBatches(state);
      const member = (entry: { ticketId: string; nodeId: string; lane: string; run: number }) => ({ ticketId: entry.ticketId, nodeId: entry.nodeId, lane: entry.lane, run: entry.run });
      views.push({
        projectId: state.projectId,
        name: state.name,
        label: definition.spec.label,
        version: state.version,
        spec: definition.spec,
        status: state.blocked !== undefined ? 'blocked' : running.length > 0 ? 'running' : state.waiting !== undefined ? 'waiting' : 'idle',
        ...(state.blocked === undefined ? {} : { blocked: { reason: state.blocked.reason, batch: state.blocked.batch, by: state.blocked.by.map(member) } }),
        queue: state.queue.map((entry, index) => ({ ...member(entry), position: index + 1, queuedAt: entry.at, retry: entry.retry === true })),
        running: running.map((batch) => ({
          batch: batch.batch,
          batchId: batch.batchId,
          trigger: batch.trigger,
          members: batch.members.map(member),
          startedAt: batch.startedAt ?? 0,
        })),
        recent: [...state.recent].reverse().map((batch) => ({
          batch: batch.batch,
          batchId: batch.batchId,
          trigger: batch.trigger,
          members: batch.members.map(member),
          startedAt: batch.startedAt ?? 0,
          ...(batch.finishedAt === undefined ? {} : { finishedAt: batch.finishedAt }),
          outcome: batch.outcome,
          ...(batch.policy === undefined ? {} : { policy: batch.policy }),
          failed: batch.failed.map((entry) => entry.ticketId),
          ...(batch.errorFiles === undefined ? {} : { errorFiles: batch.errorFiles }),
        })),
      });
    }
    return views;
  }

  /** Worktrees a person may clean up, with what each still holds (ignored files included) and its fingerprint. */
  async worktreeCleanup(projectId: string, ticketId?: string): Promise<WorktreeCleanupCandidate[]> {
    return this.cleanup === undefined ? [] : this.cleanup(projectId, ticketId);
  }

  async projects(): Promise<ProjectRow[]> {
    const rows = await this.store.query<{ projectId: string; name: string; createdAt: number; root: string | null; baseRef: string | null; settings: string | null }>(
      'SELECT project_id AS projectId, name, created_at AS createdAt, root, base_ref AS baseRef, settings FROM p_projects ORDER BY created_at, project_id',
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        settings: row.settings === null ? null : (JSON.parse(row.settings) as WorkspaceSettings),
        rootIsGitRepo: row.root !== null && (await isRepositoryTop(row.root)),
      })),
    );
  }

  async tickets(projectId?: string): Promise<TicketRow[]> {
    const rows =
      projectId === undefined
        ? await this.store.query<RawTicket>('SELECT * FROM p_tickets ORDER BY created_at, ticket_id')
        : await this.store.query<RawTicket>('SELECT * FROM p_tickets WHERE project_id = ? ORDER BY created_at, ticket_id', [projectId]);
    return rows.map(toTicket);
  }

  /**
   * The project's workspace ledger: entries held now, recent refusals, changes found afterwards (by default only the
   * flagged ones: unattributed, or changed while someone else held them), overlap warnings and the engine's worktrees.
   */
  async workspace(projectId: string, options: { ticketId?: string; changes: 'flagged' | 'all'; limit: number }): Promise<WorkspaceView> {
    const byTicket = options.ticketId === undefined ? '' : ' AND ticket_id = ?';
    const params = (...extra: (string | number)[]) => [projectId, ...(options.ticketId === undefined ? [] : [options.ticketId]), ...extra];
    const checkouts = await this.store.query<Record<string, unknown>>(
      `SELECT entry_id AS id, space, path, kind, mode, ticket_id AS ticketId, node_id AS nodeId, lane, run, release, on_conflict AS onConflict,
              pause_mode AS pauseMode, priority, expires_at AS expiresAt, base_hash AS baseHash, pause_hash AS pauseHash, paused, retained,
              acquired_at AS acquiredAt
         FROM p_checkouts WHERE project_id = ?${byTicket} ORDER BY acquired_at, entry_id`,
      params(),
    );
    const blocks = await this.store.query<Record<string, unknown>>(
      `SELECT sequence, ticket_id AS ticketId, node_id AS nodeId, lane, run, space, paths, source, policy, outcome, deadlock, conflicts, at
         FROM p_checkout_blocks WHERE project_id = ?${byTicket} ORDER BY sequence DESC LIMIT ?`,
      params(options.limit),
    );
    const flagged = options.changes === 'flagged' ? " AND attribution IN ('unattributed', 'conflict')" : '';
    const changes = await this.store.query<Record<string, unknown>>(
      `SELECT sequence, space, scan, path, hash, previous, attribution, ticket_id AS ticketId, node_id AS nodeId, lane, run, suspects, at
         FROM p_workspace_changes WHERE project_id = ?${flagged}${options.ticketId === undefined ? '' : " AND (ticket_id = ? OR suspects LIKE '%' || ? || '%')"}
         ORDER BY sequence DESC, id DESC LIMIT ?`,
      options.ticketId === undefined ? [projectId, options.limit] : [projectId, options.ticketId, options.ticketId, options.limit],
    );
    const overlaps = await this.store.query<Record<string, unknown>>(
      'SELECT sequence, path, spaces, holders, at FROM p_overlap_warnings WHERE project_id = ? ORDER BY sequence DESC LIMIT ?',
      [projectId, options.limit],
    );
    const worktrees = await this.store.query<Record<string, unknown>>(
      `SELECT key, ticket_id AS ticketId, scope, node_id AS nodeId, lane, path, branch, base, created_at AS createdAt, removed_at AS removedAt,
              removed_reason AS removedReason, branch_deleted AS branchDeleted, kept_at AS keptAt, kept_reason AS keptReason, kept_files AS keptFiles, kept_count AS keptCount,
              kept_ignored AS keptIgnored, kept_ignored_count AS keptIgnoredCount, cleanup_approved_at AS cleanupApprovedAt,
              cleanup_skipped_at AS cleanupSkippedAt, cleanup_skipped_reason AS cleanupSkippedReason
         FROM p_worktrees WHERE project_id = ?${byTicket} ORDER BY created_at, key`,
      params(),
    );
    const parse = (rows: Record<string, unknown>[], columns: readonly string[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, columns.includes(key) && typeof value === 'string' ? (JSON.parse(value) as unknown) : value])));
    return {
      checkouts: checkouts.map((row) => ({ ...row, paused: row.paused === 1, retained: row.retained === 1 })),
      blocks: parse(blocks, ['paths', 'conflicts']).map((row) => ({ ...row, deadlock: row.deadlock === 1 })),
      changes: parse(changes, ['suspects']),
      overlaps: parse(overlaps, ['spaces', 'holders']),
      worktrees: parse(worktrees, ['keptFiles', 'keptIgnored']).map((row) => ({ ...row, branchDeleted: row.branchDeleted === null ? null : row.branchDeleted === 1 })),
    };
  }

  async ticket(ticketId: string): Promise<TicketDetail | undefined> {
    const row = await this.store.queryOne<RawTicket>('SELECT * FROM p_tickets WHERE ticket_id = ?', [ticketId]);
    if (row === undefined) return undefined;
    const ticket = toTicket(row);
    const lanes = await this.store.query<Record<string, unknown>>(
      `SELECT node_id AS nodeId, lane, lane_group AS laneGroup, run, status, executor, run_id AS runId, attempt,
              pause_requested AS pauseRequested, superseded_by AS supersededBy, waiting_for AS waitingFor, updated_at AS updatedAt
         FROM p_node_lanes WHERE ticket_id = ? ORDER BY node_id, lane`,
      [ticketId],
    );
    const executions = await this.store.query<Record<string, unknown>>(
      `SELECT node_id AS nodeId, run, lane, cause, status, port, item_count AS itemCount, attempts,
              activated_at AS activatedAt, started_at AS startedAt, review_at AS reviewAt, finished_at AS finishedAt,
              error, superseded_by AS supersededBy
         FROM p_node_runs WHERE ticket_id = ? ORDER BY activated_at, node_id, run`,
      [ticketId],
    );
    const runs = await this.store.query<Record<string, unknown>>(`SELECT ${RUN_COLUMNS} FROM p_runs WHERE ticket_id = ? ORDER BY started_at, run_id`, [ticketId]);
    const events = await this.store.readAggregate(ticketId);
    let state = EMPTY_TICKET;
    for (const event of events) state = evolveTicket(state, event);
    let workflow: CompiledWorkflow | undefined;
    try {
      workflow = state.template === undefined ? undefined : await this.definitions.workflow(state.template);
    } catch {
      workflow = undefined; // Changed definition files: the detail shows what the events hold.
    }
    const waitingFor = ticket.status !== 'open' ? [] : workflow === undefined ? undefined : ticketWaitReasons(state, workflow);
    const parsedLanes = lanes.map((row) => ({ ...row, waitingFor: typeof row.waitingFor === 'string' ? (JSON.parse(row.waitingFor) as unknown) : null }));
    const reviewing = lanes.filter((row) => row.status === 'review').map((row) => ({ nodeId: String(row.nodeId), lane: String(row.lane), run: Number(row.run) }));
    return {
      ticket,
      lanes: parsedLanes,
      executions,
      runs,
      ...(waitingFor === undefined ? {} : { waitingFor }),
      ...(workflow === undefined || state.template === undefined ? {} : { workflow: workflowView(workflow, state.template) }),
      reviews: reviewViews(events, reviewing, workflow),
    };
  }

  /** Active templates, the latest version of each, for choosing one when a ticket is created. */
  async templates(): Promise<TemplateSummary[]> {
    const rows = await this.store.query<{ id: string; version: number; hash: string }>(
      "SELECT id, version, hash FROM p_definitions d WHERE kind = 'template' AND status = 'active' AND version = (SELECT MAX(version) FROM p_definitions e WHERE e.kind = 'template' AND e.id = d.id AND e.status = 'active') ORDER BY id",
    );
    const summaries: TemplateSummary[] = [];
    for (const row of rows) {
      try {
        const loaded = await this.definitions.template(row.id, row.version);
        if (loaded === undefined) continue;
        summaries.push(workflowView(loaded.workflow, loaded.pin));
      } catch (error) {
        summaries.push({ id: row.id, version: row.version, hash: row.hash, name: row.id, nodes: [], edges: [], problem: (error as Error).message });
      }
    }
    return summaries;
  }

  /**
   * A project's board: its tickets with their lanes and token totals, and the workflows they pinned. One query per
   * table, so the board does not ask once per ticket.
   */
  async board(projectId: string): Promise<BoardResult> {
    const tickets = await this.tickets(projectId);
    const lanes = await this.store.query<{ ticketId: string; nodeId: string; lane: string; run: number; status: string; waitingFor: string | null; updatedAt: number }>(
      `SELECT l.ticket_id AS ticketId, l.node_id AS nodeId, l.lane, l.run, l.status, l.waiting_for AS waitingFor, l.updated_at AS updatedAt
         FROM p_node_lanes l JOIN p_tickets t ON t.ticket_id = l.ticket_id WHERE t.project_id = ? ORDER BY l.node_id, l.lane`,
      [projectId],
    );
    const usage = await this.store.query<{ ticketId: string; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }>(
      `SELECT r.ticket_id AS ticketId, SUM(r.tokens_input) AS input, SUM(r.tokens_cache_read) AS cacheRead, SUM(r.tokens_cache_write) AS cacheWrite,
              SUM(r.tokens_output) AS output, SUM(COALESCE(r.tokens_reasoning, 0)) AS reasoning
         FROM p_runs r JOIN p_tickets t ON t.ticket_id = r.ticket_id WHERE t.project_id = ? GROUP BY r.ticket_id`,
      [projectId],
    );
    const lanesBy = new Map<string, BoardTicketView['lanes'][number][]>();
    for (const row of lanes) {
      const list = lanesBy.get(row.ticketId) ?? [];
      list.push({ nodeId: row.nodeId, lane: row.lane, run: row.run, status: row.status, waitingFor: row.waitingFor === null ? null : (JSON.parse(row.waitingFor) as unknown), updatedAt: row.updatedAt });
      lanesBy.set(row.ticketId, list);
    }
    const usageBy = new Map(usage.map((row) => [row.ticketId, row]));
    const workflows: Record<string, WorkflowView> = {};
    for (const ticket of tickets) {
      const pin = ticket.template;
      if (pin === null) continue;
      const key = `${pin.id}@${pin.version}`;
      if (Object.hasOwn(workflows, key)) continue;
      try {
        // Versions never change content, so the active version with the same hash is what the ticket pinned.
        const loaded = await this.definitions.template(pin.id, pin.version);
        if (loaded !== undefined && loaded.pin.hash === pin.hash) workflows[key] = workflowView(loaded.workflow, loaded.pin);
      } catch {
        // Files no longer match: the board falls back to the lanes it has.
      }
    }
    return {
      tickets: tickets.map((ticket): BoardTicketView => {
        const totals = usageBy.get(ticket.ticketId);
        return {
          ticketId: ticket.ticketId,
          projectId: ticket.projectId,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          template: ticket.template,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          completedAt: ticket.completedAt,
          revision: ticket.revision,
          attention: ticket.attention,
          lanes: lanesBy.get(ticket.ticketId) ?? [],
          tokens: {
            input: totals?.input ?? 0,
            cacheRead: totals?.cacheRead ?? 0,
            cacheWrite: totals?.cacheWrite ?? 0,
            output: totals?.output ?? 0,
            reasoning: totals?.reasoning ?? 0,
          },
        };
      }),
      workflows,
    };
  }

  async artifacts(ticketId: string, nodeId?: string): Promise<ArtifactRow[]> {
    const rows = await this.store.query<Omit<ArtifactRow, 'current'>>(
      `SELECT node_id AS nodeId, slot, kind, uri, version, title, mime_type AS mimeType, content_hash AS contentHash, source,
              lane, run_id AS runId, exec_run AS execution, item, added_at AS addedAt, sequence
         FROM p_artifacts WHERE ticket_id = ?${nodeId === undefined ? '' : ' AND node_id = ?'} ORDER BY sequence, id`,
      nodeId === undefined ? [ticketId] : [ticketId, nodeId],
    );
    // Registrations are always listed. An output is listed only when no earlier entry has the same location and
    // version: a node that hands on what it received (a join, an end node, a reviewer) adds no new artifact.
    const seen = new Set(rows.filter((row) => row.source === 'added').map((row) => artifactKey(row)));
    const kept = rows.filter((row) => {
      if (row.source === 'added') return true;
      const key = artifactKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const latest = new Map<string, number>();
    kept.forEach((row, index) => latest.set(`${row.nodeId}\u0000${row.lane ?? ''}\u0000${row.slot}`, index));
    return kept.map((row, index) => ({ ...row, current: latest.get(`${row.nodeId}\u0000${row.lane ?? ''}\u0000${row.slot}`) === index }));
  }

  async ticketStats(ticketId: string): Promise<TicketStats | undefined> {
    const ticketEvents = await this.store.readAggregate(ticketId);
    if (ticketEvents[0]?.type !== 'ticket.created') return undefined;
    const runIds = await this.store.query<{ run_id: string }>('SELECT run_id FROM p_runs WHERE ticket_id = ? ORDER BY started_at', [ticketId]);
    const runEvents: DomainEvent[] = [];
    for (const { run_id: runId } of runIds) runEvents.push(...(await this.store.readAggregate(runId)));
    runEvents.sort((a, b) => a.sequence - b.sequence);
    const template = ticketEvents[0].data.template;
    const nodeKinds = template === undefined ? undefined : await this.nodeKinds(template);
    return computeTicketStats({ ticketId, ticketEvents, runEvents, ...(nodeKinds === undefined ? {} : { nodeKinds }), asOf: this.clock.now() });
  }

  private async nodeKinds(pin: PinnedTemplate): Promise<Record<string, NodeKind> | undefined> {
    try {
      const workflow = await this.definitions.workflow(pin);
      return Object.fromEntries([...workflow.nodes.values()].map((node) => [node.id, node.completion]));
    } catch {
      return undefined; // Changed definition files: the stats fall back to what the events show.
    }
  }

}

/**
 * What each lane in review asks the person to decide: the output a review gate holds (from its last
 * `node.reviewRequested`), or the input of a human node (from its activation).
 */
function reviewViews(events: readonly DomainEvent[], reviewing: readonly { nodeId: string; lane: string; run: number }[], workflow: CompiledWorkflow | undefined): ReviewView[] {
  if (reviewing.length === 0) return [];
  const key = (nodeId: string, run: number) => `${nodeId}\u0000${run}`;
  const wanted = new Set(reviewing.map((entry) => key(entry.nodeId, entry.run)));
  const activations = new Map<string, Extract<DomainEvent, { type: 'node.activated' }>>();
  const held = new Map<string, Extract<DomainEvent, { type: 'node.reviewRequested' }>>();
  for (const event of events) {
    if (event.type === 'node.activated' && wanted.has(key(event.data.nodeId, event.data.run))) activations.set(key(event.data.nodeId, event.data.run), event);
    if (event.type === 'node.reviewRequested' && wanted.has(key(event.data.nodeId, event.data.run))) held.set(key(event.data.nodeId, event.data.run), event);
  }
  return reviewing.map((entry): ReviewView => {
    const activation = activations.get(key(entry.nodeId, entry.run));
    const gate = held.get(key(entry.nodeId, entry.run));
    const feedback = activation?.data.feedback?.comment;
    const base = { nodeId: entry.nodeId, lane: entry.lane, run: entry.run, ...(feedback === undefined ? {} : { feedback }) };
    if (gate !== undefined) {
      return {
        ...base,
        kind: 'gate',
        output: { port: gate.data.output.port, items: gate.data.output.items.map(itemView) },
        ...(gate.data.reason === undefined ? {} : { reason: gate.data.reason }),
        ...(gate.data.merge === undefined ? {} : { merge: gate.data.merge }),
      };
    }
    const outputs = workflow?.nodes.get(entry.nodeId)?.outputs;
    const approval = outputs !== undefined && outputs.has('approve') && outputs.has('reject');
    return { ...base, kind: approval ? 'approval' : 'task', inputs: Object.values(activation?.data.inputs ?? {}).flat().map(itemView) };
  });
}

function itemView(item: HandoffItem): ItemView {
  const artifacts =
    item.artifacts === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(item.artifacts).map(([slot, ref]) => [
            slot,
            { kind: ref.kind, uri: ref.uri, ...(ref.version === undefined ? {} : { version: ref.version }), ...(ref.title === undefined ? {} : { title: ref.title }) },
          ]),
        );
  return {
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(Object.keys(item.data).length === 0 ? {} : { data: item.data }),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

function artifactKey(row: Pick<ArtifactRow, 'kind' | 'uri' | 'version'>): string {
  return [row.kind, row.uri, row.version ?? ''].join('\u0000');
}

function toTicket(row: RawTicket): TicketRow {
  return {
    ticketId: row.ticket_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    template:
      row.template_id === null || row.template_version === null || row.template_hash === null
        ? null
        : { id: row.template_id, version: row.template_version, hash: row.template_hash },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    revision: row.revision,
    attention: row.attention,
  };
}
