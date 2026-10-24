import { type ExpressionContext, resolveTemplateValue, stringifyValue } from '@vuyro/contracts';
import type { Clock } from '../runtime/clock.ts';
import type { ProcessRunner } from '../runtime/process.ts';
import type { CompiledScript } from './compile.ts';

/**
 * Runs a script node's program ([[명령·이벤트 계약]] §10.5): no shell, a minimal environment, a time limit, and the
 * tail of its output. Script nodes of tickets and shared nodes' batches (M5) both run through here.
 */

export const STDOUT_LIMIT = 1_048_576;
export const STDERR_LIMIT = 65_536;

export interface ScriptInvocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** From the script's own `cwd`, if it has one. */
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export interface ScriptExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut?: true;
  readonly error?: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Resolves the script's templates. An argument that is one expression resolving to an array becomes several. */
export function resolveScript(script: CompiledScript, context: ExpressionContext, baseEnv: Readonly<Record<string, string>>): ScriptInvocation {
  const program = stringifyValue(resolveTemplateValue(script.program, context));
  const args = script.args.flatMap((arg) => {
    const value = resolveTemplateValue(arg, context);
    return Array.isArray(value) ? value.map((item) => stringifyValue(item)) : [stringifyValue(value)];
  });
  const env: Record<string, string> = { ...baseEnv };
  for (const [name, value] of script.env) env[name] = stringifyValue(resolveTemplateValue(value, context));
  const cwd = script.cwd === undefined ? undefined : stringifyValue(resolveTemplateValue(script.cwd, context));
  return { program, args, env, ...(cwd === undefined || cwd === '' ? {} : { cwd }), timeoutMs: script.timeoutMs };
}

export interface RunningScript {
  readonly exited: Promise<ScriptExit>;
  /** Kills the process (cancellation). */
  kill(): void;
}

/** Starts the program without a shell in `cwd` (the script's own `cwd` wins) and collects its output. */
export function startScript(runner: ProcessRunner, clock: Clock, invocation: ScriptInvocation, cwd: string | undefined): RunningScript {
  const where = invocation.cwd ?? cwd;
  const child = runner.spawn({ command: invocation.program, args: [...invocation.args], env: { ...invocation.env }, ...(where === undefined || where === '' ? {} : { cwd: where }) });
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, invocation.timeoutMs);
  const exited = Promise.all([collect(child.stdout, STDOUT_LIMIT), collect(child.stderr, STDERR_LIMIT), child.exited]).then(([stdout, stderr, exit]): ScriptExit => {
    clock.clearTimeout(timer);
    return {
      exitCode: exit.code,
      signal: exit.signal,
      ...(timedOut ? { timedOut: true as const } : {}),
      ...(exit.error === undefined ? {} : { error: `could not start '${invocation.program}': ${exit.error.message}` }),
      stdout,
      stderr,
    };
  });
  return {
    exited,
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}

async function collect(chunks: AsyncIterable<string>, limit: number): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    text += chunk;
    // Keep the tail: the last line is where a JSON result is.
    if (text.length > limit * 2) text = text.slice(-limit);
  }
  return text.length > limit ? text.slice(-limit) : text;
}
