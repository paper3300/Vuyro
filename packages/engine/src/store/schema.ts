/**
 * Core tables of the engine database. Projection tables live in projections.ts and are
 * dropped and rebuilt from the log whenever their version changes.
 *
 * `PRAGMA user_version` is the core schema version. Migrations only ever add.
 */
export const CORE_SCHEMA_VERSION = 1;

const V1 = [
  `CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,

  // The log. sequence is assigned by the single writer and must be gapless.
  `CREATE TABLE events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    replica_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    authz TEXT,
    request_id TEXT,
    correlation_id TEXT,
    data TEXT NOT NULL,
    UNIQUE (aggregate_id, revision)
  ) STRICT`,
  'CREATE INDEX events_by_request ON events (request_id) WHERE request_id IS NOT NULL',
  'CREATE INDEX events_by_type ON events (type, sequence)',

  // Revisions are 1, 2, 3… per aggregate. A stale writer aborts the whole transaction.
  `CREATE TRIGGER events_revision_gapless BEFORE INSERT ON events
   WHEN NEW.revision <> COALESCE((SELECT MAX(revision) FROM events WHERE aggregate_id = NEW.aggregate_id), 0) + 1
   BEGIN SELECT RAISE(ABORT, 'vuyro:revision_conflict'); END`,
  `CREATE TRIGGER events_sequence_gapless BEFORE INSERT ON events
   WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) FROM events), 0) + 1
   BEGIN SELECT RAISE(ABORT, 'vuyro:sequence_conflict'); END`,
  `CREATE TRIGGER events_no_update BEFORE UPDATE ON events
   BEGIN SELECT RAISE(ABORT, 'vuyro:append_only'); END`,
  `CREATE TRIGGER events_no_delete BEFORE DELETE ON events
   BEGIN SELECT RAISE(ABORT, 'vuyro:append_only'); END`,

  // Idempotency records, written in the same transaction as the command's events.
  `CREATE TABLE commands (
    request_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    response TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  ) STRICT`,
];

/** Statements that bring a database at `version` to the next version. Index = from-version. */
export const MIGRATIONS: readonly (readonly string[])[] = [V1];
