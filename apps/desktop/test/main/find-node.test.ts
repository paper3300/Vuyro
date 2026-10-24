import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNode } from '../../src/main/engine-connector.ts';

/** Which Node runs the engine (L-13): `VUYRO_NODE`, then the installed app's own, then PATH. Never Electron's. */
describe('findNode', () => {
  const bundled = join('C:', 'app', 'resources', 'node', 'node.exe');
  const onPath = join('C:', 'tools', 'node.exe');
  const env = { PATH: `C:\\nothing${delimiter}C:\\tools` };
  const exists = (path: string): boolean => path === bundled || path === onPath;

  it('VUYRO_NODE wins', () => {
    expect(findNode({ ...env, VUYRO_NODE: 'D:\\pinned\\node.exe' }, exists, bundled)).toBe('D:\\pinned\\node.exe');
  });

  it("the installed app's Node comes before PATH", () => {
    expect(findNode(env, exists, bundled)).toBe(bundled);
  });

  it('PATH when the app carries none (a development run) or the file is missing', () => {
    expect(findNode(env, exists)).toBe(onPath);
    expect(findNode(env, (path) => path === onPath, bundled)).toBe(onPath);
  });

  it('says what to do when there is no Node at all', () => {
    expect(() => findNode({ PATH: '' }, () => false, bundled)).toThrow(/Node 24/);
  });
});
