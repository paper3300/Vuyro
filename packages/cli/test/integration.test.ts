import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliAgentAdapter } from '@vuyro/agent-adapters';
import { type EngineDaemon, nodeProcessRunner, startEngineDaemon, systemClock } from '@vuyro/engine';
import { type CliIo, runCli } from '../src/index.ts';

/**
 * M3 completion test ([[구현 계획]] M3): a person creates a ticket with the `vuyro` CLI, the engine daemon starts the
 * node's agent through the real Claude adapter as a real process (a stand-in that replays a recorded run), and
 * the agent finishes the node with `vuyro artifact add` and `vuyro node done`, identified by the run token in its
 * environment. No real agent CLI runs.
 */

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const fakeAgent = fileURLToPath(new URL('./helpers/fake-agent.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../agent-adapters/fixtures/claude/2.1.309/tools-read-write.jsonl', import.meta.url));

const TEMPLATE = {
  vuyro: 'export',
  formatVersion: 1,
  kind: 'template',
  id: 'test/report',
  version: 1,
  name: 'Report',
  content: {
    id: 'test/report',
    version: 1,
    name: 'Report',
    nodes: [
      {
        id: 'write',
        type: 'vuyro.agent',
        version: 1,
        params: { instructions: 'Write the report and register it as the report artifact.' },
        ports: { done: { schema: { type: 'object', required: ['pages'], properties: { pages: { type: 'integer' } } } } },
      },
      { id: 'end', type: 'vuyro.end', version: 1 },
    ],
    edges: [{ from: { node: 'write', port: 'done' }, to: { node: 'end', port: 'in' } }],
  },
};

interface Captured extends CliIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

describe.runIf(process.platform === 'win32')('vuyro CLI against the engine daemon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vuyro-cli-'));
  const dataDir = join(dir, 'data');
  const log = join(dir, 'agent.log');
  const pipePath = `\\\\.\\pipe\\vuyro-cli-test-${process.pid}-${Date.now()}`;
  const env: Record<string, string | undefined> = { VUYRO_DATA_DIR: dataDir, VUYRO_PIPE: pipePath };
  let daemon: EngineDaemon;
  const approvals: string[] = [];

  async function vuyro(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{ code: number; out: Captured }> {
    const out = capture();
    const code = await runCli(args, out, { env: { ...env, ...extraEnv }, cwd: dir });
    return { code, out };
  }

  async function json<T>(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<T> {
    const { code, out } = await vuyro([...args, '--json'], extraEnv);
    if (code !== 0) throw new Error(`vuyro ${args.join(' ')} → ${code}: ${out.stderr.join('\n')}`);
    return JSON.parse(out.stdout.join('\n')) as T;
  }

  beforeAll(async () => {
    writeFileSync(log, '');
    daemon = await startEngineDaemon({
      dataDir,
      pipePath,
      approver: {
        confirm: (request) => {
          approvals.push(`${request.kind}:${request.code}`);
          return Promise.resolve(true);
        },
      },
      adapters: {
        claude: CliAgentAdapter.claude({
          runner: nodeProcessRunner,
          clock: systemClock,
          command: process.execPath,
          prefixArgs: [fakeAgent, bin, fixture, log],
          resolve: (command) => command,
        }),
      },
      agentTimeoutMs: 60_000,
    });
  });

  afterAll(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a ticket as a person and lets the agent finish its node through the CLI', async () => {
    // Without a credential the CLI is read-only.
    const refused = await vuyro(['project', 'create', 'sample']);
    expect(refused.code).toBe(1);
    expect(refused.out.stderr[0]).toMatch(/^vuyro: forbidden: /);

    // A person asks for a human credential; the engine asks on screen (here: approved) without restarting.
    const login = await vuyro(['auth', 'login', '--json']);
    expect(login.code).toBe(0);
    const { credential } = JSON.parse(login.out.stdout.join('\n')) as { credential: string };
    expect(login.out.stderr.join('\n')).toContain(`Code: ${approvals[0]?.split(':')[1] ?? '?'}`);
    const human = { VUYRO_HUMAN_CREDENTIAL: credential };
    expect((await json<{ identity: string }>(['auth', 'status'], human)).identity).toBe('human-cli');

    const { projectId } = await json<{ projectId: string }>(['project', 'create', 'sample'], human);
    // The agent inherits the engine's environment (this process), not the CLI's.
    process.env.TEST_PROJECT = projectId;
    writeFileSync(join(dir, 'template.json'), JSON.stringify(TEMPLATE));
    expect(await json<{ status: string }>(['definition', 'save', '@template.json'], human)).toMatchObject({ status: 'staged' });
    let ticketId = '';
    for (let attempt = 0; attempt < 100 && ticketId === ''; attempt++) {
      const created = await vuyro(['ticket', 'create', '--project', projectId, '--title', 'Write a report', '--template', 'test/report', '--json'], human);
      if (created.code === 0) ticketId = (JSON.parse(created.out.stdout.join('\n')) as { ticketId: string }).ticketId;
      else await new Promise((resolve) => setTimeout(resolve, 20)); // the definition activates right after staging
    }
    expect(ticketId).not.toBe('');

    // The agent runs as a real process and reports; wait for the ticket to finish.
    let status = 'open';
    for (let attempt = 0; attempt < 300 && status !== 'done'; attempt++) {
      status = (await json<{ ticket: { status: string } }>(['ticket', 'show', ticketId])).ticket.status;
      if (status !== 'done') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe('done');

    const steps = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    const step = (name: string) => steps.find((entry) => entry.step === name) ?? {};
    expect(step('started')).toMatchObject({ hasToken: true, human: null });
    expect(String(step('started').prompt)).toContain('Write the report and register it');
    expect(String(step('started').prompt)).toContain('vuyro node done');
    expect(step('started').args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json']));
    expect(step('ticket-create')).toMatchObject({ code: 1 });
    expect(String(step('ticket-create').stderr)).toContain('"forbidden"');
    expect(step('done-without-token')).toMatchObject({ code: 1 });
    expect(String(step('done-without-token').stderr)).toContain('"forbidden"');
    expect(step('artifact-add')).toMatchObject({ code: 0 });
    // A port the node does not have comes back as an error the agent can act on, then the real report goes through.
    expect(step('node-done-invalid')).toMatchObject({ code: 1 });
    expect(step('node-done')).toMatchObject({ code: 0 });

    const { artifacts } = await json<{ artifacts: { nodeId: string; slot: string; uri: string; version: string; source: string; current: boolean; runId: string }[] }>(['artifact', 'list', '--ticket', ticketId]);
    expect(artifacts).toMatchObject([{ nodeId: 'write', slot: 'report', uri: 'docs/report.md', version: 'v1', source: 'added', current: true }]);

    const detail = await json<{ runs: Record<string, unknown>[]; executions: Record<string, unknown>[] }>(['ticket', 'show', ticketId]);
    const result = JSON.parse(readFileSync(fixture, 'utf8').trim().split('\n').at(-1) ?? '{}') as { usage: { output_tokens: number } };
    expect(detail.runs).toMatchObject([{ nodeId: 'write', status: 'succeeded', exitCode: 0, toolCalls: 2, tokensOutput: result.usage.output_tokens, costBasis: 'list' }]);
    expect(artifacts[0]?.runId).toBe(detail.runs[0]?.runId);

    const stats = await json<{ status: string; tokens: { output: number }; toolCalls: number; nodes: { nodeId: string; runningMs: number }[] }>(['ticket', 'stats', ticketId]);
    expect(stats).toMatchObject({ status: 'done', tokens: { output: result.usage.output_tokens }, toolCalls: 2 });
    expect(stats.nodes.find((node) => node.nodeId === 'write')?.runningMs).toBeGreaterThan(0);

    // Who did what, from the log: the person created, the agent registered and reported.
    const lines = (await vuyro(['events', '--json'])).out.stdout.map((line) => JSON.parse(line) as { type: string; actor: { kind: string; role?: string; via?: string } });
    expect(lines.find((event) => event.type === 'ticket.created')?.actor).toMatchObject({ kind: 'human', via: 'cli' });
    expect(lines.find((event) => event.type === 'artifact.added')?.actor).toMatchObject({ kind: 'agent', role: 'node.agent' });
    expect(lines.find((event) => event.type === 'node.outputSubmitted')?.actor).toMatchObject({ kind: 'agent', role: 'node.agent' });
    expect(lines.filter((event) => event.type === 'command.denied')).toHaveLength(3); // unverified project, agent ticket, agent without token
  }, 60_000);

  it('reports usage errors and an unreachable engine with their exit codes', async () => {
    expect((await vuyro(['node', 'done'])).code).toBe(2);
    expect((await vuyro(['ticket', 'create', '--project', 'x', '--title', 't', '--bogus', '1'])).out.stderr[0]).toContain('unknown option --bogus');
    const gone = await runCli(['project', 'list'], capture(), { env: { VUYRO_DATA_DIR: join(dir, 'nothing'), VUYRO_PIPE: `${pipePath}-none` } });
    expect(gone).toBe(3);
  });
});
