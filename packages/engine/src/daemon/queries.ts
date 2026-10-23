import type { DomainEvent, PinnedTemplate, TicketStats } from '@vuyro/contracts';
import type { Clock } from '../runtime/clock.ts';
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

  constructor(options: { store: EventStore; definitions: DefinitionResolver; clock: Clock }) {
    this.store = options.store;
    this.definitions = options.definitions;
    this.clock = options.clock;
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

  async ticket(ticketId: string): Promise<TicketDetail | undefined> {
    const row = await this.store.queryOne<RawTicket>('SELECT * FROM p_tickets WHERE ticket_id = ?', [ticketId]);
    if (row === undefined) return undefined;
    const ticket = toTicket(row);
    const lanes = await this.store.query<Record<string, unknown>>(
      `SELECT node_id AS nodeId, lane, lane_group AS laneGroup, run, status, executor, run_id AS runId, attempt,
              pause_requested AS pauseRequested, superseded_by AS supersededBy, updated_at AS updatedAt
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
    return { ticket, lanes, executions, runs, ...(waitingFor === undefined ? {} : { waitingFor }) };
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
