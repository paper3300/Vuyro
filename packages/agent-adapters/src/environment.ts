import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Prefix of every variable the engine reserves (Windows names are case-insensitive). */
const RESERVED = /^VUYRO_/i;

/**
 * Variables that belong to the session that started the engine, not to the user's settings: an agent CLI session
 * (Claude Code marks its children as nested sessions and hands them its own messaging socket and token) or a
 * terminal multiplexer's pane. Measured (M7a): an engine started from such a terminal passed them all to its agents.
 * User settings such as `CLAUDE_CODE_GIT_BASH_PATH` or `CLAUDE_CODE_USE_BEDROCK` are kept.
 */
const LAUNCHING_SESSION =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_\w+)|HERDR_\w+)$/i;

/**
 * Environment of an agent process: the user's environment (the CLI needs its login, proxy and tool
 * settings) without any inherited `VUYRO_*` variable, plus what the engine sets for this run.
 *
 * Inherited `VUYRO_*` values are dropped on purpose: a human credential exported in the terminal that
 * started the engine (`VUYRO_HUMAN_CREDENTIAL`), or another run's token, must never reach an agent. So are the
 * variables of the session that started the engine (`LAUNCHING_SESSION`).
 */
export function agentEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  run: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || RESERVED.test(name) || LAUNCHING_SESSION.test(name)) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(run)) env[name] = value;
  return env;
}

/** Case-insensitive lookup (Windows environment names). */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

export class ExecutableNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutableNotFoundError';
  }
}

/**
 * Finds an executable on PATH. Agents are started without a shell, and Windows cannot start a `.cmd`/`.bat`
 * shim without one, so only real executables count; a shim found instead is reported with what to do.
 */
export function resolveExecutable(command: string, env: Readonly<Record<string, string | undefined>>): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  const windows = process.platform === 'win32';
  const extensions = windows ? ['.exe', '.com'] : [''];
  const dirs = (envValue(env, 'PATH') ?? '').split(delimiter).filter((dir) => dir !== '');
  let shim: string | undefined;
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, command.toLowerCase().endsWith(extension) ? command : command + extension);
      if (isFile(candidate)) return candidate;
    }
    if (windows && shim === undefined) {
      for (const extension of ['.cmd', '.bat']) {
        const candidate = join(dir, command + extension);
        if (isFile(candidate)) shim = candidate;
      }
    }
  }
  if (shim !== undefined) {
    throw new ExecutableNotFoundError(
      `'${command}' is a script shim (${shim}), which cannot run without a shell. Configure the path of the real executable.`,
    );
  }
  throw new ExecutableNotFoundError(`'${command}' was not found on PATH`);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
