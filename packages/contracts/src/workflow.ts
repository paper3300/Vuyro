import { type Static, Type } from '@sinclair/typebox';
import { PORT_PATTERN } from './handoff.ts';
import { NodeIdSchema } from './ids.ts';
import {
  ArtifactSlotSpecSchema,
  CLAIM_CONFLICT_POLICIES,
  ExtensionsSchema,
  JsonSchemaObjectSchema,
  NODE_TYPE_PATTERN,
  NodeTypeSpecSchema,
  PAUSE_MODES,
} from './node-type.ts';
import { AGENT_PROVIDERS } from './providers.ts';

/**
 * Workflow templates, definition files and node states ([[구현 계획]] M2).
 *
 * A template is a graph of node instances (each pinning a node type version) and edges between ports.
 * Templates and node types are stored as definition files in the export envelope format
 * ([[공유·권한·BlackBoard 설계]] §1.2); a ticket pins the template version and the hashes it ran with.
 */

// ---------------------------------------------------------------------------
// Node states

/**
 * What a node (one lane of it) shows on the board.
 * - wait: not activated yet (inputs missing). A node without lanes is in this state.
 * - queued: inputs ready, waiting for an executor slot.
 * - running: an agent or a script is working on it.
 * - review: waiting for a person (a human node, or a held output behind a review gate).
 * - done / failed: finished through a normal port / the error port.
 * - rejected: sent back by a later node or a reviewer, not started again yet.
 * - paused: held by a person; resumes where it was.
 * - stale: an input it read has changed (state value only until change requests land).
 */
export const NODE_STATUSES = ['wait', 'queued', 'running', 'review', 'done', 'failed', 'rejected', 'paused', 'stale'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Execution statuses that never show as a lane's state because a newer execution replaced them. */
export const EXECUTION_STATUSES = [...NODE_STATUSES, 'superseded', 'discarded'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * Why a node execution was activated.
 * - start: an entry node when the ticket was created.
 * - input: new input arrived over an edge.
 * - rework: input arrived whose lineage leads back to this lane's own earlier output (e.g. QA rejected it).
 * - review: a reviewer rejected the lane's held output (review gate); same inputs, with feedback.
 * - retry: a person retried a failed lane with the same inputs.
 */
export const ACTIVATION_CAUSES = ['start', 'input', 'rework', 'review', 'retry'] as const;
export type ActivationCause = (typeof ACTIVATION_CAUSES)[number];

// ---------------------------------------------------------------------------
// Settings layered app → project → template → node ([[명령·이벤트 계약]] §14)

export const MERGE_CONFLICT_POLICIES = ['ask', 'agent', 'rerun', 'fail'] as const;

export const WorkspaceSettingsSchema = Type.Object(
  {
    /** shared: every node works in the project folder. worktree: git worktrees (git repositories only). */
    workspaceMode: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('worktree')])),
    /** ticket: one worktree per ticket. nodeRun: fan-out lanes get a worktree each, merged by the join. */
    worktreeScope: Type.Optional(Type.Union([Type.Literal('ticket'), Type.Literal('nodeRun')])),
    /** Check files out right before an agent edits them (PreToolUse hook). Default: on in shared mode, off in worktree mode. */
    autoCheckoutHook: Type.Optional(Type.Boolean()),
    onMergeConflict: Type.Optional(Type.Union(MERGE_CONFLICT_POLICIES.map((policy) => Type.Literal(policy)))),
    /** Agent that resolves merge conflicts under `onMergeConflict: agent`. Default Claude with its default model. */
    mergeAgent: Type.Optional(
      Type.Object(
        {
          provider: Type.Union(AGENT_PROVIDERS.map((provider) => Type.Literal(provider))),
          model: Type.Optional(Type.String({ maxLength: 128 })),
        },
        { additionalProperties: false },
      ),
    ),
    /** Warn when two worktrees change the same file (a likely merge conflict), before the merge. */
    overlapWarning: Type.Optional(Type.Boolean()),
    /** Claim and checkout conflicts (§3.7). A claim of the node type may override them. */
    onConflict: Type.Optional(Type.Union(CLAIM_CONFLICT_POLICIES.map((policy) => Type.Literal(policy)))),
    pauseMode: Type.Optional(Type.Union(PAUSE_MODES.map((mode) => Type.Literal(mode)))),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Template

/** Definition ids: node types use their type ('vuyro.agent'); templates use 'namespace/name' ('vuyro/ai-sdlc'). */
export const DEFINITION_ID_PATTERN = '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*(/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$';
export const TEMPLATE_ID_PATTERN = '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$';

/**
 * Per-instance port changes: extend the type's data schema (allOf), add artifact slots (a slot with the
 * type's name replaces it), make the port strict, or switch an input to fan-out.
 */
export const PortOverrideSchema = Type.Object(
  {
    schema: Type.Optional(JsonSchemaObjectSchema),
    artifacts: Type.Optional(Type.Array(ArtifactSlotSpecSchema, { maxItems: 64 })),
    strict: Type.Optional(Type.Boolean()),
    /** Input ports only. */
    mode: Type.Optional(Type.Union([Type.Literal('whole'), Type.Literal('each')])),
  },
  { additionalProperties: false },
);

export const TemplateNodeSchema = Type.Object(
  {
    /** Stable id used in edges and expressions (`{{ nodes.<id> }}`). The label is for display. */
    id: NodeIdSchema,
    type: Type.String({ pattern: NODE_TYPE_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    /** Values for the type's params. Strings may hold expressions. Missing values take the param schema's `default`. */
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    ports: Type.Optional(Type.Record(Type.String({ pattern: PORT_PATTERN }), PortOverrideSchema, { additionalProperties: false })),
    /**
     * 'human': an agent's or script's output waits in Review until a person approves it (then it is routed)
     * or rejects it (then the node runs again with the reviewer's feedback). Default 'none'.
     */
    review: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('human')])),
    settings: Type.Optional(WorkspaceSettingsSchema),
    /** Canvas position. Display only. */
    position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false })),
    extensions: Type.Optional(ExtensionsSchema),
  },
  { additionalProperties: false },
);

export const PortRefSchema = Type.Object(
  { node: NodeIdSchema, port: Type.String({ pattern: PORT_PATTERN }) },
  { additionalProperties: false },
);

export const TemplateEdgeSchema = Type.Object(
  {
    from: PortRefSchema,
    to: PortRefSchema,
    /**
     * Condition AST (see expressions.ts `Condition`), evaluated per item with `item` = the item on the edge.
     * Items that fail it do not travel this edge. Checked when the template is saved.
     */
    when: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    label: Type.Optional(Type.String({ maxLength: 128 })),
  },
  { additionalProperties: false },
);

export const TemplateSpecSchema = Type.Object(
  {
    id: Type.String({ pattern: TEMPLATE_ID_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 65536 })),
    nodes: Type.Array(TemplateNodeSchema, { minItems: 1, maxItems: 500 }),
    edges: Type.Array(TemplateEdgeSchema, { maxItems: 2000 }),
    settings: Type.Optional(WorkspaceSettingsSchema),
    extensions: Type.Optional(ExtensionsSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Definition files (the export envelope)

export const DEFINITION_KINDS = ['nodeType', 'template'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
export const HashSchema = Type.String({ pattern: HASH_PATTERN });

const RequiresSchema = Type.Object(
  {
    vuyro: Type.Optional(Type.String({ maxLength: 64 })),
    nodeTypes: Type.Optional(Type.Record(Type.String({ pattern: NODE_TYPE_PATTERN }), Type.Integer({ minimum: 1 }), { additionalProperties: false })),
    plugins: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 64 }))),
    artifactKinds: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
    blackboard: Type.Optional(Type.Array(Type.String({ maxLength: 512 }))),
    /** Names only. Values never travel in a definition. */
    credentials: Type.Optional(Type.Array(Type.String({ maxLength: 128 }))),
  },
  { additionalProperties: false },
);

const envelopeFields = {
  vuyro: Type.Literal('export'),
  formatVersion: Type.Literal(1),
  id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
  version: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 65536 })),
  author: Type.Optional(Type.String({ maxLength: 200 })),
  requires: Type.Optional(RequiresSchema),
  /** 'sha256:<hex>' of the canonical JSON of the envelope without this field. Checked when present. */
  checksum: Type.Optional(HashSchema),
};

export const NodeTypeDefinitionSchema = Type.Object(
  { ...envelopeFields, kind: Type.Literal('nodeType'), content: NodeTypeSpecSchema },
  { additionalProperties: false },
);

export const TemplateDefinitionSchema = Type.Object(
  { ...envelopeFields, kind: Type.Literal('template'), content: TemplateSpecSchema },
  { additionalProperties: false },
);

export const DefinitionEnvelopeSchema = Type.Union([NodeTypeDefinitionSchema, TemplateDefinitionSchema]);

/** What a ticket runs with: the template version and the hash of every definition it used. */
export const PinnedTemplateSchema = Type.Object(
  {
    id: Type.String({ pattern: TEMPLATE_ID_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    hash: HashSchema,
    /** 'type@version' → hash of each node type the template uses. */
    nodeTypes: Type.Record(Type.String({ pattern: '^[a-z][a-z0-9.-]*@[1-9][0-9]*$' }), HashSchema, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export type WorkspaceSettings = Static<typeof WorkspaceSettingsSchema>;
export type PortOverride = Static<typeof PortOverrideSchema>;
export type TemplateNode = Static<typeof TemplateNodeSchema>;
export type PortRef = Static<typeof PortRefSchema>;
export type TemplateEdge = Static<typeof TemplateEdgeSchema>;
export type TemplateSpec = Static<typeof TemplateSpecSchema>;
export type NodeTypeDefinition = Static<typeof NodeTypeDefinitionSchema>;
export type TemplateDefinition = Static<typeof TemplateDefinitionSchema>;
export type DefinitionEnvelope = Static<typeof DefinitionEnvelopeSchema>;
export type PinnedTemplate = Static<typeof PinnedTemplateSchema>;

/** Aggregate id of a definition's version history: 'def:template:vuyro:ai-sdlc'. Injective because ids never contain ':'. */
export function definitionAggregateId(kind: DefinitionKind, id: string): string {
  return `def:${kind}:${id.replace('/', ':')}`;
}

export function nodeTypeKey(type: string, version: number): string {
  return `${type}@${version}`;
}
