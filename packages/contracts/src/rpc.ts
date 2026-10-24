import { type Static, Type } from '@sinclair/typebox';
import { IdSchema, NodeIdSchema } from './ids.ts';
import type { TokenUsage } from './usage.ts';

/**
 * Engine wire protocol: JSON-RPC 2.0, one JSON object per line (NDJSON), on the authenticated engine pipe
 * ([[명령·이벤트 계약]] §11). The UI, the `vuyro` CLI and (later) MCP all speak it.
 *
 * A connection starts with `session.hello`, which fixes who the connection is for its whole life.
 */

export const RPC_METHODS = {
  hello: 'session.hello',
  execute: 'command.execute',
  subscribe: 'events.subscribe',
  unsubscribe: 'events.unsubscribe',
  readEvents: 'events.read',
  status: 'engine.status',
  shutdown: 'engine.shutdown',
  pair: 'auth.pair',
  projects: 'query.projects',
  tickets: 'query.tickets',
  ticket: 'query.ticket',
  artifacts: 'query.artifacts',
  ticketStats: 'query.ticketStats',
  workspace: 'query.workspace',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** Notifications the engine sends. */
export const RPC_NOTIFICATIONS = {
  /** A batch of events for a subscription, in sequence order without gaps. */
  events: 'events',
  /** The subscriber fell too far behind; the subscription is gone. Resubscribe from `lastSequence`. */
  overflow: 'events.overflow',
  /** During `auth.pair`: the code the approval dialog shows, so the requester can compare. */
  pairingCode: 'auth.pairingCode',
} as const;

/** Standard JSON-RPC errors (protocol level). Command failures use the codes in COMMAND_ERRORS. */
export const RPC_PROTOCOL_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

const strict = { additionalProperties: false } as const;

export const CLIENT_KINDS = ['ui', 'cli', 'mcp', 'unknown'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

const Secret = Type.String({ minLength: 1, maxLength: 256 });

export const HelloParamsSchema = Type.Object(
  {
    protocol: Type.Integer({ minimum: 1 }),
    client: Type.Union(CLIENT_KINDS.map((kind) => Type.Literal(kind))),
    /** The UI credential (passed to the engine at launch, or obtained by pairing). Makes this a `ui-session`. */
    uiCredential: Type.Optional(Secret),
    /** A CLI human credential (from `vuyro auth login`). Checked again on every command. */
    humanCredential: Type.Optional(Secret),
  },
  strict,
);
export type HelloParams = Static<typeof HelloParamsSchema>;

/** Who the connection is, as the engine decided at hello (without a run token on the request). */
export type ConnectionIdentity = 'ui' | 'human-cli' | 'unverified' | 'mcp';

export interface HelloResult {
  readonly protocol: number;
  readonly engineVersion: string;
  readonly identity: ConnectionIdentity;
  readonly lastSequence: number;
}

export const SubscribeParamsSchema = Type.Object({ afterSequence: Type.Optional(Type.Integer({ minimum: 0 })) }, strict);
export const UnsubscribeParamsSchema = Type.Object({ subscription: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
export const ReadEventsParamsSchema = Type.Object(
  { afterSequence: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) },
  strict,
);
export const PairParamsSchema = Type.Object({ kind: Type.Union([Type.Literal('ui'), Type.Literal('cli')]) }, strict);
export const ShutdownParamsSchema = Type.Object({}, strict);
export const StatusParamsSchema = Type.Object({}, strict);

export const TicketsQuerySchema = Type.Object({ projectId: Type.Optional(IdSchema) }, strict);
export const TicketQuerySchema = Type.Object({ ticketId: IdSchema }, strict);
export const ArtifactsQuerySchema = Type.Object({ ticketId: IdSchema, nodeId: Type.Optional(NodeIdSchema) }, strict);
export const ProjectsQuerySchema = Type.Object({}, strict);
/** The project's checkout ledger: entries held now, recent refusals and changes, overlap warnings, worktrees. */
export const WorkspaceQuerySchema = Type.Object(
  {
    projectId: IdSchema,
    ticketId: Type.Optional(IdSchema),
    /** Changes to list: unattributed and conflicting only (default), or every one. */
    changes: Type.Optional(Type.Union([Type.Literal('flagged'), Type.Literal('all')])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  strict,
);

export interface SubscribeResult {
  readonly subscription: string;
}

export interface PairResult {
  readonly kind: 'ui' | 'cli';
  readonly credential: string;
  /** Epoch ms; absent = valid until the engine stops. */
  readonly expiresAt?: number;
}

export interface EngineStatus {
  readonly pid: number;
  readonly engineVersion: string;
  readonly startedAt: number;
  readonly dataDir: string;
  /** Agents and scripts running now. */
  readonly running: number;
  readonly lastSequence: number;
}

// ---------------------------------------------------------------------------
// Statistics ([[명령·이벤트 계약]] §12): computed from the events, in milliseconds and tokens.

export interface TokenTotals extends TokenUsage {
  readonly reasoning: number;
}

export interface UsageStats {
  readonly tokens: TokenTotals;
  /** List-price estimate where the provider gives one (Claude); never a bill. */
  readonly costUsd?: number;
  readonly agentRuns: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly messages: number;
}

export interface TimeStats {
  /** Waiting for an executor slot (queued; rejected executor nodes before they start again). */
  readonly queuedMs: number;
  /** An agent or script was running. */
  readonly runningMs: number;
  /** Waiting for a person: review, human nodes, rejected human tasks. */
  readonly humanWaitMs: number;
  readonly pausedMs: number;
}

export interface NodeStats extends TimeStats, UsageStats {
  readonly nodeId: string;
  readonly executions: number;
  readonly attempts: number;
  readonly failed: number;
  /** Executions started again by rework, review returns and retries. */
  readonly reworks: number;
  /** Approvals, rejections and human completions on this node, by people and by AI (`actor.kind`). */
  readonly decisions: { readonly human: number; readonly ai: number };
}

export interface TicketStats extends UsageStats {
  readonly ticketId: string;
  readonly status: 'open' | 'done';
  readonly createdAt: number;
  readonly completedAt?: number;
  /** Created to completed, or to now while open. */
  readonly totalMs: number;
  /** Wall-clock time in which at least one thing waited for a person (overlaps counted once). */
  readonly humanWaitMs: number;
  /** Wall-clock time in which at least one agent or script ran. */
  readonly activeMs: number;
  readonly nodes: readonly NodeStats[];
  /** Node with the most running + human wait time. */
  readonly bottleneck?: string;
  /** When the numbers were computed (open intervals end here). */
  readonly asOf: number;
}
