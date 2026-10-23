import type { TSchema } from '@sinclair/typebox';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Contract schemas may only reference schemas inside the same bundle. */
const BUNDLE_ID_PREFIX = 'urn:vuyro:';

export interface ValidationIssue {
  /** JSON Pointer into the validated value ('' is the root). */
  readonly path: string;
  readonly message: string;
}

export class SchemaReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaReferenceError';
  }
}

/**
 * Throws if the schema points outside its own bundle.
 * Allowed: local refs ('#…', '#/$defs/x') and ids in the `urn:vuyro:` namespace registered on the same validator.
 * Anything with another URI scheme (http, https, file, …) or a relative path is rejected before Ajv sees it.
 */
export function assertBundledRefs(schema: unknown): void {
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${path}/${index}`);
      });
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === '$ref' || key === '$dynamicRef' || key === '$id' || key === '$schema') && typeof value === 'string') {
        checkReference(key, value, `${path}/${key}`);
      }
      visit(value, `${path}/${key}`);
    }
  };
  visit(schema, '');
}

function checkReference(key: string, value: string, path: string): void {
  if (key === '$schema') {
    if (value !== JSON_SCHEMA_DIALECT) throw new SchemaReferenceError(`${path}: only the 2020-12 dialect is allowed`);
    return;
  }
  if (value.startsWith('#')) return;
  if (value.startsWith(BUNDLE_ID_PREFIX)) return;
  throw new SchemaReferenceError(`${path}: '${value}' points outside the bundle (use '#…' or '${BUNDLE_ID_PREFIX}…')`);
}

/**
 * A JSON Schema 2020-12 validator with no network or file access.
 * Ajv is created without `loadSchema`, and every schema is checked with `assertBundledRefs` first.
 */
export class SchemaValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new WeakMap<object, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  }

  /** Registers a schema with an `urn:vuyro:` `$id` so other schemas can reference it. */
  addSchema(schema: TSchema | Record<string, unknown>): void {
    assertBundledRefs(schema);
    this.ajv.addSchema(schema);
  }

  validate(schema: TSchema | Record<string, unknown>, value: unknown): ValidationIssue[] {
    const validateFn = this.compile(schema);
    if (validateFn(value)) return [];
    return toIssues(validateFn.errors ?? []);
  }

  compile(schema: TSchema | Record<string, unknown>): ValidateFunction {
    let validateFn = this.cache.get(schema);
    if (validateFn === undefined) {
      assertBundledRefs(schema);
      validateFn = this.ajv.compile(schema);
      this.cache.set(schema, validateFn);
    }
    return validateFn;
  }
}

function toIssues(errors: readonly ErrorObject[]): ValidationIssue[] {
  return errors.map((error) => {
    const extra =
      error.keyword === 'additionalProperties'
        ? ` ('${String((error.params as { additionalProperty?: unknown }).additionalProperty)}')`
        : '';
    return { path: error.instancePath, message: `${error.message ?? error.keyword}${extra}` };
  });
}
