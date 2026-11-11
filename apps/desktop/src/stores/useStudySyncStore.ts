import { create } from 'zustand';

import { createDefaultBackend, type StudyBackend } from '@/lib/backend';
import type { MenuItemState, WindowChromeStyle } from '@/lib/backend/types';
import { describeError } from '@/lib/utils';
import {
  type AnchorLocation,
  type Annotation,
  type AnnotationPatch,
  type Bookmark,
  bookmarkLocationKey,
  type CardPatch,
  type CreateAnnotationOptions,
  DEFAULT_READING_PREFERENCES,
  type DocumentContentReader,
  type DocumentSourceStatus,
  type JumpRequest,
  type MindMapEdge,
  type MindMapNode,
  type NoteCard,
  type ReaderHighlight,
  type ReaderSelection,
  type ReadingPreferences,
  type RelinkDocumentResult,
  type StudyDocument,
  type StudyNotebook,
  type Viewport,
} from '@/types/domain';

export const DEFAULT_NOTEBOOK_TITLE = 'My Notebook';
export const DEFAULT_EXCERPT_COLOR = '#fde047';

export interface DeletedAnnotationSnapshot {
  annotation: Annotation;
}

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
  /** What readers load documents through; they get nothing else from the backend. */
  content: DocumentContentReader;

  documents: StudyDocument[];
  documentSourceStatuses: Record<string, DocumentSourceStatus>;
  relinkedNonceByDocumentId: Record<string, number>;
  openDocumentIds: string[];
  activeDocumentId: string | null;
  isDraggingFile: boolean;
  /** Immersive reading: chrome collapsed. Part of the session, so it survives a restart. */
  immersive: boolean;
  /** Whether the window is full screen, however it got there. */
  fullscreen: boolean;
  /**
   * Focus mode entered full screen itself (`focusModeFullScreen`), so leaving focus
   * mode leaves full screen too. Full screen the reader chose is never touched.
   */
  fullscreenFromFocusMode: boolean;
  chromeStyle: WindowChromeStyle;
  readingPreferences: ReadingPreferences;
  bookmarks: Bookmark[];

  notebook: StudyNotebook | null;
  annotations: Annotation[];
  deletedAnnotationHistory: DeletedAnnotationSnapshot[];
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
  reopenRecentDocument(documentId: string): Promise<void>;
  verifyDocumentSource(documentId: string): Promise<DocumentSourceStatus | null>;
  relinkDocument(
    documentId: string,
    confirmInPlace?: boolean,
  ): Promise<RelinkDocumentResult | null>;
  dropFiles(files: readonly File[]): Promise<void>;
  activateDocument(documentId: string): void;
  closeDocument(documentId: string): void;
  reportCursor(documentId: string, anchor: StudyDocument['lastCursorAnchor']): void;
  setImmersive(immersive: boolean): void;
  setFullscreen(fullscreen: boolean): Promise<void>;
  /** Native menu choices, as command ids. Thin pass-throughs to the backend. */
  onMenuCommand(listener: (commandId: string) => void): () => void;
  setMenuItemStates(states: readonly MenuItemState[]): Promise<void>;

  /** A loadable URL for an annotation's capture, or `null` if it has no image. */
  captureUrl(annotationId: string): Promise<string | null>;

  setSelection(selection: ReaderSelection | null): void;
  excerptSelection(): Promise<void>;
  createAnnotationFromSelection(options?: CreateAnnotationOptions): Promise<Annotation | null>;
  updateAnnotation(annotationId: string, patch: AnnotationPatch): Promise<void>;
  removeAnnotation(annotationId: string): Promise<void>;
  undoRemoveAnnotation(): Promise<Annotation | null>;
  jumpToAnnotation(annotationId: string): void;
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
  updateReadingPreferences(patch: Partial<ReadingPreferences>): Promise<void>;

  addBookmark(documentId: string, anchor: AnchorLocation, label?: string): Promise<Bookmark | null>;
  removeBookmark(bookmarkId: string): Promise<void>;
  toggleBookmark(documentId: string, anchor: AnchorLocation, label?: string): Promise<void>;
  jumpToBookmark(bookmarkId: string): void;
}

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
    .map(({ id, anchor, color, style }) => ({ annotationId: id, anchor, color, style }));
}

export function selectDocumentAnnotations(
  annotations: readonly Annotation[],
  documentId: string,
): Annotation[] {
  return annotations.filter((annotation) => annotation.documentId === documentId);
}

export function selectBookmarks(bookmarks: readonly Bookmark[], documentId: string): Bookmark[] {
  return bookmarks.filter((bookmark) => bookmark.documentId === documentId);
}

/** Most recently opened documents first, falling back to `createdAt`. */
export function selectRecentDocuments(documents: readonly StudyDocument[]): StudyDocument[] {
  return [...documents].sort((a, b) => {
    const aTime = a.lastOpenedAt ?? a.createdAt;
    const bTime = b.lastOpenedAt ?? b.createdAt;
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return b.id.localeCompare(a.id);
  });
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

    const persistSession = () => {
      const { openDocumentIds, activeDocumentId, immersive } = get();
      void guarded(async () => {
        await backend.saveWorkspaceSession({ openDocumentIds, activeDocumentId, immersive });
      });
    };

    const checkDocumentSource = async (
      documentId: string,
    ): Promise<DocumentSourceStatus | null> => {
      if (!get().documents.some((doc) => doc.id === documentId)) return null;
      let status: DocumentSourceStatus | null = null;
      await guarded(async () => {
        status = await backend.verifyDocumentSource(documentId);
        if (status) {
          const resolved = status;
          set((state) => ({
            documentSourceStatuses: {
              ...state.documentSourceStatuses,
              [documentId]: resolved,
            },
          }));
        }
      });
      return status;
    };

    const applyOpenedDocuments = (opened: readonly StudyDocument[], error?: unknown) => {
      set((state) => {
        let documents = state.documents;
        let openDocumentIds = state.openDocumentIds;
        const documentSourceStatuses = { ...state.documentSourceStatuses };
        for (const document of opened) {
          documents = [...documents.filter((d) => d.id !== document.id), document];
          if (!openDocumentIds.includes(document.id)) {
            openDocumentIds = [...openDocumentIds, document.id];
          }
          documentSourceStatuses[document.id] = {
            documentId: document.id,
            state: 'ok',
            currentFileHash: document.fileHash,
            fileSizeBytes: null,
          };
        }
        const lastOpened = opened.at(-1);
        return {
          documents,
          documentSourceStatuses,
          openDocumentIds,
          activeDocumentId: lastOpened ? lastOpened.id : state.activeDocumentId,
          selection: opened.length > 0 ? null : state.selection,
          ...(error !== undefined && error !== null ? { error: describeError(error) } : {}),
        };
      });
      if (opened.length > 0) persistSession();
    };

    // Leaving full screen by any other route (the window's button, View ▸ Exit Full
    // Screen) hands it back to the reader: a later exit from focus mode leaves it be.
    backend.onFullscreenChange((fullscreen) =>
      set(fullscreen ? { fullscreen } : { fullscreen, fullscreenFromFocusMode: false }),
    );

    backend.onFileDrop((event) => {
      if (event.type === 'enter') {
        set({ isDraggingFile: true });
      } else if (event.type === 'leave') {
        set({ isDraggingFile: false });
      } else {
        set({ isDraggingFile: false });
        applyOpenedDocuments(event.documents, event.error);
      }
    });

    return {
      status: 'idle',
      error: null,
      backendKind: backend.kind,
      content: {
        loadDocumentSource: (document) => backend.loadDocumentSource(document),
        readTextStream: (documentId, encoding, onChunk, signal) =>
          backend.readTextStream(documentId, encoding, onChunk, signal),
      },
      documents: [],
      documentSourceStatuses: {},
      relinkedNonceByDocumentId: {},
      openDocumentIds: [],
      activeDocumentId: null,
      isDraggingFile: false,
      immersive: false,
      fullscreen: false,
      fullscreenFromFocusMode: false,
      chromeStyle: backend.chromeStyle,
      readingPreferences: { ...DEFAULT_READING_PREFERENCES },
      bookmarks: [],
      notebook: null,
      annotations: [],
      deletedAnnotationHistory: [],
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
          const [documents, notebooks, readingPreferences, bookmarks, session] = await Promise.all([
            backend.listDocuments(),
            backend.listNotebooks(),
            backend.getReadingPreferences(),
            backend.listBookmarks(),
            backend.getWorkspaceSession(),
          ]);
          const notebook = notebooks[0] ?? (await backend.createNotebook(DEFAULT_NOTEBOOK_TITLE));
          const graph = await backend.loadNotebookGraph(notebook.id);
          const knownIds = new Set(documents.map((doc) => doc.id));
          const openDocumentIds = session.openDocumentIds.filter((id) => knownIds.has(id));
          const activeDocumentId =
            session.activeDocumentId && openDocumentIds.includes(session.activeDocumentId)
              ? session.activeDocumentId
              : (openDocumentIds.at(-1) ?? null);
          const verifiedStatuses = await Promise.all(
            openDocumentIds.map((id) => backend.verifyDocumentSource(id).catch(() => null)),
          );
          const documentSourceStatuses: Record<string, DocumentSourceStatus> = {};
          for (const status of verifiedStatuses) {
            if (status) documentSourceStatuses[status.documentId] = status;
          }
          set({
            status: 'ready',
            documents,
            documentSourceStatuses,
            openDocumentIds,
            activeDocumentId,
            immersive: session.immersive,
            readingPreferences,
            bookmarks,
            ...graph,
          });
        } catch (error) {
          set({ status: 'error', error: describeError(error) });
        }
      },

      dismissError: () => set({ error: null }),

      async openDocument() {
        await guarded(async () => {
          const document = await backend.pickDocument();
          if (document === null) return;
          applyOpenedDocuments([document]);
        });
      },

      async reopenRecentDocument(documentId) {
        if (!get().documents.some((doc) => doc.id === documentId)) return;
        await guarded(async () => {
          const [touched, status] = await Promise.all([
            backend.touchDocumentOpened(documentId),
            backend.verifyDocumentSource(documentId),
          ]);
          set((state) => ({
            documents: state.documents.map((doc) => (doc.id === documentId ? touched : doc)),
            documentSourceStatuses: {
              ...state.documentSourceStatuses,
              [documentId]: status,
            },
            openDocumentIds: state.openDocumentIds.includes(documentId)
              ? state.openDocumentIds
              : [...state.openDocumentIds, documentId],
            activeDocumentId: documentId,
            selection: state.activeDocumentId === documentId ? state.selection : null,
          }));
          persistSession();
        });
      },

      verifyDocumentSource(documentId) {
        return checkDocumentSource(documentId);
      },

      async relinkDocument(documentId, confirmInPlace = false) {
        if (!get().documents.some((doc) => doc.id === documentId)) return null;
        let relinked: RelinkDocumentResult | null = null;
        await guarded(async () => {
          const result = await backend.relinkDocument(documentId, confirmInPlace);
          if (!result) return;
          relinked = result;
          set((state) => ({
            documents: state.documents.map((doc) =>
              doc.id === documentId ? result.document : doc,
            ),
            documentSourceStatuses: {
              ...state.documentSourceStatuses,
              [documentId]: {
                documentId,
                state: 'ok',
                currentFileHash: result.document.fileHash,
                fileSizeBytes: null,
              },
            },
            relinkedNonceByDocumentId: {
              ...state.relinkedNonceByDocumentId,
              [documentId]: (state.relinkedNonceByDocumentId[documentId] ?? 0) + 1,
            },
            selection: state.selection?.documentId === documentId ? null : state.selection,
          }));
        });
        return relinked;
      },

      async dropFiles(files) {
        if (files.length === 0) return;
        await guarded(async () => {
          const { documents, error } = await backend.dropFiles(files);
          applyOpenedDocuments(documents, error);
        });
      },

      activateDocument(documentId) {
        if (documentId === get().activeDocumentId) return;
        set({ activeDocumentId: documentId, selection: null });
        persistSession();
        void checkDocumentSource(documentId);
      },

      closeDocument(documentId) {
        if (!get().openDocumentIds.includes(documentId)) return;
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
        persistSession();
      },

      async setFullscreen(fullscreen) {
        await guarded(async () => {
          await backend.setFullscreen(fullscreen);
          set({ fullscreen: await backend.isFullscreen() });
        });
      },

      onMenuCommand: (listener) => backend.onMenuCommand(listener),

      async setMenuItemStates(states) {
        // A menu that lags a moment behind is harmless; an error banner for it is not.
        await backend.setMenuItemStates(states).catch(() => undefined);
      },

      setImmersive(immersive) {
        if (get().immersive === immersive) return;
        set({ immersive });
        persistSession();
        const { readingPreferences, fullscreen, fullscreenFromFocusMode } = get();
        if (immersive && readingPreferences.focusModeFullScreen && !fullscreen) {
          set({ fullscreenFromFocusMode: true });
          // A refused request leaves focus mode on in the window, without an error.
          void backend
            .setFullscreen(true)
            .then(() => backend.isFullscreen())
            .then((now) => {
              if (!now) {
                set({ fullscreenFromFocusMode: false });
                return;
              }
              set({ fullscreen: true });
              // Focus mode ended while the window was still going full screen.
              if (!get().immersive) void get().setFullscreen(false);
            })
            .catch(() => set({ fullscreenFromFocusMode: false }));
        } else if (!immersive && fullscreenFromFocusMode) {
          set({ fullscreenFromFocusMode: false });
          void get().setFullscreen(false);
        }
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

      captureUrl: (annotationId) => backend.captureUrl(annotationId),

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
            excerptImagePng: selection.imagePng,
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

      async createAnnotationFromSelection(options) {
        const { selection, notebook, isExcerpting } = get();
        if (!selection || !notebook || isExcerpting) return null;

        let created: Annotation | null = null;
        await guarded(async () => {
          const saved = await backend.createAnnotation({
            documentId: selection.documentId,
            notebookId: notebook.id,
            anchor: selection.anchor,
            excerptText: selection.text,
            excerptImagePng: selection.imagePng,
            note: options?.note ?? null,
            color: options?.color ?? DEFAULT_EXCERPT_COLOR,
            style: options?.style ?? 'highlight',
          });
          created = saved;
          set((state) => ({
            annotations: [...state.annotations, saved],
            selection: state.selection === selection ? null : state.selection,
          }));
        });
        return created;
      },

      async updateAnnotation(annotationId, patch) {
        await guarded(async () => {
          const updated = await backend.updateAnnotation(annotationId, patch);
          set((state) => ({
            annotations: state.annotations.map((candidate) =>
              candidate.id === annotationId ? updated : candidate,
            ),
          }));
        });
      },

      async removeAnnotation(annotationId) {
        const removed = get().annotations.find((annotation) => annotation.id === annotationId);
        if (!removed) return;
        const previousCards = get().cards;
        set((state) => ({
          annotations: state.annotations.filter((annotation) => annotation.id !== annotationId),
          deletedAnnotationHistory: [...state.deletedAnnotationHistory, { annotation: removed }],
          cards: state.cards.map((card) =>
            card.annotationIds.includes(annotationId)
              ? {
                  ...card,
                  annotationIds: card.annotationIds.filter((id) => id !== annotationId),
                }
              : card,
          ),
        }));
        await guarded(
          () => backend.deleteAnnotation(annotationId),
          () =>
            set((state) => ({
              annotations: [...state.annotations, removed],
              deletedAnnotationHistory: state.deletedAnnotationHistory.filter(
                (entry) => entry.annotation.id !== removed.id,
              ),
              cards: previousCards,
            })),
        );
      },

      async undoRemoveAnnotation() {
        const last = get().deletedAnnotationHistory.at(-1);
        if (!last) return null;
        set((state) => ({
          deletedAnnotationHistory: state.deletedAnnotationHistory.slice(0, -1),
        }));

        let restored: Annotation | null = null;
        await guarded(
          async () => {
            const saved = await backend.createAnnotation({
              documentId: last.annotation.documentId,
              notebookId: last.annotation.notebookId,
              anchor: last.annotation.anchor,
              excerptText: last.annotation.excerptText,
              excerptImagePng: null,
              note: last.annotation.note ?? null,
              color: last.annotation.color,
              style: last.annotation.style,
            });
            restored = saved;
            set((state) => ({
              annotations: [...state.annotations, saved],
            }));
          },
          () =>
            set((state) => ({
              deletedAnnotationHistory: [...state.deletedAnnotationHistory, last],
            })),
        );
        return restored;
      },

      jumpToAnnotation(annotationId) {
        const { annotations, documents } = get();
        const annotation = annotations.find((candidate) => candidate.id === annotationId);
        if (!annotation) return;

        if (!documents.some((document) => document.id === annotation.documentId)) {
          set({ error: 'The source document for this annotation is no longer available.' });
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
        persistSession();
        void checkDocumentSource(annotation.documentId);
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
        persistSession();
        void checkDocumentSource(annotation.documentId);
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

      async updateReadingPreferences(patch) {
        const previous = get().readingPreferences;
        const next: ReadingPreferences = { ...previous, ...patch };
        set({ readingPreferences: next });
        await guarded(
          async () => {
            const saved = await backend.saveReadingPreferences(next);
            set({ readingPreferences: saved });
          },
          () => set({ readingPreferences: previous }),
        );
      },

      async addBookmark(documentId, anchor, label) {
        let created: Bookmark | null = null;
        await guarded(async () => {
          const saved = await backend.createBookmark({
            documentId,
            anchor,
            label: label ?? null,
          });
          created = saved;
          set((state) => {
            const exists = state.bookmarks.some((candidate) => candidate.id === saved.id);
            return {
              bookmarks: exists
                ? state.bookmarks.map((candidate) =>
                    candidate.id === saved.id ? saved : candidate,
                  )
                : [...state.bookmarks, saved],
            };
          });
        });
        return created;
      },

      async removeBookmark(bookmarkId) {
        const removed = get().bookmarks.find((bookmark) => bookmark.id === bookmarkId);
        if (!removed) return;
        set((state) => ({
          bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
        }));
        await guarded(
          () => backend.deleteBookmark(bookmarkId),
          () => set((state) => ({ bookmarks: [...state.bookmarks, removed] })),
        );
      },

      async toggleBookmark(documentId, anchor, label) {
        const key = bookmarkLocationKey(anchor);
        const existing = get().bookmarks.find(
          (bookmark) =>
            bookmark.documentId === documentId && bookmarkLocationKey(bookmark.anchor) === key,
        );
        if (existing) {
          await get().removeBookmark(existing.id);
        } else {
          await get().addBookmark(documentId, anchor, label);
        }
      },

      jumpToBookmark(bookmarkId) {
        const { bookmarks, documents } = get();
        const bookmark = bookmarks.find((candidate) => candidate.id === bookmarkId);
        if (!bookmark) return;

        if (!documents.some((document) => document.id === bookmark.documentId)) {
          set({ error: 'The source document for this bookmark is no longer available.' });
          return;
        }

        jumpNonce += 1;
        set((state) => ({
          openDocumentIds: state.openDocumentIds.includes(bookmark.documentId)
            ? state.openDocumentIds
            : [...state.openDocumentIds, bookmark.documentId],
          activeDocumentId: bookmark.documentId,
          selection: state.activeDocumentId === bookmark.documentId ? state.selection : null,
          jumpRequest: {
            nonce: jumpNonce,
            documentId: bookmark.documentId,
            annotationId: bookmark.id,
            anchor: bookmark.anchor,
          },
        }));
        persistSession();
        void checkDocumentSource(bookmark.documentId);
      },
    };
  });
}

export const useStudySyncStore = createStudySyncStore(createDefaultBackend());
