import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { envValue } from './environment.ts';

/**
 * The user's Codex folder (`CODEX_HOME`, default `~/.codex`), read only. Vuyro never writes there: it holds the
 * user's login, and the checkout hook must not depend on changing the user's settings ([[결정 대기]] D-031).
 */

export function codexHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = envValue(env, 'CODEX_HOME');
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.codex');
}

/**
 * Whether the user has Codex hooks in `<CODEX_HOME>/hooks.json`. Codex loads that file even with
 * `--ignore-user-config`, and the hook trust bypass the checkout hook needs would run those hooks unchecked
 * ([[초기 검증 결과]] M4), so the engine leaves the checkout hook out then. Unreadable counts as present.
 */
export function codexUserHooks(home: string): boolean {
  const file = join(home, 'hooks.json');
  if (!existsSync(file)) return false;
  try {
    // Only a file that plainly declares nothing (`{}`, or `{"hooks": {}}` with empty lists) counts as no hooks.
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return false;
    const hooks = (parsed as { hooks?: unknown }).hooks;
    if (keys.length !== 1 || typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return true;
    return Object.values(hooks).some((groups) => !Array.isArray(groups) || groups.length > 0);
  } catch {
    return true;
  }
}

/**
 * The user's Windows sandbox setting (`[windows] sandbox` in config.toml). A hooked Codex run ignores the user's
 * config, and without this setting Codex treats `workspace-write` as read-only on Windows (measured), so the run
 * carries it over. Default `unelevated`: it needs no set-up.
 */
export function codexWindowsSandbox(home: string): string {
  let text: string;
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return 'unelevated';
  }
  let inWindows = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inWindows = /^\[\s*windows\s*\]$/.test(line);
      continue;
    }
    const match = inWindows ? /^sandbox\s*=\s*"([a-z-]+)"/.exec(line) : null;
    if (match?.[1] !== undefined) return match[1];
  }
  return 'unelevated';
}
