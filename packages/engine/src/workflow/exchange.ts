import {
  type ClippedText,
  type DefinitionEnvelope,
  type DefinitionKind,
  type ExportBundle,
  ExportBundleSchema,
  type ExportResult,
  IMPORTABLE_KINDS,
  type ImportAction,
  type ImportChoice,
  type ImportDependency,
  type ImportItem,
  type ImportPreview,
  type NodeExecutionPreview,
  NODE_TYPE_PATTERN,
  type NodeTypeDefinition,
  NodeTypeDefinitionSchema,
  nodeTypeKey,
  type NodeTypeSpec,
  type RedactedField,
  type SchemaValidator,
  TEMPLATE_ID_PATTERN,
  type TemplateDefinition,
  TemplateDefinitionSchema,
  type TemplateSpec,
  type WorkflowView,
} from '@vuyro/contracts';
import { canonicalJson, sha256Hex } from '../commands/fingerprint.ts';
import { type CompiledNodeType, compileNodeType, compileWorkflow } from './compile.ts';
import { workflowView } from '../daemon/workflow-view.ts';
import { type DefinitionRow, definitionHash } from './definitions.ts';
import { placeholdersIn, SecretScrubber, scrubNodeType, scrubTemplate } from './secrets.ts';

/**
 * Exporting and importing definitions as JSON ([[공유·권한·BlackBoard 설계]] §1, [[명령·이벤트 계약]] §17).
 *
 * Export reads a definition as its file holds it (hash checked), leaves out what may be a secret and says so.
 * Import never saves anything: it reads the text, checks it, shows what each node would run and where each
 * definition would go, and lists the save commands. The person confirms, and the app sends exactly those commands,
 * which check everything again.
 */

export class ExchangeError extends Error {
  readonly code: 'not_found' | 'invariant_violated';

  constructor(code: 'not_found' | 'invariant_violated', message: string) {
    super(message);
    this.name = 'ExchangeError';
    this.code = code;
  }
}

/** What export and import read from this engine. */
export interface ExchangeSource {
  /** Every registered version (staged, active, abandoned). */
  rows(): Promise<readonly DefinitionRow[]>;
  /** An active version as its file holds it, hash checked (latest when `version` is omitted). */
  activeDefinition(kind: DefinitionKind, id: string, version?: number): Promise<{ row: DefinitionRow; definition: DefinitionEnvelope } | undefined>;
  /** An active node type, compiled (for checking a template before it is saved). */
  nodeType(type: string, version: number): Promise<CompiledNodeType | undefined>;
  /** Strict validator for envelopes. */
  readonly validator: SchemaValidator;
  /** Lenient validator for schemas people write (port data, params), as the engine uses when saving. */
  readonly dataValidator: SchemaValidator;
}

// ---------------------------------------------------------------------------
// Export

function stripChecksum<T extends { checksum?: string }>(value: T): Omit<T, 'checksum'> {
  const rest = { ...value };
  delete rest.checksum;
  return rest;
}

function withChecksum<T extends DefinitionEnvelope>(definition: T): T {
  return { ...stripChecksum(definition), checksum: definitionHash(definition) } as T;
}

export function bundleHash(bundle: ExportBundle): string {
  return `sha256:${sha256Hex(canonicalJson(stripChecksum(bundle)))}`;
}

function credentialsOf(requires: DefinitionEnvelope['requires'], added: readonly string[]): string[] {
  return [...new Set([...(requires?.credentials ?? []), ...added])];
}

/** A definition with what the scrubber found named in `requires.credentials` (unchanged when it found nothing). */
function withCredentials<T extends DefinitionEnvelope>(original: T, cleaned: T, found: readonly string[]): T {
  if (found.length === 0) return original;
  return { ...cleaned, requires: { ...original.requires, credentials: credentialsOf(original.requires, found) } };
}

/** `type → version` of the node types a template uses (the highest version when it uses several). */
export function requiredNodeTypes(spec: TemplateSpec): Record<string, number> {
  const required: Record<string, number> = {};
  for (const node of spec.nodes) required[node.type] = Math.max(required[node.type] ?? 0, node.version);
  return required;
}

function fileName(id: string, version: number): string {
  return `${id.replace(/\//g, '.')}@${String(version)}.json`;
}

/** A node type for export, with what was replaced (secrets.ts). */
export function redactNodeType(definition: NodeTypeDefinition, pointer = ''): { definition: NodeTypeDefinition; redacted: RedactedField[] } {
  const scrubber = new SecretScrubber();
  const cleaned = scrubNodeType(definition, pointer, scrubber);
  return { definition: withCredentials(definition, cleaned, scrubber.credentials), redacted: scrubber.findings };
}

/**
 * The export of one active definition. A template is a bundle with the node types it uses unless
 * `embedNodeTypes` is false. Secrets are replaced by placeholders and listed (secrets.ts); the app shows the list
 * and the person confirms before the text is written or copied.
 */
export async function exportDefinition(
  source: ExchangeSource,
  request: { kind: DefinitionKind; id: string; version?: number; embedNodeTypes?: boolean },
): Promise<ExportResult> {
  const found = await active(source, request.kind, request.id, request.version);
  if (found.kind === 'nodeType') {
    const { definition, redacted } = redactNodeType(found);
    return { document: withChecksum(definition), fileName: fileName(found.id, found.version), redacted };
  }
  const template = found;
  const types: NodeTypeDefinition[] = [];
  const seen = new Set<string>();
  for (const node of template.content.nodes) {
    const key = nodeTypeKey(node.type, node.version);
    if (seen.has(key)) continue;
    seen.add(key);
    types.push((await active(source, 'nodeType', node.type, node.version)) as NodeTypeDefinition);
  }
  const declared = (type: string, version: number, param: string) =>
    types.some((each) => each.id === type && each.version === version && each.content.params.some((spec) => spec.name === param && spec.secret === true));
  const embed = request.embedNodeTypes !== false;
  const scrubber = new SecretScrubber();
  const content = scrubTemplate(template.content, embed ? '/content/content' : '/content', declared, scrubber);
  // Unchanged when nothing was found, so importing it here finds the same version.
  const cleaned = withCredentials(template, { ...template, content }, scrubber.credentials);
  if (!embed) return { document: withChecksum(cleaned), fileName: fileName(template.id, template.version), redacted: scrubber.findings };
  const redacted = [...scrubber.findings];
  const embedded = types.map((type, index) => {
    const result = redactNodeType(type, `/embedded/${String(index)}`);
    redacted.push(...result.redacted);
    return withChecksum(result.definition);
  });
  const allCredentials = credentialsOf(cleaned.requires, embedded.flatMap((type) => type.requires?.credentials ?? []));
  const bundle: ExportBundle = {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'bundle',
    id: template.id,
    version: template.version,
    name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    ...(template.author === undefined ? {} : { author: template.author }),
    requires: { nodeTypes: requiredNodeTypes(template.content), ...(allCredentials.length === 0 ? {} : { credentials: allCredentials }) },
    content: withChecksum(cleaned),
    embedded,
  };
  return { document: { ...bundle, checksum: bundleHash(bundle) }, fileName: fileName(template.id, template.version), redacted };
}

async function active(source: ExchangeSource, kind: DefinitionKind, id: string, version?: number): Promise<DefinitionEnvelope> {
  let found;
  try {
    found = await source.activeDefinition(kind, id, version);
  } catch (error) {
    throw new ExchangeError('invariant_violated', (error as Error).message);
  }
  if (found === undefined) throw new ExchangeError('not_found', `no active ${kind} ${id}${version === undefined ? '' : `@${version}`}`);
  return found.definition;
}

// ---------------------------------------------------------------------------
// Import

const PROMPT_PREVIEW = 1200;
const PARAM_PREVIEW = 600;
const MAX_PROBLEMS = 12;

function clipText(text: string, limit: number): ClippedText {
  return { text: text.length > limit ? `${text.slice(0, limit)}…` : text, length: text.length };
}

function shown(value: unknown, limit: number): ClippedText {
  return clipText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), limit);
}

/** One definition from the file, with where it came from. */
interface Entry {
  readonly key: string;
  readonly kind: 'nodeType' | 'template';
  readonly definition: DefinitionEnvelope;
}

const refusedKind = (kind: string): string =>
  /permission/i.test(kind)
    ? '권한 규칙은 파일로 가져올 수 없습니다. AI가 자기 권한을 바꾸지 못하도록 권한은 사람이 권한 화면에서만 바꿉니다(고정 규칙).'
    : `'${kind}' 종류는 가져올 수 없습니다. 노드 타입, 템플릿, 묶음(템플릿 + 노드 타입)만 가져옵니다.`;

function unreadable(problems: string[]): ImportPreview {
  return { readable: false, problems, items: [], dependencies: [], credentials: [], saves: [], canSave: false };
}

function issueLines(issues: readonly { path: string; message: string }[]): string[] {
  const lines = issues.slice(0, MAX_PROBLEMS).map((issue) => `${issue.path === '' ? '/' : issue.path}: ${issue.message}`);
  if (issues.length > MAX_PROBLEMS) lines.push(`외 ${issues.length - MAX_PROBLEMS}개`);
  return lines;
}

/** Parses and checks the text, and turns it into the definitions it holds. */
function readDocument(text: string, validator: SchemaValidator): { problems: string[]; entries?: Entry[]; document?: ImportPreview['document']; credentials?: string[]; blocking?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { problems: [`JSON으로 읽을 수 없습니다: ${(error as Error).message}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || (parsed as { vuyro?: unknown }).vuyro !== 'export') {
    return { problems: ['Vuyro 내보내기 파일이 아닙니다("vuyro": "export"가 없습니다).'] };
  }
  const head = parsed as { formatVersion?: unknown; kind?: unknown };
  if (head.formatVersion !== 1) return { problems: [`이 엔진이 읽을 수 없는 형식 버전입니다(formatVersion ${JSON.stringify(head.formatVersion)}).`] };
  if (typeof head.kind !== 'string' || !(IMPORTABLE_KINDS as readonly string[]).includes(head.kind)) return { problems: [refusedKind(String(head.kind))] };
  const kind = head.kind as (typeof IMPORTABLE_KINDS)[number];
  const schema = kind === 'nodeType' ? NodeTypeDefinitionSchema : kind === 'template' ? TemplateDefinitionSchema : ExportBundleSchema;
  const issues = validator.validate(schema, parsed);
  if (issues.length > 0) return { problems: ['파일의 형식이 맞지 않습니다.', ...issueLines(issues)] };

  const blocking: string[] = [];
  const checksum = (envelope: { checksum?: string }, actual: string, what: string) => {
    if (envelope.checksum !== undefined && envelope.checksum !== actual) blocking.push(`${what}의 체크섬이 내용과 맞지 않습니다. 파일이 바뀌었거나 손상되었습니다.`);
  };
  let entries: Entry[];
  let credentials: string[];
  if (kind === 'bundle') {
    const bundle = parsed as ExportBundle;
    checksum(bundle, bundleHash(bundle), '묶음');
    entries = bundle.embedded.map((type) => {
      checksum(type, definitionHash(type), `노드 타입 ${type.id}@${type.version}`);
      return { key: `nodeType:${type.id}@${type.version}`, kind: 'nodeType' as const, definition: type };
    });
    checksum(bundle.content, definitionHash(bundle.content), `템플릿 ${bundle.content.id}@${bundle.content.version}`);
    if (bundle.content.id !== bundle.id || bundle.content.version !== bundle.version) blocking.push('묶음의 id·버전과 안에 든 템플릿의 id·버전이 다릅니다.');
    entries.push({ key: `template:${bundle.content.id}@${bundle.content.version}`, kind: 'template', definition: bundle.content });
    credentials = credentialsOf(bundle.requires, [...(bundle.content.requires?.credentials ?? []), ...bundle.embedded.flatMap((type) => type.requires?.credentials ?? [])]);
  } else {
    const definition = parsed as DefinitionEnvelope;
    checksum(definition, definitionHash(definition), kind === 'nodeType' ? '노드 타입' : '템플릿');
    entries = [{ key: `${kind}:${definition.id}@${definition.version}`, kind, definition }];
    credentials = credentialsOf(definition.requires, []);
  }
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) blocking.push(`${entry.key}가 파일에 두 번 들어 있습니다.`);
    keys.add(entry.key);
  }
  const doc = parsed as { id: string; version: number; name: string; description?: string; author?: string };
  return {
    problems: [],
    blocking,
    entries,
    credentials,
    document: {
      kind,
      id: doc.id,
      version: doc.version,
      name: doc.name,
      ...(doc.description === undefined ? {} : { description: doc.description }),
      ...(doc.author === undefined ? {} : { author: doc.author }),
    },
  };
}

function nodePreview(type: NodeTypeSpec | undefined, fields: { nodeId?: string; label: string; type: string; typeVersion: number }): NodeExecutionPreview {
  if (type === undefined) return fields;
  const script = type.script;
  return {
    ...fields,
    completion: type.completion,
    ...(script === undefined
      ? {}
      : {
          script: {
            program: script.program,
            args: script.args ?? [],
            ...(script.cwd === undefined ? {} : { cwd: script.cwd }),
            env: Object.keys(script.env ?? {}),
            ...(script.timeout === undefined ? {} : { timeout: script.timeout }),
            ...(script.output === undefined ? {} : { output: script.output }),
          },
        }),
    ...(type.prompt === undefined ? {} : { prompt: clipText(type.prompt, PROMPT_PREVIEW) }),
    ...(type.claims === undefined || type.claims.length === 0 ? {} : { claims: type.claims.map((claim) => ({ path: claim.path, mode: claim.mode })) }),
    ...(type.reads === undefined || type.reads.length === 0 ? {} : { reads: type.reads }),
    ...(type.writes === undefined || type.writes.length === 0 ? {} : { writes: type.writes }),
  };
}

const ACTIONS: Readonly<Record<ImportItem['state'], readonly ImportAction[]>> = {
  new: ['add', 'newId', 'skip'],
  newVersion: ['add', 'newVersion', 'newId', 'skip'],
  same: ['skip', 'newVersion', 'newId'],
  conflict: ['newVersion', 'newId', 'skip'],
};

/**
 * What importing `text` would do with the given choices. Nothing is saved: the result lists the save commands
 * (node types first) for the app to send after the person confirms.
 */
export async function previewImport(source: ExchangeSource, text: string, choices: Readonly<Record<string, ImportChoice>> = {}): Promise<ImportPreview> {
  const read = readDocument(text, source.validator);
  if (read.entries === undefined) return unreadable(read.problems);
  const { entries } = read;
  const rows = (await source.rows()).filter((row) => row.status !== 'abandoned');
  const versionsOf = (kind: DefinitionKind, id: string) => rows.filter((row) => row.kind === kind && row.id === id);

  // Where each entry goes. A new version is newer than every version here and in the file.
  const nextVersion = new Map<string, number>();
  const fileMax = new Map<string, number>();
  for (const { kind, definition } of entries) fileMax.set(`${kind}:${definition.id}`, Math.max(fileMax.get(`${kind}:${definition.id}`) ?? 0, definition.version));
  const planned = entries.map((entry) => {
    const { definition } = entry;
    const existing = versionsOf(entry.kind, definition.id);
    const same = existing.find((row) => row.version === definition.version);
    const hash = definitionHash(definition);
    const state: ImportItem['state'] = same === undefined ? (existing.length === 0 ? 'new' : 'newVersion') : same.hash === hash ? 'same' : 'conflict';
    const actions = ACTIONS[state];
    const choice = Object.hasOwn(choices, entry.key) ? choices[entry.key] : undefined;
    const problems: string[] = [];
    const inner = entry.kind === 'nodeType' ? { id: (definition as NodeTypeDefinition).content.type, version: (definition as NodeTypeDefinition).content.version } : (definition as TemplateDefinition).content;
    if (inner.id !== definition.id || inner.version !== definition.version) problems.push(`봉투의 id·버전(${definition.id}@${definition.version})과 내용의 id·버전(${inner.id}@${inner.version})이 다릅니다.`);
    let action: ImportAction = state === 'same' || state === 'conflict' ? 'skip' : 'add';
    if (choice !== undefined) {
      if (actions.includes(choice.action)) action = choice.action;
      else problems.push(`이 항목은 '${choice.action}'로 처리할 수 없습니다.`);
    } else if (state === 'conflict') {
      problems.push(`${definition.id}@${definition.version}이(가) 다른 내용으로 이미 있습니다. 덮어쓰기(새 버전), 새 id, 건너뛰기 중 하나를 고르세요.`);
    }
    let target: ImportItem['target'];
    const name = choice?.name ?? definition.name;
    if (action === 'add') target = { id: definition.id, version: definition.version, name };
    else if (action === 'newVersion') {
      const key = `${entry.kind}:${definition.id}`;
      const version = Math.max(nextVersion.get(key) ?? fileMax.get(key) ?? 0, definition.version, ...existing.map((row) => row.version)) + 1;
      nextVersion.set(key, version);
      target = { id: definition.id, version, name };
    } else if (action === 'newId') {
      const id = choice?.id;
      const pattern = new RegExp(entry.kind === 'nodeType' ? NODE_TYPE_PATTERN : TEMPLATE_ID_PATTERN);
      if (id === undefined || !pattern.test(id)) {
        problems.push(entry.kind === 'nodeType' ? '새 id를 적으세요(예: myteam.build).' : '새 id를 적으세요(예: myteam/ai-sdlc).');
      } else if (versionsOf(entry.kind, id).length > 0) {
        problems.push(`${id}은(는) 이미 있는 id입니다. 다른 id를 적거나 덮어쓰기(새 버전)를 고르세요.`);
      } else {
        target = { id, version: definition.version, name };
      }
    }
    // What the person saw, for the engine to check again when saving (the engine may change in between).
    const expect: 'newId' | 'newVersion' | undefined = action === 'newId' || (action === 'add' && state === 'new') ? 'newId' : action === 'newVersion' ? 'newVersion' : undefined;
    return { entry, state, actions, action, target, expect, problems, hash, existing: existing.map((row) => row.version).sort((a, b) => a - b) };
  });

  // All final targets together (kept ids, new ids, new versions): one item per id@version, and a new id only for the
  // item that takes it. Saving checks the same against the engine again, all or nothing.
  const targetKey = (plan: (typeof planned)[number]) => (plan.target === undefined ? undefined : `${plan.entry.kind}:${plan.target.id}`);
  const byVersion = new Map<string, number>();
  for (const plan of planned) {
    const key = targetKey(plan);
    if (key === undefined || plan.target === undefined) continue;
    const exact = `${key}@${String(plan.target.version)}`;
    byVersion.set(exact, (byVersion.get(exact) ?? 0) + 1);
  }
  for (const plan of planned) {
    const key = targetKey(plan);
    if (key === undefined || plan.target === undefined) continue;
    if (plan.action === 'newId' && planned.some((other) => other !== plan && targetKey(other) === key)) {
      plan.problems.push(`${plan.target.id}을(를) 이 파일의 다른 항목도 쓰려고 합니다.`);
    } else if ((byVersion.get(`${key}@${String(plan.target.version)}`) ?? 0) > 1) {
      plan.problems.push(`${plan.target.id}@${String(plan.target.version)}에 이 파일의 두 항목이 저장됩니다. 한쪽을 새 id나 덮어쓰기(새 버전)로 바꾸세요.`);
    }
  }

  // Node types the import renames or re-versions: templates in the file follow them.
  const rewrites = new Map<string, { type: string; version: number }>();
  for (const plan of planned) {
    if (plan.entry.kind === 'nodeType' && plan.target !== undefined) {
      rewrites.set(nodeTypeKey(plan.entry.definition.id, plan.entry.definition.version), { type: plan.target.id, version: plan.target.version });
    }
  }
  const fromFile = new Map(planned.filter((plan) => plan.entry.kind === 'nodeType').map((plan) => [nodeTypeKey(plan.entry.definition.id, plan.entry.definition.version), plan]));

  // What each node type the templates use resolves to, and what it runs.
  const installed = new Map<string, NodeTypeDefinition | undefined>();
  const installedType = async (type: string, version: number): Promise<NodeTypeDefinition | undefined> => {
    const key = nodeTypeKey(type, version);
    if (!installed.has(key)) {
      try {
        installed.set(key, (await source.activeDefinition('nodeType', type, version))?.definition as NodeTypeDefinition | undefined);
      } catch {
        installed.set(key, undefined); // A changed file is as good as missing.
      }
    }
    return installed.get(key);
  };
  const dependencies = new Map<string, ImportDependency>();
  const resolved = new Map<string, NodeTypeSpec | undefined>();
  for (const plan of planned) {
    if (plan.entry.kind !== 'template') continue;
    for (const node of (plan.entry.definition as TemplateDefinition).content.nodes) {
      const key = nodeTypeKey(node.type, node.version);
      if (dependencies.has(key)) continue;
      const own = fromFile.get(key);
      const local = await installedType(node.type, node.version);
      let dependency: ImportDependency;
      if (own !== undefined && own.target !== undefined) {
        const moved = rewrites.get(key);
        dependency = { type: node.type, version: node.version, status: 'file', ...(moved !== undefined && (moved.type !== node.type || moved.version !== node.version) ? { savedAs: moved } : {}) };
        resolved.set(key, (own.entry.definition as NodeTypeDefinition).content);
      } else if (local !== undefined) {
        const different = own !== undefined && definitionHash(local) !== own.hash;
        dependency = { type: node.type, version: node.version, status: different ? 'installedDifferent' : 'installed' };
        resolved.set(key, local.content);
      } else {
        dependency = { type: node.type, version: node.version, status: 'missing' };
        resolved.set(key, own === undefined ? undefined : (own.entry.definition as NodeTypeDefinition).content);
      }
      dependencies.set(key, dependency);
    }
  }

  // The definitions to save, in order: node types, then templates.
  const saves: ImportPreview['saves'][number][] = [];
  const compiledPlanned = new Map<string, CompiledNodeType>();
  const ordered = [...planned.filter((plan) => plan.entry.kind === 'nodeType'), ...planned.filter((plan) => plan.entry.kind === 'template')];
  const views = new Map<string, WorkflowView>();
  for (const plan of ordered) {
    const { target, entry } = plan;
    if (entry.kind === 'nodeType') {
      if (target === undefined) continue;
      const type = entry.definition as NodeTypeDefinition;
      const changed = target.id !== type.id || target.version !== type.version || target.name !== type.name;
      const definition: NodeTypeDefinition = changed
        ? { ...stripChecksum(type), id: target.id, version: target.version, name: target.name, content: { ...type.content, type: target.id, version: target.version } }
        : type;
      const { nodeType, issues } = compileNodeType(definition.content, source.dataValidator);
      if (nodeType === undefined) plan.problems.push(...issueLines(issues));
      else compiledPlanned.set(nodeTypeKey(target.id, target.version), nodeType);
      saves.push({ type: 'nodeType.save', definition, ...(plan.expect === undefined ? {} : { expect: plan.expect }) });
      continue;
    }
    // Templates are compiled against the node types they would run with, also when skipped (for the picture).
    const template = entry.definition as TemplateDefinition;
    const nodes = template.content.nodes.map((node) => {
      const moved = rewrites.get(nodeTypeKey(node.type, node.version));
      return moved === undefined ? node : { ...node, type: moved.type, version: moved.version };
    });
    const into = target ?? { id: template.id, version: template.version, name: template.name };
    const content: TemplateSpec = { ...template.content, id: into.id, version: into.version, name: into.name, nodes };
    const types = new Map<string, CompiledNodeType>();
    for (const node of content.nodes) {
      const key = nodeTypeKey(node.type, node.version);
      if (types.has(key)) continue;
      const type = compiledPlanned.get(key) ?? (await source.nodeType(node.type, node.version).catch(() => undefined));
      if (type !== undefined) types.set(key, type);
    }
    const compiled = compileWorkflow(content, types, source.dataValidator);
    if (compiled.workflow !== undefined) views.set(entry.key, workflowView(compiled.workflow, { id: into.id, version: into.version, hash: plan.hash }));
    if (target === undefined) continue;
    for (const [key, dependency] of dependencies) {
      if (dependency.status === 'missing' && template.content.nodes.some((node) => nodeTypeKey(node.type, node.version) === key)) {
        plan.problems.push(`노드 타입 ${key}이(가) 파일에도 이 엔진에도 없습니다.`);
      }
    }
    if (plan.problems.length === 0) plan.problems.push(...issueLines(compiled.issues));
    const changed = canonicalJson(content) !== canonicalJson(template.content) || target.name !== template.name;
    const requires = template.requires?.nodeTypes === undefined ? template.requires : { ...template.requires, nodeTypes: requiredNodeTypes(content) };
    const definition: TemplateDefinition = changed
      ? { ...stripChecksum(template), id: target.id, version: target.version, name: target.name, ...(requires === undefined ? {} : { requires }), content }
      : template;
    saves.push({ type: 'template.save', definition, ...(plan.expect === undefined ? {} : { expect: plan.expect }) });
  }

  const items = planned.map((plan): ImportItem => {
    const { definition } = plan.entry;
    const view = views.get(plan.entry.key);
    let execution: NodeExecutionPreview[];
    let settings: ImportItem['settings'];
    if (plan.entry.kind === 'nodeType') {
      const spec = (definition as NodeTypeDefinition).content;
      execution = [nodePreview(spec, { label: spec.label, type: spec.type, typeVersion: spec.version })];
    } else {
      const spec = (definition as TemplateDefinition).content;
      settings = spec.settings;
      execution = spec.nodes.map((node) => {
        const preview = nodePreview(resolved.get(nodeTypeKey(node.type, node.version)), { nodeId: node.id, label: node.label ?? node.id, type: node.type, typeVersion: node.version });
        const params = Object.entries(node.params ?? {}).map(([name, value]) => ({ name, value: shown(value, PARAM_PREVIEW) }));
        return {
          ...preview,
          ...(params.length === 0 ? {} : { params }),
          ...(node.review === 'human' ? { review: 'human' as const } : {}),
          ...(node.settings === undefined ? {} : { settings: node.settings }),
        };
      });
    }
    return {
      key: plan.entry.key,
      kind: plan.entry.kind,
      id: definition.id,
      version: definition.version,
      name: definition.name,
      hash: plan.hash,
      state: plan.state,
      existingVersions: plan.existing,
      actions: plan.actions,
      action: plan.action,
      ...(plan.target === undefined ? {} : { target: plan.target }),
      problems: plan.problems,
      execution,
      ...(settings === undefined ? {} : { settings }),
      ...(view === undefined ? {} : { workflow: view }),
    };
  });

  const problems = [...read.problems, ...(read.blocking ?? [])];
  // Any problem stops the import, also on an item that would not be saved (a refused new id, an undecided conflict):
  // saving the rest would not be what the person chose.
  const blocked = problems.length > 0 || items.some((item) => item.problems.length > 0);
  return {
    readable: true,
    problems,
    ...(read.document === undefined ? {} : { document: read.document }),
    items,
    dependencies: [...dependencies.values()],
    // Named by the exporter, and any placeholder in the text even if the name list was edited away.
    credentials: [...new Set([...(read.credentials ?? []), ...placeholdersIn(text)])],
    saves,
    canSave: !blocked && saves.length > 0,
  };
}
