import { dirname, join, relative, sep } from 'node:path';
import {
  type CommandResponse,
  type DefinitionEnvelope,
  type DefinitionKind,
  type DomainEvent,
} from '@vuyro/contracts';
import type { CommandBus } from '../commands/command-bus.ts';
import type { TransportIdentity } from '../commands/caller.ts';
import type { ActivityTracker } from '../runtime/activity.ts';
import type { FileSystem } from '../runtime/fs.ts';
import type { EventStore } from '../store/event-store.ts';
import { sha256Hex } from '../commands/fingerprint.ts';
import { type DefinitionRegistry, definitionAggregate, definitionHash, definitionPath, findStagedEvent } from './definitions.ts';

export interface DefinitionWriterOptions {
  readonly registry: DefinitionRegistry;
  readonly fs: FileSystem;
  readonly bus: CommandBus;
  readonly store: EventStore;
  readonly activity?: ActivityTracker;
  readonly reportError?: (error: Error, context: string) => void;
}

export interface ScanReport {
  /** Files that no saved version accounts for. Never registered automatically. */
  readonly untracked: readonly string[];
  /** Registered versions whose file no longer matches the registered hash (refused until restored). */
  readonly modified: readonly string[];
  /** Registered active versions whose file is gone. */
  readonly missing: readonly string[];
  /** Leftover temporary files removed. */
  readonly removedTemp: readonly string[];
}

interface Staged {
  /** The command that staged it: one save, or every definition of one import. */
  readonly requestId?: string;
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly definition: DefinitionEnvelope;
}

const SYSTEM: TransportIdentity = { kind: 'internal', component: 'definitions' };
const TEMP_SUFFIX = '.tmp';

/**
 * Writes staged definitions to their files and activates them, one command's definitions at a time and in two
 * steps (M6b re-review): first every file (temporary file → rename over the target → read back and compare the hash),
 * then one activation for all of them (`definition.activate` / `definition.activateMany`, a single commit). If any
 * file cannot be written or the activation is refused, every version of that command is abandoned and the files it
 * wrote are removed, so an import never leaves part of itself usable.
 */
export class DefinitionWriter {
  private readonly options: DefinitionWriterOptions;
  private readonly waiters = new Map<string, ((outcome: { ok: boolean; reason?: string }) => void)[]>();
  private chain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(options: DefinitionWriterOptions) {
    this.options = options;
  }

  /** Reacts to `definition.staged` events from now on. */
  start(): void {
    this.unsubscribe ??= this.options.store.subscribe((events) => {
      const staged = events.filter((event): event is Extract<DomainEvent, { type: 'definition.staged' }> => event.type === 'definition.staged').map(stagedFrom);
      for (const group of byRequest(staged)) this.enqueue(group);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Sends the save command and waits until the version is active (or abandoned).
   * Returns the command response; a staged version that could not be written becomes an error.
   */
  async save(definition: DefinitionEnvelope, transport: TransportIdentity, requestId: string): Promise<CommandResponse> {
    const type = definition.kind === 'nodeType' ? 'nodeType.save' : 'template.save';
    const hash = definitionHash(definition);
    this.start();
    const waiting = this.wait(hash);
    const response = await this.options.bus.execute({ requestId, type, payload: { definition } }, transport);
    if (!response.ok || (response.result as { status: string }).status === 'active') {
      this.forget(hash, waiting.resolve);
      return response;
    }
    if (response.replayed) {
      // The same save was sent before (the built-ins on every start): the replayed answer says 'staged' from back
      // then, and no new `definition.staged` will come. The registry says how that save ended.
      const row = await this.options.registry.row(definition.kind, definition.id, definition.version);
      if (row?.hash === hash && row.status === 'active') {
        this.forget(hash, waiting.resolve);
        return { ...response, result: { ...(response.result as object), status: 'active' } };
      }
      if (row?.hash === hash && row.status === 'abandoned') {
        this.forget(hash, waiting.resolve);
        return { ok: false, requestId, error: { code: 'internal', message: 'this definition version was abandoned earlier (its file could not be written)', retryable: false } };
      }
      // Still staged: `recover()` or the writer's queue finishes it, and `waiting` hears about it.
    }
    const outcome = await waiting.promise;
    if (outcome.ok) return { ...response, result: { ...(response.result as object), status: 'active' } };
    return { ok: false, requestId, error: { code: 'internal', message: `could not write the definition file: ${outcome.reason ?? ''}`, retryable: true } };
  }

  /**
   * Finishes versions that were staged but never activated (the engine died in between):
   * the file is written from the staged content if it is missing or different, then activated.
   */
  async recover(): Promise<{ activated: string[]; abandoned: string[] }> {
    const activated: string[] = [];
    const abandoned: string[] = [];
    const staged: Staged[] = [];
    for (const row of await this.options.registry.rows('staged')) {
      const events = await this.options.store.readAggregate(definitionAggregate(row.kind, row.id));
      const event = findStagedEvent(events, row.version, row.hash);
      if (event === undefined) {
        await this.abandon(row, 'staged content not found in the log');
        abandoned.push(`${row.kind} ${row.id}@${String(row.version)}`);
        continue;
      }
      staged.push(stagedFrom(event));
    }
    // Versions an import staged together are finished together, as when the engine had not stopped. If part of the
    // group was already dropped (an older engine dropped them one at a time and stopped in between), the rest is
    // dropped too: a group is never activated without all of its members.
    const droppedRequests = await this.droppedRequests();
    for (const group of byRequest(staged)) {
      const requestId = group[0]?.requestId;
      const ok = requestId !== undefined && droppedRequests.has(requestId) ? await this.fail(group, [], 'another definition of the same import was abandoned') : await this.materialize(group);
      for (const each of group) (ok ? activated : abandoned).push(`${each.kind} ${each.id}@${String(each.version)}`);
    }
    return { activated, abandoned };
  }

  /** Commands that staged a version that was later abandoned. */
  private async droppedRequests(): Promise<Set<string>> {
    const requests = new Set<string>();
    for (const row of await this.options.registry.rows('abandoned')) {
      const event = findStagedEvent(await this.options.store.readAggregate(definitionAggregate(row.kind, row.id)), row.version, row.hash);
      if (event?.requestId !== undefined) requests.add(event.requestId);
    }
    return requests;
  }

  /** Compares the files on disk with the registered versions. Changes nothing except leftover temp files. */
  async scan(): Promise<ScanReport> {
    const { registry, fs } = this.options;
    const rows = await registry.rows();
    const known = new Map(rows.map((row) => [definitionPath(registry.root, row.kind, row.id, row.version), row]));
    const untracked: string[] = [];
    const modified: string[] = [];
    const missing: string[] = [];
    const removedTemp: string[] = [];
    for (const kind of ['nodeType', 'template'] as const) {
      const base = join(registry.root, kind === 'nodeType' ? 'node-types' : 'templates');
      for (const file of await walk(fs, base)) {
        if (file.endsWith(TEMP_SUFFIX)) {
          await fs.rm(file, { force: true });
          removedTemp.push(file);
          continue;
        }
        const row = known.get(file);
        if (row === undefined || row.status === 'abandoned') {
          untracked.push(relative(registry.root, file).split(sep).join('/'));
          continue;
        }
        const hash = await registry.fileHash(row.kind, row.id, row.version);
        if (hash !== row.hash) modified.push(`${row.kind} ${row.id}@${row.version}`);
      }
    }
    for (const row of rows) {
      if (row.status !== 'active') continue;
      if (!(await fs.exists(definitionPath(registry.root, row.kind, row.id, row.version)))) missing.push(`${row.kind} ${row.id}@${row.version}`);
    }
    return { untracked, modified, missing, removedTemp };
  }

  private enqueue(group: readonly Staged[]): void {
    const done = this.options.activity?.begin();
    this.chain = this.chain
      .then(() => this.materialize(group))
      .then(
        () => undefined,
        (error: unknown) => {
          this.report(error, `materializing ${group.map((each) => `${each.kind} ${each.id}@${String(each.version)}`).join(', ')}`);
        },
      )
      .finally(() => done?.());
  }

  /** Writes every file of the group, then activates them all in one command; on any failure abandons them all. */
  private async materialize(group: readonly Staged[]): Promise<boolean> {
    const { registry, fs } = this.options;
    const written: string[] = [];
    for (const staged of group) {
      const path = definitionPath(registry.root, staged.kind, staged.id, staged.version);
      const current = await registry.fileHash(staged.kind, staged.id, staged.version);
      if (current === staged.hash) continue;
      const temp = `${path}${TEMP_SUFFIX}`;
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(temp, `${JSON.stringify(staged.definition, null, 2)}\n`);
        await fs.rename(temp, path);
        written.push(path);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        return this.fail(group, written, `write failed for ${staged.kind} ${staged.id}@${String(staged.version)}: ${(error as Error).message}`);
      }
      const check = await registry.fileHash(staged.kind, staged.id, staged.version);
      if (check !== staged.hash) return this.fail(group, written, `file hash of ${staged.kind} ${staged.id}@${String(staged.version)} is ${check ?? 'unreadable'}, not ${staged.hash}`);
    }
    const keys = group.map((staged) => ({ kind: staged.kind, id: staged.id, version: staged.version, hash: staged.hash }));
    const [only] = keys;
    const response =
      keys.length === 1 && only !== undefined
        ? await this.options.bus.execute({ requestId: `def-activate-${only.hash.slice(7, 39)}-${String(only.version)}`, type: 'definition.activate', payload: only }, SYSTEM)
        : await this.options.bus.execute(
            { requestId: `def-activate-many-${sha256Hex(keys.map((key) => `${key.hash}@${String(key.version)}`).join(',')).slice(0, 40)}`, type: 'definition.activateMany', payload: { items: keys } },
            SYSTEM,
          );
    if (!response.ok) return this.fail(group, written, `activation refused: ${response.error.message}`);
    for (const staged of group) this.settle(staged.hash, { ok: true });
    return true;
  }

  private async fail(group: readonly Staged[], written: readonly string[], reason: string): Promise<false> {
    for (const path of written) await this.options.fs.rm(path, { force: true }).catch(() => undefined);
    await this.abandonGroup(group, reason);
    for (const staged of group) this.settle(staged.hash, { ok: false, reason });
    return false;
  }

  /** Drops a whole group in one commit, so a stop in the middle never leaves part of it staged. */
  private async abandonGroup(group: readonly Staged[], reason: string): Promise<void> {
    const [only] = group;
    if (group.length === 1 && only !== undefined) {
      await this.abandon(only, reason);
      return;
    }
    const items = group.map((staged) => ({ kind: staged.kind, id: staged.id, version: staged.version, hash: staged.hash }));
    const response = await this.options.bus.execute(
      {
        requestId: `def-abandon-many-${sha256Hex(items.map((item) => `${item.hash}@${String(item.version)}`).join(',')).slice(0, 40)}`,
        type: 'definition.abandonMany',
        payload: { items, reason: reason.slice(0, 1024) },
      },
      SYSTEM,
    );
    if (!response.ok) this.report(new Error(response.error.message), `abandoning ${items.map((item) => `${item.kind} ${item.id}@${String(item.version)}`).join(', ')}`);
  }

  private async abandon(row: { kind: DefinitionKind; id: string; version: number; hash: string }, reason: string): Promise<void> {
    const response = await this.options.bus.execute(
      {
        requestId: `def-abandon-${row.hash.slice(7, 39)}-${row.version}`,
        type: 'definition.abandon',
        payload: { kind: row.kind, id: row.id, version: row.version, hash: row.hash, reason: reason.slice(0, 1024) },
      },
      SYSTEM,
    );
    if (!response.ok) this.report(new Error(response.error.message), `abandoning ${row.kind} ${row.id}@${row.version}`);
  }

  private wait(hash: string): { promise: Promise<{ ok: boolean; reason?: string }>; resolve: (outcome: { ok: boolean; reason?: string }) => void } {
    let resolve!: (outcome: { ok: boolean; reason?: string }) => void;
    const promise = new Promise<{ ok: boolean; reason?: string }>((done) => {
      resolve = done;
    });
    this.waiters.set(hash, [...(this.waiters.get(hash) ?? []), resolve]);
    return { promise, resolve };
  }

  private forget(hash: string, resolve: (outcome: { ok: boolean }) => void): void {
    const rest = (this.waiters.get(hash) ?? []).filter((candidate) => candidate !== resolve);
    if (rest.length === 0) this.waiters.delete(hash);
    else this.waiters.set(hash, rest);
  }

  private settle(hash: string, outcome: { ok: boolean; reason?: string }): void {
    const list = this.waiters.get(hash) ?? [];
    this.waiters.delete(hash);
    for (const resolve of list) resolve(outcome);
  }

  private report(error: unknown, context: string): void {
    const failed = error instanceof Error ? error : new Error(String(error));
    if (this.options.reportError !== undefined) this.options.reportError(failed, context);
    else process.stderr.write(`[vuyro] ${context}: ${failed.message}\n`);
  }
}

function stagedFrom(event: Extract<DomainEvent, { type: 'definition.staged' }>): Staged {
  const { kind, id, version, hash, definition } = event.data;
  return { ...(event.requestId === undefined ? {} : { requestId: event.requestId }), kind, id, version, hash, definition };
}

/** Staged versions grouped by the command that staged them (node types first in each group), in order. */
function byRequest(staged: readonly Staged[]): Staged[][] {
  const groups = new Map<string, Staged[]>();
  staged.forEach((each, index) => {
    const key = each.requestId ?? `#${String(index)}`;
    groups.set(key, [...(groups.get(key) ?? []), each]);
  });
  return [...groups.values()].map((group) => [...group.filter((each) => each.kind === 'nodeType'), ...group.filter((each) => each.kind === 'template')]);
}

async function walk(fs: FileSystem, dir: string): Promise<string[]> {
  if (!(await fs.exists(dir))) return [];
  const files: string[] = [];
  for (const name of await fs.readdir(dir)) {
    const path = join(dir, name);
    let children: string[] | undefined;
    try {
      children = await fs.readdir(path);
    } catch {
      children = undefined;
    }
    if (children === undefined) files.push(path);
    else files.push(...(await walk(fs, path)));
  }
  return files;
}
