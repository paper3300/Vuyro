import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  type Edge,
  getNodesBounds,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type { NodeStats, WorkflowView } from '@vuyro/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { type CanvasLane, focusNode, type GraphNodeModel, graphModel, initialViewport, NODE_HEIGHT, NODE_WIDTH } from '../graph-model.ts';
import { Chip, TONE_BAR } from './ui.tsx';

/**
 * The graph canvas (시안 01, @xyflow/react): a ticket's pinned workflow, or a template's for a preview. Nodes are
 * painted by their lanes' state and repaint as events arrive; rework loops are dashed and run underneath. View only:
 * nodes can be dragged around, but positions are not saved (no editor in the MVP).
 */

type StageData = GraphNodeModel & { readonly selected: boolean } & Record<string, unknown>;
type StageNode = Node<StageData, 'stage'>;

const BORDER: Readonly<Record<GraphNodeModel['tone'], string>> = {
  done: 'border-done/50',
  agent: 'border-agent/60',
  human: 'border-human/60',
  rejected: 'border-rejected/60',
  failed: 'border-failed/60',
  paused: 'border-stale/60',
  stale: 'border-stale/60',
  wait: 'border-line',
};

/** Handles only anchor the edges (nothing can be connected by hand). */
const HIDDEN_HANDLE = { opacity: 0, pointerEvents: 'none' } as const;

/**
 * The first view: the whole graph when it fits at a readable size; otherwise readable size, centred on the node that
 * matters now (the selected one, else the first that is not waiting or done), kept inside the graph's edges.
 */
function InitialView({ focus }: { focus: string | undefined }) {
  const flow = useReactFlow<StageNode>();
  const initialized = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const done = useRef(false);
  useEffect(() => {
    if (!initialized || done.current || width === 0 || height === 0) return;
    done.current = true;
    const nodes = flow.getNodes();
    const at = nodes.find((node) => node.id === focus)?.position;
    const viewport = initialViewport(getNodesBounds(nodes), { width, height }, at);
    if (viewport === undefined) void flow.fitView({ padding: 0.15 });
    else void flow.setViewport(viewport);
  }, [initialized, width, height, flow, focus]);
  return null;
}

function StageNodeView({ data }: NodeProps<StageNode>) {
  return (
    <div
      aria-label={`노드 ${data.label}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex overflow-hidden rounded-[10px] border-2 bg-white shadow-sm ${data.selected ? 'border-agent ring-4 ring-agent/15' : BORDER[data.tone]}`}
    >
      <span className={`w-1.5 flex-none ${TONE_BAR[data.tone]}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2">
        <span className="truncate text-[13px] leading-tight font-semibold" title={data.label}>
          {data.label}
        </span>
        <span className="truncate text-[11px] text-muted">{data.hint.text}</span>
        {data.state !== '' && (
          <span className="self-start">
            <Chip tone={data.tone}>{data.state}</Chip>
          </span>
        )}
        {data.metric !== undefined && <span className="truncate font-mono text-[10.5px] text-muted">{data.metric}</span>}
      </div>
      {/* Forward edges enter on the left and leave on the right; rework loops leave and enter at the bottom. */}
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Bottom} id="back-out" isConnectable={false} style={{ ...HIDDEN_HANDLE, left: '70%' }} />
      <Handle type="target" position={Position.Bottom} id="back-in" isConnectable={false} style={{ ...HIDDEN_HANDLE, left: '30%' }} />
    </div>
  );
}

const NODE_TYPES = { stage: StageNodeView };

export function WorkflowCanvas({
  workflow,
  lanes,
  stats,
  selected,
  onSelect,
  height = 520,
  label = '워크플로 그래프',
}: {
  workflow: WorkflowView;
  lanes?: readonly CanvasLane[] | undefined;
  stats?: readonly NodeStats[] | undefined;
  selected?: string | undefined;
  onSelect?: ((nodeId: string) => void) | undefined;
  height?: number;
  label?: string;
}) {
  const model = useMemo(() => graphModel(workflow, lanes, stats), [workflow, lanes, stats]);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(
    model.nodes.map((node) => ({ id: node.id, type: 'stage', position: node.position, data: { ...node, selected: node.id === selected }, connectable: false, deletable: false })),
  );
  // New state repaints the nodes; where a person dragged a node (and what was measured) stays.
  useEffect(() => {
    setNodes((previous) => {
      const before = new Map(previous.map((node) => [node.id, node]));
      return model.nodes.map((node): StageNode => {
        const old = before.get(node.id);
        return {
          ...(old ?? {}),
          id: node.id,
          type: 'stage',
          position: old?.position ?? node.position,
          data: { ...node, selected: node.id === selected },
          connectable: false,
          deletable: false,
        };
      });
    });
  }, [model, selected, setNodes]);
  const edges = useMemo(
    () =>
      model.edges.map((edge): Edge => {
        const color = edge.back ? 'var(--color-rejected)' : '#9aa1ad';
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.back ? 'back-out' : 'out',
          targetHandle: edge.back ? 'back-in' : 'in',
          type: 'smoothstep',
          ...(edge.back ? { pathOptions: { offset: 36 } } : {}),
          ...(edge.label === undefined ? {} : { label: edge.label, labelStyle: { fill: edge.back ? 'var(--color-rejected)' : 'var(--color-muted)', fontSize: 11 }, labelBgStyle: { fill: '#ffffff' } }),
          style: { stroke: color, strokeWidth: 1.75, ...(edge.back ? { strokeDasharray: '6 4' } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          focusable: false,
          deletable: false,
        };
      }),
    [model],
  );

  return (
    <div role="group" aria-label={label} style={{ height }} className="relative overflow-hidden rounded-xl border border-line bg-white">
      <ReactFlow<StageNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => onSelect?.(node.id)}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={onSelect !== undefined}
        deleteKeyCode={null}
        minZoom={0.3}
        maxZoom={1.75}
      >
        <InitialView focus={selected ?? focusNode(model.nodes)} />
        <Background gap={18} color="#dfe3ea" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
