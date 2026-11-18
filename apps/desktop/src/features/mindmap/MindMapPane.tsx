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
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { isEditableShortcutTarget } from '@/features/commands/registry';
import { CardNode, type CardFlowNode } from '@/features/mindmap/CardNode';
import {
  MIN_REVEAL_ZOOM,
  prefersReducedMotion,
  REVEAL_DURATION_MS,
  viewportRevealing,
} from '@/features/mindmap/reveal';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const NODE_TYPES = { card: CardNode };
type Measured = NonNullable<CardFlowNode['measured']>;
/** A card's size until React Flow has measured it: `w-60`, about three lines tall. */
const UNMEASURED_CARD = { width: 240, height: 96 };

/**
 * The store owns graph state; React Flow is a controlled view of it. Measured
 * sizes and edge selection are purely presentational, so they stay local.
 *
 * `open` is whether the pane is showing: a collapsed pane stays mounted, and a
 * card it is asked to reveal waits until it opens.
 */
export function MindMapPane({ open }: { open: boolean }) {
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

  const sectionRef = useRef<HTMLElement>(null);
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

  // Esc on the canvas puts the selection away, and with it the nesting target.
  useEscapeLayer(
    ESCAPE_LAYER.mindMap,
    open
      ? (event) => {
          const { target } = event;
          if (!(target instanceof Node) || !sectionRef.current?.contains(target)) return false;
          if (isEditableShortcutTarget(target)) return false;
          const { selectedNodeId: selected, nestingTargetNodeId } = useStudySyncStore.getState();
          if (selected === null && nestingTargetNodeId === null) return false;
          selectNode(null);
          return true;
        }
      : null,
  );

  return (
    <section ref={sectionRef} aria-label="MindMap canvas" className="h-full">
      <ReactFlow<CardFlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        // React Flow reports no change for a click on a card that is already
        // selected, as one an excerpt selected is; the click still chooses it.
        onNodeClick={(_event, node) => selectNode(node.id)}
        onPaneClick={() => selectNode(null)}
        onNodeDragStop={(_event, node) => void commitNodeLayout(node.id)}
        onMoveEnd={(_event, viewport) => void saveViewport(viewport)}
        {...(initialViewport ? { defaultViewport: initialViewport } : {})}
        minZoom={MIN_REVEAL_ZOOM}
        maxZoom={2.5}
        multiSelectionKeyCode={null}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
        <RevealOnRequest open={open} />
      </ReactFlow>
    </section>
  );
}

/** Pans to a card the store asks to reveal, if it is not already fully in view. */
function RevealOnRequest({ open }: { open: boolean }) {
  const request = useStudySyncStore((state) => state.revealRequest);
  const node = useStudySyncStore((state) =>
    request ? state.nodes.find((candidate) => candidate.id === request.nodeId) : undefined,
  );
  const completeReveal = useStudySyncStore((state) => state.completeReveal);
  const domNode = useStore((state) => state.domNode);
  // A pane that has only just expanded may not be laid out yet; its next
  // measurement runs this again.
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const { getInternalNode, getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    if (!request || !open) return;
    if (!node) {
      completeReveal(request.nonce);
      return;
    }
    const pane = domNode?.getBoundingClientRect();
    if (!pane || pane.width === 0 || pane.height === 0) return;
    const size = getInternalNode(node.id)?.measured;
    const next = viewportRevealing(
      {
        x: node.posX,
        y: node.posY,
        width: size?.width ?? UNMEASURED_CARD.width,
        height: size?.height ?? UNMEASURED_CARD.height,
      },
      getViewport(),
      pane,
    );
    if (next) {
      void setViewport(next, { duration: prefersReducedMotion() ? 0 : REVEAL_DURATION_MS });
    }
    completeReveal(request.nonce);
  }, [
    request,
    open,
    node,
    domNode,
    paneWidth,
    paneHeight,
    completeReveal,
    getInternalNode,
    getViewport,
    setViewport,
  ]);

  return null;
}
