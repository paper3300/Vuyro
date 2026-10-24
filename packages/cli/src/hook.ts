import { isAbsolute, resolve } from 'node:path';

/**
 * `vuyro hook pretooluse`: the automatic checkout hook ([[공유·권한·BlackBoard 설계]] §3.8). The agent CLI runs it
 * right before a file tool runs, with the tool call as JSON on stdin. It checks the files out for the agent's run
 * (Vuyro's own ledger; nothing is locked in git or Perforce) and answers:
 * - nothing on stdout (exit 0): the edit may go ahead (it is not a file edit, or the checkout was granted);
 * - a JSON `deny` with the reason: the ledger refused, or anything went wrong (fail closed).
 * JSON deny is the one answer that blocks in both Claude and Codex ([[초기 검증 결과]] M0b).
 */

export type HookProvider = 'claude' | 'codex';

export interface HookCheckout {
  (paths: readonly string[]): Promise<{ granted: boolean; reason?: string }>;
}

/** Claude's file tools and the input field that names the file. */
const CLAUDE_FILE_FIELDS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;

/** Files a Codex `apply_patch` touches, from its patch text. */
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = PATCH_FILE.exec(line);
    const file = (match?.[1] ?? match?.[2])?.trim();
    if (file !== undefined && file !== '') files.push(file);
  }
  return files;
}

/**
 * The files a tool call is about to change, absolute. `undefined`: not a file edit (nothing to check out).
 * An empty list means it is a file edit whose files could not be read (refused).
 */
export function editedFiles(input: unknown, fallbackCwd: string): string[] | undefined {
  if (typeof input !== 'object' || input === null) return [];
  const call = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  const cwd = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : fallbackCwd;
  const toolInput = typeof call.tool_input === 'object' && call.tool_input !== null ? (call.tool_input as Record<string, unknown>) : {};
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  let files: string[];
  if (Object.hasOwn(CLAUDE_FILE_FIELDS, name)) {
    const value = toolInput[CLAUDE_FILE_FIELDS[name] ?? ''];
    files = typeof value === 'string' && value !== '' ? [value] : [];
  } else if (name === 'apply_patch') {
    const patch = typeof toolInput.command === 'string' ? toolInput.command : typeof toolInput.patch === 'string' ? toolInput.patch : '';
    files = patchFiles(patch);
  } else {
    return undefined;
  }
  return files.map((file) => (isAbsolute(file) ? file : resolve(cwd, file)));
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Vuyro: ${reason}` },
  });
}

/** Decides one hook call. Never throws: any failure is a deny. Returns what to print (nothing = allow). */
export async function runPreToolUseHook(stdin: string, cwd: string, checkout: HookCheckout | undefined): Promise<string | undefined> {
  let input: unknown;
  try {
    input = JSON.parse(stdin) as unknown;
  } catch {
    return denyOutput('the hook could not read the tool call, so the edit is blocked');
  }
  const files = editedFiles(input, cwd);
  if (files === undefined) return undefined;
  if (files.length === 0) return denyOutput('the hook could not tell which files this edit changes, so it is blocked');
  if (checkout === undefined) return denyOutput('this agent is not running as a Vuyro node (no VUYRO_RUN_TOKEN), so files cannot be checked out');
  try {
    const result = await checkout(files);
    if (result.granted) return undefined;
    return denyOutput(result.reason ?? 'the checkout was refused');
  } catch (error) {
    return denyOutput(`the checkout could not be made (${error instanceof Error ? error.message : String(error)}), so the edit is blocked`);
  }
}
