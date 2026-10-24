import { create } from 'zustand';
import type { ConnectionState } from '../shared/bridge.ts';

/** Screen state that is not engine data: the connection as the main process reports it, and what is selected. */

const PROJECT_KEY = 'vuyro.project';

function remembered(): string | undefined {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface UiState {
  readonly connection: ConnectionState;
  readonly projectId: string | undefined;
  readonly ticketId: string | undefined;
  /** Last event sequence this screen has seen (shown in the status line). */
  readonly lastSequence: number;
  setConnection: (state: ConnectionState) => void;
  selectProject: (projectId: string | undefined) => void;
  openTicket: (ticketId: string | undefined) => void;
  sawSequence: (sequence: number) => void;
}

export const useUi = create<UiState>()((set) => ({
  connection: { phase: 'connecting', access: 'none' },
  projectId: remembered(),
  ticketId: undefined,
  lastSequence: 0,
  setConnection: (connection) => {
    set({ connection });
  },
  selectProject: (projectId) => {
    try {
      if (projectId === undefined) localStorage.removeItem(PROJECT_KEY);
      else localStorage.setItem(PROJECT_KEY, projectId);
    } catch {
      // Remembering the project is a convenience.
    }
    set({ projectId, ticketId: undefined });
  },
  openTicket: (ticketId) => {
    set({ ticketId });
  },
  sawSequence: (sequence) => {
    set((state) => (sequence > state.lastSequence ? { lastSequence: sequence } : state));
  },
}));

export function useCanWrite(): boolean {
  return useUi((state) => state.connection.phase === 'connected' && state.connection.access === 'write');
}
