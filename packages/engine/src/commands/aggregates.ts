import type { DefinitionKind, DomainEvent, RunOutcome, WatchSettings, WorkspaceSettings } from '@vuyro/contracts';
import { EMPTY_TICKET, evolveTicket, type TicketWorkflow } from '../workflow/state.ts';
import { EMPTY_SHARED_NODE, evolveSharedNode, type SharedNodeState } from '../shared/state.ts';
import { EMPTY_LEDGER, evolveLedger, type LedgerState } from '../workspace/ledger.ts';

/**
 * Aggregate state used to decide commands, folded from the aggregate's own events.
 * Only what decisions need lives here; screens read the projections.
 */
export interface AggregateDefinition<S> {
  readonly type: string;
  readonly initial: S;
  evolve(state: S, event: DomainEvent): S;
}

export interface ProjectState {
  readonly exists: boolean;
  readonly name: string;
  /** Workspace folder and settings layer (`project.configure`, M4). */
  readonly root?: string;
  readonly baseRef?: string;
  readonly watch?: WatchSettings;
  readonly settings?: WorkspaceSettings;
  /** Its shared nodes (M5), in the order they were defined. */
  readonly sharedNodes?: readonly string[];
}

export const projectAggregate: AggregateDefinition<ProjectState> = {
  type: 'project',
  initial: { exists: false, name: '' },
  evolve(state, event) {
    if (event.type === 'project.created') return { exists: true, name: event.data.name };
    if (event.type === 'project.sharedNodeAdded') return { ...state, sharedNodes: [...(state.sharedNodes ?? []), event.data.name] };
    if (event.type !== 'project.configured') return state;
    // Absent = unchanged, null = cleared.
    const { data } = event;
    const root = data.root === undefined ? state.root : (data.root ?? undefined);
    const baseRef = data.baseRef === undefined ? state.baseRef : (data.baseRef ?? undefined);
    const watch = data.watch ?? state.watch;
    const settings = data.settings ?? state.settings;
    return {
      exists: state.exists,
      name: state.name,
      ...(root === undefined ? {} : { root }),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(watch === undefined ? {} : { watch }),
      ...(settings === undefined ? {} : { settings }),
      ...(state.sharedNodes === undefined ? {} : { sharedNodes: state.sharedNodes }),
    };
  },
};

/** The app layer of the workspace settings (singleton aggregate `settings:app`). */
export interface AppSettingsState {
  readonly settings?: WorkspaceSettings;
}

export const appSettingsAggregate: AggregateDefinition<AppSettingsState> = {
  type: 'settings',
  initial: {},
  evolve(state, event) {
    return event.type === 'app.configured' ? { settings: event.data.settings } : state;
  },
};

/** A project's workspace ledger (`workspace:<projectId>`). */
export const workspaceAggregate: AggregateDefinition<LedgerState> = {
  type: 'workspace',
  initial: EMPTY_LEDGER,
  evolve: evolveLedger,
};

/** A shared node of a project (`shared:<projectId>:<name>`, M5; see shared/state.ts). */
export const sharedNodeAggregate: AggregateDefinition<SharedNodeState> = {
  type: 'shared',
  initial: EMPTY_SHARED_NODE,
  evolve: evolveSharedNode,
};

/** The ticket and its workflow progress (see workflow/state.ts). */
export type TicketState = TicketWorkflow;

export const ticketAggregate: AggregateDefinition<TicketState> = {
  type: 'ticket',
  initial: EMPTY_TICKET,
  evolve: evolveTicket,
};

export interface RunState {
  readonly exists: boolean;
  readonly status: 'running' | RunOutcome;
  readonly ticketId: string;
  readonly nodeId: string;
  readonly provider: string;
  /** Provider session to resume (Claude session_id / Codex thread_id), once identified. */
  readonly sessionId?: string;
  readonly terminalReason?: string;
  readonly error?: string;
}

export const runAggregate: AggregateDefinition<RunState> = {
  type: 'run',
  initial: { exists: false, status: 'running', ticketId: '', nodeId: '', provider: '' },
  evolve(state, event) {
    switch (event.type) {
      case 'run.started':
        return { exists: true, status: 'running', ticketId: event.data.ticketId, nodeId: event.data.nodeId, provider: event.data.provider };
      case 'run.sessionIdentified':
        return { ...state, sessionId: event.data.providerSessionId };
      case 'run.settled':
        return {
          ...state,
          status: event.data.outcome,
          ...(event.data.terminalReason === undefined ? {} : { terminalReason: event.data.terminalReason }),
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
        };
      default:
        return state;
    }
  },
};

export interface PermissionsState {
  readonly ruleCount: number;
}

export const permissionsAggregate: AggregateDefinition<PermissionsState> = {
  type: 'permissions',
  initial: { ruleCount: 0 },
  evolve(state, event) {
    return event.type === 'permission.rulesChanged' ? { ruleCount: event.data.rules.length } : state;
  },
};

/** Singleton aggregate ids for permission rule sets. */
export function permissionsAggregateId(scope: 'app' | 'project', projectId?: string): string {
  return scope === 'app' ? 'permissions:app' : `permissions:project:${projectId ?? ''}`;
}

export interface DefinitionVersion {
  readonly hash: string;
  readonly status: 'staged' | 'active' | 'abandoned';
}

export interface DefinitionState {
  readonly kind?: DefinitionKind;
  readonly versions: Readonly<Record<number, DefinitionVersion>>;
}

export const definitionAggregate: AggregateDefinition<DefinitionState> = {
  type: 'definition',
  initial: { versions: {} },
  evolve(state, event) {
    switch (event.type) {
      case 'definition.staged':
        return { kind: event.data.kind, versions: { ...state.versions, [event.data.version]: { hash: event.data.hash, status: 'staged' } } };
      case 'definition.activated':
        return { ...state, versions: { ...state.versions, [event.data.version]: { hash: event.data.hash, status: 'active' } } };
      case 'definition.abandoned':
        return { ...state, versions: { ...state.versions, [event.data.version]: { hash: event.data.hash, status: 'abandoned' } } };
      default:
        return state;
    }
  },
};
