import type { DomainEvent } from '@vuyro/contracts';
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
  version: 1,
  tables: ['p_projects'],
  ddl: [
    `CREATE TABLE p_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revision INTEGER NOT NULL
    ) STRICT`,
  ],
  apply(event) {
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
  version: 1,
  tables: ['p_tickets', 'p_artifacts'],
  ddl: [
    `CREATE TABLE p_tickets (
      ticket_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_tickets_by_project ON p_tickets (project_id)',
    // Artifact registry: every registration is kept; the latest per slot is the current one.
    `CREATE TABLE p_artifacts (
      sequence INTEGER PRIMARY KEY,
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
      added_at INTEGER NOT NULL
    ) STRICT`,
    'CREATE INDEX p_artifacts_by_slot ON p_artifacts (ticket_id, node_id, slot, sequence)',
  ],
  apply(event) {
    switch (event.type) {
      case 'ticket.created':
        return [
          {
            sql: `INSERT INTO p_tickets (ticket_id, project_id, title, description, created_at, updated_at, revision)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params: [
              event.data.ticketId,
              event.data.projectId,
              event.data.title,
              event.data.description ?? null,
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
                    (sequence, ticket_id, node_id, slot, kind, uri, version, title, mime_type, content_hash, run_id, added_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              event.timestamp,
            ],
          },
        ];
      }
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

export const BUILTIN_PROJECTORS: readonly Projector[] = [projects, tickets, runs, permissions, audit];

/** Identifies the projection set; a mismatch with the stored value triggers a rebuild. */
export function projectionVersion(projectors: readonly Projector[]): string {
  return projectors.map((projector) => `${projector.name}@${projector.version}`).join(',');
}
