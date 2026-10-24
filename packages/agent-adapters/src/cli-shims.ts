import { delimiter } from 'node:path';
import type { HookCli } from './hooks.ts';

/**
 * The `vuyro` command on the agent's PATH. Agents report by running `vuyro …` from their shell (Claude's Bash tool
 * is Git Bash, its PowerShell tool and Codex's shell are PowerShell), but nothing puts the CLI on the PATH of a
 * person's PC: an installed app keeps it next to its own files. The engine writes these two shims into a folder of
 * its data directory and puts that folder first on every agent's PATH ([[초기 검증 결과]] M7a).
 *
 * - `vuyro.cmd`: found by cmd and PowerShell (PATHEXT).
 * - `vuyro`: a POSIX shell script for Git Bash (Claude's Bash tool), which does not look at PATHEXT.
 *
 * Only the CLI's paths are in them; the run token stays in the environment.
 */
export function vuyroShims(cli: HookCli): { readonly 'vuyro.cmd': string; readonly vuyro: string } {
  // cmd: `%` would expand inside the quotes.
  const cmdPart = (part: string): string => `"${part.replace(/%/g, '%%')}"`;
  // sh: single quotes take everything literally but a single quote.
  const shPart = (part: string): string => `'${part.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  const parts = [cli.command, ...cli.args];
  return {
    'vuyro.cmd': `@${parts.map(cmdPart).join(' ')} %*\r\n`,
    vuyro: `#!/bin/sh\nexec ${parts.map(shPart).join(' ')} "$@"\n`,
  };
}

/** `env` with `dirs` put first on its PATH (whatever the case of the variable's name), the rest kept in order. */
export function prependPath(env: Record<string, string>, dirs: readonly string[]): Record<string, string> {
  if (dirs.length === 0) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const rest = (env[key] ?? '').split(delimiter).filter((dir) => dir !== '' && !dirs.includes(dir));
  return { ...env, [key]: [...dirs, ...rest].join(delimiter) };
}
