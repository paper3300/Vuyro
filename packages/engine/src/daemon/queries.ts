import type { DomainEvent, PinnedTemplate, SharedNodeView, TicketStats, WorktreeCleanupCandidate } from '@vuyro/contracts';
import type { Clock } from '../runtime/clock.ts';
import { currentDefinition, EMPTY_SHARED_NODE, evolveSharedNode, runningBatches } from '../shared/state.ts';
import { computeTicketStats, type NodeKind } from '../stats/ticket-stats.ts';
import type { EventStore } from '../store/event-store.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';
import { ticketWaitReasons, type WaitReason } from '../workflow/machine.ts';
import { EMPTY_TICKET, evolveTicket } from '../workflow/state.ts';

/**
 * Read side of the daemon: what screens and the CLI ask for. Everything comes from the projections and the
 * log on the read-only worker; nothing here changes state. Statistics are computed from the events.
 */

export interface ProjectRow {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface TicketRow {
  readonly ticketId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
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
}

interface RawTicket {
  ticket_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
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

  constructor(options: {
    store: EventStore;
    definitions: DefinitionResolver;
    clock: Clock;
    /** The engine's view of worktrees a person may clean up (it reads the worktrees on disk). */
    cleanup?: (projectId: string, ticketId?: string) => Promise<WorktreeCleanupCandidate[]>;
  }) {
    this.store = options.store;
    this.definitions = options.definitions;
    this.clock = options.clock;
    this.cleanup = options.cleanup;
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
    return this.store.query<ProjectRow>('SELECT project_id AS projectId, name, created_at AS createdAt FROM p_projects ORDER BY created_at, project_id');
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
    const waitingFor = await this.waitReasons(ticketId, ticket);
    const parsedLanes = lanes.map((row) => ({ ...row, waitingFor: typeof row.waitingFor === 'string' ? (JSON.parse(row.waitingFor) as unknown) : null }));
    return { ticket, lanes: parsedLanes, executions, runs, ...(waitingFor === undefined ? {} : { waitingFor }) };
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

  private async waitReasons(ticketId: string, ticket: TicketRow): Promise<WaitReason[] | undefined> {
    if (ticket.status !== 'open') return [];
    const events = await this.store.readAggregate(ticketId);
    let state = EMPTY_TICKET;
    for (const event of events) state = evolveTicket(state, event);
    if (state.template === undefined) return undefined;
    try {
      return ticketWaitReasons(state, await this.definitions.workflow(state.template));
    } catch {
      return undefined;
    }
  }
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
