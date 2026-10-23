import { Type } from '@sinclair/typebox';

/**
 * Entity ids (events, tickets, runs, projects, replicas) are UUIDv7 (RFC 9562), lowercase.
 * They are unique without coordination and sort by creation time, so logs from several replicas can be merged later.
 */
export const UUID_V7_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const uuidV7 = new RegExp(UUID_V7_PATTERN);

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && uuidV7.test(value);
}

/** Milliseconds since the Unix epoch encoded in a UUIDv7. */
export function uuidV7Timestamp(id: string): number {
  if (!uuidV7.test(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export const IdSchema = Type.String({ pattern: UUID_V7_PATTERN });

/** Client-chosen idempotency key. Any opaque token; clients normally send a UUID. */
export const REQUEST_ID_PATTERN = '^[A-Za-z0-9._:-]{8,128}$';
export const RequestIdSchema = Type.String({ pattern: REQUEST_ID_PATTERN });

/**
 * Node ids are chosen by template authors (e.g. 'spec', 'dev'), not generated.
 * Kept short and path-safe because they appear in expressions (`{{ nodes.<id>... }}`).
 */
export const NODE_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const NodeIdSchema = Type.String({ pattern: NODE_ID_PATTERN });

/** Aggregate ids are UUIDv7 or a fixed singleton name such as `permissions:app`. */
export const AGGREGATE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$';
export const AggregateIdSchema = Type.String({ pattern: AGGREGATE_ID_PATTERN });
