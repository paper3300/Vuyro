import type { AgentProvider } from '@vuyro/contracts';

/**
 * The automatic checkout hook ([[공유·권한·BlackBoard 설계]] §3.8, [[초기 검증 결과]] M0b): right before the agent
 * edits a file, its CLI runs `vuyro hook pretooluse`, which checks the file out in Vuyro's ledger for the run (by
 * the run token in the environment) and answers with a JSON `deny` when the ledger refuses. JSON deny is the only
 * way that blocks in both CLIs (Codex ignores exit code 2).
 *
 * Only paths and fixed words go on the command line; the token reaches the hook through the environment.
 */

export interface HookCli {
  /** Executable (e.g. node) and the arguments that run the `vuyro` CLI (e.g. its bin.js). */
  readonly command: string;
  readonly args: readonly string[];
}

/** Claude's file tools. Shell tools are not matched: shell edits are found afterwards (change detection). */
export const CLAUDE_EDIT_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit';
/** Codex's file edits (Edit and Write are aliases of it). */
export const CODEX_EDIT_TOOLS = 'apply_patch';
/** Seconds the CLI waits for the hook. */
const HOOK_TIMEOUT_S = 60;

/** One command line for the CLI to run: forward slashes, and quotes only where a part has spaces. */
export function hookCommandLine(cli: HookCli, provider: AgentProvider): string {
  const quote = (part: string): string => {
    const slashed = part.replace(/\\/g, '/');
    return /[\s"]/.test(slashed) ? `"${slashed.replace(/"/g, '\\"')}"` : slashed;
  };
  return [cli.command, ...cli.args, 'hook', 'pretooluse', '--provider', provider].map(quote).join(' ');
}

/** `--settings` with a PreToolUse hook on Claude's file tools. Applies even with `--setting-sources ""`. */
export function claudeHookArgs(commandLine: string): string[] {
  const settings = {
    hooks: { PreToolUse: [{ matcher: CLAUDE_EDIT_TOOLS, hooks: [{ type: 'command', command: commandLine, timeout: HOOK_TIMEOUT_S }] }] },
  };
  return ['--settings', JSON.stringify(settings)];
}

/**
 * `hooks.PreToolUse` for Codex (a session override) and the flag without which Codex does not run hooks it has not
 * been told to trust. That flag runs every other enabled hook unchecked too, so the run also ignores the user's
 * config.toml (its hooks, and the hooks of the plugins it enables, are not loaded; the login stays). The user's
 * `hooks.json` and the repository's own hooks are loaded even so: the engine leaves the hook out when either exists
 * ([[결정 대기]] D-031, [[초기 검증 결과]] M4). Without the user's config Codex would treat `workspace-write` as
 * read-only on Windows, so the user's Windows sandbox setting is carried over.
 */
export function codexHookArgs(commandLine: string, options: { readonly windowsSandbox: string }): string[] {
  // JSON strings are valid TOML basic strings.
  const command = JSON.stringify(commandLine);
  return [
    '-c',
    `hooks.PreToolUse=[{matcher=${JSON.stringify(CODEX_EDIT_TOOLS)}, hooks=[{type="command", command=${command}, commandWindows=${command}, timeout=${HOOK_TIMEOUT_S}}]}]`,
    '--ignore-user-config',
    '-c',
    `windows.sandbox=${JSON.stringify(options.windowsSandbox)}`,
    '--dangerously-bypass-hook-trust',
  ];
}
