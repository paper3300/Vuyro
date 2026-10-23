import { type Static, Type } from '@sinclair/typebox';

/**
 * Error codes a command can fail with. The same object is returned in-process,
 * as the `data` of a JSON-RPC error, and printed by the CLI, so agents can act on `code`.
 */
export const COMMAND_ERRORS = {
  /** The envelope or payload does not match the schema. `details.issues` lists the problems. */
  validation_failed: { rpcCode: -32602, retryable: false },
  unknown_command: { rpcCode: -32009, retryable: false },
  unsupported_schema_version: { rpcCode: -32008, retryable: false },
  /** A run token was presented but is unknown, revoked, or the run has settled. */
  unauthenticated: { rpcCode: -32001, retryable: false },
  /** The principal may never run this command (e.g. AI and `permission.edit`). */
  forbidden: { rpcCode: -32002, retryable: false },
  /** The principal may run the command, but not on this ticket or node. */
  out_of_scope: { rpcCode: -32003, retryable: false },
  /** `expectedRevision` did not match. Reload and retry with the new revision. */
  revision_conflict: { rpcCode: -32004, retryable: true },
  /** The request id was already used for a different command or by another principal. */
  idempotency_conflict: { rpcCode: -32005, retryable: false },
  not_found: { rpcCode: -32006, retryable: false },
  /** The command is valid but not allowed in the current state (e.g. observing a settled run). */
  invariant_violated: { rpcCode: -32007, retryable: false },
  internal: { rpcCode: -32603, retryable: true },
} as const satisfies Record<string, { rpcCode: number; retryable: boolean }>;

export type CommandErrorCode = keyof typeof COMMAND_ERRORS;

export const COMMAND_ERROR_CODES = Object.keys(COMMAND_ERRORS) as CommandErrorCode[];

export const CommandErrorSchema = Type.Object(
  {
    code: Type.Union(COMMAND_ERROR_CODES.map((code) => Type.Literal(code))),
    message: Type.String(),
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export type CommandError = Static<typeof CommandErrorSchema>;

export function commandError(code: CommandErrorCode, message: string, details?: Record<string, unknown>): CommandError {
  const error: CommandError = { code, message, retryable: COMMAND_ERRORS[code].retryable };
  if (details !== undefined) error.details = details;
  return error;
}
