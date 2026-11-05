import type {
  AnchorLocation,
  CardPatch,
  CreatedExcerpt,
  CreateExcerptInput,
  DocumentContentReader,
  MindMapEdge,
  NodeLayoutPatch,
  NoteCard,
  NotebookGraph,
  StudyDocument,
  StudyNotebook,
  Viewport,
} from '@/types/domain';

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
}
