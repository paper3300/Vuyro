import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent, TemplateDefinition, TemplateEdge, TemplateNode } from '@vuyro/contracts';
import type { CompiledWorkflow } from '../src/workflow/compile.ts';
import { ticketWaitReasons } from '../src/workflow/machine.ts';
import type { ScriptedSession } from '../src/workflow/scripted-agent.ts';
import { currentExecution, execution, nodeProgress, type TicketWorkflow } from '../src/workflow/state.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { JoinOracle, type OracleCounts } from './helpers/join-oracle.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * Property test of the routing rules ([[명령·이벤트 계약]] §10.6). Seeded random workflows (branches, done/error
 * edges, joins, fan-out with and without review gates, rejection loops, re-planning) run with seeded random node
 * results and random human decisions. After every drive the ticket's event log is replayed through `JoinOracle`,
 * which restates §10.6 without the engine's state fold, and must report:
 *
 * - safety: no join or fan-in ran before its sources settled or with anything but their contributions, no work
 *   happened in a replaced generation, stale items were exactly those answering replaced lanes, and the ticket
 *   completed only when allowed;
 * - progress: with the engine idle, no join or fan-in could still run, every delivery was taken, and an open
 *   ticket has a wait reason. The engine's own `ticketWaitReasons` must equal the oracle's;
 * - the engine reports no unexpected errors and leaves nothing queued while idle.
 *
 * A failing case is shrunk (edges, then nodes removed while it still fails) and printed as a minimal counterexample.
 * PROPERTY_CASES and PROPERTY_SEED override the defaults.
 */

const CASES = Number(process.env.PROPERTY_CASES ?? 300);
const BASE_SEED = Number(process.env.PROPERTY_SEED ?? 20261024);
const MAX_STEPS = 40;

type Kind = 'agent' | 'each' | 'gated' | 'gate' | 'review' | 'join' | 'human';

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

const isLanes = (kind: Kind | 'end' | undefined): boolean => kind === 'each' || kind === 'gated';

function generate(seed: number): Graph {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const middle = 2 + Math.floor(random() * 5);
  const kinds: Kind[] = ['agent', ...Array.from({ length: middle }, () => pick<Kind>(['agent', 'agent', 'each', 'gated', 'gate', 'review', 'review', 'join', 'join', 'human']))];
  const nodes: { id: string; kind: Kind | 'end' }[] = [...kinds.map((kind, index) => ({ id: `n${index}`, kind })), { id: 'end', kind: 'end' as const }];
  const edges: { from: string; port: string; to: string }[] = [];
  const keys = new Set<string>();
  const addById = (from: string, port: string, to: string): void => {
    const key = `${from}.${port}>${to}`;
    if (keys.has(key) || from === to) return;
    keys.add(key);
    edges.push({ from, port, to });
  };
  const add = (from: number, port: string, to: number): void => {
    addById(nodes[from]?.id ?? '', port, nodes[to]?.id ?? '');
  };
  const last = nodes.length - 1;
  const later = (index: number): number => index + 1 + Math.floor(random() * (last - index));
  const indexesOf = (test: (kind: Kind, index: number) => boolean): number[] => kinds.flatMap((kind, index) => (test(kind, index) ? [index] : []));
  kinds.forEach((kind, index) => {
    const main = kind === 'review' ? 'approve' : 'done';
    // Now and then a node leads nowhere on its main port.
    if (index === 0 || random() > 0.1) add(index, main, later(index));
    if (random() < 0.3) add(index, main, later(index));
    if (kind !== 'join' && kind !== 'human' && random() < 0.5) add(index, 'error', later(index));
    if (kind === 'review') {
      const agents = indexesOf((other, at) => other === 'agent' && at >= 1 && at < index);
      if (index > 1 && random() < 0.9) add(index, 'reject', agents.length > 0 && random() < 0.7 ? pick(agents) : 1 + Math.floor(random() * (index - 1)));
      else add(index, 'reject', later(index));
    }
  });
  // The rework race: a source feeds a join and a review that may send it back.
  if (random() < 0.8) {
    const joins = indexesOf((kind, index) => kind === 'join' && index >= 2);
    const join = joins.length === 0 ? undefined : pick(joins);
    const sources = join === undefined ? [] : indexesOf((kind, index) => kind === 'agent' && index >= 1 && index < join);
    const source = sources.length === 0 ? undefined : pick(sources);
    const reviews = source === undefined ? [] : indexesOf((kind, index) => kind === 'review' && index > source);
    const review = reviews.length === 0 ? undefined : pick(reviews);
    if (join !== undefined && source !== undefined && review !== undefined) {
      add(source, 'done', join);
      add(source, 'done', review);
      add(review, 'reject', source);
    }
  }
  // Re-planning: a planner feeds a fan-out node and can run again while the old lanes are still busy, either
  // because a review sends it back or because a person asks for a new plan (an extra entry).
  if (random() < 0.9) {
    const fanOuts = indexesOf((kind, index) => isLanes(kind) && index >= 1);
    const fanOut = fanOuts.length === 0 ? undefined : pick(fanOuts);
    const planners = fanOut === undefined ? [] : indexesOf((kind, index) => kind === 'agent' && index < fanOut);
    const planner = planners.length === 0 ? undefined : pick(planners);
    if (fanOut !== undefined && planner !== undefined) {
      add(planner, 'done', fanOut);
      // A QA-style review of the lanes that sends some of them back (and may add new work, D-020).
      const checks = indexesOf((kind, index) => kind === 'review' && index > fanOut);
      if (checks.length > 0 && random() < 0.6) {
        const check = pick(checks);
        add(fanOut, 'done', check);
        add(check, 'reject', fanOut);
      }
      // The planned lanes' join feeds a node that waits for a person (a review gate or a human task): a new plan
      // must take that pending review with it.
      if (random() < 0.8) {
        const reviewer = { id: 'rqa', kind: random() < 0.5 ? ('gate' as const) : ('human' as const) };
        // 'rsum' summarizes the join and sometimes also cites work outside the fan-out (mixed lineage).
        nodes.push({ id: 'rjoin', kind: 'join' }, { id: 'rsum', kind: 'agent' }, reviewer);
        addById(nodes[fanOut]?.id ?? '', 'done', 'rjoin');
        addById('rjoin', 'done', 'rsum');
        // Sometimes the join also takes something that never passed the fan-out: its work stays current then.
        if (random() < 0.4) addById('n0', 'done', 'rjoin');
        addById('rsum', 'done', 'rqa');
        addById('rqa', 'done', 'end');
      }
      // A chained fan-out under the planned lanes.
      const chained = indexesOf((kind, index) => isLanes(kind) && index > fanOut);
      if (chained.length > 0 && random() < 0.5) add(fanOut, 'done', pick(chained));
      // The entry node must keep no incoming edge, so only a later planner can be sent back.
      const reviews = planner === 0 ? [] : indexesOf((kind, index) => kind === 'review' && index > planner);
      if (reviews.length > 0 && random() < 0.5) {
        const review = pick(reviews);
        add(planner, 'done', review);
        add(review, 'reject', planner);
      } else {
        nodes.push({ id: 'replan', kind: 'human' });
        addById('replan', 'done', nodes[planner]?.id ?? '');
      }
    }
  }
  // Every node but the entries needs an incoming edge.
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
      case 'gated':
        return { id: nodeId, type: 'vuyro.agent', version: 1, params: { instructions: nodeId }, ports: { in: { mode: 'each' } }, review: 'human' };
      case 'gate':
        return { id: nodeId, type: 'vuyro.agent', version: 1, params: { instructions: nodeId }, review: 'human' };
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

interface Coverage extends OracleCounts {
  fanOutLanes: number;
  /** Activations the engine classed as rework (back edge or lane reuse). */
  reworkRuns: number;
  /** Deliveries from a reject port to an earlier node. */
  rejectLoops: number;
}

const emptyCoverage = (): Coverage => ({
  replans: 0,
  retired: 0,
  retiredDownstream: 0,
  replansOverActive: 0,
  joinRuns: 0,
  multiSourceJoinRuns: 0,
  fanInRuns: 0,
  extendedGroups: 0,
  chainedGroups: 0,
  replansAfterEnd: 0,
  mixedAtReplan: 0,
  retiredEmpty: 0,
  fanOutLanes: 0,
  reworkRuns: 0,
  rejectLoops: 0,
});

/** Replays a ticket's log through the oracle. */
function replay(events: readonly DomainEvent[], workflow: CompiledWorkflow): JoinOracle {
  const oracle = new JoinOracle(workflow);
  for (const event of events) oracle.apply(event);
  return oracle;
}

/** What the case exercised, counted from its final log. */
function tally(events: readonly DomainEvent[], workflow: CompiledWorkflow, oracle: JoinOracle, coverage: Coverage): void {
  for (const key of Object.keys(oracle.counts) as (keyof OracleCounts)[]) coverage[key] += oracle.counts[key];
  const order = [...workflow.nodes.keys()];
  for (const event of events) {
    if (event.type === 'node.activated') {
      if (event.data.lane !== 'main') coverage.fanOutLanes += 1;
      if (event.data.cause === 'rework') coverage.reworkRuns += 1;
    }
    if (event.type === 'node.completed') {
      for (const route of event.data.routes) {
        const edge = workflow.edges[route.edge]?.edge;
        if (edge?.from.port === 'reject' && order.indexOf(edge.to.node) < order.indexOf(edge.from.node)) coverage.rejectLoops += 1;
      }
    }
  }
}

interface CaseRun {
  readonly seed: number;
  readonly kinds: ReadonlyMap<string, Kind | 'end'>;
  /** Nodes that feed a fan-out node: their empty outputs (a skipped plan) matter most. */
  readonly planners: ReadonlySet<string>;
}

describe('routing properties', () => {
  let h: WorkflowHarness;
  const cases = new Map<string, CaseRun>();
  let templateCounter = 0;
  const stats = { invalid: 0, done: 0, open: 0, steps: 0, runs: 0 };
  const coverage = emptyCoverage();

  /**
   * An explicit lineage that cites one finished fan-out lane output and one finished output of an entry run (a root
   * that never passed a fan-out). Generations ignore lineage, so this probes that, and stale/rework targeting.
   * Undefined when either is missing.
   */
  function mixedLineage(config: CaseRun, state: TicketWorkflow, self: string, random: () => number): { nodeId: string; run: number; item: number }[] | undefined {
    const refs = (wanted: (nodeId: string, cause: string) => boolean) =>
      Object.entries(state.nodes).flatMap(([nodeId, progress]) =>
        nodeId === self
          ? []
          : progress.executions.flatMap((exec) =>
              (exec.status === 'done' || exec.status === 'failed') && (exec.output?.items.length ?? 0) > 0 && wanted(nodeId, exec.cause) ? [{ nodeId, run: exec.run, item: 0 }] : [],
            ),
      );
    // 'rsum' cites what it summarizes (the planned lanes' join); others cite any fan-out lane output.
    const own = self === 'rsum' ? Object.values(execution(state, self, nodeProgress(state, self).executions.length)?.inputs ?? {}).flat()[0]?.lineage?.[0] : undefined;
    const fanOut = own === undefined ? refs((nodeId) => isLanes(config.kinds.get(nodeId))) : [own];
    const other = refs((nodeId, cause) => cause === 'start' && !isLanes(config.kinds.get(nodeId)));
    const a = fanOut[Math.floor(random() * fanOut.length)];
    const b = other[Math.floor(random() * other.length)];
    if (a === undefined) return undefined;
    // Now and then cite only the lane output: once its plan is replaced, the item rests only on old work (stale).
    if (random() < 0.3) return [a];
    return b === undefined ? undefined : [a, b];
  }

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
      if (runs > 4 || roll < (runs <= 1 ? 0.35 : 0.6)) await done('approve', { data: { verdict: 'ok' } });
      else if (roll < 0.9) {
        const items: Record<string, unknown>[] = [{ data: { feedback: 'again' }, ...(inputs > 0 && random() < 0.5 ? { pairedInput: 0 } : {}) }];
        // Now and then the rejection also adds new work that answers no earlier item.
        if (random() < 0.5) items.push({ data: { feedback: 'new task' }, lineage: [] });
        await done('reject', { items });
      }
      else await done('error', { data: { reason: 'review failed' } });
      return undefined;
    }
    if (runs > 6 || roll < 0.75) {
      const shape = random();
      // A planner now and then plans nothing: a person approves the skip (an empty delivery) or sends it back.
      const none = config.planners.has(nodeId) ? 0.3 : 0.1;
      const count = runs > 6 ? 1 : shape < none ? 0 : shape < 0.6 ? 1 : shape < 0.85 ? 2 : 3;
      const lineage = kind === 'agent' && random() < (nodeId === 'rsum' ? 0.7 : 0.3) ? mixedLineage(config, state, nodeId, random) : undefined;
      await done('done', { items: Array.from({ length: count }, (_, index) => ({ data: { index }, ...(lineage === undefined ? {} : { lineage }) })) });
    } else if (roll < 0.87) {
      await done('error', { items: random() < 0.2 ? [] : [{ data: { reason: 'failed' } }] });
    } else if (roll < 0.95) {
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

  let shrinking = false;

  /** Runs one case. Returns a failure description, or undefined when every property held. */
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
    const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
    const planners = new Set(graph.edges.filter((edge) => isLanes(kinds.get(edge.to))).map((edge) => edge.from));
    cases.set(ticketId, { seed, kinds, planners });
    const errorsBefore = h.errors.length;
    const decide = prng(hash(seed, 'human'));
    const fail = async (message: string): Promise<string> => `${message}\n${await describeTicket(ticketId)}`;
    let workflow: CompiledWorkflow | undefined;
    let oracle: JoinOracle | undefined;

    /** Drives the engine until it is idle, then checks every property. */
    const settle = async (): Promise<string | undefined> => {
      try {
        await h.drive();
      } catch (error) {
        return fail((error as Error).message);
      }
      if (h.errors.length > errorsBefore) return `engine reported: ${h.errors.slice(errorsBefore).map((entry) => `${entry.context}: ${entry.error.message}`).join('; ')}`;
      const state = await h.ticket(ticketId);
      if (state.template === undefined) return 'no template';
      workflow ??= await h.registry.workflow(state.template);
      const events = await h.store.readAggregate(ticketId);
      oracle = replay(events, workflow);
      if (oracle.violations.length > 0) return fail(`oracle (safety): ${oracle.violations.join('; ')}`);
      const problems = oracle.idleProblems();
      if (problems.length > 0) return fail(`oracle (progress): ${problems.join('; ')}`);
      const engineReasons = ticketWaitReasons(state, workflow).map((reason) => `${reason.kind}:${reason.nodeId}/${reason.lane}`).sort();
      const oracleReasons = oracle.waitReasons().map((reason) => `${reason.kind}:${reason.nodeId}/${reason.lane}`).sort();
      if (engineReasons.join(',') !== oracleReasons.join(',')) return fail(`wait reasons differ: engine [${engineReasons.join(', ')}], oracle [${oracleReasons.join(', ')}]`);
      if ((state.status === 'done') !== oracle.ticketDone) return fail(`ticket status ${state.status}, but the oracle says done=${String(oracle.ticketDone)}`);
      const waiting = ticketWaitReasons(state, workflow).filter(
        (reason) => reason.kind === 'active' && (reason.status === 'queued' || reason.status === 'running' || (reason.status === 'rejected' && workflow?.nodes.get(reason.nodeId)?.completion !== 'human')),
      );
      if (waiting.length > 0 && (h.engine?.running ?? 0) === 0) return `executions left waiting while the engine is idle: ${waiting.map((r) => `${r.nodeId}/${r.lane}:${r.status}`).join(', ')}`;
      return undefined;
    };

    const finish = async (): Promise<undefined> => {
      if (!shrinking && workflow !== undefined && oracle !== undefined) tally(await h.store.readAggregate(ticketId), workflow, oracle, coverage);
      return undefined;
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      const failure = await settle();
      if (failure !== undefined) return failure;
      stats.steps += 1;
      const state = await h.ticket(ticketId);
      if (state.status === 'done') {
        stats.done += 1;
        return finish();
      }
      // A person acts on something that waits for one.
      const actionable = oracle?.actionable() ?? [];
      const choice = actionable[Math.floor(decide() * actionable.length)];
      if (choice === undefined) {
        stats.open += 1;
        return finish(); // Waiting on something the test does not drive (fine: a reason exists).
      }
      let response;
      if (choice.kind !== 'active') {
        if (decide() < 0.3) {
          stats.open += 1;
          return finish(); // Leave the failure: the ticket stays open with a reason.
        }
        response = await h.exec('node.retry', { ticketId, nodeId: choice.nodeId, lane: choice.lane });
      } else if (workflow?.nodes.get(choice.nodeId)?.completion === 'human') {
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
    const failure = await settle();
    return failure ?? finish();
  }

  /** Every execution of the ticket: node, lane, run, cause, status, port, routes (for counterexamples). */
  async function describeTicket(ticketId: string): Promise<string> {
    const state = await h.ticket(ticketId);
    const lines = Object.entries(state.nodes).flatMap(([nodeId, progress]) =>
      progress.executions.map(
        (exec) =>
          `  ${nodeId}/${exec.lane}${progress.lanes[exec.lane]?.group === undefined ? '' : `@${progress.lanes[exec.lane]?.group}`} run ${exec.run} ${exec.cause} -> ${exec.status} port=${exec.output?.port ?? '-'} items=${exec.output?.items.length ?? '-'} routes=${JSON.stringify(exec.routes)}`,
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

  it(`keeps the join semantics on ${CASES} random workflows`, async () => {
    let closed = 0;
    for (let index = 0; index < CASES; index++) {
      const seed = BASE_SEED + index;
      const graph = generate(seed);
      const failure = await runCase(seed, graph);
      if (failure !== undefined) {
        const minimal = await shrink(seed, graph);
        throw new Error(`property failed (seed ${seed}): ${failure}\nshrunk: ${minimal.failure}\nminimal counterexample:\n${describeGraph(minimal.graph)}\noriginal:\n${describeGraph(graph)}`);
      }
      closed += 1;
    }
    expect(closed).toBe(CASES);
    stats.runs = h.adapter.started.length;
    process.stdout.write(`property stats: ${JSON.stringify(stats)} coverage: ${JSON.stringify(coverage)}\n`);
    expect(stats.invalid).toBe(0);
    // What the runs actually exercised (not just what the graphs could have).
    expect(coverage.multiSourceJoinRuns).toBeGreaterThanOrEqual(CASES / 10);
    expect(coverage.fanInRuns).toBeGreaterThanOrEqual(CASES / 10);
    expect(coverage.fanOutLanes).toBeGreaterThanOrEqual(CASES / 2);
    expect(coverage.rejectLoops).toBeGreaterThanOrEqual(CASES / 6);
    expect(coverage.reworkRuns).toBeGreaterThanOrEqual(CASES / 10);
    expect(coverage.replans).toBeGreaterThanOrEqual(CASES / 6);
    expect(coverage.replansOverActive).toBeGreaterThanOrEqual(CASES / 20);
    expect(coverage.retired).toBeGreaterThanOrEqual(CASES / 20);
    expect(coverage.retiredDownstream).toBeGreaterThanOrEqual(CASES / 100);
    expect(coverage.extendedGroups).toBeGreaterThanOrEqual(CASES / 60);
    expect(coverage.chainedGroups).toBeGreaterThanOrEqual(CASES / 20);
    expect(coverage.replansAfterEnd).toBeGreaterThanOrEqual(CASES / 100);
    expect(coverage.mixedAtReplan).toBeGreaterThanOrEqual(CASES / 300);
    expect(coverage.retiredEmpty).toBeGreaterThanOrEqual(CASES / 300);
    expect(stats.done).toBeGreaterThan(CASES / 3);
    expect(stats.runs).toBeGreaterThan(CASES * 2);
    // The generator must reach the interesting shapes, or the test proves little.
    const shapes = Array.from({ length: CASES }, (_, index) => generate(BASE_SEED + index));
    expect(shapes.filter((graph) => graph.nodes.some((node) => node.kind === 'join') && graph.edges.some((edge) => edge.port === 'error')).length).toBeGreaterThan(CASES / 5);
    expect(shapes.filter((graph) => graph.edges.some((edge) => edge.port === 'reject' && Number(edge.to.slice(1)) < Number(edge.from.slice(1)))).length).toBeGreaterThan(CASES / 10);
    expect(shapes.filter((graph) => graph.nodes.some((node) => isLanes(node.kind))).length).toBeGreaterThan(CASES / 5);
    expect(shapes.filter((graph) => graph.nodes.some((node) => node.id === 'replan')).length).toBeGreaterThan(CASES / 10);
    const lanes = (graph: Graph, id: string): boolean => isLanes(graph.nodes.find((node) => node.id === id)?.kind);
    expect(shapes.filter((graph) => graph.edges.some((edge) => lanes(graph, edge.from) && lanes(graph, edge.to))).length).toBeGreaterThan(CASES / 10);
  }, 900_000);
});
