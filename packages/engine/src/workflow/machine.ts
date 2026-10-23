import {
  type ActivationCause,
  type Basis,
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
  type Group,
  groupLive,
  laneLive,
  laneOf,
  nodeProgress,
  type TicketWorkflow,
} from './state.ts';

/**
 * The routing rules of a ticket. Pure: given the folded state and the compiled template, it produces
 * the events of one command. Joins and fan-ins cascade inside the same command, so a crash can never
 * leave a node finished but its successors not activated.
 *
 * The rules are [[명령·이벤트 계약]] §10.6 ("join semantics"); the numbers in the comments below are its items.
 * In short:
 * - An output leaves through one port; each edge from that port carries the items that pass its condition.
 * - A fan-out node (an each input) opens a lane per new item. Lanes opened by one delivery form a group; the
 *   group a node opened last is its current group, and a group is live while it is current and the group it
 *   hangs under is live. Live lanes are the current generation. Opening a group supersedes every active
 *   execution of the generation it replaced, so active executions only ever exist in the current generation.
 * - Items whose lineage leads to a live lane re-run that lane; items that lead only to replaced lanes are stale.
 * - A join fires once some source made a new contribution and every source settled; a fan-in (a whole input
 *   fed by a fan-out node) fires once the fan-out made a new contribution and is not busy. Every completion
 *   re-checks every join and fan-in, because the path one waited for can die anywhere upstream.
 * - An agent or script output that would deliver nothing on a port that leads somewhere waits in Review
 *   (reason 'empty'), error port included (D-016). Approving it sends an empty delivery.
 * - The ticket is done when a path ended and no wait reason holds (active work, or an unhandled failure of
 *   the current generation).
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

function routedItems(edgeIndex: number, exec: Execution): HandoffItem[] {
  const indexes = Object.hasOwn(exec.routes, edgeIndex) ? (exec.routes[edgeIndex] ?? []) : [];
  return indexes.flatMap((index) => {
    const item = exec.output?.items[index];
    return item === undefined ? [] : [copyItem(item, { nodeId: exec.nodeId, run: exec.run, item: index })];
  });
}

const FREE: Basis = { groups: [], free: true };

/** The union of generation records (§10.6 item 3). */
function mergeBasis(bases: readonly Basis[]): Basis {
  const groups = [...new Set(bases.flatMap((basis) => basis.groups))].sort();
  return bases.length === 0 || bases.some((basis) => basis.free === true) ? { groups, free: true } : { groups };
}

/** A record is of the current generation when it is free or one of its groups is live. */
function basisLive(state: TicketWorkflow, basis: Basis): boolean {
  return basis.free === true || basis.groups.length === 0 || basis.groups.some((group) => groupLive(state, group));
}

/**
 * The generation record of what an execution sends: a fan-out lane's is its group. An execution whose deliveries
 * opened groups sends work of exactly those generations (a plan and the review of that plan both go when a newer
 * plan replaces it), whatever it rested on itself. Any other sends its own record.
 */
export function outgoingBasis(state: TicketWorkflow, exec: Execution): Basis {
  const group = laneOf(state, exec.nodeId, exec.lane)?.group;
  if (group !== undefined) return { groups: [group] };
  const opened = exec.opened ?? [];
  return opened.length === 0 ? (exec.basis ?? FREE) : { groups: [...new Set(opened)].sort() };
}

/**
 * §10.6 item 3: whether an execution belongs to the current generation. A fan-out lane's execution follows its
 * lane; any other follows its generation record, whatever items it got (empty deliveries carry a record too).
 */
export function executionLive(state: TicketWorkflow, exec: Execution): boolean {
  if (laneOf(state, exec.nodeId, exec.lane)?.group !== undefined) return laneLive(state, exec.nodeId, exec.lane);
  return basisLive(state, outgoingBasis(state, exec));
}

/** A fan-out node: it has an each input, so it runs in lanes grouped by delivery. */
function isFanOut(node: CompiledNode): boolean {
  return node.inputs.some((port) => port.mode === 'each');
}

function groupOf(state: TicketWorkflow, groupId: string): Group | undefined {
  return Object.hasOwn(state.groups, groupId) ? state.groups[groupId] : undefined;
}

function settled(exec: Execution | undefined): exec is Execution {
  return exec?.status === 'done' || exec?.status === 'failed';
}

function hasActive(state: TicketWorkflow, nodeId: string): boolean {
  return nodeProgress(state, nodeId).executions.some((exec) => ACTIVE_STATUSES.has(exec.status));
}

/** Item 7: the settled executions a source contributes, item 8: whether that is new since `since`, and its record. */
interface Contribution {
  readonly execs: readonly Execution[];
  readonly fresh: boolean;
  /** Set when the source contributes anything (items or an empty delivery). */
  readonly basis?: Basis;
}

function contribution(draft: WorkflowDraft, source: string, edges: readonly number[], since: number): Contribution {
  const { state } = draft;
  const routedOver = (exec: Execution): boolean => edges.some((index) => Object.hasOwn(exec.routes, index));
  if (isFanOut(draft.node(source))) {
    const progress = nodeProgress(state, source);
    const group = progress.group;
    if (group === undefined || !groupLive(state, group)) return { execs: [], fresh: false };
    const execs = progress.laneOrder
      .filter((lane) => laneOf(state, source, lane)?.group === group)
      .map((lane) => currentExecution(state, source, lane))
      .filter((exec): exec is Execution => settled(exec) && routedOver(exec));
    const passed = groupOf(state, group)?.passed;
    const passedHere = passed !== undefined && passed.edges.some((index) => edges.includes(index));
    if (execs.length === 0 && !passedHere) return { execs, fresh: false };
    return { execs, fresh: (passedHere && passed.step > since) || execs.some((exec) => (exec.completedOrder ?? 0) > since), basis: { groups: [group] } };
  }
  const latest = nodeProgress(state, source)
    .executions.filter(settled)
    .sort((a, b) => (b.completedOrder ?? 0) - (a.completedOrder ?? 0))[0];
  // A result of a replaced generation is no contribution at all, not one with its items removed (item 7).
  if (latest === undefined || !routedOver(latest) || !executionLive(state, latest)) return { execs: [], fresh: false };
  return { execs: [latest], fresh: (latest.completedOrder ?? 0) > since, basis: outgoingBasis(state, latest) };
}

function contributedItems(contributed: Contribution, edges: readonly number[]): HandoffItem[] {
  return contributed.execs.flatMap((exec) => edges.flatMap((index) => routedItems(index, exec)));
}

/** Item 9, first part: the source, or a lane of a group its current group hangs under, is still active. */
function busy(state: TicketWorkflow, source: string): boolean {
  if (hasActive(state, source)) return true;
  const seen = new Set<string>();
  for (let current = nodeProgress(state, source).group; current !== undefined && !seen.has(current); ) {
    seen.add(current);
    const group = groupOf(state, current);
    if (group === undefined) break;
    const progress = nodeProgress(state, group.node);
    for (const lane of progress.laneOrder) {
      if (laneOf(state, group.node, lane)?.group !== current) continue;
      const status = currentExecution(state, group.node, lane)?.status;
      if (status !== undefined && ACTIVE_STATUSES.has(status)) return true;
    }
    current = group.parent;
  }
  return false;
}

/**
 * Item 9, second part: something still active could make `source` deliver to `join`: it is reachable from a
 * node with an active execution without passing through the join. Back edges count, so a review that may
 * still send work back keeps the paths it can revive alive.
 */
function reachableFromActive(draft: WorkflowDraft, source: string, join: string): boolean {
  const active = [...draft.workflow.nodes.keys()].filter((nodeId) => nodeId !== join && hasActive(draft.state, nodeId));
  const seen = new Set<string>(active);
  const queue = [...active];
  while (queue.length > 0) {
    const nodeId = queue.shift() ?? '';
    if (nodeId === source) return true;
    for (const indexes of draft.node(nodeId).outgoing.values()) {
      for (const index of indexes) {
        const next = draft.workflow.edges[index]?.edge.to.node;
        if (next === undefined || next === join || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Incoming edges of a node by source node, in edge order. */
function edgesBySource(draft: WorkflowDraft, target: CompiledNode, filter: (index: number) => boolean = () => true): Map<string, number[]> {
  const bySource = new Map<string, number[]>();
  for (const index of target.incoming) {
    const source = draft.workflow.edges[index]?.edge.from.node;
    if (source !== undefined && filter(index)) bySource.set(source, [...(bySource.get(source) ?? []), index]);
  }
  return bySource;
}

function toPort(draft: WorkflowDraft, index: number): string | undefined {
  return draft.workflow.edges[index]?.edge.to.port;
}

/** Whether an edge ends at an each input. */
function toEach(draft: WorkflowDraft, index: number): boolean {
  const edge = draft.workflow.edges[index];
  return edge !== undefined && draft.node(edge.edge.to.node).inputs.find((input) => input.name === edge.edge.to.port)?.mode === 'each';
}

/** Latest delivery over an edge: a fan-out source's contribution, else the latest current run that took it. */
function latestOver(draft: WorkflowDraft, edgeIndex: number): { items: HandoffItem[]; basis?: Basis } {
  const source = draft.workflow.edges[edgeIndex]?.edge.from.node;
  if (source === undefined) return { items: [] };
  if (isFanOut(draft.node(source))) {
    const contributed = contribution(draft, source, [edgeIndex], 0);
    return { items: contributedItems(contributed, [edgeIndex]), ...(contributed.basis === undefined ? {} : { basis: contributed.basis }) };
  }
  const latest = nodeProgress(draft.state, source)
    .executions.filter((exec) => exec.completedOrder !== undefined && Object.hasOwn(exec.routes, edgeIndex))
    .sort((a, b) => (b.completedOrder ?? 0) - (a.completedOrder ?? 0))[0];
  if (latest === undefined || !executionLive(draft.state, latest)) return { items: [] };
  return { items: routedItems(edgeIndex, latest), basis: outgoingBasis(draft.state, latest) };
}

export interface ActivationExtra {
  /** Generation record of what this activation consumed. */
  readonly basis: Basis;
  /** Set on the activation that opens a new group: whose delivery opened it. */
  readonly openedBy?: { readonly nodeId: string; readonly run: number };
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
  extra: ActivationExtra,
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
      basis: extra.basis,
      ...(extra.openedBy === undefined ? {} : { openedBy: extra.openedBy }),
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
  for (const nodeId of draft.workflow.entries) activate(draft, nodeId, MAIN, 'start', {}, { basis: FREE });
}

/**
 * Activates a whole-input node: the given ports take the given items (whose deliveries carry `consumed`), the
 * others their latest delivery. The record is the union of everything consumed.
 */
function activateWhole(draft: WorkflowDraft, target: CompiledNode, given: Readonly<Record<string, readonly HandoffItem[]>>, consumed: readonly Basis[], back: boolean): void {
  const inputs: Record<string, readonly HandoffItem[]> = {};
  const bases = [...consumed];
  for (const input of target.inputs) {
    if (Object.hasOwn(given, input.name)) {
      inputs[input.name] = given[input.name] ?? [];
      continue;
    }
    const latest = target.incoming.filter((index) => toPort(draft, index) === input.name).map((index) => latestOver(draft, index));
    inputs[input.name] = latest.flatMap((entry) => entry.items);
    for (const entry of latest) if (entry.basis !== undefined) bases.push(entry.basis);
  }
  activate(draft, target.id, MAIN, back ? 'rework' : 'input', inputs, { basis: mergeBasis(bases) });
}

function nextLane(draft: WorkflowDraft, nodeId: string): string {
  const used = nodeProgress(draft.state, nodeId).laneOrder.map((lane) => Number.parseInt(lane, 10)).filter(Number.isFinite);
  return String(Math.max(0, ...used) + 1);
}

function newGroupId(draft: WorkflowDraft): string {
  return `g${Object.keys(draft.state.groups).length + 1}`;
}

/** The live group of `nodeId` that hangs under `parent` (chained fan-out), if there is one. */
function liveChild(state: TicketWorkflow, nodeId: string, parent: string): string | undefined {
  return Object.entries(state.groups).find(([id, group]) => group.node === nodeId && group.parent === parent && groupLive(state, id))?.[0];
}

/**
 * Item 6: every active execution outside the current generation ends as superseded (D-019): lanes of replaced
 * groups, and executions downstream that only consume outdated results (a QA reviewing the old plan's join).
 */
function retireReplaced(draft: WorkflowDraft): void {
  for (const nodeId of draft.workflow.nodes.keys()) {
    for (const lane of nodeProgress(draft.state, nodeId).laneOrder) {
      const exec = currentExecution(draft.state, nodeId, lane);
      if (exec === undefined || !ACTIVE_STATUSES.has(exec.status) || executionLive(draft.state, exec)) continue;
      draft.emit({ type: 'node.superseded', data: { ticketId: draft.ticketId, nodeId, lane, run: exec.run, reason: 'replaced' } });
    }
  }
}

/** Item 5: a delivery to a fan-out node re-runs the live lanes its items lead to and opens lanes for the rest. */
function deliverEach(draft: WorkflowDraft, edgeIndex: number, source: Execution, target: CompiledNode, port: CompiledPort): void {
  const items = routedItems(edgeIndex, source);
  const rework = new Map<string, HandoffItem[]>();
  const fresh: HandoffItem[] = [];
  for (const item of items) {
    const lanes = new Set<string>();
    for (const ref of ancestorsOf(draft.state, item.lineage ?? [], target.id)) {
      const lane = execution(draft.state, target.id, ref.run)?.lane;
      if (lane !== undefined && laneLive(draft.state, target.id, lane)) lanes.add(lane);
    }
    if (lanes.size === 0) fresh.push(item);
    for (const lane of lanes) rework.set(lane, [...(rework.get(lane) ?? []), item]);
  }
  const basis = outgoingBasis(draft.state, source);
  for (const [lane, laneItems] of rework) {
    const group = laneOf(draft.state, target.id, lane)?.group;
    activate(draft, target.id, lane, 'rework', { [port.name]: laneItems }, { basis, ...(group === undefined ? {} : { group }) });
  }
  if (fresh.length === 0) return;
  // Chained fan-out: lanes hang under the source lane's group. Otherwise new items join the current group
  // when the same delivery reworks it (D-020), and open a new generation when it does not.
  const parent = laneOf(draft.state, source.nodeId, source.lane)?.group;
  const existing = parent === undefined ? (rework.size > 0 ? nodeProgress(draft.state, target.id).group : undefined) : liveChild(draft.state, target.id, parent);
  const group = existing ?? newGroupId(draft);
  fresh.forEach((item, index) => {
    const opening = existing === undefined && index === 0;
    const extra: ActivationExtra = {
      basis,
      group,
      ...(opening && parent !== undefined ? { groupParent: parent } : {}),
      ...(opening ? { openedBy: { nodeId: source.nodeId, run: source.run } } : {}),
    };
    activate(draft, target.id, nextLane(draft, target.id), 'input', { [port.name]: [item] }, extra);
  });
  if (existing === undefined) retireReplaced(draft);
}

/**
 * Item 10: fires a join (dead path elimination, as in BPMN) once some source made a new contribution since
 * the join's last activation and every source settled. A source whose contribution is new only has to be
 * idle; one with nothing new must also be out of reach of active work. Its input is every contribution.
 */
function tryJoin(draft: WorkflowDraft, target: CompiledNode): void {
  const since = nodeProgress(draft.state, target.id).activated;
  const bySource = edgesBySource(draft, target);
  let fresh = false;
  for (const [source, edges] of bySource) {
    if (busy(draft.state, source)) return;
    if (contribution(draft, source, edges, since).fresh) fresh = true;
    else if (reachableFromActive(draft, source, target.id)) return;
  }
  if (!fresh) return;
  const inputs: Record<string, HandoffItem[]> = {};
  for (const port of target.inputs) {
    inputs[port.name] = [...bySource].flatMap(([source, edges]) => {
      const onPort = edges.filter((index) => toPort(draft, index) === port.name);
      return contributedItems(contribution(draft, source, onPort, since), onPort);
    });
  }
  const bases = [...bySource].flatMap(([source, edges]) => contribution(draft, source, edges, since).basis ?? []);
  activate(draft, target.id, MAIN, 'input', inputs, { basis: mergeBasis(bases) });
}

/**
 * Item 11: a whole input fed by fan-out nodes runs once one of them made a new contribution and is not busy.
 * One activation takes every such source at once (a second activation would no longer see the first source
 * as new), each with the latest result of every live lane.
 */
function tryFanIns(draft: WorkflowDraft, target: CompiledNode): void {
  const since = nodeProgress(draft.state, target.id).activated;
  const whole = new Set(target.inputs.filter((port) => port.mode === 'whole').map((port) => port.name));
  const ready = [...edgesBySource(draft, target, (index) => whole.has(toPort(draft, index) ?? ''))].filter(
    ([source, edges]) => isFanOut(draft.node(source)) && !busy(draft.state, source) && contribution(draft, source, edges, since).fresh,
  );
  if (ready.length === 0) return;
  const given: Record<string, HandoffItem[]> = {};
  for (const [source, edges] of ready) {
    for (const index of edges) {
      const port = toPort(draft, index) ?? '';
      given[port] = [...(given[port] ?? []), ...contributedItems(contribution(draft, source, [index], since), [index])];
    }
  }
  const consumed = ready.flatMap(([source, edges]) => contribution(draft, source, edges, since).basis ?? []);
  const back = ready.some(([, edges]) => edges.some((index) => draft.workflow.edges[index]?.back === true));
  activateWhole(draft, target, given, consumed, back);
}

/** Item 12: re-checks every join and fan-in. A join that fires completes, and its completion sweeps again. */
function sweep(draft: WorkflowDraft): void {
  for (const node of draft.workflow.nodes.values()) {
    if (node.completion === 'join') tryJoin(draft, node);
    else tryFanIns(draft, node);
  }
}

/** What items that travelled one edge mean for its target (joins and fan-ins wait for the sweep). */
function propagate(draft: WorkflowDraft, edgeIndex: number, source: Execution): void {
  const edge = draft.workflow.edges[edgeIndex];
  if (edge === undefined) return;
  const target = draft.node(edge.edge.to.node);
  const port = target.inputs.find((input) => input.name === edge.edge.to.port);
  if (port === undefined) return;
  if (port.mode === 'each') deliverEach(draft, edgeIndex, source, target, port);
  else if (target.completion !== 'join' && !isFanOut(draft.node(source.nodeId))) {
    activateWhole(draft, target, { [port.name]: routedItems(edgeIndex, source) }, [outgoingBasis(draft.state, source)], edge.back);
  }
}

/**
 * Carries an empty delivery over one edge (item 5, last case). `parent` is the group of the lane it comes
 * from; `seen` stops loops of fan-out nodes.
 */
function propagateEmpty(
  draft: WorkflowDraft,
  edgeIndex: number,
  parent: string | undefined,
  fromFanOut: boolean,
  from: Execution,
  basis: Basis | undefined,
  seen: Set<string>,
): void {
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
    const existing = parent === undefined ? undefined : liveChild(draft.state, target.id, parent);
    const group = existing ?? newGroupId(draft);
    draft.emit({
      type: 'node.passedOver',
      data: {
        ticketId: draft.ticketId,
        nodeId: target.id,
        group,
        ...(existing === undefined && parent !== undefined ? { groupParent: parent } : {}),
        edges,
        basis: { groups: [group] },
        ...(existing === undefined ? { openedBy: { nodeId: from.nodeId, run: from.run } } : {}),
      },
    });
    if (existing === undefined) retireReplaced(draft);
    for (const next of edges) propagateEmpty(draft, next.edge, group, true, from, { groups: [group] }, seen);
    return;
  }
  // A join, or a fan-in of a fan-out node, sees the empty delivery in the sweep.
  if (target.completion === 'join' || fromFanOut) return;
  // A first hop from a lane-less execution: its record now includes any group the same completion opened.
  activateWhole(draft, target, { [port.name]: [] }, [basis ?? outgoingBasis(draft.state, draft.exec(from.nodeId, from.run))], edge.back);
}

export interface CompletionExtra {
  readonly error?: string;
  readonly undeclared?: readonly string[];
}

interface PlannedRoutes {
  readonly routes: { edge: number; to: string; items: number[] }[];
  readonly stale: { edge: number; to: string; items: number[] }[];
  /** Set when the port leads somewhere but nothing would travel: every edge of the port then carries an empty delivery. */
  readonly empty: { edge: number; to: string }[];
}

/** Which items an output sends over which edges of its port (conditions applied, stale items held back). */
function planRoutes(draft: WorkflowDraft, node: CompiledNode, exec: Execution, output: NodeRunOutput): PlannedRoutes {
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
    routes.length === 0 && stale.length === 0
      ? portEdges.flatMap((edgeIndex) => {
          const edge = draft.workflow.edges[edgeIndex];
          return edge === undefined ? [] : [{ edge: edgeIndex, to: edge.edge.to.node }];
        })
      : [];
  return { routes, stale, empty };
}

/** True when the output's port leads somewhere but the output would deliver nothing (D-016). */
export function deliversNothing(draft: WorkflowDraft, node: CompiledNode, exec: Execution, output: NodeRunOutput): boolean {
  return planRoutes(draft, node, exec, output).empty.length > 0;
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
  const { routes, stale, empty } = planRoutes(draft, node, exec, output);
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
      basis: outgoingBasis(draft.state, exec),
    },
  });
  // Fan-out targets first: a new generation this completion opens there is part of what it sends everywhere else.
  const eachFirst = <T extends { edge: number }>(list: readonly T[]): T[] =>
    [...list].sort((a, b) => Number(!toEach(draft, a.edge)) - Number(!toEach(draft, b.edge)) || a.edge - b.edge);
  for (const route of eachFirst(routes)) propagate(draft, route.edge, draft.exec(nodeId, run));
  const parent = laneOf(draft.state, nodeId, exec.lane)?.group;
  for (const entry of eachFirst(empty)) propagateEmpty(draft, entry.edge, parent, isFanOut(node), draft.exec(nodeId, run), undefined, new Set());
  sweep(draft);
  completeTicketIfDone(draft);
}

/** Item 5: the item descends from lanes of the target, but only from lanes of a replaced generation. */
function answersOnlyOldLanes(draft: WorkflowDraft, item: HandoffItem, target: string): boolean {
  const refs = ancestorsOf(draft.state, item.lineage ?? [], target);
  if (refs.length === 0) return false;
  return refs.every((ref) => {
    const lane = execution(draft.state, target, ref.run)?.lane;
    return lane === undefined || !laneLive(draft.state, target, lane);
  });
}

/** Why an open ticket is not done yet (item 14). */
export interface WaitReason {
  readonly nodeId: string;
  readonly lane: string;
  readonly run: number;
  /**
   * 'active': someone (executor or person) still has to act. 'failed': a failure no edge took; retry it.
   * 'stale': a success whose items all answered replaced work, so it went nowhere (D-021); retry it.
   * 'attention': the log holds events in a retired format (§6); nothing carries the ticket on.
   */
  readonly kind: 'active' | 'failed' | 'stale' | 'attention';
  readonly status: string;
}

/**
 * The ticket-end invariant: an open ticket always has one of these reasons. Failures of a replaced generation
 * do not count: a newer group replaced their work.
 */
export function ticketWaitReasons(state: TicketWorkflow, workflow: CompiledWorkflow): WaitReason[] {
  if (state.attention !== undefined) return [{ nodeId: '', lane: '', run: 0, kind: 'attention', status: state.attention.reason }];
  const reasons: WaitReason[] = [];
  for (const nodeId of workflow.nodes.keys()) {
    const progress = nodeProgress(state, nodeId);
    for (const exec of progress.executions) {
      if (ACTIVE_STATUSES.has(exec.status)) reasons.push({ nodeId, lane: exec.lane, run: exec.run, kind: 'active', status: exec.status });
    }
    for (const lane of progress.laneOrder) {
      const exec = currentExecution(state, nodeId, lane);
      if (exec === undefined || Object.keys(exec.routes).length > 0 || !executionLive(state, exec)) continue;
      if (exec.status === 'failed') reasons.push({ nodeId, lane, run: exec.run, kind: 'failed', status: exec.status });
      else if (exec.status === 'done' && exec.onlyStale === true) reasons.push({ nodeId, lane, run: exec.run, kind: 'stale', status: exec.status });
    }
  }
  return reasons;
}

/**
 * Item 13: a path ended. An end node finished, or (implicit end, as in BPMN) an execution finished successfully
 * through a port without edges. Not an output whose items were all stale.
 */
export function endReached(state: TicketWorkflow, workflow: CompiledWorkflow): boolean {
  // Only ends of the current generation count: after a new plan, an end reached with the old plan's results does not.
  // An empty delivery that passed over a fan-out node with no further edges ended its path there too.
  if (state.endGroups.some((group) => groupLive(state, group))) return true;
  const ends = new Set(workflow.ends);
  for (const nodeId of workflow.nodes.keys()) {
    for (const exec of nodeProgress(state, nodeId).executions) {
      if (exec.status !== 'done') continue;
      // An output whose items were all stale went nowhere, but it says nothing about the current work (D-021).
      if ((ends.has(nodeId) || (Object.keys(exec.routes).length === 0 && exec.onlyStale !== true)) && executionLive(state, exec)) return true;
    }
  }
  return false;
}

/** Item 15. */
export function completeTicketIfDone(draft: WorkflowDraft): void {
  const { state, workflow } = draft;
  if (state.status !== 'open' || !endReached(state, workflow)) return;
  if (ticketWaitReasons(state, workflow).length > 0) return;
  draft.emit({ type: 'ticket.completed', data: { ticketId: draft.ticketId } });
}

/** Activates a lane again with the inputs of its current execution (retry, review rejection). Live lanes only. */
export function rerun(draft: WorkflowDraft, exec: Execution, cause: 'retry' | 'review', feedback?: { run: number; comment?: string }): void {
  if (!executionLive(draft.state, exec)) throw new Error(`run ${exec.run} of node '${exec.nodeId}' belongs to a replaced generation`);
  const group = laneOf(draft.state, exec.nodeId, exec.lane)?.group;
  activate(draft, exec.nodeId, exec.lane, cause, exec.inputs, {
    basis: exec.basis ?? FREE,
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
  // D-016 applies to every port that leads somewhere, the error port included.
  const empty = executor && deliversNothing(draft, node, exec, output);
  if (executor && (empty || (status === 'done' && node.review === 'human'))) {
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
