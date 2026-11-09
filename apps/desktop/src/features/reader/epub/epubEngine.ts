import ePub, { type Contents, type Location, type NavItem } from 'epubjs';

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
  findSubstringMatches,
} from '@/features/reader/DocumentSearch';
import {
  markViewportRect,
  rangeViewportRect,
  type ViewportRect,
} from '@/features/reader/markup/geometry';
import {
  isOverContent,
  type PageGestureSample,
  type WheelSample,
} from '@/features/reader/paging/pageTurn';
import {
  type AnnotationStyle,
  DEFAULT_READING_PREFERENCES,
  type DocumentSource,
  type EpubReadingMode,
  type ReadingPreferences,
} from '@/types/domain';

import { sanitizeChapter } from './sanitizeChapter';

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
}

export interface EpubSelection {
  cfiRange: string;
  chapterHref: string;
  text: string;
}

export interface EpubLocation {
  cfi: string;
  href: string;
  page?: number;
  totalPages?: number;
  chapterIndex?: number;
  totalChapters?: number;
  bookProgress?: number;
  /** Where this page starts in the book, `0..1`, by spine chapter and page. */
  fraction?: number;
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
    options?: { caseSensitive?: boolean },
  ): Promise<readonly EpubSearchMatch[]>;
  /** Shows a CFI or chapter, or the first chapter with no target. Rejects if it cannot. */
  display(target?: string): Promise<void>;
  /** The spine position of a chapter file, or -1. */
  spineIndexOf(href: string): number;
  /** The chapter file at a spine position. */
  spineHref(index: number): string | undefined;
  /**
   * Shows the page holding a point part-way through a chapter's text (`0` its
   * start, `1` its end), whether or not the chapter is rendered.
   */
  displayChapterFraction(index: number, fraction: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setReadingMode(mode: EpubReadingMode): Promise<void>;
  /**
   * How many pages Two pages shows. The viewer decides from the reading measure;
   * other modes always show one.
   */
  setColumns(columns: 1 | 2): void;
  /** `theme` must already be resolved: `auto` renders as Light. */
  setPreferences(preferences: ReadingPreferences): void;
  /** Marks a range; an underline draws only a line under the text. */
  highlight(annotationId: string, cfiRange: string, color: string, style?: AnnotationStyle): void;
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
  const root = chapterDoc.body ?? chapterDoc.documentElement;
  const nodes: { node: Text; start: number; end: number }[] = [];
  let fullText = '';
  if (!root) return { fullText, nodes };
  const walker = chapterDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    const parentTag = textNode.parentElement?.tagName.toLowerCase();
    if (
      parentTag === 'style' ||
      parentTag === 'script' ||
      parentTag === 'noscript' ||
      parentTag === 'title' ||
      textNode.parentElement?.closest('head, style, script, noscript')
    ) {
      continue;
    }
    const value = textNode.data;
    if (!value) continue;
    const start = fullText.length;
    fullText += value;
    nodes.push({ node: textNode, start, end: fullText.length });
  }
  return { fullText, nodes };
}

interface LoadableSection {
  href: string;
  document?: Document;
  contents?: Element;
  load(request: unknown): Promise<Element>;
  unload(): void;
  cfiFromRange(range: Range): string;
}

const toBuffer = async (source: DocumentSource): Promise<ArrayBuffer> => {
  if (source.kind === 'url') return (await fetch(source.url)).arrayBuffer();
  // A copy, because the archive reader may hold on to it after this tab closes.
  return source.bytes.slice().buffer as ArrayBuffer;
};

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
    (book.spine as unknown as { spineItems?: { href: string; canonical?: string }[] }).spineItems ??
    [];
  const resolveTarget = (target?: string): string | undefined => {
    if (!target || target.startsWith('epubcfi(')) return target;
    if (book.spine.get(target)) return target;
    const [rawPath = '', fragment] = target.split('#');
    const cleanPath = rawPath.replace(/^(\.\/|\/)+/, '');
    const matched = spineItems.find(
      (item) =>
        item.href === cleanPath ||
        item.canonical === cleanPath ||
        item.href.endsWith(`/${cleanPath}`) ||
        cleanPath.endsWith(`/${item.href}`),
    );
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
  let keyDownListener: (event: KeyboardEvent) => void = () => undefined;
  let gestureListener: (sample: PageGestureSample) => void = () => undefined;
  let wheelListener: (wheel: WheelSample) => boolean = () => false;
  let markClickListener: (annotationId: string, rect: ViewportRect | null) => void = () =>
    undefined;
  let pointerListener: (down: boolean) => void = () => undefined;
  let frameCursor = '';

  rendition.hooks.content.register((contents: Contents) => {
    contents.document.body?.classList.toggle('epubjs-scrolled', currentMode === 'scroll');
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
      href: location.start.href,
      chapterIndex,
      totalChapters,
      bookProgress,
      fraction: (chapterIndex + pageStart) / totalChapters,
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
    const resolved = resolveTarget(target);
    const epoch = beginNavigation();
    if (resolved?.startsWith('epubcfi(')) currentCfi = resolved;
    // epub.js' resize path re-displays the location it last reported, which lags a
    // jump by a frame; withholding it keeps a resize in that window from restoring
    // the pre-jump page, and `pendingTarget` tells the resize what to show instead.
    pendingTarget = resolved;
    Reflect.set(rendition, 'location', undefined);
    try {
      await (rendition.display(resolved) as unknown as Promise<void>);
      if (epoch !== navigation) return;
      const wanted = resolved === undefined ? undefined : book.spine.get(resolved)?.href;
      if (!wanted) return;
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

  /** Runs `read` on a spine chapter's document, loading it only for the call. */
  const withSection = async <T>(
    index: number,
    read: (section: LoadableSection, chapterDoc: Document) => T,
    fallback: T,
  ): Promise<T> => {
    const section = book.spine.get(index) as unknown as LoadableSection | null;
    if (!section) return fallback;
    const wasLoaded = Boolean(section.document && section.contents);
    if (!wasLoaded) await section.load(book.load.bind(book));
    try {
      return section.document ? read(section, section.document) : fallback;
    } finally {
      if (!wasLoaded) section.unload();
    }
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
          const caseSensitive = options?.caseSensitive ?? false;
          const rawMatches = findSubstringMatches(fullText, query, caseSensitive);
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
    spineIndexOf(href) {
      const clean = (href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');
      if (!clean) return -1;
      return spineItems.findIndex(
        (item) =>
          item.href === clean ||
          item.canonical === clean ||
          item.href.endsWith(`/${clean}`) ||
          clean.endsWith(`/${item.href}`),
      );
    },
    spineHref: (index) => spineItems[index]?.href,
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
          const target = Math.min(Math.floor(fraction * fullText.length), fullText.length - 1);
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
    async next() {
      beginNavigation();
      pendingTarget = undefined;
      if (currentMode === 'scroll') {
        const scroller = element.querySelector<HTMLElement>('.epub-container');
        if (
          scroller &&
          scroller.clientHeight > 0 &&
          scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4
        ) {
          scroller.scrollTop = Math.min(
            scroller.scrollTop + Math.max(Math.floor(scroller.clientHeight * 0.85), 100),
            scroller.scrollHeight - scroller.clientHeight,
          );
          return;
        }
      }
      await (rendition.next() as unknown as Promise<void>);
    },
    async previous() {
      beginNavigation();
      pendingTarget = undefined;
      if (currentMode === 'scroll') {
        const scroller = element.querySelector<HTMLElement>('.epub-container');
        if (scroller && scroller.clientHeight > 0 && scroller.scrollTop > 4) {
          scroller.scrollTop = Math.max(
            scroller.scrollTop - Math.max(Math.floor(scroller.clientHeight * 0.85), 100),
            0,
          );
          return;
        }
      }
      await (rendition.prev() as unknown as Promise<void>);
    },
    async setReadingMode(mode) {
      if (mode === currentMode) return;
      currentMode = mode;
      const epoch = beginNavigation();
      const target = currentCfi;
      pendingTarget = target;
      Reflect.set(rendition, 'location', undefined);
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
      const before = spreadFor(currentMode, currentColumns);
      currentColumns = columns;
      const after = spreadFor(currentMode, columns);
      if (before === after) return;
      // epub.js re-lays out on resize and returns to the current location then.
      rendition.spread(after, 0);
      const target = currentCfi;
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        resizeTo(element.clientWidth, element.clientHeight, target);
      }
      if (target) {
        beginNavigation();
        pendingTarget = undefined;
        void (rendition.display(target) as unknown as Promise<void>).catch(() => undefined);
      }
    },

    setPreferences(preferences) {
      const typographyChanged =
        preferences.fontFamily !== currentPreferences.fontFamily ||
        preferences.fontSize !== currentPreferences.fontSize ||
        preferences.lineSpacing !== currentPreferences.lineSpacing ||
        preferences.justify !== currentPreferences.justify;
      currentPreferences = { ...preferences };
      for (const contents of contentsList()) {
        applyUserPreferencesToDocument(contents.document, currentPreferences, isFixedLayout);
      }
      if (
        typographyChanged &&
        !isFixedLayout &&
        element.clientWidth > 0 &&
        element.clientHeight > 0
      ) {
        const target = currentCfi;
        resizeTo(element.clientWidth, element.clientHeight, target);
        if (target && currentMode !== 'scroll') {
          beginNavigation();
          pendingTarget = undefined;
          void (rendition.display(target) as unknown as Promise<void>).catch(() => undefined);
        }
      }
    },

    highlight(annotationId, cfiRange, color, style = 'highlight') {
      // marks-pane forwards clicks in the frame to the mark under them.
      const onClick = () => {
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
      if (style === 'underline') {
        rendition.annotations.underline(cfiRange, { annotationId }, onClick, 'epub-underline', {
          stroke: color,
          'stroke-opacity': '1',
          'stroke-width': '2',
        });
        return;
      }
      rendition.annotations.highlight(cfiRange, { annotationId }, onClick, 'epub-highlight', {
        fill: color,
        'fill-opacity': '0.4',
        'mix-blend-mode': 'multiply',
      });
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
    resize: (width, height) =>
      // A resize clears epub.js' views. Restore the jump in flight, or the current
      // location, rather than the stale location epub.js last reported (#41).
      resizeTo(width, height, pendingTarget ?? currentCfi),
    onSelection(listener) {
      selectionListener = listener;
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
      book.destroy();
    },
  };
}
