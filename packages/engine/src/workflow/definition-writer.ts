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
import { type DefinitionRegistry, definitionAggregate, definitionHash, definitionPath, findStaged } from './definitions.ts';

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
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly definition: DefinitionEnvelope;
}

const SYSTEM: TransportIdentity = { kind: 'internal', component: 'definitions' };
const TEMP_SUFFIX = '.tmp';

/**
 * Writes staged definitions to their files and activates them, in that order:
 * temporary file → rename over the target → read back and compare the hash → `definition.activate`.
 * A failure abandons the version (`definition.abandon`) so the caller can save again.
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
      for (const event of events) {
        if (event.type === 'definition.staged') this.enqueue(stagedFrom(event));
      }
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
    for (const row of await this.options.registry.rows('staged')) {
      const events = await this.options.store.readAggregate(definitionAggregate(row.kind, row.id));
      const definition = findStaged(events, row.version, row.hash);
      const label = `${row.kind} ${row.id}@${row.version}`;
      if (definition === undefined) {
        await this.abandon(row, 'staged content not found in the log');
        abandoned.push(label);
        continue;
      }
      const ok = await this.materialize({ ...row, definition });
      (ok ? activated : abandoned).push(label);
    }
    return { activated, abandoned };
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

  private enqueue(staged: Staged): void {
    const done = this.options.activity?.begin();
    this.chain = this.chain
      .then(() => this.materialize(staged))
      .then(
        () => undefined,
        (error: unknown) => {
          this.report(error, `materializing ${staged.kind} ${staged.id}@${staged.version}`);
        },
      )
      .finally(() => done?.());
  }

  private async materialize(staged: Staged): Promise<boolean> {
    const { registry, fs } = this.options;
    const path = definitionPath(registry.root, staged.kind, staged.id, staged.version);
    const current = await registry.fileHash(staged.kind, staged.id, staged.version);
    if (current !== staged.hash) {
      const temp = `${path}${TEMP_SUFFIX}`;
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(temp, `${JSON.stringify(staged.definition, null, 2)}\n`);
        await fs.rename(temp, path);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        return this.fail(staged, `write failed: ${(error as Error).message}`);
      }
      const written = await registry.fileHash(staged.kind, staged.id, staged.version);
      if (written !== staged.hash) return this.fail(staged, `file hash ${written ?? 'unreadable'} does not match ${staged.hash}`);
    }
    const response = await this.options.bus.execute(
      {
        requestId: `def-activate-${staged.hash.slice(7, 39)}-${staged.version}`,
        type: 'definition.activate',
        payload: { kind: staged.kind, id: staged.id, version: staged.version, hash: staged.hash },
      },
      SYSTEM,
    );
    if (!response.ok) return this.fail(staged, `activation refused: ${response.error.message}`);
    this.settle(staged.hash, { ok: true });
    return true;
  }

  private async fail(staged: Staged, reason: string): Promise<false> {
    await this.abandon(staged, reason);
    this.settle(staged.hash, { ok: false, reason });
    return false;
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
  return { kind, id, version, hash, definition };
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
