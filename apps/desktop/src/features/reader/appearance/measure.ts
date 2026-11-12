import type { ReadingMargins, ReadingPageWidth } from '@/types/domain';

/**
 * The reading measure: characters per line. Below the minimum, two pages give
 * way to one; above the selected maximum, the column stops growing and the page centers.
 */
export const MIN_MEASURE_CH = 45;
export const MAX_MEASURE_CH = 75;

const PAGE_MEASURE_CH: Record<ReadingPageWidth, number> = {
  standard: MAX_MEASURE_CH,
  wide: 110,
  full: Number.POSITIVE_INFINITY,
};

/** The average advance of body text, in em, where the face cannot be measured. */
export const FALLBACK_CHAR_WIDTH_EM = 0.5;

/**
 * The paginated gap epub.js puts between two pages, half of it on each outer
 * edge. It is the spine gutter, so it never drops below 48 px.
 */
export const PAGE_GUTTER_PX = 64;

/**
 * Page padding outside the text, on top of half the gutter. At the default
 * (normal) the outer margin is 16 + 32 = 48 px.
 */
export const MARGIN_PX: Record<ReadingMargins, number> = {
  narrow: 0,
  normal: 16,
  wide: 56,
};

/** EPUB body text is `1.05rem` at 100 %; see `epubEngine.ts`. */
export const EPUB_BASE_FONT_REM = 1.05;

export interface ReadingLayout {
  columns: 1 | 2;
  /** Width of each text column, in px. */
  columnWidth: number;
  /** Width the paginated renderer gets: the columns and their gutters. */
  pageWidth: number;
  /** Padding on each side of the page, inside the available width. */
  padding: number;
}

/**
 * Lays out a reflowable page: two columns only where each holds at least
 * `MIN_MEASURE_CH` at the face's base (100%) size, with the user-selected
 * column cap. Mirrors epub.js, where each page is its column plus one gutter.
 *
 * `charWidth` is measured at the 100% base size rather than the scaled
 * `fontSize`, so adjusting font size changes glyph size and line wrapping
 * without altering page width or column count.
 */
export function computeReadingLayout({
  availableWidth,
  charWidth,
  margins,
  spread,
  pageWidth = 'standard',
}: {
  availableWidth: number;
  /** Average character advance of the chosen face at 100% base size, in px. */
  charWidth: number;
  margins: ReadingMargins;
  pageWidth?: ReadingPageWidth;
  /** Whether the reader asked for two pages. */
  spread: boolean;
}): ReadingLayout {
  const padding = MARGIN_PX[margins];
  const inner = Math.max(0, availableWidth - 2 * padding);
  const minColumn = MIN_MEASURE_CH * charWidth;
  const maxColumn = PAGE_MEASURE_CH[pageWidth] * charWidth;
  const twoUpColumn = inner / 2 - PAGE_GUTTER_PX;
  const columns: 1 | 2 = spread && twoUpColumn >= minColumn ? 2 : 1;
  const fitted = columns === 2 ? twoUpColumn : inner - PAGE_GUTTER_PX;
  const columnWidth = Math.max(0, Math.min(maxColumn, fitted));
  return {
    columns,
    columnWidth,
    pageWidth: Math.min(inner, columns * (columnWidth + PAGE_GUTTER_PX)),
    padding,
  };
}

/**
 * A scrolling page of one column (TXT): the same outer margin a paginated page
 * has, with the selected column cap (unbounded at Full width).
 */
export function singleColumnPage(
  charWidth: number,
  margins: ReadingMargins,
  pageWidth: ReadingPageWidth = 'standard',
): { maxWidth: number; sidePadding: number } {
  const sidePadding = PAGE_GUTTER_PX / 2 + MARGIN_PX[margins];
  return {
    maxWidth:
      pageWidth === 'full'
        ? Number.POSITIVE_INFINITY
        : PAGE_MEASURE_CH[pageWidth] * charWidth + 2 * sidePadding,
    sidePadding,
  };
}

/** Characters a column of `columnWidth` holds. */
export function charactersPerLine(columnWidth: number, charWidth: number): number {
  return charWidth > 0 ? columnWidth / charWidth : 0;
}

// Letter frequencies close to running English prose, spaces and punctuation included.
const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog, and then reads a chapter or two of a good book.';
const charWidthCache = new Map<string, number>();

/**
 * The average character advance of `fontFamily` at `fontSizePx`, measured once
 * per face and size. Falls back to `FALLBACK_CHAR_WIDTH_EM` where no canvas is
 * available (tests) or the face cannot be measured.
 */
export function measureCharWidth(fontFamily: string, fontSizePx: number): number {
  const key = `${fontSizePx}px ${fontFamily}`;
  const cached = charWidthCache.get(key);
  if (cached !== undefined) return cached;
  let width = fontSizePx * FALLBACK_CHAR_WIDTH_EM;
  if (typeof OffscreenCanvas === 'function') {
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    if (context) {
      context.font = key;
      const measured = context.measureText(SAMPLE_TEXT).width / SAMPLE_TEXT.length;
      if (Number.isFinite(measured) && measured > 0) width = measured;
    }
  }
  charWidthCache.set(key, width);
  return width;
}

/** The root font size in px; 16 where the document has none. */
export function rootFontSizePx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}
