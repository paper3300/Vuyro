/**
 * Path expressions and branch conditions ([[n8n 노드 데이터 전달 분석]] §6.5, [[기술 스택 결정]] §7).
 *
 * - Templates are strings with `{{ path }}` holes: `{{ input.summary }}`, `{{ nodes.spec.artifacts.specDoc }}`.
 *   A hole holds a path and nothing else: no operators, no calls, no literals. There is no `eval`.
 * - Conditions are a JSON AST of fixed comparisons and logic (`all`, `any`, `not`, `eq`, `lt`, …).
 * - Evaluation reads own properties of plain JSON values only, so a path can never reach a prototype.
 *
 * Runtime-neutral (shared with the renderer for previews). The engine builds the context object.
 */

/** Roots a path may start with. */
export const EXPRESSION_ROOTS = ['input', 'inputs', 'nodes', 'params', 'ticket', 'node', 'item', 'feedback'] as const;
export type ExpressionRoot = (typeof EXPRESSION_ROOTS)[number];

export type PathSegment = string | number;

export interface PathExpression {
  readonly root: ExpressionRoot;
  readonly segments: readonly PathSegment[];
  /** Source text inside the braces, trimmed. */
  readonly source: string;
}

export type TemplatePart = string | PathExpression;

export interface ParsedTemplate {
  readonly parts: readonly TemplatePart[];
}

export class ExpressionError extends Error {
  /** Character offset in the template where the problem starts. */
  readonly offset: number;

  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'ExpressionError';
    this.offset = offset;
  }
}

export const EXPRESSION_LIMITS = {
  /** Longest template (characters). Prompts are the largest templates. */
  templateLength: 262_144,
  /** Most `{{ }}` holes in one template. */
  holes: 1000,
  /** Most segments after the root. */
  segments: 32,
  /** Deepest condition AST. */
  conditionDepth: 32,
  /** Most condition nodes. */
  conditionNodes: 512,
  /** Most JSON values inside the literals of one condition. */
  conditionLiteralValues: 10_000,
  /** Longest string in a condition literal. */
  conditionLiteralString: 65_536,
  /** Most issues reported before checking stops. */
  conditionIssues: 50,
} as const;

/** Names that would reach object machinery instead of data. Refused while parsing and while evaluating. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

/** Parses `root.a.b[0]['c d']`. Throws ExpressionError. */
export function parsePath(source: string, baseOffset = 0): PathExpression {
  const text = source.trim();
  let index = 0;
  const fail = (message: string): never => {
    throw new ExpressionError(`${message} in '${text}'`, baseOffset + index);
  };
  const readIdent = (): string => {
    const start = index;
    const first = text[index];
    if (first === undefined || !IDENT_START.test(first)) fail('expected a name');
    index += 1;
    while (index < text.length && IDENT_PART.test(text[index] ?? '')) index += 1;
    return text.slice(start, index);
  };

  if (text === '') fail('empty expression');
  const root = readIdent();
  if (!(EXPRESSION_ROOTS as readonly string[]).includes(root)) {
    fail(`unknown root '${root}' (expected one of ${EXPRESSION_ROOTS.join(', ')})`);
  }
  const segments: PathSegment[] = [];
  while (index < text.length) {
    const char = text[index];
    if (char === '.') {
      index += 1;
      segments.push(readIdent());
    } else if (char === '[') {
      index += 1;
      const quote = text[index];
      if (quote === "'" || quote === '"') {
        index += 1;
        const start = index;
        while (index < text.length && text[index] !== quote) {
          if (text[index] === '\\') fail('escapes are not supported in keys');
          index += 1;
        }
        if (index >= text.length) fail('unterminated key');
        segments.push(text.slice(start, index));
        index += 1;
      } else {
        const start = index;
        while (index < text.length && /[0-9]/.test(text[index] ?? '')) index += 1;
        if (start === index) fail("expected an index or a quoted key after '['");
        const digits = text.slice(start, index);
        if (digits.length > 1 && digits.startsWith('0')) fail('indexes have no leading zeros');
        segments.push(Number.parseInt(digits, 10));
      }
      if (text[index] !== ']') fail("expected ']'");
      index += 1;
    } else {
      fail(`unexpected '${String(char)}'`);
    }
    if (segments.length > EXPRESSION_LIMITS.segments) fail(`more than ${EXPRESSION_LIMITS.segments} segments`);
  }
  for (const segment of segments) {
    if (typeof segment === 'string' && FORBIDDEN_KEYS.has(segment)) fail(`'${segment}' cannot be used in a path`);
  }
  return { root: root as ExpressionRoot, segments, source: text };
}

/** Splits a template into text and `{{ path }}` parts. Throws ExpressionError. */
export function parseTemplate(template: string): ParsedTemplate {
  if (template.length > EXPRESSION_LIMITS.templateLength) {
    throw new ExpressionError(`template is longer than ${EXPRESSION_LIMITS.templateLength} characters`);
  }
  const parts: TemplatePart[] = [];
  let text = '';
  let index = 0;
  let holes = 0;
  while (index < template.length) {
    const open = template.indexOf('{{', index);
    if (open < 0) {
      text += template.slice(index);
      break;
    }
    // '\{{' is a literal '{{' (for prompts that show template syntax).
    if (open > 0 && template[open - 1] === '\\') {
      text += `${template.slice(index, open - 1)}{{`;
      index = open + 2;
      continue;
    }
    const close = template.indexOf('}}', open + 2);
    if (close < 0) throw new ExpressionError("'{{' without '}}' (write '\\{{' for a literal '{{')", open);
    const inner = template.slice(open + 2, close);
    if (inner.includes('{{')) throw new ExpressionError("nested '{{'", open);
    text += template.slice(index, open);
    if (text !== '') parts.push(text);
    text = '';
    parts.push(parsePath(inner, open + 2));
    holes += 1;
    if (holes > EXPRESSION_LIMITS.holes) throw new ExpressionError(`more than ${EXPRESSION_LIMITS.holes} expressions`, open);
    index = close + 2;
  }
  if (text !== '') parts.push(text);
  return { parts };
}

/** True when the template is exactly one `{{ path }}` (surrounding whitespace allowed). */
export function singleExpression(parsed: ParsedTemplate): PathExpression | undefined {
  const meaningful = parsed.parts.filter((part) => typeof part !== 'string' || part.trim() !== '');
  const [only] = meaningful;
  return meaningful.length === 1 && only !== undefined && typeof only !== 'string' ? only : undefined;
}

export type ExpressionContext = Readonly<Partial<Record<ExpressionRoot, unknown>>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Reads a path. Missing values are `undefined` (never an error).
 * Arrays also answer `first`, `last` and `length`/`count`. Only own properties of plain objects are read.
 */
export function evaluatePath(path: PathExpression, context: ExpressionContext): unknown {
  let current: unknown = Object.hasOwn(context, path.root) ? context[path.root] : undefined;
  for (const segment of path.segments) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      if (typeof segment === 'number') current = segment < current.length ? (current[segment] as unknown) : undefined;
      else if (segment === 'first') current = current[0] as unknown;
      else if (segment === 'last') current = current.at(-1) as unknown;
      else if (segment === 'length' || segment === 'count') current = current.length;
      else return undefined;
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    const key = String(segment);
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** How a value is written into text: strings as is, missing as '', everything else as JSON. */
export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(parsed: ParsedTemplate, context: ExpressionContext): string {
  return parsed.parts.map((part) => (typeof part === 'string' ? part : stringifyValue(evaluatePath(part, context)))).join('');
}

/** A template that is exactly one expression yields the raw value (arrays, objects, numbers); otherwise text. */
export function resolveTemplateValue(parsed: ParsedTemplate, context: ExpressionContext): unknown {
  const only = singleExpression(parsed);
  return only === undefined ? renderTemplate(parsed, context) : evaluatePath(only, context);
}

/** Node ids referenced as `nodes.<id>` (for save-time checks). */
export function referencedNodes(expressions: Iterable<PathExpression>): Set<string> {
  const ids = new Set<string>();
  for (const expression of expressions) {
    const [first] = expression.segments;
    if (expression.root === 'nodes' && typeof first === 'string') ids.add(first);
  }
  return ids;
}

export function templateExpressions(parsed: ParsedTemplate): PathExpression[] {
  return parsed.parts.filter((part): part is PathExpression => typeof part !== 'string');
}

// ---------------------------------------------------------------------------
// Conditions

export type Operand = { readonly path: string } | { readonly value: unknown };

export const COMPARISON_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains'] as const;
export const UNARY_OPS = ['exists', 'empty'] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];
export type UnaryOp = (typeof UNARY_OPS)[number];

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly op: ComparisonOp; readonly left: Operand; readonly right: Operand }
  | { readonly op: UnaryOp; readonly left: Operand };

export interface ConditionIssue {
  readonly path: string;
  readonly message: string;
}

/** A condition with its paths parsed. Built by `compileCondition`. */
export type CompiledCondition =
  | { readonly kind: 'all' | 'any'; readonly children: readonly CompiledCondition[] }
  | { readonly kind: 'not'; readonly child: CompiledCondition }
  | { readonly kind: 'compare'; readonly op: ComparisonOp; readonly left: CompiledOperand; readonly right: CompiledOperand }
  | { readonly kind: 'unary'; readonly op: UnaryOp; readonly left: CompiledOperand };

type CompiledOperand = { readonly path: PathExpression } | { readonly value: unknown };

/**
 * Checks a condition's shape and parses its paths. Unknown keys, unknown operators, non-JSON values,
 * too deep or too large trees are all issues. Returns the compiled tree only when there are none.
 */
export function compileCondition(condition: unknown): { condition?: CompiledCondition; issues: ConditionIssue[]; paths: PathExpression[] } {
  const issues: ConditionIssue[] = [];
  const paths: PathExpression[] = [];
  let count = 0;
  // Checking stops at the first limit hit (or after enough issues), so a huge input costs little.
  const state = { stopped: false };
  // A function, so the check is not narrowed away between calls that may set it.
  const halted = (): boolean => state.stopped;
  const literalBudget: { values: number } = { values: EXPRESSION_LIMITS.conditionLiteralValues };
  const report = (issue: ConditionIssue): void => {
    issues.push(issue);
    if (issues.length >= EXPRESSION_LIMITS.conditionIssues) state.stopped = true;
  };

  const operand = (value: unknown, at: string): CompiledOperand | undefined => {
    if (!isPlainObject(value)) {
      report({ path: at, message: 'operand must be {path} or {value}' });
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'path' && typeof value.path === 'string') {
      try {
        const parsed = parsePath(value.path);
        paths.push(parsed);
        return { path: parsed };
      } catch (error) {
        report({ path: `${at}/path`, message: (error as Error).message });
        return undefined;
      }
    }
    if (keys.length === 1 && keys[0] === 'value') {
      if (!isJsonValue(value.value, 0, literalBudget)) {
        if (literalBudget.values < 0) {
          report({ path: `${at}/value`, message: `literals hold more than ${EXPRESSION_LIMITS.conditionLiteralValues} values` });
          state.stopped = true;
        } else {
          report({ path: `${at}/value`, message: 'value must be plain JSON (strings up to 65536 characters)' });
        }
        return undefined;
      }
      return { value: value.value };
    }
    report({ path: at, message: 'operand must have exactly one of path or value' });
    return undefined;
  };

  const visit = (node: unknown, at: string, depth: number): CompiledCondition | undefined => {
    if (halted()) return undefined;
    count += 1;
    if (count > EXPRESSION_LIMITS.conditionNodes) {
      report({ path: at, message: `more than ${EXPRESSION_LIMITS.conditionNodes} condition nodes` });
      state.stopped = true;
      return undefined;
    }
    if (depth > EXPRESSION_LIMITS.conditionDepth) {
      report({ path: at, message: `deeper than ${EXPRESSION_LIMITS.conditionDepth}` });
      return undefined;
    }
    if (!isPlainObject(node)) {
      report({ path: at, message: 'condition must be an object' });
      return undefined;
    }
    const keys = Object.keys(node).sort();
    const only = (...allowed: string[]): boolean => {
      const extra = keys.filter((key) => !allowed.includes(key));
      if (extra.length > 0) report({ path: at, message: `unknown keys: ${extra.join(', ')}` });
      return extra.length === 0;
    };
    if ('all' in node || 'any' in node) {
      const kind = 'all' in node ? 'all' : 'any';
      if (!only(kind)) return undefined;
      const list = node[kind];
      if (!Array.isArray(list) || list.length === 0) {
        report({ path: `${at}/${kind}`, message: 'must be a non-empty array' });
        return undefined;
      }
      const children: CompiledCondition[] = [];
      let complete = true;
      for (const [index, child] of (list as unknown[]).entries()) {
        if (halted()) return undefined;
        const compiled = visit(child, `${at}/${kind}/${index}`, depth + 1);
        if (compiled === undefined) complete = false;
        else children.push(compiled);
      }
      return complete ? { kind, children } : undefined;
    }
    if ('not' in node) {
      if (!only('not')) return undefined;
      const child = visit(node.not, `${at}/not`, depth + 1);
      return child === undefined ? undefined : { kind: 'not', child };
    }
    if ('op' in node) {
      const op = node.op;
      if ((UNARY_OPS as readonly unknown[]).includes(op)) {
        if (!only('left', 'op')) return undefined;
        const left = operand(node.left, `${at}/left`);
        return left === undefined ? undefined : { kind: 'unary', op: op as UnaryOp, left };
      }
      if ((COMPARISON_OPS as readonly unknown[]).includes(op)) {
        if (!only('left', 'op', 'right')) return undefined;
        const left = operand(node.left, `${at}/left`);
        const right = operand(node.right, `${at}/right`);
        return left === undefined || right === undefined ? undefined : { kind: 'compare', op: op as ComparisonOp, left, right };
      }
      report({ path: `${at}/op`, message: `unknown operator '${String(op)}'` });
      return undefined;
    }
    report({ path: at, message: 'expected all, any, not or op' });
    return undefined;
  };

  const compiled = visit(condition, '', 0);
  return issues.length === 0 && compiled !== undefined ? { condition: compiled, issues, paths } : { issues, paths };
}

/** Plain JSON within the depth limit; `budget.values` counts down per value and stops the walk at zero. */
function isJsonValue(value: unknown, depth: number, budget: { values: number }): boolean {
  budget.values -= 1;
  if (budget.values < 0 || depth > EXPRESSION_LIMITS.conditionDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= EXPRESSION_LIMITS.conditionLiteralString;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1, budget));
  if (isPlainObject(value)) {
    return Object.entries(value).every(([key, item]) => !FORBIDDEN_KEYS.has(key) && isJsonValue(item, depth + 1, budget));
  }
  return false;
}

/** Structural equality of JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function operandValue(operand: CompiledOperand, context: ExpressionContext): unknown {
  return 'path' in operand ? evaluatePath(operand.path, context) : operand.value;
}

function ordered(a: unknown, b: unknown): [number | string, number | string] | undefined {
  if (typeof a === 'number' && typeof b === 'number') return [a, b];
  if (typeof a === 'string' && typeof b === 'string') return [a, b];
  return undefined;
}

/** Evaluates a compiled condition. No type coercion: comparing different types is false (except `ne`). */
export function evaluateCondition(condition: CompiledCondition, context: ExpressionContext): boolean {
  switch (condition.kind) {
    case 'all':
      return condition.children.every((child) => evaluateCondition(child, context));
    case 'any':
      return condition.children.some((child) => evaluateCondition(child, context));
    case 'not':
      return !evaluateCondition(condition.child, context);
    case 'unary': {
      const value = operandValue(condition.left, context);
      if (condition.op === 'exists') return value !== undefined && value !== null;
      if (value === undefined || value === null || value === '') return true;
      if (Array.isArray(value)) return value.length === 0;
      return isPlainObject(value) && Object.keys(value).length === 0;
    }
    case 'compare': {
      const left = operandValue(condition.left, context);
      const right = operandValue(condition.right, context);
      switch (condition.op) {
        case 'eq':
          return jsonEqual(left, right);
        case 'ne':
          return !jsonEqual(left, right);
        case 'in':
          return Array.isArray(right) && right.some((item) => jsonEqual(item, left));
        case 'contains':
          if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
          return Array.isArray(left) && left.some((item) => jsonEqual(item, right));
        default: {
          const pair = ordered(left, right);
          if (pair === undefined) return false;
          const [a, b] = pair;
          if (condition.op === 'lt') return a < b;
          if (condition.op === 'lte') return a <= b;
          if (condition.op === 'gt') return a > b;
          return a >= b;
        }
      }
    }
  }
}
