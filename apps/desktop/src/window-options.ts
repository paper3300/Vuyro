import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * The renderer gets no Node access: everything goes through the preload bridge
 * (기술 스택 결정 §1).
 */
export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false,
    title: 'Vuyro',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}
