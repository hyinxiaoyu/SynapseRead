import ePub, { type Contents, type Location } from 'epubjs';

import type { DocumentSource } from '@/types/domain';

import { sanitizeChapter } from './sanitizeChapter';

export type EpubReadingMode = 'spread' | 'paged' | 'scroll';

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
}

/** The whole of what the reader needs from epub.js; nothing else imports it. */
export interface EpubHandle {
  /** Shows a CFI or chapter, or the first chapter with no target. Rejects if it cannot. */
  display(target?: string): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setReadingMode(mode: EpubReadingMode): Promise<void>;
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

const MODE_LAYOUT: Record<
  EpubReadingMode,
  { flow: 'paginated' | 'scrolled-doc'; spread: 'auto' | 'none' }
> = {
  spread: { flow: 'paginated', spread: 'auto' },
  paged: { flow: 'paginated', spread: 'none' },
  scroll: { flow: 'scrolled-doc', spread: 'none' },
};

const BOOK_TYPOGRAPHY_CSS = `
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
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

const toBuffer = async (source: DocumentSource): Promise<ArrayBuffer> => {
  if (source.kind === 'url') return (await fetch(source.url)).arrayBuffer();
  // A copy, because the archive reader may hold on to it after this tab closes.
  return source.bytes.slice().buffer as ArrayBuffer;
};

export async function openEpubDocument(
  source: DocumentSource,
  element: HTMLElement,
  initialMode: EpubReadingMode = 'spread',
): Promise<EpubHandle> {
  const book = ePub(await toBuffer(source));
  await book.ready;
  book.spine.hooks.content.register(sanitizeChapter);
  book.spine.hooks.content.register(applyBookTypography);

  let currentMode: EpubReadingMode = initialMode;
  let currentCfi: string | undefined;
  const initialLayout = MODE_LAYOUT[currentMode];

  const rendition = book.renderTo(element, {
    flow: initialLayout.flow,
    width: '100%',
    height: '100%',
    spread: initialLayout.spread,
    minSpreadWidth: MIN_SPREAD_WIDTH,
    // Without this, WebKit never fires the listeners epub.js needs: see
    // `docs/adr/0005-epub-sandbox.md`, which also covers why it is safe here.
    allowScriptedContent: true,
  });

  let selectionListener: (selection: EpubSelection | null) => void = () => undefined;
  let locationListener: (location: EpubLocation) => void = () => undefined;
  let keyDownListener: (event: KeyboardEvent) => void = () => undefined;

  rendition.hooks.content.register((contents: Contents) => {
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
    locationListener({
      cfi: location.start.cfi,
      href: location.start.href,
      ...(displayed ? { page: displayed.page, totalPages: displayed.total } : {}),
    });
  });

  const contentsList = () => rendition.getContents() as unknown as Contents[];

  return {
    async display(target) {
      if (target) currentCfi = target;
      await (rendition.display(target) as unknown as Promise<void>);
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
