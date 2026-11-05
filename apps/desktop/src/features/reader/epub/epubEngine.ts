import ePub, { type Contents, type Location } from 'epubjs';

import type { DocumentSource } from '@/types/domain';

import { sanitizeChapter } from './sanitizeChapter';

export interface EpubSelection {
  cfiRange: string;
  chapterHref: string;
  text: string;
}

export interface EpubLocation {
  cfi: string;
  href: string;
}

/** The whole of what the reader needs from epub.js; nothing else imports it. */
export interface EpubHandle {
  /** Shows a CFI or chapter, or the first chapter with no target. Rejects if it cannot. */
  display(target?: string): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  highlight(annotationId: string, cfiRange: string, color: string): void;
  removeHighlight(cfiRange: string): void;
  /** Whether a highlight's marks are on screen; the marks draw after `display` resolves. */
  setPulse(annotationId: string, pulsing: boolean): boolean;
  clearSelection(): void;
  resize(width: number, height: number): void;
  onSelection(listener: (selection: EpubSelection | null) => void): void;
  onLocation(listener: (location: EpubLocation) => void): void;
  destroy(): void;
}

const toBuffer = async (source: DocumentSource): Promise<ArrayBuffer> => {
  if (source.kind === 'url') return (await fetch(source.url)).arrayBuffer();
  // A copy, because the archive reader may hold on to it after this tab closes.
  return source.bytes.slice().buffer as ArrayBuffer;
};

export async function openEpubDocument(
  source: DocumentSource,
  element: HTMLElement,
): Promise<EpubHandle> {
  const book = ePub(await toBuffer(source));
  await book.ready;
  book.spine.hooks.content.register(sanitizeChapter);

  const rendition = book.renderTo(element, {
    flow: 'scrolled-doc',
    width: '100%',
    height: '100%',
    spread: 'none',
    // Without this, WebKit never fires the listeners epub.js needs: see
    // `docs/adr/0005-epub-sandbox.md`, which also covers why it is safe here.
    allowScriptedContent: true,
  });

  let selectionListener: (selection: EpubSelection | null) => void = () => undefined;
  let locationListener: (location: EpubLocation) => void = () => undefined;

  rendition.hooks.content.register((contents: Contents) => {
    // `selected` only reports new selections, not one that has been cleared.
    contents.document.addEventListener('selectionchange', () => {
      const selection = contents.window.getSelection();
      if (!selection || selection.isCollapsed) selectionListener(null);
    });
  });
  rendition.on('selected', (cfiRange: string, contents: Contents) => {
    const text = contents.window.getSelection()?.toString().trim() ?? '';
    const chapterHref = book.spine.get(cfiRange)?.href;
    // Core refuses an excerpt of only whitespace.
    selectionListener(text && chapterHref ? { cfiRange, chapterHref, text } : null);
  });
  rendition.on('relocated', (location: Location) =>
    locationListener({ cfi: location.start.cfi, href: location.start.href }),
  );

  const contentsList = () => rendition.getContents() as unknown as Contents[];

  return {
    display: (target) => rendition.display(target) as unknown as Promise<void>,
    next: () => rendition.next() as unknown as Promise<void>,
    previous: () => rendition.prev() as unknown as Promise<void>,

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
    destroy() {
      book.destroy();
    },
  };
}
