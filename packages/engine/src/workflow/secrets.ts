import type { NodeTypeDefinition, NodeTypeSpec, RedactedField, TemplateSpec } from '@vuyro/contracts';

/**
 * Keeping secrets out of exports (M6b review). Three layers, strongest first:
 * 1. declared: a param marked `secret: true` in its node type always leaves (the authority);
 * 2. guessed by name: script environment values, params whose names look like secrets;
 * 3. guessed by value: every text value anywhere in the definition (arguments, prompts, nested params, extensions)
 *    that looks like a token or key.
 * What leaves becomes a `${secret:<name>}` placeholder (text) or is dropped (other values), the name goes to
 * `requires.credentials`, and every finding is listed for the person to check before the file is written.
 * Guessing can never be complete; declaring is what makes a secret certain to stay home.
 */

/** Param names whose values may be secrets. */
export const SECRET_NAME = /(token|secret|passw(or)?d|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;

/** A value made only of `{{ … }}` expressions refers to something else (a param); it is not itself a secret. */
const ONLY_EXPRESSIONS = /^(\s*\{\{[^{}]*\}\}\s*)+$/;

interface TokenPattern {
  readonly looksLike: string;
  readonly regex: RegExp;
  /** Text kept in front of the placeholder (`Bearer `). */
  readonly keep?: (match: string) => string;
  readonly accept?: (match: string) => boolean;
}

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Long, random-looking text: letters and digits mixed, not plain hex (hashes, commit ids), high entropy. */
function randomLooking(text: string): boolean {
  return /[0-9]/.test(text) && /[A-Za-z]/.test(text) && !/^[0-9a-fA-F]+$/.test(text) && entropy(text) >= 4.0;
}

const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { looksLike: '개인 키', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { looksLike: 'Bearer 토큰', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, keep: () => 'Bearer ' },
  { looksLike: 'GitHub 토큰', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { looksLike: 'Slack 토큰', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { looksLike: 'AWS 액세스 키', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { looksLike: 'API 키 (sk-)', regex: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { looksLike: '긴 무작위 문자열', regex: /[A-Za-z0-9_+=-]{32,}/g, accept: randomLooking },
];

const PLACEHOLDER = /\$\{secret:[^}]*\}/;

/** Collects findings and hands out unique placeholder names. */
export class SecretScrubber {
  readonly findings: RedactedField[] = [];
  readonly credentials: string[] = [];
  private readonly used = new Set<string>();

  private placeholder(name: string): string {
    const base = name.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 110) || 'value';
    let unique = base;
    for (let n = 2; this.used.has(unique); n++) unique = `${base}.${String(n)}`;
    this.used.add(unique);
    this.credentials.push(unique);
    return `\${secret:${unique}}`;
  }

  /** Replaces a whole value (declared, by name, env). Text becomes a placeholder; anything else is dropped (undefined). */
  replace(value: unknown, field: Omit<RedactedField, 'placeholder'>, name: string): string | undefined {
    if (typeof value !== 'string') {
      this.findings.push(field);
      this.credentials.push(name.replace(/[^A-Za-z0-9_.@-]/g, '_'));
      return undefined;
    }
    const placeholder = this.placeholder(name);
    this.findings.push({ ...field, placeholder });
    return placeholder;
  }

  /** Replaces what looks like a token inside a text; returns the text unchanged when nothing does. */
  scanText(text: string, path: string, label: string, name: string): string {
    let result = text;
    for (const pattern of TOKEN_PATTERNS) {
      result = result.replace(pattern.regex, (match: string) => {
        if (PLACEHOLDER.test(match)) return match;
        if (pattern.accept !== undefined && !pattern.accept(match)) return match;
        const placeholder = this.placeholder(name);
        this.findings.push({ path, label, reason: 'pattern', looksLike: pattern.looksLike, placeholder });
        return `${pattern.keep?.(match) ?? ''}${placeholder}`;
      });
    }
    return result;
  }

  /** Scans every text value under `value` (objects and arrays included). */
  scanValue(value: unknown, path: string, label: string, name: string): unknown {
    if (typeof value === 'string') return this.scanText(value, path, label, name);
    if (Array.isArray(value)) return value.map((item: unknown, index) => this.scanValue(item, `${path}/${String(index)}`, label, `${name}.${String(index)}`));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.scanValue(item, `${path}/${pointerEscape(key)}`, label, `${name}.${key}`)]));
    }
    return value;
  }
}

function pointerEscape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** A node type for export: declared and name-guessed param defaults, env values, then every value scanned. */
export function scrubNodeType(definition: NodeTypeDefinition, pointer: string, scrubber: SecretScrubber): NodeTypeDefinition {
  const at = `${definition.id}@${String(definition.version)}`;
  const content: NodeTypeSpec = structuredClone(definition.content);
  content.params.forEach((param, index) => {
    const declared = param.secret === true;
    if (!declared && !SECRET_NAME.test(param.name)) return;
    if (!Object.hasOwn(param.schema, 'default')) return;
    const replaced = scrubber.replace(
      param.schema.default,
      { path: `${pointer}/content/params/${String(index)}/schema/default`, label: `${at} · 파라미터 ${param.name}의 기본값`, reason: declared ? 'declared' : 'name' },
      `${definition.id}.${param.name}`,
    );
    if (replaced === undefined) delete param.schema.default;
    else param.schema.default = replaced;
  });
  if (content.script?.env !== undefined) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(content.script.env)) {
      env[name] = ONLY_EXPRESSIONS.test(value)
        ? value
        : (scrubber.replace(value, { path: `${pointer}/content/script/env/${name}`, label: `${at} · 스크립트 환경 변수 ${name}`, reason: 'env' }, `${definition.id}.env.${name}`) ?? '');
    }
    content.script.env = env;
  }
  const scanned = scrubber.scanValue(content, `${pointer}/content`, at, definition.id) as NodeTypeSpec;
  return { ...definition, content: scanned };
}

/** A template for export: values of declared or name-guessed params, then every value scanned. */
export function scrubTemplate(spec: TemplateSpec, pointer: string, declared: (type: string, version: number, param: string) => boolean, scrubber: SecretScrubber): TemplateSpec {
  const at = `${spec.id}@${String(spec.version)}`;
  const content: TemplateSpec = structuredClone(spec);
  content.nodes.forEach((node, index) => {
    if (node.params === undefined) return;
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.params)) {
      const isDeclared = declared(node.type, node.version, name);
      if (!isDeclared && !SECRET_NAME.test(name)) {
        params[name] = value;
        continue;
      }
      const replaced = scrubber.replace(
        value,
        { path: `${pointer}/nodes/${String(index)}/params/${name}`, label: `${at} · 노드 ${node.label ?? node.id}의 파라미터 ${name}`, reason: isDeclared ? 'declared' : 'name' },
        `${node.id}.${name}`,
      );
      if (replaced !== undefined) params[name] = replaced;
    }
    node.params = params;
  });
  return scrubber.scanValue(content, pointer, at, spec.id) as TemplateSpec;
}

/** Placeholder names in an exported text (what the importer must fill in). */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{secret:([A-Za-z0-9_.@-]{1,120})\}/g)].map((match) => match[1] ?? ''))];
}
