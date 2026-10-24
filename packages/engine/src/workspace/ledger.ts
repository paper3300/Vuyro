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
  /** Worktrees left for a person (`worktree.kept`): key → what was recorded (`keptSignature`). */
  readonly kept: Readonly<Record<string, string>>;
  /** Clean-ups a person approved that the engine has not carried out yet: key → fingerprint. */
  readonly approved: Readonly<Record<string, string>>;
  /**
   * Which tickets edited a file, per space and path key (exclusive checkouts and changes attributed to a checkout),
   * most recent last. Outlives the entries: a shared node's `blame` compares the files in a failed batch's errors with
   * it ([[공유·권한·BlackBoard 설계]] §4.5).
   */
  readonly edits: Readonly<Record<string, Readonly<Record<string, EditRecord>>>>;
  /** Which tickets held exclusive claims on a pattern, per space and pattern key (the weaker `blame` evidence). */
  readonly claimed: Readonly<Record<string, Readonly<Record<string, EditRecord>>>>;
  /** The shared node's batch building the project folder now (M5): one at a time. */
  readonly building?: { readonly sharedNode: string; readonly batch: number; readonly batchId: string };
}

export interface EditRecord {
  readonly path: string;
  readonly tickets: readonly string[];
}

/** Tickets remembered per path: the most recent ones. */
const EDIT_HISTORY = 32;
/** Paths remembered per space: the most recently edited ones (older edits can no longer be blamed). */
export const EDIT_PATHS = 10_000;

export const EMPTY_LEDGER: LedgerState = { entries: {}, known: {}, changed: {}, warned: {}, worktrees: {}, kept: {}, approved: {}, edits: {}, claimed: {} };

export function remember(
  history: Readonly<Record<string, Readonly<Record<string, EditRecord>>>>,
  space: string,
  path: string,
  ticketId: string,
  limit = EDIT_PATHS,
): Readonly<Record<string, Readonly<Record<string, EditRecord>>>> {
  const key = pathKey(path);
  const bySpace = history[space] ?? {};
  const previous = Object.hasOwn(bySpace, key) ? bySpace[key] : undefined;
  const tickets = [...(previous?.tickets ?? []).filter((id) => id !== ticketId), ticketId].slice(-EDIT_HISTORY);
  // Most recent last (string keys keep their insertion order); the oldest paths go beyond the limit.
  const kept = Object.entries(bySpace).filter(([name]) => name !== key);
  const trimmed = kept.length >= limit ? kept.slice(kept.length - limit + 1) : kept;
  return { ...history, [space]: Object.fromEntries([...trimmed, [key, { path, tickets }]]) };
}

/** What a `worktree.kept` record says, for recording it again only when it changes. */
export function keptSignature(data: { removal: string; files: readonly string[]; ignored?: readonly string[]; count: number; ignoredCount?: number }): string {
  return JSON.stringify([data.removal, data.count, data.ignoredCount ?? 0, data.files, data.ignored ?? []]);
}

function without<T>(record: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  const gone = new Set(ids);
  return Object.fromEntries(Object.entries(record).filter(([id]) => !gone.has(id)));
}

export function evolveLedger(state: LedgerState, event: NewEvent | DomainEvent): LedgerState {
  switch (event.type) {
    case 'checkout.acquired': {
      const entries = { ...state.entries };
      let { edits, claimed } = state;
      for (const entry of event.data.entries) {
        entries[entry.id] = entry;
        if (entry.mode !== 'exclusive') continue;
        if (entry.kind === 'checkout') edits = remember(edits, entry.space, entry.path, entry.holder.ticketId);
        else claimed = remember(claimed, entry.space, entry.path, entry.holder.ticketId);
      }
      return { ...state, entries, edits, claimed };
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
      let { edits } = state;
      for (const change of event.data.changes) {
        const key = pathKey(change.path);
        known[key] = change.hash;
        if (change.attribution === 'worktree') changed[key] = change.holder === undefined ? { path: change.path } : { path: change.path, holder: change.holder };
        if ((change.attribution === 'checkout' || change.attribution === 'worktree') && change.holder !== undefined) edits = remember(edits, space, change.path, change.holder.ticketId);
      }
      return { ...state, known: { ...state.known, [space]: known }, changed: { ...state.changed, [space]: changed }, edits };
    }
    case 'workspace.overlapWarned': {
      const [a, b] = event.data.spaces;
      return { ...state, warned: { ...state.warned, [warnKey(event.data.path, a, b)]: true } };
    }
    case 'workspace.buildStarted':
      return { ...state, building: { sharedNode: event.data.sharedNode, batch: event.data.batch, batchId: event.data.batchId } };
    case 'workspace.buildEnded':
      if (state.building?.sharedNode !== event.data.sharedNode || state.building.batch !== event.data.batch) return state;
      return Object.fromEntries(Object.entries(state).filter(([name]) => name !== 'building')) as unknown as LedgerState;
    case 'worktree.created':
      return { ...state, worktrees: { ...state.worktrees, [event.data.worktree.key]: event.data.worktree }, kept: without(state.kept, [event.data.worktree.key]) };
    case 'worktree.kept':
      return { ...state, kept: { ...state.kept, [event.data.key]: keptSignature(event.data) } };
    case 'worktree.cleanupApproved':
      return { ...state, approved: { ...state.approved, [event.data.key]: event.data.fingerprint } };
    case 'worktree.cleanupSkipped':
      return { ...state, approved: without(state.approved, [event.data.key]) };
    case 'worktree.removed': {
      const space = `wt:${event.data.key}`;
      return {
        ...state,
        worktrees: without(state.worktrees, [event.data.key]),
        kept: without(state.kept, [event.data.key]),
        approved: without(state.approved, [event.data.key]),
        known: without(state.known, [space]),
        changed: without(state.changed, [space]),
        edits: without(state.edits, [space]),
        claimed: without(state.claimed, [space]),
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
