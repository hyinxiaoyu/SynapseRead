import type {
  AnchorLocation,
  Bookmark,
  CardPatch,
  CreateBookmarkInput,
  CreatedExcerpt,
  CreateExcerptInput,
  DocumentContentReader,
  IpcError,
  MindMapEdge,
  NodeLayoutPatch,
  NoteCard,
  NotebookGraph,
  ReadingPreferences,
  StudyDocument,
  StudyNotebook,
  Viewport,
} from '@/types/domain';

export interface DroppedDocumentsPayload {
  documents: StudyDocument[];
  error: IpcError | null;
}

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

  createNotebook(title: string): Promise<StudyNotebook>;
  listNotebooks(): Promise<StudyNotebook[]>;
  saveNotebookViewport(notebookId: string, viewport: Viewport): Promise<void>;
  loadNotebookGraph(notebookId: string): Promise<NotebookGraph>;

  createExcerpt(input: CreateExcerptInput): Promise<CreatedExcerpt>;
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
}
