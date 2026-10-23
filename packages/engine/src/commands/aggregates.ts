import type { DefinitionKind, DomainEvent, RunOutcome } from '@vuyro/contracts';
import { EMPTY_TICKET, evolveTicket, type TicketWorkflow } from '../workflow/state.ts';

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
}

export const projectAggregate: AggregateDefinition<ProjectState> = {
  type: 'project',
  initial: { exists: false, name: '' },
  evolve(state, event) {
    return event.type === 'project.created' ? { exists: true, name: event.data.name } : state;
  },
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
