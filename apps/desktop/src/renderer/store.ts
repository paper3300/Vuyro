import { create } from 'zustand';
import type { ConnectionState } from '../shared/bridge.ts';

/** Screen state that is not engine data: the connection as the main process reports it, and what is selected. */

// The project, view and selected ticket outlive the window: closing to the tray and opening again returns there.
const PROJECT_KEY = 'vuyro.project';
const VIEW_KEY = 'vuyro.view';
const TICKET_KEY = 'vuyro.ticket';

function remembered(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience.
  }
}

function rememberedView(): View {
  const view = remembered(VIEW_KEY);
  return view === 'graph' || view === 'library' ? view : 'board';
}

/** board: 칸반, graph: the selected ticket's workflow, library: templates and node types (import / export). */
export type View = 'board' | 'graph' | 'library';

export interface UiState {
  readonly connection: ConnectionState;
  readonly projectId: string | undefined;
  readonly view: View;
  /** The selected ticket; it stays selected when the view changes. */
  readonly ticketId: string | undefined;
  /** The ticket detail drawer is open (over any view). */
  readonly detailOpen: boolean;
  /** The node selected on the graph (its detail shows beside the canvas). */
  readonly nodeId: string | undefined;
  /** Last event sequence this screen has seen (shown in the status line). */
  readonly lastSequence: number;
  setConnection: (state: ConnectionState) => void;
  selectProject: (projectId: string | undefined) => void;
  setView: (view: View) => void;
  /** Selects a ticket and opens its detail (undefined closes the detail and clears the selection). */
  openTicket: (ticketId: string | undefined) => void;
  /** Selects a ticket without opening its detail (the graph's ticket list). */
  selectTicket: (ticketId: string | undefined) => void;
  /** Closes the detail; the ticket stays selected. */
  closeDetail: () => void;
  selectNode: (nodeId: string | undefined) => void;
  sawSequence: (sequence: number) => void;
}

export const useUi = create<UiState>()((set) => ({
  connection: { phase: 'connecting', access: 'none' },
  projectId: remembered(PROJECT_KEY),
  view: rememberedView(),
  ticketId: remembered(TICKET_KEY),
  detailOpen: false,
  nodeId: undefined,
  lastSequence: 0,
  setConnection: (connection) => {
    set({ connection });
  },
  selectProject: (projectId) => {
    remember(PROJECT_KEY, projectId);
    remember(TICKET_KEY, undefined);
    set({ projectId, ticketId: undefined, detailOpen: false, nodeId: undefined });
  },
  setView: (view) => {
    remember(VIEW_KEY, view);
    set({ view, detailOpen: false });
  },
  openTicket: (ticketId) => {
    remember(TICKET_KEY, ticketId);
    set((state) => ({ ticketId, detailOpen: ticketId !== undefined, nodeId: ticketId === state.ticketId ? state.nodeId : undefined }));
  },
  selectTicket: (ticketId) => {
    remember(TICKET_KEY, ticketId);
    set((state) => ({ ticketId, nodeId: ticketId === state.ticketId ? state.nodeId : undefined }));
  },
  closeDetail: () => {
    set({ detailOpen: false });
  },
  selectNode: (nodeId) => {
    set({ nodeId });
  },
  sawSequence: (sequence) => {
    set((state) => (sequence > state.lastSequence ? { lastSequence: sequence } : state));
  },
}));

export function useCanWrite(): boolean {
  return useUi((state) => state.connection.phase === 'connected' && state.connection.access === 'write');
}
