import type { NodeStats, WorkflowView } from '@vuyro/contracts';
import { laneTone, stageHint, type Tone } from './board-model.ts';
import { formatDuration, formatTokens, statusLabel } from './format.ts';

/**
 * The graph canvas (시안 01) as data: where each node sits, what colour its state paints it, and which edges loop back.
 * Pure functions, so the layout and the painting are tested without a canvas.
 */

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 96;
const COLUMN = 250;
const ROW = 136;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Positions from the template when every node has one; otherwise columns by stage (longest path over forward edges
 * from the entry nodes) and rows in stage order, centred.
 */
export function layoutWorkflow(workflow: WorkflowView): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (workflow.nodes.length > 0 && workflow.nodes.every((node) => node.position !== undefined)) {
    for (const node of workflow.nodes) positions.set(node.id, { x: node.position?.x ?? 0, y: node.position?.y ?? 0 });
    return positions;
  }
  // Nodes come in stage order (topological over forward edges), so one pass finds each node's depth.
  const depth = new Map<string, number>(workflow.nodes.map((node) => [node.id, 0]));
  for (const node of workflow.nodes) {
    for (const edge of workflow.edges) {
      if (edge.back || edge.from.node !== node.id) continue;
      depth.set(edge.to.node, Math.max(depth.get(edge.to.node) ?? 0, (depth.get(node.id) ?? 0) + 1));
    }
  }
  const columns = new Map<number, string[]>();
  for (const node of workflow.nodes) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  for (const [column, ids] of columns) {
    ids.forEach((id, row) => {
      positions.set(id, { x: column * COLUMN, y: Math.round((row - (ids.length - 1) / 2) * ROW) });
    });
  }
  return positions;
}

/** A lane of the ticket as the canvas needs it. */
export interface CanvasLane {
  readonly nodeId: string;
  readonly lane: string;
  readonly status: string;
}

export interface GraphNodeModel {
  readonly id: string;
  readonly label: string;
  readonly hint: { readonly text: string; readonly tone: Tone };
  readonly position: Point;
  /** The state colour (wait when there is no ticket or the node has not started). */
  readonly tone: Tone;
  /** `실행 중`, `완료 2 · 실행 중 1`, or empty without lanes. */
  readonly state: string;
  /** Time and tokens, when the ticket has statistics. */
  readonly metric?: string;
}

export interface GraphEdgeModel {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly back: boolean;
  readonly label?: string;
}

function stateText(statuses: readonly string[]): string {
  if (statuses.length === 0) return '';
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  if (counts.size === 1 && statuses.length === 1) return statusLabel(statuses[0] ?? '');
  return [...counts].map(([status, count]) => `${statusLabel(status)} ${count}`).join(' · ');
}

function metricText(stats: NodeStats | undefined): string | undefined {
  if (stats === undefined) return undefined;
  const parts: string[] = [];
  const time = stats.runningMs + stats.humanWaitMs;
  if (time > 0) parts.push(formatDuration(time));
  const tokens = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite + stats.tokens.output;
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Nodes and edges to draw: the workflow, painted with the ticket's lanes and statistics when given. */
export function graphModel(workflow: WorkflowView, lanes: readonly CanvasLane[] = [], stats: readonly NodeStats[] = []): { nodes: GraphNodeModel[]; edges: GraphEdgeModel[] } {
  const positions = layoutWorkflow(workflow);
  const byNode = new Map(stats.map((each) => [each.nodeId, each]));
  const nodes = workflow.nodes.map((node): GraphNodeModel => {
    const statuses = lanes.filter((lane) => lane.nodeId === node.id).map((lane) => lane.status);
    const metric = metricText(byNode.get(node.id));
    return {
      id: node.id,
      label: node.label,
      hint: stageHint(node),
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      tone: laneTone(statuses, node),
      state: stateText(statuses),
      ...(metric === undefined ? {} : { metric }),
    };
  });
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.map((edge, index): GraphEdgeModel => {
    const source = byId.get(edge.from.node);
    // A port name tells which way a decision went (approve / reject); a node with one output needs no label.
    const port = (source?.outputs.length ?? 0) > 1 ? (source?.outputs.find((output) => output.name === edge.from.port)?.label ?? edge.from.port) : undefined;
    const label = edge.label ?? port;
    return {
      id: `${edge.from.node}:${edge.from.port}>${edge.to.node}:${edge.to.port}#${index}`,
      source: edge.from.node,
      target: edge.to.node,
      back: edge.back,
      ...(label === undefined ? {} : { label }),
    };
  });
  return { nodes, edges };
}

/** The node a ticket's graph opens on: the first one that is neither waiting nor done (what holds it up now). */
export function focusNode(nodes: readonly GraphNodeModel[]): string | undefined {
  return (nodes.find((node) => node.tone !== 'wait' && node.tone !== 'done') ?? nodes[0])?.id;
}

/** Below this the node text is too small to read. */
export const READABLE_ZOOM = 0.8;
const MARGIN = 24;

/**
 * The first viewport: undefined when the whole graph fits at a readable zoom (then it is fitted); otherwise the
 * readable zoom with `focus` (a node's top-left) centred, kept so the graph's ends do not leave empty space.
 */
export function initialViewport(
  bounds: { x: number; y: number; width: number; height: number },
  view: { width: number; height: number },
  focus: Point | undefined,
): { x: number; y: number; zoom: number } | undefined {
  const fit = Math.min((view.width - 2 * MARGIN) / bounds.width, (view.height - 2 * MARGIN) / bounds.height);
  if (fit >= READABLE_ZOOM) return undefined;
  const zoom = READABLE_ZOOM;
  const centreX = (focus?.x ?? bounds.x) + NODE_WIDTH / 2;
  let x = view.width / 2 - centreX * zoom;
  // Do not scroll past the graph's left or right end.
  x = Math.min(x, MARGIN - bounds.x * zoom);
  x = Math.max(x, Math.min(MARGIN - bounds.x * zoom, view.width - MARGIN - (bounds.x + bounds.width) * zoom));
  const y = view.height / 2 - (bounds.y + bounds.height / 2) * zoom;
  return { x: Math.round(x), y: Math.round(y), zoom };
}
