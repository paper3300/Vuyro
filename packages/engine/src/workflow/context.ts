import {
  type ExpressionContext,
  type HandoffItem,
  type ItemRef,
  resolveTemplateValue,
} from '@vuyro/contracts';
import type { CompiledNode, CompiledWorkflow } from './compile.ts';
import { type Execution, execution, nodeProgress, type TicketWorkflow } from './state.ts';

/**
 * Builds what expressions read ([[n8n 노드 데이터 전달 분석]] §6.5):
 *
 * - `input`: the first input item (a fan-out lane's own item); `inputs.<port>`: all items per input port.
 * - `nodes.<id>`: that node's output as seen from here. `item` is the output item this input descends from
 *   (found through lineage); `data`, `artifacts`, `summary` read that item, or the latest run's first item
 *   when lineage does not lead there. `runs` lists finished runs (`runs.last`), `port` is the latest port.
 * - `params` (rendered), `ticket`, `node`, `feedback` (reviewer comment on a review re-run).
 */

const MAX_LINEAGE_STEPS = 100_000;

/** The output item an ItemRef points at. */
export function outputItem(state: TicketWorkflow, ref: ItemRef): HandoffItem | undefined {
  return execution(state, ref.nodeId, ref.run)?.output?.items[ref.item];
}

function refKey(ref: ItemRef): string {
  return `${ref.nodeId}#${ref.run}#${ref.item}`;
}

/**
 * Walks lineage from `start` towards the roots and returns every reference to `target`'s outputs,
 * stopping each path at the first such reference.
 */
export function ancestorsOf(state: TicketWorkflow, start: readonly ItemRef[], target: string): ItemRef[] {
  const found: ItemRef[] = [];
  const seen = new Set<string>();
  const queue = [...start];
  let steps = 0;
  while (queue.length > 0 && steps < MAX_LINEAGE_STEPS) {
    steps += 1;
    const ref = queue.shift();
    if (ref === undefined) break;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.nodeId === target) {
      found.push(ref);
      continue;
    }
    queue.push(...(outputItem(state, ref)?.lineage ?? []));
  }
  return found;
}

/** Input items of an execution in port order. */
export function inputItems(exec: Execution, node: CompiledNode): HandoffItem[] {
  return node.inputs.flatMap((port) => (Object.hasOwn(exec.inputs, port.name) ? (exec.inputs[port.name] ?? []) : []));
}

interface RunView {
  readonly run: number;
  readonly lane: string;
  readonly port: string;
  readonly items: readonly HandoffItem[];
  readonly data?: unknown;
  readonly artifacts?: unknown;
  readonly summary?: unknown;
}

function runView(exec: Execution): RunView | undefined {
  if (exec.output === undefined || (exec.status !== 'done' && exec.status !== 'failed')) return undefined;
  const first = exec.output.items[0];
  return {
    run: exec.run,
    lane: exec.lane,
    port: exec.output.port,
    items: exec.output.items,
    ...(first === undefined ? {} : { data: first.data, artifacts: first.artifacts ?? {}, summary: first.summary ?? '' }),
  };
}

function nodesView(state: TicketWorkflow, workflow: CompiledWorkflow, lineage: readonly ItemRef[]): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const nodeId of workflow.nodes.keys()) {
    const runs = nodeProgress(state, nodeId)
      .executions.filter((exec) => exec.completedOrder !== undefined)
      .sort((a, b) => (a.completedOrder ?? 0) - (b.completedOrder ?? 0))
      .map(runView)
      .filter((run): run is RunView => run !== undefined);
    const [paired] = ancestorsOf(state, lineage, nodeId);
    const item = paired === undefined ? undefined : outputItem(state, paired);
    const latest = runs.at(-1);
    if (latest === undefined && item === undefined) continue;
    const shown = item ?? (latest?.items.length === 1 ? latest.items[0] : undefined);
    view[nodeId] = {
      runs,
      ...(latest === undefined ? {} : { port: latest.port, items: latest.items }),
      ...(item === undefined ? {} : { item }),
      ...(shown === undefined ? {} : { data: shown.data, artifacts: shown.artifacts ?? {}, summary: shown.summary ?? '' }),
    };
  }
  return view;
}

function ticketView(state: TicketWorkflow, ticketId: string): Record<string, unknown> {
  return {
    id: ticketId,
    projectId: state.projectId,
    title: state.title,
    ...(state.description === undefined ? {} : { description: state.description }),
  };
}

/** Context for an execution's prompt, params and script fields. */
export function executionContext(
  state: TicketWorkflow,
  workflow: CompiledWorkflow,
  ticketId: string,
  node: CompiledNode,
  exec: Execution,
): ExpressionContext {
  const items = inputItems(exec, node);
  const lineage = items.flatMap((item) => item.lineage ?? []);
  const base: Record<string, unknown> = {
    input: items[0] ?? { data: {} },
    inputs: exec.inputs,
    nodes: nodesView(state, workflow, lineage),
    ticket: ticketView(state, ticketId),
    node: { id: node.id, label: node.label, lane: exec.lane, run: exec.run, attempt: exec.attempts },
    ...(exec.feedback === undefined ? {} : { feedback: exec.feedback }),
  };
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.params)) {
    const template = node.paramTemplates.get(name);
    params[name] = template === undefined ? value : resolveTemplateValue(template, base);
  }
  return { ...base, params };
}

/** Context for an edge condition: `item` is the item about to travel the edge. */
export function edgeContext(
  state: TicketWorkflow,
  workflow: CompiledWorkflow,
  ticketId: string,
  from: { node: CompiledNode; exec: Execution },
  item: HandoffItem,
): ExpressionContext {
  // The source execution is not finished yet while its routes are decided, so start from the item's own lineage.
  const lineage = item.lineage ?? [];
  return {
    item,
    nodes: nodesView(state, workflow, lineage),
    ticket: ticketView(state, ticketId),
    node: { id: from.node.id, label: from.node.label, lane: from.exec.lane, run: from.exec.run },
  };
}
