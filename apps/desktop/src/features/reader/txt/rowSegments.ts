import type { TxtTextModel } from '@/features/reader/txt/textModel';
import type { AnnotationStyle, ReaderHighlight, TxtAnchor } from '@/types/domain';

export interface PaintedRange {
  annotationId: string;
  color: string;
  style: AnnotationStyle;
  startUnit: number;
  endUnit: number;
  hasNote?: boolean;
  /**
   * Where a noted range's marker goes: the end of its last row with text. Past
   * that, a range can run on over line terminators and blank rows, which have no
   * segment to carry it. Defaults to `endUnit`.
   */
  markerEnd?: number;
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
 * its marker still belongs to this row as long as its `markerEnd` stops at or
 * before `nextRowStart`.
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
    if (!range?.hasNote || (range.markerEnd ?? range.endUnit) > nextRowStart) continue;
    if (marked.has(range)) continue;
    segment.endsNote = true;
    marked.add(range);
  }
  return segments;
}

type RowSource = Pick<TxtTextModel, 'rowAtUnit' | 'rowStart' | 'rowText'>;

/**
 * The end of the last row with text inside `[startUnit, endUnit)`. A drag across a
 * blank line to the next paragraph ends at that paragraph's row start, past a row
 * with no text at all; the marker belongs at the end of the text before it.
 */
export function noteMarkerEnd(model: RowSource, startUnit: number, endUnit: number): number {
  for (let row = model.rowAtUnit(endUnit); row >= 0; row -= 1) {
    const rowStart = model.rowStart(row);
    const end = Math.min(endUnit, rowStart + model.rowText(row).length);
    if (end > Math.max(rowStart, startUnit)) return end;
    if (rowStart <= startUnit) break;
  }
  return endUnit;
}

export const asTxtAnchor = (anchor: { format: string } | null | undefined): TxtAnchor | null =>
  anchor?.format === 'txt' ? (anchor as TxtAnchor) : null;

/** The highlights that fall in the loaded text, in units, ready for {@link segmentRow}. */
export function paint(model: TxtTextModel, highlights: readonly ReaderHighlight[]): PaintedRange[] {
  const ranges: PaintedRange[] = [];
  for (const { annotationId, anchor, color, style = 'highlight', hasNote } of highlights) {
    const txtAnchor = asTxtAnchor(anchor);
    const range = txtAnchor && model.rangeFor(txtAnchor);
    if (!range) continue;
    ranges.push({
      annotationId,
      color,
      style,
      hasNote: hasNote === true,
      ...range,
      ...(hasNote ? { markerEnd: noteMarkerEnd(model, range.startUnit, range.endUnit) } : {}),
    });
  }
  return ranges;
}
