import { describe, expect, it } from 'vitest';

import type { TxtHeading } from './textModel';
import { chapterAt, chapterStartRows, headingId, headingIndexAt, headingOutline } from './chapters';

const heading = (row: number, label: string, level: 0 | 1, joined = false): TxtHeading => ({
  row,
  startByte: row * 10,
  label,
  level,
  joined,
});

const headings = [
  heading(4, 'Chapter 1', 1),
  heading(20, 'Part Two', 0),
  heading(22, 'Chapter 2', 1, true),
  heading(40, 'Chapter 3', 1),
];

describe('TXT chapters', () => {
  it('nests chapters under the part before them, with source bytes as targets', () => {
    expect(headingOutline(headings)).toEqual([
      { id: 'txt-heading-40', label: 'Chapter 1', target: 40, children: [] },
      {
        id: 'txt-heading-200',
        label: 'Part Two',
        target: 200,
        children: [
          { id: 'txt-heading-220', label: 'Chapter 2', target: 220, children: [] },
          { id: 'txt-heading-400', label: 'Chapter 3', target: 400, children: [] },
        ],
      },
    ]);
    expect(headingId(headings[0] as TxtHeading)).toBe('txt-heading-40');
  });

  it('finds the heading a row is under', () => {
    expect(headingIndexAt(headings, 0)).toBe(-1);
    expect(headingIndexAt(headings, 4)).toBe(0);
    expect(headingIndexAt(headings, 21)).toBe(1);
    expect(headingIndexAt(headings, 22)).toBe(2);
    expect(headingIndexAt(headings, 1000)).toBe(3);
    expect(headingIndexAt([], 5)).toBe(-1);
  });

  it('starts a chapter at the front matter and at each heading not joined to another', () => {
    const starts = chapterStartRows(headings);
    expect(starts).toEqual([0, 4, 20, 40]);
    expect(chapterAt(starts, 0)).toBe(0);
    expect(chapterAt(starts, 22)).toBe(2);
    expect(chapterAt(starts, 39)).toBe(2);
    expect(chapterStartRows([heading(0, 'Chapter 1', 1)])).toEqual([0]);
    expect(chapterStartRows([])).toEqual([]);
  });
});
