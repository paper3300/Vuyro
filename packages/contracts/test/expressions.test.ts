import { describe, expect, it } from 'vitest';
import {
  compileCondition,
  type CompiledCondition,
  evaluateCondition,
  evaluatePath,
  ExpressionError,
  jsonEqual,
  parsePath,
  parseTemplate,
  referencedNodes,
  renderTemplate,
  resolveTemplateValue,
  templateExpressions,
} from '../src/index.ts';

const context = {
  input: { data: { title: 'Notepad', tags: ['a', 'b'], count: 3, 'odd key': 'x' }, summary: 'short', artifacts: { specDoc: { kind: 'file', uri: 'docs/spec.md' } } },
  nodes: { spec: { runs: [{ data: { v: 1 } }, { data: { v: 2 } }], data: { title: 'Spec' } } },
  params: { name: 'dev' },
  ticket: { title: 'Ticket' },
};

function compiled(condition: unknown): CompiledCondition {
  const result = compileCondition(condition);
  if (result.condition === undefined) throw new Error(JSON.stringify(result.issues));
  return result.condition;
}

describe('path expressions', () => {
  it('parses roots, names, indexes and quoted keys', () => {
    expect(parsePath(' nodes.spec.runs[1].data.v ')).toEqual({ root: 'nodes', segments: ['spec', 'runs', 1, 'data', 'v'], source: 'nodes.spec.runs[1].data.v' });
    expect(parsePath("input.data['odd key']").segments).toEqual(['data', 'odd key']);
    expect(parsePath('nodes.spec-review.data').segments).toEqual(['spec-review', 'data']);
  });

  it.each([
    ['', /empty/],
    ['process.env.SECRET', /unknown root/],
    ['input.data.__proto__', /cannot be used/],
    ['input.constructor', /cannot be used/],
    ["input['__proto__']", /cannot be used/],
    ['input.data[01]', /leading zeros/],
    ['input.data + 1', /unexpected/],
    ['input.data()', /unexpected/],
    ["input['a\\'b']", /escapes/],
    ['input.' + 'a.'.repeat(40) + 'b', /segments/],
  ])('rejects %j', (source, message) => {
    expect(() => parsePath(source)).toThrow(message);
  });

  it('reads own properties only, never prototypes or non-plain objects', () => {
    expect(evaluatePath(parsePath('input.data.title'), context)).toBe('Notepad');
    expect(evaluatePath(parsePath('nodes.spec.runs.last.data.v'), context)).toBe(2);
    expect(evaluatePath(parsePath('nodes.spec.runs.first.data.v'), context)).toBe(1);
    expect(evaluatePath(parsePath('input.data.tags.length'), context)).toBe(2);
    expect(evaluatePath(parsePath('input.data.tags[5]'), context)).toBeUndefined();
    expect(evaluatePath(parsePath('input.data.missing.deeper'), context)).toBeUndefined();
    expect(evaluatePath(parsePath('input.data.toString'), context)).toBeUndefined();
    expect(evaluatePath(parsePath('input.data.hasOwnProperty'), context)).toBeUndefined();
    expect(evaluatePath(parsePath('input.date.getTime'), { input: { date: new Date(0) } })).toBeUndefined();
    expect(evaluatePath(parsePath('input.map.size'), { input: { map: new Map() } })).toBeUndefined();
    class Holder {
      token = 'secret';
    }
    expect(evaluatePath(parsePath('input.token'), { input: new Holder() })).toBeUndefined();
    const inherited = Object.create({ secret: 1 }) as Record<string, unknown>;
    expect(evaluatePath(parsePath('input.secret'), { input: inherited })).toBeUndefined();
  });
});

describe('templates', () => {
  it('renders text with values; missing values are empty and objects are JSON', () => {
    const parsed = parseTemplate('Title: {{ input.data.title }} / {{input.missing}} / {{ input.data.count }} / {{ input.data.tags }}');
    expect(renderTemplate(parsed, context)).toBe('Title: Notepad /  / 3 / [\n  "a",\n  "b"\n]');
  });

  it('keeps the raw value when the template is a single expression', () => {
    expect(resolveTemplateValue(parseTemplate(' {{ input.data.tags }} '), context)).toEqual(['a', 'b']);
    expect(resolveTemplateValue(parseTemplate('{{ input.data.count }}!'), context)).toBe('3!');
  });

  it('treats \\{{ as a literal and stray }} as text', () => {
    expect(renderTemplate(parseTemplate('use \\{{ input.x }} and {a: {b}}'), context)).toBe('use {{ input.x }} and {a: {b}}');
  });

  it('rejects unclosed and nested braces', () => {
    expect(() => parseTemplate('{{ input.data')).toThrow(ExpressionError);
    expect(() => parseTemplate('{{ input {{ x }} }}')).toThrow(/nested/);
  });

  it('lists referenced nodes for save-time checks', () => {
    const parsed = parseTemplate('{{ nodes.spec.data }} {{ nodes.plan.item.data.scope }} {{ input.summary }}');
    expect([...referencedNodes(templateExpressions(parsed))]).toEqual(['spec', 'plan']);
  });
});

describe('conditions', () => {
  it('compares without coercion', () => {
    const ctx = { item: { data: { n: 3, s: '3', tags: ['x'], empty: '' } } };
    expect(evaluateCondition(compiled({ op: 'eq', left: { path: 'item.data.n' }, right: { value: 3 } }), ctx)).toBe(true);
    expect(evaluateCondition(compiled({ op: 'eq', left: { path: 'item.data.s' }, right: { value: 3 } }), ctx)).toBe(false);
    expect(evaluateCondition(compiled({ op: 'gt', left: { path: 'item.data.s' }, right: { value: 2 } }), ctx)).toBe(false);
    expect(evaluateCondition(compiled({ op: 'gte', left: { path: 'item.data.n' }, right: { value: 3 } }), ctx)).toBe(true);
    expect(evaluateCondition(compiled({ op: 'contains', left: { path: 'item.data.tags' }, right: { value: 'x' } }), ctx)).toBe(true);
    expect(evaluateCondition(compiled({ op: 'in', left: { path: 'item.data.n' }, right: { value: [1, 3] } }), ctx)).toBe(true);
    expect(evaluateCondition(compiled({ op: 'empty', left: { path: 'item.data.empty' } }), ctx)).toBe(true);
    expect(evaluateCondition(compiled({ op: 'exists', left: { path: 'item.data.nope' } }), ctx)).toBe(false);
    expect(
      evaluateCondition(
        compiled({ all: [{ not: { op: 'exists', left: { path: 'item.data.nope' } } }, { any: [{ op: 'lt', left: { path: 'item.data.n' }, right: { value: 1 } }, { op: 'ne', left: { value: 'a' }, right: { value: 'b' } }] }] }),
        ctx,
      ),
    ).toBe(true);
  });

  it.each([
    [{ op: 'matches', left: { value: 1 }, right: { value: 1 } }, /unknown operator/],
    [{ op: 'eq', left: { value: 1 } }, /operand/],
    [{ op: 'eq', left: { path: 'process.env' }, right: { value: 1 } }, /unknown root/],
    [{ op: 'eq', left: { path: 'item.x', value: 1 }, right: { value: 1 } }, /exactly one/],
    [{ all: [] }, /non-empty/],
    [{ all: [{ op: 'exists', left: { value: 1 } }], extra: true }, /unknown keys/],
    [JSON.parse('{"op":"eq","left":{"value":{"__proto__":1}},"right":{"value":1}}') as unknown, /plain JSON/],
    [{ op: 'eq', left: { value: Number.NaN }, right: { value: 1 } }, /plain JSON/],
    ['eq', /must be an object/],
  ])('rejects %j', (condition, message) => {
    const result = compileCondition(condition);
    expect(result.condition).toBeUndefined();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(message);
  });

  it('bounds depth and size', () => {
    let deep: unknown = { op: 'exists', left: { value: 1 } };
    for (let index = 0; index < 40; index++) deep = { not: deep };
    expect(compileCondition(deep).issues.some((issue) => /deeper/.test(issue.message))).toBe(true);
    const wide = { any: Array.from({ length: 600 }, () => ({ op: 'exists', left: { value: 1 } })) };
    expect(compileCondition(wide).issues.some((issue) => /more than/.test(issue.message))).toBe(true);
  });

  it('stops at the first limit instead of walking a huge input', () => {
    const huge = { any: Array.from({ length: 10_000 }, () => ({ op: 'exists', left: { value: 1 } })) };
    const result = compileCondition(huge);
    expect(result.condition).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    const noisy = { any: Array.from({ length: 400 }, () => ({ op: 'nope' })) };
    expect(compileCondition(noisy).issues.length).toBeLessThanOrEqual(50);
  });

  it('bounds literal size', () => {
    const big = compileCondition({ op: 'in', left: { path: 'item.x' }, right: { value: Array.from({ length: 20_000 }, (_, index) => index) } });
    expect(big.condition).toBeUndefined();
    expect(big.issues.map((issue) => issue.message).join(' ')).toMatch(/more than 10000 values/);
    const long = compileCondition({ op: 'eq', left: { path: 'item.x' }, right: { value: 'x'.repeat(70_000) } });
    expect(long.condition).toBeUndefined();
    expect(compileCondition({ op: 'eq', left: { path: 'item.x' }, right: { value: 'x'.repeat(100) } }).condition).toBeDefined();
  });

  it('compares JSON structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
  });
});
