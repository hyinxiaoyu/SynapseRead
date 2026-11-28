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
  /**
   * How far through the document `lastCursorAnchor` is, `0..1`, when the reader
   * measured it; null or absent when it could not.
   */
  lastProgress?: number | null;
  /**
   * Timestamp set when the reader removes this entry from Recent / Continue
   * reading; cleared when the file is opened again.
   */
  hiddenFromRecentAt?: string | null;
  /**
   * Metadata title reported by the reader (EPUB `dc:title`, PDF `Info.Title`),
   * leaving the filename stem in `title` available.
   */
  displayTitle?: string | null;
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

/** A single dropped path that could not be opened (#130). */
export interface DroppedDocumentError {
  fileName: string;
  code: string;
  message: string;
}

/** Payload emitted after drag-and-drop paths are processed (#130). */
export interface DroppedDocumentsPayload {
  documents: StudyDocument[];
  errors: DroppedDocumentError[];
}

export interface WorkspacePaneLayout {
  mindMapOpen: boolean;
  inspectorOpen: boolean;
  /** Last non-zero MindMap width percentage (`35..=80`), or `null` for default. */
  mindMapSize: number | null;
  /** Last non-zero Inspector width percentage (`20..=80`), or `null` for default. */
  inspectorSize: number | null;
}

export const DEFAULT_WORKSPACE_PANE_LAYOUT: WorkspacePaneLayout = {
  mindMapOpen: false,
  inspectorOpen: false,
  mindMapSize: null,
  inspectorSize: null,
};

export interface WorkspaceSession {
  openDocumentIds: string[];
  activeDocumentId: string | null;
  /** Immersive reading: reader chrome collapsed and the toolbar auto-hiding. */
  immersive: boolean;
  /** MindMap and Inspector open/closed state and widths across relaunch (#119). */
  paneLayout?: WorkspacePaneLayout;
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
  /** Optional human-readable location reported by the reader at creation time (#125). */
  locationLabel?: string | null;
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
  /** Optional human-readable location reported by the reader (#125). */
  locationLabel?: string | null;
  /** File hash when the selection was made; core rejects stale writes after a content-changing relink (#125). */
  expectedFileHash?: string | null;
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
  /** Optional human-readable location reported by the reader (#125). */
  locationLabel?: string | null;
  /** File hash when the selection was made; core rejects stale writes after a content-changing relink (#125). */
  expectedFileHash?: string | null;
}

export interface CreatedExcerpt {
  annotation: Annotation;
  card: NoteCard;
  node: MindMapNode;
  edge: MindMapEdge | null;
}

export interface CreateCardForAnnotationInput {
  annotationId: string;
  notebookId: string;
  parentNodeId: string | null;
  posX: number;
  posY: number;
}

export interface CreatedCard {
  card: NoteCard;
  node: MindMapNode;
  edge: MindMapEdge | null;
}

/** An annotation brought back by Undo Delete, with the cards that cite it again. */
export interface RestoredAnnotation {
  annotation: Annotation;
  cards: NoteCard[];
}

/** Summary of a deleted card: its id, removed nodes and edges, and re-rooted children. */
export interface DeletedCard {
  cardId: string;
  nodeIds: string[];
  edgeIds: string[];
  rerootedChildNodeIds: string[];
}

/** A card brought back by Undo Delete, with its nodes, edges, and re-attached children. */
export interface RestoredCard {
  card: NoteCard;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  reparentedChildren: MindMapNode[];
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
export type PageTransition = 'none' | 'slide' | 'fade' | 'curl' | 'stack';
/** How a continuous-scrolling reader animates an explicit page turn; reduced motion turns instantly. */
export type ScrollPageTransition = 'none' | 'fade';
/** Sensitivity levels (`1..=5`, default `3`) for vertical wheel page turns in paginated modes. */
export type WheelSensitivity = 1 | 2 | 3 | 4 | 5;
export const MIN_WHEEL_SENSITIVITY = 1;
export const MAX_WHEEL_SENSITIVITY = 5;
export const DEFAULT_WHEEL_SENSITIVITY: WheelSensitivity = 3;

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
  /**
   * Used by continuous-scrolling modes (`EPUB` `scroll`, `PDF` `continuous`,
   * `TXT`). When `null`, scrolling follows `pageTransition` (`none` stays
   * `none`; everything else fades) so switching modes preserves both
   * preferences independently.
   */
  scrollPageTransition: ScrollPageTransition | null;
  /** Tints PDF page canvases for Dark and Sepia; a capture still saves the original bitmap. */
  tintPdfPages: boolean;
  /** Whether entering focus mode also enters full screen. */
  focusModeFullScreen: boolean;
  /** Vertical wheel page-turn sensitivity (`1..=5`, default `3`); higher turns with less movement. */
  wheelSensitivity: number;
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
  scrollPageTransition: null,
  tintPdfPages: false,
  focusModeFullScreen: false,
  wheelSensitivity: DEFAULT_WHEEL_SENSITIVITY,
};

/** How a PDF lays out its pages. */
export type PdfDisplayMode = 'continuous' | 'single' | 'two-page';
/** How a PDF page is sized; `custom` uses `PdfLayout.scale`. */
export type PdfZoomMode = 'fit-width' | 'fit-page' | 'actual-size' | 'custom';
/** Clockwise view rotation in degrees. */
export type PdfRotation = 0 | 90 | 180 | 270;

/**
 * One PDF's page layout, saved per document and always sent whole: `scale` only
 * applies to custom zoom and `coverPageAlone` only to two pages.
 */
export interface PdfLayout {
  displayMode: PdfDisplayMode;
  zoomMode: PdfZoomMode;
  /** The custom zoom factor (`0.25..=4`), kept while another zoom mode is chosen. */
  scale: number;
  rotation: PdfRotation;
  /** Two pages show page 1 alone, then 2-3, 4-5, so printed spreads face each other. */
  coverPageAlone: boolean;
}

export const DEFAULT_PDF_LAYOUT: PdfLayout = {
  displayMode: 'continuous',
  zoomMode: 'fit-width',
  scale: 1,
  rotation: 0,
  coverPageAlone: false,
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
  /** Optional human-readable location within the document (e.g. `"Ch. 3 · p. 41"`, `"Line 6"`). */
  locationLabel?: string | null;
  /** File hash of the source loaded in the reader when this selection was created (#125). */
  sourceFileHash?: string;
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
  /**
   * Reports reading position so the document can reopen where it was left, with
   * how far through the document it is (`0..1`) when the reader can measure that.
   */
  onCursorChange: (anchor: AnchorOf<F>, progress?: number) => void;
  /** User-configurable appearance and layout preferences (EPUB and TXT). */
  preferences?: ReadingPreferences;
  /** Updates and persists reading preferences. */
  onPreferencesChange?: (patch: Partial<ReadingPreferences>) => void;
  /**
   * PDF only: the layout this document opens in, read once when the viewer mounts.
   * Omitted, the viewer starts from `DEFAULT_PDF_LAYOUT`.
   */
  pdfLayout?: PdfLayout;
  /** PDF only: reports the whole layout each time the reader changes part of it. */
  onPdfLayoutChange?: (layout: PdfLayout) => void;
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
  /** Updates an annotation's inline note and/or color; resolves to `false` when the write fails. */
  onUpdateAnnotation?: (annotationId: string, patch: AnnotationPatch) => void | Promise<boolean>;
  /** Deletes an annotation from this document. */
  onDeleteAnnotation?: (annotationId: string) => void;
  /** Undoes the most recent annotation deletion in this session, if available. */
  canUndoAnnotationDelete?: boolean;
  onUndoAnnotationDelete?: () => void;
  /**
   * Annotations a MindMap card cites as its source. Deleting one of them asks
   * first, because the card then loses its link back to the text.
   */
  cardSourceAnnotationIds?: ReadonlySet<string>;
  /**
   * Annotations currently being sent to the MindMap. Deleting one of them is
   * disabled until the card write commits so source-link confirmation cannot be skipped (#124).
   */
  excerptingAnnotationIds?: ReadonlySet<string>;
  /** Sends the published selection to the MindMap, as the Excerpt to MindMap button does. */
  onExcerptSelection?: () => void;
  /** Sends an existing highlight or underline to the MindMap without creating a duplicate (#124). */
  onExcerptAnnotation?: (annotationId: string) => void;
  /** Opens the MindMap and reveals the card backed by this annotation (#124). */
  onShowAnnotationCard?: (annotationId: string) => void;
  /** False while an excerpt is being written. */
  canExcerpt?: boolean;
  /** Title of the MindMap card new excerpts will nest under, or `null` for a new root (#127). */
  excerptTargetTitle?: string | null;
  /** Clears the active nesting target so later excerpts become new roots (#127). */
  onClearExcerptTarget?: () => void;
  /**
   * Reports the title the file declares about itself (EPUB dc:title, PDF Info/XMP title),
   * already normalized, together with the `fileHash` of the source the viewer loaded.
   * Readers only report; the store decides whether to persist it.
   */
  onDocumentTitle?: (title: string, sourceFileHash: string) => void;
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

// ---------------------------------------------------------------------------
// LAN Book Sync IPC Contract (ADR 0008, #143, #144)
// ---------------------------------------------------------------------------

/** Stable machine-readable `lan_*` error codes defined by ADR 0008. */
export const LAN_ERROR_CODES = [
  'lan_address_invalid',
  'lan_address_unavailable',
  'lan_bind_failed',
  'lan_ports_exhausted',
  'lan_network_changed',
  'lan_unreachable',
  'lan_protocol_incompatible',
  'lan_source_stopped',
  'lan_auth_invalid',
  'lan_auth_expired',
  'lan_attempts_exceeded',
  'lan_session_busy',
  'lan_scope_denied',
  'lan_transfer_busy',
  'lan_source_changed',
  'lan_size_mismatch',
  'lan_hash_mismatch',
  'lan_payload_too_large',
  'lan_disk_full',
  'lan_cancelled',
  'lan_position_conflict',
] as const;

export type LanErrorCode = (typeof LAN_ERROR_CODES)[number];

const LAN_ERROR_CODE_SET: ReadonlySet<string> = new Set(LAN_ERROR_CODES);

export function isLanErrorCode(code: string): code is LanErrorCode {
  return LAN_ERROR_CODE_SET.has(code);
}

export interface Ipv4Subnet {
  ip: string;
  netmask: string;
  prefixLen: number;
}

export interface LanInterface {
  name: string;
  subnet: Ipv4Subnet;
}

export interface SharePermissions {
  positions: boolean;
  bookmarks: boolean;
}

export type ListenerStopReason =
  'stoppedByUser' | 'sessionEnded' | 'shutdown' | 'networkChanged' | 'codeExpired' | 'idleTimeout';

export type PeerRejectReason = 'nonIpv4' | 'nonPrivateAddress' | 'outOfSubnet';

export type LanShareStatus =
  | { state: 'off' }
  | { state: 'listening'; failedAttempts: number; maxFailedAttempts: number }
  | { state: 'codeLocked' }
  | { state: 'paired'; peerIp: string };

export interface LanShareSnapshot {
  status: LanShareStatus;
  address: string | null;
  interfaceName: string | null;
  pairingCode: string | null;
  codeExpiresAtMs: number | null;
  permissions: SharePermissions | null;
  sharedBookCount: number;
  blockedPeerCount: number;
  lastBlockedPeerIp: string | null;
  lastStopReason: ListenerStopReason | null;
  lastStopErrorCode: string | null;
}

export const INITIAL_LAN_SHARE_SNAPSHOT: LanShareSnapshot = {
  status: { state: 'off' },
  address: null,
  interfaceName: null,
  pairingCode: null,
  codeExpiresAtMs: null,
  permissions: null,
  sharedBookCount: 0,
  blockedPeerCount: 0,
  lastBlockedPeerIp: null,
  lastStopReason: null,
  lastStopErrorCode: null,
};

export interface LanShareStartInput {
  documentIds: string[];
  positions: boolean;
  bookmarks: boolean;
  interfaceIp?: string | null;
}

export type LanShareEventKind =
  | {
      kind: 'peerBlocked';
      peerIp: string;
      reason: PeerRejectReason;
      totalBlocked: number;
    }
  | {
      kind: 'stopped';
      reason: ListenerStopReason;
      errorCode: string | null;
    };

export interface LanShareEventPayload {
  event: LanShareEventKind;
  snapshot: LanShareSnapshot;
}

export type BookSyncState =
  | 'new'
  | 'alreadyPresent'
  | 'missingFile'
  | 'localFileChanged'
  | 'sameTitleDifferentVersion'
  | 'sourceUnavailable'
  | 'formatMismatch';

export interface CatalogBookClassification {
  bookId: string;
  title: string;
  format: DocumentFormat | null;
  rawFormat: string;
  extension: string;
  sizeBytes: number;
  fileAvailable: boolean;
  hasPosition: boolean | null;
  bookmarkCount: number | null;
  state: BookSyncState;
  eligible: boolean;
  needsFileDownload: boolean;
  localDocumentId: string | null;
  localTitle: string | null;
}

export interface LanImportConnectInput {
  address: string;
  code: string;
  operationId?: string | null;
}

export interface LanImportSessionInfo {
  sessionId: string;
  address: string;
  idleTimeoutSeconds: number;
  permissions: SharePermissions;
}

export interface PlanProgress {
  completedBooks: number;
  totalBooks: number;
  bookId: string;
}

export interface ImportErrorInfo {
  code: string;
  message: string;
}

export interface PositionPlanSummary {
  remoteAvailable: boolean;
  remoteProgress: number | null;
  localHasPosition: boolean;
  localProgress: number | null;
  differs: boolean;
  skippedReason?: string;
  defaultAdopt: boolean;
}

export type BookmarkPlanSkipReason =
  | { kind: 'invalidAnchor' }
  | { kind: 'formatMismatch' }
  | { kind: 'anchorLimitExceeded' }
  | { kind: 'bookmarkCapExceeded' }
  | { kind: 'unsupportedAnchor'; reason: string };

export type PlannedBookmarkStatus =
  | { status: 'new' }
  | { status: 'existing' }
  | { status: 'skipped'; reason: BookmarkPlanSkipReason };

export interface PlannedBookmarkPreview {
  index: number;
  label: string | null;
  createdAt: string | null;
  status: PlannedBookmarkStatus;
}

export interface BookmarkPlanSummary {
  newCount: number;
  existingCount: number;
  skippedCount: number;
  entries: PlannedBookmarkPreview[];
  defaultImport: boolean;
}

export interface BookPlanSummary {
  bookId: string;
  title: string;
  format: DocumentFormat | null;
  extension: string;
  sizeBytes: number;
  state: BookSyncState;
  eligible: boolean;
  needsFileDownload: boolean;
  localDocumentId: string | null;
  localTitle: string | null;
  position: PositionPlanSummary;
  bookmarks: BookmarkPlanSummary;
  planError?: ImportErrorInfo;
}

export interface ImportPlanSummary {
  books: BookPlanSummary[];
}

export interface BookImportDecision {
  bookId: string;
  importFile: boolean;
  importPosition: boolean;
  importBookmarks: boolean;
  selectedBookmarkIndices?: number[];
  overridePositionConflict?: boolean;
}

export interface LanImportPlanInput {
  sessionId: string;
  bookIds: string[];
  operationId?: string | null;
}

export interface LanImportPlanResult {
  planId: string;
  summary: ImportPlanSummary;
  defaultDecisions: BookImportDecision[];
}

export type LanComponentOutcome =
  | { status: 'applied' }
  | { status: 'skipped'; reason?: string }
  | { status: 'blocked'; reason: string }
  | {
      status: 'conflict';
      code: string;
      hasCurrentPosition: boolean;
      currentProgress: number | null;
    }
  | { status: 'failed'; error: ImportErrorInfo }
  | { status: 'cancelled' };

export interface BookmarkExecutionSummary {
  inserted: number;
  existing: number;
  skipped: number;
}

export interface LanBookImportResult {
  bookId: string;
  documentId: string | null;
  state: BookSyncState;
  file: LanComponentOutcome;
  position: LanComponentOutcome;
  bookmarks: LanComponentOutcome;
  bookmarkCounts: BookmarkExecutionSummary;
}

export type LanImportProgress =
  | {
      phase: 'bookStarted';
      bookId: string;
      bookIndex: number;
      totalBooks: number;
    }
  | {
      phase: 'fileTransfer';
      bookId: string;
      downloadedBytes: number;
      totalBytes: number;
    }
  | {
      phase: 'bookCompleted';
      bookId: string;
      bookIndex: number;
      totalBooks: number;
      result: LanBookImportResult;
    };

export interface LanImportExecuteInput {
  sessionId: string;
  planId: string;
  decisions: BookImportDecision[];
  operationId?: string | null;
}

export interface LanImportExecutionReport {
  books: LanBookImportResult[];
  cancelled: boolean;
  sessionError?: ImportErrorInfo;
}

// ---------------------------------------------------------------------------
// Runtime Type Guards for Untrusted LAN Sync Payloads (#144)
// ---------------------------------------------------------------------------

const BOOK_SYNC_STATES: ReadonlySet<string> = new Set<BookSyncState>([
  'new',
  'alreadyPresent',
  'missingFile',
  'localFileChanged',
  'sameTitleDifferentVersion',
  'sourceUnavailable',
  'formatMismatch',
]);

const DOCUMENT_FORMATS: ReadonlySet<string> = new Set<DocumentFormat>(['pdf', 'epub', 'txt', 'md']);

const LISTENER_STOP_REASONS: ReadonlySet<string> = new Set<ListenerStopReason>([
  'stoppedByUser',
  'sessionEnded',
  'shutdown',
  'networkChanged',
  'codeExpired',
  'idleTimeout',
]);

const PEER_REJECT_REASONS: ReadonlySet<string> = new Set<PeerRejectReason>([
  'nonIpv4',
  'nonPrivateAddress',
  'outOfSubnet',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

const isNullableBoolean = (value: unknown): value is boolean | null =>
  value === null || typeof value === 'boolean';

export function isSharePermissions(value: unknown): value is SharePermissions {
  if (!isRecord(value)) return false;
  return typeof value.positions === 'boolean' && typeof value.bookmarks === 'boolean';
}

export function isImportErrorInfo(value: unknown): value is ImportErrorInfo {
  if (!isRecord(value)) return false;
  return typeof value.code === 'string' && typeof value.message === 'string';
}

export function isLanInterface(value: unknown): value is LanInterface {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.subnet)) {
    return false;
  }
  return (
    typeof value.subnet.ip === 'string' &&
    typeof value.subnet.netmask === 'string' &&
    isFiniteNumber(value.subnet.prefixLen)
  );
}

export function isLanShareSnapshot(value: unknown): value is LanShareSnapshot {
  if (!isRecord(value) || !isRecord(value.status)) return false;
  const state = value.status.state;
  if (state !== 'off' && state !== 'listening' && state !== 'codeLocked' && state !== 'paired') {
    return false;
  }
  if (
    state === 'listening' &&
    (!isFiniteNumber(value.status.failedAttempts) ||
      !isFiniteNumber(value.status.maxFailedAttempts))
  ) {
    return false;
  }
  if (state === 'paired' && typeof value.status.peerIp !== 'string') {
    return false;
  }
  if (value.permissions !== null && !isSharePermissions(value.permissions)) {
    return false;
  }
  if (
    value.lastStopReason !== null &&
    (typeof value.lastStopReason !== 'string' || !LISTENER_STOP_REASONS.has(value.lastStopReason))
  ) {
    return false;
  }
  return (
    isNullableString(value.address) &&
    isNullableString(value.interfaceName) &&
    isNullableString(value.pairingCode) &&
    isNullableNumber(value.codeExpiresAtMs) &&
    isFiniteNumber(value.sharedBookCount) &&
    isFiniteNumber(value.blockedPeerCount) &&
    isNullableString(value.lastBlockedPeerIp) &&
    isNullableString(value.lastStopErrorCode)
  );
}

export function isLanShareEventPayload(value: unknown): value is LanShareEventPayload {
  if (!isRecord(value) || !isRecord(value.event) || !isLanShareSnapshot(value.snapshot)) {
    return false;
  }
  switch (value.event.kind) {
    case 'peerBlocked':
      return (
        typeof value.event.peerIp === 'string' &&
        typeof value.event.reason === 'string' &&
        PEER_REJECT_REASONS.has(value.event.reason) &&
        isFiniteNumber(value.event.totalBlocked)
      );
    case 'stopped':
      return (
        typeof value.event.reason === 'string' &&
        LISTENER_STOP_REASONS.has(value.event.reason) &&
        isNullableString(value.event.errorCode)
      );
    default:
      return false;
  }
}

export function isLanImportSessionInfo(value: unknown): value is LanImportSessionInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === 'string' &&
    typeof value.address === 'string' &&
    isFiniteNumber(value.idleTimeoutSeconds) &&
    isSharePermissions(value.permissions)
  );
}

export function isPlanProgress(value: unknown): value is PlanProgress {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.completedBooks) &&
    isFiniteNumber(value.totalBooks) &&
    typeof value.bookId === 'string'
  );
}

export function isCatalogBookClassification(value: unknown): value is CatalogBookClassification {
  if (!isRecord(value)) return false;
  if (
    value.format !== null &&
    (typeof value.format !== 'string' || !DOCUMENT_FORMATS.has(value.format))
  ) {
    return false;
  }
  return (
    typeof value.bookId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.rawFormat === 'string' &&
    typeof value.extension === 'string' &&
    isFiniteNumber(value.sizeBytes) &&
    typeof value.fileAvailable === 'boolean' &&
    isNullableBoolean(value.hasPosition) &&
    isNullableNumber(value.bookmarkCount) &&
    typeof value.state === 'string' &&
    BOOK_SYNC_STATES.has(value.state) &&
    typeof value.eligible === 'boolean' &&
    typeof value.needsFileDownload === 'boolean' &&
    isNullableString(value.localDocumentId) &&
    isNullableString(value.localTitle)
  );
}

export function isPositionPlanSummary(value: unknown): value is PositionPlanSummary {
  if (!isRecord(value)) return false;
  if (value.skippedReason !== undefined && typeof value.skippedReason !== 'string') {
    return false;
  }
  return (
    typeof value.remoteAvailable === 'boolean' &&
    isNullableNumber(value.remoteProgress) &&
    typeof value.localHasPosition === 'boolean' &&
    isNullableNumber(value.localProgress) &&
    typeof value.differs === 'boolean' &&
    typeof value.defaultAdopt === 'boolean'
  );
}

export function isBookmarkPlanSkipReason(value: unknown): value is BookmarkPlanSkipReason {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'invalidAnchor':
    case 'formatMismatch':
    case 'anchorLimitExceeded':
    case 'bookmarkCapExceeded':
      return true;
    case 'unsupportedAnchor':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}

export function isPlannedBookmarkPreview(value: unknown): value is PlannedBookmarkPreview {
  if (!isRecord(value) || !isRecord(value.status)) return false;
  if (
    !isFiniteNumber(value.index) ||
    !isNullableString(value.label) ||
    !isNullableString(value.createdAt)
  ) {
    return false;
  }
  switch (value.status.status) {
    case 'new':
    case 'existing':
      return true;
    case 'skipped':
      return isBookmarkPlanSkipReason(value.status.reason);
    default:
      return false;
  }
}

export function isBookmarkPlanSummary(value: unknown): value is BookmarkPlanSummary {
  if (!isRecord(value) || !Array.isArray(value.entries)) return false;
  return (
    isFiniteNumber(value.newCount) &&
    isFiniteNumber(value.existingCount) &&
    isFiniteNumber(value.skippedCount) &&
    value.entries.every(isPlannedBookmarkPreview) &&
    typeof value.defaultImport === 'boolean'
  );
}

export function isBookPlanSummary(value: unknown): value is BookPlanSummary {
  if (!isRecord(value)) return false;
  if (
    value.format !== null &&
    (typeof value.format !== 'string' || !DOCUMENT_FORMATS.has(value.format))
  ) {
    return false;
  }
  if (value.planError !== undefined && !isImportErrorInfo(value.planError)) {
    return false;
  }
  return (
    typeof value.bookId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.extension === 'string' &&
    isFiniteNumber(value.sizeBytes) &&
    typeof value.state === 'string' &&
    BOOK_SYNC_STATES.has(value.state) &&
    typeof value.eligible === 'boolean' &&
    typeof value.needsFileDownload === 'boolean' &&
    isNullableString(value.localDocumentId) &&
    isNullableString(value.localTitle) &&
    isPositionPlanSummary(value.position) &&
    isBookmarkPlanSummary(value.bookmarks)
  );
}

export function isBookImportDecision(value: unknown): value is BookImportDecision {
  if (!isRecord(value)) return false;
  if (
    value.selectedBookmarkIndices !== undefined &&
    (!Array.isArray(value.selectedBookmarkIndices) ||
      !value.selectedBookmarkIndices.every(isFiniteNumber))
  ) {
    return false;
  }
  if (
    value.overridePositionConflict !== undefined &&
    typeof value.overridePositionConflict !== 'boolean'
  ) {
    return false;
  }
  return (
    typeof value.bookId === 'string' &&
    typeof value.importFile === 'boolean' &&
    typeof value.importPosition === 'boolean' &&
    typeof value.importBookmarks === 'boolean'
  );
}

export function isLanImportPlanResult(value: unknown): value is LanImportPlanResult {
  if (!isRecord(value) || typeof value.planId !== 'string') return false;
  if (!isRecord(value.summary) || !Array.isArray(value.summary.books)) return false;
  if (!Array.isArray(value.defaultDecisions)) return false;
  return (
    value.summary.books.every(isBookPlanSummary) &&
    value.defaultDecisions.every(isBookImportDecision)
  );
}

export function isLanComponentOutcome(value: unknown): value is LanComponentOutcome {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'applied':
    case 'cancelled':
      return true;
    case 'skipped':
      return value.reason === undefined || typeof value.reason === 'string';
    case 'blocked':
      return typeof value.reason === 'string';
    case 'conflict':
      return (
        typeof value.code === 'string' &&
        typeof value.hasCurrentPosition === 'boolean' &&
        isNullableNumber(value.currentProgress)
      );
    case 'failed':
      return isImportErrorInfo(value.error);
    default:
      return false;
  }
}

export function isLanBookImportResult(value: unknown): value is LanBookImportResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.bookId === 'string' &&
    isNullableString(value.documentId) &&
    typeof value.state === 'string' &&
    BOOK_SYNC_STATES.has(value.state) &&
    isLanComponentOutcome(value.file) &&
    isLanComponentOutcome(value.position) &&
    isLanComponentOutcome(value.bookmarks) &&
    isRecord(value.bookmarkCounts) &&
    isFiniteNumber(value.bookmarkCounts.inserted) &&
    isFiniteNumber(value.bookmarkCounts.existing) &&
    isFiniteNumber(value.bookmarkCounts.skipped)
  );
}

export function isLanImportProgress(value: unknown): value is LanImportProgress {
  if (!isRecord(value) || typeof value.phase !== 'string' || typeof value.bookId !== 'string') {
    return false;
  }
  switch (value.phase) {
    case 'bookStarted':
      return isFiniteNumber(value.bookIndex) && isFiniteNumber(value.totalBooks);
    case 'fileTransfer':
      return isFiniteNumber(value.downloadedBytes) && isFiniteNumber(value.totalBytes);
    case 'bookCompleted':
      return (
        isFiniteNumber(value.bookIndex) &&
        isFiniteNumber(value.totalBooks) &&
        isLanBookImportResult(value.result)
      );
    default:
      return false;
  }
}

export function isLanImportExecutionReport(value: unknown): value is LanImportExecutionReport {
  if (!isRecord(value)) return false;
  if (value.sessionError !== undefined && !isImportErrorInfo(value.sessionError)) {
    return false;
  }
  return (
    Array.isArray(value.books) &&
    value.books.every(isLanBookImportResult) &&
    typeof value.cancelled === 'boolean'
  );
}
