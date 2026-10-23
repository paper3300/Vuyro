import {
  AGENT_PROVIDERS,
  type ArtifactSlotSpec,
  type CompiledCondition,
  compileCondition,
  ExpressionError,
  type ExpressionRoot,
  type NodeTypeSpec,
  nodeTypeKey,
  type ParsedTemplate,
  parseTemplate,
  type PathExpression,
  referencedNodes,
  SchemaReferenceError,
  type SchemaValidator,
  type TemplateEdge,
  type TemplateNode,
  type TemplateSpec,
  templateExpressions,
} from '@vuyro/contracts';
import { parseDuration } from './duration.ts';

/**
 * Save-time checks and the executable form of node types and templates.
 * Everything that can be checked before a ticket runs is checked here, so the engine never meets a
 * broken expression, a dangling edge or an unknown port in the middle of a ticket.
 */

export interface DefinitionIssue {
  /** JSON Pointer into the definition content. */
  readonly path: string;
  readonly message: string;
}

export class DefinitionError extends Error {
  readonly issues: readonly DefinitionIssue[];

  constructor(message: string, issues: readonly DefinitionIssue[]) {
    super(`${message}: ${issues.map((issue) => `${issue.path || '/'} ${issue.message}`).join('; ')}`);
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}

export interface CompiledPort {
  readonly name: string;
  readonly label: string;
  readonly mode: 'whole' | 'each';
  /** Type schema extended by the template instance (allOf), wrapped for strict ports. */
  readonly schema?: Record<string, unknown>;
  readonly strict: boolean;
  readonly artifacts: readonly ArtifactSlotSpec[];
  /** Top-level data fields the schemas declare (for "undeclared field" marking). */
  readonly declared: ReadonlySet<string>;
  /** False when a schema allows any field name (patternProperties, additionalProperties schema). */
  readonly closedWorld: boolean;
}

export interface CompiledScript {
  readonly program: ParsedTemplate;
  readonly args: readonly ParsedTemplate[];
  readonly env: readonly (readonly [string, ParsedTemplate])[];
  readonly cwd?: ParsedTemplate;
  readonly timeoutMs: number;
  readonly exitPorts: Readonly<Record<string, string>>;
  readonly output: 'none' | 'json';
}

export interface CompiledNodeType {
  readonly key: string;
  readonly spec: NodeTypeSpec;
  readonly prompt?: ParsedTemplate;
  readonly script?: CompiledScript;
}

export interface CompiledNode {
  readonly id: string;
  readonly label: string;
  readonly instance: TemplateNode;
  readonly type: CompiledNodeType;
  readonly completion: NodeTypeSpec['completion'];
  readonly review: 'none' | 'human';
  /** Param values after defaults. Strings are templates (see `paramTemplates`). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly paramTemplates: ReadonlyMap<string, ParsedTemplate>;
  readonly inputs: readonly CompiledPort[];
  readonly outputs: ReadonlyMap<string, CompiledPort>;
  /** Edge indexes into this node, and out of it by port. */
  readonly incoming: readonly number[];
  readonly outgoing: ReadonlyMap<string, readonly number[]>;
}

export interface CompiledEdge {
  readonly index: number;
  readonly edge: TemplateEdge;
  readonly when?: CompiledCondition;
  /**
   * True for an edge that goes back to a node upstream of its source (a loop: approval reject → spec,
   * QA reject → dev). What arrives over it is rework of the target, not new input.
   */
  readonly back: boolean;
}

export interface CompiledWorkflow {
  readonly template: TemplateSpec;
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  readonly edges: readonly CompiledEdge[];
  /** Nodes without incoming edges; activated when the ticket is created. */
  readonly entries: readonly string[];
  /** Nodes without output ports; the ticket is done when one of them finished and nothing else is active. */
  readonly ends: readonly string[];
  readonly warnings: readonly DefinitionIssue[];
}

/** Roots usable in prompts, params and script fields. `params` is not available inside params. */
const RUN_ROOTS: readonly ExpressionRoot[] = ['input', 'inputs', 'nodes', 'params', 'ticket', 'node', 'feedback'];
const PARAM_ROOTS: readonly ExpressionRoot[] = ['input', 'inputs', 'nodes', 'ticket', 'node', 'feedback'];
const EDGE_ROOTS: readonly ExpressionRoot[] = ['item', 'nodes', 'ticket', 'node'];

const DEFAULT_SCRIPT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_EXIT_PORTS = { '0': 'done', default: 'error' };

class Issues {
  readonly list: DefinitionIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }

  template(path: string, text: string, roots: readonly ExpressionRoot[]): ParsedTemplate | undefined {
    try {
      const parsed = parseTemplate(text);
      for (const expression of templateExpressions(parsed)) this.root(path, expression, roots);
      return parsed;
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      this.add(path, error.message);
      return undefined;
    }
  }

  root(path: string, expression: PathExpression, roots: readonly ExpressionRoot[]): void {
    if (!roots.includes(expression.root)) this.add(path, `'${expression.root}' is not available here (use ${roots.join(', ')})`);
  }

  schema(path: string, validator: SchemaValidator, schema: Record<string, unknown>): boolean {
    try {
      validator.compile(schema);
      return true;
    } catch (error) {
      this.add(path, error instanceof SchemaReferenceError ? error.message : `invalid JSON Schema: ${(error as Error).message}`);
      return false;
    }
  }
}

/** Validates a node type beyond its JSON Schema and prepares its templates. */
export function compileNodeType(spec: NodeTypeSpec, validator: SchemaValidator): { nodeType?: CompiledNodeType; issues: DefinitionIssue[] } {
  const issues = new Issues();
  const unique = (list: readonly { name: string }[], path: string): void => {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (seen.has(entry.name)) issues.add(`${path}/${index}/name`, `duplicate name '${entry.name}'`);
      seen.add(entry.name);
    });
  };
  unique(spec.inputs, '/inputs');
  unique(spec.outputs, '/outputs');
  unique(spec.params, '/params');
  spec.outputs.forEach((port, index) => {
    if (port.mode !== undefined) issues.add(`/outputs/${index}/mode`, 'mode applies to input ports only');
  });
  const ports = [...spec.inputs.map((port, index) => ({ port, at: `/inputs/${index}` })), ...spec.outputs.map((port, index) => ({ port, at: `/outputs/${index}` }))];
  for (const { port, at } of ports) {
    if (port.schema !== undefined) issues.schema(`${at}/schema`, validator, port.schema);
    const slots = new Set<string>();
    port.artifacts?.forEach((slot, index) => {
      if (slots.has(slot.slot)) issues.add(`${at}/artifacts/${index}/slot`, `duplicate slot '${slot.slot}'`);
      slots.add(slot.slot);
    });
  }
  spec.params.forEach((param, index) => {
    issues.schema(`/params/${index}/schema`, validator, param.schema);
  });

  let prompt: ParsedTemplate | undefined;
  let script: CompiledScript | undefined;
  switch (spec.completion) {
    case 'agent':
      if (spec.prompt === undefined) issues.add('/prompt', "agent nodes need a prompt template");
      else prompt = issues.template('/prompt', spec.prompt, RUN_ROOTS);
      if (spec.script !== undefined) issues.add('/script', 'only script nodes have a script');
      if (spec.outputs.length === 0) issues.add('/outputs', 'agent nodes need at least one output port');
      break;
    case 'script':
      if (spec.script === undefined) issues.add('/script', 'script nodes need a script');
      else {
        script = compileScript(spec.script, issues);
        for (const [code, port] of Object.entries(spec.script.exitPorts ?? DEFAULT_EXIT_PORTS)) {
          if (!spec.outputs.some((output) => output.name === port)) issues.add(`/script/exitPorts/${code}`, `no output port '${port}'`);
        }
      }
      if (spec.prompt !== undefined) issues.add('/prompt', 'only agent nodes have a prompt');
      if (spec.outputs.length === 0) issues.add('/outputs', 'script nodes need at least one output port');
      break;
    case 'human':
    case 'join':
      if (spec.prompt !== undefined) issues.add('/prompt', 'only agent nodes have a prompt');
      if (spec.script !== undefined) issues.add('/script', 'only script nodes have a script');
      if (spec.completion === 'join' && spec.outputs.length > 0 && !spec.outputs.some((port) => port.name === 'done')) {
        issues.add('/outputs', "join nodes finish through a 'done' port");
      }
      break;
    case 'shared':
      // Fail closed: an engine that cannot run shared nodes must not accept a definition that needs them.
      issues.add('/completion', "'shared' nodes are not supported by this engine yet (M5)");
      break;
  }
  if (issues.list.length > 0) return { issues: issues.list };
  return {
    nodeType: {
      key: nodeTypeKey(spec.type, spec.version),
      spec,
      ...(prompt === undefined ? {} : { prompt }),
      ...(script === undefined ? {} : { script }),
    },
    issues: [],
  };
}

function compileScript(spec: NonNullable<NodeTypeSpec['script']>, issues: Issues): CompiledScript | undefined {
  const program = issues.template('/script/program', spec.program, RUN_ROOTS);
  const args = (spec.args ?? []).map((arg, index) => issues.template(`/script/args/${index}`, arg, RUN_ROOTS));
  const env = Object.entries(spec.env ?? {}).map(([name, value]) => [name, issues.template(`/script/env/${name}`, value, RUN_ROOTS)] as const);
  const cwd = spec.cwd === undefined ? undefined : issues.template('/script/cwd', spec.cwd, RUN_ROOTS);
  const exitPorts = spec.exitPorts ?? DEFAULT_EXIT_PORTS;
  if (!Object.hasOwn(exitPorts, 'default')) issues.add('/script/exitPorts', "needs a 'default' entry");
  if (program === undefined || args.some((arg) => arg === undefined) || env.some(([, value]) => value === undefined)) return undefined;
  if (spec.cwd !== undefined && cwd === undefined) return undefined;
  return {
    program,
    args: args as ParsedTemplate[],
    env: env as (readonly [string, ParsedTemplate])[],
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: spec.timeout === undefined ? DEFAULT_SCRIPT_TIMEOUT_MS : parseDuration(spec.timeout),
    exitPorts,
    output: spec.output ?? 'none',
  };
}

/** Top-level property names a schema declares, and whether it allows other names at all. */
function declaredFields(schemas: readonly (Record<string, unknown> | undefined)[]): { declared: Set<string>; closedWorld: boolean } {
  const declared = new Set<string>();
  let closedWorld = true;
  for (const schema of schemas) {
    if (schema === undefined) continue;
    const properties = schema.properties;
    if (typeof properties === 'object' && properties !== null) for (const key of Object.keys(properties)) declared.add(key);
    if (schema.patternProperties !== undefined) closedWorld = false;
    const additional = schema.additionalProperties;
    if (typeof additional === 'object' && additional !== null) closedWorld = false;
  }
  return { declared, closedWorld };
}

function combineSchema(base: Record<string, unknown> | undefined, extension: Record<string, unknown> | undefined, strict: boolean) {
  const parts = [base, extension].filter((part): part is Record<string, unknown> => part !== undefined);
  if (parts.length === 0 && !strict) return undefined;
  if (strict) return { allOf: parts.length === 0 ? [{ type: 'object' }] : parts, unevaluatedProperties: false };
  return parts.length === 1 ? parts[0] : { allOf: parts };
}

function compilePorts(
  node: TemplateNode,
  spec: NodeTypeSpec,
  validator: SchemaValidator,
  at: string,
  issues: Issues,
): { inputs: CompiledPort[]; outputs: Map<string, CompiledPort> } {
  const overrides = node.ports ?? {};
  const known = new Set([...spec.inputs.map((port) => port.name), ...spec.outputs.map((port) => port.name)]);
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) issues.add(`${at}/ports/${name}`, `node type ${spec.type}@${spec.version} has no port '${name}'`);
  }
  const build = (port: NodeTypeSpec['inputs'][number], input: boolean): CompiledPort => {
    const override = Object.hasOwn(overrides, port.name) ? overrides[port.name] : undefined;
    if (!input && override?.mode !== undefined) issues.add(`${at}/ports/${port.name}/mode`, 'mode applies to input ports only');
    if (override?.schema !== undefined) issues.schema(`${at}/ports/${port.name}/schema`, validator, override.schema);
    const strict = override?.strict ?? port.strict ?? false;
    const schema = combineSchema(port.schema, override?.schema, strict);
    const { declared, closedWorld } = declaredFields([port.schema, override?.schema]);
    return {
      name: port.name,
      label: port.label,
      mode: input ? (override?.mode ?? port.mode ?? 'whole') : 'whole',
      ...(schema === undefined ? {} : { schema }),
      strict,
      artifacts: [
        ...(port.artifacts ?? []).filter((slot) => !(override?.artifacts ?? []).some((extra) => extra.slot === slot.slot)),
        ...(override?.artifacts ?? []),
      ],
      declared,
      closedWorld,
    };
  };
  return {
    inputs: spec.inputs.map((port) => build(port, true)),
    outputs: new Map(spec.outputs.map((port) => [port.name, build(port, false)])),
  };
}

function compileParams(
  node: TemplateNode,
  spec: NodeTypeSpec,
  validator: SchemaValidator,
  at: string,
  issues: Issues,
): { params: Record<string, unknown>; templates: Map<string, ParsedTemplate>; expressions: PathExpression[] } {
  const given = node.params ?? {};
  const params: Record<string, unknown> = {};
  const templates = new Map<string, ParsedTemplate>();
  const expressions: PathExpression[] = [];
  const declared = new Set(spec.params.map((param) => param.name));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) issues.add(`${at}/params/${name}`, `node type ${spec.type}@${spec.version} has no param '${name}'`);
  }
  for (const param of spec.params) {
    const value = Object.hasOwn(given, param.name) ? given[param.name] : param.schema.default;
    if (value === undefined) {
      if (param.required === true) issues.add(`${at}/params/${param.name}`, 'required');
      continue;
    }
    try {
      for (const issue of validator.validate(param.schema, value)) issues.add(`${at}/params/${param.name}${issue.path}`, issue.message);
    } catch {
      // The schema itself is broken; compileNodeType reported it.
    }
    params[param.name] = value;
    if (typeof value === 'string') {
      const parsed = issues.template(`${at}/params/${param.name}`, value, PARAM_ROOTS);
      if (parsed !== undefined) {
        templates.set(param.name, parsed);
        expressions.push(...templateExpressions(parsed));
      }
    }
  }
  return { params, templates, expressions };
}

/**
 * Checks a template against its node types and builds the graph the engine runs.
 * `nodeTypes` maps 'type@version' to the compiled node type.
 */
export function compileWorkflow(
  template: TemplateSpec,
  nodeTypes: ReadonlyMap<string, CompiledNodeType>,
  validator: SchemaValidator,
): { workflow?: CompiledWorkflow; issues: DefinitionIssue[] } {
  const issues = new Issues();
  const warnings: DefinitionIssue[] = [];
  const ids = new Set<string>();
  template.nodes.forEach((node, index) => {
    if (ids.has(node.id)) issues.add(`/nodes/${index}/id`, `duplicate node id '${node.id}'`);
    ids.add(node.id);
  });

  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, Map<string, number[]>>();
  const drafts = new Map<
    string,
    { node: TemplateNode; type: CompiledNodeType; ports: ReturnType<typeof compilePorts>; params: ReturnType<typeof compileParams> }
  >();
  const expressionsByNode = new Map<string, PathExpression[]>();

  template.nodes.forEach((node, index) => {
    const at = `/nodes/${index}`;
    const type = nodeTypes.get(nodeTypeKey(node.type, node.version));
    if (type === undefined) {
      issues.add(`${at}/type`, `node type ${node.type}@${node.version} is not available`);
      return;
    }
    const ports = compilePorts(node, type.spec, validator, at, issues);
    const params = compileParams(node, type.spec, validator, at, issues);
    if (type.spec.completion === 'agent') {
      const provider = params.params.provider;
      if (provider !== undefined && !(AGENT_PROVIDERS as readonly unknown[]).includes(provider)) {
        issues.add(`${at}/params/provider`, `unknown agent provider ${JSON.stringify(provider)}`);
      }
    }
    if (node.review === 'human' && (type.spec.completion === 'human' || type.spec.completion === 'join')) {
      issues.add(`${at}/review`, `a review gate applies to agent and script nodes, not ${type.spec.completion} nodes`);
    }
    drafts.set(node.id, { node, type, ports, params });
    const expressions = [...params.expressions];
    if (type.prompt !== undefined) expressions.push(...templateExpressions(type.prompt));
    if (type.script !== undefined) {
      const { script } = type;
      for (const parsed of [script.program, ...script.args, ...script.env.map(([, value]) => value), ...(script.cwd === undefined ? [] : [script.cwd])]) {
        expressions.push(...templateExpressions(parsed));
      }
    }
    expressionsByNode.set(node.id, expressions);
    incoming.set(node.id, []);
    outgoing.set(node.id, new Map());
  });

  const edges: CompiledEdge[] = [];
  const edgeKeys = new Set<string>();
  template.edges.forEach((edge, index) => {
    const at = `/edges/${index}`;
    const from = drafts.get(edge.from.node);
    const to = drafts.get(edge.to.node);
    if (!ids.has(edge.from.node)) issues.add(`${at}/from/node`, `no node '${edge.from.node}'`);
    if (!ids.has(edge.to.node)) issues.add(`${at}/to/node`, `no node '${edge.to.node}'`);
    if (from !== undefined && !from.ports.outputs.has(edge.from.port)) {
      issues.add(`${at}/from/port`, `node '${edge.from.node}' has no output port '${edge.from.port}'`);
    }
    if (to !== undefined && !to.ports.inputs.some((port) => port.name === edge.to.port)) {
      issues.add(`${at}/to/port`, `node '${edge.to.node}' has no input port '${edge.to.port}'`);
    }
    const key = `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`;
    if (edgeKeys.has(key)) issues.add(at, 'duplicate edge');
    edgeKeys.add(key);
    let when: CompiledCondition | undefined;
    if (edge.when !== undefined) {
      const compiled = compileCondition(edge.when);
      for (const issue of compiled.issues) issues.add(`${at}/when${issue.path}`, issue.message);
      for (const path of compiled.paths) issues.root(`${at}/when`, path, EDGE_ROOTS);
      for (const id of referencedNodes(compiled.paths)) if (!ids.has(id)) issues.add(`${at}/when`, `no node '${id}'`);
      when = compiled.condition;
    }
    edges.push({ index, edge, back: false, ...(when === undefined ? {} : { when }) });
    incoming.get(edge.to.node)?.push(index);
    const byPort = outgoing.get(edge.from.node);
    if (byPort !== undefined) byPort.set(edge.from.port, [...(byPort.get(edge.from.port) ?? []), index]);
  });

  for (const [nodeId, expressions] of expressionsByNode) {
    for (const id of referencedNodes(expressions)) {
      if (!ids.has(id)) issues.add(`/nodes/${template.nodes.findIndex((node) => node.id === nodeId)}`, `expression refers to unknown node '${id}'`);
    }
  }

  const entries = template.nodes.filter((node) => (incoming.get(node.id)?.length ?? 0) === 0).map((node) => node.id);
  const ends = template.nodes.filter((node) => drafts.get(node.id)?.ports.outputs.size === 0).map((node) => node.id);
  if (entries.length === 0) issues.add('/nodes', 'no entry node (every node has an incoming edge)');
  if (ends.length === 0) issues.add('/nodes', 'no end node (a node without output ports)');
  for (const id of entries) {
    const draft = drafts.get(id);
    if (draft?.type.spec.completion === 'join') issues.add('/nodes', `entry node '${id}' is a join; it would finish with no input`);
  }

  // Unreachable nodes are almost always a mistake, but not an error.
  const reachable = new Set(entries);
  const stack = [...entries];
  while (stack.length > 0) {
    const id = stack.pop() ?? '';
    for (const indexes of outgoing.get(id)?.values() ?? []) {
      for (const index of indexes) {
        const target = template.edges[index]?.to.node;
        if (target !== undefined && !reachable.has(target)) {
          reachable.add(target);
          stack.push(target);
        }
      }
    }
  }
  template.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) warnings.push({ path: `/nodes/${index}`, message: `node '${node.id}' cannot be reached from an entry node` });
  });

  if (issues.list.length > 0) return { issues: issues.list };

  const back = backEdges(template, entries, outgoing);
  const marked = edges.map((edge) => (back.has(edge.index) ? { ...edge, back: true } : edge));

  const nodes = new Map<string, CompiledNode>();
  for (const [id, draft] of drafts) {
    nodes.set(id, {
      id,
      label: draft.node.label ?? draft.type.spec.label,
      instance: draft.node,
      type: draft.type,
      completion: draft.type.spec.completion,
      review: draft.node.review ?? 'none',
      params: draft.params.params,
      paramTemplates: draft.params.templates,
      inputs: draft.ports.inputs,
      outputs: draft.ports.outputs,
      incoming: incoming.get(id) ?? [],
      outgoing: outgoing.get(id) ?? new Map(),
    });
  }
  return { workflow: { template, nodes, edges: marked, entries, ends, warnings }, issues: [] };
}

/** Edges that close a cycle in a depth-first walk from the entry nodes (then from any node not reached). */
function backEdges(template: TemplateSpec, entries: readonly string[], outgoing: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>): Set<number> {
  const back = new Set<number>();
  const state = new Map<string, 'open' | 'closed'>();
  const visit = (root: string): void => {
    const stack: { node: string; edges: number[] }[] = [];
    const enter = (node: string): void => {
      state.set(node, 'open');
      const list = [...(outgoing.get(node)?.values() ?? [])].flat().sort((a, b) => a - b);
      stack.push({ node, edges: list });
    };
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const index = top.edges.shift();
      if (index === undefined) {
        state.set(top.node, 'closed');
        stack.pop();
        continue;
      }
      const target = template.edges[index]?.to.node;
      if (target === undefined) continue;
      const seen = state.get(target);
      if (seen === 'open') back.add(index);
      else if (seen === undefined) enter(target);
    }
  };
  for (const entry of entries) if (!state.has(entry)) visit(entry);
  for (const node of template.nodes) if (!state.has(node.id)) visit(node.id);
  return back;
}
