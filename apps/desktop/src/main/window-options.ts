import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * The renderer gets no Node access: everything goes through the preload bridge
 * (기술 스택 결정 §1).
 */
export function mainWindowOptions(preloadPath: string, icon?: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Vuyro',
    backgroundColor: '#f4f5f8',
    autoHideMenuBar: true,
    ...(icon === undefined ? {} : { icon }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  };
}
