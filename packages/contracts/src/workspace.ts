import { type Static, Type } from '@sinclair/typebox';
import { IdSchema, NodeIdSchema } from './ids.ts';
import { CLAIM_CONFLICT_POLICIES } from './node-type.ts';
import { HashSchema, WorkspaceSettingsSchema } from './workflow.ts';

/**
 * Workspaces and the internal checkout ledger ([[구현 계획]] M4, [[공유·권한·BlackBoard 설계]] §3.7–§3.9).
 *
 * Every project has one ledger (aggregate `workspace:<projectId>`). It records which execution holds which
 * workspace path (claims taken when a node starts, checkouts taken right before a file is edited), conflicts and
 * how they were decided, changes found afterwards, and the git worktrees the engine made. It never touches the
 * external tools: no git or Perforce lock or checkout is ever taken (Vuyro's checkout is its own bookkeeping).
 */

const strict = { additionalProperties: false } as const;

/** An absolute folder: `C:\…`, `C:/…`, `\\server\share\…` or `/…`. Checked again (and normalized) by the engine. */
export const ABSOLUTE_PATH_PATTERN = '^([A-Za-z]:[\\\\/]|\\\\\\\\|/)';
export const AbsolutePathSchema = Type.String({ minLength: 1, maxLength: 1024, pattern: ABSOLUTE_PATH_PATTERN });

/**
 * A workspace path pattern relative to the workspace folder, with `/` separators: `Source/Game/UI/**`,
 * `*.md`, `docs/spec.md`. `**` crosses folders, `*` and `?` do not. No `..` segments.
 */
export const WorkspacePatternSchema = Type.String({ minLength: 1, maxLength: 1024 });

/** Which paths change detection looks at. Default include everything, exclude `.git` and build output folders. */
export const WatchSettingsSchema = Type.Object(
  {
    include: Type.Optional(Type.Array(WorkspacePatternSchema, { maxItems: 256 })),
    exclude: Type.Optional(Type.Array(WorkspacePatternSchema, { maxItems: 256 })),
  },
  strict,
);

/** A git ref name or commit the ticket branches start from (`main`, `origin/main`, a sha). */
export const GitRefSchema = Type.String({ minLength: 1, maxLength: 256, pattern: '^(?!-)[^\\s~^:?*\\[\\\\]+$' });

/**
 * The project's workspace: its folder and the project layer of the settings (app → project → template → node).
 * A ticket pins the merged app + project layer when it is created, so later changes apply to new tickets only.
 */
export const ProjectWorkspaceFields = {
  /** The folder agents work in (shared mode), and the git repository worktrees are made from (worktree mode). */
  root: Type.Optional(Type.Union([AbsolutePathSchema, Type.Null()])),
  /** Where ticket branches start in worktree mode. Default: the repository's HEAD when the ticket's first worktree is made. */
  baseRef: Type.Optional(Type.Union([GitRefSchema, Type.Null()])),
  watch: Type.Optional(WatchSettingsSchema),
  settings: Type.Optional(WorkspaceSettingsSchema),
};

/** What a ticket runs with: pinned at `ticket.created` from the app and project layers. */
export const TicketWorkspaceSchema = Type.Object(
  {
    root: Type.Optional(AbsolutePathSchema),
    baseRef: Type.Optional(GitRefSchema),
    watch: Type.Optional(WatchSettingsSchema),
    /** App and project layers merged (project wins). Template and node layers come from the pinned template. */
    settings: WorkspaceSettingsSchema,
  },
  strict,
);

// ---------------------------------------------------------------------------
// Ledger

/** Who holds an entry: one node execution (lane + execution number). */
export const HolderSchema = Type.Object(
  {
    ticketId: IdSchema,
    nodeId: NodeIdSchema,
    lane: Type.String({ minLength: 1, maxLength: 16 }),
    run: Type.Integer({ minimum: 1 }),
  },
  strict,
);

/**
 * Where an entry lives. `root` is the project folder (shared mode); `wt:<key>` is a git worktree the engine made
 * (`wt:<ticket key>` for the ticket's own worktree, `wt:<ticket key>/<node>-<lane>` for one fan-out lane's).
 * Entries in different spaces never conflict: the files are different files on disk.
 */
export const SPACE_PATTERN = '^(root|wt:[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_.-]{1,160})?)$';
export const SpaceSchema = Type.String({ pattern: SPACE_PATTERN });

export const CHECKOUT_RELEASES = ['nodeDone', 'ticketDone', 'manual'] as const;
export const CheckoutReleaseSchema = Type.Union(CHECKOUT_RELEASES.map((release) => Type.Literal(release)));

export const ClaimConflictPolicySchema = Type.Union(CLAIM_CONFLICT_POLICIES.map((policy) => Type.Literal(policy)));

export const CheckoutEntrySchema = Type.Object(
  {
    id: IdSchema,
    space: SpaceSchema,
    /** Normalized relative path (`checkout`) or pattern (`claim`), `/` separators. */
    path: WorkspacePatternSchema,
    /** `claim`: declared by the node type, taken when the node starts. `checkout`: one file, right before an edit. */
    kind: Type.Union([Type.Literal('claim'), Type.Literal('checkout')]),
    mode: Type.Union([Type.Literal('exclusive'), Type.Literal('shared')]),
    holder: HolderSchema,
    release: CheckoutReleaseSchema,
    /** Conflict policy and pause mode that applied when it was taken. */
    onConflict: ClaimConflictPolicySchema,
    pauseMode: Type.Union([Type.Literal('boundary'), Type.Literal('immediate')]),
    /** Priority of the holder's ticket when it was taken (priorityWins). */
    priority: Type.Integer(),
    /** Clean-up deadline (epoch ms) for entries a crash left behind. */
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
    /** SHA-256 of the file when it was checked out (`null`: it did not exist). Checkouts only. */
    baseHash: Type.Optional(Type.Union([HashSchema, Type.Null()])),
  },
  strict,
);

export const ConflictSchema = Type.Object(
  {
    /** The path asked for and the entry it overlaps. */
    path: WorkspacePatternSchema,
    entryId: IdSchema,
    entryPath: WorkspacePatternSchema,
    holder: HolderSchema,
  },
  strict,
);

/**
 * Why a lane waits for a claim (on `node.paused` / `node.pauseRequested`). `ask`: a person decides (the `ask`
 * policy, or a deadlock between waiting lanes); resuming it lets the lane go ahead despite the overlap.
 */
export const ClaimWaitSchema = Type.Object(
  {
    policy: ClaimConflictPolicySchema,
    conflicts: Type.Array(ConflictSchema, { maxItems: 256 }),
    ask: Type.Optional(Type.Literal(true)),
    deadlock: Type.Optional(Type.Literal(true)),
    /** Set when a higher-priority ticket took the paths over (priorityWins, immediate). */
    preemptedBy: Type.Optional(HolderSchema),
  },
  strict,
);

/** How a changed file was explained by the ledger. */
export const CHANGE_ATTRIBUTIONS = ['checkout', 'worktree', 'unattributed', 'conflict'] as const;

export const DetectedChangeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    /** SHA-256 now (`null`: deleted). */
    hash: Type.Union([HashSchema, Type.Null()]),
    /** The hash last recorded for this path in this space (`null`: did not exist; absent: never seen). */
    previous: Type.Optional(Type.Union([HashSchema, Type.Null()])),
    /**
     * checkout: an entry of a running execution covers it. worktree: made in a lane's own worktree.
     * unattributed: nothing covers it (changed without a checkout, or while the engine was not watching).
     * conflict: covered by an entry whose holder was not running (someone else changed a held file).
     */
    attribution: Type.Union(CHANGE_ATTRIBUTIONS.map((kind) => Type.Literal(kind))),
    holder: Type.Optional(HolderSchema),
    /** Executions running in this space while the change happened (unattributed changes). */
    suspects: Type.Optional(Type.Array(HolderSchema, { maxItems: 64 })),
  },
  strict,
);

export const SCAN_REASONS = ['start', 'finish', 'resume', 'watch', 'startup'] as const;

export const WorktreeSchema = Type.Object(
  {
    ticketId: IdSchema,
    /** `<ticket key>` or `<ticket key>/<node>-<lane>`; the space is `wt:<key>`. */
    key: Type.String({ minLength: 1, maxLength: 230 }),
    scope: Type.Union([Type.Literal('ticket'), Type.Literal('lane')]),
    nodeId: Type.Optional(NodeIdSchema),
    lane: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    path: AbsolutePathSchema,
    branch: Type.String({ minLength: 1, maxLength: 256 }),
    /** The commit it started from. */
    base: Type.String({ minLength: 4, maxLength: 64 }),
  },
  strict,
);

/** A join's merge that stopped on conflicts and waits for a person (`onMergeConflict: ask`, or an agent that gave up). */
export const MergeReviewSchema = Type.Object(
  {
    /** Ticket worktree folder where the merge is in progress. */
    worktree: AbsolutePathSchema,
    branch: Type.String({ minLength: 1, maxLength: 256 }),
    conflicts: Type.Array(Type.Object({ branch: Type.String({ maxLength: 256 }), files: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 1000 }) }, strict), {
      maxItems: 1000,
    }),
    /** `agent`: an agent resolved the conflicts and its result waits for review. */
    resolvedBy: Type.Optional(Type.Literal('agent')),
  },
  strict,
);

export const MERGE_OUTCOMES = ['merged', 'conflict', 'resolved', 'error'] as const;

/** What the engine's merge step reports for a join in worktree mode (`node.finish` result kind `merge`). */
export const MergeResultSchema = Type.Object(
  {
    kind: Type.Literal('merge'),
    outcome: Type.Union(MERGE_OUTCOMES.map((outcome) => Type.Literal(outcome))),
    /** Ticket branch and its commit after the merge step. */
    branch: Type.Optional(Type.String({ maxLength: 256 })),
    head: Type.Optional(Type.String({ maxLength: 64 })),
    worktree: Type.Optional(AbsolutePathSchema),
    merged: Type.Optional(Type.Array(Type.Object({ branch: Type.String({ maxLength: 256 }), commit: Type.String({ maxLength: 64 }) }, strict), { maxItems: 1000 })),
    /** Branches that conflicted (left in progress for `ask`/`agent`, aborted for `fail`/`rerun`). */
    conflicts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            branch: Type.String({ maxLength: 256 }),
            nodeId: NodeIdSchema,
            lane: Type.String({ maxLength: 16 }),
            files: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 1000 }),
          },
          strict,
        ),
        { maxItems: 1000 },
      ),
    ),
    error: Type.Optional(Type.String({ maxLength: 65536 })),
    /** The agent run that tried to resolve the conflicts (`onMergeConflict: agent`). */
    agentRunId: Type.Optional(IdSchema),
  },
  strict,
);

export type WatchSettings = Static<typeof WatchSettingsSchema>;
export type TicketWorkspace = Static<typeof TicketWorkspaceSchema>;
export type Holder = Static<typeof HolderSchema>;
export type CheckoutEntry = Static<typeof CheckoutEntrySchema>;
export type CheckoutRelease = Static<typeof CheckoutReleaseSchema>;
export type Conflict = Static<typeof ConflictSchema>;
export type ClaimWait = Static<typeof ClaimWaitSchema>;
export type DetectedChange = Static<typeof DetectedChangeSchema>;
export type ChangeAttribution = (typeof CHANGE_ATTRIBUTIONS)[number];
export type ScanReason = (typeof SCAN_REASONS)[number];
export type Worktree = Static<typeof WorktreeSchema>;
export type MergeReview = Static<typeof MergeReviewSchema>;
export type MergeResult = Static<typeof MergeResultSchema>;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

/** Aggregate id of a project's ledger. */
export function workspaceAggregateId(projectId: string): string {
  return `workspace:${projectId}`;
}

/** Aggregate id of the app layer of the settings. */
export const APP_SETTINGS_AGGREGATE_ID = 'settings:app';
