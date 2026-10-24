import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { CommandErrorSchema } from './errors.ts';
import { CHECKOUT_RELEASE_REASONS, EXECUTION_FIELDS, LaneSchema, OBSERVATION_FIELDS, RUN_SETTLE_FIELDS, TicketPriority } from './events.ts';
import { ArtifactRefSchema, ItemRefSchema, PORT_PATTERN, SLOT_PATTERN } from './handoff.ts';
import { IdSchema, NodeIdSchema, RequestIdSchema } from './ids.ts';
import { PermissionRuleSchema } from './permission.ts';
import { AGENT_PROVIDERS } from './providers.ts';
import {
  DEFINITION_ID_PATTERN,
  DEFINITION_KINDS,
  HashSchema,
  NodeTypeDefinitionSchema,
  TEMPLATE_ID_PATTERN,
  TemplateDefinitionSchema,
  WorkspaceSettingsSchema,
} from './workflow.ts';
import {
  ConflictSchema,
  DetectedChangeSchema,
  HolderSchema,
  MergeResultSchema,
  ProjectWorkspaceFields,
  SCAN_REASONS,
  SpaceSchema,
  WorktreeSchema,
} from './workspace.ts';

/**
 * Command envelope. UI buttons, the `vuyro` CLI, the agent panel and MCP all send this
 * and go through the same bus. See [[명령·이벤트 계약]].
 */
export const COMMAND_TYPE_PATTERN = '^[a-z][A-Za-z]*(\\.[a-z][A-Za-z]*)+$';

export const CommandRequestSchema = Type.Object(
  {
    /** Idempotency key. Retrying with the same id and the same command returns the first result. */
    requestId: RequestIdSchema,
    type: Type.String({ pattern: COMMAND_TYPE_PATTERN }),
    /** Payload version. Omitted = 1. */
    schemaVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Revision of the command's target aggregate the caller last saw. 0 = must not exist yet. */
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    /** What the caller says it is working on. Checked against the run token, never trusted on its own. */
    context: Type.Optional(
      Type.Object({ ticketId: Type.Optional(IdSchema), nodeId: Type.Optional(NodeIdSchema) }, { additionalProperties: false }),
    ),
    auth: Type.Optional(
      Type.Object(
        {
          /** Node run token from the VUYRO_RUN_TOKEN environment variable. Narrows the caller to that node. */
          runToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: false },
      ),
    ),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type CommandRequestEnvelope = Static<typeof CommandRequestSchema>;

/** Run tokens look like `vrt_<43 base64url chars>` (32 random bytes). */
export const RUN_TOKEN_PATTERN = '^vrt_[A-Za-z0-9_-]{43}$';

// ---------------------------------------------------------------------------
// Catalog

export type CommandScope = 'app' | 'project' | 'ticket' | 'node' | 'run';

export interface CommandAccess {
  /**
   * What a node agent (caller with a run token) may do:
   * 'own-node' = only when the payload's ticket and node are the token's; 'deny' = never.
   */
  readonly nodeAgent: 'own-node' | 'deny';
  /** Only the engine itself (system principal) may send it. */
  readonly systemOnly?: boolean;
  /**
   * Only a verified person (fixed rule): actions that destroy what is on disk, such as removing a worktree with its
   * content. AI principals and the engine itself are refused.
   */
  readonly humanOnly?: boolean;
}

export interface CommandDefinition {
  readonly version: number;
  readonly scope: CommandScope;
  /** 'permission' commands are always refused for AI principals (fixed rule). */
  readonly category: 'project' | 'ticket' | 'artifact' | 'run' | 'node' | 'definition' | 'workspace' | 'permission';
  readonly access: CommandAccess;
  readonly summary: string;
  readonly payload: TSchema;
  readonly result: TSchema;
}

const strict = { additionalProperties: false } as const;
const Empty = Type.Object({}, strict);

const Observation = Type.Union([
  Type.Object({ kind: Type.Literal('session'), ...OBSERVATION_FIELDS.session }, strict),
  Type.Object({ kind: Type.Literal('message'), ...OBSERVATION_FIELDS.message }, strict),
  Type.Object({ kind: Type.Literal('toolCallStarted'), ...OBSERVATION_FIELDS.toolCallStarted }, strict),
  Type.Object({ kind: Type.Literal('toolCallFinished'), ...OBSERVATION_FIELDS.toolCallFinished }, strict),
  Type.Object({ kind: Type.Literal('usage'), ...OBSERVATION_FIELDS.usage }, strict),
  Type.Object({ kind: Type.Literal('warning'), ...OBSERVATION_FIELDS.warning }, strict),
  Type.Object({ kind: Type.Literal('raw'), ...OBSERVATION_FIELDS.raw }, strict),
]);
export type RunObservation = Static<typeof Observation>;
export const RunObservationSchema = Observation;

/**
 * An output item as a node submits it. The engine turns it into a HandoffItem: it fills `lineage`
 * (from `pairedInput`, or by pairing with the inputs) and adds the artifacts registered during the run.
 */
export const DraftItemSchema = Type.Object(
  {
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    summary: Type.Optional(Type.String({ maxLength: 65536 })),
    artifacts: Type.Optional(Type.Record(Type.String({ pattern: SLOT_PATTERN }), ArtifactRefSchema, strict)),
    /** Index (or indexes) of the input items on the first input port this item answers. */
    pairedInput: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 1000 })]),
    ),
    /** Explicit lineage. Every reference must point at an existing output of this ticket. */
    lineage: Type.Optional(Type.Array(ItemRefSchema, { maxItems: 1000 })),
  },
  strict,
);
export type DraftItem = Static<typeof DraftItemSchema>;

const NodeTarget = { ticketId: IdSchema, nodeId: NodeIdSchema, lane: Type.Optional(LaneSchema) };
const Comment = Type.Optional(Type.String({ maxLength: 65536 }));

const DefinitionSaveResult = Type.Object(
  {
    kind: Type.Union(DEFINITION_KINDS.map((kind) => Type.Literal(kind))),
    id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    hash: HashSchema,
    /** 'active' when this exact version was already active (nothing to write). */
    status: Type.Union([Type.Literal('staged'), Type.Literal('active')]),
  },
  strict,
);
const DefinitionKeyPayload = {
  kind: Type.Union(DEFINITION_KINDS.map((kind) => Type.Literal(kind))),
  id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
  version: Type.Integer({ minimum: 1 }),
  hash: HashSchema,
};

export const COMMAND_CATALOG = {
  'project.create': {
    version: 1,
    scope: 'app',
    category: 'project',
    access: { nodeAgent: 'deny' },
    summary: 'Create a project.',
    payload: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
    result: Type.Object({ projectId: IdSchema }, strict),
  },
  'ticket.create': {
    version: 1,
    scope: 'project',
    category: 'ticket',
    access: { nodeAgent: 'deny' },
    summary: 'Create a ticket in a project.',
    payload: Type.Object(
      {
        projectId: IdSchema,
        title: Type.String({ minLength: 1, maxLength: 300 }),
        description: Type.Optional(Type.String({ maxLength: 65536 })),
        /** Workflow to run. Version omitted = the latest active version. Pinned with its hashes. */
        template: Type.Optional(
          Type.Object({ id: Type.String({ pattern: TEMPLATE_ID_PATTERN }), version: Type.Optional(Type.Integer({ minimum: 1 })) }, strict),
        ),
        /** Higher first when tickets compete for a claim (`priorityWins`). Default 0. */
        priority: Type.Optional(TicketPriority),
      },
      strict,
    ),
    result: Type.Object({ ticketId: IdSchema }, strict),
  },
  'ticket.update': {
    version: 1,
    scope: 'ticket',
    category: 'ticket',
    access: { nodeAgent: 'deny' },
    summary: "Change a ticket's title or description.",
    payload: Type.Object(
      {
        ticketId: IdSchema,
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        description: Type.Optional(Type.String({ maxLength: 65536 })),
        priority: Type.Optional(TicketPriority),
      },
      { ...strict, minProperties: 2 },
    ),
    result: Empty,
  },
  'project.configure': {
    version: 1,
    scope: 'project',
    category: 'project',
    access: { nodeAgent: 'deny' },
    summary: "Set the project's workspace folder, change-detection paths and its layer of the workspace settings. New tickets pin them.",
    payload: Type.Object({ projectId: IdSchema, ...ProjectWorkspaceFields }, { ...strict, minProperties: 2 }),
    result: Empty,
  },
  'app.configure': {
    version: 1,
    scope: 'app',
    category: 'project',
    access: { nodeAgent: 'deny' },
    summary: 'Replace the app layer of the workspace settings (defaults for every project).',
    payload: Type.Object({ settings: WorkspaceSettingsSchema }, strict),
    result: Empty,
  },
  'checkout.acquire': {
    version: 1,
    scope: 'node',
    category: 'workspace',
    access: { nodeAgent: 'own-node' },
    summary: "Check workspace files out for the caller's execution right before editing them (internal ledger only; no external lock).",
    payload: Type.Object(
      {
        ticketId: IdSchema,
        nodeId: NodeIdSchema,
        lane: Type.Optional(LaneSchema),
        /** Absolute, or relative to the execution's workspace folder. */
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 256 }),
        mode: Type.Optional(Type.Union([Type.Literal('exclusive'), Type.Literal('shared')])),
        /** hook: the automatic PreToolUse hook. agent: the agent asked itself (`vuyro checkout`). */
        source: Type.Optional(Type.Union([Type.Literal('hook'), Type.Literal('agent')])),
      },
      strict,
    ),
    result: Type.Object(
      {
        granted: Type.Boolean(),
        /** granted, overlap (granted under `warn`), outside (not in the workspace: nothing to record), wait, fail, ask. */
        decision: Type.Union(['granted', 'overlap', 'outside', 'wait', 'fail', 'ask'].map((decision) => Type.Literal(decision))),
        reason: Type.Optional(Type.String({ maxLength: 4096 })),
        conflicts: Type.Optional(Type.Array(ConflictSchema, { maxItems: 256 })),
        /** The workspace-relative paths now held. */
        paths: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 256 })),
      },
      strict,
    ),
  },
  'checkout.release': {
    version: 1,
    scope: 'node',
    category: 'workspace',
    access: { nodeAgent: 'own-node' },
    summary: "Release checkouts of the caller's execution (all of them, or the given paths). Claims stay until the node ends.",
    payload: Type.Object(
      {
        ticketId: IdSchema,
        nodeId: NodeIdSchema,
        lane: Type.Optional(LaneSchema),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 256 })),
      },
      strict,
    ),
    result: Type.Object({ released: Type.Integer({ minimum: 0 }) }, strict),
  },
  'checkout.forceRelease': {
    version: 1,
    scope: 'project',
    category: 'workspace',
    access: { nodeAgent: 'deny' },
    summary: "Release ledger entries by id, whoever holds them (a person clearing a stuck claim or a 'manual' release).",
    payload: Type.Object({ projectId: IdSchema, ids: Type.Array(IdSchema, { minItems: 1, maxItems: 1024 }) }, strict),
    result: Type.Object({ released: Type.Integer({ minimum: 0 }) }, strict),
  },
  'worktree.cleanup': {
    version: 1,
    scope: 'project',
    category: 'workspace',
    access: { nodeAgent: 'deny', humanOnly: true },
    summary:
      'Remove a worktree the engine left for a person (query.worktreeCleanup shows it), with exactly the content shown: the fingerprint must still match when the engine removes it.',
    payload: Type.Object({ projectId: IdSchema, key: Type.String({ minLength: 1, maxLength: 230 }), fingerprint: HashSchema }, strict),
    result: Type.Object({ requested: Type.Boolean() }, strict),
  },
  'workspace.record': {
    version: 1,
    scope: 'project',
    category: 'workspace',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: "The engine's workspace bookkeeping: releases, pause hashes, detected changes, worktrees.",
    payload: Type.Union([
      Type.Object(
        { projectId: IdSchema, op: Type.Literal('release'), ids: Type.Array(IdSchema, { minItems: 1, maxItems: 4096 }), reason: Type.Union(CHECKOUT_RELEASE_REASONS.map((reason) => Type.Literal(reason))) },
        strict,
      ),
      Type.Object({ projectId: IdSchema, op: Type.Literal('retain'), ids: Type.Array(IdSchema, { minItems: 1, maxItems: 4096 }) }, strict),
      Type.Object({ projectId: IdSchema, op: Type.Literal('pause'), holder: HolderSchema, hashes: Type.Record(IdSchema, Type.Union([HashSchema, Type.Null()])) }, strict),
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('resume'),
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
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('changes'),
          space: SpaceSchema,
          scan: Type.Union(SCAN_REASONS.map((reason) => Type.Literal(reason))),
          changes: Type.Array(DetectedChangeSchema, { minItems: 1, maxItems: 4096 }),
          /** Also warn about files another worktree changed too (`overlapWarning`). */
          warnOverlaps: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('baseline'),
          space: SpaceSchema,
          files: Type.Record(Type.String({ minLength: 1, maxLength: 1024 }), Type.Union([HashSchema, Type.Null()])),
        },
        strict,
      ),
      Type.Object({ projectId: IdSchema, op: Type.Literal('worktreeCreated'), worktree: WorktreeSchema }, strict),
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('worktreeRemoved'),
          ticketId: IdSchema,
          key: Type.String({ minLength: 1, maxLength: 230 }),
          reason: Type.Union([Type.Literal('merged'), Type.Literal('ticketDone'), Type.Literal('manual')]),
          branchDeleted: Type.Boolean(),
        },
        strict,
      ),
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('worktreeKept'),
          ticketId: IdSchema,
          key: Type.String({ minLength: 1, maxLength: 230 }),
          removal: Type.Union([Type.Literal('merged'), Type.Literal('ticketDone'), Type.Literal('superseded')]),
          files: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 1000 }),
          count: Type.Integer({ minimum: 0 }),
          ignored: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 1000 }),
          ignoredCount: Type.Integer({ minimum: 0 }),
        },
        strict,
      ),
      Type.Object(
        {
          projectId: IdSchema,
          op: Type.Literal('cleanupSkipped'),
          key: Type.String({ minLength: 1, maxLength: 230 }),
          reason: Type.Union([Type.Literal('changed'), Type.Literal('inUse'), Type.Literal('error')]),
          detail: Type.Optional(Type.String({ maxLength: 4096 })),
        },
        strict,
      ),
    ]),
    result: Empty,
  },
  'artifact.add': {
    version: 1,
    scope: 'node',
    category: 'artifact',
    access: { nodeAgent: 'own-node' },
    summary: 'Register an artifact (location + version) in a node slot.',
    payload: Type.Object(
      {
        ticketId: IdSchema,
        nodeId: NodeIdSchema,
        slot: Type.String({ pattern: SLOT_PATTERN }),
        ref: ArtifactRefSchema,
        /** Lane the artifact belongs to. Agents need not say: their run identifies the lane. */
        lane: Type.Optional(LaneSchema),
      },
      strict,
    ),
    result: Empty,
  },
  'nodeType.save': {
    version: 1,
    scope: 'app',
    category: 'definition',
    access: { nodeAgent: 'deny' },
    summary: 'Save a node type version (stages it; the engine writes the file and activates it).',
    payload: Type.Object({ definition: NodeTypeDefinitionSchema }, strict),
    result: DefinitionSaveResult,
  },
  'template.save': {
    version: 1,
    scope: 'app',
    category: 'definition',
    access: { nodeAgent: 'deny' },
    summary: 'Save a workflow template version (stages it; the engine writes the file and activates it).',
    payload: Type.Object({ definition: TemplateDefinitionSchema }, strict),
    result: DefinitionSaveResult,
  },
  'definition.activate': {
    version: 1,
    scope: 'app',
    category: 'definition',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Mark a staged definition usable once its file is in place with the staged hash.',
    payload: Type.Object(DefinitionKeyPayload, strict),
    result: Empty,
  },
  'definition.abandon': {
    version: 1,
    scope: 'app',
    category: 'definition',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Drop a staged definition whose file could not be written.',
    payload: Type.Object({ ...DefinitionKeyPayload, reason: Type.String({ maxLength: 1024 }) }, strict),
    result: Empty,
  },
  'node.done': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'own-node' },
    summary: 'Report the result of a node: the output port and its items (or one item as data/summary/artifacts).',
    payload: Type.Object(
      {
        ...NodeTarget,
        port: Type.String({ pattern: PORT_PATTERN }),
        data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        summary: Type.Optional(Type.String({ maxLength: 65536 })),
        artifacts: Type.Optional(Type.Record(Type.String({ pattern: SLOT_PATTERN }), ArtifactRefSchema, strict)),
        /** Several items (fan-out). Not together with data/summary/artifacts. */
        items: Type.Optional(Type.Array(DraftItemSchema, { maxItems: 1000 })),
      },
      strict,
    ),
    result: Empty,
  },
  'node.approve': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny' },
    summary: "Approve a node waiting in Review: an approval node's 'approve' port, or a held output behind a review gate.",
    payload: Type.Object({ ...NodeTarget, comment: Comment }, strict),
    result: Empty,
  },
  'node.reject': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny' },
    summary: "Reject a node waiting in Review: an approval node's 'reject' port (items pick what to send back), or a held output (runs it again).",
    payload: Type.Object({ ...NodeTarget, comment: Comment, items: Type.Optional(Type.Array(DraftItemSchema, { minItems: 1, maxItems: 1000 })) }, strict),
    result: Empty,
  },
  'node.retry': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny' },
    summary: 'Run a failed lane again with the same inputs.',
    payload: Type.Object(NodeTarget, strict),
    result: Empty,
  },
  'node.pause': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny' },
    summary: 'Pause a lane. A running agent is cancelled and resumes its session later.',
    payload: Type.Object(NodeTarget, strict),
    result: Empty,
  },
  'node.resume': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny' },
    summary: 'Resume a paused lane.',
    payload: Type.Object(NodeTarget, strict),
    result: Empty,
  },
  'node.start': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: "Start a queued execution. For agent nodes this also starts the run and returns its token (once).",
    payload: Type.Object({ ...EXECUTION_FIELDS, attempt: Type.Integer({ minimum: 1 }) }, strict),
    result: Type.Object(
      {
        runId: Type.Optional(IdSchema),
        runToken: Type.Optional(Type.String()),
        /** The node's claims conflict (M4): it did not start. wait/ask: it pauses for the paths; fail: it failed. */
        blocked: Type.Optional(Type.Union([Type.Literal('wait'), Type.Literal('ask'), Type.Literal('fail')])),
      },
      strict,
    ),
  },
  'node.finish': {
    version: 1,
    scope: 'node',
    category: 'node',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Apply the end of an execution: the settled agent run, or the exit of a script.',
    payload: Type.Object(
      {
        ...EXECUTION_FIELDS,
        attempt: Type.Integer({ minimum: 1 }),
        result: Type.Union([
          Type.Object({ kind: Type.Literal('agent'), runId: IdSchema }, strict),
          Type.Object(
            {
              kind: Type.Literal('script'),
              exitCode: Type.Union([Type.Integer(), Type.Null()]),
              signal: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
              timedOut: Type.Optional(Type.Boolean()),
              /** Could not start or was interrupted (e.g. the engine restarted while it ran). */
              error: Type.Optional(Type.String({ maxLength: 65536 })),
              stdout: Type.Optional(Type.String({ maxLength: 1_048_576 })),
              stderr: Type.Optional(Type.String({ maxLength: 65536 })),
            },
            strict,
          ),
          MergeResultSchema,
        ]),
      },
      strict,
    ),
    result: Empty,
  },
  'run.start': {
    version: 1,
    scope: 'node',
    category: 'run',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Start an agent run for a node and issue its run token.',
    payload: Type.Object(
      {
        ticketId: IdSchema,
        nodeId: NodeIdSchema,
        provider: Type.Union(AGENT_PROVIDERS.map((provider) => Type.Literal(provider))),
        resumedFromRunId: Type.Optional(IdSchema),
      },
      strict,
    ),
    /** `runToken` is returned once and never stored; an idempotent replay returns `runId` only. */
    result: Type.Object({ runId: IdSchema, runToken: Type.Optional(Type.String()) }, strict),
  },
  'run.observe': {
    version: 1,
    scope: 'run',
    category: 'run',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Record normalized observations from an agent run (adapter output).',
    payload: Type.Object(
      { runId: IdSchema, observations: Type.Array(Observation, { minItems: 1, maxItems: 1000 }) },
      strict,
    ),
    result: Empty,
  },
  'run.settle': {
    version: 1,
    scope: 'run',
    category: 'run',
    access: { nodeAgent: 'deny', systemOnly: true },
    summary: 'Record how a run ended. Revokes its run token.',
    payload: Type.Object({ runId: IdSchema, ...RUN_SETTLE_FIELDS }, strict),
    result: Empty,
  },
  'permission.edit': {
    version: 1,
    scope: 'app',
    category: 'permission',
    access: { nodeAgent: 'deny' },
    summary: 'Replace the permission rules of the app or a project. Never allowed for AI.',
    payload: Type.Union([
      Type.Object({ scope: Type.Literal('app'), rules: Type.Array(PermissionRuleSchema, { maxItems: 1000 }) }, strict),
      Type.Object(
        { scope: Type.Literal('project'), projectId: IdSchema, rules: Type.Array(PermissionRuleSchema, { maxItems: 1000 }) },
        strict,
      ),
    ]),
    result: Empty,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CommandType = keyof typeof COMMAND_CATALOG;
export type CommandPayload<T extends CommandType> = Static<(typeof COMMAND_CATALOG)[T]['payload']>;
export type CommandResult<T extends CommandType> = Static<(typeof COMMAND_CATALOG)[T]['result']>;

export const COMMAND_TYPES = Object.keys(COMMAND_CATALOG) as CommandType[];

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === 'string' && Object.hasOwn(COMMAND_CATALOG, value);
}

/** Typed request for a known command. */
export type CommandRequest<T extends CommandType = CommandType> = Omit<CommandRequestEnvelope, 'type' | 'payload'> & {
  readonly type: T;
  readonly payload: CommandPayload<T>;
};

// ---------------------------------------------------------------------------
// Response

export const CommandResponseSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      requestId: RequestIdSchema,
      type: Type.String(),
      result: Type.Unknown(),
      /** Revision of the target aggregate after the command (absent if it has none). */
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
      events: Type.Union([
        Type.Null(),
        Type.Object(
          {
            firstSequence: Type.Integer({ minimum: 1 }),
            lastSequence: Type.Integer({ minimum: 1 }),
            count: Type.Integer({ minimum: 1 }),
          },
          strict,
        ),
      ]),
      /** True when this is the stored answer to an earlier request with the same id. */
      replayed: Type.Boolean(),
    },
    strict,
  ),
  Type.Object({ ok: Type.Literal(false), requestId: Type.Optional(Type.String()), error: CommandErrorSchema }, strict),
]);

export type CommandResponse = Static<typeof CommandResponseSchema>;
export type CommandSuccess = Extract<CommandResponse, { ok: true }>;
export type CommandFailure = Extract<CommandResponse, { ok: false }>;
