import '@xyflow/react/dist/style.css';

import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  ReactFlow,
} from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';

import { CardNode, type CardFlowNode } from '@/features/mindmap/CardNode';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const NODE_TYPES = { card: CardNode };
type Measured = NonNullable<CardFlowNode['measured']>;

/**
 * The store owns graph state; React Flow is a controlled view of it. Measured
 * sizes and edge selection are purely presentational, so they stay local.
 */
export function MindMapPane() {
  const nodes = useStudySyncStore((state) => state.nodes);
  const edges = useStudySyncStore((state) => state.edges);
  const selectedNodeId = useStudySyncStore((state) => state.selectedNodeId);
  const initialViewport = useStudySyncStore((state) => state.notebook?.viewport);
  const selectNode = useStudySyncStore((state) => state.selectNode);
  const dragNode = useStudySyncStore((state) => state.dragNode);
  const commitNodeLayout = useStudySyncStore((state) => state.commitNodeLayout);
  const connectNodes = useStudySyncStore((state) => state.connectNodes);
  const removeEdge = useStudySyncStore((state) => state.removeEdge);
  const saveViewport = useStudySyncStore((state) => state.saveViewport);

  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());

  const flowNodes = useMemo<CardFlowNode[]>(
    () =>
      nodes.map((node) => {
        const size = measured[node.id];
        return {
          id: node.id,
          type: 'card',
          position: { x: node.posX, y: node.posY },
          data: { cardId: node.cardId },
          selected: node.id === selectedNodeId,
          deletable: false,
          ...(size ? { measured: size } : {}),
        };
      }),
    [nodes, measured, selectedNodeId],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        selected: selectedEdgeIds.has(edge.id),
        ...(edge.label === null ? {} : { label: edge.label }),
      })),
    [edges, selectedEdgeIds],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CardFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          dragNode(change.id, change.position.x, change.position.y);
        } else if (change.type === 'dimensions' && change.dimensions) {
          const { dimensions, id } = change;
          setMeasured((current) => ({ ...current, [id]: dimensions }));
        } else if (change.type === 'select') {
          if (change.selected) {
            selectNode(change.id);
          } else if (useStudySyncStore.getState().selectedNodeId === change.id) {
            selectNode(null);
          }
        }
      }
    },
    [dragNode, selectNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'select') {
          setSelectedEdgeIds((current) => {
            const next = new Set(current);
            if (change.selected) next.add(change.id);
            else next.delete(change.id);
            return next;
          });
        } else if (change.type === 'remove') {
          void removeEdge(change.id);
        }
      }
    },
    [removeEdge],
  );

  const onConnect = useCallback(
    ({ source, target }: Connection) => void connectNodes(source, target),
    [connectNodes],
  );

  return (
    <section aria-label="MindMap canvas" className="h-full">
      <ReactFlow<CardFlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={(_event, node) => void commitNodeLayout(node.id)}
        onMoveEnd={(_event, viewport) => void saveViewport(viewport)}
        {...(initialViewport ? { defaultViewport: initialViewport } : {})}
        minZoom={0.1}
        maxZoom={2.5}
        multiSelectionKeyCode={null}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </section>
  );
}
