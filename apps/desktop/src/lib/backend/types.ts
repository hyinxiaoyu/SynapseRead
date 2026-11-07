import type {
  AnchorLocation,
  Annotation,
  AnnotationPatch,
  Bookmark,
  CardPatch,
  CreateAnnotationInput,
  CreateBookmarkInput,
  CreatedExcerpt,
  CreateExcerptInput,
  DocumentContentReader,
  DocumentSourceStatus,
  IpcError,
  MindMapEdge,
  NodeLayoutPatch,
  NoteCard,
  NotebookGraph,
  ReadingPreferences,
  RelinkDocumentResult,
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
  updateDocumentCursor(documentId: string, anchor: AnchorLocation): Promise<void>;
  touchDocumentOpened(documentId: string): Promise<StudyDocument>;
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
  deleteAnnotation(annotationId: string): Promise<void>;
  updateCard(cardId: string, patch: CardPatch): Promise<NoteCard>;
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
}
