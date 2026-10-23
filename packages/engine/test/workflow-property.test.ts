import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import { endReached, ticketWaitReasons } from '../src/workflow/machine.ts';
import type { ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution, execution, nodeProgress } from '../src/workflow/state.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * Property test of the routing rules. Seeded random workflows (branches, done/error edges, joins, fan-out,
 * rejection loops) run with seeded random node results and random human decisions. After every drive:
 *
 * - an open ticket always has a wait reason (active work or an unhandled failure);
 * - once an end node finished, the ticket is done or a reason says why not;
 * - nothing waits for an executor slot while the engine is idle;
 * - the engine reports no unexpected errors.
 *
 * A failing case is shrunk (edges, then nodes removed while it still fails) and printed as a minimal counterexample.
 * PROPERTY_CASES and PROPERTY_SEED override the defaults.
 */

const CASES = Number(process.env.PROPERTY_CASES ?? 300);
const BASE_SEED = Number(process.env.PROPERTY_SEED ?? 20261024);
const MAX_STEPS = 40;

type Kind = 'agent' | 'each' | 'review' | 'join' | 'human';

interface Graph {
  readonly nodes: readonly { readonly id: string; readonly kind: Kind | 'end' }[];
  readonly edges: readonly { readonly from: string; readonly port: string; readonly to: string }[];
}

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const char of parts.join('|')) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}


function generate(seed: number): Graph {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const middle = 2 + Math.floor(random() * 5);
  const kinds: Kind[] = ['agent', ...Array.from({ length: middle }, () => pick<Kind>(['agent', 'agent', 'each', 'review', 'join', 'join', 'human']))];
  const nodes = [...kinds.map((kind, index) => ({ id: `n${index}`, kind })), { id: 'end', kind: 'end' as const }];
  const edges: { from: string; port: string; to: string }[] = [];
  const keys = new Set<string>();
  const add = (from: number, port: string, to: number): void => {
    const edge = { from: nodes[from]?.id ?? '', port, to: nodes[to]?.id ?? '' };
    const key = `${edge.from}.${port}>${edge.to}`;
    if (keys.has(key) || from === to) return;
    keys.add(key);
    edges.push(edge);
  };
  const last = nodes.length - 1;
  const later = (index: number): number => index + 1 + Math.floor(random() * (last - index));
  kinds.forEach((kind, index) => {
    const main = kind === 'review' ? 'approve' : 'done';
    // Now and then a node leads nowhere on its main port.
    if (index === 0 || random() > 0.1) add(index, main, later(index));
    if (random() < 0.3) add(index, main, later(index));
    if (kind !== 'join' && kind !== 'human' && random() < 0.5) add(index, 'error', later(index));
    if (kind === 'review') {
      if (index > 1 && random() < 0.7) add(index, 'reject', 1 + Math.floor(random() * (index - 1)));
      else add(index, 'reject', later(index));
    }
  });
  // Every node but the entry needs an incoming edge.
  for (let index = 1; index <= last; index++) {
    if (!edges.some((edge) => edge.to === nodes[index]?.id)) {
      const from = Math.floor(random() * index);
      add(from, kinds[from] === 'review' ? 'approve' : 'done', index);
    }
  }
  return { nodes, edges };
}

function toTemplate(graph: Graph, id: string): TemplateDefinition {
  const nodes: TemplateNode[] = graph.nodes.map(({ id: nodeId, kind }) => {
    switch (kind) {
      case 'agent':
        return { id: nodeId, type: 'vuyro.agent', version: 1, params: { instructions: nodeId } };
      case 'each':
        return { id: nodeId, type: 'vuyro.agent', version: 1, params: { instructions: nodeId }, ports: { in: { mode: 'each' } } };
      case 'review':
        return { id: nodeId, type: 'vuyro.review-agent', version: 1, params: { instructions: nodeId } };
      case 'join':
        return { id: nodeId, type: 'vuyro.join', version: 1 };
      case 'human':
        return { id: nodeId, type: 'vuyro.human-task', version: 1 };
      case 'end':
        return { id: nodeId, type: 'vuyro.end', version: 1 };
    }
  });
  const edges: TemplateEdge[] = graph.edges.map((edge) => ({ from: { node: edge.from, port: edge.port }, to: { node: edge.to, port: 'in' } }));
  return { vuyro: 'export', formatVersion: 1, kind: 'template', id, version: 1, name: id, content: { id, version: 1, name: id, nodes, edges } };
}

function describeGraph(graph: Graph): string {
  return [
    graph.nodes.map((node) => `${node.id}:${node.kind}`).join(' '),
    ...graph.edges.map((edge) => `  ${edge.from}.${edge.port} -> ${edge.to}`),
  ].join('\n');
}

interface CaseRun {
  readonly seed: number;
  readonly kinds: ReadonlyMap<string, Kind | 'end'>;
}

describe('routing properties', () => {
  let h: WorkflowHarness;
  const cases = new Map<string, CaseRun>();
  let templateCounter = 0;
  const stats = { invalid: 0, done: 0, open: 0, steps: 0, runs: 0 };

  /** Plays one agent run: the outcome is a pure function of the case seed and the run's identity. */
  async function behave(s: ScriptedSession): Promise<undefined> {
    const { ticketId, nodeId, run, lane } = s.request;
    const config = cases.get(ticketId);
    if (config === undefined) throw new Error('unknown ticket');
    const random = prng(hash(config.seed, nodeId, run, lane));
    const kind = config.kinds.get(nodeId);
    const state = await h.ticket(ticketId);
    const runs = nodeProgress(state, nodeId).executions.length;
    const inputs = Object.values(execution(state, nodeId, run)?.inputs ?? {}).flat().length;
    const done = (port: string, extra: Record<string, unknown>) => s.vuyro('node.done', { ticketId, nodeId, port, ...extra });
    const roll = random();
    if (kind === 'review') {
      if (runs > 4 || roll < 0.5) await done('approve', { data: { verdict: 'ok' } });
      else if (roll < 0.85) await done('reject', { items: [{ data: { feedback: 'again' }, ...(inputs > 0 && random() < 0.5 ? { pairedInput: 0 } : {}) }] });
      else await done('error', { data: { reason: 'review failed' } });
      return undefined;
    }
    if (runs > 6 || roll < 0.55) {
      const count = runs > 6 ? 1 : random() < 0.15 ? 0 : random() < 0.8 ? 1 : 2;
      await done('done', { items: Array.from({ length: count }, (_, index) => ({ data: { index } })) });
    } else if (roll < 0.75) {
      await done('error', { items: random() < 0.2 ? [] : [{ data: { reason: 'failed' } }] });
    } else if (roll < 0.9) {
      throw new Error('crashed');
    }
    // Otherwise the agent ends without reporting (the node fails).
    return undefined;
  }

  beforeAll(async () => {
    h = await openWorkflowHarness({ behavior: behave, maxConcurrent: 3 });
  });

  afterAll(async () => {
    await h.close();
  });

  /** Runs one case. Returns a failure description, or undefined when every property held. */
  let shrinking = false;
  async function runCase(seed: number, graph: Graph): Promise<string | undefined> {
    templateCounter += 1;
    const id = `myteam/p${templateCounter}`;
    const saved = await h.writer.save(toTemplate(graph, id), HUMAN, nextRequestId());
    if (!saved.ok) {
      stats.invalid += 1;
      return shrinking ? undefined : `generated template is not valid: ${saved.error.message} ${JSON.stringify(saved.error.details ?? {})}`;
    }
    const project = await h.ok('project.create', { name: 'property' });
    const ticket = await h.exec('ticket.create', { projectId: (project.result as { projectId: string }).projectId, title: `case ${seed}`, template: { id } });
    if (!ticket.ok) return `ticket.create failed: ${ticket.error.message}`;
    const ticketId = (ticket.result as { ticketId: string }).ticketId;
    cases.set(ticketId, { seed, kinds: new Map(graph.nodes.map((node) => [node.id, node.kind])) });
    const errorsBefore = h.errors.length;
    const decide = prng(hash(seed, 'human'));
    for (let step = 0; step < MAX_STEPS; step++) {
      try {
        await h.drive();
      } catch (error) {
        return `${(error as Error).message}\n${await describeTicket(ticketId)}`;
      }
      if (h.errors.length > errorsBefore) return `engine reported: ${h.errors.slice(errorsBefore).map((entry) => `${entry.context}: ${entry.error.message}`).join('; ')}`;
      stats.steps += 1;
      const state = await h.ticket(ticketId);
      if (state.status === 'done') {
        stats.done += 1;
        return undefined;
      }
      if (state.template === undefined) return 'no template';
      const workflow = await h.registry.workflow(state.template);
      const reasons = ticketWaitReasons(state, workflow);
      if (reasons.length === 0) return `open ticket without a wait reason (end reached: ${String(endReached(state, workflow))})\n${await describeTicket(ticketId)}`;
      const waiting = reasons.filter((reason) => reason.kind === 'active' && (reason.status === 'queued' || reason.status === 'running' || (reason.status === 'rejected' && workflow.nodes.get(reason.nodeId)?.completion !== 'human')));
      if (waiting.length > 0 && (h.engine?.running ?? 0) === 0) return `executions left waiting while the engine is idle: ${waiting.map((r) => `${r.nodeId}/${r.lane}:${r.status}`).join(', ')}`;
      // A person acts on something that waits for one.
      const actionable = reasons.filter((reason) => (reason.kind === 'active' && reason.status === 'review') || reason.kind === 'failed');
      const choice = actionable[Math.floor(decide() * actionable.length)];
      if (choice === undefined) {
        stats.open += 1;
        return undefined; // Waiting on something the test does not drive (fine: a reason exists).
      }
      let response;
      if (choice.kind === 'failed') {
        if (decide() < 0.3) {
          stats.open += 1;
          return undefined; // Leave the failure: the ticket stays open with a reason.
        }
        response = await h.exec('node.retry', { ticketId, nodeId: choice.nodeId, lane: choice.lane });
      } else if (workflow.nodes.get(choice.nodeId)?.completion === 'human') {
        const count = decide() < 0.2 ? 0 : decide() < 0.8 ? 1 : 2;
        response = await h.exec('node.done', { ticketId, nodeId: choice.nodeId, lane: choice.lane, port: 'done', items: Array.from({ length: count }, (_, index) => ({ data: { index } })) });
      } else {
        const exec = currentExecution(state, choice.nodeId, choice.lane);
        const type = exec?.output !== undefined && decide() < 0.35 ? 'node.reject' : 'node.approve';
        response = await h.exec(type, { ticketId, nodeId: choice.nodeId, lane: choice.lane, comment: 'decided by the test' });
      }
      if (!response.ok) return `human ${choice.kind} on ${choice.nodeId}/${choice.lane} failed: ${response.error.message}`;
    }
    // Check the state the last decision left behind too.
    try {
      await h.drive();
    } catch (error) {
      return (error as Error).message;
    }
    return undefined;
  }

  /** Every execution of the ticket: node, lane, run, cause, status, port, routes (for counterexamples). */
  async function describeTicket(ticketId: string): Promise<string> {
    const state = await h.ticket(ticketId);
    const lines = Object.entries(state.nodes).flatMap(([nodeId, progress]) =>
      progress.executions.map(
        (exec) =>
          `  ${nodeId}/${exec.lane} run ${exec.run} ${exec.cause} -> ${exec.status} port=${exec.output?.port ?? '-'} items=${exec.output?.items.length ?? '-'} routes=${JSON.stringify(exec.routes)}`,
      ),
    );
    return ['executions:', ...lines].join('\n');
  }

  /** Removes edges, then middle nodes, while the case keeps failing. */
  async function shrink(seed: number, graph: Graph): Promise<{ graph: Graph; failure: string }> {
    shrinking = true;
    let best = graph;
    let failure = (await runCase(seed, graph)) ?? 'not reproducible';
    for (let improved = true; improved; ) {
      improved = false;
      const candidates: Graph[] = [
        ...best.edges.map((_, index) => ({ nodes: best.nodes, edges: best.edges.filter((__, other) => other !== index) })),
        ...best.nodes
          .filter((node) => node.id !== 'n0' && node.id !== 'end')
          .map((node) => ({ nodes: best.nodes.filter((other) => other !== node), edges: best.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id) })),
      ];
      for (const candidate of candidates) {
        const result = await runCase(seed, candidate);
        if (result !== undefined) {
          best = candidate;
          failure = result;
          improved = true;
          break;
        }
      }
    }
    return { graph: best, failure };
  }

  it(`keeps the ticket-end invariant on ${CASES} random workflows`, async () => {
    let closed = 0;
    for (let index = 0; index < CASES; index++) {
      const seed = BASE_SEED + index;
      const graph = generate(seed);
      const failure = await runCase(seed, graph);
      if (failure !== undefined) {
        const minimal = await shrink(seed, graph);
        throw new Error(`property failed (seed ${seed}): ${minimal.failure}\nminimal counterexample:\n${describeGraph(minimal.graph)}\noriginal:\n${describeGraph(graph)}`);
      }
      closed += 1;
    }
    expect(closed).toBe(CASES);
    stats.runs = h.adapter.started.length;
    process.stdout.write(`property stats: ${JSON.stringify(stats)}
`);
    expect(stats.invalid).toBe(0);
    expect(stats.done).toBeGreaterThan(CASES / 3);
    expect(stats.runs).toBeGreaterThan(CASES * 2);
    // The generator must reach the interesting shapes, or the test proves little.
    const shapes = Array.from({ length: CASES }, (_, index) => generate(BASE_SEED + index));
    expect(shapes.filter((graph) => graph.nodes.some((node) => node.kind === 'join') && graph.edges.some((edge) => edge.port === 'error')).length).toBeGreaterThan(CASES / 5);
    expect(shapes.filter((graph) => graph.edges.some((edge) => edge.port === 'reject' && Number(edge.to.slice(1)) < Number(edge.from.slice(1)))).length).toBeGreaterThan(CASES / 10);
    expect(shapes.filter((graph) => graph.nodes.some((node) => node.kind === 'each')).length).toBeGreaterThan(CASES / 5);
  }, 900_000);
});
