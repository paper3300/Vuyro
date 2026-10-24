import type { ReviewView, WorkflowView } from '@vuyro/contracts';

/** Shapes of the engine's read side the screens use (`query.ticket`, `query.projects`, `query.artifacts`). */

export interface ProjectRow {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface TicketRow {
  readonly ticketId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly template: { readonly id: string; readonly version: number; readonly hash: string } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly revision: number;
  readonly attention: string | null;
}

export interface LaneRow {
  readonly nodeId: string;
  readonly lane: string;
  readonly laneGroup: string | null;
  readonly run: number;
  readonly status: string;
  readonly executor: string | null;
  readonly runId: string | null;
  readonly attempt: number;
  readonly pauseRequested: number;
  readonly supersededBy: string | null;
  /** The claim a paused lane waits for (who holds which paths). */
  readonly waitingFor: unknown;
  readonly updatedAt: number;
}

export interface ExecutionRow {
  readonly nodeId: string;
  readonly run: number;
  readonly lane: string;
  readonly cause: string;
  readonly status: string;
  readonly port: string | null;
  readonly itemCount: number | null;
  readonly attempts: number;
  readonly activatedAt: number;
  readonly startedAt: number | null;
  readonly reviewAt: number | null;
  readonly finishedAt: number | null;
  readonly error: string | null;
  readonly supersededBy: string | null;
}

export interface AgentRunRow {
  readonly runId: string;
  readonly nodeId: string;
  readonly provider: string;
  readonly status: string;
  readonly model: string | null;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly terminalReason: string | null;
  readonly tokensInput: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  readonly tokensOutput: number;
  readonly costUsd: number | null;
  readonly toolCalls: number;
  readonly toolErrors: number;
}

export interface WaitReason {
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  readonly kind: 'active' | 'failed' | 'stale' | 'attention';
  readonly status: string;
}

export interface TicketDetail {
  readonly ticket: TicketRow;
  readonly lanes: readonly LaneRow[];
  readonly executions: readonly ExecutionRow[];
  readonly runs: readonly AgentRunRow[];
  readonly waitingFor?: readonly WaitReason[];
  readonly workflow?: WorkflowView;
  readonly reviews: readonly ReviewView[];
}

export interface ArtifactRow {
  readonly nodeId: string;
  readonly slot: string;
  readonly kind: string;
  readonly uri: string;
  readonly version: string | null;
  readonly title: string | null;
  readonly lane: string | null;
  readonly current: boolean;
  readonly sequence: number;
}
