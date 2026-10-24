import type { Holder } from '@vuyro/contracts';
import type { LedgerState } from '../workspace/ledger.ts';
import { CASE_INSENSITIVE, insideRoot, matches, normalizeRelative, pathKey } from '../workspace/paths.ts';

/**
 * Who broke a batch ([[공유·권한·BlackBoard 설계]] §4.5 `blame`): the files named in the batch's error lines are
 * compared with the checkout ledger's edit history. Pure: the `sharedNode.finish` handler decides with it.
 */

export interface ErrorScan {
  /** Error lines, in output order (at most MAX_LINES). */
  readonly lines: readonly string[];
  /** Workspace-relative files the error lines name, with the lines that name each (at most MAX_FILES). */
  readonly files: readonly { readonly path: string; readonly lines: readonly string[] }[];
}

const MAX_LINES = 1000;
const MAX_FILES = 1000;
const MAX_LINE_LENGTH = 2000;

/** A line that reports an error: `error`/`fatal error` as a word, not a count like `0 error(s)`. */
const ERROR_LINE = /(^|[^A-Za-z0-9_])(fatal )?error([^A-Za-z0-9_]|$)/i;
const NO_ERRORS = /\b0 errors?\b|\b0 error\(s\)/i;

/**
 * A file with an extension followed by a line number, the way compilers name the place of an error:
 * `Source/a.cpp(12): error`, `src/a.ts(12,5): error TS…`, `src/a.c:12:5: error:`, `C:\w\Source\a.cpp(3)`.
 */
const FILE_AT_LINE = /((?:[A-Za-z]:)?[\\/]?(?:[\w.$@+-]+[\\/])*[\w.$@+-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?=(?:\(\d+(?:[,:]\d+)*\)|:\d+))/g;

/**
 * Finds the error lines of a batch's output and the workspace files they name. Absolute paths count only inside
 * `root` (the project folder); relative ones are taken as relative to it.
 */
export function scanErrors(output: string, root: string | undefined, caseInsensitive = CASE_INSENSITIVE): ErrorScan {
  const lines: string[] = [];
  const files = new Map<string, { path: string; lines: string[] }>();
  for (const raw of output.split(/\r?\n/)) {
    if (lines.length >= MAX_LINES) break;
    if (!ERROR_LINE.test(raw) || NO_ERRORS.test(raw)) continue;
    const line = raw.trim().slice(0, MAX_LINE_LENGTH);
    lines.push(line);
    for (const match of line.matchAll(FILE_AT_LINE)) {
      const path = workspacePath(match[1] ?? '', root, caseInsensitive);
      if (path === undefined) continue;
      const key = pathKey(path, caseInsensitive);
      const found = files.get(key);
      if (found !== undefined) {
        if (!found.lines.includes(line)) found.lines.push(line);
      } else if (files.size < MAX_FILES) {
        files.set(key, { path, lines: [line] });
      }
    }
  }
  return { lines, files: [...files.values()] };
}

/** Explicit file names a script reported (`errorFiles` in its JSON result), as workspace paths. */
export function reportedFiles(paths: readonly string[], root: string | undefined, caseInsensitive = CASE_INSENSITIVE): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths.slice(0, MAX_FILES)) {
    const path = workspacePath(raw, root, caseInsensitive);
    if (path === undefined || seen.has(pathKey(path, caseInsensitive))) continue;
    seen.add(pathKey(path, caseInsensitive));
    result.push(path);
  }
  return result;
}

function workspacePath(raw: string, root: string | undefined, caseInsensitive: boolean): string | undefined {
  if (raw === '') return undefined;
  const absolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\');
  if (absolute) return root === undefined ? undefined : insideRoot(root, raw, caseInsensitive);
  return normalizeRelative(raw.replace(/\\/g, '/'));
}

export interface Blame {
  /** Members whose tickets edited a file the errors name (or held an exclusive claim over it). */
  readonly blamed: readonly Holder[];
  /** For each blamed ticket: the error files it edited. */
  readonly filesByTicket: ReadonlyMap<string, readonly string[]>;
  /** `edit`: from edits of the files; `claim`: only from exclusive claims covering them. */
  readonly evidence?: 'edit' | 'claim';
}

/**
 * The batch members to blame for `files` in workspace `space`: those whose tickets edited one of the files (the
 * ledger's edit history). Only when none did, those whose tickets held an exclusive claim covering one. Tickets not in
 * the batch are never blamed: their changes are not what this batch built. Empty when nothing points at a member.
 */
export function blameMembers(ledger: LedgerState, space: string, files: readonly string[], members: readonly Holder[], caseInsensitive = CASE_INSENSITIVE): Blame {
  const memberTickets = new Set(members.map((member) => member.ticketId));
  const pick = (ticketsOf: (file: string) => readonly string[]): Map<string, string[]> => {
    const byTicket = new Map<string, string[]>();
    for (const file of files) {
      for (const ticketId of ticketsOf(file)) {
        if (!memberTickets.has(ticketId)) continue;
        const list = byTicket.get(ticketId) ?? [];
        if (!list.includes(file)) list.push(file);
        byTicket.set(ticketId, list);
      }
    }
    return byTicket;
  };
  const edits = ledger.edits[space] ?? {};
  let evidence: Blame['evidence'] = 'edit';
  let byTicket = pick((file) => {
    // The ledger keys its history the way it keys everything (pathKey's default).
    const key = pathKey(file);
    return Object.hasOwn(edits, key) ? (edits[key]?.tickets ?? []) : [];
  });
  if (byTicket.size === 0) {
    evidence = 'claim';
    const claimed = Object.values(ledger.claimed[space] ?? {});
    byTicket = pick((file) => claimed.filter((record) => matches(record.path, file, caseInsensitive)).flatMap((record) => record.tickets));
  }
  if (byTicket.size === 0) return { blamed: [], filesByTicket: byTicket };
  return { blamed: members.filter((member) => byTicket.has(member.ticketId)), filesByTicket: byTicket, evidence };
}
