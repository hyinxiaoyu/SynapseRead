import { describe, expect, it } from 'vitest';

import {
  charactersPerLine,
  computeReadingLayout,
  MARGIN_PX,
  MAX_MEASURE_CH,
  MIN_MEASURE_CH,
  PAGE_GUTTER_PX,
  singleColumnPage,
} from './measure';

/** 0.5em of 16.8 px: EPUB body text at 100 %, with the fallback character width. */
const CHAR = 8.4;

describe('computeReadingLayout', () => {
  it.each([1280, 1728, 2560])(
    'keeps every column within %i px between the minimum and maximum measure',
    (width) => {
      for (const spread of [true, false]) {
        for (const margins of ['narrow', 'normal', 'wide'] as const) {
          const layout = computeReadingLayout({
            availableWidth: width,
            charWidth: CHAR,
            margins,
            spread,
          });
          const perLine = charactersPerLine(layout.columnWidth, CHAR);
          expect(perLine).toBeGreaterThanOrEqual(MIN_MEASURE_CH);
          expect(perLine).toBeLessThanOrEqual(MAX_MEASURE_CH);
          expect(layout.pageWidth + 2 * layout.padding).toBeLessThanOrEqual(width);
        }
      }
    },
  );

  it.each([320, 1280, 1728, 2560])(
    'uses available width without overflow at %i px',
    (availableWidth) => {
      for (const spread of [true, false]) {
        for (const margins of ['narrow', 'normal', 'wide'] as const) {
          const options = { availableWidth, charWidth: CHAR, margins, spread };
          const standard = computeReadingLayout(options);
          const wide = computeReadingLayout({ ...options, pageWidth: 'wide' });
          const full = computeReadingLayout({ ...options, pageWidth: 'full' });
          expect(wide.pageWidth).toBeGreaterThanOrEqual(standard.pageWidth);
          expect(full.pageWidth).toBeGreaterThanOrEqual(wide.pageWidth);
          expect(full.pageWidth + 2 * full.padding).toBe(availableWidth);
          if (availableWidth === 2560) {
            expect(wide.columnWidth).toBeGreaterThan(standard.columnWidth);
            expect(full.columnWidth).toBeGreaterThan(wide.columnWidth);
          }
        }
      }
    },
  );

  it('shows two pages only when each column holds the minimum measure', () => {
    // Two columns need 2 * (45ch + gutter) plus the margins.
    const threshold = 2 * (MIN_MEASURE_CH * CHAR + PAGE_GUTTER_PX) + 2 * MARGIN_PX.normal;
    const at = (availableWidth: number) =>
      computeReadingLayout({ availableWidth, charWidth: CHAR, margins: 'normal', spread: true });
    expect(at(threshold).columns).toBe(2);
    expect(at(threshold - 1).columns).toBe(1);
    expect(at(1280).columns).toBe(2);
    expect(at(800).columns).toBe(1);
  });

  it('never shows two pages unless asked', () => {
    const layout = computeReadingLayout({
      availableWidth: 2560,
      charWidth: CHAR,
      margins: 'normal',
      spread: false,
    });
    expect(layout.columns).toBe(1);
    expect(layout.pageWidth).toBe(MAX_MEASURE_CH * CHAR + PAGE_GUTTER_PX);
  });

  it('caps the column at the maximum measure for the chosen face advance', () => {
    const at = (charWidth: number) =>
      computeReadingLayout({ availableWidth: 2560, charWidth, margins: 'normal', spread: true });
    expect(at(CHAR).columnWidth).toBe(MAX_MEASURE_CH * CHAR);
    expect(at(CHAR * 1.2).columnWidth).toBeCloseTo(MAX_MEASURE_CH * CHAR * 1.2);
    // A very wide advance in a narrower viewport falls back to one column.
    expect(
      computeReadingLayout({
        availableWidth: 900,
        charWidth: CHAR,
        margins: 'normal',
        spread: true,
      }).columns,
    ).toBe(1);
  });

  it('pads the page by the margin setting, with a 32 px outer margin at the least', () => {
    for (const margins of ['narrow', 'normal', 'wide'] as const) {
      const layout = computeReadingLayout({
        availableWidth: 1728,
        charWidth: CHAR,
        margins,
        spread: true,
      });
      expect(layout.padding).toBe(MARGIN_PX[margins]);
      // Outside the text: the padding plus half the gutter epub.js puts on each edge.
      expect(layout.padding + PAGE_GUTTER_PX / 2).toBeGreaterThanOrEqual(32);
    }
    expect(PAGE_GUTTER_PX).toBeGreaterThanOrEqual(48);
    expect(MARGIN_PX.normal + PAGE_GUTTER_PX / 2).toBeGreaterThanOrEqual(32);
  });

  it('degrades to an empty single column with no room', () => {
    expect(
      computeReadingLayout({ availableWidth: 0, charWidth: CHAR, margins: 'wide', spread: true }),
    ).toEqual({ columns: 1, columnWidth: 0, pageWidth: 0, padding: MARGIN_PX.wide });
  });
});

describe('singleColumnPage', () => {
  it('widens scrolling text independently of margins and removes the cap at full width', () => {
    for (const margins of ['narrow', 'normal', 'wide'] as const) {
      const standard = singleColumnPage(CHAR, margins);
      const wide = singleColumnPage(CHAR, margins, 'wide');
      const full = singleColumnPage(CHAR, margins, 'full');
      expect(wide.maxWidth).toBeGreaterThan(standard.maxWidth);
      expect(full.maxWidth).toBe(Number.POSITIVE_INFINITY);
      expect(full.sidePadding).toBe(standard.sidePadding);
      expect(wide.sidePadding).toBe(standard.sidePadding);
    }
  });
  it('caps a scrolling column at the maximum measure, with the paginated outer margin', () => {
    const page = singleColumnPage(CHAR, 'normal');
    expect(page.sidePadding).toBe(PAGE_GUTTER_PX / 2 + MARGIN_PX.normal);
    expect(charactersPerLine(page.maxWidth - 2 * page.sidePadding, CHAR)).toBe(MAX_MEASURE_CH);
  });
});
