import { describe, expect, it } from 'vitest';

import { type PaintedRange, segmentRow } from '@/features/reader/txt/rowSegments';

const range = (
  annotationId: string,
  startUnit: number,
  endUnit: number,
  hasNote = true,
): PaintedRange => ({
  annotationId,
  color: '#fde047',
  style: 'highlight',
  startUnit,
  endUnit,
  hasNote,
});

const noteEnds = (segments: ReturnType<typeof segmentRow>) =>
  segments.filter((s) => s.endsNote).map((s) => [s.range?.annotationId, s.text]);

describe('segmentRow', () => {
  it('marks the segment where a noted range ends', () => {
    const segments = segmentRow(0, 6, 'hello', [range('a', 1, 3)]);
    expect(segments.map((s) => s.text)).toEqual(['h', 'el', 'lo']);
    expect(noteEnds(segments)).toEqual([['a', 'el']]);
  });

  it('marks a range that ends inside the line terminator, at the next row start', () => {
    // "hello\n" then "world": a triple-click selects 0..6, past the row's text.
    const ranges = [range('a', 0, 6)];
    expect(noteEnds(segmentRow(0, 6, 'hello', ranges))).toEqual([['a', 'hello']]);
    expect(segmentRow(6, 11, 'world', ranges).every((s) => s.range === null)).toBe(true);
  });

  it('marks a range that ends inside a CRLF terminator', () => {
    expect(noteEnds(segmentRow(0, 7, 'hello', [range('a', 2, 7)]))).toEqual([['a', 'llo']]);
  });

  it('marks only the row where a multi-row range ends', () => {
    const ranges = [range('a', 3, 9)];
    expect(noteEnds(segmentRow(0, 6, 'hello', ranges))).toEqual([]);
    expect(noteEnds(segmentRow(6, 12, 'world', ranges))).toEqual([['a', 'wor']]);
  });

  it('moves the marker before a later highlight that covers the noted tail', () => {
    const segments = segmentRow(0, 11, 'hello world', [range('a', 0, 8), range('b', 6, 11, false)]);
    expect(segments.map((s) => [s.range?.annotationId, s.text])).toEqual([
      ['a', 'hello '],
      ['b', 'wo'],
      ['b', 'rld'],
    ]);
    expect(noteEnds(segments)).toEqual([['a', 'hello ']]);
  });

  it('does not mark ranges without a note', () => {
    expect(noteEnds(segmentRow(0, 6, 'hello', [range('a', 0, 5, false)]))).toEqual([]);
  });
});
