import { type Static, Type } from '@sinclair/typebox';
import { NodeIdSchema } from './ids.ts';

/**
 * Handoff envelope between nodes ([[n8n 노드 데이터 전달 분석]] §6.3).
 * The outer shape is fixed so any custom node connects to any other; only `data`,
 * artifact slots and ports are customizable.
 */

export const ARTIFACT_KIND_PATTERN = '^[a-z][a-z0-9.-]{0,63}$';
export const SLOT_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,63}$';
export const PORT_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';

/** Points at an artifact outside Vuyro (location + version), never its content. */
export const ArtifactRefSchema = Type.Object(
  {
    /** 'file' | 'git' | 'p4' | 'confluence' | 'jira' | 'url' | plugin kinds. */
    kind: Type.String({ pattern: ARTIFACT_KIND_PATTERN }),
    uri: Type.String({ minLength: 1, maxLength: 2048 }),
    /** git sha, p4 CL, page version… */
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    title: Type.Optional(Type.String({ maxLength: 512 })),
    mimeType: Type.Optional(Type.String({ maxLength: 128 })),
    /** e.g. 'sha256:<hex>'. Used for Stale detection. */
    contentHash: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false },
);

/** Which upstream item an item came from: node, node run number (1-based), item index (0-based). */
export const ItemRefSchema = Type.Object(
  {
    nodeId: NodeIdSchema,
    run: Type.Integer({ minimum: 1 }),
    item: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const HandoffItemSchema = Type.Object(
  {
    /** Validated against the port's declared schema; undeclared fields are kept (unless the node is strict). */
    data: Type.Record(Type.String(), Type.Unknown()),
    artifacts: Type.Optional(
      Type.Record(Type.String({ pattern: SLOT_PATTERN }), ArtifactRefSchema, { additionalProperties: false }),
    ),
    /** Markdown summary for the next agent and the reviewer. */
    summary: Type.Optional(Type.String({ maxLength: 65536 })),
    lineage: Type.Optional(Type.Array(ItemRefSchema)),
  },
  { additionalProperties: false },
);

export const NodeRunOutputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    /** Result port the run left through: 'done' | 'approve' | 'reject' | 'error' | … */
    port: Type.String({ pattern: PORT_PATTERN }),
    items: Type.Array(HandoffItemSchema),
  },
  { additionalProperties: false },
);

export type ArtifactRef = Static<typeof ArtifactRefSchema>;
export type ItemRef = Static<typeof ItemRefSchema>;
export type HandoffItem = Static<typeof HandoffItemSchema>;
export type NodeRunOutput = Static<typeof NodeRunOutputSchema>;
