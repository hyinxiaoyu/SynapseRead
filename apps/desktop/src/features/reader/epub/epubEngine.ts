import ePub, { type Contents, type Location, type NavItem } from 'epubjs';

import {
  buildSearchSnippet,
  type DocumentSearchResultItem,
  findSubstringMatches,
} from '@/features/reader/DocumentSearchBar';
import {
  DEFAULT_READING_PREFERENCES,
  type DocumentSource,
  type EpubReadingMode,
  type ReadingFontFamily,
  type ReadingPreferences,
  type ReadingTheme,
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
  next(): Promise<void>;
  previous(): Promise<void>;
  setReadingMode(mode: EpubReadingMode): Promise<void>;
  setPreferences(preferences: ReadingPreferences): void;
  highlight(annotationId: string, cfiRange: string, color: string): void;
  removeHighlight(cfiRange: string): void;
  /** Whether a highlight's marks are on screen; the marks draw after `display` resolves. */
  setPulse(annotationId: string, pulsing: boolean): boolean;
  clearSelection(): void;
  resize(width: number, height: number): void;
  onSelection(listener: (selection: EpubSelection | null) => void): void;
  onLocation(listener: (location: EpubLocation) => void): void;
  onKeyDown(listener: (event: KeyboardEvent) => void): void;
  destroy(): void;
}

const MIN_SPREAD_WIDTH = 640;
/**
 * Default column/page gutter in pixels for paginated EPUB layouts.
 * epub.js otherwise defaults to `Math.floor(width / 12)` (~150px+ on wide viewports),
 * which wastes horizontal screen space in full-screen reading.
 */
const PAGINATED_GAP_PX = 48;
/** Horizontal padding inside scrolled chapters (epub.js defaults to `width / 12` per side). */
const SCROLLED_HORIZONTAL_PADDING = 'clamp(24px, 4vw, 56px)';

const MODE_LAYOUT: Record<
  EpubReadingMode,
  { flow: 'paginated' | 'scrolled-doc'; spread: 'auto' | 'none' }
> = {
  spread: { flow: 'paginated', spread: 'auto' },
  paged: { flow: 'paginated', spread: 'none' },
  scroll: { flow: 'scrolled-doc', spread: 'none' },
};

const THEME_COLORS: Record<ReadingTheme, { background: string; text: string; border: string }> = {
  light: { background: '#fbfaf7', text: '#1c1917', border: 'rgba(28, 25, 23, 0.2)' },
  sepia: { background: '#f4ecd8', text: '#433422', border: 'rgba(67, 52, 34, 0.25)' },
  dark: { background: '#18181b', text: '#e4e4e7', border: 'rgba(228, 228, 231, 0.25)' },
};

const FONT_STACKS: Record<ReadingFontFamily, string> = {
  serif:
    "Charter, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', 'PingFang SC', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'PingFang SC', monospace",
};

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
  font-family: Charter, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', 'PingFang SC', serif;
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
  const palette = THEME_COLORS[preferences.theme];
  if (isFixedLayout) {
    return `
html, body {
  background-color: ${palette.background};
}
`;
  }
  const fontStack = FONT_STACKS[preferences.fontFamily];
  const fontRem = ((1.05 * preferences.fontSize) / 100).toFixed(3);
  const lineSpacing = preferences.lineSpacing.toFixed(2);
  return `
html, body {
  background-color: ${palette.background} !important;
  color: ${palette.text} !important;
}
body {
  font-family: ${fontStack} !important;
  font-size: ${fontRem}rem !important;
  line-height: ${lineSpacing} !important;
}
p, li, dd, dt, blockquote {
  font-family: inherit !important;
  line-height: ${lineSpacing} !important;
}
a {
  color: inherit;
}
blockquote {
  border-left-color: ${palette.border} !important;
}
`;
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
): Promise<EpubHandle> {
  const book = ePub(await toBuffer(source));
  await book.ready;
  const metadataLayout = (
    book.packaging as unknown as { metadata?: { layout?: string } } | undefined
  )?.metadata?.layout;
  const isFixedLayout = metadataLayout === 'pre-paginated';
  let currentPreferences: ReadingPreferences = { ...initialPreferences };

  book.spine.hooks.content.register(sanitizeChapter);
  if (!isFixedLayout) {
    book.spine.hooks.content.register(applyBookTypography);
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
  let currentCfi: string | undefined;
  const initialLayout = MODE_LAYOUT[currentMode];

  const rendition = book.renderTo(element, {
    flow: initialLayout.flow,
    width: '100%',
    height: '100%',
    spread: initialLayout.spread,
    minSpreadWidth: MIN_SPREAD_WIDTH,
    gap: PAGINATED_GAP_PX,
    // Without this, WebKit never fires the listeners epub.js needs: see
    // `docs/adr/0005-epub-sandbox.md`, which also covers why it is safe here.
    allowScriptedContent: true,
  } as Parameters<typeof book.renderTo>[1] & { gap: number });

  let selectionListener: (selection: EpubSelection | null) => void = () => undefined;
  let locationListener: (location: EpubLocation) => void = () => undefined;
  let keyDownListener: (event: KeyboardEvent) => void = () => undefined;

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
    locationListener({
      cfi: location.start.cfi,
      href: location.start.href,
      chapterIndex,
      totalChapters,
      bookProgress,
      ...(displayed ? { page: displayed.page, totalPages: displayed.total } : {}),
    });
  });

  const contentsList = () => rendition.getContents() as unknown as Contents[];

  return {
    toc,
    isFixedLayout,
    chapterCount: spineItems.length,
    async searchChapter(chapterIndex, query, options) {
      if (query.trim() === '') return [];
      const section = book.spine.get(chapterIndex) as unknown as {
        href: string;
        document?: Document;
        contents?: Element;
        load(request: unknown): Promise<Element>;
        unload(): void;
        cfiFromRange(range: Range): string;
      } | null;
      if (!section) return [];
      const wasLoaded = Boolean(section.document && section.contents);
      if (!wasLoaded) {
        await section.load(book.load.bind(book));
      }
      try {
        const chapterDoc = section.document;
        const root = chapterDoc?.body ?? chapterDoc?.documentElement;
        if (!chapterDoc || !root) return [];

        const walker = chapterDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let fullText = '';
        const nodes: { node: Text; start: number; end: number }[] = [];
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
          const end = fullText.length;
          nodes.push({ node: textNode, start, end });
        }

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
      } finally {
        if (!wasLoaded) {
          section.unload();
        }
      }
    },
    async display(target) {
      const resolved = resolveTarget(target);
      if (resolved?.startsWith('epubcfi(')) currentCfi = resolved;
      await (rendition.display(resolved) as unknown as Promise<void>);
    },
    async next() {
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
      const layout = MODE_LAYOUT[mode];
      const target = currentCfi;
      Reflect.set(rendition, 'location', undefined);
      rendition.flow(layout.flow);
      rendition.spread(layout.spread, MIN_SPREAD_WIDTH);
      rendition.clear();
      await (rendition.display(target) as unknown as Promise<void>).catch(
        () => rendition.display() as unknown as Promise<void>,
      );
    },

    setPreferences(preferences) {
      const typographyChanged =
        preferences.fontFamily !== currentPreferences.fontFamily ||
        preferences.fontSize !== currentPreferences.fontSize ||
        preferences.lineSpacing !== currentPreferences.lineSpacing;
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
        rendition.resize(element.clientWidth, element.clientHeight);
        if (target && currentMode !== 'scroll') {
          void (rendition.display(target) as unknown as Promise<void>).catch(() => undefined);
        }
      }
    },

    highlight(annotationId, cfiRange, color) {
      rendition.annotations.highlight(cfiRange, { annotationId }, undefined, 'epub-highlight', {
        fill: color,
        'fill-opacity': '0.4',
        'mix-blend-mode': 'multiply',
      });
    },
    removeHighlight: (cfiRange) => rendition.annotations.remove(cfiRange, 'highlight'),

    setPulse(annotationId, pulsing) {
      const marks = element.querySelectorAll(`[data-annotation-id="${CSS.escape(annotationId)}"]`);
      for (const mark of marks) mark.classList.toggle('anchor-pulse', pulsing);
      return marks.length > 0;
    },

    clearSelection() {
      for (const contents of contentsList()) contents.window.getSelection()?.removeAllRanges();
    },
    resize: (width, height) => rendition.resize(width, height),
    onSelection(listener) {
      selectionListener = listener;
    },
    onLocation(listener) {
      locationListener = listener;
    },
    onKeyDown(listener) {
      keyDownListener = listener;
    },
    destroy() {
      book.destroy();
    },
  };
}
