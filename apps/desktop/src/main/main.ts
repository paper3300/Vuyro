import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, Tray, type WebContents } from 'electron';
import { BRIDGE_CHANNELS, type ConnectionState } from '../shared/bridge.ts';
import { APP_INDEX, APP_SCHEME, appResponseHeaders, resolveAppFile } from './app-protocol.ts';
import { EngineConnection } from './engine-connection.ts';
import { engineConnector } from './engine-connector.ts';
import { checkRendererRequest, checkSubscribe, isTrustedFrame } from './ipc-policy.ts';
import { quitForGood, trayItems, trayTooltip } from './tray-model.ts';
import { mainWindowOptions } from './window-options.ts';

// Electron main: one instance per user, the engine connection, the tray, and the window that shows the UI.
// Closing the window leaves the app in the tray; the engine (a separate process) keeps the work going.

const here = import.meta.dirname;
const rendererRoot = join(here, '..', 'renderer');
const preloadPath = join(here, '..', 'preload', 'preload.cjs');
const iconPath = join(here, '..', '..', 'static', 'icon.png');
const trayIconPath = join(here, '..', '..', 'static', 'tray.png');
const smoke = process.env.VUYRO_SMOKE === '1';

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

function log(error: Error, context: string): void {
  const line = `${new Date().toISOString()} ${context}: ${error.stack ?? error.message}\n`;
  try {
    const file = join(app.getPath('logs'), 'desktop.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch {
    process.stderr.write(line);
  }
}

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let toldAboutTray = false;
const connection = new EngineConnection({ connector: engineConnector(), onError: log });
/** Renderer subscriptions by web contents, so a closed window stops its subscriptions. */
const subscriptions = new Map<number, Map<string, () => void>>();

function showWindow(): void {
  if (window !== undefined && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  const created = new BrowserWindow(mainWindowOptions(preloadPath, iconPath));
  window = created;
  guardContents(created.webContents);
  created.once('ready-to-show', () => {
    created.show();
    // Smoke check: `VUYRO_SMOKE=1 pnpm --filter @vuyro/desktop start` opens the window and exits 0.
    if (smoke) {
      void created.webContents.executeJavaScript('typeof require + " " + typeof window.vuyro?.request + " " + document.title').then((probe: unknown) => {
        console.log(`vuyro desktop: ready-to-show (renderer: ${String(probe)})`);
        app.exit(0);
      });
    }
  });
  created.on('closed', () => {
    if (window === created) window = undefined;
    if (!toldAboutTray && !smoke && tray !== undefined && process.platform === 'win32') {
      toldAboutTray = true;
      tray.displayBalloon({ title: 'Vuyro', content: '창을 닫아도 Vuyro는 트레이에서 계속 실행됩니다. 작업도 멈추지 않습니다.' });
    }
  });
  void created.loadURL(APP_INDEX);
}

/** No navigation, no new windows, no webviews, no permissions: the window only ever shows our page. */
function guardContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (url !== APP_INDEX) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.once('destroyed', () => {
    const owned = subscriptions.get(contents.id);
    subscriptions.delete(contents.id);
    for (const unsubscribe of owned?.values() ?? []) unsubscribe();
  });
}

function broadcast(state: ConnectionState): void {
  for (const each of BrowserWindow.getAllWindows()) {
    if (!each.isDestroyed()) each.webContents.send(BRIDGE_CHANNELS.connectionChanged, state);
  }
}

function refreshTray(state: ConnectionState): void {
  if (tray === undefined) return;
  tray.setToolTip(trayTooltip(state));
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayItems(state).map((item) => {
        if (item.kind === 'separator') return { type: 'separator' as const };
        if (item.kind === 'info') return { label: item.label, enabled: false };
        return { label: item.label, click: item.id === 'open' ? showWindow : requestQuit };
      }),
    ),
  );
}

let quitting = false;
function requestQuit(): void {
  if (quitting) return;
  quitting = true;
  const parent = window !== undefined && !window.isDestroyed() ? window : undefined;
  const ask = async (options: Electron.MessageBoxOptions) => (parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options));
  void quitForGood({
    running: () => connection.running(),
    access: () => connection.current.access,
    confirm: async ({ message, detail }) => (await ask({ type: 'warning', title: 'Vuyro', message, detail, buttons: ['종료', '취소'], defaultId: 1, cancelId: 1, noLink: true })).response === 0,
    notify: async ({ message, detail }) => {
      await ask({ type: 'info', title: 'Vuyro', message, detail, buttons: ['확인'] });
    },
    shutdownEngine: () => connection.shutdownEngine(),
    exitApp: () => {
      connection.stop();
      tray?.destroy();
      app.exit(0);
    },
  })
    .then((outcome) => {
      if (outcome === 'cancelled') quitting = false;
    })
    .catch((error: unknown) => {
      quitting = false;
      log(error instanceof Error ? error : new Error(String(error)), 'quit');
    });
}

function registerIpc(): void {
  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
    try {
      return isTrustedFrame(event.senderFrame, event.sender.mainFrame);
    } catch {
      return false; // A frame that went away while the message was in flight.
    }
  };
  const refusal = { ok: false, error: { code: 'bridge_refused', message: 'untrusted sender', retryable: false } } as const;
  ipcMain.handle(BRIDGE_CHANNELS.request, async (event, message: unknown) => {
    if (!trusted(event)) return refusal;
    const checked = checkRendererRequest(message);
    if (!checked.ok) return checked;
    return connection.request(checked.method, checked.params);
  });
  ipcMain.handle(BRIDGE_CHANNELS.connection, (event) => (trusted(event) ? connection.current : undefined));
  ipcMain.handle(BRIDGE_CHANNELS.pair, async (event) => (trusted(event) ? connection.pair() : refusal));
  ipcMain.handle(BRIDGE_CHANNELS.retry, async (event) => {
    if (trusted(event)) await connection.retry();
  });
  ipcMain.on(BRIDGE_CHANNELS.subscribe, (event, message: unknown) => {
    if (!trusted(event)) return;
    const checked = checkSubscribe(message);
    if (checked === undefined) return;
    const contents = event.sender;
    let owned = subscriptions.get(contents.id);
    if (owned === undefined) {
      owned = new Map();
      subscriptions.set(contents.id, owned);
    }
    owned.get(checked.id)?.();
    owned.set(
      checked.id,
      connection.subscribe(checked.afterSequence, (events) => {
        if (!contents.isDestroyed()) contents.send(BRIDGE_CHANNELS.events, { id: checked.id, events });
      }),
    );
  });
  ipcMain.on(BRIDGE_CHANNELS.unsubscribe, (event, message: unknown) => {
    if (!trusted(event)) return;
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    const owned = subscriptions.get(event.sender.id);
    owned?.get(id)?.();
    owned?.delete(id);
  });
}

function ready(): void {
  // The window asks for nothing (camera, notifications, …); refuse everything.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(rendererRoot, request.url);
    if (file === undefined) return new Response('not found', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: appResponseHeaders(file) });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  Menu.setApplicationMenu(null);
  registerIpc();
  if (!smoke) {
    tray = new Tray(nativeImage.createFromPath(trayIconPath));
    tray.on('click', showWindow);
    refreshTray(connection.current);
    connection.onState((state) => {
      broadcast(state);
      refreshTray(state);
    });
    void connection.start();
  }
  showWindow();
}

if (!app.requestSingleInstanceLock()) {
  // One app per user: the second start only brings the first one's window up.
  app.exit(0);
} else {
  app.on('second-instance', showWindow);
  // The tray keeps the app (and the engine connection) alive without windows.
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(ready);
}
