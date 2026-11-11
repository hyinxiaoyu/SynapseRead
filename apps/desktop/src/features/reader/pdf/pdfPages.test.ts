import { describe, expect, it } from 'vitest';

import {
  normalizePageLabels,
  pageLabelOf,
  pagesInSpread,
  resolvePageInput,
  spreadCount,
  spreadOfPage,
} from './pdfPages';

const spreads = (pageCount: number, cover: boolean) =>
  Array.from({ length: spreadCount(pageCount, cover) }, (_, spread) =>
    pagesInSpread(spread, pageCount, cover),
  );

describe('Two Pages spreads', () => {
  it('pairs from the first page by default', () => {
    expect(spreads(5, false)).toEqual([[0, 1], [2, 3], [4]]);
    expect(spreads(4, false)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('shows the cover alone, then 2-3, 4-5', () => {
    expect(spreads(5, true)).toEqual([[0], [1, 2], [3, 4]]);
    expect(spreads(6, true)).toEqual([[0], [1, 2], [3, 4], [5]]);
    expect(spreads(1, true)).toEqual([[0]]);
    expect(spreads(0, true)).toEqual([]);
  });

  it('finds the spread of every page', () => {
    for (const cover of [false, true]) {
      for (const pageCount of [1, 2, 5, 6]) {
        spreads(pageCount, cover).forEach((pages, spread) => {
          for (const page of pages) expect(spreadOfPage(page, cover)).toBe(spread);
        });
      }
    }
  });

  it('has no pages outside the document', () => {
    expect(pagesInSpread(3, 5, true)).toEqual([]);
    expect(pagesInSpread(-1, 5, false)).toEqual([]);
  });
});

describe('page labels', () => {
  const labels = normalizePageLabels(['i', 'ii', '1', '2', '3', 'A-1'], 6);

  it('keeps labels only when they differ from the page numbers', () => {
    expect(labels).toEqual(['i', 'ii', '1', '2', '3', 'A-1']);
    expect(normalizePageLabels(['1', '2', '3'], 3)).toBeNull();
    expect(normalizePageLabels(null, 3)).toBeNull();
    // pdf.js reports a label per page; anything else cannot be trusted.
    expect(normalizePageLabels(['i', 'ii'], 3)).toBeNull();
    // An unlabelled page shows its number.
    expect(normalizePageLabels(['Cover', '', ' '], 3)).toEqual(['Cover', '2', '3']);
  });

  it('shows the label, or the page number without labels', () => {
    expect(pageLabelOf(labels, 1)).toBe('ii');
    expect(pageLabelOf(null, 1)).toBe('2');
  });

  it('jumps by printed label first', () => {
    expect(resolvePageInput('2', labels, 6)).toBe(3);
    expect(resolvePageInput(' ii ', labels, 6)).toBe(1);
    expect(resolvePageInput('II', labels, 6)).toBe(1);
    expect(resolvePageInput('a-1', labels, 6)).toBe(5);
  });

  it('jumps by physical page with # or parentheses, or by number without labels', () => {
    expect(resolvePageInput('#2', labels, 6)).toBe(1);
    expect(resolvePageInput('(2)', labels, 6)).toBe(1);
    expect(resolvePageInput('#6', labels, 6)).toBe(5);
    expect(resolvePageInput('4', null, 6)).toBe(3);
  });

  it('rejects a number no label claims, rather than reading it as a physical page', () => {
    // Physical page 5 is printed 3; reading 5 as that page would put two inputs on it.
    expect(resolvePageInput('5', labels, 6)).toBeNull();
    expect(resolvePageInput('6', labels, 6)).toBeNull();
  });

  it('picks the nearest of duplicate labels, going forward on a tie', () => {
    // Two sections that each restart at 1.
    const sections = normalizePageLabels(['1', '2', '3', '1', '2', '3', '4'], 7);
    expect(resolvePageInput('2', sections, 7, 0)).toBe(1);
    expect(resolvePageInput('2', sections, 7, 5)).toBe(4);
    expect(resolvePageInput('1', sections, 7, 6)).toBe(3);
    expect(resolvePageInput('3', sections, 7, 4)).toBe(5);
    // Index 1 is equally far from both 1s: forward wins.
    expect(resolvePageInput('1', ['1', 'x', '1'], 3, 1)).toBe(2);
  });

  it('rejects what matches nothing', () => {
    for (const input of ['', '  ', 'iv', '7', '#0', '(9)', '2.5', '-1']) {
      expect(resolvePageInput(input, labels, 6)).toBeNull();
    }
    expect(resolvePageInput('0', null, 6)).toBeNull();
  });
});
