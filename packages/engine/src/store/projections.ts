import { type DomainEvent, isRetiredEvent } from '@vuyro/contracts';
import type { SqliteStatement } from '../db/sqlite-worker-protocol.ts';

/**
 * A projection keeps query tables in step with the log. `apply` must be a pure function of the
 * event: the store runs its statements in the same transaction as the append, and replays the
 * whole log through it to rebuild. Bump `version` whenever `ddl` or `apply` changes.
 */
export interface Projector {
  readonly name: string;
  readonly version: number;
  /** Tables this projector owns (dropped on rebuild). */
  readonly tables: readonly string[];
  readonly ddl: readonly string[];
  apply(event: DomainEvent): SqliteStatement[];
}

const projects: Projector = {
  name: 'projects',
  version: 2,
  tables: ['p_projects', 'p_app_settings'],
  ddl: [
    `CREATE TABLE p_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      root TEXT,
      base_ref TEXT,
      watch TEXT,
      settings TEXT
    ) STRICT`,
    `CREATE TABLE p_app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  ],
  apply(event) {
    if (event.type === 'app.configured') {
      return [
        {
          sql: 'INSERT INTO p_app_settings (id, settings, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at',
          params: [JSON.stringify(event.data.settings), event.timestamp],
        },
      ];
    }
    if (event.type === 'project.configured') {
      const { data } = event;
      // Absent = unchanged, null = cleared.
      const column = (name: string, value: unknown, json = false): SqliteStatement[] =>
        value === undefined
          ? []
          : [{ sql: `UPDATE p_projects SET ${name} = ?, revision = ? WHERE project_id = ?`, params: [value === null ? null : json ? JSON.stringify(value) : (value as string), event.revision, data.projectId] }];
      return [...column('root', data.root), ...column('base_ref', data.baseRef), ...column('watch', data.watch, true), ...column('settings', data.settings, true)];
    }
    if (event.type !== 'project.created') return [];
    return [
      {
        sql: 'INSERT INTO p_projects (project_id, name, created_at, revision) VALUES (?, ?, ?, ?)',
        params: [event.data.projectId, event.data.name, event.timestamp, event.revision],
      },
    ];
  },
};

const tickets: Projector = {
  name: 'tickets',
  version: 4,
  tables: ['p_tickets', 'p_artifacts'],
  ddl: [
    `CREATE TABLE p_tickets (
      ticket_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      template_id TEXT,
      template_version INTEGER,
      template_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      revision INTEGER NOT NULL,
      attention TEXT
    ) STRICT`,
    'CREATE INDEX p_tickets_by_project ON p_tickets (project_id)',
    // Artifact registry (location + version): every registration (`artifact.add`, source 'added') and every
    // artifact a finished execution handed on (source 'output', with its run and item) is kept.
    `CREATE TABLE p_artifacts (
      id INTEGER PRIMARY KEY,
      sequence INTEGER NOT NULL,
      source TEXT NOT NULL,
      exec_run INTEGER,
      item INTEGER,
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      version TEXT,
      title TEXT,
      mime_type TEXT,
      content_hash TEXT,
      run_id TEXT,
      lane TEXT,
      added_at INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_artifacts_by_slot ON p_artifacts (ticket_id, node_id, slot, sequence)',
  ],
  apply(event) {
    const statements = ticketStatements(event);
    // A ticket with events in a retired format needs attention: the engine does not carry it on (§6).
    if (event.aggregateType !== 'ticket' || !isRetiredEvent(event)) return statements;
    return [...statements, { sql: "UPDATE p_tickets SET attention = COALESCE(attention, 'legacy-events') WHERE ticket_id = ?", params: [event.aggregateId] }];
  },
};

function ticketStatements(event: DomainEvent): SqliteStatement[] {
  switch (event.type) {
    case 'ticket.created':
      return [
        {
          sql: `INSERT INTO p_tickets
                  (ticket_id, project_id, title, description, status, template_id, template_version, template_hash,
                   created_at, updated_at, revision)
                VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
          params: [
            event.data.ticketId,
            event.data.projectId,
            event.data.title,
            event.data.description ?? null,
            event.data.template?.id ?? null,
            event.data.template?.version ?? null,
            event.data.template?.hash ?? null,
            event.timestamp,
            event.timestamp,
            event.revision,
          ],
        },
      ];
    case 'ticket.updated':
      return [
        {
          sql: `UPDATE p_tickets SET
                  title = COALESCE(?, title),
                  description = CASE WHEN ? THEN ? ELSE description END,
                  updated_at = ?, revision = ?
                WHERE ticket_id = ?`,
          params: [
            event.data.title ?? null,
            event.data.description === undefined ? 0 : 1,
            event.data.description ?? null,
            event.timestamp,
            event.revision,
            event.data.ticketId,
          ],
        },
      ];
    case 'artifact.added': {
      const { ref } = event.data;
      return [
        { sql: 'UPDATE p_tickets SET updated_at = ?, revision = ? WHERE ticket_id = ?', params: [event.timestamp, event.revision, event.data.ticketId] },
        {
          sql: `INSERT INTO p_artifacts
                  (sequence, source, ticket_id, node_id, slot, kind, uri, version, title, mime_type, content_hash, run_id, lane, added_at)
                VALUES (?, 'added', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            event.sequence,
            event.data.ticketId,
            event.data.nodeId,
            event.data.slot,
            ref.kind,
            ref.uri,
            ref.version ?? null,
            ref.title ?? null,
            ref.mimeType ?? null,
            ref.contentHash ?? null,
            event.data.runId ?? null,
            event.data.lane ?? null,
            event.timestamp,
          ],
        },
      ];
    }
    case 'node.completed': {
      const { data } = event;
      return [
        { sql: 'UPDATE p_tickets SET updated_at = ?, revision = ? WHERE ticket_id = ?', params: [event.timestamp, event.revision, event.aggregateId] },
        ...data.output.items.flatMap((item, index) =>
          Object.entries(item.artifacts ?? {}).map(([slot, ref]) => ({
            sql: `INSERT INTO p_artifacts
                    (sequence, source, exec_run, item, ticket_id, node_id, slot, kind, uri, version, title, mime_type, content_hash, lane, added_at)
                  VALUES (?, 'output', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              event.sequence,
              data.run,
              index,
              data.ticketId,
              data.nodeId,
              slot,
              ref.kind,
              ref.uri,
              ref.version ?? null,
              ref.title ?? null,
              ref.mimeType ?? null,
              ref.contentHash ?? null,
              data.lane,
              event.timestamp,
            ],
          })),
        ),
      ];
    }
    case 'ticket.completed':
      return [
        {
          sql: "UPDATE p_tickets SET status = 'done', completed_at = ?, updated_at = ?, revision = ? WHERE ticket_id = ?",
          params: [event.timestamp, event.timestamp, event.revision, event.data.ticketId],
        },
      ];
    default:
      // Every other ticket event moves the revision too (the UI uses it for optimistic concurrency).
      if (event.aggregateType !== 'ticket') return [];
      return [
        { sql: 'UPDATE p_tickets SET updated_at = ?, revision = ? WHERE ticket_id = ?', params: [event.timestamp, event.revision, event.aggregateId] },
      ];
  }
}

type LaneKey = { readonly ticketId: string; readonly nodeId: string; readonly lane: string; readonly run: number };

/**
 * Node progress for boards and stats: one row per lane (its current run) and one per execution
 * (activated, started, reviewed, finished; port and error). No row for a node means it is waiting.
 * `superseded_by` says why an execution was cut short: 'new-input' (newer input for its lane) or 'replaced' (a
 * new plan replaced its generation). A lane row keeps it while that execution is the lane's last one.
 */
const nodes: Projector = {
  name: 'nodes',
  version: 4,
  tables: ['p_node_lanes', 'p_node_runs'],
  ddl: [
    `CREATE TABLE p_node_lanes (
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      lane_group TEXT,
      run INTEGER NOT NULL,
      status TEXT NOT NULL,
      executor TEXT,
      run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      pause_requested INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      waiting_for TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, node_id, lane)
    ) STRICT`,
    'CREATE INDEX p_node_lanes_by_status ON p_node_lanes (status, updated_at)',
    `CREATE TABLE p_node_runs (
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      run INTEGER NOT NULL,
      lane TEXT NOT NULL,
      cause TEXT NOT NULL,
      status TEXT NOT NULL,
      port TEXT,
      item_count INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      activated_at INTEGER NOT NULL,
      started_at INTEGER,
      review_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      superseded_by TEXT,
      PRIMARY KEY (ticket_id, node_id, run)
    ) STRICT`,
  ],
  apply(event) {
    // Lane rows follow the lane's current run only; an event about an older run leaves them alone.
    const lane = (set: string, params: (string | number | null)[], key: LaneKey): SqliteStatement => ({
      sql: `UPDATE p_node_lanes SET ${set}, updated_at = ? WHERE ticket_id = ? AND node_id = ? AND lane = ? AND run = ?`,
      params: [...params, event.timestamp, key.ticketId, key.nodeId, key.lane, key.run],
    });
    const run = (set: string, params: (string | number | null)[], key: Omit<LaneKey, 'lane'>): SqliteStatement => ({
      sql: `UPDATE p_node_runs SET ${set} WHERE ticket_id = ? AND node_id = ? AND run = ?`,
      params: [...params, key.ticketId, key.nodeId, key.run],
    });
    switch (event.type) {
      case 'node.activated': {
        const { data } = event;
        const statements: SqliteStatement[] = [];
        if (data.supersedes !== undefined) {
          statements.push(run("status = 'superseded', superseded_by = 'new-input', finished_at = ?", [event.timestamp], { ...data, run: data.supersedes }));
        }
        statements.push(
          {
            sql: `INSERT INTO p_node_lanes (ticket_id, node_id, lane, lane_group, run, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (ticket_id, node_id, lane) DO UPDATE SET
                    lane_group = COALESCE(excluded.lane_group, lane_group), run = excluded.run, status = excluded.status,
                    executor = NULL, run_id = NULL, attempt = 0, pause_requested = 0, superseded_by = NULL, waiting_for = NULL,
                    updated_at = excluded.updated_at`,
            params: [data.ticketId, data.nodeId, data.lane, data.group ?? null, data.run, data.status, event.timestamp],
          },
          {
            sql: 'INSERT INTO p_node_runs (ticket_id, node_id, run, lane, cause, status, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            params: [data.ticketId, data.nodeId, data.run, data.lane, data.cause, data.status, event.timestamp],
          },
        );
        return statements;
      }
      case 'node.started':
        return [
          lane("status = 'running', executor = ?, run_id = ?, attempt = ?", [event.data.executor, event.data.runId ?? null, event.data.attempt], event.data),
          run("status = 'running', attempts = ?, started_at = COALESCE(started_at, ?)", [event.data.attempt, event.timestamp], event.data),
        ];
      case 'node.reviewRequested':
        return [
          lane("status = 'review'", [], event.data),
          run("status = 'review', port = ?, item_count = ?, review_at = ?", [event.data.output.port, event.data.output.items.length, event.timestamp], event.data),
        ];
      case 'node.returned':
        return [run("status = 'discarded', finished_at = ?", [event.timestamp], event.data)];
      case 'node.superseded':
        // A new plan replaced its generation: nothing will come of it. The lane shows 'wait' (as laneStatus does) and why.
        return [
          lane("status = 'wait', superseded_by = ?", [event.data.reason], event.data),
          run("status = 'superseded', superseded_by = ?, finished_at = ?", [event.data.reason, event.timestamp], event.data),
        ];
      case 'node.completed':
        return [
          lane('status = ?', [event.data.status], event.data),
          run('status = ?, port = ?, item_count = ?, finished_at = ?, error = ?', [
            event.data.status,
            event.data.output.port,
            event.data.output.items.length,
            event.timestamp,
            event.data.error ?? null,
          ], event.data),
        ];
      case 'node.requeued':
        return [lane("status = 'queued', run_id = NULL", [], event.data), run("status = 'queued'", [], event.data)];
      case 'node.pauseRequested':
        return [lane('pause_requested = 1', [], event.data)];
      case 'node.paused':
        // `waiting_for`: the claim it waits for (who holds which paths), so boards can say why it paused.
        return [
          lane("status = 'paused', pause_requested = 0, waiting_for = ?", [event.data.claim === undefined ? null : JSON.stringify(event.data.claim)], event.data),
          run("status = 'paused'", [], event.data),
        ];
      case 'node.resumed':
        return [lane('status = ?, pause_requested = 0, waiting_for = NULL', [event.data.status], event.data), run('status = ?', [event.data.status], event.data)];
      default:
        return [];
    }
  },
};

const definitions: Projector = {
  name: 'definitions',
  version: 1,
  tables: ['p_definitions'],
  ddl: [
    `CREATE TABLE p_definitions (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      staged_at INTEGER NOT NULL,
      activated_at INTEGER,
      reason TEXT,
      PRIMARY KEY (kind, id, version)
    ) STRICT`,
  ],
  apply(event) {
    switch (event.type) {
      case 'definition.staged':
        return [
          {
            sql: `INSERT INTO p_definitions (kind, id, version, hash, name, status, staged_at) VALUES (?, ?, ?, ?, ?, 'staged', ?)
                  ON CONFLICT (kind, id, version) DO UPDATE SET
                    hash = excluded.hash, name = excluded.name, status = 'staged', staged_at = excluded.staged_at,
                    activated_at = NULL, reason = NULL`,
            params: [event.data.kind, event.data.id, event.data.version, event.data.hash, event.data.name, event.timestamp],
          },
        ];
      case 'definition.activated':
        return [
          {
            sql: "UPDATE p_definitions SET status = 'active', activated_at = ? WHERE kind = ? AND id = ? AND version = ?",
            params: [event.timestamp, event.data.kind, event.data.id, event.data.version],
          },
        ];
      case 'definition.abandoned':
        return [
          {
            sql: "UPDATE p_definitions SET status = 'abandoned', reason = ? WHERE kind = ? AND id = ? AND version = ?",
            params: [event.data.reason, event.data.kind, event.data.id, event.data.version],
          },
        ];
      default:
        return [];
    }
  },
};

const runs: Projector = {
  name: 'runs',
  version: 1,
  tables: ['p_runs'],
  ddl: [
    `CREATE TABLE p_runs (
      run_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      resumed_from_run_id TEXT,
      provider_session_id TEXT,
      model TEXT,
      started_at INTEGER NOT NULL,
      settled_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      terminal_reason TEXT,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      cost_basis TEXT,
      messages INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_errors INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_runs_by_node ON p_runs (ticket_id, node_id, started_at)',
  ],
  apply(event) {
    const touch = (set: string, params: (string | number | null)[]): SqliteStatement => ({
      sql: `UPDATE p_runs SET ${set}${set === '' ? '' : ', '}revision = ? WHERE run_id = ?`,
      params: [...params, event.revision, event.aggregateId],
    });
    switch (event.type) {
      case 'run.started':
        return [
          {
            sql: `INSERT INTO p_runs (run_id, ticket_id, node_id, provider, status, token_hash, resumed_from_run_id, started_at, revision)
                  VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
            params: [
              event.data.runId,
              event.data.ticketId,
              event.data.nodeId,
              event.data.provider,
              event.data.tokenHash,
              event.data.resumedFromRunId ?? null,
              event.timestamp,
              event.revision,
            ],
          },
        ];
      case 'run.sessionIdentified':
        return [touch('provider_session_id = ?, model = COALESCE(?, model)', [event.data.providerSessionId, event.data.model ?? null])];
      case 'run.messageRecorded':
        return [touch('messages = messages + 1', [])];
      case 'run.toolCallStarted':
        return [touch('tool_calls = tool_calls + 1', [])];
      case 'run.toolCallFinished':
        return [touch('tool_errors = tool_errors + ?', [event.data.isError === true ? 1 : 0])];
      case 'run.warningRecorded':
        return [touch('warnings = warnings + 1', [])];
      case 'run.rawRecorded':
        return [touch('', [])];
      case 'run.usageRecorded': {
        const { tokens, cost } = event.data;
        const values = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.reasoning ?? 0];
        // 'run' usage is the final total (Claude result.usage) and replaces; 'turn' usage (Codex) adds up.
        if (event.data.scope === 'run') {
          return [
            touch(
              `tokens_input = ?, tokens_cache_read = ?, tokens_cache_write = ?, tokens_output = ?, tokens_reasoning = ?,
               cost_usd = COALESCE(?, cost_usd), cost_basis = COALESCE(?, cost_basis), model = COALESCE(?, model)`,
              [...values, cost?.usd ?? null, cost?.basis ?? null, event.data.model ?? null],
            ),
          ];
        }
        return [
          touch(
            `tokens_input = tokens_input + ?, tokens_cache_read = tokens_cache_read + ?,
             tokens_cache_write = tokens_cache_write + ?, tokens_output = tokens_output + ?,
             tokens_reasoning = tokens_reasoning + ?,
             cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ? END,
             cost_basis = COALESCE(?, cost_basis), model = COALESCE(?, model)`,
            [...values, cost?.usd ?? null, cost?.usd ?? null, cost?.basis ?? null, event.data.model ?? null],
          ),
        ];
      }
      case 'run.settled':
        return [
          touch('status = ?, settled_at = ?, exit_code = ?, signal = ?, terminal_reason = ?', [
            event.data.outcome,
            event.timestamp,
            event.data.exitCode ?? null,
            event.data.signal ?? null,
            event.data.terminalReason ?? null,
          ]),
        ];
      default:
        return [];
    }
  },
};

const permissions: Projector = {
  name: 'permissions',
  version: 1,
  tables: ['p_permission_rules'],
  ddl: [
    `CREATE TABLE p_permission_rules (
      scope_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      rule TEXT NOT NULL,
      PRIMARY KEY (scope_key, position)
    ) STRICT`,
  ],
  apply(event) {
    if (event.type !== 'permission.rulesChanged') return [];
    const scopeKey = event.data.scope === 'app' ? 'app' : `project:${event.data.projectId ?? ''}`;
    return [
      { sql: 'DELETE FROM p_permission_rules WHERE scope_key = ?', params: [scopeKey] },
      ...event.data.rules.map((rule, position) => ({
        sql: 'INSERT INTO p_permission_rules (scope_key, position, rule) VALUES (?, ?, ?)',
        params: [scopeKey, position, JSON.stringify(rule)],
      })),
    ];
  },
};

const audit: Projector = {
  name: 'audit',
  version: 1,
  tables: ['p_command_denials'],
  ddl: [
    `CREATE TABLE p_command_denials (
      sequence INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      code TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      ticket_id TEXT,
      node_id TEXT,
      timestamp INTEGER NOT NULL
    ) STRICT`,
  ],
  apply(event) {
    if (event.type !== 'command.denied') return [];
    return [
      {
        sql: `INSERT INTO p_command_denials
                (sequence, request_id, command_type, code, reason, actor_kind, actor, ticket_id, node_id, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.sequence,
          event.data.requestId,
          event.data.commandType,
          event.data.code,
          event.data.reason,
          event.actor.kind,
          JSON.stringify(event.actor),
          event.data.ticketId ?? null,
          event.data.nodeId ?? null,
          event.timestamp,
        ],
      },
    ];
  },
};

/**
 * The workspace ledger (M4): entries held now, refused requests, changes found afterwards (unattributed ones are what
 * screens flag), overlap warnings and the engine's worktrees.
 */
const workspace: Projector = {
  name: 'workspace',
  version: 3,
  tables: ['p_checkouts', 'p_checkout_blocks', 'p_workspace_changes', 'p_overlap_warnings', 'p_worktrees'],
  ddl: [
    `CREATE TABLE p_checkouts (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      space TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      run INTEGER NOT NULL,
      release TEXT NOT NULL,
      on_conflict TEXT NOT NULL,
      pause_mode TEXT NOT NULL,
      priority INTEGER NOT NULL,
      expires_at INTEGER,
      base_hash TEXT,
      pause_hash TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      retained INTEGER NOT NULL DEFAULT 0,
      acquired_at INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_checkouts_by_project ON p_checkouts (project_id, space, path)',
    'CREATE INDEX p_checkouts_by_ticket ON p_checkouts (ticket_id, node_id, lane)',
    `CREATE TABLE p_checkout_blocks (
      sequence INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      run INTEGER NOT NULL,
      space TEXT NOT NULL,
      paths TEXT NOT NULL,
      source TEXT NOT NULL,
      policy TEXT NOT NULL,
      outcome TEXT NOT NULL,
      deadlock INTEGER NOT NULL,
      conflicts TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_checkout_blocks_by_project ON p_checkout_blocks (project_id, sequence)',
    `CREATE TABLE p_workspace_changes (
      id INTEGER PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      space TEXT NOT NULL,
      scan TEXT NOT NULL,
      path TEXT NOT NULL,
      hash TEXT,
      previous TEXT,
      attribution TEXT NOT NULL,
      ticket_id TEXT,
      node_id TEXT,
      lane TEXT,
      run INTEGER,
      suspects TEXT,
      at INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_workspace_changes_by_project ON p_workspace_changes (project_id, attribution, sequence)',
    'CREATE INDEX p_workspace_changes_by_ticket ON p_workspace_changes (ticket_id, sequence)',
    `CREATE TABLE p_overlap_warnings (
      sequence INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      spaces TEXT NOT NULL,
      holders TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE p_worktrees (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      node_id TEXT,
      lane TEXT,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER,
      removed_reason TEXT,
      branch_deleted INTEGER,
      kept_at INTEGER,
      kept_reason TEXT,
      kept_files TEXT,
      kept_count INTEGER,
      kept_ignored TEXT,
      kept_ignored_count INTEGER,
      cleanup_approved_at INTEGER,
      cleanup_skipped_at INTEGER,
      cleanup_skipped_reason TEXT,
      PRIMARY KEY (project_id, key)
    ) STRICT`,
  ],
  apply(event) {
    switch (event.type) {
      case 'checkout.acquired':
        return event.data.entries.map((entry) => ({
          sql: `INSERT INTO p_checkouts
                  (entry_id, project_id, space, path, kind, mode, ticket_id, node_id, lane, run, release, on_conflict, pause_mode,
                   priority, expires_at, base_hash, acquired_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            entry.id,
            event.data.projectId,
            entry.space,
            entry.path,
            entry.kind,
            entry.mode,
            entry.holder.ticketId,
            entry.holder.nodeId,
            entry.holder.lane,
            entry.holder.run,
            entry.release,
            entry.onConflict,
            entry.pauseMode,
            entry.priority,
            entry.expiresAt ?? null,
            entry.baseHash ?? null,
            event.timestamp,
          ],
        }));
      case 'checkout.released':
        return event.data.ids.map((id) => ({ sql: 'DELETE FROM p_checkouts WHERE entry_id = ?', params: [id] }));
      case 'checkout.retained':
        return event.data.ids.map((id) => ({ sql: 'UPDATE p_checkouts SET retained = 1 WHERE entry_id = ?', params: [id] }));
      case 'checkout.paused':
        return Object.entries(event.data.hashes).map(([id, hash]) => ({ sql: 'UPDATE p_checkouts SET pause_hash = ?, paused = 1 WHERE entry_id = ?', params: [hash, id] }));
      case 'checkout.resumed': {
        const { holder } = event.data;
        return [
          {
            sql: 'UPDATE p_checkouts SET pause_hash = NULL, paused = 0 WHERE ticket_id = ? AND node_id = ? AND lane = ? AND run = ?',
            params: [holder.ticketId, holder.nodeId, holder.lane, holder.run],
          },
        ];
      }
      case 'checkout.blocked': {
        const { data } = event;
        return [
          {
            sql: `INSERT INTO p_checkout_blocks
                    (sequence, project_id, ticket_id, node_id, lane, run, space, paths, source, policy, outcome, deadlock, conflicts, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              event.sequence,
              data.projectId,
              data.requester.ticketId,
              data.requester.nodeId,
              data.requester.lane,
              data.requester.run,
              data.space,
              JSON.stringify(data.paths),
              data.source,
              data.policy,
              data.outcome,
              data.deadlock === true ? 1 : 0,
              JSON.stringify(data.conflicts),
              event.timestamp,
            ],
          },
        ];
      }
      case 'workspace.changesDetected':
        return event.data.changes.map((change) => ({
          sql: `INSERT INTO p_workspace_changes
                  (sequence, project_id, space, scan, path, hash, previous, attribution, ticket_id, node_id, lane, run, suspects, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            event.sequence,
            event.data.projectId,
            event.data.space,
            event.data.scan,
            change.path,
            change.hash,
            change.previous ?? null,
            change.attribution,
            change.holder?.ticketId ?? null,
            change.holder?.nodeId ?? null,
            change.holder?.lane ?? null,
            change.holder?.run ?? null,
            change.suspects === undefined ? null : JSON.stringify(change.suspects),
            event.timestamp,
          ],
        }));
      case 'workspace.overlapWarned':
        return [
          {
            sql: 'INSERT INTO p_overlap_warnings (sequence, project_id, path, spaces, holders, at) VALUES (?, ?, ?, ?, ?, ?)',
            params: [event.sequence, event.data.projectId, event.data.path, JSON.stringify(event.data.spaces), JSON.stringify(event.data.holders), event.timestamp],
          },
        ];
      case 'worktree.created': {
        const { worktree } = event.data;
        return [
          {
            sql: `INSERT INTO p_worktrees (project_id, key, ticket_id, scope, node_id, lane, path, branch, base, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (project_id, key) DO UPDATE SET
                    path = excluded.path, branch = excluded.branch, base = excluded.base, created_at = excluded.created_at,
                    removed_at = NULL, removed_reason = NULL, branch_deleted = NULL, kept_at = NULL, kept_reason = NULL, kept_files = NULL, kept_count = NULL, kept_ignored = NULL, kept_ignored_count = NULL,
                    cleanup_approved_at = NULL, cleanup_skipped_at = NULL, cleanup_skipped_reason = NULL`,
            params: [
              event.data.projectId,
              worktree.key,
              worktree.ticketId,
              worktree.scope,
              worktree.nodeId ?? null,
              worktree.lane ?? null,
              worktree.path,
              worktree.branch,
              worktree.base,
              event.timestamp,
            ],
          },
        ];
      }
      case 'worktree.kept':
        return [
          {
            sql: 'UPDATE p_worktrees SET kept_at = ?, kept_reason = ?, kept_files = ?, kept_count = ?, kept_ignored = ?, kept_ignored_count = ? WHERE project_id = ? AND key = ?',
            params: [
              event.timestamp,
              event.data.reason,
              JSON.stringify(event.data.files),
              event.data.count,
              JSON.stringify(event.data.ignored ?? []),
              event.data.ignoredCount ?? 0,
              event.data.projectId,
              event.data.key,
            ],
          },
        ];
      case 'worktree.cleanupApproved':
        return [{ sql: 'UPDATE p_worktrees SET cleanup_approved_at = ? WHERE project_id = ? AND key = ?', params: [event.timestamp, event.data.projectId, event.data.key] }];
      case 'worktree.cleanupSkipped':
        return [
          {
            sql: 'UPDATE p_worktrees SET cleanup_skipped_at = ?, cleanup_skipped_reason = ? WHERE project_id = ? AND key = ?',
            params: [event.timestamp, event.data.reason, event.data.projectId, event.data.key],
          },
        ];
      case 'worktree.removed':
        return [
          {
            sql: 'UPDATE p_worktrees SET removed_at = ?, removed_reason = ?, branch_deleted = ?, kept_at = NULL, kept_files = NULL, kept_count = NULL WHERE project_id = ? AND key = ?',
            params: [event.timestamp, event.data.reason, event.data.branchDeleted ? 1 : 0, event.data.projectId, event.data.key],
          },
        ];
      default:
        return [];
    }
  },
};

export const BUILTIN_PROJECTORS: readonly Projector[] = [projects, tickets, nodes, runs, permissions, audit, definitions, workspace];

/** Identifies the projection set; a mismatch with the stored value triggers a rebuild. */
export function projectionVersion(projectors: readonly Projector[]): string {
  return projectors.map((projector) => `${projector.name}@${projector.version}`).join(',');
}
