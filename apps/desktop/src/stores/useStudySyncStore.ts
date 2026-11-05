import { create } from 'zustand';

import { createDefaultBackend, type StudyBackend } from '@/lib/backend';
import type {
  Annotation,
  CardPatch,
  JumpRequest,
  MindMapEdge,
  MindMapNode,
  NoteCard,
  ReaderHighlight,
  ReaderSelection,
  StudyDocument,
  StudyNotebook,
  Viewport,
} from '@/types/domain';

export const DEFAULT_NOTEBOOK_TITLE = 'My Notebook';
export const DEFAULT_EXCERPT_COLOR = '#fde047';

const CHILD_OFFSET_X = 320;
const SIBLING_OFFSET_Y = 140;
const ROOT_ORIGIN = { x: 40, y: 40 };
const ROOT_CASCADE = 36;

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StudySyncState {
  status: LoadStatus;
  /** Latest failure, shown to the user until dismissed. */
  error: string | null;
  backendKind: StudyBackend['kind'];

  documents: StudyDocument[];
  openDocumentIds: string[];
  activeDocumentId: string | null;

  notebook: StudyNotebook | null;
  annotations: Annotation[];
  cards: NoteCard[];
  nodes: MindMapNode[];
  edges: MindMapEdge[];

  /** Reader -> MindMap: what the reader currently has selected. */
  selection: ReaderSelection | null;
  isExcerpting: boolean;
  selectedNodeId: string | null;
  /** MindMap -> Reader: the jump the reader for that document should perform. */
  jumpRequest: JumpRequest | null;

  initialize(): Promise<void>;
  dismissError(): void;

  openDocument(): Promise<void>;
  activateDocument(documentId: string): void;
  closeDocument(documentId: string): void;
  reportCursor(documentId: string, anchor: StudyDocument['lastCursorAnchor']): void;

  setSelection(selection: ReaderSelection | null): void;
  excerptSelection(): Promise<void>;
  jumpToNode(nodeId: string, annotationId?: string): void;
  completeJump(nonce: number): void;

  selectNode(nodeId: string | null): void;
  /** Updates position in memory only: called for every frame of a drag. */
  dragNode(nodeId: string, posX: number, posY: number): void;
  /** Persists the node's current layout: called when a drag ends. */
  commitNodeLayout(nodeId: string): Promise<void>;
  connectNodes(sourceNodeId: string, targetNodeId: string): Promise<void>;
  removeEdge(edgeId: string): Promise<void>;
  updateCard(cardId: string, patch: CardPatch): Promise<void>;
  saveViewport(viewport: Viewport): Promise<void>;
}

const describeError = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return 'Something went wrong';
};

/** Children stack to the right of their parent; roots cascade from the origin. */
export function nextNodePosition(
  nodes: readonly MindMapNode[],
  parentNodeId: string | null,
): { x: number; y: number } {
  const parent = parentNodeId ? nodes.find((node) => node.id === parentNodeId) : undefined;
  if (parent) {
    const siblings = nodes.filter((node) => node.parentNodeId === parent.id).length;
    return { x: parent.posX + CHILD_OFFSET_X, y: parent.posY + siblings * SIBLING_OFFSET_Y };
  }
  const roots = nodes.filter((node) => node.parentNodeId === null).length;
  return { x: ROOT_ORIGIN.x + roots * ROOT_CASCADE, y: ROOT_ORIGIN.y + roots * ROOT_CASCADE };
}

export function selectHighlights(
  annotations: readonly Annotation[],
  documentId: string,
): ReaderHighlight[] {
  return annotations
    .filter((annotation) => annotation.documentId === documentId)
    .map(({ id, anchor, color }) => ({ annotationId: id, anchor, color }));
}

/**
 * The bi-directional bus between the Reader and the MindMap. Neither side knows
 * the other exists: readers publish selections and consume jump requests, the
 * canvas publishes jumps and renders the excerpts that selections become.
 */
export function createStudySyncStore(backend: StudyBackend) {
  let jumpNonce = 0;

  return create<StudySyncState>((set, get) => {
    /** Runs a backend write, routing failures to the error banner. */
    const guarded = async (write: () => Promise<void>, rollback?: () => void) => {
      try {
        await write();
      } catch (error) {
        rollback?.();
        set({ error: describeError(error) });
      }
    };

    return {
      status: 'idle',
      error: null,
      backendKind: backend.kind,
      documents: [],
      openDocumentIds: [],
      activeDocumentId: null,
      notebook: null,
      annotations: [],
      cards: [],
      nodes: [],
      edges: [],
      selection: null,
      isExcerpting: false,
      selectedNodeId: null,
      jumpRequest: null,

      async initialize() {
        if (get().status === 'loading' || get().status === 'ready') return;
        set({ status: 'loading', error: null });
        try {
          const [documents, notebooks] = await Promise.all([
            backend.listDocuments(),
            backend.listNotebooks(),
          ]);
          const notebook = notebooks[0] ?? (await backend.createNotebook(DEFAULT_NOTEBOOK_TITLE));
          const graph = await backend.loadNotebookGraph(notebook.id);
          set({ status: 'ready', documents, ...graph });
        } catch (error) {
          set({ status: 'error', error: describeError(error) });
        }
      },

      dismissError: () => set({ error: null }),

      async openDocument() {
        await guarded(async () => {
          const document = await backend.pickDocument();
          if (document === null) return;
          set((state) => ({
            documents: [...state.documents.filter((d) => d.id !== document.id), document],
            openDocumentIds: state.openDocumentIds.includes(document.id)
              ? state.openDocumentIds
              : [...state.openDocumentIds, document.id],
            activeDocumentId: document.id,
            selection: null,
          }));
        });
      },

      activateDocument(documentId) {
        if (documentId === get().activeDocumentId) return;
        set({ activeDocumentId: documentId, selection: null });
      },

      closeDocument(documentId) {
        set((state) => {
          const index = state.openDocumentIds.indexOf(documentId);
          if (index === -1) return state;
          const openDocumentIds = state.openDocumentIds.filter((id) => id !== documentId);
          const activeDocumentId =
            state.activeDocumentId === documentId
              ? (openDocumentIds[Math.min(index, openDocumentIds.length - 1)] ?? null)
              : state.activeDocumentId;
          return {
            openDocumentIds,
            activeDocumentId,
            selection: state.selection?.documentId === documentId ? null : state.selection,
            jumpRequest: state.jumpRequest?.documentId === documentId ? null : state.jumpRequest,
          };
        });
      },

      reportCursor(documentId, anchor) {
        if (anchor === null) return;
        set((state) => ({
          documents: state.documents.map((document) =>
            document.id === documentId ? { ...document, lastCursorAnchor: anchor } : document,
          ),
        }));
        void guarded(() => backend.updateDocumentCursor(documentId, anchor));
      },

      setSelection: (selection) => set({ selection }),

      async excerptSelection() {
        const { selection, notebook, isExcerpting, selectedNodeId, nodes } = get();
        if (!selection || !notebook || isExcerpting) return;

        const position = nextNodePosition(nodes, selectedNodeId);
        set({ isExcerpting: true });
        try {
          const created = await backend.createExcerpt({
            documentId: selection.documentId,
            notebookId: notebook.id,
            anchor: selection.anchor,
            excerptText: selection.text,
            excerptImagePath: selection.imagePath,
            color: DEFAULT_EXCERPT_COLOR,
            parentNodeId: selectedNodeId,
            posX: position.x,
            posY: position.y,
          });
          // Only clear the selection the user excerpted: they may have made a
          // new one while the write was in flight.
          set((state) => ({
            annotations: [...state.annotations, created.annotation],
            cards: [...state.cards, created.card],
            nodes: [...state.nodes, created.node],
            edges: created.edge ? [...state.edges, created.edge] : state.edges,
            selection: state.selection === selection ? null : state.selection,
            selectedNodeId: created.node.id,
            isExcerpting: false,
          }));
        } catch (error) {
          // The selection stays so the user can retry.
          set({ isExcerpting: false, error: describeError(error) });
        }
      },

      jumpToNode(nodeId, annotationId) {
        const { nodes, cards, annotations, documents } = get();
        const node = nodes.find((candidate) => candidate.id === nodeId);
        const card = node && cards.find((candidate) => candidate.id === node.cardId);
        const targetId = annotationId ?? card?.annotationIds[0];
        const annotation = annotations.find((candidate) => candidate.id === targetId);
        if (!annotation) return;

        if (!documents.some((document) => document.id === annotation.documentId)) {
          set({ error: 'The source document for this card is no longer available.' });
          return;
        }

        jumpNonce += 1;
        set((state) => ({
          openDocumentIds: state.openDocumentIds.includes(annotation.documentId)
            ? state.openDocumentIds
            : [...state.openDocumentIds, annotation.documentId],
          activeDocumentId: annotation.documentId,
          selection: state.activeDocumentId === annotation.documentId ? state.selection : null,
          jumpRequest: {
            nonce: jumpNonce,
            documentId: annotation.documentId,
            annotationId: annotation.id,
            anchor: annotation.anchor,
          },
        }));
      },

      completeJump(nonce) {
        // A newer jump may already be pending; never clear that one.
        if (get().jumpRequest?.nonce === nonce) set({ jumpRequest: null });
      },

      selectNode: (selectedNodeId) => set({ selectedNodeId }),

      dragNode(nodeId, posX, posY) {
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, posX, posY } : node)),
        }));
      },

      async commitNodeLayout(nodeId) {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return;
        const { posX, posY, isCollapsed } = node;
        await guarded(() => backend.updateNodeLayout(nodeId, { posX, posY, isCollapsed }));
      },

      async connectNodes(sourceNodeId, targetNodeId) {
        const { notebook } = get();
        if (!notebook) return;
        await guarded(async () => {
          const edge = await backend.createEdge(notebook.id, sourceNodeId, targetNodeId, null);
          set((state) => ({ edges: [...state.edges, edge] }));
        });
      },

      async removeEdge(edgeId) {
        const removed = get().edges.find((edge) => edge.id === edgeId);
        if (!removed) return;
        set((state) => ({ edges: state.edges.filter((edge) => edge.id !== edgeId) }));
        await guarded(
          () => backend.deleteEdge(edgeId),
          () => set((state) => ({ edges: [...state.edges, removed] })),
        );
      },

      async updateCard(cardId, patch) {
        await guarded(async () => {
          const card = await backend.updateCard(cardId, patch);
          set((state) => ({
            cards: state.cards.map((candidate) => (candidate.id === cardId ? card : candidate)),
          }));
        });
      },

      async saveViewport(viewport) {
        const { notebook } = get();
        if (!notebook) return;
        set({ notebook: { ...notebook, viewport } });
        await guarded(() => backend.saveNotebookViewport(notebook.id, viewport));
      },
    };
  });
}

export const useStudySyncStore = createStudySyncStore(createDefaultBackend());
