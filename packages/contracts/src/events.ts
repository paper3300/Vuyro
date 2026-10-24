import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { ArtifactRefSchema, HandoffItemSchema, NodeRunOutputSchema, PORT_PATTERN, SLOT_PATTERN } from './handoff.ts';
import { AggregateIdSchema, IdSchema, NodeIdSchema, RequestIdSchema } from './ids.ts';
import { PermissionRuleSchema } from './permission.ts';
import { AuthorizationSchema, PrincipalSchema } from './principal.ts';
import { CLAIM_CONFLICT_POLICIES } from './node-type.ts';
import { AGENT_PROVIDERS } from './providers.ts';
import { CostSchema, TokenUsageSchema } from './usage.ts';
import {
  ACTIVATION_CAUSES,
  DEFINITION_ID_PATTERN,
  DEFINITION_KINDS,
  DefinitionEnvelopeSchema,
  HashSchema,
  PinnedTemplateSchema,
  WorkspaceSettingsSchema,
} from './workflow.ts';
import {
  CheckoutEntrySchema,
  ClaimWaitSchema,
  ConflictSchema,
  DetectedChangeSchema,
  HolderSchema,
  MergeReviewSchema,
  ProjectWorkspaceFields,
  SCAN_REASONS,
  SpaceSchema,
  TicketWorkspaceSchema,
  WorktreeSchema,
} from './workspace.ts';

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
/** Ticket priority (claims, `priorityWins`). */
export const TicketPriority = Type.Integer({ minimum: -1000, maximum: 1000 });
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

const CheckoutSource = Type.Union([Type.Literal('start'), Type.Literal('hook'), Type.Literal('agent')]);
/**
 * nodeDone / ticketDone / manual: the entry's own release. ended: its execution ended another way (superseded,
 * discarded, failed). expired: its ttl passed. preempted: a higher-priority ticket took it. recovered: cleaned
 * up when the engine started.
 */
export const CHECKOUT_RELEASE_REASONS = ['nodeDone', 'ticketDone', 'manual', 'ended', 'expired', 'preempted', 'recovered'] as const;
export type CheckoutReleaseReason = (typeof CHECKOUT_RELEASE_REASONS)[number];

/**
 * A lane is one parallel copy of a node. Whole-input nodes have the single lane 'main'; fan-out
 * (`mode: 'each'`) nodes get lanes '1', '2', … in creation order, never reused across groups.
 */
export const LANE_PATTERN = '^(main|[1-9][0-9]{0,6})$';
export const LaneSchema = Type.String({ pattern: LANE_PATTERN });
/** Execution number of a node within a ticket (1-based, over all lanes). The `run` of an ItemRef. */
const RunNumber = Type.Integer({ minimum: 1 });

/** Fields that identify one node execution, shared by the node events and the system commands. */
export const EXECUTION_FIELDS = {
  ticketId: TicketId,
  nodeId: NodeIdSchema,
  lane: LaneSchema,
  run: RunNumber,
};

/** Fan-out group id: lanes created together. Inherited along chained fan-out nodes. */
const GroupId = Type.String({ minLength: 1, maxLength: 160 });

/** An edge (template index) and the node at its far end. */
const EdgeTarget = Type.Object({ edge: Type.Integer({ minimum: 0 }), to: NodeIdSchema }, strict);

/**
 * The generation record of an execution or a delivery ([[명령·이벤트 계약]] §10.6 item 3): the fan-out groups the
 * work rests on, and `free` when it also rests on something that never passed a fan-out. Required from v2 of the
 * workflow events; v1 events are retired (their tickets are blocked, not read as if they were free).
 */
export const BasisSchema = Type.Object(
  {
    groups: Type.Array(GroupId, { maxItems: 4096 }),
    free: Type.Optional(Type.Literal(true)),
  },
  strict,
);
export type Basis = Static<typeof BasisSchema>;

const DefinitionKey = {
  kind: Type.Union(DEFINITION_KINDS.map((kind) => Type.Literal(kind))),
  id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
  version: Type.Integer({ minimum: 1 }),
  hash: HashSchema,
};

interface EventDefinition {
  readonly aggregateType: string;
  /** Current version of `data`. Bump only for breaking changes and add an upcaster. */
  readonly version: number;
  readonly schema: TSchema;
  /**
   * Versions retired by a format change before release ([[명령·이벤트 계약]] §6): read as stored, never converted.
   * Whoever folds them must refuse to carry on with the aggregate (fail closed). After release, use upcasters.
   */
  readonly retired?: readonly number[];
}

export const EVENT_CATALOG = {
  'project.created': {
    aggregateType: 'project',
    version: 1,
    schema: Type.Object({ projectId: IdSchema, name: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
  },
  /** The project's workspace folder and settings layer changed (fields present = changed; `null` clears). */
  'project.configured': {
    aggregateType: 'project',
    version: 1,
    schema: Type.Object({ projectId: IdSchema, ...ProjectWorkspaceFields }, strict),
  },
  /** The app layer of the settings (replaced as a whole). */
  'app.configured': {
    aggregateType: 'settings',
    version: 1,
    schema: Type.Object({ settings: WorkspaceSettingsSchema }, strict),
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
        /** The workflow this ticket runs, pinned with the hashes of every definition it uses. */
        template: Type.Optional(PinnedTemplateSchema),
        /** Higher first when tickets compete for a claim (`priorityWins`). Default 0. */
        priority: Type.Optional(TicketPriority),
        /** The project's workspace and the app + project settings, pinned for the ticket's lifetime (M4). */
        workspace: Type.Optional(TicketWorkspaceSchema),
      },
      strict,
    ),
  },
  /** An end node finished and nothing else in the ticket is active. */
  'ticket.completed': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object({ ticketId: TicketId }, strict),
  },
  'ticket.updated': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ticketId: TicketId,
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        description: Type.Optional(Type.String({ maxLength: 65536 })),
        priority: Type.Optional(TicketPriority),
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
        /** The lane it was registered for, when the caller named one. */
        lane: Type.Optional(LaneSchema),
      },
      strict,
    ),
  },

  // -------------------------------------------------------------------------
  // Workflow (ticket aggregate). The engine decides every routing step and records it explicitly,
  // so the ticket state folds from these events without reading the template.

  /** A node execution got its inputs. `status` is where it starts: queued (executor), review (human) or rejected. */
  'node.activated': {
    aggregateType: 'ticket',
    // v2 (pre-release): generation records (`basis`). v1 logs are retired, not converted: their tickets need attention.
    version: 2,
    retired: [1],
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        cause: Type.Union(ACTIVATION_CAUSES.map((cause) => Type.Literal(cause))),
        status: Type.Union([Type.Literal('queued'), Type.Literal('review'), Type.Literal('rejected')]),
        /** Input items by input port. Each item's lineage points at the upstream output it was copied from. */
        inputs: Type.Record(Type.String({ pattern: PORT_PATTERN }), Type.Array(HandoffItemSchema), strict),
        /** Fan-out group of the lane (each-mode nodes). */
        group: Type.Optional(GroupId),
        /** Set when the group is new and was inherited from an upstream fan-out group. */
        groupParent: Type.Optional(GroupId),
        /** The lane's previous execution this one replaces while it was still active. */
        supersedes: Type.Optional(RunNumber),
        /** Reviewer feedback for a `review` re-activation. */
        feedback: Type.Optional(Type.Object({ run: RunNumber, comment: Type.Optional(Type.String({ maxLength: 65536 })) }, strict)),
        /** Generation record: the union of what the activation consumed (empty deliveries included). */
        basis: BasisSchema,
        /** On the activation that opens a new group: the execution whose delivery opened it. */
        openedBy: Type.Optional(Type.Object({ nodeId: NodeIdSchema, run: RunNumber }, strict)),
        /**
         * Worktree mode: start the lane's worktree over from the ticket branch (a merge conflict sent the lane
         * back to run again on top of what was merged, `onMergeConflict: rerun`).
         */
        workspace: Type.Optional(Type.Object({ reset: Type.Literal(true) }, strict)),
      },
      strict,
    ),
  },
  'node.started': {
    aggregateType: 'ticket',
    // v2: the 'merge' executor (a join merging worktree branches, M4). v1 data is valid v2 data.
    version: 2,
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        /** 1, 2, … per execution (a restart after an engine crash is a new attempt). */
        attempt: Type.Integer({ minimum: 1 }),
        executor: Type.Union([Type.Literal('agent'), Type.Literal('script'), Type.Literal('merge')]),
        runId: Type.Optional(RunId),
      },
      strict,
    ),
  },
  /** The agent reported its result (`node.done`) while its run is still going. Applied when the run settles. */
  'node.outputSubmitted': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object({ ...EXECUTION_FIELDS, runId: RunId, output: NodeRunOutputSchema }, strict),
  },
  /**
   * The output waits for a person before it is routed: a review gate, or (`reason: 'empty'`) an output
   * with no items on a port that leads somewhere. Approving an empty output skips what it would have fed.
   */
  'node.reviewRequested': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        output: NodeRunOutputSchema,
        reason: Type.Optional(Type.Literal('empty')),
        /** A join's merge stopped on conflicts (M4). Approving continues the merge; rejecting hands it to an agent. */
        merge: Type.Optional(MergeReviewSchema),
      },
      strict,
    ),
  },
  /** A reviewer sent the held output back. The execution is discarded; a `review` activation follows. */
  'node.returned': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object({ ...EXECUTION_FIELDS, comment: Type.Optional(Type.String({ maxLength: 65536 })) }, strict),
  },
  /**
   * An execution finished. `routes` lists, per template edge index, which output items travel it
   * (the engine evaluated the edge conditions). The activations they cause are separate events.
   */
  'node.completed': {
    aggregateType: 'ticket',
    // v2 (pre-release): generation records (`basis`). v1 logs are retired, not converted: their tickets need attention.
    version: 2,
    retired: [1],
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
        output: NodeRunOutputSchema,
        routes: Type.Array(
          Type.Object(
            { edge: Type.Integer({ minimum: 0 }), to: NodeIdSchema, items: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }) },
            strict,
          ),
        ),
        /** Why it failed (executor failure without an output). */
        error: Type.Optional(Type.String({ maxLength: 65536 })),
        /** Top-level data fields the port schema does not declare (kept, shown as undeclared). */
        undeclared: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 })),
        /** Edges that carried an empty delivery (the output had no items and a person accepted that). */
        empty: Type.Optional(Type.Array(EdgeTarget)),
        /**
         * Items not delivered because their lineage leads to lanes of an older fan-out group of the target
         * (the work they answer was replaced, e.g. by a new plan).
         */
        stale: Type.Optional(Type.Array(Type.Object({ ...EdgeTarget.properties, items: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }) }, strict))),
        /** Generation record of what this completion delivers (routes and empty deliveries alike). */
        basis: BasisSchema,
      },
      strict,
    ),
  },
  /**
   * A fan-out node received an empty delivery: it opens an empty group (no lanes), or reuses the live group
   * under the same upstream group, and passes the empty delivery on along its non-error outgoing edges, so
   * whatever gathers its lanes runs with no items.
   */
  'node.passedOver': {
    aggregateType: 'ticket',
    // v2 (pre-release): generation records (`basis`). v1 logs are retired, not converted: their tickets need attention.
    version: 2,
    retired: [1],
    schema: Type.Object(
      {
        ticketId: TicketId,
        nodeId: NodeIdSchema,
        group: GroupId,
        /** Set when the group is new and hangs under an upstream fan-out group. */
        groupParent: Type.Optional(GroupId),
        edges: Type.Array(EdgeTarget),
        /** Generation record of the empty deliveries it passes on: the passed-over group. */
        basis: BasisSchema,
        /** When the group is new: the execution whose empty delivery opened it. */
        openedBy: Type.Optional(Type.Object({ nodeId: NodeIdSchema, run: RunNumber }, strict)),
      },
      strict,
    ),
  },
  /**
   * An active execution of a lane whose fan-out group was replaced (a new plan opened a newer group).
   * It ends without a result; the engine cancels its agent.
   */
  'node.superseded': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object({ ...EXECUTION_FIELDS, reason: Type.Literal('replaced') }, strict),
  },
  /** The executor stopped without a result for a reason worth another attempt (engine restart). */
  'node.requeued': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      { ...EXECUTION_FIELDS, reason: Type.String({ maxLength: 1024 }), resumeFromRunId: Type.Optional(RunId) },
      strict,
    ),
  },
  /** A person asked to pause a running lane; the engine cancels the run and then records `node.paused`. */
  'node.pauseRequested': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        /** The engine stops the run because of a claim conflict (M4): it waits for the paths, or fails (`fail`). */
        claim: Type.Optional(ClaimWaitSchema),
        fail: Type.Optional(Type.Literal(true)),
      },
      strict,
    ),
  },
  'node.paused': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        resumeTo: Type.Union([Type.Literal('queued'), Type.Literal('review'), Type.Literal('rejected')]),
        resumeFromRunId: Type.Optional(RunId),
        /** Set when it waits for paths another execution holds (M4). The engine resumes it once they are free. */
        claim: Type.Optional(ClaimWaitSchema),
      },
      strict,
    ),
  },
  'node.resumed': {
    aggregateType: 'ticket',
    version: 1,
    schema: Type.Object(
      {
        ...EXECUTION_FIELDS,
        /** Where the lane is now: back where it was paused, or still running when the pause had not happened yet. */
        status: Type.Union([Type.Literal('queued'), Type.Literal('review'), Type.Literal('rejected'), Type.Literal('running')]),
        /** A person resumed a lane that waited for a claim: it goes ahead despite the overlap (recorded as a warning). */
        override: Type.Optional(Type.Literal(true)),
      },
      strict,
    ),
  },

  // -------------------------------------------------------------------------
  // Definitions (aggregate 'definition', one per kind + id). Files are the source of truth;
  // these events record which versions were asked for and which are usable.

  /** An authorized caller asked to save this version. The file is written next. */
  'definition.staged': {
    aggregateType: 'definition',
    version: 1,
    schema: Type.Object(
      {
        ...DefinitionKey,
        name: Type.String({ minLength: 1, maxLength: 200 }),
        /** The content, so recovery can write the file if the engine died before it did. */
        definition: DefinitionEnvelopeSchema,
      },
      strict,
    ),
  },
  /** The file is in place and its hash matches. Usable from now on. */
  'definition.activated': {
    aggregateType: 'definition',
    version: 1,
    schema: Type.Object(DefinitionKey, strict),
  },
  /** The file never made it (write failed, or the engine died first and the file is missing or different). */
  'definition.abandoned': {
    aggregateType: 'definition',
    version: 1,
    schema: Type.Object({ ...DefinitionKey, reason: Type.String({ maxLength: 1024 }) }, strict),
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
  // -------------------------------------------------------------------------
  // Workspace ledger (aggregate 'workspace', one per project; [[명령·이벤트 계약]] §14)

  /** Entries taken: a node's claims when it started, or checkouts right before an edit. */
  'checkout.acquired': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        entries: Type.Array(CheckoutEntrySchema, { minItems: 1, maxItems: 1024 }),
        source: CheckoutSource,
        /** Overlaps that were let through: the `warn` policy, or a person resuming a waiting lane. */
        overlaps: Type.Optional(Type.Array(ConflictSchema, { maxItems: 256 })),
      },
      strict,
    ),
  },
  /** A request for paths another execution holds was refused: the decision and who holds them. */
  'checkout.blocked': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        requester: HolderSchema,
        space: SpaceSchema,
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 1024 }),
        source: CheckoutSource,
        conflicts: Type.Array(ConflictSchema, { minItems: 1, maxItems: 256 }),
        policy: Type.Union(CLAIM_CONFLICT_POLICIES.map((policy) => Type.Literal(policy))),
        /** wait: the lane pauses until the paths are free. fail: the lane fails. ask: a person decides. */
        outcome: Type.Union([Type.Literal('wait'), Type.Literal('fail'), Type.Literal('ask')]),
        deadlock: Type.Optional(Type.Literal(true)),
      },
      strict,
    ),
  },
  'checkout.released': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        ids: Type.Array(IdSchema, { minItems: 1, maxItems: 4096 }),
        reason: Type.Union(CHECKOUT_RELEASE_REASONS.map((reason) => Type.Literal(reason))),
      },
      strict,
    ),
  },
  /** `release: ticketDone` entries outlive their node: the ticket keeps them until it completes. */
  'checkout.retained': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object({ projectId: IdSchema, ids: Type.Array(IdSchema, { minItems: 1, maxItems: 4096 }) }, strict),
  },
  /** The holder paused: file hashes now, to tell later what others changed while it waited (pauseHash). */
  'checkout.paused': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        holder: HolderSchema,
        hashes: Type.Record(IdSchema, Type.Union([HashSchema, Type.Null()])),
      },
      strict,
    ),
  },
  /** The holder runs again: the pause hashes are cleared; `changed` lists what changed while it waited. */
  'checkout.resumed': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        holder: HolderSchema,
        changed: Type.Array(
          Type.Object(
            { entryId: IdSchema, path: Type.String({ maxLength: 1024 }), pauseHash: Type.Union([HashSchema, Type.Null()]), hash: Type.Union([HashSchema, Type.Null()]) },
            strict,
          ),
          { maxItems: 1024 },
        ),
      },
      strict,
    ),
  },
  /** Files found changed in a space (watcher, read-only git status, the holder's own checkouts) and how the ledger explains them. */
  'workspace.changesDetected': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        space: SpaceSchema,
        scan: Type.Union(SCAN_REASONS.map((reason) => Type.Literal(reason))),
        changes: Type.Array(DetectedChangeSchema, { minItems: 1, maxItems: 4096 }),
      },
      strict,
    ),
  },
  /** The first look at a space: files that were already changed then are its starting point, not changes. */
  'workspace.baselined': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        space: SpaceSchema,
        files: Type.Record(Type.String({ minLength: 1, maxLength: 1024 }), Type.Union([HashSchema, Type.Null()])),
      },
      strict,
    ),
  },
  /** Two worktrees changed the same file: a merge conflict is likely (`overlapWarning`). Recorded once per pair. */
  'workspace.overlapWarned': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        path: Type.String({ minLength: 1, maxLength: 1024 }),
        spaces: Type.Array(SpaceSchema, { minItems: 2, maxItems: 2 }),
        holders: Type.Array(HolderSchema, { maxItems: 2 }),
      },
      strict,
    ),
  },
  'worktree.created': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object({ projectId: IdSchema, worktree: WorktreeSchema }, strict),
  },
  'worktree.removed': {
    aggregateType: 'workspace',
    version: 1,
    schema: Type.Object(
      {
        projectId: IdSchema,
        ticketId: IdSchema,
        key: Type.String({ minLength: 1, maxLength: 230 }),
        /** merged: its branch is in the ticket branch. ticketDone: the ticket completed. */
        reason: Type.Union([Type.Literal('merged'), Type.Literal('ticketDone')]),
        branchDeleted: Type.Boolean(),
      },
      strict,
    ),
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

/** Upcasters for events whose `version` was bumped after release. Pre-release bumps retire versions instead. */
export const EVENT_UPCASTERS: UpcasterRegistry = {
  // v2 only widened `executor` with 'merge': v1 data is valid as is.
  'node.started': { 1: (data) => data },
};

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
 * A retired version comes back as stored, with its old `schemaVersion` (see `isRetiredEvent`).
 * A version newer than the catalog, a missing upcaster or an unknown type throws (fail closed).
 */
export function upcastEventData(
  type: string,
  schemaVersion: number,
  data: unknown,
  options: { catalog?: Readonly<Record<string, { version: number; retired?: readonly number[] }>>; upcasters?: UpcasterRegistry } = {},
): { schemaVersion: number; data: unknown } {
  const catalog: Readonly<Record<string, { version: number; retired?: readonly number[] }>> = options.catalog ?? EVENT_CATALOG;
  const upcasters = (options.upcasters ?? EVENT_UPCASTERS) as Readonly<Record<string, Readonly<Record<number, Upcaster>>>>;
  const definition = Object.hasOwn(catalog, type) ? catalog[type] : undefined;
  if (definition === undefined) throw new UnsupportedSchemaVersionError(type, schemaVersion, 0);
  if (schemaVersion > definition.version) throw new UnsupportedSchemaVersionError(type, schemaVersion, definition.version);
  if (schemaVersion < definition.version && definition.retired?.includes(schemaVersion) === true) return { schemaVersion, data };
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

/** True for a stored event in a retired (pre-release) format: its aggregate must not be carried on. */
export function isRetiredEvent(event: { readonly type: string; readonly schemaVersion?: number }): boolean {
  const definition: EventDefinition | undefined = Object.hasOwn(EVENT_CATALOG, event.type) ? (EVENT_CATALOG as Readonly<Record<string, EventDefinition>>)[event.type] : undefined;
  return definition !== undefined && event.schemaVersion !== undefined && event.schemaVersion < definition.version && definition.retired?.includes(event.schemaVersion) === true;
}
