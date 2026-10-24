import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in for the Claude CLI that edits a file through its PreToolUse hook, like Claude does: it reads the hook
 * the engine injected with `--settings`, runs the hook's command line in a shell with the tool call on stdin, and
 * edits only when the hook does not deny. A real process started by the engine through the Claude adapter.
 *
 *   node fake-editor.ts <fixture.jsonl> <log file> <signal dir> [claude arguments…]
 *
 * Node `a` edits `shared.txt`, waits until `b` was refused, then reports. Node `b` tries the same file, logs the
 * refusal and waits to be stopped; resumed (`--resume`), it edits and reports.
 */

const [, , fixture = '', log = '', signals = '', ...args] = process.argv;
const node = process.env.VUYRO_NODE ?? '?';
const cwd = process.cwd();

function record(entry: Record<string, unknown>): void {
  appendFileSync(log, `${JSON.stringify({ node, ...entry })}\n`);
}

function hookCommand(): string | undefined {
  const index = args.indexOf('--settings');
  if (index < 0) return undefined;
  const settings = JSON.parse(args[index + 1] ?? '{}') as { hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] } };
  return settings.hooks?.PreToolUse?.find((entry) => entry.matcher.split('|').includes('Edit'))?.hooks[0]?.command;
}

/** Runs the hook like the CLI would: the tool call as JSON on stdin; stdout empty = allowed. */
function edit(file: string, text: string): boolean {
  const command = hookCommand();
  const input = JSON.stringify({
    session_id: 'fake-session',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, file), old_string: '', new_string: text },
    tool_use_id: `toolu_${node}`,
  });
  let output = '';
  if (command !== undefined) output = execSync(command, { input, encoding: 'utf8', env: process.env, cwd }).trim();
  const decision = output === '' ? undefined : (JSON.parse(output) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  record({ step: 'edit', file, hook: command !== undefined, decision: decision?.permissionDecision ?? 'allow', reason: decision?.permissionDecisionReason ?? null });
  if (decision?.permissionDecision === 'deny') return false;
  writeFileSync(join(cwd, file), text);
  return true;
}

function report(): void {
  const bin = process.env.FAKE_EDITOR_VUYRO ?? '';
  execSync(`"${process.execPath}" "${bin}" node done --port done --summary edited`, { env: process.env, stdio: 'ignore' });
}

async function waitFor(file: string): Promise<void> {
  for (let attempt = 0; attempt < 600 && !existsSync(file); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
}

readFileSync(0, 'utf8');
const lines = readFileSync(fixture, 'utf8').split('\n').filter((line) => line !== '');
for (const line of lines.slice(0, -1)) process.stdout.write(`${line}\n`);
const resumed = args.includes('--resume');
record({ step: 'started', resumed });

if (node === 'a') {
  edit('shared.txt', 'edited by a\n');
  writeFileSync(join(signals, 'a-started'), '');
  await waitFor(join(signals, 'b-refused'));
  report();
} else if (!resumed) {
  await waitFor(join(signals, 'a-started'));
  if (!edit('shared.txt', 'edited by b\n')) writeFileSync(join(signals, 'b-refused'), '');
  // Refused: the engine stops this run and resumes it once the file is free.
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} else {
  edit('shared.txt', 'edited by b after a\n');
  report();
}
if (node === 'a') writeFileSync(join(signals, 'a-done'), '');
process.stdout.write(`${lines.at(-1) ?? ''}\n`);
