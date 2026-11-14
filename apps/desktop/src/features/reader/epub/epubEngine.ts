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
  isOverContent,
  PAGE_CURL_MS,
  PAGE_SLIDE_MS,
  PAGE_SPRING_BACK_MS,
  type PageGestureSample,
  prefersReducedMotion,
  resetPaperCurl,
  type TurnDirection,
  type WheelSample,
} from '@/features/reader/paging/pageTurn';
import {
  type AnnotationStyle,
  DEFAULT_READING_PREFERENCES,
  type DocumentSource,
  type EpubReadingMode,
  type PageTransition,
  type ReadingPreferences,
} from '@/types/domain';

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
 * The parts of epub.js' default view manager a continuous page turn touches. The
 * strip is the container that holds the chapter's columns; `delta` is how far one
 * page turn moves it, and `views` is the collection whose `clear()` would empty
 * the strip before the next chapter has loaded.
 */
interface PaginatedManager {
  container: HTMLElement;
  layout?: { delta?: number };
  views?: {
    _views?: { element?: HTMLElement }[];
    length: number;
    clear: () => void;
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
   * or chapter is shown straight away. Resolves once the turn has settled.
   */
  turnPage(
    direction: TurnDirection,
    options?: {
      animate?: boolean | undefined;
      transition?: PageTransition | undefined;
      spread?: boolean | undefined;
    },
  ): Promise<void>;
  /** Whether the current chapter has another page that way, without leaving it. */
  canTurnInPlace(direction: TurnDirection): boolean;
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
  /** Pointer events in a chapter frame, in the top window's coordinates. */
  onGesture(listener: (sample: PageGestureSample) => void): void;
  /** Wheel events in a chapter frame; the listener reports whether it used one. */
  onWheel(listener: (wheel: WheelSample) => boolean): void;
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
img, svg, video, figure, table, pre, blockquote {
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
  white-space: pre-wrap;
  overflow-wrap: break-word;
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
  let locationListener: (location: EpubLocation) => void = () => undefined;
  let internalLinkListener: (href: string, link: EpubInternalLink) => void = () => undefined;
  let keyDownListener: (event: KeyboardEvent) => void = () => undefined;
  let gestureListener: (sample: PageGestureSample) => void = () => undefined;
  let wheelListener: (wheel: WheelSample) => boolean = () => false;
  let markClickListener: (annotationId: string, rect: ViewportRect | null) => void = () =>
    undefined;
  let pointerListener: (down: boolean) => void = () => undefined;
  let frameCursor = '';

  rendition.hooks.content.register((contents: Contents) => {
    contents.document.body?.classList.toggle('epubjs-scrolled', currentMode === 'scroll');
    // epub.js puts a click handler on every relative link that calls `display()`
    // directly, before the viewer hears about it, so an internal link would jump
    // without joining the reader's jump history or offering the way back. Capture
    // the click first and let the viewer navigate. Absolute links keep their own
    // behaviour (epub.js already sends them to a new tab).
    contents.document.addEventListener(
      'click',
      (event: MouseEvent) => {
        if (event.button !== 0) return;
        const target = event.target as Element | null;
        const anchor = target?.closest?.('a[href]') ?? null;
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
    contents.document.addEventListener('selectionchange', () => {
      const selection = contents.window.getSelection();
      if (!selection || selection.isCollapsed) selectionListener(null);
    });
    contents.document.addEventListener('keydown', (event: KeyboardEvent) => {
      keyDownListener(event);
    });
    // Page turns are decided outside the frame, in the top window's coordinates.
    const chapterDoc = contents.document;
    const offset = () => {
      const frame = contents.window.frameElement;
      const rect = frame?.getBoundingClientRect();
      return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
    };
    const hasSelection = () => {
      const selection = contents.window.getSelection();
      return selection !== null && !selection.isCollapsed;
    };
    chapterDoc.documentElement.style.cursor = frameCursor;
    chapterDoc.addEventListener('pointerup', (event: PointerEvent) => {
      if (event.button === 0) pointerListener(false);
    });
    chapterDoc.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
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
      if (event.button !== 0 || event.detail > 1 || event.defaultPrevented) return;
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
        if (wheelListener(event)) event.preventDefault();
      },
      { passive: false },
    );
    // `section.load()` runs `book.spine.hooks.content` only on the first parse of a
    // chapter, so any later view created by a resize, mode switch, or chapter revisit
    // must receive the latest preferences here too before author colors are audited.
    applyUserPreferencesToDocument(contents.document, currentPreferences, isFixedLayout);
    // Dark and Sepia color `html` and `body`; a chapter's own colors survive.
    // The iframe's load event has already run, so its stylesheets are applied.
    if (!isFixedLayout) applyReadableAuthorColors(contents.document, currentPreferences.theme);
  });
  rendition.on('selected', (cfiRange: string, contents: Contents) => {
    const text = contents.window.getSelection()?.toString().trim() ?? '';
    const chapterHref = book.spine.get(cfiRange)?.href;
    // Core refuses an excerpt of only whitespace.
    selectionListener(text && chapterHref ? { cfiRange, chapterHref, text } : null);
  });
  rendition.on('relocated', (location: Location) => {
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

  /** A newer navigation; an older one must neither repair nor wait for it. */
  let navigation = 0;
  const beginNavigation = () => ++navigation;
  /** Where a jump is heading, so a resize restores it instead of the old location. */
  let pendingTarget: string | undefined;

  /** Resolves once epub.js' queue drained and its rAF-gated location report ran. */
  const settled = () =>
    renditionState()
      .q.enqueue(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      .catch(() => undefined);

  const display = async (target?: string) => {
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

  /** Puts the strip where the slide in flight was heading, if one is running. */
  const settleSlide = () => {
    const inFlight = slideFrame !== 0 || slideDone !== null;
    cancelSlide();
    // Without this, a finished slide's target would be re-applied to a chapter
    // that has since been replaced, and the strip would jump to the old page.
    if (!inFlight) return;
    const current = strip();
    if (current) current.container.scrollLeft = slideTarget;
  };

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
      if (prefersReducedMotion()) {
        container.scrollLeft = target;
        resolve();
        return;
      }
      const from = container.scrollLeft;
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

  /** Whether the chapter has another page that way, as epub.js itself decides. */
  const canTurnInPlace = (direction: TurnDirection): boolean => {
    const current = strip();
    if (!current) return false;
    const { container, stride } = current;
    return direction > 0
      ? container.scrollLeft + container.offsetWidth + stride <= container.scrollWidth + 1
      : container.scrollLeft > 1;
  };

  /**
   * epub.js empties the container before the next chapter's iframe has loaded, so
   * a turn across a spine seam shows a blank page for as long as the parse takes.
   * While a seam turn is armed, `views.clear()` forgets its views instead of
   * destroying them: their iframes stay painted in the strip, one page away from
   * the incoming chapter, and the turn slides across the seam between them.
   */
  const seam = { armed: false, held: [] as HTMLElement[] };
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
        if (held?.parentElement) seam.held.push(held);
      }
      views._views = [];
      views.length = 0;
    };
    seamViews = views;
    clearViews = original;
    return true;
  };

  /** Arms the hold, and returns what settles it once the new chapter is up. */
  const armSeam = (): ((direction: TurnDirection) => Promise<void>) | null => {
    if (!ensureSeamHold()) return null;
    seam.armed = true;
    seam.held = [];
    return async (direction) => {
      seam.armed = false;
      const held = seam.held;
      seam.held = [];
      const current = strip();
      if (current && held.length > 0) {
        const { container, stride } = current;
        // The incoming chapter sits one page past the one still painted.
        const target =
          direction > 0 ? container.scrollLeft + stride : container.scrollLeft - stride;
        await slideStrip(target, PAGE_SLIDE_MS);
      }
      for (const element of held) element.remove();
    };
  };

  let curlHost: HTMLElement | null = null;
  let curlShadow: HTMLElement | null = null;
  let cancelCurl: (() => void) | null = null;
  let scrubCurl: {
    spread: boolean;
    direction: TurnDirection | null;
    progress: number;
    captured: boolean;
  } | null = null;

  const clearCurlStage = () => {
    cancelCurl?.();
    cancelCurl = null;
    scrubCurl = null;
    resetPaperCurl(curlHost, curlShadow);
    if (curlHost) {
      curlHost.style.visibility = 'hidden';
      curlHost.replaceChildren();
    }
  };

  const runCurlAnimation = (params: {
    from: number;
    to: number;
    duration: number;
    direction: TurnDirection;
    spread: boolean;
    captured: boolean;
  }): Promise<void> =>
    new Promise((resolve) => {
      let settledRun = false;
      const settleRun = () => {
        if (settledRun) return;
        settledRun = true;
        cancelCurl = null;
        if (curlHost) {
          curlHost.style.visibility = 'hidden';
          curlHost.replaceChildren();
        }
        resolve();
      };
      const cancelAnim = animatePaperCurl({
        outgoing: params.captured ? curlHost : null,
        shadow: curlShadow,
        direction: params.direction,
        from: params.from,
        to: params.to,
        duration: params.duration,
        spread: params.spread,
        onFinish: settleRun,
      });
      if (!settledRun) {
        cancelCurl = () => {
          cancelAnim();
          settleRun();
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
    const doc = curlHost.ownerDocument;

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
      curlHost.appendChild(viewClone);

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
    if (curlHost.childElementCount === 0 && fallbackDoc?.body) {
      const cloneBox = doc.createElement('div');
      cloneBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      for (const node of Array.from(fallbackDoc.body.childNodes)) {
        const imported = doc.importNode(node, true);
        if (imported instanceof Element) stripCloneIdentifiers(imported, true);
        cloneBox.appendChild(imported);
      }
      curlHost.appendChild(cloneBox);
    }

    if (curlHost.childElementCount === 0) return false;
    curlHost.style.visibility = 'visible';
    return true;
  };

  const turn = async (
    direction: TurnDirection,
    animate: boolean,
    transition?: PageTransition,
    spread = false,
  ) => {
    // A turn starts from a whole page, so any slide or curl still running settles first.
    settleSlide();
    clearCurlStage();
    beginNavigation();
    pendingTarget = undefined;
    if (currentMode === 'scroll') {
      const scroller = element.querySelector<HTMLElement>('.epub-container');
      if (scroller && scroller.clientHeight > 0) {
        const step = Math.max(Math.floor(scroller.clientHeight * 0.85), 100);
        if (direction > 0) {
          if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4) {
            scroller.scrollTop = Math.min(
              scroller.scrollTop + step,
              scroller.scrollHeight - scroller.clientHeight,
            );
            return;
          }
        } else if (scroller.scrollTop > 4) {
          scroller.scrollTop = Math.max(scroller.scrollTop - step, 0);
          return;
        }
      }
    } else if (transition === 'curl' && !prefersReducedMotion() && (curlHost || curlShadow)) {
      const captured = captureOutgoingSpread();
      if (canTurnInPlace(direction)) {
        const current = strip();
        if (current) {
          if (captured) applyPaperCurl(curlHost, curlShadow, 0, direction, { spread });
          current.container.scrollLeft += direction * current.stride;
          await runCurlAnimation({
            from: 0,
            to: 1,
            duration: PAGE_CURL_MS,
            direction,
            spread,
            captured,
          });
          return;
        }
      }
      if (captured) applyPaperCurl(curlHost, curlShadow, 0, direction, { spread });
      try {
        await (direction > 0 ? rendition.next() : rendition.prev());
      } catch (err) {
        clearCurlStage();
        throw err;
      }
      await runCurlAnimation({
        from: 0,
        to: 1,
        duration: PAGE_CURL_MS,
        direction,
        spread,
        captured,
      });
      return;
    } else if (animate && canTurnInPlace(direction)) {
      const current = strip();
      if (current) {
        await slideStrip(current.container.scrollLeft + direction * current.stride, PAGE_SLIDE_MS);
        return;
      }
    }
    const settleSeam = animate ? armSeam() : null;
    try {
      await (direction > 0 ? rendition.next() : rendition.prev());
    } finally {
      if (settleSeam) await settleSeam(direction);
    }
  };

  /** Where the strip sat when the fingers landed; a cancelled scrub returns here. */
  let scrubBase = 0;

  const endScrub = async (committed: TurnDirection | null) => {
    const activeCurl = scrubCurl;
    scrubCurl = null;
    if (activeCurl) {
      const current = strip();
      if (!current || activeCurl.direction === null) {
        clearCurlStage();
        return;
      }
      current.container.scrollLeft = scrubBase;
      const inPlace =
        committed !== null && committed === activeCurl.direction && canTurnInPlace(committed);
      if (committed === null || committed !== activeCurl.direction) {
        await runCurlAnimation({
          from: activeCurl.progress,
          to: 0,
          duration: PAGE_SPRING_BACK_MS,
          direction: activeCurl.direction,
          spread: activeCurl.spread,
          captured: activeCurl.captured,
        });
        return;
      }
      const duration = Math.max(120, Math.round((1 - activeCurl.progress) * PAGE_CURL_MS));
      if (inPlace) {
        current.container.scrollLeft = scrubBase + committed * current.stride;
        await runCurlAnimation({
          from: activeCurl.progress,
          to: 1,
          duration,
          direction: committed,
          spread: activeCurl.spread,
          captured: activeCurl.captured,
        });
        return;
      }
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
        clearCurlStage();
        throw err;
      }
      await runCurlAnimation({
        from: activeCurl.progress,
        to: 1,
        duration,
        direction: committed,
        spread: activeCurl.spread,
        captured: activeCurl.captured,
      });
      return;
    }

    const current = strip();
    if (!current) return;
    settleSlide();
    if (committed === null) {
      await slideStrip(scrubBase, PAGE_SPRING_BACK_MS);
      return;
    }
    if (canTurnInPlace(committed)) {
      await slideStrip(scrubBase + committed * current.stride, PAGE_SLIDE_MS);
      return;
    }
    // The fingers reached the chapter's edge: settle back, then cross the seam.
    await slideStrip(scrubBase, PAGE_SPRING_BACK_MS);
    await turn(committed, true);
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
    next: () => turn(1, false),
    previous: () => turn(-1, false),
    setCurlElements({ curlHost: nextHost, shadow }) {
      clearCurlStage();
      curlHost = nextHost;
      curlShadow = shadow;
    },
    turnPage: (direction, options) =>
      turn(direction, options?.animate ?? true, options?.transition, options?.spread),
    canTurnInPlace,
    beginScrub(options) {
      // A scrub starts from a whole page, never from half of a slide or curl.
      settleSlide();
      clearCurlStage();
      scrubBase = strip()?.container.scrollLeft ?? 0;
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
        };
      }
    },
    scrubTo(displacement) {
      const current = strip();
      if (!current) return;
      // A scrub takes over from a slide rather than fighting it for the offset.
      cancelSlide();
      if (scrubCurl) {
        if (displacement === 0) return;
        const dir: TurnDirection = displacement < 0 ? -1 : 1;
        if (!scrubCurl.captured) {
          current.container.scrollLeft = scrubBase;
          scrubCurl.captured = captureOutgoingSpread();
        }
        if (scrubCurl.direction !== dir) {
          current.container.scrollLeft = scrubBase;
          if (canTurnInPlace(dir)) {
            current.container.scrollLeft = scrubBase + dir * current.stride;
          }
          scrubCurl.direction = dir;
        }
        const progress = Math.min(
          Math.max(Math.abs(displacement) / Math.max(current.stride, 1), 0.005),
          0.995,
        );
        scrubCurl.progress = progress;
        applyPaperCurl(scrubCurl.captured ? curlHost : null, curlShadow, progress, dir, {
          spread: scrubCurl.spread,
        });
        return;
      }
      current.container.scrollLeft = scrubBase + displacement;
    },
    endScrub,
    async setReadingMode(mode) {
      if (mode === currentMode) return;
      clearCurlStage();
      currentMode = mode;
      const epoch = beginNavigation();
      const target = pendingTarget ?? currentCfi;
      const wanted = target === undefined ? undefined : book.spine.get(target)?.href;
      pendingTarget = target;
      Reflect.set(
        rendition,
        'location',
        target !== undefined && wanted !== undefined
          ? { start: { href: wanted, cfi: target } }
          : undefined,
      );
      rendition.flow(MODE_FLOW[mode]);
      rendition.spread(spreadFor(mode, currentColumns), 0);
      rendition.clear();
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
      clearCurlStage();
      const before = spreadFor(currentMode, currentColumns);
      currentColumns = columns;
      const after = spreadFor(currentMode, columns);
      if (before === after) return;
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
        const selecting = contentsList().some((contents) => {
          const selection = contents.window.getSelection();
          return selection !== null && !selection.isCollapsed;
        });
        if (selecting) return;
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
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) continue;
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
      // A resize clears epub.js' views. Restore the jump in flight, or the current
      // location, rather than the stale location epub.js last reported (#41).
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
    onGesture(listener) {
      gestureListener = listener;
    },
    onWheel(listener) {
      wheelListener = listener;
    },
    setCursor(cursor) {
      if (cursor === frameCursor) return;
      frameCursor = cursor;
      for (const contents of contentsList()) {
        contents.document.documentElement.style.cursor = cursor;
      }
    },
    destroy() {
      cancelSlide();
      clearCurlStage();
      // The seam hold shadows one method on the manager; leave it as we found it.
      if (seamViews && clearViews) seamViews.clear = clearViews;
      book.destroy();
    },
  };
}
