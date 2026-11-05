/**
 * Domain model shared across the frontend. Mirrors `synapse-core/src/domain.rs`;
 * `fixtures/contract/anchors.json` is checked by tests on both sides.
 */

export type DocumentFormat = 'pdf' | 'epub' | 'txt' | 'md';

/** A rectangle in page space; every coordinate is normalized to 0..1. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Covers both text highlights and rectangular area/image captures. */
export interface PdfAnchor {
  format: 'pdf';
  pageIndex: number;
  rects: NormalizedRect[];
}

export interface EpubAnchor {
  format: 'epub';
  cfiRange: string;
  chapterHref: string;
}

/** Offsets address the source file's bytes, not the decoded text. */
export interface TxtAnchor {
  format: 'txt';
  startByteOffset: number;
  endByteOffset: number;
  lineIndex: number;
}

/** Reserved for V1.1: no reader produces this anchor yet. */
export interface MarkdownAnchor {
  format: 'md';
  astNodeId: string;
  offset: number;
}

/** Position in a document. The MindMap treats this as opaque. */
export type AnchorLocation = PdfAnchor | EpubAnchor | TxtAnchor | MarkdownAnchor;

export type AnchorOf<F extends DocumentFormat> = Extract<AnchorLocation, { format: F }>;

export interface StudyDocument {
  id: string;
  title: string;
  filePath: string;
  fileHash: string;
  format: DocumentFormat;
  encoding: string;
  lastCursorAnchor: AnchorLocation | null;
  createdAt: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface StudyNotebook {
  id: string;
  title: string;
  viewport: Viewport | null;
  createdAt: string;
}

export interface Annotation {
  id: string;
  documentId: string;
  notebookId: string;
  anchor: AnchorLocation;
  excerptText: string | null;
  excerptImagePath: string | null;
  color: string;
  createdAt: string;
}

export interface NoteCard {
  id: string;
  notebookId: string;
  title: string;
  markdownNotes: string;
  tags: string[];
  /** More than one after excerpts are merged into a card. */
  annotationIds: string[];
  createdAt: string;
}

export interface MindMapNode {
  id: string;
  notebookId: string;
  cardId: string;
  /** `null` for a floating root. */
  parentNodeId: string | null;
  posX: number;
  posY: number;
  isCollapsed: boolean;
  style: Record<string, unknown> | null;
}

export interface MindMapEdge {
  id: string;
  notebookId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
}

export interface NotebookGraph {
  notebook: StudyNotebook;
  annotations: Annotation[];
  cards: NoteCard[];
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

export interface CreateExcerptInput {
  documentId: string;
  notebookId: string;
  anchor: AnchorLocation;
  excerptText: string | null;
  excerptImagePath: string | null;
  color: string;
  parentNodeId: string | null;
  posX: number;
  posY: number;
}

export interface CreatedExcerpt {
  annotation: Annotation;
  card: NoteCard;
  node: MindMapNode;
  edge: MindMapEdge | null;
}

export interface CardPatch {
  title: string | null;
  markdownNotes: string | null;
  tags: string[] | null;
}

export interface NodeLayoutPatch {
  posX: number;
  posY: number;
  isCollapsed: boolean;
}

/** One decoded piece of a text file, as sent by `read_text_stream`. */
export interface TextChunk {
  seq: number;
  encoding: string;
  startByteOffset: number;
  endByteOffset: number;
  startLineIndex: number;
  text: string;
  hadReplacements: boolean;
  isLast: boolean;
}

/** Rejection shape of every Tauri command. */
export interface IpcError {
  code: string;
  message: string;
}

/** What a reader reports when the user selects something in a document. */
export interface ReaderSelection {
  documentId: string;
  anchor: AnchorLocation;
  /** `null` for an image/area capture. */
  text: string | null;
  imagePath: string | null;
}

/** A request for a reader to scroll to an anchor and pulse-highlight it. */
export interface JumpRequest {
  /** Unique per request, so jumping twice to one anchor still fires. */
  nonce: number;
  documentId: string;
  annotationId: string;
  anchor: AnchorLocation;
}

/** A persisted highlight a reader should paint over its document. */
export interface ReaderHighlight {
  annotationId: string;
  anchor: AnchorLocation;
  color: string;
}

/**
 * The contract every document engine implements. Readers report through
 * callbacks and receive commands through props; they never touch the database
 * or the MindMap directly.
 */
export interface DocumentViewerProps<F extends DocumentFormat = DocumentFormat> {
  document: StudyDocument & { format: F };
  highlights: ReaderHighlight[];
  /** Set while a jump is outstanding for this document. */
  jumpRequest: JumpRequest | null;
  onSelectionChange: (selection: ReaderSelection | null) => void;
  /** Call once the jump has been scrolled to and pulsed. */
  onJumpHandled: (nonce: number) => void;
  /** Reports reading position so the document can reopen where it was left. */
  onCursorChange: (anchor: AnchorOf<F>) => void;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRect = (value: unknown): value is NormalizedRect => {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  );
};

/** Runtime guard for anchors arriving from outside the type system. */
export function isAnchorLocation(value: unknown): value is AnchorLocation {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Record<string, unknown>;
  switch (anchor.format) {
    case 'pdf':
      return isFiniteNumber(anchor.pageIndex) && Array.isArray(anchor.rects)
        ? anchor.rects.every(isRect)
        : false;
    case 'epub':
      return typeof anchor.cfiRange === 'string' && typeof anchor.chapterHref === 'string';
    case 'txt':
      return (
        isFiniteNumber(anchor.startByteOffset) &&
        isFiniteNumber(anchor.endByteOffset) &&
        isFiniteNumber(anchor.lineIndex)
      );
    case 'md':
      return typeof anchor.astNodeId === 'string' && isFiniteNumber(anchor.offset);
    default:
      return false;
  }
}
