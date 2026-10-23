import type { DomainEvent, RunOutcome } from '@vuyro/contracts';

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

export interface TicketState {
  readonly exists: boolean;
  readonly projectId: string;
  readonly title: string;
}

export const ticketAggregate: AggregateDefinition<TicketState> = {
  type: 'ticket',
  initial: { exists: false, projectId: '', title: '' },
  evolve(state, event) {
    switch (event.type) {
      case 'ticket.created':
        return { exists: true, projectId: event.data.projectId, title: event.data.title };
      case 'ticket.updated':
        return event.data.title === undefined ? state : { ...state, title: event.data.title };
      default:
        return state;
    }
  },
};

export interface RunState {
  readonly exists: boolean;
  readonly status: 'running' | RunOutcome;
  readonly ticketId: string;
  readonly nodeId: string;
  readonly provider: string;
}

export const runAggregate: AggregateDefinition<RunState> = {
  type: 'run',
  initial: { exists: false, status: 'running', ticketId: '', nodeId: '', provider: '' },
  evolve(state, event) {
    switch (event.type) {
      case 'run.started':
        return { exists: true, status: 'running', ticketId: event.data.ticketId, nodeId: event.data.nodeId, provider: event.data.provider };
      case 'run.settled':
        return { ...state, status: event.data.outcome };
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
