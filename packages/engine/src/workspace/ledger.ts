import type { CheckoutEntry, Conflict, DomainEvent, Holder, Worktree } from '@vuyro/contracts';
import type { NewEvent } from '../store/event-store.ts';
import { CASE_INSENSITIVE, overlaps, pathKey } from './paths.ts';

/**
 * The project's workspace ledger, folded from its aggregate (`workspace:<projectId>`). Pure: the command
 * handlers decide from it, the engine reads it to find what to release, hash or resume.
 */

export interface LedgerEntry extends CheckoutEntry {
  /** `release: ticketDone` entry whose node ended: the ticket keeps it until it completes. */
  readonly retained?: true;
  /** Hash when the holder paused (`checkout.paused`), until it runs again. */
  readonly pauseHash?: string | null;
}

export interface LedgerState {
  readonly entries: Readonly<Record<string, LedgerEntry>>;
  /** Last hash recorded per space and path key (baselines and detected changes). */
  readonly known: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** Paths changed in each worktree space (path key → path and holder), for overlap warnings. */
  readonly changed: Readonly<Record<string, Readonly<Record<string, { readonly path: string; readonly holder?: Holder }>>>>;
  /** Overlap warnings already recorded (`<path key>\u0000<space>\u0000<space>`). */
  readonly warned: Readonly<Record<string, true>>;
  readonly worktrees: Readonly<Record<string, Worktree>>;
  /** Worktrees kept instead of removed because of uncommitted changes (key → the files, as recorded). */
  readonly kept: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_LEDGER: LedgerState = { entries: {}, known: {}, changed: {}, warned: {}, worktrees: {}, kept: {} };

function without<T>(record: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  const gone = new Set(ids);
  return Object.fromEntries(Object.entries(record).filter(([id]) => !gone.has(id)));
}

export function evolveLedger(state: LedgerState, event: NewEvent | DomainEvent): LedgerState {
  switch (event.type) {
    case 'checkout.acquired': {
      const entries = { ...state.entries };
      for (const entry of event.data.entries) entries[entry.id] = entry;
      return { ...state, entries };
    }
    case 'checkout.released':
      return { ...state, entries: without(state.entries, event.data.ids) };
    case 'checkout.retained': {
      const entries = { ...state.entries };
      for (const id of event.data.ids) {
        const entry = entries[id];
        if (entry !== undefined) entries[id] = { ...entry, retained: true };
      }
      return { ...state, entries };
    }
    case 'checkout.paused': {
      const entries = { ...state.entries };
      for (const [id, hash] of Object.entries(event.data.hashes)) {
        const entry = entries[id];
        if (entry !== undefined) entries[id] = { ...entry, pauseHash: hash };
      }
      return { ...state, entries };
    }
    case 'checkout.resumed': {
      const entries = { ...state.entries };
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.pauseHash !== undefined && sameHolder(entry.holder, event.data.holder)) {
          entries[id] = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'pauseHash')) as unknown as LedgerEntry;
        }
      }
      return { ...state, entries };
    }
    case 'workspace.baselined': {
      const known = { ...(state.known[event.data.space] ?? {}) };
      for (const [path, hash] of Object.entries(event.data.files)) known[pathKey(path)] = hash;
      return { ...state, known: { ...state.known, [event.data.space]: known } };
    }
    case 'workspace.changesDetected': {
      const { space } = event.data;
      const known = { ...(state.known[space] ?? {}) };
      const changed = { ...(state.changed[space] ?? {}) };
      for (const change of event.data.changes) {
        const key = pathKey(change.path);
        known[key] = change.hash;
        if (change.attribution === 'worktree') changed[key] = change.holder === undefined ? { path: change.path } : { path: change.path, holder: change.holder };
      }
      return { ...state, known: { ...state.known, [space]: known }, changed: { ...state.changed, [space]: changed } };
    }
    case 'workspace.overlapWarned': {
      const [a, b] = event.data.spaces;
      return { ...state, warned: { ...state.warned, [warnKey(event.data.path, a, b)]: true } };
    }
    case 'worktree.created':
      return { ...state, worktrees: { ...state.worktrees, [event.data.worktree.key]: event.data.worktree }, kept: without(state.kept, [event.data.worktree.key]) };
    case 'worktree.kept':
      return { ...state, kept: { ...state.kept, [event.data.key]: event.data.files } };
    case 'worktree.removed': {
      const space = `wt:${event.data.key}`;
      return {
        ...state,
        worktrees: without(state.worktrees, [event.data.key]),
        kept: without(state.kept, [event.data.key]),
        known: without(state.known, [space]),
        changed: without(state.changed, [space]),
      };
    }
    default:
      return state;
  }
}

export function warnKey(path: string, a: string | undefined, b: string | undefined): string {
  const [first, second] = [a ?? '', b ?? ''].sort();
  return `${pathKey(path)}\u0000${first ?? ''}\u0000${second ?? ''}`;
}

export function sameHolder(a: Holder, b: Holder): boolean {
  return a.ticketId === b.ticketId && a.nodeId === b.nodeId && a.lane === b.lane && a.run === b.run;
}

export function holderKey(holder: Holder): string {
  return `${holder.ticketId}/${holder.nodeId}/${holder.lane}/${holder.run}`;
}

export interface PathRequest {
  /** Normalized relative path or pattern. */
  readonly path: string;
  readonly mode: 'exclusive' | 'shared';
}

/**
 * Entries of other holders in the same space that a request overlaps: at least one side exclusive, the paths can
 * name the same file, and the entry still holds (`holds`: not expired, holder still active). The requester's own
 * entries, and entries its ticket keeps after their node ended, never conflict with it.
 */
export function findConflicts(
  ledger: LedgerState,
  space: string,
  requests: readonly PathRequest[],
  requester: Holder,
  holds: (entry: LedgerEntry) => boolean,
  caseInsensitive = CASE_INSENSITIVE,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const entry of Object.values(ledger.entries)) {
    if (entry.space !== space || sameHolder(entry.holder, requester)) continue;
    if (entry.retained === true && entry.holder.ticketId === requester.ticketId) continue;
    for (const request of requests) {
      if (entry.mode === 'shared' && request.mode === 'shared') continue;
      if (!overlaps(entry.path, request.path, caseInsensitive)) continue;
      if (!holds(entry)) break;
      conflicts.push({ path: request.path, entryId: entry.id, entryPath: entry.path, holder: entry.holder });
    }
  }
  return conflicts;
}

/** Entries held by one execution. */
export function entriesOf(ledger: LedgerState, holder: Holder): LedgerEntry[] {
  return Object.values(ledger.entries).filter((entry) => sameHolder(entry.holder, holder));
}

/** Whether the holder already covers `path` in `mode` (an exclusive entry covers both modes). */
export function alreadyHeld(ledger: LedgerState, space: string, holder: Holder, path: string, mode: 'exclusive' | 'shared', caseInsensitive = CASE_INSENSITIVE): boolean {
  return entriesOf(ledger, holder).some(
    (entry) => entry.space === space && (entry.mode === 'exclusive' || mode === 'shared') && (entry.kind === 'checkout' ? pathKey(entry.path, caseInsensitive) === pathKey(path, caseInsensitive) : overlaps(entry.path, path, caseInsensitive) && !path.includes('*')),
  );
}
