import { join } from 'node:path';
import {
  type DefinitionEnvelope,
  DefinitionEnvelopeSchema,
  definitionAggregateId,
  type DefinitionKind,
  type DomainEvent,
  type NodeTypeDefinition,
  nodeTypeKey,
  type PinnedTemplate,
  SchemaValidator,
  type TemplateDefinition,
} from '@vuyro/contracts';
import { canonicalJson, sha256Hex } from '../commands/fingerprint.ts';
import type { FileSystem } from '../runtime/fs.ts';
import type { EventStore } from '../store/event-store.ts';
import { type CompiledNodeType, type CompiledWorkflow, compileNodeType, compileWorkflow, DefinitionError } from './compile.ts';

/**
 * Definition files ([[기술 스택 결정]] §4): node types and templates are JSON files in the export
 * envelope format, one file per version: `<root>/node-types/vuyro.agent/1.json`,
 * `<root>/templates/vuyro/ai-sdlc/1.json`.
 *
 * Saving (see DefinitionMaterializer): an authorized `nodeType.save` / `template.save` command stages the
 * version (the event carries the content) → the file is written to a temporary name and renamed into
 * place → `definition.activate` marks it usable. On start, staged versions that never got activated are
 * finished from the staged content. Files nobody staged are reported, never registered on their own.
 */

/** 'sha256:<hex>' of the canonical JSON of the envelope without its `checksum`. */
export function definitionHash(definition: DefinitionEnvelope): string {
  const rest = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'checksum'));
  return `sha256:${sha256Hex(canonicalJson(rest))}`;
}

const KIND_DIRS: Readonly<Record<DefinitionKind, string>> = { nodeType: 'node-types', template: 'templates' };

export function definitionPath(root: string, kind: DefinitionKind, id: string, version: number): string {
  return join(root, KIND_DIRS[kind], ...id.split('/'), `${version}.json`);
}

export class DefinitionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionLoadError';
  }
}

export interface DefinitionRow {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly status: 'staged' | 'active' | 'abandoned';
}

export interface LoadedTemplate {
  readonly pin: PinnedTemplate;
  readonly workflow: CompiledWorkflow;
}

/** What command handlers need from the definitions (read side). */
export interface DefinitionResolver {
  /** Validator for schemas people and agents write (port data, params). */
  readonly dataValidator: SchemaValidator;
  /** An active node type version, read from its file and checked against the registered hash. */
  nodeType(type: string, version: number): Promise<CompiledNodeType | undefined>;
  /**
   * A node type with the hash it is pinned by: the active version when `hash` is omitted (undefined if not active),
   * else exactly that content (throws DefinitionLoadError if the file no longer matches). Shared nodes pin theirs.
   */
  pinnedNodeType(type: string, version: number, hash?: string): Promise<{ nodeType: CompiledNodeType; hash: string } | undefined>;
  /** An active template (latest active version when `version` is omitted), compiled and pinned. */
  template(id: string, version?: number): Promise<LoadedTemplate | undefined>;
  /** The workflow a ticket pinned. Throws DefinitionLoadError if any file no longer matches its pinned hash. */
  workflow(pin: PinnedTemplate): Promise<CompiledWorkflow>;
  /** Reads a definition file and returns its hash (undefined if missing or unreadable). */
  fileHash(kind: DefinitionKind, id: string, version: number): Promise<string | undefined>;
}

export interface DefinitionRegistryOptions {
  readonly root: string;
  readonly fs: FileSystem;
  readonly store: EventStore;
}

/**
 * Loads definitions from their files. A file is used only if its hash equals the registered (or pinned)
 * hash; anything else is refused (fail closed), because a ticket must run exactly what it pinned.
 */
export class DefinitionRegistry implements DefinitionResolver {
  readonly root: string;
  private readonly fs: FileSystem;
  private readonly store: EventStore;
  private readonly envelopeValidator = new SchemaValidator();
  /** Port, param and data schemas written by people and agents: unknown keywords are tolerated. */
  readonly dataValidator = new SchemaValidator({ strict: false });
  private readonly nodeTypes = new Map<string, CompiledNodeType>();
  private readonly workflows = new Map<string, CompiledWorkflow>();

  constructor(options: DefinitionRegistryOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.store = options.store;
  }

  async row(kind: DefinitionKind, id: string, version?: number): Promise<DefinitionRow | undefined> {
    const row =
      version === undefined
        ? await this.store.queryOne<RowShape>(
            "SELECT * FROM p_definitions WHERE kind = ? AND id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
            [kind, id],
          )
        : await this.store.queryOne<RowShape>('SELECT * FROM p_definitions WHERE kind = ? AND id = ? AND version = ?', [kind, id, version]);
    return row === undefined ? undefined : toRow(row);
  }

  async rows(status?: DefinitionRow['status']): Promise<DefinitionRow[]> {
    const rows =
      status === undefined
        ? await this.store.query<RowShape>('SELECT * FROM p_definitions ORDER BY kind, id, version')
        : await this.store.query<RowShape>('SELECT * FROM p_definitions WHERE status = ? ORDER BY kind, id, version', [status]);
    return rows.map(toRow);
  }

  async fileHash(kind: DefinitionKind, id: string, version: number): Promise<string | undefined> {
    try {
      return definitionHash(await this.readFile(kind, id, version));
    } catch {
      return undefined;
    }
  }

  /** Reads and shape-checks a definition file. Throws DefinitionLoadError. */
  async readFile(kind: DefinitionKind, id: string, version: number): Promise<DefinitionEnvelope> {
    const path = definitionPath(this.root, kind, id, version);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.fs.readText(path)) as unknown;
    } catch (error) {
      throw new DefinitionLoadError(`cannot read ${kind} ${id}@${version} (${path}): ${(error as Error).message}`);
    }
    const issues = this.envelopeValidator.validate(DefinitionEnvelopeSchema, parsed);
    if (issues.length > 0) throw new DefinitionLoadError(`${path} is not a valid definition: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    const envelope = parsed as DefinitionEnvelope;
    if (envelope.kind !== kind || envelope.id !== id || envelope.version !== version) {
      throw new DefinitionLoadError(`${path} holds ${envelope.kind} ${envelope.id}@${envelope.version}, not ${kind} ${id}@${version}`);
    }
    return envelope;
  }

  private async verified(kind: DefinitionKind, id: string, version: number, hash: string): Promise<DefinitionEnvelope> {
    const envelope = await this.readFile(kind, id, version);
    const actual = definitionHash(envelope);
    if (actual !== hash) {
      throw new DefinitionLoadError(
        `${kind} ${id}@${version} changed on disk (file ${actual}, registered ${hash}); restore the file or save a new version`,
      );
    }
    return envelope;
  }

  /**
   * Compiled forms are cached by hash, but the file is read and hashed again on every use, so a file
   * edited while the engine runs stops being used at the next command that needs it (fail closed).
   */
  private async compiledNodeType(type: string, version: number, hash: string): Promise<CompiledNodeType> {
    const envelope = (await this.verified('nodeType', type, version, hash)) as NodeTypeDefinition;
    const cached = this.nodeTypes.get(hash);
    if (cached !== undefined) return cached;
    const { nodeType, issues } = compileNodeType(envelope.content, this.dataValidator);
    if (nodeType === undefined) throw new DefinitionError(`node type ${type}@${version}`, issues);
    this.nodeTypes.set(hash, nodeType);
    return nodeType;
  }

  async nodeType(type: string, version: number): Promise<CompiledNodeType | undefined> {
    const row = await this.row('nodeType', type, version);
    if (row?.status !== 'active') return undefined;
    return this.compiledNodeType(type, version, row.hash);
  }

  async pinnedNodeType(type: string, version: number, hash?: string): Promise<{ nodeType: CompiledNodeType; hash: string } | undefined> {
    let pinned = hash;
    if (pinned === undefined) {
      const row = await this.row('nodeType', type, version);
      if (row?.status !== 'active') return undefined;
      pinned = row.hash;
    }
    return { nodeType: await this.compiledNodeType(type, version, pinned), hash: pinned };
  }

  async template(id: string, version?: number): Promise<LoadedTemplate | undefined> {
    const row = await this.row('template', id, version);
    if (row?.status !== 'active') return undefined;
    const envelope = (await this.verified('template', id, row.version, row.hash)) as TemplateDefinition;
    const nodeTypes: Record<string, string> = {};
    for (const node of envelope.content.nodes) {
      const key = nodeTypeKey(node.type, node.version);
      if (Object.hasOwn(nodeTypes, key)) continue;
      const typeRow = await this.row('nodeType', node.type, node.version);
      if (typeRow?.status !== 'active') throw new DefinitionLoadError(`template ${id}@${row.version} needs node type ${key}, which is not active`);
      nodeTypes[key] = typeRow.hash;
    }
    const pin: PinnedTemplate = { id, version: row.version, hash: row.hash, nodeTypes };
    return { pin, workflow: await this.workflow(pin) };
  }

  /**
   * The workflow a ticket pinned. Every call re-reads the template and node type files and checks their
   * hashes (the compiled graph itself is cached). Every workflow command and every executor start goes
   * through here, so a definition edited on disk stops the ticket before its next step.
   */
  async workflow(pin: PinnedTemplate): Promise<CompiledWorkflow> {
    const key = canonicalJson(pin);
    const envelope = (await this.verified('template', pin.id, pin.version, pin.hash)) as TemplateDefinition;
    const types = new Map<string, CompiledNodeType>();
    for (const [typeKey, hash] of Object.entries(pin.nodeTypes)) {
      const at = typeKey.lastIndexOf('@');
      types.set(typeKey, await this.compiledNodeType(typeKey.slice(0, at), Number(typeKey.slice(at + 1)), hash));
    }
    const cached = this.workflows.get(key);
    if (cached !== undefined) return cached;
    const { workflow, issues } = compileWorkflow(envelope.content, types, this.dataValidator);
    if (workflow === undefined) throw new DefinitionError(`template ${pin.id}@${pin.version}`, issues);
    this.workflows.set(key, workflow);
    return workflow;
  }
}

interface RowShape {
  kind: string;
  id: string;
  version: number;
  hash: string;
  status: string;
}

function toRow(row: RowShape): DefinitionRow {
  return { kind: row.kind as DefinitionKind, id: row.id, version: row.version, hash: row.hash, status: row.status as DefinitionRow['status'] };
}

export function definitionAggregate(kind: DefinitionKind, id: string): string {
  return definitionAggregateId(kind, id);
}

/** The latest `definition.staged` event of a version, for recovery. */
export function findStaged(events: readonly DomainEvent[], version: number, hash: string): DefinitionEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'definition.staged' && event.data.version === version && event.data.hash === hash) return event.data.definition;
  }
  return undefined;
}
