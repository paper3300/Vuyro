import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/**
 * A stand-in for the Claude CLI in the integration test: a real process the engine starts through the Claude
 * adapter. It reads the prompt from stdin, prints a recorded stream-json run, and reports through the real
 * `vuyro` CLI with the run token the engine put in its environment, like an agent following its instructions.
 *
 *   node fake-agent.ts <vuyro bin> <fixture.jsonl> <log file> [claude arguments…]
 */

const [, , bin = '', fixture = '', log = ''] = process.argv;

function record(entry: Record<string, unknown>): void {
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

function vuyro(args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status: number | null; stdout?: string; stderr?: string };
    return { code: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

const prompt = readFileSync(0, 'utf8');
const lines = readFileSync(fixture, 'utf8').split('\n').filter((line) => line !== '');
record({ step: 'started', prompt, args: process.argv.slice(5), hasToken: (process.env.VUYRO_RUN_TOKEN ?? '').startsWith('vrt_'), human: process.env.VUYRO_HUMAN_CREDENTIAL ?? null });

for (const line of lines.slice(0, -1)) process.stdout.write(`${line}\n`);

// Outside its node: refused even though it is a real CLI call.
record({ step: 'ticket-create', ...vuyro(['ticket', 'create', '--project', process.env.TEST_PROJECT ?? '', '--title', 'agent ticket', '--json']) });
// Without its token the CLI is unverified: read-only.
const withoutToken = { ...process.env };
delete withoutToken.VUYRO_RUN_TOKEN;
record({ step: 'done-without-token', ...vuyro(['node', 'done', '--port', 'done', '--json'], withoutToken) });

record({ step: 'artifact-add', ...vuyro(['artifact', 'add', 'report', '--kind', 'file', '--uri', 'docs/report.md', '--version', 'v1', '--json']) });
record({ step: 'node-done-invalid', ...vuyro(['node', 'done', '--port', 'nope', '--json']) });
record({ step: 'node-done', ...vuyro(['node', 'done', '--port', 'done', '--summary', 'Wrote the report.', '--data', '{"pages":2}', '--json']) });

process.stdout.write(`${lines.at(-1) ?? ''}\n`);
