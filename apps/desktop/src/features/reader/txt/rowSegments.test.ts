import { describe, expect, it } from 'vitest';

import { paint, type PaintedRange, segmentRow } from '@/features/reader/txt/rowSegments';
import { TxtTextModel } from '@/features/reader/txt/textModel';
import { streamUtf8Lossy } from '@/lib/backend/memoryTextStream';
import type { ReaderHighlight } from '@/types/domain';

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

describe('paint', () => {
  const modelOf = (source: string) => {
    const model = new TxtTextModel();
    streamUtf8Lossy(new TextEncoder().encode(source), 64 * 1024, (chunk) => model.append(chunk));
    return model;
  };
  const noted = (startByteOffset: number, endByteOffset: number): ReaderHighlight => ({
    annotationId: 'a',
    anchor: { format: 'txt', startByteOffset, endByteOffset, lineIndex: 0 },
    color: '#fde047',
    hasNote: true,
  });
  const rows = (model: TxtTextModel, ranges: readonly PaintedRange[]) =>
    Array.from({ length: model.rowCount }, (_, row) =>
      noteEnds(
        segmentRow(model.rowStart(row), model.rowStart(row + 1), model.rowText(row), ranges),
      ),
    );

  it('marks the end of the text when a drag crosses a blank line to the next row start', () => {
    // Rows: "first" 0..6, "" 6..7, "second" 7..13. The drag ends at byte 7, the
    // start of "second", so the blank row and the terminators carry no text.
    const model = modelOf('first\n\nsecond\n');
    const ranges = paint(model, [noted(2, 7)]);
    expect(ranges[0]).toMatchObject({ startUnit: 2, endUnit: 7, markerEnd: 5 });
    expect(rows(model, ranges)).toEqual([[['a', 'rst']], [], [], []]);
  });

  it('marks the end of the text across CRLF blank lines too', () => {
    const model = modelOf('first\r\n\r\n\r\nsecond');
    expect(rows(model, paint(model, [noted(0, 11)]))).toEqual([[['a', 'first']], [], [], []]);
  });

  it('leaves a range that ends inside text as it is', () => {
    const model = modelOf('first\n\nsecond\n');
    const ranges = paint(model, [noted(2, 10)]);
    expect(ranges[0]?.markerEnd).toBe(10);
    expect(rows(model, ranges)).toEqual([[], [], [['a', 'sec']], []]);
  });
});
