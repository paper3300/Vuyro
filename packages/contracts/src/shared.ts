import { type Static, Type } from '@sinclair/typebox';
import { ArtifactRefSchema } from './handoff.ts';
import { IdSchema } from './ids.ts';
import { NODE_TYPE_PATTERN } from './node-type.ts';
import { HashSchema } from './workflow.ts';
import { HolderSchema } from './workspace.ts';

/**
 * Shared nodes ([[구현 계획]] M5, [[공유·권한·BlackBoard 설계]] §4): a node that lives in a project, not in a ticket.
 * Request nodes of many tickets (`completion: 'shared'`) queue their ticket's work for it; when a trigger fires it runs
 * its node type once for the whole batch and hands every ticket its own share of the result.
 *
 * Every shared node is one aggregate (`shared:<projectId>:<name>`): its definition, the queue, running batches and
 * whether it is blocked by a ticket that broke a batch. The ticket side stays in the ticket aggregates.
 */

const strict = { additionalProperties: false } as const;

/** The name request nodes use (`sharedNode` param). Same pattern as the spec's `name`. */
export const SHARED_NODE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const SharedNodeNameSchema = Type.String({ pattern: SHARED_NODE_NAME_PATTERN });

/** What started a batch. `retry`: requests a failed or interrupted batch put back (they already met a trigger once). */
export const BATCH_TRIGGERS = ['count', 'window', 'afterPrevious', 'manual', 'retry'] as const;
export type BatchTrigger = (typeof BATCH_TRIGGERS)[number];

/**
 * How a failed batch was settled. `blame`: the tickets that changed the files in the errors fail, the others go back
 * to the queue and the shared node is blocked until the blamed tickets come back. `allFail`: every ticket fails.
 */
export const APPLIED_BATCH_POLICIES = ['blame', 'allFail'] as const;

/** Why a shared node does not start batches. */
export const SHARED_BLOCK_REASONS = ['blamed', 'interrupted'] as const;

/** The node type the shared node runs, pinned with its hash when it was defined. */
export const PinnedNodeTypeSchema = Type.Object(
  { type: Type.String({ pattern: NODE_TYPE_PATTERN }), version: Type.Integer({ minimum: 1 }), hash: HashSchema },
  strict,
);

/** A queued request: one execution of a request node (its ticket, node, lane and run). */
export const SharedRequestSchema = HolderSchema;

export const BatchOutcomeSchema = Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('interrupted')]);

/** What the engine reports when a batch's script ended (`sharedNode.finish`). Same fields as a script node's result. */
export const BatchScriptResultSchema = Type.Object(
  {
    kind: Type.Literal('script'),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
    timedOut: Type.Optional(Type.Boolean()),
    /** Could not start, or the program resolved to nothing. */
    error: Type.Optional(Type.String({ maxLength: 65536 })),
    stdout: Type.Optional(Type.String({ maxLength: 1_048_576 })),
    stderr: Type.Optional(Type.String({ maxLength: 65536 })),
    /** Where the engine wrote the batch's full output. */
    log: Type.Optional(ArtifactRefSchema),
  },
  strict,
);

/** The engine restarted while the batch ran: nobody knows how it ended. */
export const BatchInterruptedSchema = Type.Object({ kind: Type.Literal('interrupted'), reason: Type.String({ maxLength: 1024 }) }, strict);

export const SharedNodeFields = {
  projectId: IdSchema,
  name: SharedNodeNameSchema,
};

export type SharedRequest = Static<typeof SharedRequestSchema>;
export type PinnedNodeType = Static<typeof PinnedNodeTypeSchema>;
export type BatchOutcome = Static<typeof BatchOutcomeSchema>;
export type BatchScriptResult = Static<typeof BatchScriptResultSchema>;
export type SharedBlockReason = (typeof SHARED_BLOCK_REASONS)[number];

/** Aggregate id of a shared node. Injective: project ids are UUIDs and names never contain ':'. */
export function sharedNodeAggregateId(projectId: string, name: string): string {
  return `shared:${projectId}:${name}`;
}

/** `<name>-<batch number>`: what tickets and logs call a batch. */
export function batchIdOf(name: string, batch: number): string {
  return `${name}-${batch}`;
}
