// The bridge between the page and the main process (기술 스택 결정 §1). Sandboxed preloads must be CommonJS and
// cannot require our other files, so the channel names repeat `src/shared/bridge.ts` (a test keeps them in step).
// The page gets these functions only: no ipcRenderer, no Node.
import type * as Electron from 'electron';

const { contextBridge, ipcRenderer } = require('electron') as typeof Electron;

const CHANNELS = {
  request: 'vuyro:request',
  subscribe: 'vuyro:subscribe',
  unsubscribe: 'vuyro:unsubscribe',
  events: 'vuyro:events',
  connection: 'vuyro:connection',
  connectionChanged: 'vuyro:connection-changed',
  pair: 'vuyro:pair',
  retry: 'vuyro:retry',
  openFile: 'vuyro:open-file',
  saveFile: 'vuyro:save-file',
  copyText: 'vuyro:copy-text',
  pickFolder: 'vuyro:pick-folder',
  setProjectFolder: 'vuyro:set-project-folder',
} as const;

type Listener = (payload: unknown) => void;

const subscriptions = new Map<string, Listener>();
let nextSubscription = 1;

ipcRenderer.on(CHANNELS.events, (_event, message: { id?: unknown; events?: unknown }) => {
  if (typeof message.id !== 'string') return;
  subscriptions.get(message.id)?.(message.events);
});

contextBridge.exposeInMainWorld('vuyro', {
  request: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke(CHANNELS.request, { method, params }),
  subscribe: (afterSequence: number, onEvents: Listener): (() => void) => {
    const id = `s${String(nextSubscription++)}`;
    subscriptions.set(id, onEvents);
    ipcRenderer.send(CHANNELS.subscribe, { id, afterSequence });
    return () => {
      if (!subscriptions.delete(id)) return;
      ipcRenderer.send(CHANNELS.unsubscribe, { id });
    };
  },
  connection: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.connection),
  onConnection: (listener: Listener): (() => void) => {
    const handler = (_event: unknown, state: unknown): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.connectionChanged, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.connectionChanged, handler);
    };
  },
  pair: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.pair),
  retry: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.retry),
  openJsonFile: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.openFile),
  saveJsonFile: (name: string, text: string): Promise<unknown> => ipcRenderer.invoke(CHANNELS.saveFile, { name, text }),
  copyText: (text: string): Promise<unknown> => ipcRenderer.invoke(CHANNELS.copyText, { text }),
  pickProjectFolder: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.pickFolder),
  setProjectFolder: (projectId: string, token: string, settings?: unknown): Promise<unknown> => ipcRenderer.invoke(CHANNELS.setProjectFolder, { projectId, token, settings }),
});
