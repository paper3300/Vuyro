import type { Basis, DomainEvent, HandoffItem, ItemRef } from '@vuyro/contracts';
import type { CompiledNode, CompiledWorkflow } from '../../src/workflow/compile.ts';

/**
 * Join semantics oracle: [[명령·이벤트 계약]] §10.6 restated from the event log alone. It does not use the
 * engine's state fold (`state.ts`) or routing (`machine.ts`); it reads only the compiled template's shape
 * (nodes, ports, edges). Item numbers in comments refer to §10.6.
 *
 * Feed it a ticket's events in order with `apply`. It records a violation when an event breaks a safety rule
 * (a join or fan-in that runs too early or takes the wrong input, work in a replaced generation, a ticket that
 * completes while a reason holds). `idleProblems()` checks progress for a moment when the engine has nothing
 * left to do: no join or fan-in could run, every delivery was taken, and an open ticket has a wait reason.
 */

const ACTIVE = new Set(['queued', 'running', 'review', 'rejected', 'paused']);
const SETTLED = new Set(['done', 'failed']);

interface Exec {
  readonly node: string;
  readonly run: number;
  readonly lane: string;
  readonly cause: string;
  readonly inputs: readonly HandoffItem[];
  status: string;
  routes: Map<number, number[]>;
  items: readonly HandoffItem[];
  /** The output had items for edges, all stale, so nothing travelled (D-021). */
  onlyStale: boolean;
  completedAt?: number;
}

interface Group {
  readonly node: string;
  readonly parent?: string;
  passedAt?: number;
  passedEdges: readonly number[];
}

export interface OracleReason {
  readonly nodeId: string;
  readonly lane: string;
  readonly kind: 'active' | 'failed' | 'stale';
}

export interface OracleCounts {
  /** A fan-out node opened a new generation while it already had a group (a new plan). */
  replans: number;
  /** Active executions ended because their generation was replaced. */
  retired: number;
  /** Of those, executions outside fan-out lanes that only consumed outdated results (a review of the old join). */
  retiredDownstream: number;
  /** Replans that happened while the replaced generation still had active work (the e864a07 counterexample shape). */
  replansOverActive: number;
  joinRuns: number;
  multiSourceJoinRuns: number;
  fanInRuns: number;
  /** New lanes added to the current group by a delivery that also reworked it (D-020). */
  extendedGroups: number;
  /** Groups opened under an upstream fan-out group. */
  chainedGroups: number;
  /** New plans opened after a path had already ended (with the old plan's results). */
  replansAfterEnd: number;
  /** Active executions outside fan-out lanes, at a new plan, that consumed both replaced and current work. */
  mixedAtReplan: number;
  /** Executions with no input items (only empty deliveries) retired by a new plan. */
  retiredEmpty: number;
}

const refKey = (ref: ItemRef): string => `${ref.nodeId}#${ref.run}#${ref.item}`;

/** What an activation consumed: the execution that delivered, or a passed-over group's empty delivery. */
type Source = { readonly kind: 'exec'; readonly node: string; readonly run: number } | { readonly kind: 'group'; readonly group: string };
const itemKeys = (items: readonly HandoffItem[]): string[] => items.map((item) => (item.lineage?.[0] === undefined ? '?' : refKey(item.lineage[0])));

export class JoinOracle {
  readonly violations: string[] = [];
  readonly counts: OracleCounts = { replans: 0, retired: 0, retiredDownstream: 0, replansOverActive: 0, joinRuns: 0, multiSourceJoinRuns: 0, fanInRuns: 0, extendedGroups: 0, chainedGroups: 0, replansAfterEnd: 0, mixedAtReplan: 0, retiredEmpty: 0 };
  /** Item 1: the step counter. */
  private step = 0;
  private readonly execs = new Map<string, Exec[]>();
  /** node → lane → runs, in lane creation order. */
  private readonly lanes = new Map<string, Map<string, number[]>>();
  private readonly laneGroup = new Map<string, string>();
  private readonly groups = new Map<string, Group>();
  /** Item 3: the group each node opened last. */
  private readonly current = new Map<string, string>();
  private readonly lastActivation = new Map<string, number>();
  /** Items routed to a fan-out node that no activation took yet. */
  private readonly pendingEach = new Map<string, Set<string>>();
  /** Deliveries from a non-fan-out source to a whole input that no activation took yet. */
  private readonly pendingDirect = new Map<string, { edge: number; port: string; keys: string[]; source: Source }[]>();
  /** Fan-out nodes the last completion reworked from a lane-less source: they must not open a new generation (D-020). */
  private reworked = new Set<string>();
  /** What every execution consumed, worked out by the oracle itself (never read from `basis`): node#run → sources. */
  private readonly consumed = new Map<string, readonly Source[]>();
  /** The record the oracle expects each activation to carry, as classes: node#run → classes. */
  private readonly recorded = new Map<string, string[]>();
  /** Groups each execution's deliveries opened, attributed by the oracle to the completion being routed: node#run → groups. */
  private readonly opened = new Map<string, string[]>();
  /** The execution whose completion is being routed (group openings belong to it). */
  private routing: { node: string; run: number } | undefined;
  /** Item 13 candidates; whether one counts is decided when asked, by the generation it belongs to now. */
  private readonly endRecords: ({ kind: 'exec'; node: string; run: number } | { kind: 'group'; group: string })[] = [];
  private done = false;

  private readonly workflow: CompiledWorkflow;

  constructor(workflow: CompiledWorkflow) {
    this.workflow = workflow;
  }

  get ticketDone(): boolean {
    return this.done;
  }

  apply(event: DomainEvent): void {
    switch (event.type) {
      case 'node.activated':
        this.onActivated(event.data);
        break;
      case 'node.started':
        this.setStatus(event.data.nodeId, event.data.run, 'running');
        break;
      case 'node.reviewRequested':
        this.setStatus(event.data.nodeId, event.data.run, 'review');
        break;
      case 'node.returned':
        this.setStatus(event.data.nodeId, event.data.run, 'discarded');
        break;
      case 'node.requeued':
        this.setStatus(event.data.nodeId, event.data.run, 'queued');
        break;
      case 'node.paused':
        this.setStatus(event.data.nodeId, event.data.run, 'paused');
        break;
      case 'node.resumed':
        this.setStatus(event.data.nodeId, event.data.run, event.data.status);
        break;
      case 'node.superseded': {
        const { nodeId, lane, run } = event.data;
        const exec = this.exec(nodeId, run);
        if (exec === undefined || this.execLive(exec)) this.violate(`${nodeId}/${lane} run ${run} was superseded as replaced, but it belongs to the current generation${exec === undefined ? '' : ` (${this.explain(exec)})`}`);
        this.setStatus(nodeId, run, 'superseded');
        this.counts.retired += 1;
        if (!this.laneGroup.has(`${nodeId}#${lane}`)) {
          this.counts.retiredDownstream += 1;
          if (exec !== undefined && exec.inputs.length === 0) this.counts.retiredEmpty += 1;
        }
        break;
      }
      case 'node.completed':
        this.onCompleted(event.data);
        break;
      case 'node.passedOver':
        this.onPassedOver(event.data);
        break;
      case 'ticket.completed': {
        const reasons = this.waitReasons();
        if (reasons.length > 0) this.violate(`ticket completed while ${reasons.map((r) => `${r.kind}:${r.nodeId}/${r.lane}`).join(', ')} held it open`);
        if (!this.endedNow()) this.violate('ticket completed before a path of the current generation ended');
        this.done = true;
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Folding

  private node(nodeId: string): CompiledNode {
    const node = this.workflow.nodes.get(nodeId);
    if (node === undefined) throw new Error(`oracle: unknown node ${nodeId}`);
    return node;
  }

  private exec(nodeId: string, run: number): Exec | undefined {
    return this.execs.get(nodeId)?.[run - 1];
  }

  private setStatus(nodeId: string, run: number, status: string): void {
    const exec = this.exec(nodeId, run);
    if (exec !== undefined) exec.status = status;
  }

  private violate(message: string): void {
    if (this.violations.length < 20) this.violations.push(message);
  }

  private onActivated(data: Extract<DomainEvent, { type: 'node.activated' }>['data']): void {
    const { nodeId, lane, run, group } = data;
    const node = this.node(nodeId);
    if (this.done) this.violate(`${nodeId}/${lane} run ${run} was activated after the ticket completed`);
    // Safety checks against the state just before the activation.
    if (group !== undefined && this.groups.has(group) && !this.groupLive(group)) {
      this.violate(`${nodeId}/${lane} run ${run} (${data.cause}) was activated in replaced group ${group}`);
    }
    let consumed: readonly Source[] = [];
    let rerunOf: string | undefined;
    if (data.cause === 'retry' || data.cause === 'review') {
      const previous = this.currentExec(nodeId, lane);
      rerunOf = previous === undefined ? undefined : `${nodeId}#${previous.run}`;
      consumed = rerunOf === undefined ? [] : (this.consumed.get(rerunOf) ?? []);
    } else if (node.completion === 'join') consumed = this.checkJoin(node, data.inputs);
    else if (!this.isFanOut(node) && (data.cause === 'input' || data.cause === 'rework')) consumed = this.checkWhole(node, data.inputs);
    else if (this.isFanOut(node)) consumed = this.deliveredBy(Object.values(data.inputs).flat());
    if (this.isFanOut(node)) {
      const pending = this.pendingEach.get(nodeId);
      for (const key of itemKeys(Object.values(data.inputs).flat())) pending?.delete(key);
    }
    // Fold.
    this.step += 1;
    if (data.supersedes !== undefined) this.setStatus(nodeId, data.supersedes, 'superseded');
    const list = this.execs.get(nodeId) ?? [];
    list.push({ node: nodeId, run, lane, cause: data.cause, inputs: Object.values(data.inputs).flat(), status: data.status, routes: new Map(), items: [], onlyStale: false });
    this.execs.set(nodeId, list);
    const lanes = this.lanes.get(nodeId) ?? new Map<string, number[]>();
    if (group !== undefined && data.cause === 'input' && this.reworked.has(nodeId) && this.groups.has(group) && !lanes.has(lane)) this.counts.extendedGroups += 1;
    lanes.set(lane, [...(lanes.get(lane) ?? []), run]);
    this.lanes.set(nodeId, lanes);
    this.consumed.set(`${nodeId}#${run}`, consumed);
    // A lane's record leaves out its own group when the source just opened it (the lane's generation is its group).
    // A re-run keeps the record its execution got when it was first activated.
    const classes =
      rerunOf !== undefined ? (this.recorded.get(rerunOf) ?? ['free']) : consumed.length === 0 ? ['free'] : consumed.flatMap((source) => this.sourceClasses(source, group));
    this.recorded.set(`${nodeId}#${run}`, classes);
    this.checkBasis(`activation of ${nodeId}/${lane} run ${run}`, data.basis, classes);
    if (group !== undefined) {
      this.laneGroup.set(`${nodeId}#${lane}`, group);
      if (!this.groups.has(group)) this.openGroup(nodeId, group, data.groupParent, data.openedBy);
    }
    this.lastActivation.set(nodeId, this.step);
  }

  /** The executions whose items an activation got (each item's lineage starts at the output it copies). */
  private deliveredBy(items: readonly HandoffItem[]): Source[] {
    const sources = new Map<string, Source>();
    for (const item of items) {
      const ref = item.lineage?.[0];
      if (ref !== undefined) sources.set(`${ref.nodeId}#${ref.run}`, { kind: 'exec', node: ref.nodeId, run: ref.run });
    }
    return [...sources.values()];
  }

  /** The engine's recorded generation must equal what the oracle worked out (`classes`: 'free' or 'g:<group>'). */
  private checkBasis(what: string, basis: Basis | undefined, classes: readonly string[]): void {
    const expected = { groups: [...new Set(classes.filter((c) => c !== 'free').map((c) => c.slice(2)))].sort(), free: classes.includes('free') };
    const actual = { groups: [...(basis?.groups ?? [])].sort(), free: basis?.free === true };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) this.violate(`${what} records basis ${JSON.stringify(actual)}, but it consumed ${JSON.stringify(expected)}`);
  }

  private openGroup(nodeId: string, group: string, parent: string | undefined, claimed: { nodeId: string; run: number } | undefined): void {
    const previous = this.current.get(nodeId);
    // A group is opened by the completion being routed; the engine's claim must agree.
    const opener = this.routing;
    if (JSON.stringify(opener === undefined ? null : { nodeId: opener.node, run: opener.run }) !== JSON.stringify(claimed ?? null)) {
      this.violate(`group ${group} of ${nodeId} was opened by ${opener === undefined ? 'no completion' : `${opener.node} run ${opener.run}`}, but the log says ${claimed === undefined ? 'nobody' : `${claimed.nodeId} run ${claimed.run}`}`);
    }
    if (opener !== undefined) {
      const key = `${opener.node}#${opener.run}`;
      this.opened.set(key, [...(this.opened.get(key) ?? []), group]);
    }
    if (parent !== undefined) this.counts.chainedGroups += 1;
    if (parent === undefined && this.reworked.has(nodeId)) this.violate(`${nodeId} opened a new generation although the same delivery reworks its current one (D-020)`);
    if (previous !== undefined && parent === undefined) {
      this.counts.replans += 1;
      if (this.endRecords.length > 0) this.counts.replansAfterEnd += 1;
      const replacedActive = [...(this.lanes.get(nodeId)?.keys() ?? [])].some(
        (lane) => this.laneGroup.get(`${nodeId}#${lane}`) === previous && ACTIVE.has(this.currentExec(nodeId, lane)?.status ?? ''),
      );
      if (replacedActive) this.counts.replansOverActive += 1;
    }
    this.groups.set(group, { node: nodeId, ...(parent === undefined ? {} : { parent }), passedEdges: [] });
    this.current.set(nodeId, group);
    if (previous !== undefined && parent === undefined) {
      for (const list of this.execs.values()) {
        for (const exec of list) {
          if (!ACTIVE.has(exec.status) || this.laneGroup.has(`${exec.node}#${exec.lane}`)) continue;
          const classes = this.sourceClasses({ kind: 'exec', node: exec.node, run: exec.run });
          const old = classes.some((c) => c !== 'free' && !this.groupLive(c.slice(2)));
          const current = classes.some((c) => c === 'free' || this.groupLive(c.slice(2)));
          if (old && current) this.counts.mixedAtReplan += 1;
        }
      }
    }
  }


  private onCompleted(data: Extract<DomainEvent, { type: 'node.completed' }>['data']): void {
    const exec = this.exec(data.nodeId, data.run);
    if (exec === undefined) {
      this.violate(`completion of unknown execution ${data.nodeId} run ${data.run}`);
      return;
    }
    if (!this.execLive(exec)) this.violate(`${data.nodeId}/${data.lane} run ${data.run} completed in a replaced generation (${this.explain(exec)})`);
    const source = this.node(data.nodeId);
    // D-020: a delivery from a lane-less source that reworks live lanes must not open a new generation.
    this.reworked = new Set();
    if (!this.laneGroup.has(`${data.nodeId}#${data.lane}`)) {
      for (const route of data.routes) {
        const target = this.targetOf(route.edge);
        if (target === undefined || !this.isFanOut(target)) continue;
        if (route.items.some((index) => this.lanesReached(data.output.items[index], target.id).some((lane) => this.laneLive(target.id, lane)))) this.reworked.add(target.id);
      }
    }
    // Item 5: stale items are exactly those that answer only replaced lanes of a fan-out target.
    const stale = (index: number, targetId: string): boolean => {
      const target = this.workflow.nodes.get(targetId);
      return target !== undefined && this.isFanOut(target) && this.onlyOldLanes(data.output.items[index], targetId);
    };
    for (const route of data.routes) {
      for (const index of route.items) {
        if (stale(index, route.to)) this.violate(`item ${index} of ${data.nodeId} run ${data.run} went to ${route.to} but answers only replaced lanes`);
      }
    }
    for (const entry of data.stale ?? []) {
      for (const index of entry.items) {
        if (!stale(index, entry.to)) this.violate(`item ${index} of ${data.nodeId} run ${data.run} was held back as stale but leads to a live lane of ${entry.to}`);
      }
    }
    this.step += 1;
    exec.status = data.status;
    exec.items = data.output.items;
    this.checkBasis(`completion of ${data.nodeId}/${data.lane} run ${data.run}`, data.basis, this.sourceClasses({ kind: 'exec', node: data.nodeId, run: data.run }));
    this.routing = { node: data.nodeId, run: data.run };
    exec.completedAt = this.step;
    exec.routes = new Map([...(data.empty ?? []).map((entry): [number, number[]] => [entry.edge, []]), ...data.routes.map((route): [number, number[]] => [route.edge, route.items])]);
    exec.onlyStale = exec.routes.size === 0 && (data.stale ?? []).length > 0;
    // Remember what has to be taken: items for fan-out targets, deliveries for whole inputs of non-fan-out sources.
    for (const [edge, indexes] of exec.routes) {
      const target = this.targetOf(edge);
      if (target === undefined || target.completion === 'join') continue;
      const port = this.workflow.edges[edge]?.edge.to.port ?? '';
      if (this.isFanOut(target)) {
        const pending = this.pendingEach.get(target.id) ?? new Set<string>();
        for (const item of indexes) pending.add(refKey({ nodeId: data.nodeId, run: data.run, item }));
        this.pendingEach.set(target.id, pending);
      } else if (!this.isFanOut(source)) {
        const keys = indexes.map((item) => refKey({ nodeId: data.nodeId, run: data.run, item }));
        const from: Source = { kind: 'exec', node: data.nodeId, run: data.run };
        this.pendingDirect.set(target.id, [...(this.pendingDirect.get(target.id) ?? []), { edge, port, keys, source: from }]);
      }
    }
    // Item 13: an output that went nowhere only because all its items were stale is no end (D-021).
    if (data.status === 'done' && (this.workflow.ends.includes(data.nodeId) || (exec.routes.size === 0 && !exec.onlyStale))) {
      this.endRecords.push({ kind: 'exec', node: data.nodeId, run: data.run });
    }
  }

  private onPassedOver(data: Extract<DomainEvent, { type: 'node.passedOver' }>['data']): void {
    this.checkBasis(`pass-over of ${data.nodeId}`, data.basis, [`g:${data.group}`]);
    this.step += 1;
    if (!this.groups.has(data.group)) this.openGroup(data.nodeId, data.group, data.groupParent, data.openedBy);
    else if (!this.groupLive(data.group)) this.violate(`${data.nodeId} passed an empty delivery on through replaced group ${data.group}`);
    const group = this.groups.get(data.group);
    if (group !== undefined) {
      group.passedAt = this.step;
      group.passedEdges = data.edges.map((entry) => entry.edge);
    }
    if (data.edges.length === 0) this.endRecords.push({ kind: 'group', group: data.group });
  }

  // -------------------------------------------------------------------------
  // §10.6 definitions

  private isFanOut(node: CompiledNode): boolean {
    return node.inputs.some((port) => port.mode === 'each');
  }

  private targetOf(edge: number): CompiledNode | undefined {
    const to = this.workflow.edges[edge]?.edge.to.node;
    return to === undefined ? undefined : this.workflow.nodes.get(to);
  }

  /** Item 3. */
  private groupLive(groupId: string): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = groupId; id !== undefined; id = this.groups.get(id)?.parent) {
      const group = this.groups.get(id);
      if (seen.has(id) || group === undefined || this.current.get(group.node) !== id) return false;
      seen.add(id);
    }
    return true;
  }

  private laneLive(nodeId: string, lane: string): boolean {
    const group = this.laneGroup.get(`${nodeId}#${lane}`);
    return group === undefined || this.groupLive(group);
  }

  /**
   * Item 3 by brute force, without the engine's `basis`: every path through what an execution consumed, listed in
   * full, each ending at the class that decides it: 'g:<group>' (a fan-out lane's group, or a passed-over group's
   * empty delivery) or 'free' (an execution that consumed nothing). Duplicates are kept on purpose.
   */
  private consumedClasses(node: string, run: number): string[] {
    const sources = this.consumed.get(`${node}#${run}`) ?? [];
    if (sources.length === 0) return ['free'];
    const classes = sources.flatMap((source) => this.sourceClasses(source));
    if (classes.length > 200_000) throw new Error('oracle: too many consumption paths');
    return classes;
  }

  /**
   * The classes of what a source delivers: a fan-out lane's group, a passed-over group, the groups an execution's own
   * deliveries opened (it started those generations, so everything it sends belongs to them), else what it consumed.
   */
  private sourceClasses(source: Source, notOpened?: string): string[] {
    if (source.kind === 'group') return [`g:${source.group}`];
    const exec = this.exec(source.node, source.run);
    if (exec === undefined) return ['free'];
    const group = this.laneGroup.get(`${exec.node}#${exec.lane}`);
    if (group !== undefined) return [`g:${group}`];
    const opened = (this.opened.get(`${exec.node}#${exec.run}`) ?? []).filter((id) => id !== notOpened);
    return opened.length > 0 ? opened.map((id) => `g:${id}`) : this.consumedClasses(exec.node, exec.run);
  }

  /** What an execution consumed and the classes of its paths, for counterexamples. */
  private explain(exec: Exec): string {
    const sources = (this.consumed.get(`${exec.node}#${exec.run}`) ?? []).map((source) => (source.kind === 'group' ? `group ${source.group}` : `${source.node} run ${source.run}`));
    const classes = [...new Set(this.consumedClasses(exec.node, exec.run))].map((c) => (c === 'free' ? 'free' : `${c.slice(2)}:${this.groupLive(c.slice(2)) ? 'live' : 'old'}`));
    return `consumed [${sources.join(', ')}], paths end at [${classes.join(', ')}]`;
  }

  /** Item 13: a path end of the current generation exists. */
  private endedNow(): boolean {
    return this.endRecords.some((end) => {
      if (end.kind === 'group') return this.groupLive(end.group);
      const exec = this.exec(end.node, end.run);
      return exec !== undefined && this.execLive(exec);
    });
  }

  /** Item 3: an execution of the current generation: a live lane's, or one with a path to something current. */
  private execLive(exec: Exec): boolean {
    if (this.laneGroup.has(`${exec.node}#${exec.lane}`)) return this.laneLive(exec.node, exec.lane);
    return this.sourceClasses({ kind: 'exec', node: exec.node, run: exec.run }).some((c) => c === 'free' || this.groupLive(c.slice(2)));
  }

  private currentExec(nodeId: string, lane: string): Exec | undefined {
    const run = this.lanes.get(nodeId)?.get(lane)?.at(-1);
    return run === undefined ? undefined : this.exec(nodeId, run);
  }

  private hasActive(nodeId: string): boolean {
    return (this.execs.get(nodeId) ?? []).some((exec) => ACTIVE.has(exec.status));
  }

  /** Item 5: the item's lineage reaches lanes of `target`, all of them replaced. */
  private onlyOldLanes(item: HandoffItem | undefined, target: string): boolean {
    const lanes = this.lanesReached(item, target);
    return lanes.length > 0 && lanes.every((lane) => !this.laneLive(target, lane));
  }

  /** Lanes of `target` the item's lineage leads to (each path stops at the first output of `target`). */
  private lanesReached(item: HandoffItem | undefined, target: string): string[] {
    const lanes: string[] = [];
    const seen = new Set<string>();
    const queue = [...(item?.lineage ?? [])];
    while (queue.length > 0) {
      const ref = queue.shift() as ItemRef;
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const exec = this.exec(ref.nodeId, ref.run);
      if (ref.nodeId === target) {
        if (exec !== undefined) lanes.push(exec.lane);
        continue;
      }
      queue.push(...(exec?.items[ref.item]?.lineage ?? []));
    }
    return lanes;
  }

  /** Items 7 and 8. */
  private contribution(source: string, edges: readonly number[], since: number): { execs: Exec[]; fresh: boolean; group?: string } {
    let candidates: Exec[];
    if (this.isFanOut(this.node(source))) {
      const group = this.current.get(source);
      if (group === undefined || !this.groupLive(group)) return { execs: [], fresh: false };
      candidates = [...(this.lanes.get(source)?.keys() ?? [])]
        .filter((lane) => this.laneGroup.get(`${source}#${lane}`) === group)
        .map((lane) => this.currentExec(source, lane))
        .filter((exec): exec is Exec => exec !== undefined && SETTLED.has(exec.status));
      const info = this.groups.get(group);
      const passedHere = info?.passedAt !== undefined && info.passedEdges.some((edge) => edges.includes(edge));
      const execs = candidates.filter((exec) => edges.some((edge) => exec.routes.has(edge)));
      if (execs.length === 0 && !passedHere) return { execs, fresh: false };
      return { execs, fresh: (passedHere && (info.passedAt ?? 0) > since) || execs.some((exec) => (exec.completedAt ?? 0) > since), group };
    } else {
      let latest: Exec | undefined;
      for (const exec of this.execs.get(source) ?? []) {
        if (SETTLED.has(exec.status) && (latest === undefined || (exec.completedAt ?? 0) > (latest.completedAt ?? 0))) latest = exec;
      }
      candidates = latest === undefined || !this.execLive(latest) ? [] : [latest];
    }
    const execs = candidates.filter((exec) => edges.some((edge) => exec.routes.has(edge)));
    return { execs, fresh: execs.some((exec) => (exec.completedAt ?? 0) > since) };
  }

  private contributedKeys(source: string, edges: readonly number[], since: number): string[] {
    return this.contribution(source, edges, since).execs.flatMap((exec) =>
      edges.flatMap((edge) => (exec.routes.get(edge) ?? []).map((item) => refKey({ nodeId: source, run: exec.run, item }))),
    );
  }

  /** What a source gives as consumption: its contributing group (fan-out) or its contributing execution. */
  private contributionSource(source: string, edges: readonly number[], since: number): Source[] {
    const contributed = this.contribution(source, edges, since);
    if (contributed.group !== undefined) return [{ kind: 'group', group: contributed.group }];
    return contributed.execs.map((exec) => ({ kind: 'exec', node: exec.node, run: exec.run }));
  }

  /** Item 9, first part. */
  private busy(source: string): boolean {
    if (this.hasActive(source)) return true;
    const seen = new Set<string>();
    for (let id = this.current.get(source); id !== undefined && !seen.has(id); id = this.groups.get(id)?.parent) {
      seen.add(id);
      const owner = this.groups.get(id)?.node;
      if (owner === undefined) break;
      for (const lane of this.lanes.get(owner)?.keys() ?? []) {
        if (this.laneGroup.get(`${owner}#${lane}`) === id && ACTIVE.has(this.currentExec(owner, lane)?.status ?? '')) return true;
      }
    }
    return false;
  }

  /** Item 9, second part. */
  private reachableFromActive(source: string, join: string): boolean {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const nodeId of this.workflow.nodes.keys()) {
      if (nodeId !== join && this.hasActive(nodeId)) {
        seen.add(nodeId);
        queue.push(nodeId);
      }
    }
    while (queue.length > 0) {
      const nodeId = queue.shift() as string;
      if (nodeId === source) return true;
      for (const indexes of this.node(nodeId).outgoing.values()) {
        for (const index of indexes) {
          const next = this.workflow.edges[index]?.edge.to.node;
          if (next !== undefined && next !== join && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
    return false;
  }

  private sources(target: CompiledNode, filter: (edge: number) => boolean = () => true): Map<string, number[]> {
    const bySource = new Map<string, number[]>();
    for (const index of target.incoming) {
      const from = this.workflow.edges[index]?.edge.from.node;
      if (from !== undefined && filter(index)) bySource.set(from, [...(bySource.get(from) ?? []), index]);
    }
    return bySource;
  }

  /** Item 10: why the join cannot run now, or undefined when it can. */
  private joinBlocker(join: CompiledNode): string | undefined {
    const since = this.lastActivation.get(join.id) ?? 0;
    let fresh = false;
    for (const [source, edges] of this.sources(join)) {
      if (this.busy(source)) return `its source ${source} is busy`;
      if (this.contribution(source, edges, since).fresh) fresh = true;
      else if (this.reachableFromActive(source, join.id)) return `its source ${source} can still be reached from active work`;
    }
    return fresh ? undefined : 'no source has a new contribution';
  }

  private joinInput(join: CompiledNode, port: string): string[] {
    const since = this.lastActivation.get(join.id) ?? 0;
    return [...this.sources(join)].flatMap(([source, edges]) =>
      this.contributedKeys(source, edges.filter((edge) => this.workflow.edges[edge]?.edge.to.port === port), since),
    );
  }

  /** Item 11: the fan-out sources a fan-in would take now. */
  private readyFanIns(target: CompiledNode): Map<string, number[]> {
    const since = this.lastActivation.get(target.id) ?? 0;
    const whole = new Set(target.inputs.filter((port) => port.mode === 'whole').map((port) => port.name));
    const ready = new Map<string, number[]>();
    for (const [source, edges] of this.sources(target, (edge) => whole.has(this.workflow.edges[edge]?.edge.to.port ?? ''))) {
      if (this.isFanOut(this.node(source)) && !this.busy(source) && this.contribution(source, edges, since).fresh) ready.set(source, edges);
    }
    return ready;
  }

  private checkJoin(join: CompiledNode, inputs: Readonly<Record<string, readonly HandoffItem[]>>): Source[] {
    this.counts.joinRuns += 1;
    if (this.sources(join).size >= 2) this.counts.multiSourceJoinRuns += 1;
    const since = this.lastActivation.get(join.id) ?? 0;
    const consumed = [...this.sources(join)].flatMap(([source, edges]) => this.contributionSource(source, edges, since));
    const blocker = this.joinBlocker(join);
    if (blocker !== undefined) {
      this.violate(`join ${join.id} ran although ${blocker}`);
      return consumed;
    }
    for (const port of join.inputs) {
      const actual = itemKeys(inputs[port.name] ?? []).join(',');
      const expected = this.joinInput(join, port.name).join(',');
      if (actual !== expected) this.violate(`join ${join.id} took [${actual}] on '${port.name}', but the contributions are [${expected}]`);
    }
    return consumed;
  }

  /** A whole-input activation is a direct delivery (item 11, last sentence) or a fan-in that is ready. */
  private checkWhole(target: CompiledNode, inputs: Readonly<Record<string, readonly HandoffItem[]>>): Source[] {
    const pending = this.pendingDirect.get(target.id) ?? [];
    const direct = pending.findIndex((entry) => itemKeys(inputs[entry.port] ?? []).join(',') === entry.keys.join(','));
    if (direct >= 0) {
      const [taken] = pending.splice(direct, 1);
      return taken === undefined ? [] : [taken.source, ...this.otherPorts(target, new Set([taken.port]))];
    }
    const ready = this.readyFanIns(target);
    if (ready.size === 0) {
      this.violate(`${target.id} ran with no direct delivery waiting and no fan-in ready`);
      return [];
    }
    this.counts.fanInRuns += 1;
    const since = this.lastActivation.get(target.id) ?? 0;
    const expected = new Map<string, string[]>();
    for (const [source, edges] of ready) {
      for (const edge of edges) {
        const port = this.workflow.edges[edge]?.edge.to.port ?? '';
        expected.set(port, [...(expected.get(port) ?? []), ...this.contributedKeys(source, [edge], since)]);
      }
    }
    for (const [port, keys] of expected) {
      const actual = itemKeys(inputs[port] ?? []).join(',');
      if (actual !== keys.join(',')) this.violate(`fan-in ${target.id} took [${actual}] on '${port}', but the contributions are [${keys.join(',')}]`);
    }
    const given = new Set([...ready.values()].flat().map((edge) => this.workflow.edges[edge]?.edge.to.port ?? ''));
    return [...[...ready].flatMap(([source, edges]) => this.contributionSource(source, edges, since)), ...this.otherPorts(target, given)];
  }

  /** What a whole-input activation consumes on the ports it was not activated for: each edge's latest delivery. */
  private otherPorts(target: CompiledNode, given: ReadonlySet<string>): Source[] {
    return target.inputs
      .filter((port) => !given.has(port.name))
      .flatMap((port) => target.incoming.filter((edge) => this.workflow.edges[edge]?.edge.to.port === port.name))
      .flatMap((edge) => {
        const from = this.workflow.edges[edge]?.edge.from.node;
        if (from === undefined) return [];
        if (this.isFanOut(this.node(from))) return this.contributionSource(from, [edge], 0);
        let latest: Exec | undefined;
        for (const exec of this.execs.get(from) ?? []) {
          if (exec.completedAt !== undefined && exec.routes.has(edge) && (latest === undefined || exec.completedAt > (latest.completedAt ?? 0))) latest = exec;
        }
        return latest === undefined || !this.execLive(latest) ? [] : [{ kind: 'exec' as const, node: latest.node, run: latest.run }];
      });
  }

  // -------------------------------------------------------------------------
  // Ticket end and progress

  /** Item 14. */
  waitReasons(): OracleReason[] {
    const reasons: OracleReason[] = [];
    for (const [nodeId, list] of this.execs) {
      for (const exec of list) if (ACTIVE.has(exec.status)) reasons.push({ nodeId, lane: exec.lane, kind: 'active' });
      for (const lane of this.lanes.get(nodeId)?.keys() ?? []) {
        const exec = this.currentExec(nodeId, lane);
        if (exec === undefined || exec.routes.size > 0 || !this.execLive(exec)) continue;
        if (exec.status === 'failed') reasons.push({ nodeId, lane, kind: 'failed' });
        else if (exec.status === 'done' && exec.onlyStale) reasons.push({ nodeId, lane, kind: 'stale' });
      }
    }
    return reasons;
  }

  /** Lanes that wait for a person (review) or a retry (unhandled failure, stale output): what the test may act on. */
  actionable(): OracleReason[] {
    return this.waitReasons().filter((reason) => reason.kind !== 'active' || this.currentExec(reason.nodeId, reason.lane)?.status === 'review');
  }

  /** Progress, for a moment when the engine has nothing left to do. */
  idleProblems(): string[] {
    const problems: string[] = [];
    for (const node of this.workflow.nodes.values()) {
      if (node.completion === 'join') {
        if (this.joinBlocker(node) === undefined) problems.push(`join ${node.id} could run but did not`);
      } else if (!this.isFanOut(node)) {
        const ready = this.readyFanIns(node);
        if (ready.size > 0) problems.push(`fan-in ${node.id} from ${[...ready.keys()].join(', ')} could run but did not`);
      }
    }
    for (const [target, keys] of this.pendingEach) if (keys.size > 0) problems.push(`items [${[...keys].join(',')}] sent to ${target} were never taken`);
    for (const [target, entries] of this.pendingDirect) {
      for (const entry of entries) problems.push(`the delivery over edge ${entry.edge} to ${target} never activated it`);
    }
    for (const [nodeId, lanes] of this.lanes) {
      for (const lane of lanes.keys()) {
        const exec = this.currentExec(nodeId, lane);
        if (exec !== undefined && ACTIVE.has(exec.status) && !this.execLive(exec)) problems.push(`${nodeId}/${lane} run ${exec.run} is active but belongs to a replaced generation (${this.explain(exec)})`);
      }
    }
    const reasons = this.waitReasons();
    if (!this.done && reasons.length === 0) problems.push(`open ticket without a wait reason (a current path ended: ${String(this.endedNow())})`);
    if (this.done && reasons.length > 0) problems.push('done ticket with a wait reason');
    return problems;
  }
}
