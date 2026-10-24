import { describe, expect, it } from 'vitest';
import { mainWindowOptions } from '../../src/main/window-options.ts';

describe('main window', () => {
  it('isolates the renderer from Node', () => {
    const prefs = mainWindowOptions('preload.cjs').webPreferences;
    expect(prefs).toMatchObject({
      preload: 'preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });
});
