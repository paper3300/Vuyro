import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { mainWindowOptions } from './window-options.ts';

// Empty shell (M0). Engine connection, tray residency and the React UI arrive in M6.

function createMainWindow(): void {
  const window = new BrowserWindow(mainWindowOptions(join(import.meta.dirname, 'preload.cjs')));
  window.once('ready-to-show', () => {
    window.show();
    // Smoke check: `VUYRO_SMOKE=1 pnpm --filter @vuyro/desktop start` opens the window and exits 0.
    if (process.env.VUYRO_SMOKE === '1') {
      void window.webContents.executeJavaScript('typeof require + " " + window.vuyro?.shell').then((probe: unknown) => {
        console.log(`vuyro desktop: ready-to-show (renderer: ${String(probe)})`);
        app.quit();
      });
    }
  });
  void window.loadFile(join(import.meta.dirname, '..', 'static', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(createMainWindow);
  app.on('window-all-closed', () => {
    app.quit();
  });
}
