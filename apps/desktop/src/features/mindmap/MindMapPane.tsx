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
import { Link2, Pencil, Trash2 } from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { commandDefinition, formatShortcut } from '@/features/commands/commands';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { isEditableShortcutTarget, runCommand, useCommands } from '@/features/commands/registry';
import { cardAriaLabel, edgeAriaLabel, mindMapAriaLabelConfig } from '@/features/mindmap/a11y';
import { CardNode, type CardFlowNode } from '@/features/mindmap/CardNode';
import type { NodeSize } from '@/features/mindmap/placement';
import {
  MIN_REVEAL_ZOOM,
  prefersReducedMotion,
  REVEAL_DURATION_MS,
  viewportRevealing,
} from '@/features/mindmap/reveal';
import { registerBeforeCloseFlush } from '@/lib/flushBeforeClose';
import { formatCardSource } from '@/lib/sourceAttribution';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const NODE_TYPES = { card: CardNode };
type Measured = NonNullable<CardFlowNode['measured']>;
/** A card's size until React Flow has measured it: `w-60`, about three lines tall. */
const UNMEASURED_CARD = { width: 240, height: 96 };
/** Coalesces rapid arrow-key nudges into one layout write (#182). */
export const KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS = 300;

interface CardMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function focusedCanvasNodeId(container: HTMLElement | null): string | null {
  if (!container) return null;
  const active = document.activeElement;
  if (!(active instanceof Element) || !container.contains(active)) return null;
  return active.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id ?? null;
}

/**
 * The store owns graph state; React Flow is a controlled view of it. Measured
 * sizes, edge selection, and the card context menu are purely presentational,
 * so they stay local.
 *
 * `open` is whether the pane is showing: a collapsed pane stays mounted, and a
 * card it is asked to reveal waits until it opens.
 */
export function MindMapPane({
  open,
  inspectorOpen = false,
}: {
  open: boolean;
  inspectorOpen?: boolean;
}) {
  const nodes = useStudySyncStore((state) => state.nodes);
  const cards = useStudySyncStore((state) => state.cards);
  const edges = useStudySyncStore((state) => state.edges);
  const annotations = useStudySyncStore((state) => state.annotations);
  const documents = useStudySyncStore((state) => state.documents);
  const selectedNodeId = useStudySyncStore((state) => state.selectedNodeId);
  const deletedCardCount = useStudySyncStore((state) => state.deletedCardHistory.length);
  const lastDeletionKind = useStudySyncStore((state) => state.deletionOrder.at(-1) ?? null);
  const initialViewport = useStudySyncStore((state) => state.notebook?.viewport);
  const selectNode = useStudySyncStore((state) => state.selectNode);
  const setSelectedNode = useStudySyncStore((state) => state.setSelectedNode);
  const setNestingTarget = useStudySyncStore((state) => state.setNestingTarget);
  const inspectNode = useStudySyncStore((state) => state.inspectNode);
  const reportNodeSizes = useStudySyncStore((state) => state.reportNodeSizes);
  const jumpToNode = useStudySyncStore((state) => state.jumpToNode);
  const removeCard = useStudySyncStore((state) => state.removeCard);
  const undoRemoveCard = useStudySyncStore((state) => state.undoRemoveCard);
  const dragNode = useStudySyncStore((state) => state.dragNode);
  const commitNodeLayout = useStudySyncStore((state) => state.commitNodeLayout);
  const connectNodes = useStudySyncStore((state) => state.connectNodes);
  const removeEdge = useStudySyncStore((state) => state.removeEdge);
  const saveViewport = useStudySyncStore((state) => state.saveViewport);

  const sectionRef = useRef<HTMLElement>(null);
  const clickSequenceRef = useRef<{
    nodeId: string;
    previousTarget: string | null;
    expectedNonce: number;
  } | null>(null);
  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CardMenuState | null>(null);

  const pendingLayoutIdsRef = useRef<Set<string>>(new Set());
  const layoutTimerRef = useRef<number | null>(null);
  const inFlightLayoutRef = useRef<Promise<void> | null>(null);

  const clearLayoutTimer = useCallback(() => {
    if (layoutTimerRef.current !== null) {
      window.clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
    }
  }, []);

  const trackLayoutWrite = useCallback((work: () => Promise<void>): Promise<void> => {
    const previous = inFlightLayoutRef.current ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        if (inFlightLayoutRef.current === next) {
          inFlightLayoutRef.current = null;
        }
      });
    inFlightLayoutRef.current = next;
    return next;
  }, []);

  const flushPendingLayouts = useCallback((): Promise<void> => {
    clearLayoutTimer();
    const pendingIds = [...pendingLayoutIdsRef.current];
    pendingLayoutIdsRef.current.clear();
    if (pendingIds.length === 0) {
      return inFlightLayoutRef.current ?? Promise.resolve();
    }
    return trackLayoutWrite(async () => {
      for (const id of pendingIds) {
        if (!useStudySyncStore.getState().nodes.some((candidate) => candidate.id === id)) {
          continue;
        }
        await commitNodeLayout(id);
      }
    });
  }, [clearLayoutTimer, commitNodeLayout, trackLayoutWrite]);

  const flushPendingLayoutsRef = useRef(flushPendingLayouts);
  useEffect(() => {
    flushPendingLayoutsRef.current = flushPendingLayouts;
  }, [flushPendingLayouts]);

  const scheduleLayoutCommit = useCallback(
    (nodeId: string) => {
      pendingLayoutIdsRef.current.add(nodeId);
      clearLayoutTimer();
      layoutTimerRef.current = window.setTimeout(() => {
        layoutTimerRef.current = null;
        void flushPendingLayoutsRef.current();
      }, KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
    },
    [clearLayoutTimer],
  );

  const cancelPendingLayout = useCallback(
    (nodeId: string) => {
      pendingLayoutIdsRef.current.delete(nodeId);
      if (pendingLayoutIdsRef.current.size === 0) {
        clearLayoutTimer();
      }
    },
    [clearLayoutTimer],
  );

  // Flush any pending arrow-key move before tab hide, unmount, or native quit (#182).
  useEffect(() => {
    const onPageHide = () => {
      void flushPendingLayoutsRef.current();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushPendingLayoutsRef.current();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unregisterFlush = registerBeforeCloseFlush({
      isDirty: () => pendingLayoutIdsRef.current.size > 0 || inFlightLayoutRef.current !== null,
      flush: () => flushPendingLayoutsRef.current(),
    });
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unregisterFlush();
      void flushPendingLayoutsRef.current();
    };
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleSectionFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const nodeElement = event.target.closest<HTMLElement>('.react-flow__node[data-id]');
    setFocusedNodeId(nodeElement?.dataset.id ?? null);
  }, []);

  const handleSectionBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element && sectionRef.current?.contains(next)) {
      const nodeElement = next.closest<HTMLElement>('.react-flow__node[data-id]');
      setFocusedNodeId(nodeElement?.dataset.id ?? null);
    } else {
      setFocusedNodeId(null);
    }
  }, []);

  const ariaLabelConfig = useMemo(() => mindMapAriaLabelConfig(), []);
  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const flowNodes = useMemo<CardFlowNode[]>(
    () =>
      nodes.map((node) => {
        const size = measured[node.id];
        const card = cardById.get(node.cardId);
        const parentNode = node.parentNodeId ? nodeById.get(node.parentNodeId) : undefined;
        const parentTitle = parentNode ? (cardById.get(parentNode.cardId)?.title ?? null) : null;
        const sourceLabel = card ? formatCardSource(card, annotations, documents) : null;
        return {
          id: node.id,
          type: 'card',
          position: { x: node.posX, y: node.posY },
          data: { cardId: node.cardId },
          selected: node.id === selectedNodeId,
          ariaLabel: cardAriaLabel({ card, parentTitle, sourceLabel }),
          // Card deletion routes through the command registry (`edit.deleteCard`) so
          // keyboard, context menu, Inspector, and native menu all share one path.
          deletable: false,
          ...(size ? { measured: size } : {}),
        };
      }),
    [nodes, measured, selectedNodeId, cardById, nodeById, annotations, documents],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const sourceNode = nodeById.get(edge.sourceNodeId);
        const targetNode = nodeById.get(edge.targetNodeId);
        const sourceTitle = sourceNode ? (cardById.get(sourceNode.cardId)?.title ?? null) : null;
        const targetTitle = targetNode ? (cardById.get(targetNode.cardId)?.title ?? null) : null;
        return {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          selected: selectedEdgeIds.has(edge.id),
          ariaLabel: edgeAriaLabel({
            sourceTitle,
            targetTitle,
            isNesting: targetNode?.parentNodeId === edge.sourceNodeId,
            label: edge.label,
          }),
          ...(edge.label === null ? {} : { label: edge.label }),
        };
      }),
    [edges, selectedEdgeIds, nodeById, cardById],
  );

  const handleSectionKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== ' ') return;
      if (!(event.target instanceof Element)) return;
      const nodeEl = event.target.closest<HTMLElement>('.react-flow__node[data-id]');
      if (!nodeEl || event.target.closest('button, a, input, textarea, select')) return;
      // Space deliberately selects the focused card as the nesting target, even when an
      // excerpt already selected it (React Flow skips `onNodesChange` for already-selected nodes).
      if (nodeEl.dataset.id) {
        clickSequenceRef.current = null;
        selectNode(nodeEl.dataset.id);
      }
    },
    [selectNode],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CardFlowNode>[]) => {
      const sizeUpdates: Record<string, NodeSize> = {};
      let hasSizeUpdate = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const existing = useStudySyncStore
            .getState()
            .nodes.find((candidate) => candidate.id === change.id);
          const moved =
            existing !== undefined &&
            (existing.posX !== change.position.x || existing.posY !== change.position.y);
          dragNode(change.id, change.position.x, change.position.y);
          if (change.dragging === true) {
            cancelPendingLayout(change.id);
          } else if (moved) {
            scheduleLayoutCommit(change.id);
          }
        } else if (change.type === 'dimensions' && change.dimensions) {
          const { dimensions, id } = change;
          setMeasured((current) => ({ ...current, [id]: dimensions }));
          if (dimensions.width > 0 && dimensions.height > 0) {
            sizeUpdates[id] = { width: dimensions.width, height: dimensions.height };
            hasSizeUpdate = true;
          }
        } else if (change.type === 'select') {
          // React Flow fires `select` changes on drag start, keyboard Enter, and internal
          // deselections; keep those visual-only so dragging or editing never alters the
          // nesting target (#127).
          if (change.selected) {
            setSelectedNode(change.id);
          } else if (useStudySyncStore.getState().selectedNodeId === change.id) {
            setSelectedNode(null);
          }
        }
      }
      if (hasSizeUpdate) {
        reportNodeSizes(sizeUpdates);
      }
    },
    [cancelPendingLayout, dragNode, reportNodeSizes, scheduleLayoutCommit, setSelectedNode],
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

  const selectedNode = useMemo(
    () => (selectedNodeId ? nodes.find((candidate) => candidate.id === selectedNodeId) : undefined),
    [nodes, selectedNodeId],
  );
  const activeFocusedNode = useMemo(
    () =>
      open && focusedNodeId ? nodes.find((candidate) => candidate.id === focusedNodeId) : undefined,
    [open, focusedNodeId, nodes],
  );
  const canUndoCard = deletedCardCount > 0 && lastDeletionKind === 'card';

  // When keyboard focus rests on a canvas card, keyboard actions target that card
  // rather than a stale selection elsewhere; explicit Inspector and context-menu
  // actions move focus off the card and target `selectedNode` (#116).
  const resolveTargetNode = () => {
    const state = useStudySyncStore.getState();
    if (open) {
      const focusedId = focusedCanvasNodeId(sectionRef.current);
      if (focusedId) {
        const focused = state.nodes.find((candidate) => candidate.id === focusedId);
        if (focused) return focused;
      }
    }
    return state.selectedNodeId
      ? state.nodes.find((candidate) => candidate.id === state.selectedNodeId)
      : undefined;
  };

  // Bare Return and Backspace act on a card only when pressed on the canvas; in
  // the reader, sidebar, or toolbar they belong there, whatever card an excerpt
  // just selected (#123). The context menu, Inspector, and Edit menu still reach
  // the selected card.
  const canvasKeyboardScope = () => (open ? sectionRef.current : null);

  useCommands({
    'edit.editCard': {
      run: () => {
        const target = resolveTargetNode();
        if (target) inspectNode(target.id);
      },
      enabled: open && (activeFocusedNode !== undefined || selectedNode !== undefined),
      keyboardScope: canvasKeyboardScope,
    },
    'edit.deleteCard': {
      run: () => {
        const target = resolveTargetNode();
        if (target) {
          closeContextMenu();
          void removeCard(target.cardId);
        }
      },
      enabled:
        (open && activeFocusedNode !== undefined) ||
        ((open || inspectorOpen) && selectedNode !== undefined),
      keyboardScope: canvasKeyboardScope,
    },
  });
  // Register Undo Delete Card as its own active-gated layer so deleting a card
  // always lands above an already-open reader tab's handler, and unregisters as
  // soon as a newer highlight deletion takes precedence (#116).
  useCommands(
    {
      'edit.undoDelete': {
        run: () => {
          void undoRemoveCard();
        },
        enabled: true,
        title: 'Undo Delete Card',
      },
    },
    canUndoCard,
  );

  const activeMenu = useMemo(() => {
    if (!open || !contextMenu) return null;
    const node = nodes.find((candidate) => candidate.id === contextMenu.nodeId);
    if (!node) return null;
    const card = cards.find((candidate) => candidate.id === node.cardId);
    if (!card) return null;
    return { ...contextMenu, card };
  }, [open, contextMenu, nodes, cards]);

  // Esc closes the card context menu before it clears selection on the canvas.
  useEscapeLayer(
    ESCAPE_LAYER.mindMapMenu,
    activeMenu
      ? () => {
          closeContextMenu();
          return true;
        }
      : null,
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
          clickSequenceRef.current = null;
          selectNode(null);
          return true;
        }
      : null,
  );

  const isEmpty = nodes.length === 0;

  return (
    <section
      ref={sectionRef}
      aria-label="MindMap canvas"
      className="relative h-full"
      onFocus={handleSectionFocus}
      onBlur={handleSectionBlur}
      onKeyDownCapture={handleSectionKeyDownCapture}
    >
      <ReactFlow<CardFlowNode>
        colorMode="system"
        ariaLabelConfig={ariaLabelConfig}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        // React Flow reports no change for a click on a card that is already
        // selected, as one an excerpt selected is; a plain click still chooses it.
        onNodeClick={(event, node) => {
          closeContextMenu();
          // Only the start of a browser click sequence (`detail === 1`, or synthetic `0`)
          // sets the nesting target. Capture the prior target and mutation nonce so the
          // paired `dblclick` rolls back only this sequence, with no fixed timeout (#127).
          if (event.detail <= 1) {
            const previousTarget = useStudySyncStore.getState().nestingTargetNodeId;
            selectNode(node.id);
            clickSequenceRef.current = {
              nodeId: node.id,
              previousTarget,
              expectedNonce: useStudySyncStore.getState().nestingTargetNonce,
            };
          }
        }}
        // Double-clicking a card opens it for editing in the Inspector without making
        // it the nesting target (#127). Only roll back the `detail === 1` click that
        // started this exact sequence, and skip rollback if an explicit target change
        // (Esc, Space, reader clear, etc.) happened in between.
        onNodeDoubleClick={(_event, node) => {
          closeContextMenu();
          const sequence = clickSequenceRef.current;
          clickSequenceRef.current = null;
          if (
            sequence &&
            sequence.nodeId === node.id &&
            useStudySyncStore.getState().nestingTargetNonce === sequence.expectedNonce
          ) {
            setNestingTarget(sequence.previousTarget);
          }
          inspectNode(node.id);
        }}
        // Right-clicking highlights the card for Edit/Jump/Delete without changing
        // the nesting target (#127).
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          setSelectedNode(node.id);
          setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
        }}
        onPaneClick={() => {
          clickSequenceRef.current = null;
          closeContextMenu();
          selectNode(null);
        }}
        onNodeDragStart={() => {
          clickSequenceRef.current = null;
        }}
        onNodeDragStop={(_event, node) => {
          cancelPendingLayout(node.id);
          void trackLayoutWrite(() => commitNodeLayout(node.id));
        }}
        onMoveEnd={(_event, viewport) => void saveViewport(viewport)}
        {...(initialViewport ? { defaultViewport: initialViewport } : {})}
        minZoom={MIN_REVEAL_ZOOM}
        maxZoom={2.5}
        multiSelectionKeyCode={null}
        // Only let React Flow claim Backspace/Delete while an edge is selected;
        // card deletion routes through the command registry (`edit.deleteCard`).
        deleteKeyCode={selectedEdgeIds.size > 0 ? ['Backspace', 'Delete'] : null}
      >
        <Background />
        <Controls />
        {!isEmpty && <MiniMap pannable zoomable />}
        <RevealOnRequest open={open} />
      </ReactFlow>
      {isEmpty && <EmptyCanvasHint />}
      {activeMenu && (
        <CardContextMenu
          x={activeMenu.x}
          y={activeMenu.y}
          hasSource={activeMenu.card.annotationIds.length > 0}
          onEdit={() => {
            closeContextMenu();
            runCommand('edit.editCard', 'toolbar');
          }}
          onJump={() => {
            closeContextMenu();
            jumpToNode(activeMenu.nodeId);
          }}
          onDelete={() => {
            closeContextMenu();
            runCommand('edit.deleteCard', 'toolbar');
          }}
          onClose={closeContextMenu}
        />
      )}
    </section>
  );
}

/** Non-interactive onboarding hint shown while a notebook has no cards (#120). */
function EmptyCanvasHint() {
  const excerpt = commandDefinition('edit.excerpt');
  const shortcut = excerpt.shortcut ? formatShortcut(excerpt.shortcut) : null;
  return (
    <div
      data-testid="mindmap-empty-hint"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6 select-none"
    >
      <p className="max-w-xs rounded-md bg-background/85 px-4 py-3 text-center text-sm text-muted-foreground">
        Select text in the reader and choose{' '}
        <span className="font-medium text-foreground">{excerpt.title}</span>
        {shortcut && (
          <>
            {' '}
            (<kbd className="font-sans text-foreground">{shortcut}</kbd>)
          </>
        )}{' '}
        to add a card.
      </p>
    </div>
  );
}

function CardContextMenu({
  x,
  y,
  hasSource,
  onEdit,
  onJump,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  hasSource: boolean;
  onEdit: () => void;
  onJump: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const editDef = commandDefinition('edit.editCard');
  const deleteDef = commandDefinition('edit.deleteCard');
  const editShortcut = editDef.shortcut ? formatShortcut(editDef.shortcut) : null;
  const deleteShortcut = deleteDef.shortcut ? formatShortcut(deleteDef.shortcut) : null;

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  // Clamp coordinates so the menu stays on screen even near viewport edges.
  const left =
    typeof window === 'undefined' ? x : Math.max(8, Math.min(x, window.innerWidth - 208));
  const top =
    typeof window === 'undefined' ? y : Math.max(8, Math.min(y, window.innerHeight - 140));

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Card actions"
      data-testid="card-context-menu"
      style={{ left, top }}
      className="fixed z-50 min-w-48 rounded-md border bg-background p-1 text-foreground shadow-md"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
        onClick={onEdit}
      >
        <Pencil className="size-3.5 shrink-0" />
        <span className="flex-1">{editDef.title}</span>
        {editShortcut && <kbd className="font-sans text-muted-foreground">{editShortcut}</kbd>}
      </button>
      {hasSource && (
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
          onClick={onJump}
        >
          <Link2 className="size-3.5 shrink-0" />
          <span className="flex-1">Jump to Source</span>
        </button>
      )}
      <div role="separator" className="my-1 h-px bg-border" />
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs text-destructive hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={onDelete}
      >
        <Trash2 className="size-3.5 shrink-0" />
        <span className="flex-1">{deleteDef.title}</span>
        {deleteShortcut && <kbd className="font-sans text-muted-foreground">{deleteShortcut}</kbd>}
      </button>
    </div>
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
