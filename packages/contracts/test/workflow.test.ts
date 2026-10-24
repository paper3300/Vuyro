import { describe, expect, it } from 'vitest';
import {
  COMMAND_CATALOG,
  DefinitionEnvelopeSchema,
  definitionAggregateId,
  EVENT_CATALOG,
  NodeTypeSpecSchema,
  PinnedTemplateSchema,
  SchemaValidator,
  TemplateSpecSchema,
} from '../src/index.ts';

const validator = new SchemaValidator();

const nodeType = {
  type: 'vuyro.agent',
  version: 1,
  label: 'Agent',
  completion: 'agent',
  inputs: [{ name: 'in', label: 'Input' }],
  outputs: [{ name: 'done', label: 'Done' }],
  params: [],
  prompt: 'Do {{ input.summary }}',
};

const template = {
  id: 'vuyro/sample',
  version: 1,
  name: 'Sample',
  nodes: [
    { id: 'a', type: 'vuyro.agent', version: 1, ports: { in: { mode: 'each' } } },
    { id: 'b', type: 'vuyro.end', version: 1 },
  ],
  edges: [{ from: { node: 'a', port: 'done' }, to: { node: 'b', port: 'in' }, when: { op: 'exists', left: { path: 'item.data.x' } } }],
};

describe('workflow contracts', () => {
  it('compiles the template, envelope and pin schemas', () => {
    for (const schema of [TemplateSpecSchema, DefinitionEnvelopeSchema, PinnedTemplateSchema]) expect(() => validator.compile(schema)).not.toThrow();
  });

  it('accepts a node type with a prompt or a script and rejects unknown fields', () => {
    expect(validator.validate(NodeTypeSpecSchema, nodeType)).toEqual([]);
    expect(validator.validate(NodeTypeSpecSchema, { ...nodeType, promt: 'typo' })).not.toEqual([]);
    const base = Object.fromEntries(Object.entries(nodeType).filter(([key]) => key !== 'prompt'));
    const script = { ...base, completion: 'script', script: { program: 'git', args: ['status'], env: { GIT_DIR: '.git' } } };
    expect(validator.validate(NodeTypeSpecSchema, script)).toEqual([]);
  });

  it('reserves VUYRO_* environment names for the engine', () => {
    for (const name of ['VUYRO_RUN_TOKEN', 'vuyro_run_token', 'Vuyro_Ticket']) {
      const script = { ...nodeType, completion: 'script', script: { program: 'x', env: { [name]: 'steal' } } };
      expect(validator.validate(NodeTypeSpecSchema, script).some((issue) => issue.path.includes('/script/env')), name).toBe(true);
    }
    const allowed = { ...nodeType, completion: 'script', script: { program: 'x', env: { VUYROX: '1', MY_VUYRO_: '1' } } };
    expect(validator.validate(NodeTypeSpecSchema, allowed)).toEqual([]);
  });

  it('validates templates and definition envelopes', () => {
    expect(validator.validate(TemplateSpecSchema, template)).toEqual([]);
    expect(validator.validate(TemplateSpecSchema, { ...template, id: 'no-namespace' })).not.toEqual([]);
    expect(validator.validate(TemplateSpecSchema, { ...template, nodes: [] })).not.toEqual([]);
    const envelope = { vuyro: 'export', formatVersion: 1, kind: 'template', id: 'vuyro/sample', version: 1, name: 'Sample', content: template };
    expect(validator.validate(DefinitionEnvelopeSchema, envelope)).toEqual([]);
    expect(validator.validate(DefinitionEnvelopeSchema, { ...envelope, kind: 'nodeType' })).not.toEqual([]);
    expect(validator.validate(DefinitionEnvelopeSchema, { ...envelope, secret: 'x' })).not.toEqual([]);
  });

  it('maps definition ids to aggregate ids without collisions', () => {
    expect(definitionAggregateId('template', 'vuyro/ai-sdlc')).toBe('def:template:vuyro:ai-sdlc');
    expect(definitionAggregateId('nodeType', 'vuyro.agent')).toBe('def:nodeType:vuyro.agent');
  });

  it('keeps lanes to main or positive numbers', () => {
    const schema = EVENT_CATALOG['node.resumed'].schema;
    const base = { ticketId: '0192f3a0-0000-7000-8000-000000000001', nodeId: 'dev', run: 1, status: 'queued' };
    expect(validator.validate(schema, { ...base, lane: 'main' })).toEqual([]);
    expect(validator.validate(schema, { ...base, lane: '12' })).toEqual([]);
    for (const lane of ['0', '01', 'x', '../1']) expect(validator.validate(schema, { ...base, lane })).not.toEqual([]);
  });

  it('opens node.done to node agents and keeps approvals and engine steps away from them', () => {
    expect(COMMAND_CATALOG['node.done'].access.nodeAgent).toBe('own-node');
    for (const type of ['node.approve', 'node.reject', 'node.retry', 'node.pause', 'node.resume', 'nodeType.save', 'template.save', 'definition.import'] as const) {
      expect(COMMAND_CATALOG[type].access.nodeAgent, type).toBe('deny');
    }
    for (const type of ['node.start', 'node.finish', 'definition.activate', 'definition.activateMany', 'definition.abandon'] as const) {
      expect(COMMAND_CATALOG[type].access, type).toEqual({ nodeAgent: 'deny', systemOnly: true });
    }
  });
});
