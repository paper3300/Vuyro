import { describe, expect, it } from 'vitest';
import {
  assertBundledRefs,
  COMMAND_CATALOG,
  COMMAND_ERRORS,
  COMMAND_TYPE_PATTERN,
  COMMAND_TYPES,
  CommandRequestSchema,
  CommandResponseSchema,
  EVENT_CATALOG,
  EVENT_TYPES,
  EventEnvelopeSchema,
  isAgentProvider,
  isAiPrincipal,
  isUuidV7,
  NodeRunOutputSchema,
  NodeTypeSpecSchema,
  principalKey,
  PROTOCOL_VERSION,
  RUN_TOKEN_PATTERN,
  SchemaReferenceError,
  SharedNodeSpecSchema,
  SchemaValidator,
  UnsupportedSchemaVersionError,
  upcastEventData,
  uuidV7Timestamp,
} from '../src/index.ts';

const validator = new SchemaValidator();
const ID = '0192f3a0-0000-7000-8000-000000000001';

describe('contracts basics', () => {
  it('exposes a positive protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('recognizes supported agent providers only', () => {
    expect(isAgentProvider('claude')).toBe(true);
    expect(isAgentProvider('codex')).toBe(true);
    expect(isAgentProvider('gpt')).toBe(false);
    expect(isAgentProvider(1)).toBe(false);
  });

  it('accepts lowercase UUIDv7 only and reads its timestamp', () => {
    expect(isUuidV7(ID)).toBe(true);
    expect(isUuidV7(ID.toUpperCase())).toBe(false);
    expect(isUuidV7('0192f3a0-0000-4000-8000-000000000001')).toBe(false); // v4
    expect(uuidV7Timestamp('0192f3a0-1234-7000-8000-000000000001')).toBe(0x0192f3a01234);
  });
});

describe('schemas compile under strict Ajv 2020-12', () => {
  it('compiles every command payload and result schema', () => {
    for (const type of COMMAND_TYPES) {
      const definition = COMMAND_CATALOG[type];
      expect(() => validator.compile(definition.payload), type).not.toThrow();
      expect(() => validator.compile(definition.result), type).not.toThrow();
    }
  });

  it('compiles every event schema and the envelopes', () => {
    for (const type of EVENT_TYPES) {
      expect(() => validator.compile(EVENT_CATALOG[type].schema), type).not.toThrow();
    }
    for (const schema of [
      EventEnvelopeSchema,
      CommandRequestSchema,
      CommandResponseSchema,
      NodeRunOutputSchema,
      NodeTypeSpecSchema,
      SharedNodeSpecSchema,
    ]) {
      expect(() => validator.compile(schema)).not.toThrow();
    }
  });
});

describe('remote $ref is forbidden', () => {
  it.each([
    'https://example.com/schema.json',
    'http://localhost/x',
    'file:///C:/schemas/x.json',
    'other.json#/defs/x',
    '//example.com/x',
  ])('rejects $ref %s', (ref) => {
    const schema = { type: 'object', properties: { a: { $ref: ref } } };
    expect(() => {
      assertBundledRefs(schema);
    }).toThrow(SchemaReferenceError);
    expect(() => validator.compile(schema)).toThrow(SchemaReferenceError);
  });

  it('rejects a remote $id and a foreign $schema dialect', () => {
    expect(() => {
      assertBundledRefs({ $id: 'https://example.com/a' });
    }).toThrow(SchemaReferenceError);
    expect(() => {
      assertBundledRefs({ $schema: 'http://json-schema.org/draft-07/schema#' });
    }).toThrow(SchemaReferenceError);
  });

  it('allows local refs and bundle ids', () => {
    const local = new SchemaValidator();
    local.addSchema({ $id: 'urn:vuyro:test:name', type: 'string', minLength: 1 });
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { n: { type: 'integer' } },
      properties: { a: { $ref: '#/$defs/n' }, b: { $ref: 'urn:vuyro:test:name' } },
    };
    expect(local.validate(schema, { a: 1, b: 'x' })).toEqual([]);
    expect(local.validate(schema, { a: 'no', b: '' }).map((issue) => issue.path)).toEqual(['/a', '/b']);
  });
});

describe('command envelope', () => {
  const base = { requestId: 'req-00000001', type: 'ticket.create', payload: {} };

  it('accepts a minimal request and rejects unknown envelope fields', () => {
    expect(validator.validate(CommandRequestSchema, base)).toEqual([]);
    const issues = validator.validate(CommandRequestSchema, { ...base, principal: { kind: 'human' } });
    expect(issues[0]?.message).toContain("'principal'");
  });

  it('does not let a caller declare its principal; context is limited to ticket and node', () => {
    expect(validator.validate(CommandRequestSchema, { ...base, context: { ticketId: ID, role: 'human' } })).not.toEqual([]);
    expect(validator.validate(CommandRequestSchema, { ...base, context: { ticketId: ID, nodeId: 'dev' } })).toEqual([]);
  });

  it('rejects malformed request ids and negative revisions', () => {
    expect(validator.validate(CommandRequestSchema, { ...base, requestId: 'short' })).not.toEqual([]);
    expect(validator.validate(CommandRequestSchema, { ...base, expectedRevision: -1 })).not.toEqual([]);
  });

  it('names every command <noun>.<verb> and keeps the run token format', () => {
    const pattern = new RegExp(COMMAND_TYPE_PATTERN);
    for (const type of COMMAND_TYPES) expect(pattern.test(type), type).toBe(true);
    expect(new RegExp(RUN_TOKEN_PATTERN).test(`vrt_${'A'.repeat(43)}`)).toBe(true);
  });
});

describe('command catalog invariants', () => {
  it('only permission.* commands are in the permission category, and all of them are', () => {
    for (const type of COMMAND_TYPES) {
      expect(COMMAND_CATALOG[type].category === 'permission', type).toBe(type.startsWith('permission.'));
    }
  });

  it('system-only commands are never open to node agents', () => {
    for (const type of COMMAND_TYPES) {
      const access: { nodeAgent: string; systemOnly?: boolean } = COMMAND_CATALOG[type].access;
      if (access.systemOnly === true) expect(access.nodeAgent, type).toBe('deny');
    }
  });

  it('node-agent commands carry ticketId and nodeId in the payload', () => {
    for (const type of COMMAND_TYPES) {
      const definition = COMMAND_CATALOG[type];
      if (definition.access.nodeAgent !== 'own-node') continue;
      const required = (definition.payload as { required?: string[] }).required ?? [];
      expect(required, type).toEqual(expect.arrayContaining(['ticketId', 'nodeId']));
    }
  });

  it('maps every error code to a distinct JSON-RPC code', () => {
    const codes = Object.values(COMMAND_ERRORS).map((entry) => entry.rpcCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('validates the permission.edit payload variants', () => {
    const schema = COMMAND_CATALOG['permission.edit'].payload;
    const rule = { subject: 'node.agent', scope: 'app', action: 'node.approve', target: '*', effect: 'ask' };
    expect(validator.validate(schema, { scope: 'app', rules: [rule] })).toEqual([]);
    expect(validator.validate(schema, { scope: 'project', projectId: ID, rules: [] })).toEqual([]);
    expect(validator.validate(schema, { scope: 'project', rules: [] })).not.toEqual([]);
  });

  it('requires at least one field to change in ticket.update', () => {
    const schema = COMMAND_CATALOG['ticket.update'].payload;
    expect(validator.validate(schema, { ticketId: ID })).not.toEqual([]);
    expect(validator.validate(schema, { ticketId: ID, title: 'x' })).toEqual([]);
  });
});

describe('principals', () => {
  it('treats agents and unverified local clients as AI, humans and the engine as not', () => {
    expect(isAiPrincipal({ kind: 'agent', role: 'node.agent', runId: ID })).toBe(true);
    expect(isAiPrincipal({ kind: 'unverified', client: 'cli' })).toBe(true);
    expect(isAiPrincipal({ kind: 'human', userId: 'local', via: 'ui' })).toBe(false);
    expect(isAiPrincipal({ kind: 'human', userId: 'local', via: 'cli' })).toBe(false);
    expect(isAiPrincipal({ kind: 'system', component: 'workflow' })).toBe(false);
  });

  it('keys node agents by run', () => {
    expect(principalKey({ kind: 'agent', role: 'node.agent', runId: ID })).toBe(`agent:node.agent:${ID}`);
    expect(principalKey({ kind: 'human', userId: 'local', via: 'ui' })).toBe('human:local');
  });
});

describe('handoff envelope', () => {
  const output = {
    schemaVersion: 1,
    port: 'done',
    items: [
      {
        data: { taskId: 't1', extra: { kept: true } },
        artifacts: { change: { kind: 'git', uri: 'repo:src/app.ts', version: 'abc123' } },
        summary: 'Implemented the editor.',
        lineage: [{ nodeId: 'plan', run: 1, item: 0 }],
      },
    ],
  };

  it('keeps data free-form but fixes the outer shape', () => {
    expect(validator.validate(NodeRunOutputSchema, output)).toEqual([]);
    expect(validator.validate(NodeRunOutputSchema, { ...output, cost: 1 })).not.toEqual([]);
    const badItem = { ...output, items: [{ data: {}, tokens: 5 }] };
    expect(validator.validate(NodeRunOutputSchema, badItem)).not.toEqual([]);
    const badSlot = { ...output, items: [{ data: {}, artifacts: { 'bad slot': { kind: 'git', uri: 'x' } } }] };
    expect(validator.validate(NodeRunOutputSchema, badSlot)).not.toEqual([]);
  });
});

describe('event schema versions', () => {
  const catalog = { 'thing.happened': { version: 3 } };
  const upcasters = {
    'thing.happened': {
      1: (data: unknown) => ({ ...(data as object), b: 0 }),
      2: (data: unknown) => ({ ...(data as object), c: 'x' }),
    },
  } as never;

  it('passes current-version data through', () => {
    expect(upcastEventData('ticket.created', 1, { a: 1 })).toEqual({ schemaVersion: 1, data: { a: 1 } });
  });

  it('upcasts step by step to the current version', () => {
    expect(upcastEventData('thing.happened', 1, { a: 1 }, { catalog, upcasters })).toEqual({
      schemaVersion: 3,
      data: { a: 1, b: 0, c: 'x' },
    });
  });

  it('fails closed on newer versions, unknown types and missing upcasters', () => {
    expect(() => upcastEventData('thing.happened', 4, {}, { catalog, upcasters })).toThrow(UnsupportedSchemaVersionError);
    expect(() => upcastEventData('nope.happened', 1, {})).toThrow(UnsupportedSchemaVersionError);
    expect(() => upcastEventData('thing.happened', 1, {}, { catalog, upcasters: {} })).toThrow(/missing upcaster/);
  });
});

describe('node type declarations (M4/M5 fields)', () => {
  const devNode = {
    type: 'vuyro.agent',
    version: 1,
    label: 'Dev',
    completion: 'agent',
    inputs: [{ name: 'in', label: 'Task', mode: 'each' }],
    outputs: [{ name: 'done', label: 'Done', artifacts: [{ slot: 'change', kinds: ['git', 'p4'] }] }],
    params: [{ name: 'prompt', label: 'Prompt', schema: { type: 'string' } }],
    reads: ['project:design/styleGuide', 'app:glossary'],
    writes: ['project:progress/*'],
    claims: [{ path: 'Source/Game/UI/**', mode: 'exclusive', release: 'nodeDone', ttl: '2h', onConflict: 'firstWins', pauseMode: 'boundary' }],
    extensions: { 'myteam.build': { anything: true } },
  };

  it('accepts BlackBoard reads/writes, start claims and plugin extensions', () => {
    expect(validator.validate(NodeTypeSpecSchema, devNode)).toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, completion: 'shared' })).toEqual([]);
  });

  it('still rejects unknown fields and malformed keys, claims and namespaces', () => {
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, blackboard: [] })).not.toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, reads: ['ticket:x'] })).not.toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, claims: [{ path: 'a', mode: 'lock' }] })).not.toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, claims: [{ path: 'a', mode: 'shared', ttl: '2 hours' }] })).not.toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...devNode, extensions: { 'Bad Name': 1 } })).not.toEqual([]);
  });

  it('describes a shared build node with batch trigger, protection and failure policy', () => {
    const build = {
      name: 'buildStation',
      label: 'Build station',
      node: { type: 'vuyro.script', version: 1, params: { command: 'build.bat' } },
      requestSchema: { type: 'object' },
      batchTrigger: { count: 3, window: '20m', afterPrevious: true, manual: true },
      maxConcurrent: 1,
      protect: [{ path: 'Source/**', mode: 'shared' }],
      onBatchFailure: 'blame',
      raiseBlamedPriority: true,
    };
    expect(validator.validate(SharedNodeSpecSchema, build)).toEqual([]);
    expect(validator.validate(SharedNodeSpecSchema, { ...build, batchTrigger: {} })).not.toEqual([]);
    expect(validator.validate(SharedNodeSpecSchema, { ...build, onBatchFailure: 'retry' })).not.toEqual([]);
  });
});
