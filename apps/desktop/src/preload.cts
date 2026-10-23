// Sandboxed preloads must be CommonJS.
import type * as Electron from 'electron';

const { contextBridge } = require('electron') as typeof Electron;

contextBridge.exposeInMainWorld('vuyro', {
  shell: 'm0',
});
