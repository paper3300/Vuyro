import {
  type ActivationCause,
  type DraftItem,
  evaluateCondition,
  type HandoffItem,
  type ItemRef,
  type NodeRunOutput,
  type SchemaValidator,
  type ValidationIssue,
} from '@vuyro/contracts';
import type { NewEvent } from '../store/event-store.ts';
import type { CompiledNode, CompiledPort, CompiledWorkflow } from './compile.ts';
import { ancestorsOf, edgeContext, inputItems, outputItem } from './context.ts';
import {
  ACTIVE_STATUSES,
  currentExecution,
  evolveTicket,
  type Execution,
  execution,
  laneOf,
  nodeProgress,
  TERMINAL_STATUSES,
  type TicketWorkflow,
} from './state.ts';

/**
 * The routing rules of a ticket. Pure: given the folded state and the compiled template, it produces
 * the events of one command. Joins and fan-in gathers cascade inside the same command, so a crash
 * can never leave a node finished but its successors not activated.
 *
 * Rules
 * - An output leaves through one port; each edge from that port carries the items that pass its condition.
 * - Whole input port: a new delivery activates the node (lane 'main'). From a fan-out source it waits until
 *   every lane of the source's group has finished, then takes the latest output of each lane.
 * - Each input port: every item gets a lane. An item whose lineage leads back to one of the node's own
 *   lanes re-runs that lane (rework, e.g. QA rejected item 3); other items open new lanes in one group.
 * - Input over a back edge (one that closes a loop, like approval reject → spec) is rework of the target.
 * - Join nodes wait until every incoming edge has delivered and at least one delivered something new.
 * - An agent or script output with no items on a port that leads somewhere waits in Review (reason 'empty').
 *   Rejecting runs the node again; approving (or a person finishing a human node with no items) sends an
 *   empty delivery: a fan-out node passes over (empty group, passes the empty delivery on), a whole input
 *   runs with no items, a join fires with what it has.
 * - Items whose lineage leads only to lanes of an older group of a fan-out target are stale (the work they
 *   answer was replaced, e.g. by a new plan): they are recorded as `stale` and delivered nowhere.
 * - The ticket is done when an end node (no output ports) finished, nothing else is active, and no lane's
 *   latest run failed without an error edge taking the failure somewhere.
 */

const MAIN = 'main';

export class WorkflowDraft {
  state: TicketWorkflow;
  readonly events: NewEvent[] = [];
  readonly ticketId: string;
  readonly workflow: CompiledWorkflow;

  constructor(ticketId: string, state: TicketWorkflow, workflow: CompiledWorkflow) {
    this.ticketId = ticketId;
    this.state = state;
    this.workflow = workflow;
  }

  emit(event: NewEvent): void {
    this.events.push(event);
    this.state = evolveTicket(this.state, event);
  }

  node(nodeId: string): CompiledNode {
    const node = this.workflow.nodes.get(nodeId);
    if (node === undefined) throw new Error(`node '${nodeId}' is not in template ${this.workflow.template.id}`);
    return node;
  }

  exec(nodeId: string, run: number): Execution {
    const found = execution(this.state, nodeId, run);
    if (found === undefined) throw new Error(`node '${nodeId}' has no run ${run}`);
    return found;
  }
}

function copyItem(item: HandoffItem, ref: ItemRef): HandoffItem {
  return {
    data: item.data,
    ...(item.artifacts === undefined ? {} : { artifacts: item.artifacts }),
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    lineage: [ref],
  };
}

function routedItems(draft: WorkflowDraft, edgeIndex: number, exec: Execution): HandoffItem[] {
  const indexes = Object.hasOwn(exec.routes, edgeIndex) ? (exec.routes[edgeIndex] ?? []) : [];
  return indexes.flatMap((index) => {
    const item = exec.output?.items[index];
    return item === undefined ? [] : [copyItem(item, { nodeId: exec.nodeId, run: exec.run, item: index })];
  });
}

/** Every lane of the group (and of the groups it descends from) has finished. */
function groupSettled(draft: WorkflowDraft, groupId: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = groupId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const group: { node: string; parent?: string } | undefined = Object.hasOwn(draft.state.groups, current) ? draft.state.groups[current] : undefined;
    if (group === undefined) return true;
    const progress = nodeProgress(draft.state, group.node);
    for (const name of progress.laneOrder) {
      if (laneOf(draft.state, group.node, name)?.group !== current) continue;
      const status = currentExecution(draft.state, group.node, name)?.status;
      if (status === undefined || !TERMINAL_STATUSES.has(status)) return false;
    }
    current = group.parent;
  }
  return true;
}

/** Latest items that travelled an edge: per lane of a fan-out source's current group, else the latest run. */
function gatherEdge(draft: WorkflowDraft, edgeIndex: number): HandoffItem[] {
  const edge = draft.workflow.edges[edgeIndex];
  if (edge === undefined) return [];
  const source = edge.edge.from.node;
  const progress = nodeProgress(draft.state, source);
  if (progress.group !== undefined) {
    return progress.laneOrder.flatMap((name) => {
      if (laneOf(draft.state, source, name)?.group !== progress.group) return [];
      const exec = currentExecution(draft.state, source, name);
      return exec === undefined ? [] : routedItems(draft, edgeIndex, exec);
    });
  }
  const latest = progress.executions
    .filter((exec) => exec.completedOrder !== undefined && Object.hasOwn(exec.routes, edgeIndex))
    .sort((a, b) => (b.completedOrder ?? 0) - (a.completedOrder ?? 0))[0];
  return latest === undefined ? [] : routedItems(draft, edgeIndex, latest);
}

export interface ActivationExtra {
  readonly group?: string;
  readonly groupParent?: string;
  readonly feedback?: { readonly run: number; readonly comment?: string };
}

/** Starts a new execution of a lane. Join nodes finish right away. Returns the run number. */
export function activate(
  draft: WorkflowDraft,
  nodeId: string,
  lane: string,
  cause: ActivationCause,
  inputs: Readonly<Record<string, readonly HandoffItem[]>>,
  extra: ActivationExtra = {},
): number {
  const node = draft.node(nodeId);
  const run = nodeProgress(draft.state, nodeId).executions.length + 1;
  const current = currentExecution(draft.state, nodeId, lane);
  const supersedes = current !== undefined && ACTIVE_STATUSES.has(current.status) ? current.run : undefined;
  const status = cause === 'rework' || cause === 'review' ? 'rejected' : node.completion === 'human' ? 'review' : 'queued';
  const allInputs = Object.fromEntries(node.inputs.map((port) => [port.name, [...(inputs[port.name] ?? [])]]));
  draft.emit({
    type: 'node.activated',
    data: {
      ticketId: draft.ticketId,
      nodeId,
      lane,
      run,
      cause,
      status,
      inputs: allInputs,
      ...(extra.group === undefined ? {} : { group: extra.group }),
      ...(extra.groupParent === undefined ? {} : { groupParent: extra.groupParent }),
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(extra.feedback === undefined ? {} : { feedback: extra.feedback }),
    },
  });
  if (node.completion === 'join') {
    const exec = draft.exec(nodeId, run);
    // Join output items are the inputs, in port and edge order, each pointing at the item it copies.
    const items = inputItems(exec, node).map((item) => ({ ...item, lineage: item.lineage ?? [] }));
    complete(draft, nodeId, run, { schemaVersion: 1, port: 'done', items }, 'done');
  }
  return run;
}

export function activateEntries(draft: WorkflowDraft): void {
  for (const nodeId of draft.workflow.entries) activate(draft, nodeId, MAIN, 'start', {});
}

function activateWhole(draft: WorkflowDraft, target: CompiledNode, port: string, items: readonly HandoffItem[], back: boolean): void {
  const inputs: Record<string, readonly HandoffItem[]> = {};
  for (const input of target.inputs) {
    if (input.name === port) inputs[port] = items;
    else inputs[input.name] = target.incoming.filter((index) => draft.workflow.edges[index]?.edge.to.port === input.name).flatMap((index) => gatherEdge(draft, index));
  }
  activate(draft, target.id, MAIN, back ? 'rework' : 'input', inputs);
}

function nextLane(draft: WorkflowDraft, nodeId: string): string {
  const used = nodeProgress(draft.state, nodeId).laneOrder.map((lane) => Number.parseInt(lane, 10)).filter(Number.isFinite);
  return String(Math.max(0, ...used) + 1);
}

function deliverEach(draft: WorkflowDraft, edgeIndex: number, source: Execution, target: CompiledNode, port: CompiledPort): void {
  const items = routedItems(draft, edgeIndex, source);
  const targetProgress = nodeProgress(draft.state, target.id);
  const rework = new Map<string, HandoffItem[]>();
  const fresh: HandoffItem[] = [];
  for (const item of items) {
    const lanes = new Set<string>();
    for (const ref of ancestorsOf(draft.state, item.lineage ?? [], target.id)) {
      const lane = execution(draft.state, target.id, ref.run)?.lane;
      if (lane !== undefined && laneOf(draft.state, target.id, lane)?.group === targetProgress.group) lanes.add(lane);
    }
    if (lanes.size === 0) fresh.push(item);
    for (const lane of lanes) rework.set(lane, [...(rework.get(lane) ?? []), item]);
  }
  for (const [lane, laneItems] of rework) {
    const group = laneOf(draft.state, target.id, lane)?.group;
    activate(draft, target.id, lane, 'rework', { [port.name]: laneItems }, group === undefined ? {} : { group });
  }
  if (fresh.length === 0) return;
  // Lanes opened together form a group. Downstream of another fan-out, the group hangs under the source's group.
  const parent = laneOf(draft.state, source.nodeId, source.lane)?.group;
  const inherited =
    parent === undefined
      ? undefined
      : Object.entries(draft.state.groups).find(([, group]) => group.parent === parent && group.node === target.id)?.[0];
  const group = inherited ?? `g${Object.keys(draft.state.groups).length + 1}`;
  const isNew = inherited === undefined;
  fresh.forEach((item, index) => {
    const extra: ActivationExtra = { group, ...(isNew && index === 0 && parent !== undefined ? { groupParent: parent } : {}) };
    activate(draft, target.id, nextLane(draft, target.id), 'input', { [port.name]: [item] }, extra);
  });
}

function tryJoin(draft: WorkflowDraft, target: CompiledNode): void {
  const progress = nodeProgress(draft.state, target.id);
  const delivered = target.incoming.map((index) => (Object.hasOwn(progress.deliveries, index) ? progress.deliveries[index] : undefined));
  if (delivered.some((seq) => seq === undefined)) return;
  if (!delivered.some((seq) => (seq ?? 0) > progress.consumed)) return;
  for (const index of target.incoming) {
    const source = draft.workflow.edges[index]?.edge.from.node ?? '';
    const group = nodeProgress(draft.state, source).group;
    if (group !== undefined && !groupSettled(draft, group)) return;
  }
  const inputs: Record<string, HandoffItem[]> = {};
  for (const port of target.inputs) {
    inputs[port.name] = target.incoming.filter((index) => draft.workflow.edges[index]?.edge.to.port === port.name).flatMap((index) => gatherEdge(draft, index));
  }
  activate(draft, target.id, MAIN, 'input', inputs);
}

/** What one finished execution means for the node at the other end of one of its outgoing edges. */
function propagate(draft: WorkflowDraft, edgeIndex: number, source: Execution, routed: boolean): void {
  const edge = draft.workflow.edges[edgeIndex];
  if (edge === undefined) return;
  const target = draft.node(edge.edge.to.node);
  const port = target.inputs.find((input) => input.name === edge.edge.to.port);
  if (port === undefined) return;
  if (port.mode === 'each') {
    if (routed) deliverEach(draft, edgeIndex, source, target, port);
    return;
  }
  if (target.completion === 'join') {
    tryJoin(draft, target);
    return;
  }
  const group = nodeProgress(draft.state, source.nodeId).group;
  if (group !== undefined) {
    // Fan-in: wait for the whole group, then take every lane's latest output.
    const progress = nodeProgress(draft.state, target.id);
    const seq = Object.hasOwn(progress.deliveries, edgeIndex) ? (progress.deliveries[edgeIndex] ?? 0) : 0;
    if (seq <= progress.consumed || !groupSettled(draft, group)) return;
    const items = gatherEdge(draft, edgeIndex);
    if (items.length > 0) activateWhole(draft, target, port.name, items, edge.back);
    return;
  }
  if (routed) activateWhole(draft, target, port.name, routedItems(draft, edgeIndex, source), edge.back);
}

export interface CompletionExtra {
  readonly error?: string;
  readonly undeclared?: readonly string[];
}

/** Finishes an execution with an output and routes it. */
export function complete(
  draft: WorkflowDraft,
  nodeId: string,
  run: number,
  output: NodeRunOutput,
  status: 'done' | 'failed',
  extra: CompletionExtra = {},
): void {
  const node = draft.node(nodeId);
  const exec = draft.exec(nodeId, run);
  const routes: { edge: number; to: string; items: number[] }[] = [];
  const stale: { edge: number; to: string; items: number[] }[] = [];
  const portEdges = node.outgoing.get(output.port) ?? [];
  for (const edgeIndex of portEdges) {
    const edge = draft.workflow.edges[edgeIndex];
    if (edge === undefined) continue;
    const passing = output.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => edge.when === undefined || evaluateCondition(edge.when, edgeContext(draft.state, draft.workflow, draft.ticketId, { node, exec }, item)));
    const target = draft.node(edge.edge.to.node);
    const each = target.inputs.find((input) => input.name === edge.edge.to.port)?.mode === 'each';
    const isStale = (item: HandoffItem): boolean => each && answersOnlyOldLanes(draft, item, target.id);
    const items = passing.filter(({ item }) => !isStale(item)).map(({ index }) => index);
    const old = passing.filter(({ item }) => isStale(item)).map(({ index }) => index);
    if (items.length > 0) routes.push({ edge: edgeIndex, to: edge.edge.to.node, items });
    if (old.length > 0) stale.push({ edge: edgeIndex, to: edge.edge.to.node, items: old });
  }
  const empty =
    output.items.length === 0
      ? portEdges.flatMap((edgeIndex) => {
          const edge = draft.workflow.edges[edgeIndex];
          return edge === undefined ? [] : [{ edge: edgeIndex, to: edge.edge.to.node }];
        })
      : [];
  draft.emit({
    type: 'node.completed',
    data: {
      ticketId: draft.ticketId,
      nodeId,
      lane: exec.lane,
      run,
      status,
      output,
      routes,
      ...(extra.error === undefined ? {} : { error: extra.error.slice(0, 65536) }),
      ...(extra.undeclared === undefined || extra.undeclared.length === 0 ? {} : { undeclared: [...extra.undeclared].slice(0, 256) }),
      ...(empty.length === 0 ? {} : { empty }),
      ...(stale.length === 0 ? {} : { stale }),
    },
  });
  const finished = draft.exec(nodeId, run);
  const routed = new Set(routes.map((route) => route.edge));
  const emptied = new Set(empty.map((entry) => entry.edge));
  // Every outgoing edge (any port) may matter: a fan-in waits for lanes that end through other ports too.
  const outgoing = [...node.outgoing.values()].flat().sort((a, b) => a - b);
  for (const edgeIndex of outgoing) {
    if (emptied.has(edgeIndex)) propagateEmpty(draft, edgeIndex, new Set());
    else propagate(draft, edgeIndex, finished, routed.has(edgeIndex));
  }
  completeTicketIfDone(draft);
}

/** The item descends from lanes of the target, but only from lanes outside the target's current group. */
function answersOnlyOldLanes(draft: WorkflowDraft, item: HandoffItem, target: string): boolean {
  const refs = ancestorsOf(draft.state, item.lineage ?? [], target);
  if (refs.length === 0) return false;
  const current = nodeProgress(draft.state, target).group;
  return refs.every((ref) => {
    const lane = execution(draft.state, target, ref.run)?.lane;
    return lane === undefined || laneOf(draft.state, target, lane)?.group !== current;
  });
}

/** Carries an empty delivery over one edge (see the rules above). `seen` stops loops of fan-out nodes. */
function propagateEmpty(draft: WorkflowDraft, edgeIndex: number, seen: Set<string>): void {
  const edge = draft.workflow.edges[edgeIndex];
  if (edge === undefined) return;
  const target = draft.node(edge.edge.to.node);
  const port = target.inputs.find((input) => input.name === edge.edge.to.port);
  if (port === undefined) return;
  if (port.mode === 'each') {
    if (seen.has(target.id)) return;
    seen.add(target.id);
    const edges = [...target.outgoing.entries()]
      .filter(([name]) => name !== 'error')
      .flatMap(([, indexes]) => indexes)
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const next = draft.workflow.edges[index];
        return next === undefined ? [] : [{ edge: index, to: next.edge.to.node }];
      });
    const group = `g${Object.keys(draft.state.groups).length + 1}`;
    draft.emit({ type: 'node.passedOver', data: { ticketId: draft.ticketId, nodeId: target.id, group, edges } });
    for (const next of edges) propagateEmpty(draft, next.edge, seen);
    return;
  }
  if (target.completion === 'join') {
    tryJoin(draft, target);
    return;
  }
  activateWhole(draft, target, port.name, [], edge.back);
}

export function completeTicketIfDone(draft: WorkflowDraft): void {
  const { state, workflow } = draft;
  if (state.status !== 'open') return;
  const endDone = workflow.ends.some((id) => nodeProgress(state, id).executions.some((exec) => exec.status === 'done'));
  if (!endDone) return;
  for (const nodeId of workflow.nodes.keys()) {
    const progress = nodeProgress(state, nodeId);
    if (progress.executions.some((exec) => ACTIVE_STATUSES.has(exec.status))) return;
    // A lane that failed and whose failure went nowhere (no error edge took it) still needs a person: retry it.
    for (const lane of progress.laneOrder) {
      const exec = currentExecution(state, nodeId, lane);
      if (exec?.status === 'failed' && Object.keys(exec.routes).length === 0) return;
    }
  }
  draft.emit({ type: 'ticket.completed', data: { ticketId: draft.ticketId } });
}

/** Activates a lane again with the inputs of its current execution (retry, review rejection). */
export function rerun(draft: WorkflowDraft, exec: Execution, cause: 'retry' | 'review', feedback?: { run: number; comment?: string }): void {
  const group = laneOf(draft.state, exec.nodeId, exec.lane)?.group;
  activate(draft, exec.nodeId, exec.lane, cause, exec.inputs, {
    ...(group === undefined ? {} : { group }),
    ...(feedback === undefined ? {} : { feedback }),
  });
}

// ---------------------------------------------------------------------------
// Outputs

export type OutputResult =
  | { readonly ok: true; readonly output: NodeRunOutput; readonly undeclared: string[] }
  | { readonly ok: false; readonly message: string; readonly issues: ValidationIssue[] };

/**
 * Turns submitted items into a validated output: checks the port, fills lineage, merges the artifacts
 * registered during the execution, and validates data and artifact slots against the port.
 * Default lineage: one input → every item pairs with it; as many outputs as inputs → pair by index;
 * otherwise each item descends from all inputs.
 */
export function buildOutput(
  draft: WorkflowDraft,
  node: CompiledNode,
  exec: Execution,
  portName: string,
  drafts: readonly DraftItem[],
  validator: SchemaValidator,
): OutputResult {
  const port = node.outputs.get(portName);
  if (port === undefined) {
    return {
      ok: false,
      message: `node '${node.id}' has no output port '${portName}' (ports: ${[...node.outputs.keys()].join(', ') || 'none'})`,
      issues: [{ path: '/port', message: 'unknown port' }],
    };
  }
  const inputs = inputItems(exec, node);
  const issues: ValidationIssue[] = [];
  const undeclared = new Set<string>();
  const items: HandoffItem[] = drafts.map((item, index) => {
    const at = `/items/${index}`;
    let lineage: ItemRef[];
    if (item.lineage !== undefined) {
      item.lineage.forEach((ref, refIndex) => {
        if (outputItem(draft.state, ref) === undefined) issues.push({ path: `${at}/lineage/${refIndex}`, message: 'no such output item in this ticket' });
      });
      lineage = [...item.lineage];
    } else if (item.pairedInput !== undefined) {
      const indexes = typeof item.pairedInput === 'number' ? [item.pairedInput] : item.pairedInput;
      lineage = [];
      for (const inputIndex of indexes) {
        const input = inputs[inputIndex];
        if (input === undefined) issues.push({ path: `${at}/pairedInput`, message: `there is no input item ${inputIndex} (this run has ${inputs.length})` });
        else lineage.push(...(input.lineage ?? []));
      }
    } else if (inputs.length === drafts.length && inputs.length > 1) {
      lineage = [...(inputs[index]?.lineage ?? [])];
    } else {
      lineage = inputs.flatMap((input) => input.lineage ?? []);
    }
    const artifacts = { ...exec.artifacts, ...(item.artifacts ?? {}) };
    const data = item.data ?? {};
    if (port.schema !== undefined) {
      for (const issue of validator.validate(port.schema, data)) issues.push({ path: `${at}/data${issue.path}`, message: issue.message });
    }
    if (port.schema !== undefined && port.closedWorld && !port.strict) {
      for (const key of Object.keys(data)) if (!port.declared.has(key)) undeclared.add(key);
    }
    for (const slot of port.artifacts) {
      const ref = Object.hasOwn(artifacts, slot.slot) ? artifacts[slot.slot] : undefined;
      if (ref === undefined) {
        if (slot.required === true) issues.push({ path: `${at}/artifacts/${slot.slot}`, message: 'required artifact is missing' });
      } else if (!slot.kinds.includes(ref.kind)) {
        issues.push({ path: `${at}/artifacts/${slot.slot}/kind`, message: `kind '${ref.kind}' is not allowed (${slot.kinds.join(', ')})` });
      }
    }
    return {
      data,
      ...(Object.keys(artifacts).length === 0 ? {} : { artifacts }),
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      lineage: dedupe(lineage),
    };
  });
  if (issues.length > 0) return { ok: false, message: `output does not match port '${portName}' of node '${node.id}'`, issues };
  return { ok: true, output: { schemaVersion: 1, port: portName, items }, undeclared: [...undeclared].sort() };
}

function dedupe(refs: readonly ItemRef[]): ItemRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.nodeId}#${ref.run}#${ref.item}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An executor failure without a usable output: one item on the error port that descends from all inputs. */
export function failureOutput(node: CompiledNode, exec: Execution, error: string, details: Record<string, unknown> = {}): NodeRunOutput {
  const lineage = dedupe(inputItems(exec, node).flatMap((item) => item.lineage ?? []));
  return { schemaVersion: 1, port: 'error', items: [{ data: { error, ...details }, summary: error.slice(0, 2000), lineage }] };
}

/**
 * Applies a finished executor's output: failures finish as failed; a review gate holds successful output
 * for a person; otherwise it is routed.
 */
export function finishWithOutput(draft: WorkflowDraft, node: CompiledNode, exec: Execution, output: NodeRunOutput, undeclared: readonly string[] = []): void {
  const status = output.port === 'error' ? 'failed' : 'done';
  // A person finishing a human node decides for themselves, including "nothing to pass on".
  const executor = node.completion !== 'human';
  const empty = executor && status === 'done' && output.items.length === 0 && (node.outgoing.get(output.port)?.length ?? 0) > 0;
  if (status === 'done' && executor && (node.review === 'human' || empty)) {
    draft.emit({
      type: 'node.reviewRequested',
      data: { ticketId: draft.ticketId, nodeId: node.id, lane: exec.lane, run: exec.run, output, ...(empty ? { reason: 'empty' as const } : {}) },
    });
    return;
  }
  complete(draft, node.id, exec.run, output, status, { undeclared });
}

/** Adds artifacts registered after the output was submitted to items that lack those slots. */
export function withLateArtifacts(output: NodeRunOutput, exec: Execution): NodeRunOutput {
  if (Object.keys(exec.artifacts).length === 0) return output;
  return {
    ...output,
    items: output.items.map((item) => ({ ...item, artifacts: { ...exec.artifacts, ...(item.artifacts ?? {}) } })),
  };
}
