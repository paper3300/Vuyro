import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/main/app-protocol.ts';
import { BRIDGE_CHANNELS } from '../../src/shared/bridge.ts';

/**
 * The preload runs sandboxed (CommonJS, only `electron` to require). Run its source the same way with a fake
 * Electron and look at exactly what the page receives.
 */

const source = readFileSync(new URL('../../src/preload/preload.cts', import.meta.url), 'utf8');

function loadPreload() {
  const exposed = new Map<string, unknown>();
  const invoked: { channel: string; args: unknown[] }[] = [];
  const sent: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const required: string[] = [];
  const ipcRenderer = {
    invoke: (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      return Promise.resolve({ ok: true, value: channel });
    },
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    },
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed.set(key, api);
      },
    },
    ipcRenderer,
  };
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      required.push(name);
      if (name !== 'electron') throw new Error(`a sandboxed preload cannot require '${name}'`);
      return electron;
    },
  });
  const emit = (channel: string, ...args: unknown[]) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
  };
  return { exposed, invoked, sent, listeners, required, emit };
}

interface Api {
  request(method: string, params?: unknown): Promise<unknown>;
  subscribe(afterSequence: number, onEvents: (events: unknown) => void): () => void;
  connection(): Promise<unknown>;
  onConnection(listener: (state: unknown) => void): () => void;
  pair(): Promise<unknown>;
  retry(): Promise<unknown>;
}

describe('preload bridge', () => {
  it('exposes window.vuyro with six functions and nothing of Electron or Node', () => {
    const { exposed, required } = loadPreload();
    expect([...exposed.keys()]).toEqual(['vuyro']);
    const api = exposed.get('vuyro') as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual(['connection', 'onConnection', 'pair', 'request', 'retry', 'subscribe']);
    expect(Object.values(api).every((value) => typeof value === 'function')).toBe(true);
    expect(required).toEqual(['electron']);
  });

  it('uses the same channel names as the main process', () => {
    const block = /const CHANNELS = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? '';
    const channels: Record<string, string> = {};
    for (const match of block.matchAll(/(\w+): '([^']+)'/g)) channels[match[1] ?? ''] = match[2] ?? '';
    expect(channels).toEqual(BRIDGE_CHANNELS);
  });

  it('forwards requests, connection, pairing and retry to their channels', async () => {
    const { exposed, invoked } = loadPreload();
    const api = exposed.get('vuyro') as Api;
    await api.request('query.board', { projectId: 'p' });
    await api.connection();
    await api.pair();
    await api.retry();
    expect(invoked).toEqual([
      { channel: 'vuyro:request', args: [{ method: 'query.board', params: { projectId: 'p' } }] },
      { channel: 'vuyro:connection', args: [] },
      { channel: 'vuyro:pair', args: [] },
      { channel: 'vuyro:retry', args: [] },
    ]);
  });

  it('routes events to the subscription they belong to, and unsubscribes once', () => {
    const { exposed, sent, emit } = loadPreload();
    const api = exposed.get('vuyro') as Api;
    const first: unknown[] = [];
    const second: unknown[] = [];
    const offFirst = api.subscribe(5, (events) => first.push(events));
    api.subscribe(0, (events) => second.push(events));
    expect(sent).toEqual([
      { channel: 'vuyro:subscribe', args: [{ id: 's1', afterSequence: 5 }] },
      { channel: 'vuyro:subscribe', args: [{ id: 's2', afterSequence: 0 }] },
    ]);
    emit('vuyro:events', { id: 's1', events: [{ sequence: 6 }] });
    emit('vuyro:events', { id: 's2', events: [{ sequence: 1 }] });
    emit('vuyro:events', { id: 's9', events: [{ sequence: 1 }] });
    emit('vuyro:events', { id: 7, events: [] });
    expect(first).toEqual([[{ sequence: 6 }]]);
    expect(second).toEqual([[{ sequence: 1 }]]);
    offFirst();
    offFirst();
    emit('vuyro:events', { id: 's1', events: [{ sequence: 7 }] });
    expect(first).toHaveLength(1);
    expect(sent.filter((message) => message.channel === 'vuyro:unsubscribe')).toEqual([{ channel: 'vuyro:unsubscribe', args: [{ id: 's1' }] }]);
  });

  it('passes connection changes to the page and stops when asked', () => {
    const { exposed, emit, listeners } = loadPreload();
    const api = exposed.get('vuyro') as Api;
    const states: unknown[] = [];
    const off = api.onConnection((state) => states.push(state));
    emit('vuyro:connection-changed', { phase: 'connected' });
    off();
    emit('vuyro:connection-changed', { phase: 'offline' });
    expect(states).toEqual([{ phase: 'connected' }]);
    expect(listeners.get('vuyro:connection-changed')?.size).toBe(0);
  });
});

describe('page CSP', () => {
  it('the page carries the same policy the app protocol sends (minus what a meta tag cannot set)', () => {
    const html = readFileSync(new URL('../../src/renderer/index.html', import.meta.url), 'utf8');
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(meta).toBe(CONTENT_SECURITY_POLICY.replace("; frame-ancestors 'none'", ''));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});
