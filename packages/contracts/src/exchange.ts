import { type Static, Type } from '@sinclair/typebox';
import { NODE_TYPE_PATTERN } from './node-type.ts';
import type { WorkflowView } from './rpc.ts';
import { DEFINITION_ID_PATTERN, HashSchema, NodeTypeDefinitionSchema, TemplateDefinitionSchema } from './workflow.ts';

/**
 * Sharing definitions as JSON files and through the clipboard ([[공유·권한·BlackBoard 설계]] §1, M6).
 *
 * A node type or a template travels in the same export envelope its definition file uses, so a single exported
 * definition is also a valid definition file. A bundle carries a template with the node types it uses. Secrets never
 * travel: exporting removes script environment values and secret-looking parameter values and names them in
 * `requires.credentials`. Importing shows what the file would run before anything is saved, and saving goes through
 * the same `nodeType.save` / `template.save` commands as any other definition.
 */

/** Kinds a file may hold. Anything else (permission presets above all) is refused when importing. */
export const IMPORTABLE_KINDS = ['nodeType', 'template', 'bundle'] as const;
export type ImportableKind = (typeof IMPORTABLE_KINDS)[number];

/** Largest export document accepted (characters of JSON text). */
export const MAX_EXPORT_TEXT = 4 * 1024 * 1024;

const RequiresSchema = Type.Object(
  {
    vuyro: Type.Optional(Type.String({ maxLength: 64 })),
    nodeTypes: Type.Optional(Type.Record(Type.String({ pattern: NODE_TYPE_PATTERN }), Type.Integer({ minimum: 1 }), { additionalProperties: false })),
    plugins: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 64 }))),
    artifactKinds: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
    blackboard: Type.Optional(Type.Array(Type.String({ maxLength: 512 }))),
    credentials: Type.Optional(Type.Array(Type.String({ maxLength: 128 }))),
  },
  { additionalProperties: false },
);

/**
 * A template with the node types it uses. `content` is the template's own envelope and `embedded` the node type
 * envelopes, each exactly as its definition file (so importing an unchanged export finds the same versions). The
 * bundle's `id`, `version` and `name` repeat the template's; `requires` lists every node type and left-out secret.
 */
export const ExportBundleSchema = Type.Object(
  {
    vuyro: Type.Literal('export'),
    formatVersion: Type.Literal(1),
    kind: Type.Literal('bundle'),
    /** The template's id and version. */
    id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 65536 })),
    author: Type.Optional(Type.String({ maxLength: 200 })),
    requires: Type.Optional(RequiresSchema),
    content: TemplateDefinitionSchema,
    embedded: Type.Array(NodeTypeDefinitionSchema, { maxItems: 200 }),
    /** 'sha256:<hex>' of the canonical JSON of the bundle without this field. Checked when present. */
    checksum: Type.Optional(HashSchema),
  },
  { additionalProperties: false },
);
export type ExportBundle = Static<typeof ExportBundleSchema>;

// ---------------------------------------------------------------------------
// Export

export const ExportDefinitionQuerySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('nodeType'), Type.Literal('template')]),
    id: Type.String({ pattern: DEFINITION_ID_PATTERN }),
    /** Default: the latest active version. */
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Templates: put the node types it uses in the file (a bundle). Default true. */
    embedNodeTypes: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * Something replaced in an export because it is or may be a secret. The value is never sent back: the export holds a
 * `${secret:<name>}` placeholder (or nothing, for a non-text value) and `requires.credentials` lists the name.
 * - declared: a param the node type marks `secret: true` (the authority).
 * - env: a script environment value (values are not shown to the engine's guesswork; all leave).
 * - name: a param whose name looks like a secret.
 * - pattern: a value that looks like a token or key (known prefixes, private keys, long random text). A guess, so
 *   the person checks the list before the file or clipboard gets it.
 */
export interface RedactedField {
  /** JSON pointer in the exported document. */
  readonly path: string;
  /** In words: which definition and which field (`p4.sync@1 · 환경 변수 P4PASSWD`). */
  readonly label: string;
  readonly reason: 'declared' | 'env' | 'name' | 'pattern';
  /** pattern: what it looked like (`GitHub 토큰`, `개인 키`, `긴 무작위 문자열`). */
  readonly looksLike?: string;
  /** The placeholder now in the export, if the value was text. */
  readonly placeholder?: string;
}

/** `${secret:<name>}`: where an exported secret was. Importing lists them; the person fills them in. */
export const SECRET_PLACEHOLDER_PATTERN = String.raw`\$\{secret:([A-Za-z0-9_.@-]{1,120})\}`;

export interface ExportResult {
  /** The document to write or copy (a definition envelope or a bundle), with its checksum. */
  readonly document: Readonly<Record<string, unknown>>;
  /** Suggested file name (`vuyro.ai-sdlc@1.json`). */
  readonly fileName: string;
  readonly redacted: readonly RedactedField[];
}

// ---------------------------------------------------------------------------
// Import

/**
 * - add: save as it is (new id, or a new version of an id that exists).
 * - skip: do not save it (a template then uses what is installed).
 * - newVersion: keep the id, save as the next free version (versions never change, so "overwrite" is a new version).
 * - newId: save under another id (and name), starting from the file's version.
 */
export const IMPORT_ACTIONS = ['add', 'skip', 'newVersion', 'newId'] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

export const ImportChoiceSchema = Type.Object(
  {
    action: Type.Union(IMPORT_ACTIONS.map((action) => Type.Literal(action))),
    /** newId: the id to save under. */
    id: Type.Optional(Type.String({ pattern: DEFINITION_ID_PATTERN })),
    /** newId and newVersion: a new display name. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ImportChoice = Static<typeof ImportChoiceSchema>;

export const ImportPreviewQuerySchema = Type.Object(
  {
    /** The file or pasted text. Parsed by the engine, so a malformed document is reported, never trusted. */
    text: Type.String({ maxLength: MAX_EXPORT_TEXT }),
    /** By item key (`nodeType:p4.sync@1`, `template:myteam/build@2`). Missing keys take the default action. */
    choices: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), ImportChoiceSchema, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

/** A script as it would run: program, arguments and folder are templates (§10.4) filled from params at run time. */
export interface ScriptPreview {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Names only. */
  readonly env: readonly string[];
  readonly timeout?: string;
  readonly output?: string;
}

/** Text cut for display: `text` is the first part, `length` the full length. */
export interface ClippedText {
  readonly text: string;
  readonly length: number;
}

/** What one node does when it runs: the part a person must see before importing (§1.3 "실행되는 것"). */
export interface NodeExecutionPreview {
  /** Template node id (absent for a node type on its own). */
  readonly nodeId?: string;
  readonly label: string;
  readonly type: string;
  readonly typeVersion: number;
  /** Absent when the node type is neither in the file nor installed. */
  readonly completion?: string;
  readonly script?: ScriptPreview;
  /** Agent nodes: the prompt template of the type. */
  readonly prompt?: ClippedText;
  /** Template nodes: the values given to the type's params (instructions, program, …). */
  readonly params?: readonly { readonly name: string; readonly value: ClippedText }[];
  /** Paths the node claims when it starts (exclusive = it will write there). */
  readonly claims?: readonly { readonly path: string; readonly mode: string }[];
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly review?: 'human';
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface ImportItem {
  readonly key: string;
  readonly kind: 'nodeType' | 'template';
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly hash: string;
  /**
   * new: no version of this id here. newVersion: the id exists, not this version. same: this version exists with the
   * same content (nothing to do). conflict: this version exists with other content (it cannot be saved as it is).
   */
  readonly state: 'new' | 'newVersion' | 'same' | 'conflict';
  readonly existingVersions: readonly number[];
  readonly actions: readonly ImportAction[];
  readonly action: ImportAction;
  /** Where it will be saved; absent when it will not be saved. */
  readonly target?: { readonly id: string; readonly version: number; readonly name: string };
  /** Problems that stop the import. */
  readonly problems: readonly string[];
  readonly execution: readonly NodeExecutionPreview[];
  /** Template settings (workspace mode, conflict policy). */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Templates that compile: the graph as screens draw it (with the node types it would run with). */
  readonly workflow?: WorkflowView;
}

/** A node type a template uses. */
export interface ImportDependency {
  readonly type: string;
  readonly version: number;
  /**
   * file: comes with the file and will be saved. installed: already here with the same content. installedDifferent:
   * the file's copy is skipped and this engine's different content will run. missing: neither in the file nor here.
   */
  readonly status: 'file' | 'installed' | 'installedDifferent' | 'missing';
  /** When the import saves the file's copy under another id or version, the template is pointed at it. */
  readonly savedAs?: { readonly type: string; readonly version: number };
}

export interface ImportPreview {
  /** The text is a Vuyro export this engine can read (otherwise only `problems`). */
  readonly readable: boolean;
  readonly problems: readonly string[];
  readonly document?: { readonly kind: ImportableKind; readonly id: string; readonly version: number; readonly name: string; readonly description?: string; readonly author?: string };
  readonly items: readonly ImportItem[];
  readonly dependencies: readonly ImportDependency[];
  /** Secrets the exporter left out (`requires.credentials`): the import runs without them. */
  readonly credentials: readonly string[];
  /**
   * What the import saves, in order (node types first): the items of one `definition.import` command, which stages
   * them together or not at all. `expect` carries what the preview promised (a new id, the newest version).
   */
  readonly saves: readonly { readonly type: 'nodeType.save' | 'template.save'; readonly definition: Readonly<Record<string, unknown>>; readonly expect?: 'newId' | 'newVersion' }[];
  /** Nothing blocks saving and something would be saved. */
  readonly canSave: boolean;
}

// ---------------------------------------------------------------------------
// Definitions on this engine

export const DefinitionsQuerySchema = Type.Object({ kind: Type.Optional(Type.Union([Type.Literal('nodeType'), Type.Literal('template')])) }, { additionalProperties: false });

export interface DefinitionListing {
  readonly kind: 'nodeType' | 'template';
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly hash: string;
  readonly status: 'staged' | 'active' | 'abandoned';
  /** The latest active version of its id. */
  readonly latest: boolean;
}
