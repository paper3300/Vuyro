import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { ArtifactRefSchema, SLOT_PATTERN } from './handoff.ts';
import { AggregateIdSchema, IdSchema, NodeIdSchema, RequestIdSchema } from './ids.ts';
import { PermissionRuleSchema } from './permission.ts';
import { AuthorizationSchema, PrincipalSchema } from './principal.ts';
import { AGENT_PROVIDERS } from './providers.ts';
import { CostSchema, TokenUsageSchema } from './usage.ts';

/**
 * Event envelope. Every state change is one of these, appended to the log and never changed.
 * See [[명령·이벤트 계약]] for the field rules.
 */
export const EventEnvelopeSchema = Type.Object(
  {
    /** Globally unique (UUIDv7). The key for future sync between replicas. */
    eventId: IdSchema,
    /** Position in this replica's log (1, 2, 3…, no gaps). Local only; never compare across replicas. */
    sequence: Type.Integer({ minimum: 1 }),
    type: Type.String({ minLength: 1 }),
    /** Version of `data` for this `type`. Readers upcast older versions. */
    schemaVersion: Type.Integer({ minimum: 1 }),
    aggregateType: Type.String({ minLength: 1 }),
    aggregateId: AggregateIdSchema,
    /** 1-based, gapless per aggregate. Optimistic concurrency key. */
    revision: Type.Integer({ minimum: 1 }),
    /** Epoch milliseconds (UTC) from the engine clock when the event was appended. */
    timestamp: Type.Integer({ minimum: 0 }),
    /** Engine installation (DB) that wrote the event. */
    replicaId: IdSchema,
    actor: PrincipalSchema,
    /** Present when the event came from a command. */
    authorization: Type.Optional(AuthorizationSchema),
    requestId: Type.Optional(RequestIdSchema),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

const RunId = IdSchema;
const TicketId = IdSchema;
/** When the adapter read the line (epoch ms). The envelope timestamp is when it was stored. */
const ObservedAt = Type.Optional(Type.Integer({ minimum: 0 }));

/** Fields of the run observation events, shared with the `run.observe` command. */
export const OBSERVATION_FIELDS = {
  session: {
    /** Claude `session_id` / Codex `thread_id`. Used to resume, never as the run key. */
    providerSessionId: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.Optional(Type.String({ maxLength: 128 })),
    cliVersion: Type.Optional(Type.String({ maxLength: 64 })),
    observedAt: ObservedAt,
  },
  message: {
    role: Type.Union([Type.Literal('assistant'), Type.Literal('user'), Type.Literal('system')]),
    /** Provider message id. Claude splits one message over several lines with the same id. */
    messageId: Type.Optional(Type.String({ maxLength: 256 })),
    text: Type.String({ maxLength: 1_048_576 }),
    observedAt: ObservedAt,
  },
  toolCallStarted: {
    /** Provider value kept as is (Claude `toolu_…`, Codex `item_N`). */
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    input: Type.Optional(Type.Unknown()),
    observedAt: ObservedAt,
  },
  toolCallFinished: {
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    /** Optional like Claude's `is_error`: absent means success. */
    isError: Type.Optional(Type.Boolean()),
    output: Type.Optional(Type.String({ maxLength: 1_048_576 })),
    observedAt: ObservedAt,
  },
  usage: {
    /** 'run' = final totals of the run (Claude `result.usage`); 'turn' = one turn (Codex `turn.completed`). */
    scope: Type.Union([Type.Literal('run'), Type.Literal('turn')]),
    tokens: TokenUsageSchema,
    cost: Type.Optional(CostSchema),
    model: Type.Optional(Type.String({ maxLength: 128 })),
    observedAt: ObservedAt,
  },
  warning: {
    message: Type.String({ maxLength: 65536 }),
    /** e.g. Codex `item.type = "error"`, which is a warning, not a failure. */
    source: Type.Optional(Type.String({ maxLength: 128 })),
    observedAt: ObservedAt,
  },
  raw: {
    stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
    /** Provider line type if known (e.g. 'rate_limit_event'). */
    providerType: Type.Optional(Type.String({ maxLength: 128 })),
    raw: Type.Unknown(),
    observedAt: ObservedAt,
  },
};

export const RUN_OUTCOMES = ['succeeded', 'failed', 'abnormal_exit', 'cancelled'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RUN_SETTLE_FIELDS = {
  /** abnormal_exit = the process ended without the provider's final line. */
  outcome: Type.Union(RUN_OUTCOMES.map((outcome) => Type.Literal(outcome))),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  signal: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
  /** Claude `terminal_reason`, Codex failure kind… */
  terminalReason: Type.Optional(Type.String({ maxLength: 128 })),
  error: Type.Optional(Type.String({ maxLength: 65536 })),
};

const strict = { additionalProperties: false } as const;

interface EventDefinition {
  readonly aggregateType: string;
  /** Current version of `data`. Bump only for breaking changes and add an upcaster. */
  readonly version: number;
  readonly schema: TSchema;
}

export const EVENT_CATALOG = {
  'project.created': {
    aggregateType: 'project',
    version: 1,
    schema: Type.Object({ projectId: IdSchema, name: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
  },
  'ticket.created': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ticketId: TicketId,
        projectId: IdSchema,
        title: Type.String({ minLength: 1, maxLength: 300 }),
        description: Type.Optional(Type.String({ maxLength: 65536 })),
      },
      strict,
    ),
  },
  'ticket.updated': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ticketId: TicketId,
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        description: Type.Optional(Type.String({ maxLength: 65536 })),
      },
      strict,
    ),
  },
  'artifact.added': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ticketId: TicketId,
        nodeId: NodeIdSchema,
        slot: Type.String({ pattern: SLOT_PATTERN }),
        ref: ArtifactRefSchema,
        /** The run that registered it, when an agent did. */
        runId: Type.Optional(RunId),
      },
      strict,
    ),
  },
  'run.started': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object(
      {
        runId: RunId,
        ticketId: TicketId,
        nodeId: NodeIdSchema,
        provider: Type.Union(AGENT_PROVIDERS.map((provider) => Type.Literal(provider))),
        /** 'sha256:<hex>' of the run token. The token itself is never stored. */
        tokenHash: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
        /** The run this one resumes (same provider session). */
        resumedFromRunId: Type.Optional(RunId),
      },
      strict,
    ),
  },
  'run.sessionIdentified': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.session }, strict),
  },
  'run.messageRecorded': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.message }, strict),
  },
  'run.toolCallStarted': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.toolCallStarted }, strict),
  },
  'run.toolCallFinished': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.toolCallFinished }, strict),
  },
  'run.usageRecorded': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.usage }, strict),
  },
  'run.warningRecorded': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.warning }, strict),
  },
  'run.rawRecorded': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...OBSERVATION_FIELDS.raw }, strict),
  },
  'run.settled': {
    aggregateType: 'run',
    version: 1,
    schema: Type.Object({ runId: RunId, ...RUN_SETTLE_FIELDS }, strict),
  },
  'permission.rulesChanged': {
    aggregateType: 'permissions',
    version: 1,
    schema: Type.Object(
      {
        scope: Type.Union([Type.Literal('app'), Type.Literal('project')]),
        projectId: Type.Optional(IdSchema),
        rules: Type.Array(PermissionRuleSchema, { maxItems: 1000 }),
      },
      strict,
    ),
  },
  /** An authorization refusal (forbidden / out_of_scope). Each one is its own 'audit' aggregate. */
  'command.denied': {
    aggregateType: 'audit',
    version: 1,
    schema: Type.Object(
      {
        requestId: RequestIdSchema,
        commandType: Type.String({ minLength: 1, maxLength: 128 }),
        code: Type.Union([Type.Literal('forbidden'), Type.Literal('out_of_scope')]),
        reason: Type.String({ maxLength: 1024 }),
        ticketId: Type.Optional(TicketId),
        nodeId: Type.Optional(NodeIdSchema),
      },
      strict,
    ),
  },
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENT_CATALOG;
export type EventData<T extends EventType> = Static<(typeof EVENT_CATALOG)[T]['schema']>;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(EVENT_CATALOG, value);
}

type Envelope = Static<typeof EventEnvelopeSchema>;

export type EventEnvelope<T extends EventType = EventType> = Omit<Envelope, 'type' | 'data'> & {
  readonly type: T;
  readonly data: EventData<T>;
};

/** Discriminated union of all known events (narrow on `type`). */
export type DomainEvent = { [T in EventType]: EventEnvelope<T> }[EventType];

/** Range of log sequences a command wrote. */
export interface EventRange {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Schema versions and upcasting

/** Converts `data` from version n to n + 1. */
export type Upcaster = (data: unknown) => unknown;

export type UpcasterRegistry = { readonly [T in EventType]?: Readonly<Record<number, Upcaster>> };

/** Upcasters for events whose `version` was bumped. Empty while every event is at version 1. */
export const EVENT_UPCASTERS: UpcasterRegistry = {};

export class UnsupportedSchemaVersionError extends Error {
  readonly type: string;
  readonly schemaVersion: number;
  readonly supported: number;

  constructor(type: string, schemaVersion: number, supported: number) {
    super(`event '${type}' v${schemaVersion} is newer than this engine supports (v${supported})`);
    this.name = 'UnsupportedSchemaVersionError';
    this.type = type;
    this.schemaVersion = schemaVersion;
    this.supported = supported;
  }
}

/**
 * Brings stored event data up to the catalog's current version.
 * Stored events are never rewritten; this runs on every read.
 * A version newer than the catalog, a missing upcaster or an unknown type throws (fail closed).
 */
export function upcastEventData(
  type: string,
  schemaVersion: number,
  data: unknown,
  options: { catalog?: Readonly<Record<string, { version: number }>>; upcasters?: UpcasterRegistry } = {},
): { schemaVersion: number; data: unknown } {
  const catalog: Readonly<Record<string, { version: number }>> = options.catalog ?? EVENT_CATALOG;
  const upcasters = (options.upcasters ?? EVENT_UPCASTERS) as Readonly<Record<string, Readonly<Record<number, Upcaster>>>>;
  const definition = Object.hasOwn(catalog, type) ? catalog[type] : undefined;
  if (definition === undefined) throw new UnsupportedSchemaVersionError(type, schemaVersion, 0);
  if (schemaVersion > definition.version) throw new UnsupportedSchemaVersionError(type, schemaVersion, definition.version);
  let version = schemaVersion;
  let current = data;
  while (version < definition.version) {
    const step = upcasters[type]?.[version];
    if (step === undefined) throw new Error(`missing upcaster for '${type}' v${version} → v${version + 1}`);
    current = step(current);
    version += 1;
  }
  return { schemaVersion: version, data: current };
}
