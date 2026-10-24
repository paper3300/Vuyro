import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_INDEX, appResponseHeaders, CONTENT_SECURITY_POLICY, resolveAppFile } from '../../src/main/app-protocol.ts';
import { checkRendererRequest, checkSubscribe, isTrustedFrame, isTrustedSender } from '../../src/main/ipc-policy.ts';
import { RENDERER_METHODS } from '../../src/shared/bridge.ts';

/** What the main process lets the page do (Electron security checklist: validate senders and IPC arguments). */

describe('IPC from the page', () => {
  it('trusts only our app page', () => {
    expect(isTrustedSender(APP_INDEX)).toBe(true);
    expect(isTrustedSender('vuyro-app://ui/other.html')).toBe(true);
    expect(isTrustedSender('vuyro-app://elsewhere/index.html')).toBe(false);
    expect(isTrustedSender('file:///C:/index.html')).toBe(false);
    expect(isTrustedSender('https://example.com/')).toBe(false);
    expect(isTrustedSender('about:blank')).toBe(false);
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender('not a url')).toBe(false);
  });

  it('trusts only the main frame of the window, showing our page', () => {
    const main = { processId: 7, routingId: 1, url: APP_INDEX };
    expect(isTrustedFrame(main, main)).toBe(true);
    expect(isTrustedFrame({ ...main }, main)).toBe(true);
    expect(isTrustedFrame({ ...main, routingId: 2 }, main)).toBe(false); // a sub-frame
    expect(isTrustedFrame({ ...main, processId: 8 }, main)).toBe(false);
    expect(isTrustedFrame({ ...main, url: 'https://example.com/' }, { ...main, url: 'https://example.com/' })).toBe(false);
    expect(isTrustedFrame(null, main)).toBe(false);
    expect(isTrustedFrame(main, undefined)).toBe(false);
  });

  it('allows reads and commands, nothing that belongs to the main process', () => {
    for (const method of RENDERER_METHODS) {
      const params = method === 'command.execute' ? { requestId: 'ui-1', type: 'project.create', payload: {} } : {};
      expect(checkRendererRequest({ method, params })).toMatchObject({ ok: true, method });
    }
    for (const method of ['session.hello', 'auth.pair', 'engine.shutdown', 'events.subscribe', 'events.unsubscribe', 'query.nothing', 42]) {
      expect(checkRendererRequest({ method, params: {} })).toMatchObject({ ok: false, error: { code: 'bridge_refused' } });
    }
    expect(checkRendererRequest({ method: 'query.projects' })).toMatchObject({ ok: true });
  });

  it('the page may read run logs, list, export and preview definitions; saving them is a command like any other', () => {
    expect(RENDERER_METHODS).toEqual(expect.arrayContaining(['query.runEvents', 'query.definitions', 'query.exportDefinition', 'query.importPreview']));
    // Nothing that reads or writes files on the engine side, and no other definition writes than the save commands.
    for (const method of ['query.worktreeCleanup', 'definition.activate', 'nodeType.save', 'template.save']) {
      expect(checkRendererRequest({ method, params: {} }), method).toMatchObject({ ok: false, error: { code: 'bridge_refused' } });
    }
  });

  it('the page never sends a project folder path: only the folder dialog sets it (D-072)', () => {
    const configure = (payload: Record<string, unknown>) => checkRendererRequest({ method: 'command.execute', params: { requestId: 'ui-1', type: 'project.configure', payload } });
    for (const root of ['C:\\Windows', 'D:\\anything', '/etc', null, { token: 'vpf_x' }]) {
      expect(configure({ projectId: 'p1', root }), JSON.stringify(root)).toMatchObject({ ok: false, error: { code: 'bridge_refused', message: 'the window sets the project folder through the folder dialog only' } });
    }
    // The rest of the project's settings is the page's to change, like the CLI's `--settings`.
    expect(configure({ projectId: 'p1', settings: { workspaceMode: 'worktree' } })).toMatchObject({ ok: true });
    expect(checkRendererRequest({ method: 'command.execute', params: { requestId: 'ui-1', type: 'project.create', payload: { name: 'sample' } } })).toMatchObject({ ok: true });
  });

  it('refuses malformed requests and run tokens from the page', () => {
    expect(checkRendererRequest(null)).toMatchObject({ ok: false });
    expect(checkRendererRequest([])).toMatchObject({ ok: false });
    expect(checkRendererRequest({ method: 'query.board', params: 'x' })).toMatchObject({ ok: false });
    expect(checkRendererRequest({ method: 'query.board', params: [] })).toMatchObject({ ok: false });
    expect(checkRendererRequest({ method: 'command.execute' })).toMatchObject({ ok: false, error: { message: 'command envelope missing' } });
    const withToken = { requestId: 'ui-1', type: 'node.done', payload: {}, auth: { runToken: 'vrt_x' } };
    expect(checkRendererRequest({ method: 'command.execute', params: withToken })).toMatchObject({ ok: false, error: { message: 'the window does not send run tokens' } });
  });

  it('checks subscribe arguments', () => {
    expect(checkSubscribe({ id: 's1', afterSequence: 0 })).toEqual({ id: 's1', afterSequence: 0 });
    expect(checkSubscribe({ id: 's1', afterSequence: -1 })).toBeUndefined();
    expect(checkSubscribe({ id: 's1', afterSequence: 1.5 })).toBeUndefined();
    expect(checkSubscribe({ id: '../x', afterSequence: 1 })).toBeUndefined();
    expect(checkSubscribe({ id: 'a'.repeat(65), afterSequence: 1 })).toBeUndefined();
    expect(checkSubscribe(null)).toBeUndefined();
  });
});

describe('app protocol', () => {
  const root = resolve('C:\\app\\dist\\renderer');

  it('serves files inside the renderer folder only', () => {
    expect(resolveAppFile(root, 'vuyro-app://ui/index.html')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'vuyro-app://ui/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'vuyro-app://ui/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'));
    expect(resolveAppFile(root, 'vuyro-app://ui/assets/a.js?x=1#y')).toBe(join(root, 'assets', 'a.js'));
  });

  it('refuses other hosts and schemes, and never maps outside the folder', () => {
    for (const url of ['vuyro-app://other/index.html', 'file:///C:/app/dist/renderer/index.html', 'vuyro-app://ui/..%5c..%5cmain.js', 'vuyro-app://ui/a%00.js', 'vuyro-app://ui/%E0%A4%A', 'garbage']) {
      expect(resolveAppFile(root, url), url).toBeUndefined();
    }
    // Dot segments are folded by the URL parser or refused; either way the file stays inside the root.
    for (const url of ['vuyro-app://ui/../main/main.js', 'vuyro-app://ui/%2e%2e/main/main.js', 'vuyro-app://ui/assets/%2e%2e%2f%2e%2e%2fmain.js', 'vuyro-app://ui/assets/..%2f..%2f..%2fsecret']) {
      const file = resolveAppFile(root, url);
      expect(file === undefined || file.startsWith(`${root}${sep}`), `${url} -> ${String(file)}`).toBe(true);
    }
  });

  it('answers with the CSP and no sniffing', () => {
    const headers = appResponseHeaders(join(root, 'assets', 'a.js'));
    expect(headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe');
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(appResponseHeaders('x.bin')['content-type']).toBe('application/octet-stream');
  });
});
