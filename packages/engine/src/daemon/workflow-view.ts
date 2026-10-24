import type { PinnedTemplate, WorkflowEdgeView, WorkflowNodeView, WorkflowView } from '@vuyro/contracts';
import type { CompiledWorkflow } from '../workflow/compile.ts';

/**
 * A compiled workflow as screens draw it (M6): nodes in stage order and edges with their loop flag. Stage order is
 * topological over forward edges (back edges are the rework loops), ties broken by position (x, then y) and then by
 * the template's own order, so a board's columns read left to right like the graph.
 */
export function workflowView(workflow: CompiledWorkflow, pin: Pick<PinnedTemplate, 'id' | 'version' | 'hash'>): WorkflowView {
  const { template } = workflow;
  const templateOrder = new Map(template.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map<string, number>([...workflow.nodes.keys()].map((id) => [id, 0]));
  const forward = workflow.edges.filter((edge) => !edge.back);
  for (const edge of forward) indegree.set(edge.edge.to.node, (indegree.get(edge.edge.to.node) ?? 0) + 1);
  const rank = (id: string): [number, number, number] => {
    const position = workflow.nodes.get(id)?.instance.position;
    return [position?.x ?? Number.POSITIVE_INFINITY, position?.y ?? Number.POSITIVE_INFINITY, templateOrder.get(id) ?? 0];
  };
  const before = (a: string, b: string): number => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  };
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(before);
    const id = ready.shift() as string;
    order.push(id);
    for (const edge of forward) {
      if (edge.edge.from.node !== id) continue;
      const left = (indegree.get(edge.edge.to.node) ?? 0) - 1;
      indegree.set(edge.edge.to.node, left);
      if (left === 0) ready.push(edge.edge.to.node);
    }
  }
  // A forward cycle cannot be saved, but never drop a node from the view if one slipped through.
  for (const id of [...workflow.nodes.keys()].sort(before)) if (!order.includes(id)) order.push(id);

  const nodes = order.map((id): WorkflowNodeView => {
    const node = workflow.nodes.get(id);
    if (node === undefined) throw new Error(`workflow view: unknown node ${id}`);
    const position = node.instance.position;
    return {
      id,
      label: node.label,
      type: node.instance.type,
      typeVersion: node.instance.version,
      completion: node.completion,
      review: node.review,
      ...(position === undefined ? {} : { position: { x: position.x, y: position.y } }),
      outputs: [...node.outputs.values()].map((port) => ({ name: port.name, label: port.label })),
      inputMode: node.inputs[0]?.mode ?? 'none',
    };
  });
  const edges = workflow.edges.map(
    (edge): WorkflowEdgeView => ({
      from: { node: edge.edge.from.node, port: edge.edge.from.port },
      to: { node: edge.edge.to.node, port: edge.edge.to.port },
      back: edge.back,
      ...(edge.edge.label === undefined ? {} : { label: edge.edge.label }),
    }),
  );
  return {
    id: pin.id,
    version: pin.version,
    hash: pin.hash,
    name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    nodes,
    edges,
  };
}
