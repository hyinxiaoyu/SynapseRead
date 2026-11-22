import { create } from 'zustand';

import { createDefaultBackend, type StudyBackend } from '@/lib/backend';
import type { MenuItemState, WindowChromeStyle } from '@/lib/backend/types';
import { flushBeforeClose, hasPendingBeforeCloseFlush } from '@/lib/flushBeforeClose';
import { describeError } from '@/lib/utils';
import {
  type AnchorLocation,
  type Annotation,
  annotationHasNote,
  type AnnotationPatch,
  type BookImportDecision,
  type Bookmark,
  bookmarkLocationKey,
  type CardPatch,
  type CatalogBookClassification,
  type CreateAnnotationOptions,
  DEFAULT_READING_PREFERENCES,
  DEFAULT_WORKSPACE_PANE_LAYOUT,
  type DocumentContentReader,
  type DocumentSourceStatus,
  INITIAL_LAN_SHARE_SNAPSHOT,
  type IpcError,
  type JumpRequest,
  type LanImportExecutionReport,
  type LanImportPlanResult,
  type LanImportProgress,
  type LanImportSessionInfo,
  type LanInterface,
  type LanShareEventPayload,
  type LanShareSnapshot,
  type LanShareStartInput,
  type MindMapEdge,
  type MindMapNode,
  type NoteCard,
  type ReaderHighlight,
  type ReaderSelection,
  DEFAULT_PDF_LAYOUT,
  type PdfLayout,
  type PlanProgress,
  type ReadingPreferences,
  type RelinkDocumentResult,
  type RestoredCard,
  type StudyDocument,
  type StudyNotebook,
  type Viewport,
  type WorkspacePaneLayout,
  isCatalogBookClassification,
  isLanImportExecutionReport,
  isLanImportPlanResult,
  isLanImportProgress,
  isLanShareSnapshot,
} from '@/types/domain';

export const DEFAULT_NOTEBOOK_TITLE = 'My Notebook';
export const DEFAULT_EXCERPT_COLOR = '#fde047';

export interface DeletedAnnotationSnapshot {
  annotation: Annotation;
}

export interface DeletedCardSnapshot {
  card: NoteCard;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  childParentLinks: Array<[string, string]>;
}

export type DeletionKind = 'annotation' | 'card';

export interface LanShareSliceState {
  interfaces: LanInterface[];
  snapshot: LanShareSnapshot;
  loading: boolean;
  error: IpcError | null;
}

export type LanImportPhase =
  'idle' | 'connecting' | 'catalog' | 'planning' | 'preview' | 'importing' | 'results';

export interface LanImportSliceState {
  phase: LanImportPhase;
  session: LanImportSessionInfo | null;
  catalog: CatalogBookClassification[];
  plan: LanImportPlanResult | null;
  planProgress: PlanProgress | null;
  executionProgress: LanImportProgress | null;
  executionReport: LanImportExecutionReport | null;
  activeOperationId: string | null;
  error: IpcError | null;
}

const INITIAL_LAN_SHARE_SLICE: LanShareSliceState = {
  interfaces: [],
  snapshot: { ...INITIAL_LAN_SHARE_SNAPSHOT },
  loading: false,
  error: null,
};

const INITIAL_LAN_IMPORT_SLICE: LanImportSliceState = {
  phase: 'idle',
  session: null,
  catalog: [],
  plan: null,
  planProgress: null,
  executionProgress: null,
  executionReport: null,
  activeOperationId: null,
  error: null,
};

function toIpcError(error: unknown): IpcError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal', message: describeError(error) };
}

/** Reopen Closed Tab keeps a bounded history: nobody reopens the 21st-last tab. */
const MAX_CLOSED_TABS = 20;
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
  /**
   * Documents closed this session, most recently closed last. In memory only:
   * ⇧⌘T brings one back and its tab is gone on the next launch, like the
   * session's other tab state.
   */
  closedDocumentIds: string[];
  /**
   * Documents currently locked by a close-and-flush / close-and-apply sequence.
   * Reopening a locked document is ignored until its lock is released.
   */
  lockedDocumentIds: string[];
  isDraggingFile: boolean;
  /** Immersive reading: chrome collapsed. Part of the session, so it survives a restart. */
  immersive: boolean;
  /** Persisted MindMap and Inspector pane visibility and widths across relaunch (#119). */
  paneLayout: WorkspacePaneLayout;
  /** Whether the window is full screen, however it got there. */
  fullscreen: boolean;
  /**
   * Focus mode entered full screen itself (`focusModeFullScreen`), so leaving focus
   * mode leaves full screen too. Full screen the reader chose is never touched.
   */
  fullscreenFromFocusMode: boolean;
  chromeStyle: WindowChromeStyle;
  readingPreferences: ReadingPreferences;
  /**
   * Layouts of open PDFs, by document id. An entry is loaded before its viewer
   * mounts and dropped when the tab closes, so reopening reads the saved layout.
   */
  pdfLayouts: Record<string, PdfLayout>;
  bookmarks: Bookmark[];

  notebook: StudyNotebook | null;
  annotations: Annotation[];
  deletedAnnotationHistory: DeletedAnnotationSnapshot[];
  deletedCardHistory: DeletedCardSnapshot[];
  /** Order of undoable deletions across highlights and cards, newest last. */
  deletionOrder: DeletionKind[];
  cards: NoteCard[];
  nodes: MindMapNode[];
  edges: MindMapEdge[];

  /** Reader -> MindMap: what the reader currently has selected. */
  selection: ReaderSelection | null;
  isExcerpting: boolean;
  /** The card highlighted on the canvas and shown in the inspector. */
  selectedNodeId: string | null;
  /**
   * The card the next excerpt nests under. Only the reader sets it, by selecting a
   * card on the canvas: the card an excerpt selects is not a choice they made, so
   * consecutive excerpts stay separate roots instead of chaining (#96).
   */
  nestingTargetNodeId: string | null;
  /** Store -> MindMap: a card to bring into view once the canvas is showing. */
  revealRequest: RevealRequest | null;
  /** Store -> Workspace/Inspector: open Inspector and focus Notes for this card (#119). */
  inspectRequest: InspectRequest | null;
  /** Monotonic count of successful excerpts, so announcements fire even back-to-back. */
  excerptNonce: number;
  /** MindMap -> Reader: the jump the reader for that document should perform. */
  jumpRequest: JumpRequest | null;

  /** Session-scoped LAN sharing state (ADR 0008, #144). */
  lanShare: LanShareSliceState;
  /** Session-scoped LAN import state (ADR 0008, #144). */
  lanImport: LanImportSliceState;

  initialize(): Promise<void>;
  dismissError(): void;

  openDocument(): Promise<void>;
  reopenRecentDocument(documentId: string): Promise<void>;
  /** Reopens the most recently closed tab that is not already open again. */
  reopenClosedDocument(): Promise<void>;
  verifyDocumentSource(documentId: string): Promise<DocumentSourceStatus | null>;
  relinkDocument(
    documentId: string,
    confirmInPlace?: boolean,
  ): Promise<RelinkDocumentResult | null>;
  dropFiles(files: readonly File[]): Promise<void>;
  activateDocument(documentId: string): void;
  closeDocument(documentId: string): void;
  /**
   * Closes an open document, waits for its mounted viewer to unmount and enqueue
   * any final cursor write, then waits for all in-flight cursor writes to settle.
   */
  closeDocumentAndFlush(documentId: string): Promise<void>;
  /** Waits until all in-flight `updateDocumentCursor` writes for `documentId` settle. */
  flushCursorWrites(documentId: string): Promise<void>;
  /**
   * Registers a mounted viewer instance for `documentId` and returns an unregister
   * callback to invoke on unmount after the viewer's own cleanup has run.
   */
  registerMountedViewer(documentId: string): () => void;
  /**
   * Acquires a reference-counted reopen lock for `documentId` and returns an
   * idempotent release function. While locked, open, reopen, activate, and jump
   * paths will not open or activate `documentId`.
   */
  lockDocument(documentId: string): () => void;
  /** Runs `run` while holding a reopen lock on `documentId`. */
  withDocumentLock<T>(documentId: string, run: () => Promise<T>): Promise<T>;
  /**
   * Reloads `documentId` via `backend.listDocuments()`, upserting it in `documents`.
   * If it was previously `missing` and its `filePath` changed, resets its source
   * status to `ok` and increments `relinkedNonceByDocumentId[documentId]`.
   */
  refreshDocument(documentId: string): Promise<StudyDocument | null>;
  /**
   * Reloads bookmarks via `backend.listBookmarks()` and replaces only bookmarks
   * belonging to `documentId`.
   */
  refreshBookmarks(documentId: string): Promise<void>;
  /** `progress` is how far through the document the anchor is, `0..1`, if known. */
  reportCursor(
    documentId: string,
    anchor: StudyDocument['lastCursorAnchor'],
    progress?: number,
  ): void;
  setImmersive(immersive: boolean): void;
  setPaneLayout(patch: Partial<WorkspacePaneLayout>): void;
  setFullscreen(fullscreen: boolean): Promise<void>;
  /** Native menu choices, as command ids. Thin pass-throughs to the backend. */
  onMenuCommand(listener: (commandId: string) => void): () => void;
  setMenuItemStates(states: readonly MenuItemState[]): Promise<void>;
  /** Runs an async flush hook before the native window closes or quits (#117). */
  onBeforeClose(listener: () => Promise<void>): () => void;

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

  /** The reader's own selection on the canvas; it also sets the nesting target. */
  selectNode(nodeId: string | null): void;
  /** Selects a card without making it the nesting target, and asks the canvas to show it. */
  revealNode(nodeId: string): void;
  completeReveal(nonce: number): void;
  /** Selects a card (without changing nesting target) and asks Inspector to open and focus Notes. */
  inspectNode(nodeId: string): void;
  completeInspect(nonce: number): void;
  /** Updates position in memory only: called for every frame of a drag. */
  dragNode(nodeId: string, posX: number, posY: number): void;
  /** Persists the node's current layout: called when a drag ends. */
  commitNodeLayout(nodeId: string): Promise<void>;
  connectNodes(sourceNodeId: string, targetNodeId: string): Promise<void>;
  removeEdge(edgeId: string): Promise<void>;
  /** Persists a card edit; resolves to `false` when the backend write fails. */
  updateCard(cardId: string, patch: CardPatch): Promise<boolean>;
  removeCard(cardId: string): Promise<void>;
  undoRemoveCard(): Promise<RestoredCard | null>;
  saveViewport(viewport: Viewport): Promise<void>;
  updateReadingPreferences(patch: Partial<ReadingPreferences>): Promise<void>;
  /** Loads a PDF's layout into `pdfLayouts`, falling back to the default on failure. */
  loadPdfLayout(documentId: string): Promise<void>;
  /** Records and persists a PDF's whole layout. */
  savePdfLayout(documentId: string, layout: PdfLayout): Promise<void>;

  addBookmark(documentId: string, anchor: AnchorLocation, label?: string): Promise<Bookmark | null>;
  removeBookmark(bookmarkId: string): Promise<void>;
  toggleBookmark(documentId: string, anchor: AnchorLocation, label?: string): Promise<void>;
  jumpToBookmark(bookmarkId: string): void;

  // ---- LAN Book Sync actions (ADR 0008, #144) -----------------------------
  loadLanInterfaces(): Promise<LanInterface[]>;
  startLanShare(input: LanShareStartInput): Promise<LanShareSnapshot | null>;
  refreshLanShareStatus(): Promise<LanShareSnapshot | null>;
  regenerateLanShareCode(): Promise<LanShareSnapshot | null>;
  stopLanShare(): Promise<LanShareSnapshot | null>;
  disconnectLanSharePeer(): Promise<LanShareSnapshot | null>;
  clearLanShareError(): void;

  connectLanImport(address: string, code: string): Promise<LanImportSessionInfo | null>;
  refreshLanImportCatalog(): Promise<CatalogBookClassification[]>;
  planLanImport(bookIds: string[]): Promise<LanImportPlanResult | null>;
  executeLanImport(decisions: BookImportDecision[]): Promise<LanImportExecutionReport | null>;
  cancelLanImportOperation(): Promise<boolean>;
  /** Returns to catalog selection while keeping the paired session alive (`R3-09`). */
  backToLanImportCatalog(): Promise<void>;
  disconnectLanImport(): Promise<void>;
  clearLanImportError(): void;
}

export interface RevealRequest {
  nonce: number;
  nodeId: string;
}

export interface InspectRequest {
  nonce: number;
  nodeId: string;
}

const SLOT_EPSILON = 24;

function isSlotOccupied(nodes: readonly MindMapNode[], x: number, y: number): boolean {
  return nodes.some(
    (node) => Math.abs(node.posX - x) < SLOT_EPSILON && Math.abs(node.posY - y) < SLOT_EPSILON,
  );
}

/**
 * Children stack to the right of their parent; roots cascade from the origin.
 * Picks the first unoccupied slot so deleting a card never causes the next
 * excerpt to land on top of a surviving card (#116).
 */
export function nextNodePosition(
  nodes: readonly MindMapNode[],
  parentNodeId: string | null,
): { x: number; y: number } {
  const parent = parentNodeId ? nodes.find((node) => node.id === parentNodeId) : undefined;
  if (parent) {
    const siblings = nodes.filter((node) => node.parentNodeId === parent.id).length;
    const x = parent.posX + CHILD_OFFSET_X;
    for (let slot = siblings; ; slot += 1) {
      const y = parent.posY + slot * SIBLING_OFFSET_Y;
      if (!isSlotOccupied(nodes, x, y)) return { x, y };
    }
  }
  const roots = nodes.filter((node) => node.parentNodeId === null).length;
  for (let slot = roots; ; slot += 1) {
    const x = ROOT_ORIGIN.x + slot * ROOT_CASCADE;
    const y = ROOT_ORIGIN.y + slot * ROOT_CASCADE;
    if (!isSlotOccupied(nodes, x, y)) return { x, y };
  }
}

export function selectHighlights(
  annotations: readonly Annotation[],
  documentId: string,
): ReaderHighlight[] {
  return annotations
    .filter((annotation) => annotation.documentId === documentId)
    .map((annotation) => ({
      annotationId: annotation.id,
      anchor: annotation.anchor,
      color: annotation.color,
      style: annotation.style,
      hasNote: annotationHasNote(annotation),
    }));
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

/** The closed-tab stack without a tab that is open again. */
function withoutClosed(closedDocumentIds: readonly string[], documentId: string): string[] {
  return closedDocumentIds.filter((id) => id !== documentId);
}

/**
 * The document ⇧⌘T would reopen: the newest closed tab that still exists and is
 * not open again. Undefined when Reopen Closed Tab would do nothing.
 */
export function selectReopenableDocumentId(
  closedDocumentIds: readonly string[],
  openDocumentIds: readonly string[],
  documents: readonly StudyDocument[],
  lockedDocumentIds: readonly string[] = [],
): string | null {
  for (let index = closedDocumentIds.length - 1; index >= 0; index -= 1) {
    const id = closedDocumentIds[index];
    if (id === undefined) continue;
    // A tab opened again by Open or Recent is no longer a closed tab.
    if (openDocumentIds.includes(id)) continue;
    if (lockedDocumentIds.includes(id)) continue;
    if (!documents.some((document) => document.id === id)) continue;
    return id;
  }
  return null;
}

function withoutLastDeletion(order: readonly DeletionKind[], kind: DeletionKind): DeletionKind[] {
  const index = order.lastIndexOf(kind);
  if (index === -1) return [...order];
  return [...order.slice(0, index), ...order.slice(index + 1)];
}

/**
 * The bi-directional bus between the Reader and the MindMap. Neither side knows
 * the other exists: readers publish selections and consume jump requests, the
 * canvas publishes jumps and renders the excerpts that selections become.
 */
export function createStudySyncStore(backend: StudyBackend) {
  let jumpNonce = 0;
  let revealNonce = 0;
  let inspectNonce = 0;
  let preferencesSaveSeq = 0;
  let preferencesWriteChain: Promise<void> = Promise.resolve();

  return create<StudySyncState>((set, get) => {
    /**
     * Deletes still on their way to the backend, by annotation or card id. Undo
     * waits for one, so a quick ⌘Z cannot reach the backend before the delete it undoes.
     */
    const pendingDeletes = new Map<string, Promise<void>>();
    const pendingCardDeletes = new Map<string, Promise<void>>();
    /** In-flight `updateDocumentCursor` writes, by document id. */
    const pendingCursorWrites = new Map<string, Set<Promise<void>>>();
    /** Active mounted `<Viewer>` counts, registered by sibling `<UnmountSentinel>`. */
    const mountedViewerCounts = new Map<string, number>();
    /** Waiters resolved when the last mounted viewer for a document unmounts. */
    const viewerUnmountWaiters = new Map<string, Set<() => void>>();
    /** Reference-counted reopen locks, by document id. */
    const documentLockCounts = new Map<string, number>();
    /**
     * Monotonic counter incremented whenever a lock is acquired for a document.
     * In-flight async requests capture the epoch before awaiting backend I/O so
     * a response that started before a close-and-apply cycle cannot overwrite
     * refreshed state after the lock is released.
     */
    const documentLockEpochs = new Map<string, number>();
    /** Monotonic per-document sequence numbers for `refreshDocument` and `refreshBookmarks`. */
    const documentRefreshSeqs = new Map<string, number>();
    const bookmarkRefreshSeqs = new Map<string, number>();

    const isDocumentLocked = (documentId: string): boolean =>
      (documentLockCounts.get(documentId) ?? 0) > 0;

    const getDocumentLockEpoch = (documentId: string): number =>
      documentLockEpochs.get(documentId) ?? 0;

    const getDocumentRefreshSeq = (documentId: string): number =>
      documentRefreshSeqs.get(documentId) ?? 0;

    const nextDocumentRefreshSeq = (documentId: string): number => {
      const next = getDocumentRefreshSeq(documentId) + 1;
      documentRefreshSeqs.set(documentId, next);
      return next;
    };

    const acquireLock = (documentId: string): (() => void) => {
      documentLockEpochs.set(documentId, getDocumentLockEpoch(documentId) + 1);
      const nextCount = (documentLockCounts.get(documentId) ?? 0) + 1;
      documentLockCounts.set(documentId, nextCount);
      if (nextCount === 1) {
        set((state) =>
          state.lockedDocumentIds.includes(documentId)
            ? state
            : { lockedDocumentIds: [...state.lockedDocumentIds, documentId] },
        );
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = documentLockCounts.get(documentId) ?? 0;
        if (current <= 1) {
          documentLockCounts.delete(documentId);
          set((state) =>
            state.lockedDocumentIds.includes(documentId)
              ? { lockedDocumentIds: state.lockedDocumentIds.filter((id) => id !== documentId) }
              : state,
          );
        } else {
          documentLockCounts.set(documentId, current - 1);
        }
      };
    };

    const guarded = async (write: () => Promise<void>, rollback?: () => void) => {
      try {
        await write();
      } catch (error) {
        rollback?.();
        set({ error: describeError(error) });
      }
    };

    const persistSession = () => {
      const { openDocumentIds, activeDocumentId, immersive, paneLayout } = get();
      void guarded(async () => {
        await backend.saveWorkspaceSession({
          openDocumentIds,
          activeDocumentId,
          immersive,
          paneLayout,
        });
      });
    };

    const checkDocumentSource = async (
      documentId: string,
    ): Promise<DocumentSourceStatus | null> => {
      if (!get().documents.some((doc) => doc.id === documentId)) return null;
      const lockEpoch = getDocumentLockEpoch(documentId);
      let status: DocumentSourceStatus | null = null;
      await guarded(async () => {
        status = await backend.verifyDocumentSource(documentId);
        if (isDocumentLocked(documentId) || getDocumentLockEpoch(documentId) !== lockEpoch) {
          status = null;
          return;
        }
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

    const applyOpenedDocuments = (
      opened: readonly StudyDocument[],
      error?: unknown,
      epochsAtStart?: ReadonlyMap<string, number>,
      seqsAtStart?: ReadonlyMap<string, number>,
    ) => {
      const committedIds = new Set<string>();
      set((state) => {
        let documents = state.documents;
        let openDocumentIds = state.openDocumentIds;
        const documentSourceStatuses = { ...state.documentSourceStatuses };
        const relinkedNonceByDocumentId = { ...state.relinkedNonceByDocumentId };
        const unlockedOpened: StudyDocument[] = [];
        for (const document of opened) {
          if (isDocumentLocked(document.id)) {
            if (!documents.some((d) => d.id === document.id)) {
              documents = [...documents, document];
            }
            continue;
          }
          const currentEpoch = getDocumentLockEpoch(document.id);
          if (
            epochsAtStart !== undefined &&
            currentEpoch !== (epochsAtStart.get(document.id) ?? 0)
          ) {
            // A close-and-apply lock was acquired (and possibly released) while this
            // open/drop request was in flight, invalidating the pre-lock snapshot.
            continue;
          }
          if (
            seqsAtStart !== undefined &&
            getDocumentRefreshSeq(document.id) !== (seqsAtStart.get(document.id) ?? 0)
          ) {
            // A newer open, drop, relink, or refresh superseded this response.
            continue;
          }
          const existing = documents.find((d) => d.id === document.id);
          if (existing !== undefined && existing.filePath !== document.filePath) {
            relinkedNonceByDocumentId[document.id] =
              (relinkedNonceByDocumentId[document.id] ?? 0) + 1;
          }
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
          unlockedOpened.push(document);
          committedIds.add(document.id);
        }
        const lastOpened = unlockedOpened.at(-1);
        return {
          documents,
          documentSourceStatuses,
          relinkedNonceByDocumentId,
          openDocumentIds,
          // Opening a file again takes it off the closed-tab stack.
          closedDocumentIds: state.closedDocumentIds.filter(
            (id) => !unlockedOpened.some((document) => document.id === id),
          ),
          activeDocumentId: lastOpened ? lastOpened.id : state.activeDocumentId,
          selection: unlockedOpened.length > 0 ? null : state.selection,
          ...(error !== undefined && error !== null ? { error: describeError(error) } : {}),
        };
      });
      for (const id of committedIds) {
        nextDocumentRefreshSeq(id);
      }
      if (committedIds.size > 0) persistSession();
    };

    const reconcileAndApplyOpenedDocuments = async (
      opened: readonly StudyDocument[],
      error: unknown,
      epochsAtStart: ReadonlyMap<string, number>,
      seqsAtStart: ReadonlyMap<string, number>,
    ) => {
      const hasSeqConflict = opened.some(
        (doc) =>
          !isDocumentLocked(doc.id) &&
          getDocumentLockEpoch(doc.id) === (epochsAtStart.get(doc.id) ?? 0) &&
          getDocumentRefreshSeq(doc.id) !== (seqsAtStart.get(doc.id) ?? 0),
      );
      if (!hasSeqConflict) {
        applyOpenedDocuments(opened, error, epochsAtStart, seqsAtStart);
        return;
      }
      // Another non-lock open, drop, or refresh completed while this picker or
      // drop was awaiting. Re-read the authoritative DB rows under fresh
      // per-document sequence numbers (keeping `epochsAtStart` so any sync lock
      // still invalidates the request) so a valid selection is applied with the
      // latest path without letting an older response regress state.
      const reconcileSeqs = new Map<string, number>();
      for (const doc of opened) {
        if (
          !isDocumentLocked(doc.id) &&
          getDocumentLockEpoch(doc.id) === (epochsAtStart.get(doc.id) ?? 0)
        ) {
          reconcileSeqs.set(doc.id, nextDocumentRefreshSeq(doc.id));
        }
      }
      const allDocuments = await backend.listDocuments();
      const byId = new Map(allDocuments.map((doc) => [doc.id, doc]));
      const resolved = opened
        .filter(
          (doc) =>
            !isDocumentLocked(doc.id) &&
            reconcileSeqs.has(doc.id) &&
            getDocumentRefreshSeq(doc.id) === reconcileSeqs.get(doc.id),
        )
        .map((doc) => byId.get(doc.id) ?? doc);
      if (resolved.length === 0 && (error === undefined || error === null)) return;
      applyOpenedDocuments(resolved, error, epochsAtStart, reconcileSeqs);
    };

    const openNativeDroppedDocuments = (dropped: readonly StudyDocument[], error?: unknown) => {
      const knownIds = new Set(get().documents.map((doc) => doc.id));
      const hasUnlockedKnownDocument = dropped.some(
        (doc) => knownIds.has(doc.id) && !isDocumentLocked(doc.id),
      );
      if (!hasUnlockedKnownDocument) {
        // Either all dropped docs are brand new, or every known doc is currently
        // locked (so applyOpenedDocuments skips locked known docs without bumping
        // any refresh sequence and without interfering with in-lock refreshes).
        applyOpenedDocuments(dropped, error);
        return;
      }
      // Native drop push events carry no request id and may race with sync or
      // move a known document to a new path. Read the authoritative DB rows
      // under both a lock-epoch snapshot and per-document sequence numbers so
      // out-of-order responses can never overwrite a newer path or synced state.
      // Never bump sequence numbers for locked documents, or a drop arriving
      // during a sync lock would invalidate the sync's own `refreshDocument`.
      const epochsAtStart = new Map(documentLockEpochs);
      const seqsAtStart = new Map<string, number>();
      for (const doc of dropped) {
        if (!isDocumentLocked(doc.id)) {
          seqsAtStart.set(doc.id, nextDocumentRefreshSeq(doc.id));
        }
      }
      void guarded(async () => {
        const allDocuments = await backend.listDocuments();
        const byId = new Map(allDocuments.map((doc) => [doc.id, doc]));
        const resolved = dropped
          .filter(
            (doc) =>
              !isDocumentLocked(doc.id) &&
              seqsAtStart.has(doc.id) &&
              getDocumentRefreshSeq(doc.id) === seqsAtStart.get(doc.id),
          )
          .map((doc) => byId.get(doc.id) ?? doc);
        if (resolved.length === 0 && (error === undefined || error === null)) return;
        applyOpenedDocuments(resolved, error, epochsAtStart, seqsAtStart);
      });
    };

    // Leaving full screen by any other route (the window's button, View ▸ Exit Full
    // Screen) hands it back to the reader: a later exit from focus mode leaves it be.
    // Only a real true → false transition counts: the first report after a resize can
    // be a stale `false` while the window is still animating into full screen.
    backend.onFullscreenChange((fullscreen) =>
      set((state) =>
        !fullscreen && state.fullscreen
          ? { fullscreen, fullscreenFromFocusMode: false }
          : { fullscreen },
      ),
    );

    // Focus mode's full screen is a convenience, so its requests never raise the error
    // banner, entering or leaving: focus mode works without it, and a window left full
    // screen still has its own way out.
    const leaveFocusModeFullscreen = () => {
      void backend
        .setFullscreen(false)
        .then(() => backend.isFullscreen())
        .then((fullscreen) => set({ fullscreen }))
        .catch(() => undefined);
    };

    const enterFocusModeFullscreen = async () => {
      // The store's flag is only as fresh as the last resize, so ask the window: a
      // full screen the reader already chose stays theirs.
      if (await backend.isFullscreen()) {
        set({ fullscreen: true });
        return;
      }
      if (!get().immersive || get().fullscreenFromFocusMode) return;
      set({ fullscreenFromFocusMode: true });
      await backend.setFullscreen(true);
      if (!(await backend.isFullscreen())) {
        set({ fullscreenFromFocusMode: false });
        return;
      }
      if (get().immersive) {
        // Re-asserted in case a report during the animation handed it back.
        set({ fullscreen: true, fullscreenFromFocusMode: true });
      } else {
        // Focus mode ended while the window was still going full screen.
        set({ fullscreen: true, fullscreenFromFocusMode: false });
        leaveFocusModeFullscreen();
      }
    };

    backend.onFileDrop((event) => {
      if (event.type === 'enter') {
        set({ isDraggingFile: true });
      } else if (event.type === 'leave') {
        set({ isDraggingFile: false });
      } else {
        set({ isDraggingFile: false });
        openNativeDroppedDocuments(event.documents, event.error);
      }
    });

    backend.onLanShareEvent((payload: LanShareEventPayload) => {
      if (!isLanShareSnapshot(payload.snapshot)) return;
      set((state) => ({
        lanShare: {
          ...state.lanShare,
          snapshot: payload.snapshot,
        },
      }));
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
      closedDocumentIds: [],
      lockedDocumentIds: [],
      isDraggingFile: false,
      immersive: false,
      paneLayout: { ...DEFAULT_WORKSPACE_PANE_LAYOUT },
      fullscreen: false,
      fullscreenFromFocusMode: false,
      chromeStyle: backend.chromeStyle,
      readingPreferences: { ...DEFAULT_READING_PREFERENCES },
      pdfLayouts: {},
      bookmarks: [],
      notebook: null,
      annotations: [],
      deletedAnnotationHistory: [],
      deletedCardHistory: [],
      deletionOrder: [],
      cards: [],
      nodes: [],
      edges: [],
      selection: null,
      isExcerpting: false,
      selectedNodeId: null,
      nestingTargetNodeId: null,
      revealRequest: null,
      inspectRequest: null,
      excerptNonce: 0,
      jumpRequest: null,
      lanShare: { ...INITIAL_LAN_SHARE_SLICE, snapshot: { ...INITIAL_LAN_SHARE_SNAPSHOT } },
      lanImport: { ...INITIAL_LAN_IMPORT_SLICE },

      async initialize() {
        if (get().status === 'loading' || get().status === 'ready') return;
        set({ status: 'loading', error: null });
        try {
          const [documents, notebooks, readingPreferences, bookmarks, session, fullscreen] =
            await Promise.all([
              backend.listDocuments(),
              backend.listNotebooks(),
              backend.getReadingPreferences(),
              backend.listBookmarks(),
              backend.getWorkspaceSession(),
              // The window may start full screen (restored by the OS) before any resize.
              backend.isFullscreen().catch(() => false),
            ]);
          const notebook = notebooks[0] ?? (await backend.createNotebook(DEFAULT_NOTEBOOK_TITLE));
          const graph = await backend.loadNotebookGraph(notebook.id);
          const knownIds = new Set(documents.map((doc) => doc.id));
          const openDocumentIds = session.openDocumentIds.filter(
            (id) => knownIds.has(id) && !isDocumentLocked(id),
          );
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
            paneLayout: session.paneLayout
              ? { ...session.paneLayout }
              : { ...DEFAULT_WORKSPACE_PANE_LAYOUT },
            fullscreen,
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
        const epochsAtStart = new Map(documentLockEpochs);
        const seqsAtStart = new Map(documentRefreshSeqs);
        await guarded(async () => {
          const document = await backend.pickDocument();
          if (document === null) return;
          await reconcileAndApplyOpenedDocuments([document], undefined, epochsAtStart, seqsAtStart);
        });
      },

      async reopenRecentDocument(documentId) {
        if (isDocumentLocked(documentId)) return;
        if (!get().documents.some((doc) => doc.id === documentId)) return;
        const lockEpoch = getDocumentLockEpoch(documentId);
        const refreshSeq = nextDocumentRefreshSeq(documentId);
        await guarded(async () => {
          const [touched, status] = await Promise.all([
            backend.touchDocumentOpened(documentId),
            backend.verifyDocumentSource(documentId),
          ]);
          // A close-and-apply lock or newer open/drop/refresh may have occurred
          // while awaiting backend I/O, invalidating this snapshot.
          if (
            isDocumentLocked(documentId) ||
            getDocumentLockEpoch(documentId) !== lockEpoch ||
            getDocumentRefreshSeq(documentId) !== refreshSeq
          ) {
            return;
          }
          set((state) => ({
            documents: state.documents.map((doc) => (doc.id === documentId ? touched : doc)),
            documentSourceStatuses: {
              ...state.documentSourceStatuses,
              [documentId]: status,
            },
            openDocumentIds: state.openDocumentIds.includes(documentId)
              ? state.openDocumentIds
              : [...state.openDocumentIds, documentId],
            closedDocumentIds: withoutClosed(state.closedDocumentIds, documentId),
            activeDocumentId: documentId,
            selection: state.activeDocumentId === documentId ? state.selection : null,
          }));
          persistSession();
        });
      },

      async reopenClosedDocument() {
        const { closedDocumentIds, openDocumentIds, documents, lockedDocumentIds } = get();
        const documentId = selectReopenableDocumentId(
          closedDocumentIds,
          openDocumentIds,
          documents,
          lockedDocumentIds,
        );
        if (documentId === null) return;
        await get().reopenRecentDocument(documentId);
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
          nextDocumentRefreshSeq(documentId);
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
        const epochsAtStart = new Map(documentLockEpochs);
        const seqsAtStart = new Map(documentRefreshSeqs);
        await guarded(async () => {
          const { documents, error } = await backend.dropFiles(files);
          await reconcileAndApplyOpenedDocuments(documents, error, epochsAtStart, seqsAtStart);
        });
      },

      activateDocument(documentId) {
        if (isDocumentLocked(documentId)) return;
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
          const pdfLayouts = { ...state.pdfLayouts };
          delete pdfLayouts[documentId];
          return {
            openDocumentIds,
            activeDocumentId,
            pdfLayouts,
            // ⇧⌘T remembers the order tabs were closed in, bounded for the session.
            closedDocumentIds: [
              ...withoutClosed(state.closedDocumentIds, documentId),
              documentId,
            ].slice(-MAX_CLOSED_TABS),
            selection: state.selection?.documentId === documentId ? null : state.selection,
            jumpRequest: state.jumpRequest?.documentId === documentId ? null : state.jumpRequest,
          };
        });
        persistSession();
      },

      async flushCursorWrites(documentId) {
        // Loop in case another cursor write starts while awaiting the current batch.
        for (;;) {
          const writes = pendingCursorWrites.get(documentId);
          if (!writes || writes.size === 0) return;
          await Promise.allSettled([...writes]);
        }
      },

      registerMountedViewer(documentId) {
        mountedViewerCounts.set(documentId, (mountedViewerCounts.get(documentId) ?? 0) + 1);
        let unregistered = false;
        return () => {
          if (unregistered) return;
          unregistered = true;
          const current = mountedViewerCounts.get(documentId) ?? 0;
          if (current <= 1) {
            mountedViewerCounts.delete(documentId);
            const waiters = viewerUnmountWaiters.get(documentId);
            if (waiters) {
              viewerUnmountWaiters.delete(documentId);
              for (const resolve of waiters) resolve();
            }
          } else {
            mountedViewerCounts.set(documentId, current - 1);
          }
        };
      },

      lockDocument(documentId) {
        return acquireLock(documentId);
      },

      async withDocumentLock(documentId, run) {
        const release = acquireLock(documentId);
        try {
          return await run();
        } finally {
          release();
        }
      },

      async closeDocumentAndFlush(documentId) {
        const release = acquireLock(documentId);
        try {
          const isMounted = (mountedViewerCounts.get(documentId) ?? 0) > 0;
          const wasOpen = get().openDocumentIds.includes(documentId);
          // Wait whenever a viewer is still mounted, even if a concurrent
          // `closeDocumentAndFlush` already removed `documentId` from
          // `openDocumentIds` before React committed the unmount.
          let unmountPromise: Promise<void> | null = null;
          if (isMounted) {
            unmountPromise = new Promise<void>((resolve) => {
              let waiters = viewerUnmountWaiters.get(documentId);
              if (!waiters) {
                waiters = new Set();
                viewerUnmountWaiters.set(documentId, waiters);
              }
              waiters.add(resolve);
            });
          }
          if (wasOpen) {
            get().closeDocument(documentId);
          }
          if (unmountPromise) {
            await unmountPromise;
          }
          await get().flushCursorWrites(documentId);
        } finally {
          release();
        }
      },

      async refreshDocument(documentId) {
        const lockEpoch = getDocumentLockEpoch(documentId);
        const startedWhileLocked = isDocumentLocked(documentId);
        const refreshSeq = nextDocumentRefreshSeq(documentId);
        let refreshed: StudyDocument | null = null;
        await guarded(async () => {
          const documents = await backend.listDocuments();
          if (
            getDocumentLockEpoch(documentId) !== lockEpoch ||
            getDocumentRefreshSeq(documentId) !== refreshSeq ||
            (!startedWhileLocked && isDocumentLocked(documentId))
          ) {
            return;
          }
          const target = documents.find((doc) => doc.id === documentId);
          if (!target) return;
          refreshed = target;
          set((state) => {
            const previous = state.documents.find((doc) => doc.id === documentId);
            const nextDocuments = previous
              ? state.documents.map((doc) => (doc.id === documentId ? target : doc))
              : [...state.documents, target];

            const wasMissing = state.documentSourceStatuses[documentId]?.state === 'missing';
            const filePathChanged = previous !== undefined && previous.filePath !== target.filePath;
            if (wasMissing && filePathChanged) {
              return {
                documents: nextDocuments,
                documentSourceStatuses: {
                  ...state.documentSourceStatuses,
                  [documentId]: {
                    documentId,
                    state: 'ok',
                    currentFileHash: target.fileHash,
                    fileSizeBytes: null,
                  },
                },
                relinkedNonceByDocumentId: {
                  ...state.relinkedNonceByDocumentId,
                  [documentId]: (state.relinkedNonceByDocumentId[documentId] ?? 0) + 1,
                },
                selection: state.selection?.documentId === documentId ? null : state.selection,
              };
            }

            return { documents: nextDocuments };
          });
        });
        return refreshed;
      },

      async refreshBookmarks(documentId) {
        const lockEpoch = getDocumentLockEpoch(documentId);
        const startedWhileLocked = isDocumentLocked(documentId);
        const refreshSeq = (bookmarkRefreshSeqs.get(documentId) ?? 0) + 1;
        bookmarkRefreshSeqs.set(documentId, refreshSeq);
        await guarded(async () => {
          const allBookmarks = await backend.listBookmarks();
          if (
            getDocumentLockEpoch(documentId) !== lockEpoch ||
            bookmarkRefreshSeqs.get(documentId) !== refreshSeq ||
            (!startedWhileLocked && isDocumentLocked(documentId))
          ) {
            return;
          }
          const forDocument = allBookmarks.filter((bookmark) => bookmark.documentId === documentId);
          set((state) => ({
            bookmarks: [
              ...state.bookmarks.filter((bookmark) => bookmark.documentId !== documentId),
              ...forDocument,
            ],
          }));
        });
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

      onBeforeClose: (listener) => backend.onBeforeClose(listener),

      setPaneLayout(patch) {
        const current = get().paneLayout;
        const next: WorkspacePaneLayout = { ...current, ...patch };
        if (
          next.mindMapOpen === current.mindMapOpen &&
          next.inspectorOpen === current.inspectorOpen &&
          next.mindMapSize === current.mindMapSize &&
          next.inspectorSize === current.inspectorSize
        ) {
          return;
        }
        set({ paneLayout: next });
        persistSession();
      },

      setImmersive(immersive) {
        if (get().immersive === immersive) return;
        set({ immersive });
        persistSession();
        const { readingPreferences, fullscreen, fullscreenFromFocusMode } = get();
        if (immersive && readingPreferences.focusModeFullScreen && !fullscreen) {
          void enterFocusModeFullscreen().catch(() => set({ fullscreenFromFocusMode: false }));
        } else if (!immersive && fullscreenFromFocusMode) {
          set({ fullscreenFromFocusMode: false });
          leaveFocusModeFullscreen();
        }
      },

      reportCursor(documentId, anchor, progress) {
        if (anchor === null) return;
        set((state) => ({
          documents: state.documents.map((document) =>
            document.id === documentId
              ? { ...document, lastCursorAnchor: anchor, lastProgress: progress ?? null }
              : document,
          ),
        }));
        let writes = pendingCursorWrites.get(documentId);
        if (!writes) {
          writes = new Set();
          pendingCursorWrites.set(documentId, writes);
        }
        const bucket = writes;
        const tracked = guarded(() =>
          backend.updateDocumentCursor(documentId, anchor, progress),
        ).finally(() => {
          bucket.delete(tracked);
          if (bucket.size === 0) pendingCursorWrites.delete(documentId);
        });
        bucket.add(tracked);
      },

      captureUrl: (annotationId) => backend.captureUrl(annotationId),

      setSelection: (selection) => set({ selection }),

      async excerptSelection() {
        const { selection, notebook, isExcerpting, nestingTargetNodeId, nodes } = get();
        if (!selection || !notebook || isExcerpting) return;

        const parentNodeId = nodes.some((node) => node.id === nestingTargetNodeId)
          ? nestingTargetNodeId
          : null;
        const position = nextNodePosition(nodes, parentNodeId);
        set({ isExcerpting: true });
        try {
          const created = await backend.createExcerpt({
            documentId: selection.documentId,
            notebookId: notebook.id,
            anchor: selection.anchor,
            excerptText: selection.text,
            excerptImagePng: selection.imagePng,
            color: DEFAULT_EXCERPT_COLOR,
            parentNodeId,
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
            isExcerpting: false,
            excerptNonce: state.excerptNonce + 1,
          }));
          // The new card is selected and shown so it can be found, but the
          // nesting target stays whatever the reader chose.
          get().revealNode(created.node.id);
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
        const removedFromCards = new Map(
          get()
            .cards.filter((card) => card.annotationIds.includes(annotationId))
            .map((card) => [card.id, card.annotationIds.indexOf(annotationId)]),
        );
        set((state) => ({
          annotations: state.annotations.filter((annotation) => annotation.id !== annotationId),
          deletedAnnotationHistory: [...state.deletedAnnotationHistory, { annotation: removed }],
          deletionOrder: [...state.deletionOrder, 'annotation'],
          cards: state.cards.map((card) =>
            removedFromCards.has(card.id)
              ? {
                  ...card,
                  annotationIds: card.annotationIds.filter((id) => id !== annotationId),
                }
              : card,
          ),
        }));
        const deleting = guarded(
          () => backend.deleteAnnotation(annotationId),
          () =>
            set((state) => ({
              annotations: [...state.annotations, removed],
              deletedAnnotationHistory: state.deletedAnnotationHistory.filter(
                (entry) => entry.annotation.id !== removed.id,
              ),
              deletionOrder: withoutLastDeletion(state.deletionOrder, 'annotation'),
              cards: state.cards.map((card) => {
                const index = removedFromCards.get(card.id);
                if (index === undefined || card.annotationIds.includes(annotationId)) return card;
                const annotationIds = [...card.annotationIds];
                annotationIds.splice(Math.min(index, annotationIds.length), 0, annotationId);
                return { ...card, annotationIds };
              }),
            })),
        );
        pendingDeletes.set(annotationId, deleting);
        await deleting;
        pendingDeletes.delete(annotationId);
      },

      async undoRemoveAnnotation() {
        const last = get().deletedAnnotationHistory.at(-1);
        if (!last) return null;
        const annotationId = last.annotation.id;
        set((state) => ({
          deletedAnnotationHistory: state.deletedAnnotationHistory.slice(0, -1),
          deletionOrder: withoutLastDeletion(state.deletionOrder, 'annotation'),
        }));
        await pendingDeletes.get(annotationId);
        // The delete failed and was rolled back: the highlight is already back.
        if (get().annotations.some((annotation) => annotation.id === annotationId)) return null;

        // Core restores the original row, so the id, the capture, and the cards that
        // cite it all come back, and the card's jump link works again (#97).
        let restored: Annotation | null = null;
        await guarded(
          async () => {
            const result = await backend.restoreAnnotation(annotationId);
            restored = result.annotation;
            const restoredCards = new Map(result.cards.map((card) => [card.id, card]));
            set((state) => ({
              annotations: [...state.annotations, result.annotation],
              cards: state.cards.map((card) => {
                const restoredCard = restoredCards.get(card.id);
                return restoredCard ? { ...card, annotationIds: restoredCard.annotationIds } : card;
              }),
            }));
          },
          () =>
            set((state) => ({
              deletedAnnotationHistory: [...state.deletedAnnotationHistory, last],
              deletionOrder: [...state.deletionOrder, 'annotation'],
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
        if (isDocumentLocked(annotation.documentId)) return;

        jumpNonce += 1;
        set((state) => ({
          openDocumentIds: state.openDocumentIds.includes(annotation.documentId)
            ? state.openDocumentIds
            : [...state.openDocumentIds, annotation.documentId],
          closedDocumentIds: withoutClosed(state.closedDocumentIds, annotation.documentId),
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
        if (isDocumentLocked(annotation.documentId)) return;

        jumpNonce += 1;
        set((state) => ({
          openDocumentIds: state.openDocumentIds.includes(annotation.documentId)
            ? state.openDocumentIds
            : [...state.openDocumentIds, annotation.documentId],
          closedDocumentIds: withoutClosed(state.closedDocumentIds, annotation.documentId),
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

      selectNode: (nodeId) => set({ selectedNodeId: nodeId, nestingTargetNodeId: nodeId }),

      revealNode(nodeId) {
        revealNonce += 1;
        set({ selectedNodeId: nodeId, revealRequest: { nonce: revealNonce, nodeId } });
      },

      completeReveal(nonce) {
        // A newer reveal may already be pending; never clear that one.
        if (get().revealRequest?.nonce === nonce) set({ revealRequest: null });
      },

      inspectNode(nodeId) {
        inspectNonce += 1;
        set({ selectedNodeId: nodeId, inspectRequest: { nonce: inspectNonce, nodeId } });
      },

      completeInspect(nonce) {
        if (get().inspectRequest?.nonce === nonce) set({ inspectRequest: null });
      },

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
        let saved = false;
        await guarded(async () => {
          const card = await backend.updateCard(cardId, patch);
          saved = true;
          // CardPatch never edits annotationIds; keeping the store's links avoids
          // clobbering concurrent delete/restore updates with an older snapshot (#97).
          set((state) => ({
            cards: state.cards.map((candidate) =>
              candidate.id === cardId
                ? { ...card, annotationIds: candidate.annotationIds }
                : candidate,
            ),
          }));
        });
        return saved;
      },

      async removeCard(cardId) {
        // Flush any pending Inspector edits first so Undo preserves them and no stale
        // `updateCard` races with the deletion (#116, #117).
        if (hasPendingBeforeCloseFlush()) {
          await flushBeforeClose();
        }
        const current = get();
        const removedCard = current.cards.find((candidate) => candidate.id === cardId);
        if (!removedCard) return;

        const removedNodes = current.nodes.filter((node) => node.cardId === cardId);
        const removedNodeIds = new Set(removedNodes.map((node) => node.id));
        const removedEdges = current.edges.filter(
          (edge) => removedNodeIds.has(edge.sourceNodeId) || removedNodeIds.has(edge.targetNodeId),
        );
        const removedEdgeIds = new Set(removedEdges.map((edge) => edge.id));
        const childParentLinks: Array<[string, string]> = [];
        for (const node of current.nodes) {
          if (
            !removedNodeIds.has(node.id) &&
            node.parentNodeId !== null &&
            removedNodeIds.has(node.parentNodeId)
          ) {
            childParentLinks.push([node.id, node.parentNodeId]);
          }
        }
        const rerootedIds = new Set(childParentLinks.map(([childId]) => childId));

        const snapshot: DeletedCardSnapshot = {
          card: removedCard,
          nodes: removedNodes,
          edges: removedEdges,
          childParentLinks,
        };

        set((state) => ({
          cards: state.cards.filter((candidate) => candidate.id !== cardId),
          nodes: state.nodes
            .filter((node) => !removedNodeIds.has(node.id))
            .map((node) => (rerootedIds.has(node.id) ? { ...node, parentNodeId: null } : node)),
          edges: state.edges.filter((edge) => !removedEdgeIds.has(edge.id)),
          selectedNodeId:
            state.selectedNodeId !== null && removedNodeIds.has(state.selectedNodeId)
              ? null
              : state.selectedNodeId,
          nestingTargetNodeId:
            state.nestingTargetNodeId !== null && removedNodeIds.has(state.nestingTargetNodeId)
              ? null
              : state.nestingTargetNodeId,
          revealRequest:
            state.revealRequest && removedNodeIds.has(state.revealRequest.nodeId)
              ? null
              : state.revealRequest,
          inspectRequest:
            state.inspectRequest && removedNodeIds.has(state.inspectRequest.nodeId)
              ? null
              : state.inspectRequest,
          deletedCardHistory: [...state.deletedCardHistory, snapshot],
          deletionOrder: [...state.deletionOrder, 'card'],
        }));

        const deleting = guarded(
          async () => {
            await backend.deleteCard(cardId);
          },
          () => {
            const parentByChild = new Map(childParentLinks);
            set((state) => ({
              cards: state.cards.some((c) => c.id === removedCard.id)
                ? state.cards
                : [...state.cards, removedCard],
              nodes: [
                ...state.nodes.map((node) => {
                  const formerParent = parentByChild.get(node.id);
                  return formerParent !== undefined && node.parentNodeId === null
                    ? { ...node, parentNodeId: formerParent }
                    : node;
                }),
                ...removedNodes.filter(
                  (n) => !state.nodes.some((existing) => existing.id === n.id),
                ),
              ],
              edges: [
                ...state.edges,
                ...removedEdges.filter(
                  (e) => !state.edges.some((existing) => existing.id === e.id),
                ),
              ],
              deletedCardHistory: state.deletedCardHistory.filter(
                (entry) => entry.card.id !== removedCard.id,
              ),
              deletionOrder: withoutLastDeletion(state.deletionOrder, 'card'),
            }));
          },
        );
        pendingCardDeletes.set(cardId, deleting);
        await deleting;
        pendingCardDeletes.delete(cardId);
      },

      async undoRemoveCard() {
        const last = get().deletedCardHistory.at(-1);
        if (!last) return null;
        const cardId = last.card.id;
        set((state) => ({
          deletedCardHistory: state.deletedCardHistory.slice(0, -1),
          deletionOrder: withoutLastDeletion(state.deletionOrder, 'card'),
        }));
        await pendingCardDeletes.get(cardId);
        // The delete failed and was rolled back: the card is already back.
        if (get().cards.some((card) => card.id === cardId)) return null;

        let restored: RestoredCard | null = null;
        await guarded(
          async () => {
            const result = await backend.restoreCard(cardId);
            restored = result;
            const reparented = new Map(result.reparentedChildren.map((child) => [child.id, child]));
            set((state) => ({
              cards: [...state.cards.filter((c) => c.id !== result.card.id), result.card],
              nodes: [
                ...state.nodes
                  .filter((n) => !result.nodes.some((restoredNode) => restoredNode.id === n.id))
                  .map((n) => reparented.get(n.id) ?? n),
                ...result.nodes,
              ],
              edges: [
                ...state.edges.filter(
                  (e) => !result.edges.some((restoredEdge) => restoredEdge.id === e.id),
                ),
                ...result.edges,
              ],
            }));
            const restoredNode = result.nodes[0];
            if (restoredNode) {
              get().revealNode(restoredNode.id);
            }
          },
          () =>
            set((state) => ({
              deletedCardHistory: [...state.deletedCardHistory, last],
              deletionOrder: [...state.deletionOrder, 'card'],
            })),
        );
        return restored;
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
        const seq = ++preferencesSaveSeq;
        set({ readingPreferences: next });
        const run = preferencesWriteChain.then(() =>
          guarded(
            async () => {
              const saved = await backend.saveReadingPreferences(next);
              if (seq === preferencesSaveSeq) {
                set({ readingPreferences: saved });
              }
            },
            () => {
              if (seq === preferencesSaveSeq) {
                set({ readingPreferences: previous });
              }
            },
          ),
        );
        preferencesWriteChain = run.catch(() => undefined);
        await run;
      },

      async loadPdfLayout(documentId) {
        let layout: PdfLayout = DEFAULT_PDF_LAYOUT;
        try {
          layout = await backend.getPdfLayout(documentId);
        } catch (error) {
          // The document still opens, in the default layout.
          set({ error: describeError(error) });
        }
        // A save made while this was loading is newer than what was read, and a tab
        // closed meanwhile must not get its cache back: reopening reads the backend.
        const state = get();
        if (state.pdfLayouts[documentId] || !state.openDocumentIds.includes(documentId)) return;
        set((state) => ({ pdfLayouts: { ...state.pdfLayouts, [documentId]: layout } }));
      },

      async savePdfLayout(documentId, layout) {
        // The viewer already shows the layout, so a failed save keeps it on screen
        // and only reports the error; it is retried by the next change.
        set((state) => ({ pdfLayouts: { ...state.pdfLayouts, [documentId]: layout } }));
        await guarded(async () => {
          await backend.savePdfLayout(documentId, layout);
        });
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
        if (isDocumentLocked(bookmark.documentId)) return;

        jumpNonce += 1;
        set((state) => ({
          openDocumentIds: state.openDocumentIds.includes(bookmark.documentId)
            ? state.openDocumentIds
            : [...state.openDocumentIds, bookmark.documentId],
          closedDocumentIds: withoutClosed(state.closedDocumentIds, bookmark.documentId),
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

      // ---- LAN Book Sync actions (ADR 0008, #144) -------------------------

      async loadLanInterfaces() {
        set((state) => ({
          lanShare: { ...state.lanShare, loading: true, error: null },
        }));
        try {
          const interfaces = await backend.lanListInterfaces();
          set((state) => ({
            lanShare: { ...state.lanShare, interfaces, loading: false },
          }));
          return interfaces;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, loading: false, error: toIpcError(error) },
          }));
          return [];
        }
      },

      async startLanShare(input) {
        set((state) => ({
          lanShare: { ...state.lanShare, loading: true, error: null },
        }));
        try {
          const snapshot = await backend.lanShareStart(input);
          if (snapshot === null) {
            set((state) => ({
              lanShare: { ...state.lanShare, loading: false },
            }));
            return null;
          }
          if (!isLanShareSnapshot(snapshot)) {
            throw { code: 'internal', message: 'invalid LAN share snapshot payload' };
          }
          set((state) => ({
            lanShare: { ...state.lanShare, snapshot, loading: false },
          }));
          return snapshot;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, loading: false, error: toIpcError(error) },
          }));
          return null;
        }
      },

      async refreshLanShareStatus() {
        try {
          const snapshot = await backend.lanShareStatus();
          if (!isLanShareSnapshot(snapshot)) return null;
          set((state) => ({
            lanShare: { ...state.lanShare, snapshot },
          }));
          return snapshot;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, error: toIpcError(error) },
          }));
          return null;
        }
      },

      async regenerateLanShareCode() {
        set((state) => ({
          lanShare: { ...state.lanShare, loading: true, error: null },
        }));
        try {
          const snapshot = await backend.lanShareRegenerateCode();
          if (!isLanShareSnapshot(snapshot)) {
            throw { code: 'internal', message: 'invalid LAN share snapshot payload' };
          }
          set((state) => ({
            lanShare: { ...state.lanShare, snapshot, loading: false },
          }));
          return snapshot;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, loading: false, error: toIpcError(error) },
          }));
          return null;
        }
      },

      async stopLanShare() {
        set((state) => ({
          lanShare: { ...state.lanShare, loading: true, error: null },
        }));
        try {
          const snapshot = await backend.lanShareStop();
          set((state) => ({
            lanShare: {
              ...state.lanShare,
              snapshot: isLanShareSnapshot(snapshot) ? snapshot : { ...INITIAL_LAN_SHARE_SNAPSHOT },
              loading: false,
            },
          }));
          return snapshot;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, loading: false, error: toIpcError(error) },
          }));
          return null;
        }
      },

      async disconnectLanSharePeer() {
        set((state) => ({
          lanShare: { ...state.lanShare, loading: true, error: null },
        }));
        try {
          const snapshot = await backend.lanShareDisconnectPeer();
          set((state) => ({
            lanShare: {
              ...state.lanShare,
              snapshot: isLanShareSnapshot(snapshot) ? snapshot : { ...INITIAL_LAN_SHARE_SNAPSHOT },
              loading: false,
            },
          }));
          return snapshot;
        } catch (error) {
          set((state) => ({
            lanShare: { ...state.lanShare, loading: false, error: toIpcError(error) },
          }));
          return null;
        }
      },

      clearLanShareError() {
        set((state) => ({
          lanShare: { ...state.lanShare, error: null },
        }));
      },

      async connectLanImport(address, code) {
        const operationId = crypto.randomUUID();
        set((state) => ({
          lanImport: {
            ...state.lanImport,
            phase: 'connecting',
            activeOperationId: operationId,
            error: null,
          },
        }));
        try {
          const session = await backend.lanImportConnect({ address, code, operationId });
          const rawCatalog = await backend.lanImportCatalog(session.sessionId);
          const catalog = rawCatalog.filter(isCatalogBookClassification);
          set({
            lanImport: {
              phase: 'catalog',
              session,
              catalog,
              plan: null,
              planProgress: null,
              executionProgress: null,
              executionReport: null,
              activeOperationId: null,
              error: null,
            },
          });
          return session;
        } catch (error) {
          set((state) => ({
            lanImport: {
              ...state.lanImport,
              phase: state.lanImport.session ? 'catalog' : 'idle',
              activeOperationId: null,
              error: toIpcError(error),
            },
          }));
          return null;
        }
      },

      async refreshLanImportCatalog() {
        const session = get().lanImport.session;
        if (!session) return [];
        try {
          const rawCatalog = await backend.lanImportCatalog(session.sessionId);
          const catalog = rawCatalog.filter(isCatalogBookClassification);
          set((state) => ({
            lanImport: { ...state.lanImport, catalog, error: null },
          }));
          return catalog;
        } catch (error) {
          set((state) => ({
            lanImport: { ...state.lanImport, error: toIpcError(error) },
          }));
          return [];
        }
      },

      async planLanImport(bookIds) {
        const session = get().lanImport.session;
        if (!session) return null;
        const operationId = crypto.randomUUID();
        set((state) => ({
          lanImport: {
            ...state.lanImport,
            phase: 'planning',
            plan: null,
            planProgress: { completedBooks: 0, totalBooks: bookIds.length, bookId: '' },
            activeOperationId: operationId,
            error: null,
          },
        }));
        try {
          const result = await backend.lanImportPlan(
            { sessionId: session.sessionId, bookIds, operationId },
            (progress) => {
              set((state) => ({
                lanImport: { ...state.lanImport, planProgress: progress },
              }));
            },
          );
          if (!isLanImportPlanResult(result)) {
            throw { code: 'internal', message: 'invalid LAN import plan payload' };
          }
          set((state) => ({
            lanImport: {
              ...state.lanImport,
              phase: 'preview',
              plan: result,
              activeOperationId: null,
              error: null,
            },
          }));
          return result;
        } catch (error) {
          set((state) => ({
            lanImport: {
              ...state.lanImport,
              phase: 'catalog',
              planProgress: null,
              activeOperationId: null,
              error: toIpcError(error),
            },
          }));
          return null;
        }
      },

      async executeLanImport(decisions) {
        const { session, plan } = get().lanImport;
        if (!session || !plan) return null;
        const operationId = crypto.randomUUID();
        set((state) => ({
          lanImport: {
            ...state.lanImport,
            phase: 'importing',
            executionProgress: null,
            executionReport: null,
            activeOperationId: operationId,
            error: null,
          },
        }));

        const pendingRefreshes: Array<Promise<unknown>> = [];
        try {
          const report = await backend.lanImportExecute(
            {
              sessionId: session.sessionId,
              planId: plan.planId,
              decisions,
              operationId,
            },
            (progress) => {
              if (!isLanImportProgress(progress)) return;
              set((state) => ({
                lanImport: { ...state.lanImport, executionProgress: progress },
              }));
              // Live per-book refresh using `#137` actions (`T-32`, `R2-02`, `R3-06`).
              if (progress.phase === 'bookCompleted' && progress.result.documentId !== null) {
                const docId = progress.result.documentId;
                pendingRefreshes.push(get().refreshDocument(docId), get().refreshBookmarks(docId));
              }
            },
          );
          await Promise.allSettled(pendingRefreshes);
          if (!isLanImportExecutionReport(report)) {
            throw { code: 'internal', message: 'invalid LAN import execution report' };
          }
          set((state) => ({
            lanImport: {
              ...state.lanImport,
              phase: 'results',
              executionReport: report,
              activeOperationId: null,
              error: null,
            },
          }));
          return report;
        } catch (error) {
          await Promise.allSettled(pendingRefreshes);
          set((state) => ({
            lanImport: {
              ...state.lanImport,
              phase: 'preview',
              activeOperationId: null,
              error: toIpcError(error),
            },
          }));
          return null;
        }
      },

      async cancelLanImportOperation() {
        const operationId = get().lanImport.activeOperationId;
        if (!operationId) return false;
        try {
          return await backend.lanImportCancel(operationId);
        } catch {
          return false;
        }
      },

      async backToLanImportCatalog() {
        const session = get().lanImport.session;
        if (!session) return;
        set((state) => ({
          lanImport: {
            ...state.lanImport,
            phase: 'catalog',
            plan: null,
            planProgress: null,
            executionProgress: null,
            executionReport: null,
            activeOperationId: null,
            error: null,
          },
        }));
        await get().refreshLanImportCatalog();
      },

      async disconnectLanImport() {
        const { session, activeOperationId } = get().lanImport;
        if (activeOperationId) {
          await backend.lanImportCancel(activeOperationId).catch(() => false);
        }
        if (session) {
          await backend.lanImportDisconnect(session.sessionId).catch(() => undefined);
        }
        set({
          lanImport: { ...INITIAL_LAN_IMPORT_SLICE },
        });
      },

      clearLanImportError() {
        set((state) => ({
          lanImport: { ...state.lanImport, error: null },
        }));
      },
    };
  });
}

export const useStudySyncStore = createStudySyncStore(createDefaultBackend());
