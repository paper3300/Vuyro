import { useQuery } from '@tanstack/react-query';
import type { BoardResult, SharedNodeView, TemplateSummary, TicketStats } from '@vuyro/contracts';
import { call } from './api.ts';
import { useUi } from './store.ts';
import type { ArtifactRow, ProjectRow, TicketDetail } from './types.ts';

/** Reads from the engine (TanStack Query). Event batches mark them stale (live.ts); nothing here writes. */

function useConnected(): boolean {
  return useUi((state) => state.connection.phase === 'connected');
}

export function useProjects() {
  const enabled = useConnected();
  return useQuery({ queryKey: ['projects'], enabled, queryFn: async () => (await call<{ projects: ProjectRow[] }>('query.projects', {})).projects });
}

export function useTemplates() {
  const enabled = useConnected();
  return useQuery({ queryKey: ['templates'], enabled, queryFn: async () => (await call<{ templates: TemplateSummary[] }>('query.templates', {})).templates });
}

export function useBoard(projectId: string | undefined) {
  const enabled = useConnected() && projectId !== undefined;
  return useQuery({
    queryKey: ['board', projectId],
    enabled,
    queryFn: () => call<BoardResult>('query.board', { projectId }),
    // Card clocks move while tickets are open.
    refetchInterval: 30_000,
  });
}

export function useTicket(ticketId: string | undefined) {
  const enabled = useConnected() && ticketId !== undefined;
  return useQuery({ queryKey: ['ticket', ticketId], enabled, queryFn: () => call<TicketDetail>('query.ticket', { ticketId }) });
}

export function useTicketStats(ticketId: string | undefined, open: boolean) {
  const enabled = useConnected() && ticketId !== undefined;
  return useQuery({
    queryKey: ['ticketStats', ticketId],
    enabled,
    queryFn: () => call<TicketStats>('query.ticketStats', { ticketId }),
    // Open intervals end at `asOf`; refresh so running time keeps counting.
    refetchInterval: open ? 5000 : false,
  });
}

export function useSharedNodes(projectId: string | undefined) {
  const enabled = useConnected() && projectId !== undefined;
  return useQuery({
    queryKey: ['sharedNodes', projectId],
    enabled,
    queryFn: async () => (await call<{ sharedNodes: SharedNodeView[] }>('query.sharedNodes', { projectId })).sharedNodes,
  });
}

export function useArtifacts(ticketId: string | undefined) {
  const enabled = useConnected() && ticketId !== undefined;
  return useQuery({ queryKey: ['artifacts', ticketId], enabled, queryFn: async () => (await call<{ artifacts: ArtifactRow[] }>('query.artifacts', { ticketId })).artifacts });
}
