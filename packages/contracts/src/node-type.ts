import { type Static, Type } from '@sinclair/typebox';
import { ARTIFACT_KIND_PATTERN, PORT_PATTERN, SLOT_PATTERN } from './handoff.ts';

/**
 * Declarative node type ([[n8n 노드 데이터 전달 분석]] §6.4). Built-in nodes use the same format.
 * M1 fixes the shape; M2 adds the executors that interpret it.
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
  },
  { additionalProperties: false },
);

export const NodeTypeSpecSchema = Type.Object(
  {
    /** Namespaced: 'vuyro.agent', 'vuyro.approval', 'p4.sync'. */
    type: Type.String({ pattern: NODE_TYPE_PATTERN }),
    /** Pinned by templates, like n8n typeVersion. */
    version: Type.Integer({ minimum: 1 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    completion: Type.Union([Type.Literal('human'), Type.Literal('agent'), Type.Literal('join'), Type.Literal('script')]),
    inputs: Type.Array(PortSpecSchema),
    outputs: Type.Array(PortSpecSchema),
    attachments: Type.Optional(Type.Array(AttachmentSpecSchema)),
    params: Type.Array(ParamSpecSchema),
  },
  { additionalProperties: false },
);

export type ArtifactSlotSpec = Static<typeof ArtifactSlotSpecSchema>;
export type PortSpec = Static<typeof PortSpecSchema>;
export type AttachmentSpec = Static<typeof AttachmentSpecSchema>;
export type ParamSpec = Static<typeof ParamSpecSchema>;
export type NodeTypeSpec = Static<typeof NodeTypeSpecSchema>;
