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

/** Normalized rectangles on a single PDF page when an anchor spans multiple pages. */
export interface PdfPageSpan {
  pageIndex: number;
  rects: NormalizedRect[];
}

/** Covers both text highlights (including cross-page spans) and rectangular area/image captures. */
export interface PdfAnchor {
  format: 'pdf';
  pageIndex: number;
  rects: NormalizedRect[];
  pageSpans?: PdfPageSpan[];
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
  lastOpenedAt?: string | null;
  createdAt: string;
}

export type DocumentSourceState = 'ok' | 'missing' | 'changed';

export interface DocumentSourceStatus {
  documentId: string;
  state: DocumentSourceState;
  currentFileHash: string | null;
  fileSizeBytes: number | null;
}

export interface RelinkDocumentResult {
  document: StudyDocument;
  contentChanged: boolean;
  previousFileHash: string;
}

export interface WorkspaceSession {
  openDocumentIds: string[];
  activeDocumentId: string | null;
  /** Immersive reading: reader chrome collapsed and the toolbar auto-hiding. */
  immersive: boolean;
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

/** How an annotation is drawn over its text. Excerpts are always highlights. */
export type AnnotationStyle = 'highlight' | 'underline';

export interface Annotation {
  id: string;
  documentId: string;
  notebookId: string;
  anchor: AnchorLocation;
  excerptText: string | null;
  excerptImagePath: string | null;
  note?: string | null;
  color: string;
  style: AnnotationStyle;
  createdAt: string;
}

/** Whether an annotation has a note worth showing: blank notes do not count. */
export function annotationHasNote(annotation: Pick<Annotation, 'note'>): boolean {
  return (annotation.note?.trim() ?? '') !== '';
}

export interface CreateAnnotationInput {
  documentId: string;
  notebookId: string;
  anchor: AnchorLocation;
  excerptText: string | null;
  excerptImagePng: string | null;
  note: string | null;
  color: string;
  style: AnnotationStyle;
}

export interface AnnotationPatch {
  note: string | null;
  color: string | null;
  /** Omitted or `null` keeps the current style. */
  style?: AnnotationStyle | null;
}

/** What a reader asks for when it creates an annotation from its selection. */
export interface CreateAnnotationOptions {
  color?: string;
  note?: string;
  style?: AnnotationStyle;
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
  /** A base64 PNG. Core decides where it is stored: see ADR 0003. */
  excerptImagePng: string | null;
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

/** Independent reading bookmark inside a document (no card or annotation). */
export interface Bookmark {
  id: string;
  documentId: string;
  anchor: AnchorLocation;
  label: string;
  createdAt: string;
}

export interface CreateBookmarkInput {
  documentId: string;
  anchor: AnchorLocation;
  label: string | null;
}

/** Canonical key identifying a bookmarkable reading location within a document. */
export function bookmarkLocationKey(anchor: AnchorLocation): string {
  switch (anchor.format) {
    case 'pdf':
      return `pdf:${anchor.pageIndex}`;
    case 'epub':
      return `epub:${anchor.chapterHref}:${anchor.cfiRange}`;
    case 'txt':
      return `txt:${anchor.startByteOffset}`;
    case 'md':
      return `md:${anchor.astNodeId}:${anchor.offset}`;
  }
}

/** Fallback human-readable label when a bookmark is created without one. */
export function defaultBookmarkLabel(anchor: AnchorLocation): string {
  switch (anchor.format) {
    case 'pdf':
      return `Page ${anchor.pageIndex + 1}`;
    case 'epub':
      return anchor.chapterHref;
    case 'txt':
      return `Line ${anchor.lineIndex + 1}`;
    case 'md':
      return anchor.astNodeId;
  }
}

/** `auto` follows the system's light or dark appearance. */
export type ReadingTheme = 'auto' | 'light' | 'sepia' | 'dark';
/** A theme with `auto` settled against the system appearance. */
export type ResolvedReadingTheme = Exclude<ReadingTheme, 'auto'>;
/** `original` keeps the publisher's fonts (EPUB) or the default serif (TXT). */
export type ReadingFontFamily =
  | 'original'
  | 'charter'
  | 'iowan'
  | 'palatino'
  | 'athelas'
  | 'new-york'
  | 'seravek'
  | 'sf-pro'
  | 'mono';
/** Page padding; the text column is capped by the reading measure instead. */
export type ReadingMargins = 'narrow' | 'normal' | 'wide';
/** Text-column width, independent of page padding. */
export type ReadingPageWidth = 'standard' | 'wide' | 'full';
export type EpubReadingMode = 'spread' | 'paged' | 'scroll';
/** How a paged reader animates a page turn; reduced motion always turns instantly. */
export type PageTransition = 'none' | 'slide' | 'fade' | 'flip' | 'stack';

export interface ReadingPreferences {
  theme: ReadingTheme;
  fontFamily: ReadingFontFamily;
  /** Font size percentage (`75..=200`). */
  fontSize: number;
  /** Line height multiplier (`1.2..=2.4`). */
  lineSpacing: number;
  margins: ReadingMargins;
  pageWidth: ReadingPageWidth;
  /** Justified text, hyphenated in the document's language. */
  justify: boolean;
  /** Dims images in the Dark theme. */
  dimImages: boolean;
  epubReadingMode: EpubReadingMode;
  /** Also used by PDF single and two-page modes. */
  pageTransition: PageTransition;
  /** Tints PDF page canvases for Dark and Sepia; a capture still saves the original bitmap. */
  tintPdfPages: boolean;
  /** Whether entering focus mode also enters full screen. */
  focusModeFullScreen: boolean;
}

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  theme: 'auto',
  fontFamily: 'original',
  fontSize: 100,
  lineSpacing: 1.75,
  margins: 'normal',
  pageWidth: 'standard',
  justify: true,
  dimImages: false,
  epubReadingMode: 'spread',
  pageTransition: 'slide',
  tintPdfPages: false,
  focusModeFullScreen: false,
};

/**
 * Where decoded text is not byte-identical to the source file. Text outside
 * every span is. See `docs/adr/0002-txt-anchor-drift.md`.
 */
export interface SourceSpan {
  /** UTF-8 bytes into the chunk's text where the span begins. */
  textOffset: number;
  /** Decoded UTF-8 bytes in the span; 0 for a stripped BOM. */
  textLen: number;
  /** Source bytes those decoded bytes stand for. */
  sourceLen: number;
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
  sourceSpans: SourceSpan[];
  isLast: boolean;
}

/** How a reader gets a document's raw bytes. */
export type DocumentSource = { kind: 'url'; url: string } | { kind: 'bytes'; bytes: Uint8Array };

/** The read-only document access a reader is given. It cannot write anything. */
export interface DocumentContentReader {
  loadDocumentSource(document: StudyDocument): Promise<DocumentSource>;
  readTextStream(
    documentId: string,
    encoding: string | null,
    onChunk: (chunk: TextChunk) => void,
    signal?: AbortSignal,
  ): Promise<number>;
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
  /** A base64 PNG for an area capture, held in memory until it is excerpted. */
  imagePng: string | null;
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
  /** Absent for marks that are not annotations, such as search matches. */
  style?: AnnotationStyle;
  /**
   * The annotation carries a note, so the reader draws a marker where the
   * highlight ends. Frontend-only: derived from `Annotation.note`, never sent.
   */
  hasNote?: boolean;
}

/**
 * The contract every document engine implements. Readers report through
 * callbacks and receive commands through props; they never touch the database
 * or the MindMap directly.
 */
export interface DocumentViewerProps<F extends DocumentFormat = DocumentFormat> {
  document: StudyDocument & { format: F };
  /** False while another tab is showing. The viewer stays mounted to keep its state. */
  isActive: boolean;
  /**
   * Immersive reading: the viewer hides its sidebars and floating panels and lets
   * the page take the theme color. Its commands keep working.
   */
  chromeHidden?: boolean;
  content: DocumentContentReader;
  highlights: ReaderHighlight[];
  /** Set while a jump is outstanding for this document. */
  jumpRequest: JumpRequest | null;
  onSelectionChange: (selection: ReaderSelection | null) => void;
  /** Call once the jump has been scrolled to and pulsed. */
  onJumpHandled: (nonce: number) => void;
  /** Reports reading position so the document can reopen where it was left. */
  onCursorChange: (anchor: AnchorOf<F>) => void;
  /** User-configurable appearance and layout preferences (EPUB and TXT). */
  preferences?: ReadingPreferences;
  /** Updates and persists reading preferences. */
  onPreferencesChange?: (patch: Partial<ReadingPreferences>) => void;
  /** Persisted bookmarks for this document. */
  bookmarks?: readonly Bookmark[];
  /** Adds (or updates if at the same location) a bookmark for this document. */
  onAddBookmark?: (anchor: AnchorOf<F>, label?: string) => void;
  /** Removes a persisted bookmark by id. */
  onRemoveBookmark?: (bookmarkId: string) => void;
  /** Persisted annotations (both independent highlights/notes and card-linked excerpts) for this document. */
  annotations?: readonly Annotation[];
  /** Creates an independent highlight/note from the current selection without creating a MindMap node. */
  onCreateAnnotation?: (options?: CreateAnnotationOptions) => void;
  /** Updates an annotation's inline note and/or color. */
  onUpdateAnnotation?: (annotationId: string, patch: AnnotationPatch) => void;
  /** Deletes an annotation from this document. */
  onDeleteAnnotation?: (annotationId: string) => void;
  /** Undoes the most recent annotation deletion in this session, if available. */
  canUndoAnnotationDelete?: boolean;
  onUndoAnnotationDelete?: () => void;
  /** Sends the published selection to the MindMap, as the Excerpt to MindMap button does. */
  onExcerptSelection?: () => void;
  /** False while an excerpt is being written. */
  canExcerpt?: boolean;
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

const isPdfPageSpan = (value: unknown): value is PdfPageSpan => {
  if (typeof value !== 'object' || value === null) return false;
  const span = value as Record<string, unknown>;
  return (
    isFiniteNumber(span.pageIndex) &&
    Array.isArray(span.rects) &&
    span.rects.length > 0 &&
    span.rects.every(isRect)
  );
};

/** Runtime guard for anchors arriving from outside the type system. */
export function isAnchorLocation(value: unknown): value is AnchorLocation {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Record<string, unknown>;
  switch (anchor.format) {
    case 'pdf': {
      if (!isFiniteNumber(anchor.pageIndex) || !Array.isArray(anchor.rects)) return false;
      if (!anchor.rects.every(isRect)) return false;
      if (anchor.pageSpans !== undefined) {
        if (
          !Array.isArray(anchor.pageSpans) ||
          anchor.pageSpans.length === 0 ||
          !anchor.pageSpans.every(isPdfPageSpan)
        ) {
          return false;
        }
        if (anchor.pageSpans[0]?.pageIndex !== anchor.pageIndex) return false;
        for (let index = 1; index < anchor.pageSpans.length; index += 1) {
          const prev = anchor.pageSpans[index - 1]?.pageIndex;
          const curr = anchor.pageSpans[index]?.pageIndex;
          if (prev === undefined || curr === undefined || curr <= prev) return false;
        }
      }
      return true;
    }
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
