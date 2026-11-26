import type {
  AnchorLocation,
  Annotation,
  AnnotationPatch,
  Bookmark,
  CardPatch,
  CatalogBookClassification,
  CreateAnnotationInput,
  CreateBookmarkInput,
  CreatedExcerpt,
  CreateExcerptInput,
  DeletedCard,
  DocumentContentReader,
  DocumentSourceStatus,
  IpcError,
  LanImportConnectInput,
  LanImportExecuteInput,
  LanImportExecutionReport,
  LanImportPlanInput,
  LanImportPlanResult,
  LanImportProgress,
  LanImportSessionInfo,
  LanInterface,
  LanShareEventPayload,
  LanShareSnapshot,
  LanShareStartInput,
  MindMapEdge,
  NodeLayoutPatch,
  NoteCard,
  NotebookGraph,
  PdfLayout,
  PlanProgress,
  ReadingPreferences,
  RelinkDocumentResult,
  RestoredAnnotation,
  RestoredCard,
  StudyDocument,
  StudyNotebook,
  Viewport,
  WorkspaceSession,
} from '@/types/domain';

export interface DroppedDocumentsPayload {
  documents: StudyDocument[];
  error: IpcError | null;
}

/** Whether a native menu item applies right now, and an optional context title. */
export interface MenuItemState {
  id: string;
  enabled: boolean;
  title?: string;
}

/**
 * How the window frame meets the app's toolbar. `overlay`: the toolbar is the
 * title bar (macOS), so it leaves room for the window controls and drags the
 * window. `standard`: the OS draws its own title bar above the app.
 */
export type WindowChromeStyle = 'overlay' | 'standard';

export type FileDropEvent =
  { type: 'enter' } | { type: 'leave' } | ({ type: 'drop' } & DroppedDocumentsPayload);

/**
 * Everything the UI needs from the host. Components and stores depend on this
 * interface only, never on `@tauri-apps/*`, so they run in tests and in a plain
 * browser against `createMemoryBackend`.
 */
export interface StudyBackend extends DocumentContentReader {
  /** Which implementation is active; the UI labels non-persistent sessions. */
  readonly kind: 'tauri' | 'memory';
  readonly chromeStyle: WindowChromeStyle;

  /**
   * Shows the OS file picker and registers the choice; `null` if the user cancels.
   * The UI never handles a path: see `docs/adr/0001-path-scope.md`.
   */
  pickDocument(): Promise<StudyDocument | null>;
  /**
   * Registers files dropped via HTML5 drag-and-drop in the browser/memory
   * backend. In Tauri, native OS file drops are handled in Rust and delivered
   * through `onFileDrop`.
   */
  dropFiles(files: readonly File[]): Promise<DroppedDocumentsPayload>;
  /** Subscribes to native window file-drag and drop events. */
  onFileDrop(listener: (event: FileDropEvent) => void): () => void;
  listDocuments(): Promise<StudyDocument[]>;
  /** `progress` is a fraction `0..1`; leaving it out clears the saved one. */
  updateDocumentCursor(
    documentId: string,
    anchor: AnchorLocation,
    progress?: number,
  ): Promise<void>;
  touchDocumentOpened(documentId: string): Promise<StudyDocument>;
  /**
   * Hides a document from Recent / Continue reading without altering its notes,
   * highlights, cards, bookmarks, or reading cursor. Reopening the file restores it.
   */
  hideDocumentFromRecent(documentId: string): Promise<StudyDocument>;
  /**
   * Stores or clears a metadata display title for `documentId` only when its
   * stored `fileHash` still matches `expectedFileHash`; returns `null` when replaced.
   */
  setDocumentDisplayTitle(
    documentId: string,
    displayTitle: string | null,
    expectedFileHash: string,
  ): Promise<StudyDocument | null>;
  verifyDocumentSource(documentId: string): Promise<DocumentSourceStatus>;
  relinkDocument(
    documentId: string,
    confirmInPlace?: boolean,
  ): Promise<RelinkDocumentResult | null>;
  getWorkspaceSession(): Promise<WorkspaceSession>;
  saveWorkspaceSession(session: WorkspaceSession): Promise<WorkspaceSession>;

  createNotebook(title: string): Promise<StudyNotebook>;
  listNotebooks(): Promise<StudyNotebook[]>;
  saveNotebookViewport(notebookId: string, viewport: Viewport): Promise<void>;
  loadNotebookGraph(notebookId: string): Promise<NotebookGraph>;

  createExcerpt(input: CreateExcerptInput): Promise<CreatedExcerpt>;
  createAnnotation(input: CreateAnnotationInput): Promise<Annotation>;
  updateAnnotation(annotationId: string, patch: AnnotationPatch): Promise<Annotation>;
  /**
   * Deletes an annotation for the reader. Its id, card links, and capture are kept
   * until the next launch so `restoreAnnotation` can undo it exactly.
   */
  deleteAnnotation(annotationId: string): Promise<void>;
  /** Undoes `deleteAnnotation` in this session; `not_found` once it is final. */
  restoreAnnotation(annotationId: string): Promise<RestoredAnnotation>;
  updateCard(cardId: string, patch: CardPatch): Promise<NoteCard>;
  /**
   * Deletes a card, its MindMap node(s), and its connected edges atomically,
   * re-rooting child nodes and keeping source highlights in the reader.
   */
  deleteCard(cardId: string): Promise<DeletedCard>;
  /** Undoes `deleteCard` in this session; `not_found` once snapshots are purged. */
  restoreCard(cardId: string): Promise<RestoredCard>;
  updateNodeLayout(nodeId: string, patch: NodeLayoutPatch): Promise<void>;
  createEdge(
    notebookId: string,
    sourceNodeId: string,
    targetNodeId: string,
    label: string | null,
  ): Promise<MindMapEdge>;
  deleteEdge(edgeId: string): Promise<void>;

  /** A loadable URL for an annotation's capture, or `null` if it has no image. */
  captureUrl(annotationId: string): Promise<string | null>;

  getReadingPreferences(): Promise<ReadingPreferences>;
  saveReadingPreferences(preferences: ReadingPreferences): Promise<ReadingPreferences>;

  /**
   * A PDF's saved layout. One that has none starts from the last saved layout's
   * display and zoom. The rule lives in core; the memory backend mimics it.
   */
  getPdfLayout(documentId: string): Promise<PdfLayout>;
  /** Saves the whole layout, which new PDFs then inherit. */
  savePdfLayout(documentId: string, layout: PdfLayout): Promise<PdfLayout>;

  listBookmarks(): Promise<Bookmark[]>;
  createBookmark(input: CreateBookmarkInput): Promise<Bookmark>;
  deleteBookmark(bookmarkId: string): Promise<void>;

  /** Subscribes to native menu choices, delivered as command-registry ids. */
  onMenuCommand(listener: (commandId: string) => void): () => void;
  /** Enables and retitles native menu items; a no-op where there is no menu. */
  setMenuItemStates(states: readonly MenuItemState[]): Promise<void>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  /** Also fires when the user leaves full screen through the window controls. */
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
  /** Runs an async flush hook when the native window or app is about to close (#117). */
  onBeforeClose(listener: () => Promise<void>): () => void;

  // ---- LAN Book Sync (ADR 0008, #143, #144) -------------------------------

  lanListInterfaces(): Promise<LanInterface[]>;
  /** Starts sharing after native OS confirmation; returns `null` if declined. */
  lanShareStart(input: LanShareStartInput): Promise<LanShareSnapshot | null>;
  lanShareStatus(): Promise<LanShareSnapshot>;
  lanShareRegenerateCode(): Promise<LanShareSnapshot>;
  lanShareStop(): Promise<LanShareSnapshot>;
  lanShareDisconnectPeer(): Promise<LanShareSnapshot>;
  onLanShareEvent(listener: (payload: LanShareEventPayload) => void): () => void;

  lanImportConnect(input: LanImportConnectInput): Promise<LanImportSessionInfo>;
  lanImportCatalog(sessionId: string): Promise<CatalogBookClassification[]>;
  lanImportPlan(
    input: LanImportPlanInput,
    onProgress: (progress: PlanProgress) => void,
  ): Promise<LanImportPlanResult>;
  lanImportExecute(
    input: LanImportExecuteInput,
    onProgress: (progress: LanImportProgress) => void,
  ): Promise<LanImportExecutionReport>;
  lanImportCancel(operationId: string): Promise<boolean>;
  lanImportDisconnect(sessionId: string): Promise<void>;
}
