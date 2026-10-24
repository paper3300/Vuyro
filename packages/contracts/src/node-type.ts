import { type Static, Type } from '@sinclair/typebox';
import { ARTIFACT_KIND_PATTERN, PORT_PATTERN, SLOT_PATTERN } from './handoff.ts';

/**
 * Declarative node type ([[n8n 노드 데이터 전달 분석]] §6.4). Built-in nodes use the same format.
 * M1 fixes the shape; M2 adds the executors that interpret it.
 *
 * Extension rule: the schema is strict (unknown fields are rejected, so a typo never passes silently).
 * New engine features add optional fields here; plugins put their own data under `extensions.<namespace>`.
 */

export const NODE_TYPE_PATTERN = '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$';
const NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';

/** A JSON Schema 2020-12 document (object form). Kept opaque here; validated when a definition is saved. */
export const JsonSchemaObjectSchema = Type.Record(Type.String(), Type.Unknown());

export const ArtifactSlotSpecSchema = Type.Object(
  {
    slot: Type.String({ pattern: SLOT_PATTERN }),
    kinds: Type.Array(Type.String({ pattern: ARTIFACT_KIND_PATTERN }), { minItems: 1 }),
    required: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PortSpecSchema = Type.Object(
  {
    name: Type.String({ pattern: PORT_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    schema: Type.Optional(JsonSchemaObjectSchema),
    artifacts: Type.Optional(Type.Array(ArtifactSlotSpecSchema)),
    /** Input ports only. 'each' runs the node once per item (fan-out). */
    mode: Type.Optional(Type.Union([Type.Literal('whole'), Type.Literal('each')])),
    required: Type.Optional(Type.Boolean()),
    /** Reject undeclared data fields instead of keeping them. Default false. */
    strict: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Capabilities plugged into a node (agent adapter, skill, rule, MCP server), not data. */
export const AttachmentSpecSchema = Type.Object(
  {
    name: Type.String({ pattern: NAME_PATTERN }),
    kinds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1 }),
    required: Type.Optional(Type.Boolean()),
    multiple: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Node parameters are described by JSON Schema, so the UI can generate the form. */
export const ParamSpecSchema = Type.Object(
  {
    name: Type.String({ pattern: NAME_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    schema: JsonSchemaObjectSchema,
    required: Type.Optional(Type.Boolean()),
    /**
     * The value is a secret (a token, a password): exporting always replaces it, in the type's default and in every
     * template's value, with a `${secret:…}` placeholder (M6b review). The declaration is the authority; guessing from
     * names and values only adds to it.
     */
    secret: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * BlackBoard key or key pattern ([[공유·권한·BlackBoard 설계]] §3.4): 'app:glossary',
 * 'project:design/styleGuide', 'project:design/*'. MVP scopes are app and project.
 */
export const BLACKBOARD_KEY_PATTERN = '^(app|project):[A-Za-z0-9_.*-]+(/[A-Za-z0-9_.*-]+)*$';
export const BlackboardKeySchema = Type.String({ pattern: BLACKBOARD_KEY_PATTERN, maxLength: 512 });

/** Duration such as '500ms', '30s', '20m', '2h', '1d'. */
export const DURATION_PATTERN = '^[1-9][0-9]{0,8}(ms|s|m|h|d)$';
export const DurationSchema = Type.String({ pattern: DURATION_PATTERN });

/** Claim conflict policy (§3.7). Layered app → project → template → claim; a claim may override it. */
export const CLAIM_CONFLICT_POLICIES = ['firstWins', 'priorityWins', 'ask', 'warn', 'fail'] as const;
export const PAUSE_MODES = ['boundary', 'immediate'] as const;

/**
 * A claim the node takes when it starts (§3.7). `path` is a workspace path pattern ('Source/Game/UI/**').
 * Shared nodes hold shared (read) claims while a batch runs (§4.3).
 */
export const ClaimSpecSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    mode: Type.Union([Type.Literal('exclusive'), Type.Literal('shared')]),
    release: Type.Optional(Type.Union([Type.Literal('nodeDone'), Type.Literal('ticketDone'), Type.Literal('manual')])),
    /** Clean-up deadline for claims left behind by a crash. */
    ttl: Type.Optional(DurationSchema),
    onConflict: Type.Optional(Type.Union(CLAIM_CONFLICT_POLICIES.map((policy) => Type.Literal(policy)))),
    pauseMode: Type.Optional(Type.Union(PAUSE_MODES.map((mode) => Type.Literal(mode)))),
  },
  { additionalProperties: false },
);

/**
 * Environment variable names a script may set. `VUYRO_*` is reserved for the engine, in any letter case
 * (Windows environment names are case-insensitive, so `vuyro_run_token` would be the same variable).
 */
export const ENV_NAME_PATTERN = '^(?![Vv][Uu][Yy][Rr][Oo]_)[A-Za-z_][A-Za-z0-9_]{0,127}$';
export const EXIT_PORT_KEY_PATTERN = '^(default|0|-?[1-9][0-9]{0,9})$';

/**
 * What a `completion: 'script'` node runs. Every string is a template ([[n8n 노드 데이터 전달 분석]] §6.5):
 * `args: ['sync', '{{ params.path }}']`. An argument that is exactly one expression resolving to an array
 * is spread into several arguments. The program runs without a shell, with a minimal environment.
 */
export const ScriptSpecSchema = Type.Object(
  {
    program: Type.String({ minLength: 1, maxLength: 1024 }),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 256 })),
    env: Type.Optional(Type.Record(Type.String({ pattern: ENV_NAME_PATTERN }), Type.String({ maxLength: 8192 }), { additionalProperties: false })),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    /** Killed after this long and finished through the error port. Default 30m. */
    timeout: Type.Optional(DurationSchema),
    /** Exit code → output port. Default `{ "0": "done", "default": "error" }`. */
    exitPorts: Type.Optional(
      Type.Record(Type.String({ pattern: EXIT_PORT_KEY_PATTERN }), Type.String({ pattern: PORT_PATTERN }), { additionalProperties: false }),
    ),
    /**
     * 'json': the last non-empty stdout line is `{port?, data?, summary?, items?}` and becomes the output.
     * 'none' (default): the output is one item with the exit code and the tail of stdout.
     */
    output: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('json')])),
  },
  { additionalProperties: false },
);

/** Plugin data keyed by plugin namespace ('p4', 'myteam.build'). Never interpreted by the engine. */
export const ExtensionsSchema = Type.Record(Type.String({ pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$' }), Type.Unknown(), {
  additionalProperties: false,
});

export const NodeTypeSpecSchema = Type.Object(
  {
    /** Namespaced: 'vuyro.agent', 'vuyro.approval', 'p4.sync'. */
    type: Type.String({ pattern: NODE_TYPE_PATTERN }),
    /** Pinned by templates, like n8n typeVersion. */
    version: Type.Integer({ minimum: 1 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    /** 'shared' = a request node that queues the ticket for a shared node and waits for its share of the result (§4). */
    completion: Type.Union([
      Type.Literal('human'),
      Type.Literal('agent'),
      Type.Literal('join'),
      Type.Literal('script'),
      Type.Literal('shared'),
    ]),
    inputs: Type.Array(PortSpecSchema),
    outputs: Type.Array(PortSpecSchema),
    attachments: Type.Optional(Type.Array(AttachmentSpecSchema)),
    params: Type.Array(ParamSpecSchema),
    /** BlackBoard keys the node reads / writes (§3.5): graph display, export `requires.blackboard`, permissions. */
    reads: Type.Optional(Type.Array(BlackboardKeySchema)),
    writes: Type.Optional(Type.Array(BlackboardKeySchema)),
    /** Claims taken together when the node starts (§3.7). */
    claims: Type.Optional(Type.Array(ClaimSpecSchema)),
    /**
     * `completion: 'agent'`: the prompt template. The engine appends the reporting instructions
     * (output ports, their schemas and artifact slots) after it.
     */
    prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 262_144 })),
    /** `completion: 'script'`: the command to run. */
    script: Type.Optional(ScriptSpecSchema),
    extensions: Type.Optional(ExtensionsSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Shared node (§4): lives in a project, takes queued requests from many tickets and runs them as one batch.

export const BATCH_FAILURE_POLICIES = ['blame', 'ask', 'allFail', 'bisect', 'agent'] as const;

/** One branch per trigger that can start a batch: present (count, window, schedule) or set to true (flags). */
const BATCH_TRIGGER_ENABLED = [
  { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
  { type: 'object', required: ['window'], properties: { window: { type: 'string' } } },
  { type: 'object', required: ['schedule'], properties: { schedule: { type: 'string' } } },
  { type: 'object', required: ['afterPrevious'], properties: { afterPrevious: { const: true } } },
  { type: 'object', required: ['manual'], properties: { manual: { const: true } } },
];

export const SharedNodeSpecSchema = Type.Object(
  {
    /** Stable name that request nodes reference (their `sharedNode` param). */
    name: Type.String({ pattern: NAME_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    /** The node run once per batch: any node type, pinned by version. */
    node: Type.Object(
      {
        type: Type.String({ pattern: NODE_TYPE_PATTERN }),
        version: Type.Integer({ minimum: 1 }),
        params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
    /** Schema each request item must match, so different templates can share the node. */
    requestSchema: Type.Optional(JsonSchemaObjectSchema),
    /** Runs when the first condition is met (§4.2). At least one condition. */
    batchTrigger: Type.Object(
      {
        count: Type.Optional(Type.Integer({ minimum: 1 })),
        window: Type.Optional(DurationSchema),
        afterPrevious: Type.Optional(Type.Boolean()),
        manual: Type.Optional(Type.Boolean()),
        /** Cron expression. After MVP. */
        schedule: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        /** Modifier, not a trigger: does not count as an enabled condition. */
        expediteOnPriority: Type.Optional(Type.Boolean()),
      },
      // At least one condition must actually be on: false flags do not count.
      { additionalProperties: false, anyOf: BATCH_TRIGGER_ENABLED },
    ),
    maxConcurrent: Type.Integer({ minimum: 1 }),
    /** Claims held while a batch runs (§4.3), normally shared claims on the sources. */
    protect: Type.Optional(Type.Array(ClaimSpecSchema)),
    onBatchFailure: Type.Union(BATCH_FAILURE_POLICIES.map((policy) => Type.Literal(policy))),
    /** Raise the blamed ticket's priority while the shared node is blocked (§4.5). */
    raiseBlamedPriority: Type.Optional(Type.Boolean()),
    extensions: Type.Optional(ExtensionsSchema),
  },
  { additionalProperties: false },
);

export type ArtifactSlotSpec = Static<typeof ArtifactSlotSpecSchema>;
export type PortSpec = Static<typeof PortSpecSchema>;
export type AttachmentSpec = Static<typeof AttachmentSpecSchema>;
export type ParamSpec = Static<typeof ParamSpecSchema>;
export type NodeTypeSpec = Static<typeof NodeTypeSpecSchema>;
export type ClaimSpec = Static<typeof ClaimSpecSchema>;
export type ScriptSpec = Static<typeof ScriptSpecSchema>;
export type SharedNodeSpec = Static<typeof SharedNodeSpecSchema>;
