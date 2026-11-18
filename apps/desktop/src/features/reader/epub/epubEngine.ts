import ePub, { type Contents, EpubCFI, type Location, type NavItem } from 'epubjs';

import { applyReadableAuthorColors } from '@/features/reader/appearance/authorColors';
import { PAGE_GUTTER_PX } from '@/features/reader/appearance/measure';
import {
  DEFAULT_SERIF_STACK,
  fontStack,
  PAGE_PALETTES,
  resolveReadingTheme,
} from '@/features/reader/appearance/themes';
import {
  buildSearchSnippet,
  type DocumentSearchResultItem,
  type SearchOptions,
  findSearchMatches,
} from '@/features/reader/DocumentSearch';
import {
  markViewportRect,
  rangeViewportRect,
  type ViewportRect,
} from '@/features/reader/markup/geometry';
import {
  animatePaperCurl,
  applyPaperCurl,
  easeOut,
  hasSelectionIn,
  hasTextSelection,
  isOverContent,
  PAGE_CURL_MS,
  PAGE_SLIDE_MS,
  PAGE_SPRING_BACK_MS,
  type PageGestureSample,
  prefersReducedMotion,
  resetPaperCurl,
  type TurnDirection,
  type TurnZone,
  type WheelSample,
  zoneAt,
} from '@/features/reader/paging/pageTurn';
import { computeScrollPageStep } from '@/features/reader/paging/scrollStep';
import {
  type AnnotationStyle,
  DEFAULT_READING_PREFERENCES,
  type DocumentSource,
  type EpubReadingMode,
  type PageTransition,
  type ReadingPreferences,
} from '@/types/domain';

import {
  type EpubCodeBlockHover,
  extractCodeBlockText,
  isCopyableCodeBlock,
  visibleCodeBlockRect,
} from './codeBlocks';
import { isNoteRef, noteTextAt } from './linkPeekText';
import { sanitizeChapter } from './sanitizeChapter';
import {
  countedOffsets,
  forEachReadableText,
  rawOffsetOfCounted,
  type SectionTextCount,
  TextCounter,
} from './textWeights';

export type { EpubReadingMode } from '@/types/domain';
export type { EpubCodeBlockHover } from './codeBlocks';

export interface EpubTocItem {
  id: string;
  label: string;
  href: string;
  children: readonly EpubTocItem[];
}

export interface EpubSearchMatch extends DocumentSearchResultItem {
  cfiRange: string;
  chapterHref: string;
  chapterIndex: number;
  /** Where the match starts in its chapter's text, `0..1`. */
  chapterFraction?: number;
}

export interface EpubInternalLink {
  noteref: boolean;
  rect: ViewportRect | null;
}

/**
 * One chapter view as epub.js' default view manager holds it. `destroy` is the
 * only teardown that disconnects the chapter's `ResizeObserver`, removes its
 * listeners and revokes its blob URL, so the seam hold has to keep the view
 * itself, not just its element.
 */
interface ChapterView {
  element?: HTMLElement;
  displayed?: boolean;
  destroy?: () => void;
}

/**
 * The parts of epub.js' default view manager a continuous page turn touches. The
 * strip is the container that holds the chapter's columns; `delta` is how far one
 * page turn moves it, and `views` is the collection whose `clear()` would empty
 * the strip before the next chapter has loaded.
 */
interface PaginatedManager {
  container: HTMLElement;
  layout?: { delta?: number };
  views?: {
    _views?: ChapterView[];
    length: number;
    container?: HTMLElement;
    clear: () => void;
    destroy: (view: ChapterView) => void;
  };
}

export interface EpubSelection {
  cfiRange: string;
  chapterHref: string;
  text: string;
}

export interface EpubLocation {
  cfi: string;
  /** The last location on the visible page, so a match can be placed on it. */
  endCfi?: string;
  href: string;
  page?: number;
  totalPages?: number;
  chapterIndex?: number;
  totalChapters?: number;
  bookProgress?: number;
  /** Where this page starts in the book, `0..1`, by spine chapter and page. */
  fraction?: number;
  /**
   * Where the page starts and ends within its chapter, `0..1`, by page. With the
   * chapter's share of the book's text, the viewer turns these into book positions.
   */
  chapterStart?: number;
  chapterEnd?: number;
}

export interface EpubFramePointerUp {
  x: number;
  y: number;
  overContent: boolean;
  hasSelection: boolean;
}

/** The whole of what the reader needs from epub.js; nothing else imports it. */
export interface EpubHandle {
  readonly toc: readonly EpubTocItem[];
  readonly isFixedLayout: boolean;
  readonly chapterCount?: number;
  /** Searches one spine chapter (rendered or not) and returns CFI-anchored matches. */
  searchChapter?(
    chapterIndex: number,
    query: string,
    options?: SearchOptions,
  ): Promise<readonly EpubSearchMatch[]>;
  /** Shows a CFI or chapter, or the first chapter with no target. Rejects if it cannot. */
  display(target?: string): Promise<void>;
  /**
   * Which of two CFIs comes first in the book: `-1`, `0`, or `1`. Readers compare
   * positions with it; nothing outside this module parses a CFI.
   */
  compareCfi(one: string, two: string): number;
  /**
   * A click on an internal book link, as the href epub.js resolved against the book,
   * with whether it calls itself a note reference and its box in the top window.
   */
  onInternalLink(listener: (href: string, link: EpubInternalLink) => void): void;
  /**
   * The plain text of a short link target, such as a footnote, to show beside the
   * link; null when the link should jump instead. Never returns markup (ADR 0005).
   */
  peekLink?(href: string, link: { noteref: boolean }): Promise<string | null>;
  /** The spine position of a chapter file, or -1. */
  spineIndexOf(href: string): number;
  /** The chapter file at a spine position. */
  spineHref(index: number): string | undefined;
  /**
   * Counts a spine chapter's readable text, loading it only for the call. Null
   * when the chapter cannot be loaded. Nothing it does shows on screen.
   */
  measureChapter?(index: number): Promise<SectionTextCount | null>;
  /**
   * Shows the page holding a point part-way through a chapter's text (`0` its
   * start, `1` its end), whether or not the chapter is rendered.
   */
  displayChapterFraction(index: number, fraction: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Registers the inert outgoing curl mirror host and stationary shadow overlay. */
  setCurlElements?(elements: { curlHost: HTMLElement | null; shadow: HTMLElement | null }): void;
  /**
   * A page turn. With `animate` the strip slides across a whole page — or across
   * a chapter seam — so both pages stay on screen; in `curl` mode the outgoing
   * spread stays pinned and peels away via conical clip; otherwise the next page
   * or chapter is shown straight away. Resolves with `true` when the page, scroll
   * position, or chapter actually moved, or `false` when blocked at a boundary
   * or canceled/superseded.
   */
  turnPage(
    direction: TurnDirection,
    options?: {
      animate?: boolean | undefined;
      transition?: PageTransition | undefined;
      spread?: boolean | undefined;
    },
  ): Promise<boolean>;
  /** Whether the current chapter has another page that way, without leaving it. */
  canTurnInPlace(direction: TurnDirection): boolean;
  /** Whether any rendered chapter frame currently holds a non-collapsed selection. */
  hasSelection(): boolean;
  /** Starts a live scrub from where the strip is now. */
  beginScrub(options?: {
    transition?: PageTransition | undefined;
    spread?: boolean | undefined;
  }): void;
  /** Follows the fingers: px of travel, signed, from where the scrub began. */
  scrubTo(displacement: number): void;
  /** Settles on the committed page, or springs back to where the scrub began. */
  endScrub(committed: TurnDirection | null): Promise<void>;
  setReadingMode(mode: EpubReadingMode): Promise<void>;
  /**
   * How many pages Two pages shows. The viewer decides from the reading measure;
   * other modes always show one.
   */
  setColumns(columns: 1 | 2): void;
  /** `theme` must already be resolved: `auto` renders as Light. */
  setPreferences(preferences: ReadingPreferences): void;
  /**
   * Marks a range; an underline draws only a line under the text. A mark with
   * `hasNote` also draws a dot where it ends, so a note shows on the page.
   */
  highlight(
    annotationId: string,
    cfiRange: string,
    color: string,
    style?: AnnotationStyle,
    options?: { hasNote?: boolean },
  ): void;
  removeHighlight(cfiRange: string, style?: AnnotationStyle): void;
  /** Whether a highlight's marks are on screen; the marks draw after `display` resolves. */
  setPulse(annotationId: string, pulsing: boolean): boolean;
  clearSelection(): void;
  /** The box around the selected text, in the top window's coordinates. */
  selectionRect(): ViewportRect | null;
  resize(width: number, height: number): void;
  onSelection(listener: (selection: EpubSelection | null) => void): void;
  /** A click on a highlight or underline, with the box around its marks. */
  onMarkClick(listener: (annotationId: string, rect: ViewportRect | null) => void): void;
  /** The primary button going down and up inside a chapter frame. */
  onPointer(listener: (down: boolean) => void): void;
  onLocation(listener: (location: EpubLocation) => void): void;
  onKeyDown(listener: (event: KeyboardEvent) => void): void;
  /**
   * Right clicks in a chapter frame. A frame is a document of its own, so its
   * `contextmenu` never reaches the window the rest of the app listens on.
   */
  onContextMenu(listener: (event: MouseEvent) => void): void;
  /** Pointer events in a chapter frame, in the top window's coordinates. */
  onGesture(listener: (sample: PageGestureSample) => void): void;
  /** Primary button release inside a chapter frame when press began outside it. */
  onFramePointerUp?(listener: (sample: EpubFramePointerUp) => void): void;
  /** Wheel events in a chapter frame; the listener reports whether it used one. */
  onWheel(listener: (wheel: WheelSample) => boolean): void;
  /** The copyable `<pre>` code block currently hovered or focused in a chapter frame, or null. */
  onCodeBlockHover?(listener: (block: EpubCodeBlockHover | null) => void): void;
  /** The cursor over the chapter frames, such as a page-turn hint. */
  setCursor(cursor: string): void;
  destroy(): void;
}

/**
 * The gap epub.js leaves between paginated pages, half of it on each outer edge.
 * Its default, `width / 12`, wastes wide screens; this is the spine gutter.
 */
const PAGINATED_GAP_PX = PAGE_GUTTER_PX;
/** Scrolled chapters get the same side padding a paginated page has. */
const SCROLLED_HORIZONTAL_PADDING = `${PAGE_GUTTER_PX / 2}px`;

const MODE_FLOW: Record<EpubReadingMode, 'paginated' | 'scrolled-doc'> = {
  spread: 'paginated',
  paged: 'paginated',
  scroll: 'scrolled-doc',
};

/** epub.js shows two pages when spread is `auto` and the width reaches the minimum. */
const spreadFor = (mode: EpubReadingMode, columns: 1 | 2): 'auto' | 'none' =>
  mode === 'spread' && columns === 2 ? 'auto' : 'none';

const BOOK_TYPOGRAPHY_CSS = `
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
body.epubjs-scrolled {
  padding: 24px ${SCROLLED_HORIZONTAL_PADDING} !important;
}
body {
  color: #1c1917;
  font-family: ${DEFAULT_SERIF_STACK};
  font-size: 1.05rem;
  line-height: 1.75;
  letter-spacing: 0.01em;
  overflow-wrap: break-word;
  word-wrap: break-word;
  orphans: 2;
  widows: 2;
  -webkit-font-smoothing: antialiased;
}
p {
  margin-top: 0;
  margin-bottom: 0.85em;
  text-align: justify;
  hyphens: auto;
  -webkit-hyphens: auto;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.3;
  margin-top: 1.25em;
  margin-bottom: 0.5em;
  break-after: avoid;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
}
img, svg, video, figure, table, blockquote {
  max-width: 100%;
  break-inside: avoid;
  page-break-inside: avoid;
}
blockquote {
  margin: 1em 1.25em;
  padding-left: 0.875em;
  border-left: 2px solid rgba(28, 25, 23, 0.2);
}
pre, code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
pre {
  max-width: 100%;
  box-sizing: border-box;
  margin: 0.9em 0;
  padding: 0.75em 0.9em;
  border-radius: 6px;
  line-height: 1.5;
  tab-size: 4;
  background-color: #f3f1eb;
  border: 1px solid rgba(28, 25, 23, 0.12);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  hyphens: none;
  -webkit-hyphens: none;
  text-indent: 2ch hanging each-line;
}
pre:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
pre code {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: inherit;
  line-height: inherit;
  white-space: inherit;
  overflow-wrap: inherit;
  word-break: inherit;
}
pre a[aria-hidden="true"],
pre a[aria-hidden="true"] * {
  -webkit-user-drag: none;
  user-drag: none;
  -webkit-user-select: text;
  user-select: text;
  cursor: text;
}
`;

/**
 * Precedence between book styles and user appearance preferences:
 * 1. Base defaults (`data-synapse-typography`) are prepended before the book's own
 *    stylesheets so unstyled chapters read cleanly while book structural rules
 *    (`h1`–`h6`, `pre`, `code`, `blockquote`, tables, figures) win the cascade.
 * 2. User appearance preferences (`data-synapse-preferences`) are appended at the
 *    end of `<head>` so user-chosen theme colors, font family, font size, and line
 *    spacing take precedence on reflowable prose (`html`, `body`, `p`, `li`, `dd`,
 *    `dt`, `blockquote`), while preserving monospace `pre`/`code` and heading scale.
 * 3. Fixed-layout (`rendition:layout === 'pre-paginated'`) chapters skip reflowable
 *    font/line-spacing overrides so fixed coordinates and page geometry stay intact.
 */
function buildPreferencesCss(preferences: ReadingPreferences, isFixedLayout: boolean): string {
  const theme = resolveReadingTheme(preferences.theme, false);
  const palette = PAGE_PALETTES[theme];
  // Sepia: white figure backgrounds take the paper color. Dark: optionally dimmed.
  const imageRule =
    theme === 'sepia'
      ? 'img, svg image { mix-blend-mode: multiply; }'
      : theme === 'dark' && preferences.dimImages
        ? 'img, svg, video { filter: brightness(0.85); }'
        : '';
  if (isFixedLayout) {
    return `
html, body {
  background-color: ${palette.background};
}
${imageRule}
`;
  }
  const stack = fontStack(preferences.fontFamily);
  const fontRem = ((1.05 * preferences.fontSize) / 100).toFixed(3);
  const lineSpacing = preferences.lineSpacing.toFixed(2);
  // Justified text needs hyphenation, or word spacing turns uneven. Ragged text
  // overrides the book; justified defers to a book that aligns its own paragraphs.
  const alignment = preferences.justify
    ? 'p { text-align: justify; hyphens: auto; -webkit-hyphens: auto; }'
    : 'p { text-align: start !important; hyphens: manual !important; -webkit-hyphens: manual !important; }';
  const codeThemeCss =
    theme === 'sepia'
      ? `
pre {
  background-color: #ebe1c8 !important;
  border: 1px solid rgba(67, 52, 34, 0.2) !important;
  color: #433422 !important;
}
div.sourceCode, .code-area-container {
  background-color: transparent !important;
}`
      : theme === 'dark'
        ? `
pre {
  background-color: #202024 !important;
  border: 1px solid rgba(228, 228, 231, 0.16) !important;
  color: #e4e4e7 !important;
}
div.sourceCode, .code-area-container {
  background-color: transparent !important;
}`
        : '';
  return `
html {
  color-scheme: ${palette.colorScheme};
}
html, body {
  background-color: ${palette.background} !important;
  color: ${palette.text} !important;
}
body {
  ${stack ? `font-family: ${stack} !important;` : ''}
  font-size: ${fontRem}rem !important;
  line-height: ${lineSpacing} !important;
}
p, li, dd, dt, blockquote {
  ${stack ? 'font-family: inherit !important;' : ''}
  line-height: ${lineSpacing} !important;
}
${alignment}
a {
  color: inherit;
}
blockquote {
  border-left-color: ${palette.border} !important;
}
pre {
  overflow: visible !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
  font-size: 0.875em !important;
  line-height: 1.5 !important;
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
  hyphens: none !important;
  -webkit-hyphens: none !important;
  text-indent: 2ch hanging each-line !important;
  break-inside: auto !important;
  page-break-inside: auto !important;
}
pre:focus-visible {
  outline: 2px solid currentColor !important;
  outline-offset: 2px !important;
}
pre code {
  font-size: inherit !important;
  line-height: inherit !important;
  white-space: inherit !important;
  overflow-wrap: inherit !important;
  word-break: inherit !important;
  background-color: transparent !important;
}
div:has(> pre), figure:has(> pre), blockquote:has(> pre) {
  overflow: visible !important;
  break-inside: auto !important;
  page-break-inside: auto !important;
}
pre a[aria-hidden="true"],
pre a[aria-hidden="true"] * {
  -webkit-user-drag: none !important;
  user-drag: none !important;
  -webkit-user-select: text !important;
  user-select: text !important;
  cursor: text !important;
}
${codeThemeCss}
${imageRule}
`;
}

/**
 * Hyphenation needs the text's language. A chapter that does not declare one
 * takes the book's.
 */
function applyLanguage(chapter: Document, language: string | undefined): void {
  const root = chapter.documentElement;
  if (!root || !language) return;
  if (root.getAttribute('lang') || root.getAttribute('xml:lang')) return;
  root.setAttribute('lang', language);
}

/**
 * Prepends iBooks-like reflow defaults before the chapter's own stylesheets so
 * unstyled books read cleanly while author-supplied rules still win the cascade.
 */
function applyBookTypography(chapter: Document): void {
  const head = chapter.querySelector('head') ?? chapter.documentElement;
  if (!head) return;
  const namespace = chapter.documentElement?.namespaceURI;
  const style = namespace
    ? chapter.createElementNS(namespace, 'style')
    : chapter.createElement('style');
  style.setAttribute('data-synapse-typography', 'true');
  style.textContent = BOOK_TYPOGRAPHY_CSS;
  head.insertBefore(style, head.firstChild);
}

function applyUserPreferencesToDocument(
  chapter: Document,
  preferences: ReadingPreferences,
  isFixedLayout: boolean,
): void {
  const head = chapter.querySelector('head') ?? chapter.documentElement;
  if (!head) return;
  let style = chapter.querySelector('style[data-synapse-preferences="true"]');
  if (!style) {
    const namespace = chapter.documentElement?.namespaceURI;
    style = namespace
      ? chapter.createElementNS(namespace, 'style')
      : chapter.createElement('style');
    style.setAttribute('data-synapse-preferences', 'true');
    head.appendChild(style);
  }
  style.textContent = buildPreferencesCss(preferences, isFixedLayout);
}

function mapToc(items: readonly NavItem[], prefix = 'toc'): EpubTocItem[] {
  return items.map((item, index) => {
    const id = item.id?.trim() || `${prefix}-${index}`;
    return {
      id,
      label: item.label.trim(),
      href: item.href.trim(),
      children: item.subitems ? mapToc(item.subitems, id) : [],
    };
  });
}

function findTocLabel(items: readonly EpubTocItem[], href: string): string | null {
  const cleanHref = (href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');
  for (const item of items) {
    const cleanTarget = (item.href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');
    if (
      cleanHref &&
      cleanTarget &&
      (cleanHref === cleanTarget ||
        cleanHref.endsWith(`/${cleanTarget}`) ||
        cleanTarget.endsWith(`/${cleanHref}`))
    ) {
      return item.label;
    }
    const nested = findTocLabel(item.children, href);
    if (nested) return nested;
  }
  return null;
}

/** A chapter's readable text, with the text node behind each stretch of it. */
function collectText(chapterDoc: Document): {
  fullText: string;
  nodes: { node: Text; start: number; end: number }[];
} {
  const nodes: { node: Text; start: number; end: number }[] = [];
  let fullText = '';
  forEachReadableText(chapterDoc, (node) => {
    const start = fullText.length;
    fullText += node.data;
    nodes.push({ node, start, end: fullText.length });
  });
  return { fullText, nodes };
}

/** Counts a chapter's text as `collectText` would, without building it. */
function countText(chapterDoc: Document): SectionTextCount {
  const counter = new TextCounter();
  forEachReadableText(chapterDoc, (node) => counter.add(node.data));
  return counter.result();
}

interface LoadableSection {
  href: string;
  document?: Document;
  contents?: Element;
  load(request: unknown): Promise<Element>;
  unload(): void;
  cfiFromRange(range: Range): string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const NOTE_MARKER_RADIUS = 3.5;

/** What epub.js' marks-pane hands back for a drawn mark: an SVG group it redraws. */
export interface PaneMark {
  element: SVGGElement | null;
  render(): void;
}

/** The epub.js annotation behind a mark; it reattaches each time its chapter renders. */
export interface RenditionAnnotation {
  mark?: PaneMark | undefined;
  on(type: 'attach', listener: (mark: PaneMark | undefined) => void): void;
}

const decoratedMarks = new WeakSet<PaneMark>();

/** A dot just past the end of the mark's last line box, in the highlight's color. */
function drawNoteMarker(mark: PaneMark, color: string) {
  const group = mark.element;
  const boxes = group?.querySelectorAll('rect');
  const last = boxes?.[boxes.length - 1];
  if (!group || !last) return;
  const right = Number(last.getAttribute('x')) + Number(last.getAttribute('width'));
  const top = Number(last.getAttribute('y'));
  if (!Number.isFinite(right) || !Number.isFinite(top)) return;
  const dot = group.ownerDocument.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('data-note-marker', '');
  dot.setAttribute('cx', String(right + NOTE_MARKER_RADIUS));
  dot.setAttribute('cy', String(top + NOTE_MARKER_RADIUS));
  dot.setAttribute('r', String(NOTE_MARKER_RADIUS));
  // The group's translucent fill and stroke are inherited; the dot is solid.
  dot.setAttribute('fill', color);
  dot.setAttribute('fill-opacity', '1');
  dot.setAttribute('stroke', 'rgba(0, 0, 0, 0.55)');
  dot.setAttribute('stroke-opacity', '1');
  dot.setAttribute('stroke-width', '1');
  group.appendChild(dot);
}

/**
 * marks-pane clears and redraws a mark's rects on every resize, and epub.js
 * makes a new mark each time the chapter renders, so the dot is drawn by
 * wrapping each mark's `render` rather than once.
 */
export function decorateWithNoteMarker(annotation: RenditionAnnotation, color: string) {
  const decorate = (mark: PaneMark | undefined) => {
    if (!mark || decoratedMarks.has(mark)) return;
    decoratedMarks.add(mark);
    const render = mark.render.bind(mark);
    mark.render = () => {
      render();
      drawNoteMarker(mark, color);
    };
    mark.render();
  };
  decorate(annotation.mark);
  annotation.on('attach', decorate);
}

const toBuffer = async (source: DocumentSource): Promise<ArrayBuffer> => {
  if (source.kind === 'url') return (await fetch(source.url)).arrayBuffer();
  // A copy, because the archive reader may hold on to it after this tab closes.
  return source.bytes.slice().buffer as ArrayBuffer;
};

/**
 * Links resolve against this, not the frame's base. A chapter is a `srcdoc` frame
 * whose base is the app's page, and a packaged app is served from `tauri://localhost`,
 * whose origin is the opaque `"null"`, so neither can anchor a relative URL.
 */
const BOOK_ORIGIN = 'https://book.invalid';

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape is matched as written.
    return path;
  }
}

/**
 * Where a relative link in the chapter at `chapterHref` points, as a book path with
 * its query and fragment (`/OEBPS/notes.xhtml#fn1`), or null when it leaves the book.
 * The path is decoded so it compares with the manifest's hrefs, which are often not.
 */
export function resolveChapterLink(raw: string, chapterHref: string | undefined): string | null {
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  try {
    const chapterBase = new URL(`/${(chapterHref ?? '').replace(/^\/+/, '')}`, BOOK_ORIGIN);
    const href = new URL(raw, chapterBase);
    if (href.origin !== BOOK_ORIGIN) return null;
    return `${decodePath(href.pathname)}${href.search}${href.hash}`;
  } catch {
    return null;
  }
}

/** Whether `path` names this spine item, written relative or rooted, encoded or not. */
function isSpinePath(item: { href: string; canonical?: string }, path: string): boolean {
  const clean = decodePath(path.replace(/^(\.\/|\/)+/, ''));
  if (!clean) return false;
  const href = decodePath(item.href);
  return (
    href === clean ||
    (item.canonical !== undefined && decodePath(item.canonical) === clean) ||
    href.endsWith(`/${clean}`) ||
    clean.endsWith(`/${href}`)
  );
}

function stripCloneIdentifiers(root: Element, removeScripts = false): void {
  if (removeScripts) {
    for (const script of root.querySelectorAll('script')) script.remove();
  }
  for (const candidate of [root, ...root.querySelectorAll('*')]) {
    candidate.removeAttribute('id');
    candidate.removeAttribute('data-annotation-id');
    candidate.classList.remove('anchor-pulse');
  }
}

function inlineStyleSheets(srcDoc: Document, dstDoc: Document): void {
  for (const base of srcDoc.head?.querySelectorAll('base') ?? []) {
    dstDoc.head?.appendChild(dstDoc.importNode(base, true));
  }
  for (const sheet of Array.from(srcDoc.styleSheets)) {
    try {
      const cssText = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      if (cssText) {
        const style = dstDoc.createElement('style');
        style.textContent = cssText;
        dstDoc.head?.appendChild(style);
      }
    } catch {
      const owner = sheet.ownerNode;
      if (
        owner &&
        (owner instanceof HTMLStyleElement ||
          (owner instanceof HTMLLinkElement && owner.rel === 'stylesheet'))
      ) {
        dstDoc.head?.appendChild(dstDoc.importNode(owner, true));
      }
    }
  }
}

function mirrorLiveFrame(view: HTMLElement, viewClone: HTMLElement, doc: Document): void {
  const liveFrame = view.querySelector('iframe');
  const liveDoc = liveFrame?.contentDocument;
  if (!liveFrame || !liveDoc) return;

  // ADR 0005: inert read-only mirror (`allow-same-origin` only, never `allow-scripts`).
  const mirrorFrame = doc.createElement('iframe');
  mirrorFrame.setAttribute('sandbox', 'allow-same-origin');
  mirrorFrame.setAttribute('aria-hidden', 'true');
  mirrorFrame.tabIndex = -1;
  if (liveFrame.width) mirrorFrame.width = liveFrame.width;
  if (liveFrame.height) mirrorFrame.height = liveFrame.height;
  mirrorFrame.style.cssText = `${liveFrame.style.cssText};pointer-events:none;border:0;`;
  viewClone.appendChild(mirrorFrame);

  let mirrorDoc = mirrorFrame.contentDocument;
  if (!mirrorDoc) return;
  // XHTML chapter docs run in CSS1Compat even when `liveDoc.doctype` is null,
  // whereas fresh `about:blank` iframes start in BackCompat (Quirks Mode).
  if (liveDoc.compatMode === 'CSS1Compat' && mirrorDoc.compatMode !== 'CSS1Compat') {
    try {
      mirrorDoc.open();
      mirrorDoc.write('<!DOCTYPE html><html><head></head><body></body></html>');
      mirrorDoc.close();
      mirrorDoc = mirrorFrame.contentDocument;
    } catch {
      // Keep default blank document if the host restricts document.open().
    }
  }
  if (!mirrorDoc) return;
  const srcRoot = liveDoc.documentElement;
  const dstRoot = mirrorDoc.documentElement;
  dstRoot.className = srcRoot.className;
  dstRoot.style.cssText = srcRoot.style.cssText;
  if (srcRoot.lang) dstRoot.lang = srcRoot.lang;
  if (srcRoot.dir) dstRoot.dir = srcRoot.dir;

  inlineStyleSheets(liveDoc, mirrorDoc);

  if (liveDoc.body) {
    const bodyClone = mirrorDoc.importNode(liveDoc.body, true);
    for (const script of bodyClone.querySelectorAll('script')) script.remove();
    for (const pre of bodyClone.querySelectorAll('[data-synapse-tabindex]')) {
      pre.removeAttribute('tabindex');
      pre.removeAttribute('data-synapse-tabindex');
    }
    mirrorDoc.body.replaceWith(bodyClone);
  }
}

export async function openEpubDocument(
  source: DocumentSource,
  element: HTMLElement,
  initialMode: EpubReadingMode = 'spread',
  initialPreferences: ReadingPreferences = DEFAULT_READING_PREFERENCES,
  initialColumns: 1 | 2 = 2,
): Promise<EpubHandle> {
  const book = ePub(await toBuffer(source));
  await book.ready;
  const metadataLayout = (
    book.packaging as unknown as { metadata?: { layout?: string } } | undefined
  )?.metadata?.layout;
  const language = (
    book.packaging as unknown as { metadata?: { language?: string } } | undefined
  )?.metadata?.language?.trim();
  const isFixedLayout = metadataLayout === 'pre-paginated';
  let currentPreferences: ReadingPreferences = { ...initialPreferences };

  book.spine.hooks.content.register(sanitizeChapter);
  if (!isFixedLayout) {
    book.spine.hooks.content.register(applyBookTypography);
    book.spine.hooks.content.register((chapter: Document) => applyLanguage(chapter, language));
  }
  book.spine.hooks.content.register((chapter: Document) => {
    applyUserPreferencesToDocument(chapter, currentPreferences, isFixedLayout);
  });

  const toc = mapToc(book.navigation?.toc ?? []);
  const spineItems =
    (
      book.spine as unknown as {
        spineItems?: { href: string; canonical?: string; document?: Document }[];
      }
    ).spineItems ?? [];
  const resolveTarget = (target?: string): string | undefined => {
    if (!target || target.startsWith('epubcfi(')) return target;
    if (book.spine.get(target)) return target;
    const [rawPath = '', fragment] = target.split('#');
    const matched = spineItems.find((item) => isSpinePath(item, rawPath));
    if (!matched) return target;
    return fragment ? `${matched.href}#${fragment}` : matched.href;
  };

  let currentMode: EpubReadingMode = initialMode;
  let currentColumns: 1 | 2 = initialColumns;
  let currentCfi: string | undefined;

  const rendition = book.renderTo(element, {
    flow: MODE_FLOW[currentMode],
    width: '100%',
    height: '100%',
    spread: spreadFor(currentMode, currentColumns),
    // The viewer chooses the column count from the reading measure.
    minSpreadWidth: 0,
    gap: PAGINATED_GAP_PX,
    // Without this, WebKit never fires the listeners epub.js needs: see
    // `docs/adr/0005-epub-sandbox.md`, which also covers why it is safe here.
    allowScriptedContent: true,
  } as Parameters<typeof book.renderTo>[1] & { gap: number });

  let selectionListener: (selection: EpubSelection | null) => void = () => undefined;
  /**
   * epub.js debounces `selectionchange` by 250 ms (`Contents.onSelectionChange`),
   * so a drag longer than that reports a partial selection first. The toolbar and
   * the selection popover read the last report, so a click right after the release
   * could excerpt the partial text. Report the settled selection on release, and
   * drop the debounced duplicate that follows it.
   */
  let releasedSelection: { cfiRange: string; text: string } | null = null;
  /** The selection a press started on: a click inside it must not report it again. */
  let pressedSelection: { cfiRange: string; text: string } | null = null;
  const hasContentsSelection = (contents: Contents): boolean =>
    hasTextSelection(
      contents.window?.getSelection?.() ?? contents.document?.getSelection?.() ?? null,
    );
  const selectionOf = (contents: Contents) => {
    const selection = contents.window.getSelection();
    if (!hasTextSelection(selection) || selection.rangeCount === 0) return null;
    try {
      const cfiRange = contents.cfiFromRange(selection.getRangeAt(0));
      const text = selection.toString().trim();
      return text && cfiRange ? { cfiRange, text } : null;
    } catch {
      return null;
    }
  };
  const reportSelection = (selection: { cfiRange: string; text: string }, released: boolean) => {
    const chapterHref = book.spine.get(selection.cfiRange)?.href;
    // Core refuses an excerpt of only whitespace.
    if (!chapterHref) {
      releasedSelection = null;
      selectionListener(null);
      return;
    }
    if (
      !released &&
      releasedSelection?.cfiRange === selection.cfiRange &&
      releasedSelection.text === selection.text
    ) {
      releasedSelection = null;
      return;
    }
    releasedSelection = released ? selection : null;
    selectionListener({
      cfiRange: selection.cfiRange,
      chapterHref,
      text: selection.text,
    });
  };
  let locationListener: (location: EpubLocation) => void = () => undefined;
  let internalLinkListener: (href: string, link: EpubInternalLink) => void = () => undefined;
  let keyDownListener: (event: KeyboardEvent) => void = () => undefined;
  let contextMenuListener: (event: MouseEvent) => void = () => undefined;
  let gestureListener: (sample: PageGestureSample) => void = () => undefined;
  let framePointerUpListener: (sample: EpubFramePointerUp) => void = () => undefined;
  let wheelListener: (wheel: WheelSample) => boolean = () => false;
  let markClickListener: (annotationId: string, rect: ViewportRect | null) => void = () =>
    undefined;
  let pointerListener: (down: boolean) => void = () => undefined;
  let codeBlockHoverListener: (block: EpubCodeBlockHover | null) => void = () => undefined;
  let destroyed = false;
  let framePointerDown = false;
  let frameCursor = '';
  /** One listener for every chapter document, so it can be removed again by identity. */
  const onChapterContextMenu = (event: MouseEvent) => contextMenuListener(event);
  const codeBlockIds = new WeakMap<Element, string>();
  let nextCodeBlockId = 0;
  const wiredChapterDocs = new WeakSet<Document>();
  const hoveredCodeDocs = new WeakSet<Document>();
  const codeTabObservers = new Set<MutationObserver>();
  let lastHoveredBlock: {
    id: string;
    rect: ViewportRect;
    top: number;
    left: number;
    bottom: number;
    right: number;
  } | null = null;
  const zeroRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  };
  const TABBABLE_SELECTOR =
    'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]';
  const isTabbable = (el: Element): boolean => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.tabIndex < 0) return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.closest('[inert], [hidden]') !== null) return false;
    if (
      el.localName.toLowerCase() === 'a' &&
      el.getAttribute('aria-hidden') === 'true' &&
      el.closest('pre') !== null
    ) {
      return false;
    }
    if (
      typeof htmlEl.checkVisibility === 'function' &&
      !htmlEl.checkVisibility({ visibilityProperty: true })
    ) {
      return false;
    }
    return true;
  };
  const isChapterElementVisible = (
    candidate: Element,
    frameRect: DOMRectReadOnly,
    hostRect: DOMRectReadOnly,
  ): boolean => {
    if (candidate.localName.toLowerCase() === 'pre') {
      return visibleCodeBlockRect(candidate, frameRect, hostRect) !== null;
    }
    const clientRects =
      typeof candidate.getClientRects === 'function' ? Array.from(candidate.getClientRects()) : [];
    const fragments = clientRects.length > 0 ? clientRects : [candidate.getBoundingClientRect()];
    return fragments.some(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right + frameRect.left > hostRect.left &&
        rect.left + frameRect.left < hostRect.right &&
        rect.bottom + frameRect.top > hostRect.top &&
        rect.top + frameRect.top < hostRect.bottom,
    );
  };
  const syncCodeBlockTabStops = (contents: Contents) => {
    const chapterDoc = contents.document;
    const pres = chapterDoc.querySelectorAll('pre');
    if (pres.length === 0) return;
    const frameRect =
      currentMode !== 'scroll'
        ? (contents.window.frameElement?.getBoundingClientRect() ?? zeroRect)
        : zeroRect;
    const hostRect =
      currentMode !== 'scroll' && frameRect.width > 0 ? element.getBoundingClientRect() : zeroRect;
    const checkVisibility = currentMode !== 'scroll' && frameRect.width > 0 && hostRect.width > 0;
    for (const pre of pres) {
      const managed = pre.hasAttribute('data-synapse-tabindex');
      if (pre.hasAttribute('tabindex') && !managed) continue;
      const focusable =
        isCopyableCodeBlock(pre) &&
        (!checkVisibility || visibleCodeBlockRect(pre, frameRect, hostRect) !== null);
      if (focusable) {
        if (pre.getAttribute('tabindex') !== '0') pre.setAttribute('tabindex', '0');
        if (!managed) pre.setAttribute('data-synapse-tabindex', 'true');
      } else if (managed) {
        pre.removeAttribute('tabindex');
        pre.removeAttribute('data-synapse-tabindex');
      }
    }
  };
  const blockIdOf = (pre: Element): string => {
    let id = codeBlockIds.get(pre);
    if (!id) {
      nextCodeBlockId += 1;
      id = `code-${nextCodeBlockId}`;
      codeBlockIds.set(pre, id);
    }
    return id;
  };
  const clearCodeBlockHover = () => {
    if (lastHoveredBlock === null) return;
    lastHoveredBlock = null;
    if (!destroyed) codeBlockHoverListener(null);
  };
  const ownerDoc = element.ownerDocument;
  const isCodeActionPillTarget = (target: EventTarget | null): boolean => {
    const targetElement = target as Element | null;
    return (
      typeof targetElement?.closest === 'function' &&
      targetElement.closest('[data-testid="epub-code-action-pill"]') !== null
    );
  };
  const isCopyBufferTarget = (target: EventTarget | null): boolean => {
    const targetElement = target as Element | null;
    return (
      typeof targetElement?.hasAttribute === 'function' &&
      targetElement.hasAttribute('data-synapse-copy-buffer')
    );
  };
  const clearFramePointerDown = () => {
    if (!framePointerDown) return;
    framePointerDown = false;
    pressedSelection = null;
    pointerListener(false);
  };
  const onOwnerPointerDown = (event: PointerEvent) => {
    if (event.button === 0) clearFramePointerDown();
    if (lastHoveredBlock !== null && !isCodeActionPillTarget(event.target)) {
      clearCodeBlockHover();
    }
  };
  const onOwnerPointerUp = () => {
    clearFramePointerDown();
  };
  const onOwnerPointerMove = (event: PointerEvent) => {
    if (event.buttons !== 0 || lastHoveredBlock === null) return;
    if (isCodeActionPillTarget(event.target)) return;
    const targetNode = event.target as Node | null;
    const { rect } = lastHoveredBlock;
    if (
      targetNode &&
      element.contains(targetNode) &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top - 24 &&
      event.clientY <= rect.bottom
    ) {
      return;
    }
    clearCodeBlockHover();
  };
  const onOwnerFocusIn = (event: FocusEvent) => {
    if (lastHoveredBlock === null) return;
    if (isCodeActionPillTarget(event.target) || isCopyBufferTarget(event.target)) return;
    const targetNode = event.target as Node | null;
    if (targetNode && element.contains(targetNode)) return;
    clearCodeBlockHover();
  };
  ownerDoc.addEventListener('pointermove', onOwnerPointerMove);
  ownerDoc.addEventListener('pointerdown', onOwnerPointerDown);
  ownerDoc.addEventListener('pointerup', onOwnerPointerUp);
  ownerDoc.addEventListener('pointercancel', onOwnerPointerUp);
  ownerDoc.addEventListener('focusin', onOwnerFocusIn);

  rendition.hooks.content.register((contents: Contents) => {
    const chapterDoc = contents.document;
    chapterDoc.body?.classList.toggle('epubjs-scrolled', currentMode === 'scroll');
    const offset = () => {
      const frame = contents.window.frameElement;
      const rect = frame?.getBoundingClientRect();
      return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
    };
    const hasSelection = () => hasContentsSelection(contents);
    const hasAnySelection = () =>
      hasSelection() || contentsList().some(hasContentsSelection) || hasSelectionIn(ownerDoc);
    const turnZoneAt = (topWindowX: number): TurnZone | null => {
      const pageFrame = element
        .closest('[data-testid="epub-page-area"]')
        ?.querySelector('[data-testid="epub-page-frame"]');
      const pageRect = pageFrame?.getBoundingClientRect();
      if (pageRect && pageRect.width > 0) return zoneAt(topWindowX, pageRect);
      const hostRect = element.getBoundingClientRect();
      if (hostRect.width > 0) return zoneAt(topWindowX, hostRect);
      const frameRect = contents.window.frameElement?.getBoundingClientRect();
      if (frameRect && frameRect.width > 0) return zoneAt(topWindowX, frameRect);
      return null;
    };
    const inspectCodeBlock = (pre: Element | null, clientPoint?: { x: number; y: number }) => {
      if (destroyed) return;
      if (!pre || !isCopyableCodeBlock(pre)) {
        clearCodeBlockHover();
        return;
      }
      const frameRect = contents.window.frameElement?.getBoundingClientRect() ?? zeroRect;
      const hostRect = element.getBoundingClientRect();
      const pointer = clientPoint
        ? { x: frameRect.left + clientPoint.x, y: frameRect.top + clientPoint.y }
        : undefined;
      const rect = visibleCodeBlockRect(pre, frameRect, hostRect, pointer);
      if (!rect) {
        clearCodeBlockHover();
        return;
      }
      const id = blockIdOf(pre);
      const top = Math.round(rect.top);
      const left = Math.round(rect.left);
      const bottom = Math.round(rect.bottom);
      const right = Math.round(rect.right);
      if (
        lastHoveredBlock &&
        lastHoveredBlock.id === id &&
        lastHoveredBlock.top === top &&
        lastHoveredBlock.left === left &&
        lastHoveredBlock.bottom === bottom &&
        lastHoveredBlock.right === right
      ) {
        return;
      }
      lastHoveredBlock = { id, rect, top, left, bottom, right };
      const focusBlock = (): boolean => {
        if (destroyed || !pre.isConnected) return false;
        const focusablePre = pre as HTMLElement;
        if (typeof focusablePre.focus !== 'function') return false;
        syncCodeBlockTabStops(contents);
        contents.window.focus?.();
        focusablePre.focus({ preventScroll: true });
        return chapterDoc.activeElement === pre;
      };
      const focusAfterBlock = (): boolean => {
        if (destroyed) return false;
        syncCodeBlockTabStops(contents);
        const currentFrameRect = contents.window.frameElement?.getBoundingClientRect() ?? zeroRect;
        const currentHostRect = element.getBoundingClientRect();
        const checkChapterVisibility =
          currentMode !== 'scroll' && currentFrameRect.width > 0 && currentHostRect.width > 0;
        for (const candidate of chapterDoc.querySelectorAll(TABBABLE_SELECTOR)) {
          if (candidate === pre || pre.contains(candidate)) continue;
          if ((pre.compareDocumentPosition(candidate) & 4) === 0) continue;
          if (!isTabbable(candidate)) continue;
          if (
            checkChapterVisibility &&
            !isChapterElementVisible(candidate, currentFrameRect, currentHostRect)
          ) {
            continue;
          }
          contents.window.focus?.();
          (candidate as HTMLElement).focus({ preventScroll: true });
          return true;
        }
        for (const candidate of ownerDoc.querySelectorAll(TABBABLE_SELECTOR)) {
          if (element.contains(candidate)) continue;
          if (isCodeActionPillTarget(candidate) || isCopyBufferTarget(candidate)) continue;
          if ((element.compareDocumentPosition(candidate) & 4) === 0) continue;
          if (!isTabbable(candidate)) continue;
          clearCodeBlockHover();
          (candidate as HTMLElement).focus({ preventScroll: true });
          return true;
        }
        return false;
      };
      codeBlockHoverListener({
        id,
        rect,
        getText: () => extractCodeBlockText(pre),
        focusBlock,
        focusAfterBlock,
      });
    };
    const preFromTarget = (target: EventTarget | null): Element | null => {
      const targetElement = target as Element | null;
      return typeof targetElement?.closest === 'function' ? targetElement.closest('pre') : null;
    };
    chapterDoc.documentElement.style.cursor = frameCursor;
    if (!wiredChapterDocs.has(chapterDoc)) {
      wiredChapterDocs.add(chapterDoc);
      // epub.js puts a click handler on every relative link that calls `display()`
      // directly, before the viewer hears about it, so an internal link would jump
      // without joining the reader's jump history or offering the way back. Capture
      // the click first and let the viewer navigate. Absolute links keep their own
      // behaviour (epub.js already sends them to a new tab).
      chapterDoc.addEventListener(
        'click',
        (event: MouseEvent) => {
          if (event.button !== 0) return;
          const target = event.target as Element | null;
          const anchor = target?.closest?.('a[href]') ?? null;
          // Pandoc line-number anchors inside `<pre>` are decorative targets (and in
          // `.html` spine chapters HTML5 parses `<a .../>` as wrapping the line's
          // code spans): suppress LinkPeek/navigation, but still update hover on click.
          const pre = anchor?.closest('pre') ?? null;
          if (anchor?.getAttribute('aria-hidden') === 'true' && pre !== null) {
            event.preventDefault();
            event.stopPropagation();
            if (!hasSelection()) inspectCodeBlock(pre, { x: event.clientX, y: event.clientY });
            return;
          }
          const raw = anchor?.getAttribute('href') ?? '';
          const href = resolveChapterLink(raw, spineItems[contents.sectionIndex]?.href);
          if (href === null) return;
          event.preventDefault();
          event.stopPropagation();
          const frame = contents.window.frameElement?.getBoundingClientRect();
          const box = anchor?.getBoundingClientRect?.();
          const rect =
            box && (box.width > 0 || box.height > 0)
              ? {
                  top: box.top + (frame?.top ?? 0),
                  left: box.left + (frame?.left ?? 0),
                  bottom: box.bottom + (frame?.top ?? 0),
                  right: box.right + (frame?.left ?? 0),
                }
              : null;
          internalLinkListener(href, {
            noteref: anchor ? isNoteRef(anchor) : false,
            rect,
          });
        },
        true,
      );
      // `selected` only reports new selections, not one that has been cleared.
      chapterDoc.addEventListener('selectionchange', () => {
        if (!hasSelection()) {
          releasedSelection = null;
          selectionListener(null);
        }
      });
      chapterDoc.addEventListener('keydown', (event: KeyboardEvent) => {
        if (
          !event.defaultPrevented &&
          !event.isComposing &&
          event.key === 'Tab' &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          const pre = preFromTarget(event.target);
          if (pre && event.target === pre && isCopyableCodeBlock(pre)) {
            if (lastHoveredBlock?.id !== blockIdOf(pre)) inspectCodeBlock(pre);
            const scope = element.closest('[data-testid="epub-viewer"]') ?? ownerDoc;
            const copyButton = scope.querySelector<HTMLElement>('[data-testid="epub-code-copy"]');
            if (copyButton && !copyButton.hasAttribute('disabled')) {
              event.preventDefault();
              copyButton.focus({ preventScroll: true });
              return;
            }
          }
        }
        keyDownListener(event);
      });
      // The app guards the webview's own context menu on the window, and a chapter is
      // a frame: its right clicks never reach that listener. The same function serves
      // every chapter, so a re-rendered document gets one listener, not two.
      chapterDoc.addEventListener('contextmenu', onChapterContextMenu);
      // Page turns are decided outside the frame, in the top window's coordinates.
      chapterDoc.addEventListener('pointerup', (event: PointerEvent) => {
        if (event.button !== 0) return;
        const wasDownInFrame = framePointerDown;
        framePointerDown = false;
        pointerListener(false);
        const selection = selectionOf(contents);
        const pressed = pressedSelection;
        pressedSelection = null;
        if (!wasDownInFrame) {
          const { left, top } = offset();
          framePointerUpListener({
            x: left + event.clientX,
            y: top + event.clientY,
            overContent: isOverContent(event.target, event.clientX, event.clientY),
            hasSelection: hasSelection(),
          });
        }
        if (!selection) return;
        // A click inside the existing selection leaves it in place; it is not a new
        // one, and reporting it again would re-open a popover the reader dismissed.
        if (pressed?.cfiRange === selection.cfiRange && pressed.text === selection.text) return;
        reportSelection(selection, true);
      });
      chapterDoc.addEventListener('pointercancel', () => {
        clearFramePointerDown();
      });
      chapterDoc.addEventListener('mousedown', (event: MouseEvent) => {
        if (
          currentMode === 'scroll' ||
          event.button !== 0 ||
          event.detail <= 1 ||
          event.defaultPrevented
        ) {
          return;
        }
        if (hasAnySelection()) return;
        if (isOverContent(event.target, event.clientX, event.clientY)) return;
        const { left } = offset();
        if (turnZoneAt(left + event.clientX) !== null) {
          event.preventDefault();
        }
      });
      chapterDoc.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0) return;
        framePointerDown = true;
        pressedSelection = selectionOf(contents);
        pointerListener(true);
        const { left, top } = offset();
        gestureListener({
          kind: 'down',
          x: left + event.clientX,
          y: top + event.clientY,
          hasSelection: hasSelection(),
        });
      });
      chapterDoc.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.buttons !== 0) return;
        const { left, top } = offset();
        gestureListener({
          kind: 'move',
          x: left + event.clientX,
          y: top + event.clientY,
          overContent: isOverContent(event.target, event.clientX, event.clientY),
        });
      });
      chapterDoc.documentElement.addEventListener('pointerleave', () => {
        gestureListener({ kind: 'leave' });
      });
      chapterDoc.addEventListener('click', (event: MouseEvent) => {
        if (event.button !== 0 || event.defaultPrevented) return;
        const { left, top } = offset();
        gestureListener({
          kind: 'click',
          x: left + event.clientX,
          y: top + event.clientY,
          overContent: isOverContent(event.target, event.clientX, event.clientY),
          hasSelection: hasSelection(),
        });
      });
      chapterDoc.addEventListener(
        'wheel',
        (event: WheelEvent) => {
          const sample: WheelSample = {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            buttons: event.buttons,
            defaultPrevented: event.defaultPrevented,
            target: event.target,
          };
          if (wheelListener(sample)) event.preventDefault();
        },
        { passive: false },
      );
    }
    if (!hoveredCodeDocs.has(chapterDoc)) {
      hoveredCodeDocs.add(chapterDoc);
      chapterDoc.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.buttons !== 0) return;
        const pre = preFromTarget(event.target);
        if (!pre) {
          clearCodeBlockHover();
          return;
        }
        inspectCodeBlock(pre, { x: event.clientX, y: event.clientY });
      });
      chapterDoc.addEventListener('click', (event: MouseEvent) => {
        if (event.button !== 0 || event.defaultPrevented || hasSelection()) return;
        const pre = preFromTarget(event.target);
        if (!pre) {
          clearCodeBlockHover();
          return;
        }
        inspectCodeBlock(pre, { x: event.clientX, y: event.clientY });
      });
      chapterDoc.addEventListener('focusin', (event: FocusEvent) => {
        inspectCodeBlock(preFromTarget(event.target));
      });
      chapterDoc.addEventListener('pointerdown', () => {
        clearCodeBlockHover();
      });
      chapterDoc.addEventListener('dragstart', (event: DragEvent) => {
        const rawTarget = event.target as Node | null;
        const targetElement =
          rawTarget?.nodeType === 1 ? (rawTarget as Element) : (rawTarget?.parentElement ?? null);
        if (targetElement?.closest('pre a[aria-hidden="true"]')) {
          event.preventDefault();
        }
      });
      chapterDoc.documentElement.addEventListener('pointerleave', () => {
        clearCodeBlockHover();
      });
      if (chapterDoc.documentElement) {
        const observer = new MutationObserver(() => syncCodeBlockTabStops(contents));
        observer.observe(chapterDoc.documentElement, { childList: true, subtree: true });
        codeTabObservers.add(observer);
      }
    }
    // `section.load()` runs `book.spine.hooks.content` only on the first parse of a
    // chapter, so any later view created by a resize, mode switch, or chapter revisit
    // must receive the latest preferences here too before author colors are audited.
    applyUserPreferencesToDocument(contents.document, currentPreferences, isFixedLayout);
    // Dark and Sepia color `html` and `body`; a chapter's own colors survive.
    // The iframe's load event has already run, so its stylesheets are applied.
    if (!isFixedLayout) applyReadableAuthorColors(contents.document, currentPreferences.theme);
    syncCodeBlockTabStops(contents);
  });
  rendition.on('selected', (cfiRange: string, contents: Contents) => {
    const text = contents.window.getSelection()?.toString().trim() ?? '';
    if (!text) {
      releasedSelection = null;
      selectionListener(null);
      return;
    }
    reportSelection({ cfiRange, text }, false);
  });
  rendition.on('relocated', (location: Location) => {
    clearCodeBlockHover();
    for (const contents of contentsList()) {
      syncCodeBlockTabStops(contents);
    }
    // An uncommitted scrub or spring-back moves the hidden strip ahead of commit;
    // keep the reported location on the resting page until the turn settles.
    if (scrubbing || settlingSpringBack) return;
    currentCfi = location.start.cfi;
    const displayed = location.start.displayed;
    const totalChapters = Math.max(spineItems.length, 1);
    const rawIndex =
      typeof location.start.index === 'number'
        ? location.start.index
        : spineItems.findIndex((item) => item.href === location.start.href);
    const chapterIndex = Math.min(Math.max(rawIndex >= 0 ? rawIndex : 0, 0), totalChapters - 1);
    const chapterFraction =
      displayed && displayed.total > 0
        ? Math.min(Math.max(displayed.page / displayed.total, 0), 1)
        : 1;
    const bookProgress = Math.round(((chapterIndex + chapterFraction) / totalChapters) * 100);
    // The page's start, so the first page of a chapter sits on its scrubber tick.
    const pageStart =
      displayed && displayed.total > 0
        ? Math.min(Math.max((displayed.page - 1) / displayed.total, 0), 1)
        : 0;
    locationListener({
      cfi: location.start.cfi,
      endCfi: location.end.cfi,
      href: location.start.href,
      chapterIndex,
      totalChapters,
      bookProgress,
      fraction: (chapterIndex + pageStart) / totalChapters,
      chapterStart: pageStart,
      chapterEnd: chapterFraction,
      ...(displayed ? { page: displayed.page, totalPages: displayed.total } : {}),
    });
  });

  const contentsList = () => rendition.getContents() as unknown as Contents[];

  /**
   * epub.js reports locations late: `display()` resolves the in-flight display as
   * soon as another one replaces it, `reportLocation()` runs a frame after the queue
   * drains, and the resize path clears every view and re-displays the location it
   * last saw. A resize landing around a jump therefore silently undoes it — the Back
   * button is consumed and the page does not move (#41).
   *
   * So every navigation takes an epoch (a newer one always wins), a jump withholds
   * the lagging location from the resize path, and a jump only counts as done once
   * the queue drained, the reader reports the location asked for, and a view exists
   * to show it. A jump overridden on the way is re-issued.
   */
  const renditionState = () =>
    rendition as unknown as {
      location?: { start?: { href?: string; cfi?: string } };
      q: { enqueue: (task: () => Promise<void>) => Promise<unknown> };
    };
  const displayedHref = () => renditionState().location?.start?.href;
  /** epub.js' resize accepts a CFI to restore, which its typings leave out. */
  const resizeTo = (width: number, height: number, target?: string) =>
    (
      rendition as unknown as {
        resize: (width?: number, height?: number, epubcfi?: string) => void;
      }
    ).resize(width, height, target);

  interface QueuedTurn {
    direction: TurnDirection;
    animate: boolean;
    transition: PageTransition | undefined;
    spread: boolean;
    resolve: (turned: boolean) => void;
    reject: (reason?: unknown) => void;
  }

  /** A newer navigation; an older one must neither repair nor wait for it. */
  let navigation = 0;
  let seamEpoch: number | null = null;
  let drainingTurns = false;
  let queueGeneration = 0;
  const pendingTurns: QueuedTurn[] = [];
  const clearPendingTurns = () => {
    queueGeneration += 1;
    if (pendingTurns.length === 0) return;
    const queued = pendingTurns.splice(0, pendingTurns.length);
    for (const item of queued) item.resolve(false);
  };
  const beginNavigation = (preserveQueue = false) => {
    if (!preserveQueue) clearPendingTurns();
    else seamEpoch = null;
    return ++navigation;
  };
  /** Where a jump is heading, so a resize restores it instead of the old location. */
  let pendingTarget: string | undefined;

  /** Resolves once epub.js' queue drained and its rAF-gated location report ran. */
  const settled = () =>
    renditionState()
      .q.enqueue(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      .catch(() => undefined);

  const display = async (target?: string) => {
    clearCodeBlockHover();
    // A newer navigation owns the strip: a slide still running would keep writing
    // its old page offset into the chapter this display is about to load.
    settleSlide();
    clearCurlStage();
    const resolved = resolveTarget(target);
    const epoch = beginNavigation();
    if (resolved !== undefined) currentCfi = resolved;
    const wanted = resolved === undefined ? undefined : book.spine.get(resolved)?.href;
    // epub.js' resize path clears all views and re-displays `this.location.start.cfi`
    // only when `this.location && this.location.start` is truthy (`onResized`). Seeding
    // `location` with the destination ahead of `reportLocation()` keeps a resize during
    // the jump from either restoring the pre-jump chapter or skipping re-display after
    // `manager.resize()` detaches the in-flight iframe.
    pendingTarget = resolved;
    Reflect.set(
      rendition,
      'location',
      resolved !== undefined && wanted !== undefined
        ? { start: { href: wanted, cfi: resolved } }
        : undefined,
    );
    try {
      await (rendition.display(resolved) as unknown as Promise<void>);
      if (epoch !== navigation || !wanted) return;
      // An href match alone would also be true of a view that only scrolled, or of
      // one the resize destroyed; the contents check tells a landed jump from those.
      const landed = async () => {
        await settled();
        const ok =
          epoch !== navigation || (displayedHref() === wanted && contentsList().length > 0);
        return ok;
      };
      if (await landed()) return;
      // Each repair starts from a drained queue, so a late resize cannot interleave
      // with it the way it did with the original jump.
      for (let repair = 0; repair < 2; repair += 1) {
        if (epoch !== navigation) return;
        await (rendition.display(resolved) as unknown as Promise<void>);
        if (await landed()) return;
      }
    } finally {
      if (epoch === navigation) pendingTarget = undefined;
    }
  };

  /**
   * Chapters loaded only for `withSection`, by how many calls are using each.
   * Search and the measuring pass can ask for the same chapter at once; the last
   * one out unloads it, so neither finds the document gone under it.
   */
  const borrowed = new Map<number, { users: number; ready: Promise<unknown> }>();

  /** Runs `read` on a spine chapter's document, loading it only for the call. */
  const withSection = async <T>(
    index: number,
    read: (section: LoadableSection, chapterDoc: Document) => T,
    fallback: T,
  ): Promise<T> => {
    const section = book.spine.get(index) as unknown as LoadableSection | null;
    if (!section) return fallback;
    let loan = borrowed.get(index);
    // Loaded by the rendition: it is showing, so it stays loaded.
    if (!loan && section.document && section.contents) {
      return read(section, section.document);
    }
    if (loan) {
      loan.users += 1;
    } else {
      loan = { users: 1, ready: section.load(book.load.bind(book)) };
      borrowed.set(index, loan);
    }
    try {
      await loan.ready;
      return section.document ? read(section, section.document) : fallback;
    } finally {
      loan.users -= 1;
      if (loan.users === 0) {
        borrowed.delete(index);
        section.unload();
      }
    }
  };

  // ---- The paginated strip: continuous page turns ---------------------------

  /**
   * epub.js builds its view manager on its own render queue, so it does not exist
   * when this engine is created: every use asks for it again.
   */
  const viewManager = () => (rendition as unknown as { manager?: PaginatedManager }).manager;

  /**
   * The strip epub.js lays a chapter out on: the whole chapter in CSS columns,
   * stepped by `container.scrollLeft`. Sliding that offset instead of jumping it
   * keeps the outgoing and incoming pages on screen together at full opacity,
   * which is the whole difference between a page turn and a cut.
   */
  const strip = (): { container: HTMLElement; stride: number } | null => {
    if (currentMode === 'scroll') return null;
    const manager = viewManager();
    const container = manager?.container;
    if (!container || container.clientWidth <= 0) return null;
    const stride = manager?.layout?.delta ?? container.clientWidth;
    return stride > 0 ? { container, stride } : null;
  };

  /**
   * The strip's own slide. It is driven from script rather than handed to
   * `slideScroll`, because a second turn has to be able to take over: the frame
   * loop is cancelled and the strip put where the first turn was heading, so a
   * turn never starts from half-way between two pages — and a slide never keeps
   * writing offsets into a chapter that has already been replaced.
   */
  let slideFrame = 0;
  let slideTarget = 0;
  let slideDone: (() => void) | null = null;

  const cancelSlide = () => {
    if (slideFrame !== 0) {
      cancelAnimationFrame(slideFrame);
      slideFrame = 0;
    }
    const done = slideDone;
    slideDone = null;
    if (done) done();
  };

  const reportLocation = () => {
    (rendition as unknown as { reportLocation?: () => void }).reportLocation?.();
  };

  const setStripHidden = (hidden: boolean) => {
    const current = strip();
    if (current) current.container.style.visibility = hidden ? 'hidden' : '';
  };

  const syncCurrentCfiFromScroll = () => {
    try {
      const located = (
        rendition as unknown as { currentLocation?: () => Location | undefined }
      ).currentLocation?.();
      if (located?.start?.cfi) {
        currentCfi = located.start.cfi;
        Reflect.set(rendition, 'location', located);
      }
    } catch {
      // Fake or unmounted renditions may not implement `currentLocation()`.
    }
    reportLocation();
  };

  const restoreScrubBaseLocation = (baseCfi: string | undefined, baseLocation: unknown) => {
    if (baseCfi !== undefined) currentCfi = baseCfi;
    if (baseLocation !== undefined) Reflect.set(rendition, 'location', baseLocation);
    reportLocation();
  };

  /** Puts the strip where the slide in flight was heading, if one is running. */
  const settleSlide = () => {
    seam.armed = false;
    if (slideStage !== null) {
      const stage = slideStage;
      const current = strip();
      // A scrub still under the fingers or springing back has not committed, so
      // it lands on `scrubBase`; a turn or committed scrub records its landing.
      const cancelling = scrubbing || settlingSpringBack;
      const landing = cancelling ? scrubBase : stage.landing;
      if (cancelling) {
        scrubbing = false;
        scrubMoved = false;
        settlingSpringBack = false;
      }
      cancelStage();
      endSlideStage();
      if (current && (!stage.seam || cancelling)) current.container.scrollLeft = landing;
      if (cancelling) restoreScrubBaseLocation(scrubBaseCfi, scrubBaseLocation);
      else if (!stage.seam) syncCurrentCfiFromScroll();
      return;
    }
    const inFlight = slideFrame !== 0 || slideDone !== null;
    cancelSlide();
    if (scrubbing && scrubCurl === null) {
      const moved = scrubMoved;
      scrubbing = false;
      scrubMoved = false;
      settlingSpringBack = false;
      if (moved) {
        const current = strip();
        if (current) current.container.scrollLeft = scrubBase;
        restoreScrubBaseLocation(scrubBaseCfi, scrubBaseLocation);
      }
      return;
    }
    // Without this, a finished slide's target would be re-applied to a chapter
    // that has since been replaced, and the strip would jump to the old page.
    if (!inFlight) return;
    const current = strip();
    if (current) {
      current.container.scrollLeft = slideTarget;
      syncCurrentCfiFromScroll();
    }
  };

  /*
   * The whole-page slide. Scrolling the strip only moves text inside the reading
   * measure, leaving the margins of the same paper standing still; so the
   * outgoing page is mirrored across the page area and the live pane carries the
   * incoming one, and the two travel together. `offset` runs from 0 to
   * `-direction * paneWidth`, which puts the seam between them at the page area's
   * edges instead of at the text column's.
   */
  let slideStage: {
    direction: TurnDirection;
    paneWidth: number;
    offset: number;
    surface: HTMLElement;
    /** The strip position this stage lands on when it is settled or discarded. */
    landing: number;
    /** True when the turn crosses a chapter seam and awaits `rendition.next/prev`. */
    seam: boolean;
  } | null = null;
  let stageFrame = 0;
  let stageDone: (() => void) | null = null;

  /** The paper the turn moves: the full-area pane, or the host in a bare fixture. */
  const slideSurface = (): HTMLElement =>
    element.closest<HTMLElement>('[data-testid="epub-slide-pane"]') ?? element;

  const applySlideStage = (offset: number) => {
    const stage = slideStage;
    if (stage === null) return;
    stage.offset = offset;
    if (curlHost) curlHost.style.transform = `translateX(${offset}px)`;
    stage.surface.style.transform = `translateX(${stage.direction * stage.paneWidth + offset}px)`;
    // The pane's leading edge is the seam; a soft cast shadow reads as the page
    // edge passing over the outgoing paper. It fades in and out with the travel.
    const progress = Math.min(Math.abs(offset) / Math.max(stage.paneWidth, 1), 1);
    const strength = Math.sin(Math.PI * progress);
    if (strength < 0.02) {
      stage.surface.style.boxShadow = '';
    } else {
      const cast = -stage.direction * (10 + 14 * progress);
      stage.surface.style.boxShadow = `${cast}px 0 24px -4px var(--page-turn-cast, rgba(20, 16, 12, 0.25))`;
    }
  };

  const endSlideStage = () => {
    const stage = slideStage;
    slideStage = null;
    if (stage) {
      stage.surface.style.transform = '';
      stage.surface.style.boxShadow = '';
      stage.surface.style.zIndex = '';
    }
    setStripHidden(false);
    if (curlHost) {
      curlHost.style.transform = '';
      curlHost.style.visibility = 'hidden';
      curlHost.replaceChildren();
    }
    // A bare fixture stages the host itself; clear it even when a pane was used.
    if (element) element.style.transform = '';
  };

  const cancelStage = () => {
    if (stageFrame !== 0) {
      cancelAnimationFrame(stageFrame);
      stageFrame = 0;
    }
    const done = stageDone;
    stageDone = null;
    if (done) done();
  };

  /**
   * Mirrors the outgoing page and advances the host to the incoming one, so the
   * first painted frame is the outgoing page alone. Returns the page area's
   * width, or `null` when the strip cannot be staged and the caller must fall
   * back to scrolling it.
   */
  const beginSlideStage = (
    direction: TurnDirection,
    options?: { seam?: boolean; useExistingMirror?: boolean; advanceStrip?: boolean },
  ): number | null => {
    const current = strip();
    const mirror = curlHost;
    if (!current || !mirror || prefersReducedMotion()) return null;
    const paneWidth = mirror.getBoundingClientRect().width;
    if (paneWidth <= 0) return null;
    if (!options?.useExistingMirror && !captureOutgoingSpread()) return null;
    const surface = slideSurface();
    const isSeam = options?.seam ?? false;
    const advance = options?.advanceStrip ?? !isSeam;
    const landing = advance
      ? current.container.scrollLeft + direction * current.stride
      : current.container.scrollLeft;
    slideStage = { direction, paneWidth, offset: 0, surface, landing, seam: isSeam };
    mirror.style.transform = 'translateX(0px)';
    surface.style.boxShadow = '';
    // Keep the incoming pane above the outgoing mirror (`z-10`) and below the
    // page-turn chevrons (`z-20`) so its leading-edge seam shadow falls onto the
    // outgoing paper instead of being occluded behind it.
    surface.style.zIndex = '15';
    surface.style.transform = `translateX(${direction * paneWidth}px)`;
    setStripHidden(isSeam);
    if (advance) current.container.scrollLeft = landing;
    return paneWidth;
  };

  /**
   * Flips an existing stage to the other direction without re-cloning the page:
   * the outgoing page at `base` is the one the mirror already holds. Returns
   * `false` when there is no stage or strip to restage.
   */
  const restageSlideStage = (
    direction: TurnDirection,
    base: number,
    options?: { seam?: boolean },
  ): boolean => {
    const stage = slideStage;
    const current = strip();
    if (stage === null || !current) return false;
    const isSeam = options?.seam ?? false;
    const landing = isSeam ? base : base + direction * current.stride;
    stage.direction = direction;
    stage.offset = 0;
    stage.landing = landing;
    stage.seam = isSeam;
    setStripHidden(isSeam);
    current.container.scrollLeft = landing;
    if (curlHost) curlHost.style.transform = 'translateX(0px)';
    stage.surface.style.boxShadow = '';
    stage.surface.style.zIndex = '15';
    stage.surface.style.transform = `translateX(${direction * stage.paneWidth}px)`;
    return true;
  };

  const animateSlideStage = (to: number, duration: number): Promise<void> =>
    new Promise((resolve) => {
      const stage = slideStage;
      if (stage === null) {
        resolve();
        return;
      }
      const from = stage.offset;
      if (duration <= 0 || Math.abs(to - from) < 0.5) {
        applySlideStage(to);
        resolve();
        return;
      }
      cancelStage();
      const started = performance.now();
      stageDone = resolve;
      const step = () => {
        const progress = Math.min((performance.now() - started) / duration, 1);
        applySlideStage(from + (to - from) * easeOut(progress));
        if (progress < 1) {
          stageFrame = requestAnimationFrame(step);
        } else {
          stageFrame = 0;
          stageDone = null;
          resolve();
        }
      };
      stageFrame = requestAnimationFrame(step);
    });

  const slideStrip = (target: number, duration: number): Promise<void> =>
    new Promise((resolve) => {
      const current = strip();
      if (!current) {
        resolve();
        return;
      }
      cancelSlide();
      const { container } = current;
      slideTarget = target;
      const from = container.scrollLeft;
      if (prefersReducedMotion() || duration <= 0 || Math.abs(target - from) < 0.5) {
        container.scrollLeft = target;
        resolve();
        return;
      }
      const started = performance.now();
      slideDone = resolve;
      const step = () => {
        const progress = Math.min((performance.now() - started) / duration, 1);
        container.scrollLeft = from + (target - from) * easeOut(progress);
        if (progress < 1) {
          slideFrame = requestAnimationFrame(step);
        } else {
          slideFrame = 0;
          slideDone = null;
          resolve();
        }
      };
      slideFrame = requestAnimationFrame(step);
    });

  /** Where the strip sat when the fingers landed; a cancelled scrub returns here. */
  let scrubbing = false;
  let scrubMoved = false;
  let settlingSpringBack = false;
  let scrubBase = 0;
  let scrubBaseCfi: string | undefined;
  let scrubBaseLocation: unknown;
  let scrubTransition: PageTransition | undefined;
  let scrubSpread = false;

  /** Whether the chapter has another page that way, as epub.js itself decides. */
  const canTurnInPlace = (direction: TurnDirection): boolean => {
    const current = strip();
    if (!current) return false;
    const { container, stride } = current;
    const base = scrubbing ? scrubBase : container.scrollLeft;
    return direction > 0
      ? base + container.offsetWidth + stride <= container.scrollWidth + 1
      : base > 1;
  };

  /**
   * epub.js empties the container before the next chapter's iframe has loaded, so
   * a turn across a spine seam shows a blank page for as long as the parse takes.
   * While a seam turn is armed, `views.clear()` forgets its views instead of
   * destroying them: their iframes stay painted in the strip, one page away from
   * the incoming chapter, and the turn slides across the seam between them.
   */
  const seam = { armed: false, held: [] as ChapterView[] };
  let seamViews: PaginatedManager['views'];
  let clearViews: (() => void) | undefined;

  /** Installs the hold on epub.js' view collection, once that collection exists. */
  const ensureSeamHold = (): boolean => {
    if (clearViews !== undefined) return true;
    const views = viewManager()?.views;
    if (!views) return false;
    const original = views.clear.bind(views);
    views.clear = () => {
      if (!seam.armed) {
        original();
        return;
      }
      for (const view of views._views ?? []) {
        const held = view.element;
        if (held?.parentElement) {
          // `manager.clear()` calls `views.hide()` before `views.clear()`, hiding
          // both the view wrapper and its iframe before we hold them for the slide.
          held.style.visibility = 'visible';
          for (const frame of held.querySelectorAll('iframe')) {
            frame.style.visibility = 'visible';
          }
          seam.held.push(view);
        }
      }
      views._views = [];
      views.length = 0;
    };
    seamViews = views;
    clearViews = original;
    return true;
  };

  /**
   * Runs epub.js' own teardown for a view the seam hold kept painted. Removing
   * only the element would leave the chapter's `ResizeObserver` connected, its
   * listeners attached and its blob URL alive, once per seam turn.
   */
  const destroyHeldView = (view: ChapterView) => {
    const element = view.element;
    const views = seamViews;
    // `Views.destroy` takes the element out of its own container, so it only
    // applies while the element is still there.
    if (views && element && views.container && element.parentElement === views.container) {
      views.destroy(view);
      return;
    }
    view.destroy?.();
    element?.remove();
  };

  /** Arms the hold, and returns what settles it once the new chapter is up. */
  const armSeam = ():
    ((direction: TurnDirection, options?: { animate?: boolean }) => Promise<void>) | null => {
    if (!ensureSeamHold()) return null;
    seam.armed = true;
    seam.held = [];
    // The turn this seam belongs to. A newer navigation — a contents jump, a link,
    // a relayout — owns the strip from then on, and this one must not write to it.
    const epoch = navigation;
    return async (direction, options) => {
      seam.armed = false;
      const held = seam.held;
      seam.held = [];
      const current = epoch === navigation ? strip() : null;
      let finalScrollLeft: number | null = null;
      try {
        if (current && held.length > 0) {
          const { container, stride } = current;
          const heldWidth = held.reduce((sum, view) => sum + (view.element?.offsetWidth ?? 0), 0);
          /*
           * The seam is a page turn too: the held chapter's last page is the
           * outgoing page, and the incoming chapter's first page is one stride
           * away. Stage it like an in-place turn, so the margins of both chapters
           * travel with the paper instead of standing still at the seam.
           */
          const slideSeam = async (target: number) => {
            if (options?.animate === false) return;
            const paneWidth = beginSlideStage(direction);
            if (paneWidth === null) {
              await slideStrip(target, PAGE_SLIDE_MS);
              return;
            }
            const stage = slideStage;
            await animateSlideStage(-direction * paneWidth, PAGE_SLIDE_MS);
            if (slideStage === stage) endSlideStage();
          };
          if (direction > 0) {
            const start = Math.max(0, heldWidth - stride);
            container.scrollLeft = start;
            finalScrollLeft = 0;
            await slideSeam(start + stride);
          } else {
            const incomingWidth = Math.max(0, container.scrollWidth - heldWidth);
            container.scrollLeft = incomingWidth;
            const target = Math.max(0, incomingWidth - stride);
            finalScrollLeft = target;
            await slideSeam(target);
          }
        }
      } finally {
        // Only this seam turn may clean up its stage; a newer navigation owns its own.
        if (epoch === navigation && slideStage !== null) {
          cancelStage();
          endSlideStage();
        }
        for (const view of held) destroyHeldView(view);
        if (current && finalScrollLeft !== null && epoch === navigation) {
          current.container.scrollLeft = finalScrollLeft;
          (rendition as unknown as { reportLocation?: () => void }).reportLocation?.();
        }
      }
    };
  };

  let curlHost: HTMLElement | null = null;
  let curlShadow: HTMLElement | null = null;
  let cancelCurl: (() => void) | null = null;
  let curlRunToken: symbol | null = null;
  let scrubCurl: {
    spread: boolean;
    direction: TurnDirection | null;
    progress: number;
    captured: boolean;
    seam: boolean;
  } | null = null;

  const clearCurlStage = () => {
    const restoreBase = (scrubbing && scrubMoved) || settlingSpringBack;
    const hadActiveCurl = cancelCurl !== null;
    curlRunToken = null;
    cancelCurl?.();
    cancelCurl = null;
    scrubCurl = null;
    scrubbing = false;
    scrubMoved = false;
    settlingSpringBack = false;
    scrubTransition = undefined;
    scrubSpread = false;
    seam.armed = false;
    setStripHidden(false);
    resetPaperCurl(curlHost, curlShadow);
    if (curlHost) {
      curlHost.style.transform = '';
      curlHost.style.visibility = 'hidden';
      curlHost.replaceChildren();
    }
    if (restoreBase) {
      const current = strip();
      if (current) current.container.scrollLeft = scrubBase;
      restoreScrubBaseLocation(scrubBaseCfi, scrubBaseLocation);
    } else if (hadActiveCurl) {
      syncCurrentCfiFromScroll();
    }
  };

  const runCurlAnimation = (params: {
    from: number;
    to: number;
    duration: number;
    direction: TurnDirection;
    spread: boolean;
    captured: boolean;
    token: symbol;
  }): Promise<boolean> =>
    new Promise((resolve) => {
      let settledRun = false;
      const settleRun = (completed: boolean) => {
        if (settledRun) return;
        settledRun = true;
        cancelCurl = null;
        if (curlRunToken === params.token) {
          curlRunToken = null;
          setStripHidden(false);
          if (curlHost) {
            curlHost.style.visibility = 'hidden';
            curlHost.replaceChildren();
          }
        }
        resolve(completed);
      };
      const cancelAnim = animatePaperCurl({
        outgoing: params.captured ? curlHost : null,
        shadow: curlShadow,
        direction: params.direction,
        from: params.from,
        to: params.to,
        duration: params.duration,
        spread: params.spread,
        onFinish: () => settleRun(true),
      });
      if (!settledRun) {
        cancelCurl = () => {
          cancelAnim();
          settleRun(false);
        };
      }
    });

  /**
   * Captures the currently visible EPUB views inside an inert mirror above the
   * live strip so `curlHost` can peel away at (0, 0) without moving `epub-host`
   * or promoting multi-thousand-pixel `.epub-view` layers to the GPU.
   */
  const captureOutgoingSpread = (): boolean => {
    if (!curlHost || currentMode === 'scroll') return false;
    curlHost.replaceChildren();
    const current = strip();
    const container = current?.container ?? element;
    const scrollLeft = current?.container.scrollLeft ?? 0;
    const viewportWidth = current?.container.clientWidth ?? element.clientWidth;
    const viewportHeight = current?.container.clientHeight ?? element.clientHeight;
    const doc = curlHost.ownerDocument;
    /*
     * The mirror spans the whole page area, while the live strip only spans the
     * reading measure. The copied views are clipped to a box the size of the live
     * viewport, positioned where that viewport sits inside the page, so columns
     * from the previous or next page never show in the paper margins; the paper
     * around the box is the mirror's own.
     */
    const hostBox = element.getBoundingClientRect();
    const mirrorBox = curlHost.getBoundingClientRect();
    const viewport = doc.createElement('div');
    viewport.dataset.testid = 'epub-mirror-viewport';
    viewport.style.position = 'absolute';
    viewport.style.left = `${hostBox.left - mirrorBox.left}px`;
    viewport.style.top = `${hostBox.top - mirrorBox.top}px`;
    viewport.style.width = `${viewportWidth}px`;
    viewport.style.height = `${viewportHeight}px`;
    viewport.style.overflow = 'hidden';
    viewport.style.pointerEvents = 'none';
    curlHost.appendChild(viewport);

    for (const view of container.querySelectorAll<HTMLElement>('.epub-view')) {
      const viewLeft = view.offsetLeft;
      const viewWidth = view.offsetWidth;
      if (viewportWidth > 0 && viewWidth > 0) {
        if (viewLeft + viewWidth <= scrollLeft - 1 || viewLeft >= scrollLeft + viewportWidth + 1) {
          continue;
        }
      }
      const viewClone = doc.createElement('div');
      viewClone.style.position = 'absolute';
      viewClone.style.top = `${view.offsetTop}px`;
      viewClone.style.left = `${viewLeft - scrollLeft}px`;
      viewClone.style.width = view.style.width || `${viewWidth}px`;
      viewClone.style.height = view.style.height || `${view.offsetHeight}px`;
      viewClone.style.overflow = 'hidden';
      viewClone.style.pointerEvents = 'none';
      viewport.appendChild(viewClone);

      mirrorLiveFrame(view, viewClone, doc);

      for (const child of Array.from(view.children)) {
        if (child.tagName.toLowerCase() !== 'svg') continue;
        const svgClone = doc.importNode(child, true) as SVGSVGElement;
        stripCloneIdentifiers(svgClone);
        svgClone.style.pointerEvents = 'none';
        viewClone.appendChild(svgClone);
      }
    }

    // JSDOM fallback when `epubjs` views are mocked without `.epub-view` nodes.
    const fallbackDoc = contentsList()[0]?.document;
    if (viewport.childElementCount === 0 && fallbackDoc?.body) {
      const cloneBox = doc.createElement('div');
      cloneBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      for (const node of Array.from(fallbackDoc.body.childNodes)) {
        const imported = doc.importNode(node, true);
        if (imported instanceof Element) stripCloneIdentifiers(imported, true);
        cloneBox.appendChild(imported);
      }
      viewport.appendChild(cloneBox);
    }

    if (viewport.childElementCount === 0) {
      viewport.remove();
      return false;
    }
    /*
     * The spine is a sibling of the live host, not part of the `.epub-view`, so
     * the mirror would lose the outgoing spread's gutter as soon as the pane
     * moves. Copy it into the mirror viewport at the same place, so it travels
     * with the outgoing paper while the incoming pane brings its own.
     */
    const liveSpine = element.parentElement?.querySelector<HTMLElement>(
      '[data-testid="epub-spine"]',
    );
    if (liveSpine) {
      const spineBox = liveSpine.getBoundingClientRect();
      const spineClone = doc.createElement('div');
      spineClone.dataset.testid = 'epub-mirror-spine';
      spineClone.style.position = 'absolute';
      spineClone.style.left = `${spineBox.left - hostBox.left}px`;
      spineClone.style.top = `${spineBox.top - hostBox.top}px`;
      spineClone.style.width = `${spineBox.width}px`;
      spineClone.style.height = `${spineBox.height}px`;
      spineClone.style.backgroundImage = getComputedStyle(liveSpine).backgroundImage;
      spineClone.style.pointerEvents = 'none';
      viewport.appendChild(spineClone);
    }
    curlHost.style.visibility = 'visible';
    return true;
  };

  const currentChapterIndex = (direction: TurnDirection): number => {
    const views = viewManager()?.views?._views;
    const view = (direction > 0 ? views?.at(-1) : views?.[0]) as
      (ChapterView & { index?: number; section?: { index?: number } }) | undefined;
    if (typeof view?.section?.index === 'number') return view.section.index;
    if (typeof view?.index === 'number') return view.index;
    const contents = contentsList();
    const frame = direction > 0 ? contents.at(-1) : contents[0];
    const frameIndex = (frame as (Contents & { sectionIndex?: number }) | undefined)?.sectionIndex;
    if (typeof frameIndex === 'number') return frameIndex;
    const start = renditionState().location?.start as
      { index?: number; href?: string; cfi?: string } | undefined;
    if (typeof start?.index === 'number') return start.index;
    if (start?.href) {
      const byHref = spineIndexOf(start.href);
      if (byHref >= 0) return byHref;
    }
    const cfi = start?.cfi ?? currentCfi;
    if (cfi) {
      const section = book.spine.get(cfi) as { index?: number; href?: string } | null;
      if (typeof section?.index === 'number') return section.index;
      if (section?.href) {
        const byHref = spineIndexOf(section.href);
        if (byHref >= 0) return byHref;
      }
    }
    return -1;
  };

  const canCrossChapter = (direction: TurnDirection): boolean => {
    if (spineItems.length === 0) return false;
    const views = viewManager()?.views?._views;
    const view = (direction > 0 ? views?.at(-1) : views?.[0]) as
      (ChapterView & { section?: { next?: () => unknown; prev?: () => unknown } }) | undefined;
    const section = view?.section;
    if (direction > 0 && typeof section?.next === 'function') {
      return Boolean(section.next());
    }
    if (direction < 0 && typeof section?.prev === 'function') {
      return Boolean(section.prev());
    }
    const index = currentChapterIndex(direction);
    if (index < 0) return false;
    return direction > 0 ? index < spineItems.length - 1 : index > 0;
  };

  const drainPendingTurns = async (gen: number): Promise<boolean> => {
    drainingTurns = true;
    let lastMovedItem: QueuedTurn | null = null;
    try {
      while (pendingTurns.length > 0 && gen === queueGeneration && !destroyed) {
        const item = pendingTurns.shift();
        if (!item) break;
        const isFinal = pendingTurns.length === 0;
        let moved = false;
        try {
          moved = await executeTurn(
            item.direction,
            isFinal ? item.animate : false,
            isFinal ? item.transition : 'none',
            item.spread,
            isFinal,
          );
        } catch (err) {
          item.reject(err);
          for (const remaining of pendingTurns.splice(0, pendingTurns.length)) {
            remaining.resolve(false);
          }
          if (lastMovedItem) {
            const winner = lastMovedItem;
            lastMovedItem = null;
            winner.resolve(true);
            return true;
          }
          return false;
        }
        if (gen !== queueGeneration || destroyed) {
          item.resolve(false);
          return false;
        }
        if (moved) {
          lastMovedItem?.resolve(false);
          lastMovedItem = item;
        } else {
          item.resolve(false);
        }
      }
      if (lastMovedItem) {
        const winner = lastMovedItem;
        lastMovedItem = null;
        winner.resolve(true);
        return true;
      }
      return false;
    } finally {
      lastMovedItem?.resolve(false);
      drainingTurns = false;
    }
  };

  const finishSeamTurn = async (epoch: number): Promise<boolean> => {
    syncCurrentCfiFromScroll();
    if (epoch !== navigation || destroyed) return false;
    if (!drainingTurns && pendingTurns.length > 0) {
      const drainGen = queueGeneration;
      const laterMoved = await drainPendingTurns(drainGen);
      if (drainGen !== queueGeneration || destroyed) return false;
      return !laterMoved;
    }
    return true;
  };

  const executeTurn = async (
    direction: TurnDirection,
    animate: boolean,
    transition?: PageTransition,
    spread = false,
    allowAnimation = true,
  ): Promise<boolean> => {
    clearCodeBlockHover();
    // A turn starts from a whole page, so any slide or curl still running settles first.
    settleSlide();
    clearCurlStage();
    const inDrain = drainingTurns;
    const epoch = beginNavigation(inDrain);
    pendingTarget = undefined;

    const shouldAnimateFinal = () =>
      allowAnimation && pendingTurns.length === 0 && epoch === navigation && !destroyed;

    if (currentMode === 'scroll') {
      const scroller =
        element.querySelector<HTMLElement>('.epub-container') ??
        (viewManager()?.container as HTMLElement | undefined) ??
        null;
      if (scroller && scroller.clientHeight > 0) {
        const contentRoot =
          scroller.querySelector('iframe')?.contentDocument?.body ??
          contentsList()[0]?.document?.body ??
          scroller;
        const nextTop = computeScrollPageStep({ scroller, contentRoot, direction });
        if (nextTop !== null) {
          scroller.scrollTop = nextTop;
          syncCurrentCfiFromScroll();
          return true;
        }
        const atBoundary =
          direction > 0
            ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
            : scroller.scrollTop <= 1;
        if (!atBoundary) return false;
      }
      if (!canCrossChapter(direction)) return false;
      seamEpoch = epoch;
      try {
        await (direction > 0 ? rendition.next() : rendition.prev());
        if (epoch !== navigation || destroyed) return false;
        if (direction < 0) {
          for (const contents of contentsList()) {
            (contents as unknown as { expand?: () => void }).expand?.();
          }
          await settled();
          if (epoch !== navigation || destroyed) return false;
          const nextScroller =
            element.querySelector<HTMLElement>('.epub-container') ??
            (viewManager()?.container as HTMLElement | undefined) ??
            scroller;
          if (nextScroller) {
            nextScroller.scrollTop = Math.max(
              0,
              nextScroller.scrollHeight - nextScroller.clientHeight,
            );
          }
        }
        if (seamEpoch === epoch) seamEpoch = null;
        return finishSeamTurn(epoch);
      } catch (err) {
        if (!inDrain && epoch === navigation) clearPendingTurns();
        throw err;
      } finally {
        if (seamEpoch === epoch) seamEpoch = null;
      }
    }

    if (transition === 'curl' && !prefersReducedMotion() && (curlHost || curlShadow)) {
      if (canTurnInPlace(direction)) {
        const current = strip();
        if (current) {
          const captured = allowAnimation ? captureOutgoingSpread() : false;
          if (captured) applyPaperCurl(curlHost, curlShadow, 0, direction, { spread });
          const maxLeft = Math.max(
            0,
            current.container.scrollWidth - current.container.clientWidth,
          );
          current.container.scrollLeft =
            direction > 0
              ? Math.min(current.container.scrollLeft + current.stride, maxLeft)
              : Math.max(0, current.container.scrollLeft - current.stride);
          syncCurrentCfiFromScroll();
          if (!allowAnimation) return true;
          const token = Symbol('curl');
          curlRunToken = token;
          const completed = await runCurlAnimation({
            from: 0,
            to: 1,
            duration: PAGE_CURL_MS,
            direction,
            spread,
            captured,
            token,
          });
          return completed && epoch === navigation && !destroyed;
        }
      }
      if (!canCrossChapter(direction)) return false;
      const captured = captureOutgoingSpread();
      if (captured) applyPaperCurl(curlHost, curlShadow, 0, direction, { spread });
      seamEpoch = epoch;
      try {
        await (direction > 0 ? rendition.next() : rendition.prev());
      } catch (err) {
        if (seamEpoch === epoch) seamEpoch = null;
        if (epoch === navigation) {
          if (!inDrain) clearPendingTurns();
          clearCurlStage();
        }
        throw err;
      }
      if (seamEpoch === epoch) seamEpoch = null;
      if (epoch !== navigation || destroyed) return false;
      if (shouldAnimateFinal()) {
        const token = Symbol('curl');
        curlRunToken = token;
        const completed = await runCurlAnimation({
          from: 0,
          to: 1,
          duration: PAGE_CURL_MS,
          direction,
          spread,
          captured,
          token,
        });
        return completed && epoch === navigation && !destroyed;
      }
      clearCurlStage();
      return finishSeamTurn(epoch);
    }

    if (canTurnInPlace(direction)) {
      const current = strip();
      if (current) {
        if (animate && allowAnimation) {
          const paneWidth = beginSlideStage(direction);
          if (paneWidth !== null) {
            const stage = slideStage;
            await animateSlideStage(-direction * paneWidth, PAGE_SLIDE_MS);
            // A newer turn may have taken the stage over; it owns the cleanup.
            if (slideStage === stage) endSlideStage();
            if (epoch !== navigation || destroyed) return false;
            syncCurrentCfiFromScroll();
            return true;
          }
          const maxLeft = Math.max(
            0,
            current.container.scrollWidth - current.container.clientWidth,
          );
          const targetLeft =
            direction > 0
              ? Math.min(current.container.scrollLeft + current.stride, maxLeft)
              : Math.max(0, current.container.scrollLeft - current.stride);
          await slideStrip(targetLeft, PAGE_SLIDE_MS);
          if (epoch !== navigation || destroyed) return false;
          syncCurrentCfiFromScroll();
          return true;
        }
        const maxLeft = Math.max(0, current.container.scrollWidth - current.container.clientWidth);
        current.container.scrollLeft =
          direction > 0
            ? Math.min(current.container.scrollLeft + current.stride, maxLeft)
            : Math.max(0, current.container.scrollLeft - current.stride);
        syncCurrentCfiFromScroll();
        return true;
      }
    }

    if (!canCrossChapter(direction)) return false;

    if (animate && !prefersReducedMotion() && curlHost) {
      const paneWidth = curlHost.getBoundingClientRect().width;
      if (paneWidth > 0 && captureOutgoingSpread()) {
        // Freeze the outgoing page above the strip while epub.js parses and lays
        // out the next chapter so `views.clear()` / `scrollTo(0, 0)` never flashes.
        curlHost.style.transform = 'translateX(0px)';
        seamEpoch = epoch;
        try {
          await (direction > 0 ? rendition.next() : rendition.prev());
        } catch (err) {
          if (seamEpoch === epoch) seamEpoch = null;
          if (epoch === navigation) {
            if (!inDrain) clearPendingTurns();
            clearCurlStage();
          }
          throw err;
        }
        if (seamEpoch === epoch) seamEpoch = null;
        if (epoch !== navigation || destroyed) return false;
        if (shouldAnimateFinal()) {
          const stagedWidth = beginSlideStage(direction, {
            useExistingMirror: true,
            advanceStrip: false,
          });
          if (stagedWidth !== null) {
            const stage = slideStage;
            await animateSlideStage(-direction * stagedWidth, PAGE_SLIDE_MS);
            if (slideStage === stage) endSlideStage();
            if (epoch !== navigation || destroyed) return false;
            syncCurrentCfiFromScroll();
            return true;
          }
        }
        clearCurlStage();
        return finishSeamTurn(epoch);
      }
    }

    const settleSeam = animate && !prefersReducedMotion() ? armSeam() : null;
    seamEpoch = epoch;
    try {
      await (direction > 0 ? rendition.next() : rendition.prev());
    } catch (err) {
      if (!inDrain && epoch === navigation) clearPendingTurns();
      throw err;
    } finally {
      if (seamEpoch === epoch) seamEpoch = null;
      if (settleSeam) await settleSeam(direction, { animate: shouldAnimateFinal() });
    }
    if (epoch !== navigation || destroyed) return false;
    return finishSeamTurn(epoch);
  };

  const turn = async (
    direction: TurnDirection,
    animate: boolean,
    transition?: PageTransition,
    spread = false,
  ): Promise<boolean> => {
    if (seamEpoch !== null && seamEpoch === navigation) {
      return new Promise<boolean>((resolve, reject) => {
        pendingTurns.push({ direction, animate, transition, spread, resolve, reject });
      });
    }
    return executeTurn(direction, animate, transition, spread);
  };

  const endScrub = async (committed: TurnDirection | null) => {
    const activeCurl = scrubCurl;
    const transition = scrubTransition;
    const spread = scrubSpread;
    const base = scrubBase;
    const baseCfi = scrubBaseCfi;
    const baseLocation = scrubBaseLocation;
    const inPlace = committed !== null && canTurnInPlace(committed);
    scrubbing = false;
    scrubMoved = false;
    scrubTransition = undefined;
    scrubSpread = false;
    scrubCurl = null;
    if (activeCurl) {
      const current = strip();
      if (!current || activeCurl.direction === null) {
        clearCurlStage();
        return;
      }
      current.container.scrollLeft = base;
      const inPlaceCurl = committed !== null && committed === activeCurl.direction && inPlace;
      if (committed === null || committed !== activeCurl.direction) {
        const epoch = navigation;
        settlingSpringBack = true;
        setStripHidden(activeCurl.seam);
        const token = Symbol('curl');
        curlRunToken = token;
        const completed = await runCurlAnimation({
          from: activeCurl.progress,
          to: 0,
          duration: PAGE_SPRING_BACK_MS,
          direction: activeCurl.direction,
          spread: activeCurl.spread,
          captured: activeCurl.captured,
          token,
        });
        if (!completed || epoch !== navigation || destroyed || scrubbing) return;
        settlingSpringBack = false;
        setStripHidden(false);
        restoreScrubBaseLocation(baseCfi, baseLocation);
        return;
      }
      const duration = Math.max(120, Math.round((1 - activeCurl.progress) * PAGE_CURL_MS));
      if (inPlaceCurl) {
        const epoch = navigation;
        setStripHidden(false);
        current.container.scrollLeft = base + committed * current.stride;
        const token = Symbol('curl');
        curlRunToken = token;
        const completed = await runCurlAnimation({
          from: activeCurl.progress,
          to: 1,
          duration,
          direction: committed,
          spread: activeCurl.spread,
          captured: activeCurl.captured,
          token,
        });
        if (completed && epoch === navigation && !destroyed && !scrubbing && !settlingSpringBack) {
          syncCurrentCfiFromScroll();
        }
        return;
      }
      const epoch = beginNavigation();
      setStripHidden(true);
      applyPaperCurl(
        activeCurl.captured ? curlHost : null,
        curlShadow,
        activeCurl.progress,
        committed,
        {
          spread: activeCurl.spread,
        },
      );
      try {
        await (committed > 0 ? rendition.next() : rendition.prev());
      } catch (err) {
        if (epoch === navigation) clearCurlStage();
        throw err;
      }
      if (epoch !== navigation || destroyed) return;
      setStripHidden(false);
      const token = Symbol('curl');
      curlRunToken = token;
      await runCurlAnimation({
        from: activeCurl.progress,
        to: 1,
        duration,
        direction: committed,
        spread: activeCurl.spread,
        captured: activeCurl.captured,
        token,
      });
      return;
    }

    const current = strip();
    if (!current) return;

    // A staged scrub settles the whole-page slide the fingers were driving.
    if (slideStage !== null) {
      const stage = slideStage;
      const commit =
        committed !== null && committed === stage.direction && (stage.seam ? true : inPlace);
      if (!commit) {
        const epoch = navigation;
        settlingSpringBack = true;
        // Record where this settle lands before the animation: an interruption
        // during the spring-back must restore the cancelled scrub's page.
        stage.landing = base;
        await animateSlideStage(0, PAGE_SPRING_BACK_MS);
        // A turn or navigation that arrived during the settle owns the page now.
        if (epoch !== navigation || slideStage !== stage || destroyed) return;
        settlingSpringBack = false;
        current.container.scrollLeft = base;
        endSlideStage();
        restoreScrubBaseLocation(baseCfi, baseLocation);
        return;
      }
      if (!stage.seam) {
        stage.landing = base + stage.direction * current.stride;
        await animateSlideStage(-stage.direction * stage.paneWidth, PAGE_SLIDE_MS);
        if (slideStage !== stage) return;
        endSlideStage();
        syncCurrentCfiFromScroll();
        return;
      }
      const epoch = beginNavigation();
      // Keep the outgoing page visible where the fingers released until the next
      // chapter finishes loading so a slow parse never leaves a blank paper pane.
      try {
        await (committed > 0 ? rendition.next() : rendition.prev());
      } catch (err) {
        if (epoch === navigation && slideStage === stage) {
          cancelStage();
          endSlideStage();
        }
        throw err;
      }
      if (epoch !== navigation || slideStage !== stage || destroyed) return;
      setStripHidden(false);
      stage.landing = current.container.scrollLeft;
      const progress = Math.min(Math.abs(stage.offset) / Math.max(stage.paneWidth, 1), 1);
      const duration = Math.max(120, Math.round((1 - progress) * PAGE_SLIDE_MS));
      await animateSlideStage(-stage.direction * stage.paneWidth, duration);
      if (epoch !== navigation || slideStage !== stage || destroyed) return;
      endSlideStage();
      syncCurrentCfiFromScroll();
      return;
    }

    settleSlide();
    // Only `slide` settles by moving the strip. `none`, `fade` and `stack` land at
    // once and play their own motion on the incoming page, as a turn does.
    const slides = transition === undefined || transition === 'slide';
    const settleMs = slides ? PAGE_SLIDE_MS : 0;
    const springMs = slides ? PAGE_SPRING_BACK_MS : 0;
    if (committed === null) {
      const epoch = navigation;
      settlingSpringBack = true;
      await slideStrip(base, springMs);
      if (epoch === navigation && !destroyed && !scrubbing && settlingSpringBack) {
        settlingSpringBack = false;
        restoreScrubBaseLocation(baseCfi, baseLocation);
      }
      return;
    }
    if (inPlace) {
      const epoch = navigation;
      await slideStrip(base + committed * current.stride, settleMs);
      if (epoch === navigation && !destroyed && !scrubbing && !settlingSpringBack) {
        syncCurrentCfiFromScroll();
      }
      return;
    }
    // The fingers reached the chapter's edge: settle back, then cross the seam.
    const epoch = navigation;
    await slideStrip(base, springMs);
    if (epoch !== navigation || destroyed || scrubbing) return;
    await turn(committed, transition === 'slide', transition, spread);
  };

  const spineIndexOf = (href: string) => {
    const path = href.split('#')[0] ?? '';
    if (!path.replace(/^(\.\/|\/)+/, '')) return -1;
    return spineItems.findIndex((item) => isSpinePath(item, path));
  };

  return {
    toc,
    isFixedLayout,
    chapterCount: spineItems.length,
    async searchChapter(chapterIndex, query, options) {
      if (query.trim() === '') return [];
      return withSection(
        chapterIndex,
        (section, chapterDoc) => {
          const { fullText, nodes } = collectText(chapterDoc);
          const rawMatches = findSearchMatches(fullText, query, options);
          // Counted like the measuring pass, so a mark sits where the weights put it.
          const counted = countedOffsets(fullText, [
            ...rawMatches.map((match) => match.start),
            fullText.length,
          ]);
          const countedLength = counted.at(-1) ?? 0;
          const locationLabel = findTocLabel(toc, section.href) ?? `Ch. ${chapterIndex + 1}`;
          const matches: EpubSearchMatch[] = [];

          for (let index = 0; index < rawMatches.length; index += 1) {
            const match = rawMatches[index];
            if (!match) continue;
            const startEntry = nodes.find((entry) => entry.end > match.start);
            const endEntry = nodes.findLast((entry) => entry.start < match.end);
            if (!startEntry || !endEntry) continue;
            const startOffset = Math.max(0, match.start - startEntry.start);
            const endOffset = Math.min(endEntry.node.data.length, match.end - endEntry.start);
            const range = chapterDoc.createRange();
            range.setStart(startEntry.node, startOffset);
            range.setEnd(endEntry.node, endOffset);
            const cfiRange = section.cfiFromRange(range);
            const snippet = buildSearchSnippet(fullText, match.start, match.end);
            matches.push({
              id: `epub-${chapterIndex}-${index}`,
              cfiRange,
              chapterHref: section.href,
              chapterIndex,
              chapterFraction: countedLength > 0 ? (counted[index] ?? 0) / countedLength : 0,
              locationLabel,
              ...snippet,
            });
          }
          return matches;
        },
        [],
      );
    },
    display,
    compareCfi(one, two) {
      return new EpubCFI().compare(one, two);
    },
    spineIndexOf,
    async peekLink(href, { noteref }) {
      const hash = href.indexOf('#');
      if (hash < 0) return null;
      const index = spineIndexOf(href);
      if (index < 0) return null;
      const fragment = href.slice(hash + 1);
      return withSection(
        index,
        (_section, chapterDoc) => noteTextAt(chapterDoc, fragment, { noteref }),
        null,
      );
    },
    spineHref: (index) => spineItems[index]?.href,
    measureChapter: (index) =>
      withSection(index, (_section, chapterDoc) => countText(chapterDoc), null),
    async displayChapterFraction(index, fraction) {
      const href = spineItems[index]?.href;
      if (href === undefined) throw new Error(`no chapter ${index}`);
      if (fraction <= 0) {
        await display(href);
        return;
      }
      const cfi = await withSection(
        index,
        (section, chapterDoc) => {
          const { fullText, nodes } = collectText(chapterDoc);
          if (nodes.length === 0) return null;
          // `fraction` is of the counted text the weights measure, not of the raw
          // text, so indentation in pretty-printed XHTML does not move the target.
          const countedLength = countedOffsets(fullText, [fullText.length])[0] ?? 0;
          const target = Math.min(
            rawOffsetOfCounted(fullText, Math.floor(fraction * countedLength)),
            fullText.length - 1,
          );
          const entry = nodes.find((candidate) => candidate.end > target) ?? nodes.at(-1);
          if (!entry) return null;
          const range = chapterDoc.createRange();
          const at = Math.min(Math.max(target - entry.start, 0), entry.node.length);
          range.setStart(entry.node, at);
          range.setEnd(entry.node, at);
          return section.cfiFromRange(range);
        },
        null,
      );
      await display(cfi ?? href);
    },
    next: async () => {
      await turn(1, false);
    },
    previous: async () => {
      await turn(-1, false);
    },
    setCurlElements({ curlHost: nextHost, shadow }) {
      clearCurlStage();
      curlHost = nextHost;
      curlShadow = shadow;
    },
    turnPage: (direction, options) =>
      turn(direction, options?.animate ?? true, options?.transition, options?.spread),
    canTurnInPlace,
    hasSelection() {
      return contentsList().some(hasContentsSelection);
    },
    beginScrub(options) {
      clearCodeBlockHover();
      // A scrub starts from a whole page and claims navigation ownership so any
      // in-flight seam turn or jump that finishes later cannot overwrite it.
      settleSlide();
      clearCurlStage();
      beginNavigation();
      pendingTarget = undefined;
      scrubbing = true;
      scrubMoved = false;
      settlingSpringBack = false;
      scrubBase = strip()?.container.scrollLeft ?? 0;
      scrubBaseCfi = currentCfi;
      scrubBaseLocation = renditionState().location;
      scrubTransition = options?.transition;
      scrubSpread = options?.spread ?? false;
      if (
        options?.transition === 'curl' &&
        currentMode !== 'scroll' &&
        !prefersReducedMotion() &&
        (curlHost || curlShadow)
      ) {
        scrubCurl = {
          spread: options.spread ?? false,
          direction: null,
          progress: 0,
          captured: false,
          seam: false,
        };
      }
    },
    scrubTo(displacement) {
      const current = strip();
      if (!current) return;
      // A scrub takes over from a slide rather than fighting it for the offset.
      cancelSlide();
      if (scrubCurl) {
        if (displacement === 0) {
          scrubMoved = false;
          current.container.scrollLeft = scrubBase;
          setStripHidden(false);
          resetPaperCurl(curlHost, curlShadow);
          if (curlHost) {
            curlHost.style.visibility = 'hidden';
            curlHost.replaceChildren();
          }
          scrubCurl.direction = null;
          scrubCurl.progress = 0;
          scrubCurl.captured = false;
          scrubCurl.seam = false;
          return;
        }
        scrubMoved = true;
        const dir: TurnDirection = displacement < 0 ? -1 : 1;
        if (!scrubCurl.captured) {
          current.container.scrollLeft = scrubBase;
          scrubCurl.captured = captureOutgoingSpread();
        }
        if (scrubCurl.direction !== dir) {
          current.container.scrollLeft = scrubBase;
          const seamTurn = !canTurnInPlace(dir);
          scrubCurl.seam = seamTurn;
          setStripHidden(seamTurn);
          if (!seamTurn) {
            current.container.scrollLeft = scrubBase + dir * current.stride;
          }
          scrubCurl.direction = dir;
        }
        const paneWidth = curlHost?.getBoundingClientRect().width ?? 0;
        const span = paneWidth > 0 ? paneWidth : current.stride;
        const progress = Math.min(
          Math.max(Math.abs(displacement) / Math.max(span, 1), 0.005),
          0.995,
        );
        scrubCurl.progress = progress;
        applyPaperCurl(scrubCurl.captured ? curlHost : null, curlShadow, progress, dir, {
          spread: scrubCurl.spread,
        });
        return;
      }

      // A staged slide follows the fingers across the whole page area.
      if (scrubTransition === undefined || scrubTransition === 'slide') {
        if (displacement === 0) {
          scrubMoved = false;
          if (slideStage !== null) {
            endSlideStage();
            current.container.scrollLeft = scrubBase;
          }
          return;
        }
        scrubMoved = true;
        const dir: TurnDirection = displacement < 0 ? -1 : 1;
        const seamTurn = !canTurnInPlace(dir);
        if (slideStage === null) {
          current.container.scrollLeft = scrubBase;
          if (beginSlideStage(dir, { seam: seamTurn }) === null) {
            current.container.scrollLeft = scrubBase + displacement;
            return;
          }
        } else if (slideStage.direction !== dir) {
          // The same outgoing page is on both sides of a reversal, so the mirror
          // already holds it; restage instead of cloning the chapter again.
          current.container.scrollLeft = scrubBase;
          if (!restageSlideStage(dir, scrubBase, { seam: seamTurn })) {
            endSlideStage();
            current.container.scrollLeft = scrubBase + displacement;
            return;
          }
        }
        // The stage offset is the page's travel, which runs opposite the fingers:
        // a forward swipe (positive displacement) pulls the incoming page in from
        // the right, so its offset goes negative.
        applySlideStage(-displacement);
        return;
      }

      scrubMoved = displacement !== 0;
      current.container.scrollLeft = scrubBase + displacement;
    },
    endScrub,
    async setReadingMode(mode) {
      if (mode === currentMode) return;
      clearCodeBlockHover();
      // A relayout replaces the strip's chapter, so a slide in flight must land
      // before epub.js re-displays, not keep writing into the new one.
      settleSlide();
      clearCurlStage();
      currentMode = mode;
      const epoch = beginNavigation();
      const target = pendingTarget ?? currentCfi;
      const wanted = target === undefined ? undefined : book.spine.get(target)?.href;
      pendingTarget = target;
      // Clear `location` while changing flow, spread, and stage size so
      // `rendition.flow` and `onResized` do not enqueue stale displays first.
      Reflect.set(rendition, 'location', undefined);
      rendition.flow(MODE_FLOW[mode]);
      rendition.spread(spreadFor(mode, currentColumns), 0);
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        resizeTo(element.clientWidth, element.clientHeight, target);
      }
      rendition.clear();
      Reflect.set(
        rendition,
        'location',
        target !== undefined && wanted !== undefined
          ? { start: { href: wanted, cfi: target } }
          : undefined,
      );
      try {
        await (rendition.display(target) as unknown as Promise<void>).catch(
          () => rendition.display() as unknown as Promise<void>,
        );
      } finally {
        if (epoch === navigation) pendingTarget = undefined;
      }
    },

    setColumns(columns) {
      if (columns === currentColumns) return;
      // The column count changes the stride, so a slide in flight is already
      // measured in the wrong units.
      clearPendingTurns();
      settleSlide();
      clearCurlStage();
      const before = spreadFor(currentMode, currentColumns);
      currentColumns = columns;
      const after = spreadFor(currentMode, columns);
      if (before === after) return;
      clearCodeBlockHover();
      // epub.js re-lays out on resize and returns to the current location then.
      rendition.spread(after, 0);
      const target = pendingTarget ?? currentCfi;
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        resizeTo(element.clientWidth, element.clientHeight, target);
      }
      if (target) {
        const epoch = beginNavigation();
        pendingTarget = target;
        void (rendition.display(target) as unknown as Promise<void>)
          .catch(() => undefined)
          .finally(() => {
            if (epoch === navigation) pendingTarget = undefined;
          });
      }
    },

    setPreferences(preferences) {
      clearCodeBlockHover();
      const typographyChanged =
        preferences.fontFamily !== currentPreferences.fontFamily ||
        preferences.fontSize !== currentPreferences.fontSize ||
        preferences.lineSpacing !== currentPreferences.lineSpacing ||
        preferences.justify !== currentPreferences.justify;
      currentPreferences = { ...preferences };
      // `section.render()` re-serializes cached `section.document` on resize or mode
      // switches without re-running `book.spine.hooks.content`, and `IframeView.onLoad`
      // measures the frame before `rendition.hooks.content` runs. Keep every loaded
      // section document in sync so re-renders measure and paint at the current size.
      for (const item of spineItems) {
        if (item.document) {
          applyUserPreferencesToDocument(item.document, currentPreferences, isFixedLayout);
        }
      }
      for (const contents of contentsList()) {
        applyUserPreferencesToDocument(contents.document, currentPreferences, isFixedLayout);
        // Free when the theme has not changed: the chapter remembers which theme
        // its colors were settled for, and the book's own colors stay untouched.
        if (!isFixedLayout) {
          applyReadableAuthorColors(contents.document, currentPreferences.theme);
        }
      }
      if (typographyChanged && !isFixedLayout) {
        // `manager.resize` early-returns when the host dimensions did not change
        // (such as a font-size change inside a fixed page width), so expand live
        // views explicitly to reflow iframe bounds and re-place highlight marks.
        const views = (
          rendition as unknown as {
            views?: () => { forEach?: (fn: (view: { _needsReframe?: boolean }) => void) => void };
          }
        ).views?.();
        views?.forEach?.((view) => {
          view._needsReframe = true;
        });
        for (const contents of contentsList()) {
          (contents as unknown as { expand?: () => void }).expand?.();
        }
        if (element.clientWidth > 0 && element.clientHeight > 0) {
          clearPendingTurns();
          const target = pendingTarget ?? currentCfi;
          resizeTo(element.clientWidth, element.clientHeight, target);
          if (target && currentMode !== 'scroll') {
            const epoch = beginNavigation();
            pendingTarget = target;
            void (rendition.display(target) as unknown as Promise<void>)
              .catch(() => undefined)
              .finally(() => {
                if (epoch === navigation) pendingTarget = undefined;
              });
          }
        }
      }
    },

    highlight(annotationId, cfiRange, color, style = 'highlight', options = {}) {
      // marks-pane forwards clicks in the frame to the mark under them.
      const onClick = () => {
        // Search marks are painted by the reader, not annotations it can open.
        if (annotationId.startsWith('__')) return;
        // A drag that ends over a mark clicks it too; that press made a selection instead.
        if (contentsList().some(hasContentsSelection)) return;
        const marks = element.querySelectorAll(
          `[data-annotation-id="${CSS.escape(annotationId)}"]`,
        );
        markClickListener(annotationId, markViewportRect(Array.from(marks), annotationId));
      };
      // The note dot comes from `decorateWithNoteMarker` alone, so the mark's data
      // says only which annotation it is.
      const data = { annotationId };
      // `add` is what `highlight` and `underline` call, and the one typed to
      // return the annotation, which the note dot needs.
      const annotation =
        style === 'underline'
          ? rendition.annotations.add('underline', cfiRange, data, onClick, 'epub-underline', {
              stroke: color,
              'stroke-opacity': '1',
              'stroke-width': '2',
            })
          : rendition.annotations.add('highlight', cfiRange, data, onClick, 'epub-highlight', {
              fill: color,
              'fill-opacity': '0.4',
              'mix-blend-mode': 'multiply',
            });
      if (options.hasNote) {
        decorateWithNoteMarker(annotation as unknown as RenditionAnnotation, color);
      }
    },
    removeHighlight: (cfiRange, style = 'highlight') =>
      rendition.annotations.remove(cfiRange, style),

    setPulse(annotationId, pulsing) {
      const marks = element.querySelectorAll(`[data-annotation-id="${CSS.escape(annotationId)}"]`);
      for (const mark of marks) mark.classList.toggle('anchor-pulse', pulsing);
      return marks.length > 0;
    },

    clearSelection() {
      for (const contents of contentsList()) contents.window.getSelection()?.removeAllRanges();
    },
    selectionRect() {
      for (const contents of contentsList()) {
        const selection = contents.window.getSelection();
        if (!hasTextSelection(selection) || selection.rangeCount === 0) continue;
        const frame = contents.window.frameElement?.getBoundingClientRect();
        return rangeViewportRect(selection.getRangeAt(0), {
          left: frame?.left ?? 0,
          top: frame?.top ?? 0,
        });
      }
      return null;
    },
    onMarkClick(listener) {
      markClickListener = listener;
    },
    onPointer(listener) {
      pointerListener = listener;
    },
    resize: (width, height) => {
      clearCodeBlockHover();
      // A resize clears epub.js' views. Restore the jump in flight, or the current
      // location, rather than the stale location epub.js last reported (#41).
      clearPendingTurns();
      settleSlide();
      clearCurlStage();
      resizeTo(width, height, pendingTarget ?? currentCfi);
    },
    onSelection(listener) {
      selectionListener = listener;
    },
    onInternalLink(listener) {
      internalLinkListener = listener;
    },
    onLocation(listener) {
      locationListener = listener;
    },
    onKeyDown(listener) {
      keyDownListener = listener;
    },
    onContextMenu(listener) {
      contextMenuListener = listener;
    },
    onGesture(listener) {
      gestureListener = listener;
    },
    onFramePointerUp(listener) {
      framePointerUpListener = listener;
    },
    onWheel(listener) {
      wheelListener = listener;
    },
    onCodeBlockHover(listener) {
      codeBlockHoverListener = listener;
    },
    setCursor(cursor) {
      if (cursor === frameCursor) return;
      frameCursor = cursor;
      for (const contents of contentsList()) {
        contents.document.documentElement.style.cursor = cursor;
      }
    },
    destroy() {
      clearCodeBlockHover();
      destroyed = true;
      framePointerDown = false;
      clearPendingTurns();
      framePointerUpListener = () => undefined;
      codeBlockHoverListener = () => undefined;
      for (const observer of codeTabObservers) observer.disconnect();
      codeTabObservers.clear();
      ownerDoc.removeEventListener('pointermove', onOwnerPointerMove);
      ownerDoc.removeEventListener('pointerdown', onOwnerPointerDown);
      ownerDoc.removeEventListener('pointerup', onOwnerPointerUp);
      ownerDoc.removeEventListener('pointercancel', onOwnerPointerUp);
      ownerDoc.removeEventListener('focusin', onOwnerFocusIn);
      cancelSlide();
      clearCurlStage();
      // The seam hold shadows one method on the manager; leave it as we found it.
      if (seamViews && clearViews) seamViews.clear = clearViews;
      // A view epub.js has already thrown away took its document with it; the rest
      // still carry the listener the chapter hook added.
      for (const contents of contentsList()) {
        contents.document.removeEventListener('contextmenu', onChapterContextMenu);
      }
      book.destroy();
    },
  };
}
