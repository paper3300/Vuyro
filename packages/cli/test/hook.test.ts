import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliAgentAdapter } from '@vuyro/agent-adapters';
import { type EngineClient, type EngineClientOptions, type EngineDaemon, EngineUnavailableError, nodeProcessRunner, startEngineDaemon, systemClock } from '@vuyro/engine';
import { denyOutput, editedFiles, patchFiles, runPreToolUseHook } from '../src/hook.ts';
import { type CliIo, runCli } from '../src/index.ts';

/**
 * The automatic checkout hook `vuyro hook pretooluse` (M4): which files a tool call edits (Claude and Codex inputs as
 * recorded in M0b), the answer it prints (nothing = allowed, JSON deny otherwise), that it fails closed, and an end to
 * end run where the engine injects it into a (stand-in) Claude process that edits through it.
 */

const fixtures = fileURLToPath(new URL('../../agent-adapters/fixtures/', import.meta.url));

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

const AGENT = { VUYRO_RUN_TOKEN: `vrt_${'a'.repeat(43)}`, VUYRO_TICKET: '01900000-0000-7000-8000-000000000001', VUYRO_NODE: 'dev' };

function decision(output: string | undefined): { permissionDecision?: string; permissionDecisionReason?: string } | undefined {
  return output === undefined ? undefined : (JSON.parse(output) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
}

describe('which files a tool call edits', () => {
  it('reads Claude file tools (recorded hook input) and makes paths absolute', () => {
    const input = JSON.parse(readFileSync(join(fixtures, 'claude', '2.1.309', 'hook-input-pretooluse-edit.json'), 'utf8')) as { tool_input: { file_path: string } };
    expect(editedFiles(input, 'C:\\elsewhere')).toEqual([input.tool_input.file_path]);
    expect(editedFiles({ tool_name: 'Write', cwd: 'C:\\repo', tool_input: { file_path: 'src\\a.txt' } }, 'C:\\x')).toEqual([join('C:\\repo', 'src', 'a.txt')]);
    expect(editedFiles({ tool_name: 'NotebookEdit', cwd: 'C:\\repo', tool_input: { notebook_path: 'n.ipynb' } }, 'C:\\x')).toEqual([join('C:\\repo', 'n.ipynb')]);
    expect(editedFiles({ tool_name: 'Edit', cwd: 'C:\\repo', tool_input: {} }, 'C:\\x')).toEqual([]);
  });

  it('reads the files of a Codex apply_patch (recorded hook input), moves included', () => {
    const input = JSON.parse(readFileSync(join(fixtures, 'codex', '0.163.0', 'hook-input-pretooluse-apply-patch.json'), 'utf8')) as { cwd: string };
    expect(editedFiles(input, 'C:\\x')).toEqual([join(input.cwd, 'blocked.txt')]);
    expect(patchFiles('*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** Delete File: c.txt\n*** End Patch')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('leaves other tools alone (shell edits are found afterwards)', () => {
    const input = JSON.parse(readFileSync(join(fixtures, 'codex', '0.163.0', 'hook-input-pretooluse-bash.json'), 'utf8')) as unknown;
    expect(editedFiles(input, 'C:\\x')).toBeUndefined();
    expect(editedFiles({ tool_name: 'Read', tool_input: { file_path: 'a' } }, 'C:\\x')).toBeUndefined();
  });
});

describe('the hook answer', () => {
  const edit = JSON.stringify({ tool_name: 'Edit', cwd: 'C:\\repo', tool_input: { file_path: 'src\\a.txt' } });

  it('allows (prints nothing) when the checkout is granted, and denies with the reason when it is refused', async () => {
    const asked: string[][] = [];
    expect(await runPreToolUseHook(edit, 'C:\\x', (paths) => (asked.push([...paths]), Promise.resolve({ granted: true })))).toBeUndefined();
    expect(asked).toEqual([[join('C:\\repo', 'src', 'a.txt')]]);
    const refused = await runPreToolUseHook(edit, 'C:\\x', () => Promise.resolve({ granted: false, reason: "'src/a.txt' is held by node 'b'" }));
    expect(decision(refused)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Vuyro: 'src/a.txt' is held by node 'b'" });
  });

  it('fails closed: unreadable input, unknown files, no run token, or an error all deny', async () => {
    const granted = () => Promise.resolve({ granted: true });
    expect(decision(await runPreToolUseHook('not json', 'C:\\x', granted))?.permissionDecision).toBe('deny');
    expect(decision(await runPreToolUseHook(JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: 'garbage' } }), 'C:\\x', granted))?.permissionDecision).toBe('deny');
    expect(decision(await runPreToolUseHook(edit, 'C:\\x', undefined))?.permissionDecisionReason).toContain('VUYRO_RUN_TOKEN');
    expect(decision(await runPreToolUseHook(edit, 'C:\\x', () => Promise.reject(new Error('pipe closed'))))?.permissionDecisionReason).toContain('pipe closed');
    expect(decision(denyOutput('x'))?.permissionDecision).toBe('deny');
  });

  async function hook(stdin: string, env: Record<string, string>, connect?: (options: EngineClientOptions) => Promise<EngineClient>, args: string[] = []): Promise<{ code: number; out: string[]; err: string[] }> {
    const io = capture();
    async function* input(): AsyncGenerator<string> {
      await Promise.resolve();
      yield stdin;
    }
    const code = await runCli(['hook', 'pretooluse', '--provider', 'claude', ...args], io, { env, stdin: input(), ...(connect === undefined ? {} : { connect }) });
    return { code, out: io.stdout, err: io.stderr };
  }

  it('sends checkout.acquire with the run token, ticket and node from the environment', async () => {
    const sent: Record<string, unknown>[] = [];
    const connect = (): Promise<EngineClient> =>
      Promise.resolve({
        execute: (envelope: Record<string, unknown>) => {
          sent.push(envelope);
          return Promise.resolve({ ok: true, requestId: envelope.requestId, type: envelope.type, result: { granted: true, decision: 'granted', paths: ['src/a.txt'] }, events: null, replayed: false });
        },
        close: () => undefined,
      } as unknown as EngineClient);
    const result = await hook(edit, AGENT, connect);
    expect(result).toEqual({ code: 0, out: [], err: [] });
    expect(sent[0]).toMatchObject({
      type: 'checkout.acquire',
      payload: { ticketId: AGENT.VUYRO_TICKET, nodeId: 'dev', paths: [join('C:\\repo', 'src', 'a.txt')], source: 'hook' },
      auth: { runToken: AGENT.VUYRO_RUN_TOKEN },
    });
  });

  it('exits 0 with a deny when the engine is unreachable, the token is missing, or the call itself is wrong', async () => {
    const unreachable = (): Promise<EngineClient> => Promise.reject(new EngineUnavailableError('no engine'));
    const gone = await hook(edit, AGENT, unreachable);
    expect(gone.code).toBe(0);
    expect(decision(gone.out[0])?.permissionDecision).toBe('deny');
    const anonymous = await hook(edit, {});
    expect(decision(anonymous.out[0])?.permissionDecisionReason).toContain('VUYRO_RUN_TOKEN');
    // A broken invocation still answers with a deny: an error exit would let Claude (non-2) and Codex (any) go ahead.
    const broken = await hook(edit, AGENT, unreachable, ['--bogus', 'x']);
    expect(broken.code).toBe(0);
    expect(decision(broken.out[0])?.permissionDecision).toBe('deny');
  });
});

describe.runIf(process.platform === 'win32')('the engine injects the hook and an agent edits through it', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
  const fakeEditor = fileURLToPath(new URL('./helpers/fake-editor.ts', import.meta.url));
  const fixture = join(fixtures, 'claude', '2.1.309', 'simple.jsonl');
  const dir = mkdtempSync(join(tmpdir(), 'vuyro-hook-'));
  const dataDir = join(dir, 'data');
  const workspace = join(dir, 'workspace');
  const signals = join(dir, 'signals');
  const log = join(dir, 'editor.log');
  const pipePath = `\\\\.\\pipe\\vuyro-hook-test-${process.pid}-${Date.now()}`;
  const env = { VUYRO_DATA_DIR: dataDir, VUYRO_PIPE: pipePath };
  let daemon: EngineDaemon;
  let human: Record<string, string>;

  beforeAll(async () => {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(signals, { recursive: true });
    writeFileSync(log, '');
    process.env.FAKE_EDITOR_VUYRO = bin;
    daemon = await startEngineDaemon({
      dataDir,
      pipePath,
      approver: { confirm: () => Promise.resolve(true) },
      watcher: null,
      adapters: {
        claude: CliAgentAdapter.claude({
          runner: nodeProcessRunner,
          clock: systemClock,
          command: process.execPath,
          prefixArgs: [fakeEditor, fixture, log, signals],
          resolve: (command) => command,
          vuyroHook: { command: process.execPath, args: [bin] },
        }),
      },
      agentTimeoutMs: 60_000,
    });
    const login = capture();
    await runCli(['auth', 'login', '--json'], login, { env });
    human = { ...env, VUYRO_HUMAN_CREDENTIAL: (JSON.parse(login.stdout.join('\n')) as { credential: string }).credential };
  });

  afterAll(async () => {
    await daemon.close();
    delete process.env.FAKE_EDITOR_VUYRO;
    rmSync(dir, { recursive: true, force: true });
  });

  async function json<T>(args: string[]): Promise<T> {
    const io = capture();
    const code = await runCli([...args, '--json'], io, { env: human, cwd: dir });
    if (code !== 0) throw new Error(`vuyro ${args.join(' ')} → ${code}: ${io.stderr.join('\n')}`);
    return JSON.parse(io.stdout.join('\n') || '{}') as T;
  }

  it('blocks the second node right before its edit, pauses it, and lets it edit once the first is done', async () => {
    const template = {
      vuyro: 'export',
      formatVersion: 1,
      kind: 'template',
      id: 'test/pair',
      version: 1,
      name: 'Pair',
      content: {
        id: 'test/pair',
        version: 1,
        name: 'Pair',
        nodes: [
          { id: 'a', type: 'vuyro.agent', version: 1, params: { instructions: 'edit shared.txt' } },
          { id: 'b', type: 'vuyro.agent', version: 1, params: { instructions: 'edit shared.txt' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        edges: [
          { from: { node: 'a', port: 'done' }, to: { node: 'end', port: 'in' } },
          { from: { node: 'b', port: 'done' }, to: { node: 'end', port: 'in' } },
        ],
      },
    };
    writeFileSync(join(dir, 'template.json'), JSON.stringify(template));
    await json(['definition', 'save', '@template.json']);
    const { projectId } = await json<{ projectId: string }>(['project', 'create', 'sample']);
    await json(['project', 'configure', projectId, '--root', workspace]);
    let ticketId = '';
    for (let attempt = 0; attempt < 100 && ticketId === ''; attempt++) {
      const io = capture();
      if ((await runCli(['ticket', 'create', '--project', projectId, '--title', 'Edit', '--template', 'test/pair', '--json'], io, { env: human })) === 0) {
        ticketId = (JSON.parse(io.stdout.join('\n')) as { ticketId: string }).ticketId;
      } else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let status = 'open';
    for (let attempt = 0; attempt < 600 && status !== 'done'; attempt++) {
      status = (await json<{ ticket: { status: string } }>(['ticket', 'show', ticketId])).ticket.status;
      if (status !== 'done') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe('done');
    const steps = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { node: string; step: string; decision?: string; reason?: string; hook?: boolean; resumed?: boolean });
    const edits = steps.filter((step) => step.step === 'edit');
    expect(edits.map((step) => `${step.node}:${step.decision ?? ''}`)).toEqual(['a:allow', 'b:deny', 'b:allow']);
    expect(edits.every((step) => step.hook === true)).toBe(true);
    expect(edits[1]?.reason).toContain("held by node 'a'");
    expect(steps.filter((step) => step.step === 'started').map((step) => `${step.node}:${String(step.resumed)}`)).toEqual(expect.arrayContaining(['a:false', 'b:false', 'b:true']));
    expect(readFileSync(join(workspace, 'shared.txt'), 'utf8')).toBe('edited by b after a\n');

    const view = await json<{ blocks: { nodeId: string; source: string; outcome: string }[]; changes: unknown[] }>(['workspace', 'show', '--project', projectId, '--all']);
    expect(view.blocks).toMatchObject([{ nodeId: 'b', source: 'hook', outcome: 'wait' }]);
  }, 60_000);
});
