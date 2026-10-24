import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EngineClient, EngineClientOptions } from '@vuyro/engine';
import { type CliIo, runCli } from '../src/index.ts';

/** How CLI arguments and the environment become command envelopes (no engine; the client is a fake). */

const dir = mkdtempSync(join(tmpdir(), 'vuyro-cli-args-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeEngine() {
  const sent: { envelope: Record<string, unknown>; options: EngineClientOptions }[] = [];
  const requests: { method: string; options: EngineClientOptions }[] = [];
  const connect = (options: EngineClientOptions): Promise<EngineClient> =>
    Promise.resolve({
      request: (method: string) => {
        requests.push({ method, options });
        return Promise.resolve({ kind: 'cli', credential: 'vhc_new' });
      },
      on: () => () => undefined,
      hello: { protocol: 1, engineVersion: '0.0.0', identity: 'unverified', lastSequence: 0 },
      execute: (envelope: Record<string, unknown>) => {
        sent.push({ envelope, options });
        return Promise.resolve({ ok: true, requestId: envelope.requestId, type: envelope.type, result: {}, events: null, replayed: false });
      },
      close: () => undefined,
    } as unknown as EngineClient);
  return { sent, requests, connect };
}

const io = (): CliIo & { err: (line: string) => void; errors: string[] } => {
  const errors: string[] = [];
  return { errors, out: () => undefined, err: (line) => errors.push(line) };
};

describe('vuyro command envelopes', () => {
  const agentEnv = { VUYRO_RUN_TOKEN: `vrt_${'a'.repeat(43)}`, VUYRO_TICKET: '01900000-0000-7000-8000-000000000001', VUYRO_NODE: 'dev' };

  it('node done: ticket and node from the environment, token as auth, JSON from @file', async () => {
    writeFileSync(join(dir, 'items.json'), JSON.stringify([{ data: { taskId: 'T1' }, pairedInput: 0 }]));
    const engine = fakeEngine();
    const code = await runCli(['node', 'done', '--port', 'done', '--items', '@items.json', '--request-id', 'req-fixed-0001'], io(), { env: agentEnv, cwd: dir, connect: engine.connect });
    expect(code).toBe(0);
    expect(engine.sent[0]?.envelope).toEqual({
      requestId: 'req-fixed-0001',
      type: 'node.done',
      payload: { ticketId: agentEnv.VUYRO_TICKET, nodeId: 'dev', port: 'done', items: [{ data: { taskId: 'T1' }, pairedInput: 0 }] },
      auth: { runToken: agentEnv.VUYRO_RUN_TOKEN },
    });
    // The agent never names its lane; its run token decides it.
    expect(engine.sent[0]?.envelope.payload).not.toHaveProperty('lane');
    expect(engine.sent[0]?.options).not.toHaveProperty('humanCredential');
  });

  it('artifact add maps the reference fields', async () => {
    const engine = fakeEngine();
    await runCli(['artifact', 'add', 'change', '--kind', 'git', '--uri', 'repo:main', '--version', 'abc123', '--mime', 'text/x-diff', '--hash', 'sha256:00'], io(), { env: agentEnv, connect: engine.connect });
    expect(engine.sent[0]?.envelope).toMatchObject({
      type: 'artifact.add',
      payload: { ticketId: agentEnv.VUYRO_TICKET, nodeId: 'dev', slot: 'change', ref: { kind: 'git', uri: 'repo:main', version: 'abc123', mimeType: 'text/x-diff', contentHash: 'sha256:00' } },
    });
  });

  it('a person: the human credential goes to hello, flags name ticket, node and lane, no run token', async () => {
    const engine = fakeEngine();
    await runCli(['node', 'reject', '--ticket', 'T', '--node', 'qa', '--lane', '2', '--comment', 'again'], io(), {
      env: { VUYRO_HUMAN_CREDENTIAL: 'vhc_secret' },
      connect: engine.connect,
    });
    expect(engine.sent[0]?.options.humanCredential).toBe('vhc_secret');
    expect(engine.sent[0]?.envelope).toMatchObject({ type: 'node.reject', payload: { ticketId: 'T', nodeId: 'qa', lane: '2', comment: 'again' } });
    expect(engine.sent[0]?.envelope).not.toHaveProperty('auth');
  });

  it('auth login connects without the terminal human credential (an expired one would fail hello)', async () => {
    const engine = fakeEngine();
    const code = await runCli(['auth', 'login', '--json'], io(), { env: { VUYRO_HUMAN_CREDENTIAL: 'vhc_expired' }, connect: engine.connect });
    expect(code).toBe(0);
    expect(engine.requests).toEqual([{ method: 'auth.pair', options: expect.not.objectContaining({ humanCredential: expect.anything() as unknown }) as EngineClientOptions }]);
  });

  it('ticket create with a pinned template version', async () => {
    const engine = fakeEngine();
    await runCli(['ticket', 'create', '--project', 'P', '--title', 'Notepad', '--template', 'vuyro/ai-sdlc@1'], io(), { env: {}, connect: engine.connect });
    expect(engine.sent[0]?.envelope).toMatchObject({ type: 'ticket.create', payload: { projectId: 'P', title: 'Notepad', template: { id: 'vuyro/ai-sdlc', version: 1 } } });
  });

  it('shared define takes a spec or its export envelope; run and unblock name the shared node (M5)', async () => {
    const spec = { name: 'build', label: 'Build', node: { type: 'vuyro.script', version: 1 }, batchTrigger: { count: 3 }, maxConcurrent: 1, onBatchFailure: 'blame' };
    writeFileSync(join(dir, 'shared.json'), JSON.stringify({ vuyro: 'export', formatVersion: 1, kind: 'sharedNode', id: 'build', version: 1, name: 'Build', content: spec }));
    const engine = fakeEngine();
    const human = { env: { VUYRO_HUMAN_CREDENTIAL: 'vhc_secret' }, cwd: dir, connect: engine.connect };
    expect(await runCli(['shared', 'define', '--project', 'P', '@shared.json', '--json'], io(), human)).toBe(0);
    expect(await runCli(['shared', 'define', '--project', 'P', JSON.stringify(spec), '--json'], io(), human)).toBe(0);
    await runCli(['shared', 'run', 'build', '--project', 'P', '--json'], io(), human);
    await runCli(['shared', 'unblock', 'build', '--project', 'P', '--json'], io(), human);
    expect(engine.sent.map((entry) => [entry.envelope.type, entry.envelope.payload])).toEqual([
      ['sharedNode.define', { projectId: 'P', spec }],
      ['sharedNode.define', { projectId: 'P', spec }],
      ['sharedNode.run', { projectId: 'P', name: 'build' }],
      ['sharedNode.unblock', { projectId: 'P', name: 'build' }],
    ]);
    await runCli(['shared', 'show', '--project', 'P', 'build', '--json'], io(), human);
    expect(engine.requests.at(-1)?.method).toBe('query.sharedNodes');
  });

  it.each([
    [['shared', 'run', '--project', 'P'], "give the shared node's name"],
    [['shared', 'other'], "expected 'define', 'show', 'run' or 'unblock'"],
    [['node', 'done', '--port', 'done'], '--ticket is required'],
    [['node', 'done', '--ticket', 'T', '--node', 'n', '--port', 'done', '--data', '{bad'], 'not valid JSON'],
    [['artifact', 'add', 'slot', '--ticket', 'T', '--node', 'n', '--kind', 'file'], '--uri is required'],
    [['node', 'done', '--ticket', 'T', '--node', 'n', '--port'], '--port needs a value'],
    [['definition', 'save', '{"kind":"other"}'], "'kind' must be"],
  ])('%j is a usage error', async (args, message) => {
    const out = io();
    expect(await runCli(args, out, { env: {}, connect: fakeEngine().connect })).toBe(2);
    expect(out.errors.join('\n')).toContain(message);
  });
});
