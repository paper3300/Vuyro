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
  worktreeCleanup: 'query.worktreeCleanup',
  sharedNodes: 'query.sharedNodes',
  templates: 'query.templates',
  board: 'query.board',
  runEvents: 'query.runEvents',
  definitions: 'query.definitions',
  exportDefinition: 'query.exportDefinition',
  importPreview: 'query.importPreview',
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

/** Worktrees a person may clean up, with what each still holds (`vuyro workspace cleanup`). */
export const WorktreeCleanupQuerySchema = Type.Object({ projectId: IdSchema, ticketId: Type.Optional(IdSchema) }, strict);

export interface WorktreeCleanupCandidate {
  readonly key: string;
  readonly ticketId: string;
  readonly scope: 'ticket' | 'lane';
  readonly nodeId?: string;
  readonly lane?: string;
  readonly path: string;
  readonly branch: string;
  /** Its branch is in the ticket branch (removing the worktree then also deletes the branch). */
  readonly merged: boolean;
  /** Changed and untracked files, and ignored files (first 200 of each), with their counts. */
  readonly files: readonly string[];
  readonly count: number;
  readonly ignored: readonly string[];
  readonly ignoredCount: number;
  /** What `worktree.cleanup` must send back: it changes when anything in the worktree changes. */
  readonly fingerprint: string;
}

/** A project's shared nodes: definition, status, queue, running and recent batches (M5). */
export const SharedNodesQuerySchema = Type.Object({ projectId: IdSchema, name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, strict);

export interface SharedQueueEntryView {
  readonly ticketId: string;
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  /** 1-based place in the queue. */
  readonly position: number;
  readonly queuedAt: number;
  /** Put back by a failed or interrupted batch. */
  readonly retry: boolean;
}

export interface SharedBatchView {
  readonly batch: number;
  readonly batchId: string;
  readonly trigger: string;
  readonly members: readonly { readonly ticketId: string; readonly nodeId: string; readonly lane: string; readonly run: number }[];
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly outcome?: 'succeeded' | 'failed' | 'interrupted';
  readonly policy?: string;
  /** Tickets sent to their error port (the blamed ones under `blame`). */
  readonly failed?: readonly string[];
  readonly errorFiles?: readonly string[];
}

export interface SharedNodeView {
  readonly projectId: string;
  readonly name: string;
  readonly label: string;
  readonly version: number;
  readonly spec: unknown;
  /** idle, running, blocked, or waiting (for protected paths someone else holds). */
  readonly status: 'idle' | 'running' | 'blocked' | 'waiting';
  readonly blocked?: { readonly reason: string; readonly batch: number; readonly by: readonly { readonly ticketId: string; readonly nodeId: string; readonly lane: string; readonly run: number }[] };
  readonly queue: readonly SharedQueueEntryView[];
  readonly running: readonly SharedBatchView[];
  /** The last batches, newest first (at most 20). */
  readonly recent: readonly SharedBatchView[];
}

/**
 * One agent run's log (M6b node detail): messages, tool calls, usage, warnings and the end, in order, a page at a time.
 * `after` is the run's event revision to continue from (the previous page's `cursor`). Long text is cut at `textLimit`
 * characters; ask again for one entry (`after` = its revision - 1, `limit` 1) with a larger limit to see all of it.
 */
export const RunEventsQuerySchema = Type.Object(
  {
    runId: IdSchema,
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    textLimit: Type.Optional(Type.Integer({ minimum: 200, maximum: 1_048_576 })),
  },
  strict,
);

/** Text as the log shows it: the first `textLimit` characters, and the full length. */
export interface LogText {
  readonly text: string;
  readonly length: number;
}

interface RunLogBase {
  /** The run's event revision (the paging cursor). */
  readonly revision: number;
  readonly sequence: number;
  /** When the adapter saw it (falls back to when it was stored). Epoch ms. */
  readonly at: number;
}

export type RunLogEntry = RunLogBase &
  (
    | { readonly kind: 'started'; readonly provider: string; readonly resumedFromRunId?: string }
    | { readonly kind: 'session'; readonly model?: string; readonly cliVersion?: string }
    | { readonly kind: 'message'; readonly role: 'assistant' | 'user' | 'system'; readonly messageId?: string; readonly text: LogText }
    | { readonly kind: 'toolStarted'; readonly toolCallId: string; readonly name: string; readonly input?: LogText }
    | { readonly kind: 'toolFinished'; readonly toolCallId: string; readonly isError: boolean; readonly output?: LogText }
    | { readonly kind: 'usage'; readonly scope: 'run' | 'turn'; readonly tokens: TokenUsage; readonly model?: string }
    | { readonly kind: 'warning'; readonly message: LogText; readonly source?: string }
    | { readonly kind: 'raw'; readonly stream: 'stdout' | 'stderr'; readonly providerType?: string; readonly text: LogText }
    | { readonly kind: 'settled'; readonly outcome: string; readonly exitCode?: number | null; readonly terminalReason?: string; readonly error?: LogText }
  );

export interface RunEventsResult {
  readonly run: {
    readonly runId: string;
    readonly ticketId: string;
    readonly nodeId: string;
    readonly provider: string;
    readonly status: string;
    readonly model: string | null;
    readonly startedAt: number;
    readonly settledAt: number | null;
  };
  readonly entries: readonly RunLogEntry[];
  /** Pass as `after` for the next page. */
  readonly cursor: number;
  /** More events after this page (now). */
  readonly more: boolean;
}

/** Active templates, latest version of each (M6: ticket creation). */
export const TemplatesQuerySchema = Type.Object({}, strict);
/** A project's tickets with their lanes and token totals, and the workflows they pinned (M6: board). */
export const BoardQuerySchema = Type.Object({ projectId: IdSchema }, strict);

/**
 * A workflow as screens draw it: its nodes in stage order (topological over forward edges, then position, then
 * template order) and its edges. Built from the compiled template; the engine's graph model stays the meaning.
 */
export interface WorkflowNodeView {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly typeVersion: number;
  readonly completion: string;
  /** 'human': an agent's or script's result waits for a person (review gate). */
  readonly review: 'none' | 'human';
  readonly position?: { readonly x: number; readonly y: number };
  readonly outputs: readonly { readonly name: string; readonly label?: string }[];
  /** Input mode of the first input port ('each' = one lane per item). */
  readonly inputMode: 'whole' | 'each' | 'none';
}

export interface WorkflowEdgeView {
  readonly from: { readonly node: string; readonly port: string };
  readonly to: { readonly node: string; readonly port: string };
  /** Goes back upstream (rework loop). */
  readonly back: boolean;
  readonly label?: string;
}

export interface WorkflowView {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly name: string;
  readonly description?: string;
  readonly nodes: readonly WorkflowNodeView[];
  readonly edges: readonly WorkflowEdgeView[];
}

/** One template in `query.templates`. `problem` is set (and `nodes` empty) when its files cannot be used. */
export interface TemplateSummary extends WorkflowView {
  readonly problem?: string;
}

/** One output or input item shown to the person who decides (summary, data, artifacts). */
export interface ItemView {
  readonly summary?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly artifacts?: Readonly<Record<string, { readonly kind: string; readonly uri: string; readonly version?: string; readonly title?: string }>>;
}

/**
 * Something waiting for a person on an open ticket: an approval node (approve / reject), a human task (finish on
 * one of its ports), or a review gate holding an executor's result (approve sends it on, reject runs it again).
 */
export interface ReviewView {
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly kind: 'approval' | 'task' | 'gate';
  /** Gate: what the executor produced (the port it chose and its items). */
  readonly output?: { readonly port: string; readonly items: readonly ItemView[] };
  /** Approval and task: the input items. */
  readonly inputs?: readonly ItemView[];
  /** Gate: the output reached no edge (D-016); approving sends an empty delivery. */
  readonly reason?: 'empty';
  /** Gate: a join's merge stopped on conflicts (M4). */
  readonly merge?: unknown;
  /** The reviewer's comment that started this execution again, if any. */
  readonly feedback?: string;
}

export interface BoardLaneView {
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly status: string;
  readonly waitingFor: unknown;
  readonly updatedAt: number;
}

export interface BoardTicketView {
  readonly ticketId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly template: { readonly id: string; readonly version: number; readonly hash: string } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly revision: number;
  readonly attention: string | null;
  readonly lanes: readonly BoardLaneView[];
  /** Sum over the ticket's agent runs (input excludes cache, as in the events). */
  readonly tokens: TokenTotals;
}

export interface BoardResult {
  readonly tickets: readonly BoardTicketView[];
  /** The workflows the tickets pinned, by `<id>@<version>` (missing when its files no longer match). */
  readonly workflows: Readonly<Record<string, WorkflowView>>;
}

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
