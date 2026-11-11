import type { AnnotationStyle } from '@/types/domain';

export interface PaintedRange {
  annotationId: string;
  color: string;
  style: AnnotationStyle;
  startUnit: number;
  endUnit: number;
  hasNote?: boolean;
}

export interface Segment {
  unit: number;
  text: string;
  range: PaintedRange | null;
  /** This segment carries the range's note marker. */
  endsNote: boolean;
}

/**
 * Cuts a row at highlight edges. The last highlight painted over a character wins.
 *
 * `nextRowStart` is where the following row begins. A range can end past the row's
 * text, inside its line terminator (a triple-click or a drag to the next line), and
 * it still ends in this row as long as it stops at or before `nextRowStart`.
 *
 * A noted range's marker goes on the last segment it still wins in the row where it
 * ends, so a later highlight covering its tail moves the marker, not removes it.
 */
export function segmentRow(
  rowStart: number,
  nextRowStart: number,
  text: string,
  ranges: readonly PaintedRange[],
): Segment[] {
  const rowEnd = rowStart + text.length;
  const overlapping = ranges.filter((r) => r.startUnit < rowEnd && r.endUnit > rowStart);
  if (overlapping.length === 0) return [{ unit: rowStart, text, range: null, endsNote: false }];

  const edges = new Set([rowStart, rowEnd]);
  for (const range of overlapping) {
    if (range.startUnit > rowStart) edges.add(range.startUnit);
    if (range.endUnit < rowEnd) edges.add(range.endUnit);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const start = sorted[index] as number;
    const end = sorted[index + 1] as number;
    segments.push({
      unit: start,
      text: text.slice(start - rowStart, end - rowStart),
      range: overlapping.findLast((r) => r.startUnit <= start && r.endUnit >= end) ?? null,
      endsNote: false,
    });
  }

  const marked = new Set<PaintedRange>();
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as Segment;
    const { range } = segment;
    if (!range?.hasNote || range.endUnit > nextRowStart || marked.has(range)) continue;
    segment.endsNote = true;
    marked.add(range);
  }
  return segments;
}
