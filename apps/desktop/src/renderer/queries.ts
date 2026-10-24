import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardResult, DefinitionListing, ImportChoice, ImportPreview, RunEventsResult, RunLogEntry, SharedNodeView, TemplateSummary, TicketStats } from '@vuyro/contracts';
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

/**
 * The newest part of a run's log (M6b re-review): the screen keeps at most `LOG_KEEP` entries. It starts from the run's
 * last entries, and each refetch (an event of the run arrived) asks only for what came after the last one, dropping the
 * oldest beyond the limit. Older entries are read again page by page (`useRunLogPage`).
 */
export interface RunLog {
  readonly run: RunEventsResult['run'];
  readonly entries: readonly RunLogEntry[];
  readonly cursor: number;
  /** More new entries than one refresh reads; `loadMore` continues. */
  readonly more: boolean;
  readonly lastRevision: number;
}

export const LOG_KEEP = 1000;
/** Pages fetched per refresh; a longer backlog waits for "더 불러오기". */
const LOG_PAGES_PER_FETCH = 10;
const LOG_PAGE = 500;

export function useRunLog(runId: string | undefined) {
  const enabled = useConnected() && runId !== undefined;
  const client = useQueryClient();
  const key = ['runLog', runId];
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async (): Promise<RunLog> => {
      const previous = client.getQueryData<RunLog>(key);
      if (previous === undefined) {
        const first = await call<RunEventsResult>('query.runEvents', { runId, tail: LOG_KEEP });
        return { run: first.run, entries: first.entries, cursor: first.cursor, more: first.more, lastRevision: first.lastRevision };
      }
      let { cursor, run, lastRevision } = previous;
      let entries = previous.entries;
      let more = true;
      for (let page = 0; page < LOG_PAGES_PER_FETCH && more; page++) {
        const result = await call<RunEventsResult>('query.runEvents', { runId, after: cursor, limit: LOG_PAGE });
        run = result.run;
        entries = entries.concat(result.entries);
        cursor = result.cursor;
        more = result.more;
        lastRevision = result.lastRevision;
      }
      return { run, entries: entries.length > LOG_KEEP ? entries.slice(-LOG_KEEP) : entries, cursor, more, lastRevision };
    },
  });
  return { ...query, loadMore: () => void client.invalidateQueries({ queryKey: key }) };
}

export const LOG_PAGE_SIZE = 200;

/** One page of a run's log from its start (page 0 = events 1..200); revisions have no gaps, so pages are by number. */
export function useRunLogPage(runId: string, page: number) {
  const enabled = useConnected();
  return useQuery({
    queryKey: ['runLogPage', runId, page],
    enabled,
    queryFn: () => call<RunEventsResult>('query.runEvents', { runId, after: page * LOG_PAGE_SIZE, limit: LOG_PAGE_SIZE }),
    // Old pages do not change; only the page count grows.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** One log entry in full (its text was cut for the list). */
export async function fullLogEntry(runId: string, revision: number): Promise<RunLogEntry | undefined> {
  const result = await call<RunEventsResult>('query.runEvents', { runId, after: revision - 1, limit: 1, textLimit: 1_048_576 });
  return result.entries[0];
}

export function useDefinitions() {
  const enabled = useConnected();
  return useQuery({ queryKey: ['definitions'], enabled, queryFn: async () => (await call<{ definitions: DefinitionListing[] }>('query.definitions', {})).definitions });
}

/** What importing `text` would do with these choices (the engine reads and checks it; nothing is saved). */
export function useImportPreview(text: string | undefined, choices: Readonly<Record<string, ImportChoice>>) {
  const enabled = useConnected() && text !== undefined;
  return useQuery({
    queryKey: ['importPreview', text, choices],
    enabled,
    queryFn: () => call<ImportPreview>('query.importPreview', { text, choices }),
    // A preview is about this text and these choices only; it is not kept or refreshed by events.
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
  });
}
