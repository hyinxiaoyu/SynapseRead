import {
  buildSearchSnippet,
  type DocumentSearchResultItem,
  findSubstringMatches,
} from '@/features/reader/DocumentSearch';
import type { SourceSpan, TextChunk, TxtAnchor } from '@/types/domain';

export interface TxtSearchMatch extends DocumentSearchResultItem {
  anchor: TxtAnchor;
  startUnit: number;
  endUnit: number;
  rowIndex: number;
  lineNumber: number;
}

/**
 * Longest row, in UTF-16 units. A file with one enormous line would otherwise
 * defeat line virtualization, so long lines render as several adjacent rows.
 */
export const MAX_ROW_UNITS = 4096;

interface ModelChunk {
  text: string;
  startUnit: number;
  startByte: number;
  endByte: number;
  startLine: number;
  spans: SourceSpan[];
}

export type Rounding = 'down' | 'up';

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Encoded size of the code point at `index`, and the UTF-16 units it occupies. */
function codePointAt(text: string, index: number): { utf8: number; units: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { utf8: 1, units: 1 };
  if (code < 0x800) return { utf8: 2, units: 1 };
  if (isHighSurrogate(code)) return { utf8: 4, units: 2 };
  return { utf8: 3, units: 1 };
}

/** Index of the last entry whose key is `<= value`; the first entry is the floor. */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (key(items[middle] as T) <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The decoded text of a TXT document as it streams in.
 *
 * Positions are "units": UTF-16 offsets into the concatenation of all chunks,
 * which is what DOM selections report. This class is the only place units and
 * source bytes convert into each other: see `docs/adr/0002-txt-anchor-drift.md`.
 */
export class TxtTextModel {
  private readonly chunks: ModelChunk[] = [];
  private readonly rowStarts: number[] = [0];
  private units = 0;
  private endByte = 0;

  complete = false;
  hadReplacements = false;

  /** Appends the next chunk. Chunks must be contiguous in the source file. */
  append(chunk: TextChunk): void {
    if (chunk.startByteOffset !== this.endByte) {
      throw new Error(
        `text stream gap: expected byte ${this.endByte}, got ${chunk.startByteOffset}`,
      );
    }
    this.chunks.push({
      text: chunk.text,
      startUnit: this.units,
      startByte: chunk.startByteOffset,
      endByte: chunk.endByteOffset,
      startLine: chunk.startLineIndex,
      spans: chunk.sourceSpans,
    });
    this.scanRows(chunk.text, this.units);
    this.units += chunk.text.length;
    this.endByte = chunk.endByteOffset;
    this.hadReplacements ||= chunk.hadReplacements;
    this.complete = chunk.isLast;
  }

  private scanRows(text: string, startUnit: number): void {
    let from = 0;
    for (;;) {
      const newline = text.indexOf('\n', from);
      const contentEnd = startUnit + (newline === -1 ? text.length : newline);
      let rowStart = this.rowStarts.at(-1) as number;
      while (contentEnd - rowStart > MAX_ROW_UNITS) {
        let rowBreak = rowStart + MAX_ROW_UNITS;
        // Chunks end on code points, so this index is always inside `text`.
        if (isHighSurrogate(text.charCodeAt(rowBreak - startUnit - 1))) rowBreak -= 1;
        this.rowStarts.push(rowBreak);
        rowStart = rowBreak;
      }
      if (newline === -1) return;
      this.rowStarts.push(startUnit + newline + 1);
      from = newline + 1;
    }
  }

  /** Source bytes loaded so far: the whole file once `complete`. */
  get loadedBytes(): number {
    return this.endByte;
  }

  get rowCount(): number {
    return this.rowStarts.length;
  }

  rowStart(row: number): number {
    return this.rowStarts[row] ?? this.units;
  }

  /** The row's text, without its line terminator. */
  rowText(row: number): string {
    const text = this.slice(this.rowStart(row), this.rowStart(row + 1));
    if (!text.endsWith('\n')) return text;
    return text.slice(0, text.endsWith('\r\n') ? -2 : -1);
  }

  rowAtUnit(unit: number): number {
    return lastAtOrBefore(this.rowStarts, unit, (start) => start);
  }

  /** Decoded text between two units, across chunk boundaries. */
  slice(startUnit: number, endUnit: number): string {
    if (endUnit <= startUnit) return '';
    let index = this.chunkAtUnit(startUnit);
    let text = '';
    for (; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index] as ModelChunk;
      if (chunk.startUnit >= endUnit) break;
      text += chunk.text.slice(startUnit - chunk.startUnit, endUnit - chunk.startUnit);
      startUnit = chunk.startUnit + chunk.text.length;
    }
    return text;
  }

  private chunkAtUnit(unit: number): number {
    return lastAtOrBefore(this.chunks, unit, (chunk) => chunk.startUnit);
  }

  /** The source byte a text position corresponds to (ADR 0002, invariant 2). */
  sourceOffsetAt(unit: number): number {
    const chunk = this.chunks[this.chunkAtUnit(Math.min(unit, this.units))];
    if (!chunk) return 0;
    const relative = Math.min(unit - chunk.startUnit, chunk.text.length);
    let decoded = 0;
    for (let index = 0; index < relative;) {
      const point = codePointAt(chunk.text, index);
      decoded += point.utf8;
      index += point.units;
    }
    return chunk.startByte + decoded + spanAdjustment(chunk.spans, decoded);
  }

  /**
   * The text position of a source byte, or `null` if that byte has not loaded.
   * A byte inside a span rounds outward, as the span is atomic (invariant 3).
   */
  unitAtSourceOffset(byte: number, rounding: Rounding): number | null {
    if (byte > this.endByte) return null;
    if (byte === this.endByte) return this.units;
    const chunk = this.chunks[lastAtOrBefore(this.chunks, byte, (item) => item.startByte)];
    if (!chunk) return null;

    let index = 0;
    let decoded = 0;
    let previous = 0;
    while (index < chunk.text.length) {
      const offset = chunk.startByte + decoded + spanAdjustment(chunk.spans, decoded);
      if (offset === byte) return chunk.startUnit + index;
      if (offset > byte) return chunk.startUnit + (rounding === 'down' ? previous : index);
      previous = index;
      const point = codePointAt(chunk.text, index);
      decoded += point.utf8;
      index += point.units;
    }
    return chunk.startUnit + (rounding === 'down' ? previous : index);
  }

  private lineIndexAt(unit: number): number {
    const chunk = this.chunks[this.chunkAtUnit(unit)];
    if (!chunk) return 0;
    const relative = unit - chunk.startUnit;
    let line = chunk.startLine;
    for (
      let newline = chunk.text.indexOf('\n');
      newline !== -1 && newline < relative;
      newline = chunk.text.indexOf('\n', newline + 1)
    ) {
      line += 1;
    }
    return line;
  }

  private anchor(startUnit: number, endUnit: number): TxtAnchor {
    return {
      format: 'txt',
      startByteOffset: this.sourceOffsetAt(startUnit),
      endByteOffset: this.sourceOffsetAt(endUnit),
      lineIndex: this.lineIndexAt(startUnit),
    };
  }

  /**
   * Turns a selected range into an anchor and its excerpt text. Line breaks at
   * the edges are dropped (a triple-click ends on the next row). Returns `null`
   * if nothing but whitespace is selected, which core would refuse to save.
   */
  selectionFor(startUnit: number, endUnit: number): { anchor: TxtAnchor; text: string } | null {
    let start = startUnit;
    let end = endUnit;
    if (isLowSurrogate(this.codeAt(start))) start -= 1;
    if (isLowSurrogate(this.codeAt(end))) end += 1;
    while (start < end && isLineBreak(this.codeAt(start))) start += 1;
    while (end > start && isLineBreak(this.codeAt(end - 1))) end -= 1;

    const text = this.slice(start, end);
    if (text.trim() === '') return null;
    return { anchor: this.anchor(start, end), text };
  }

  private codeAt(unit: number): number {
    const chunk = this.chunks[this.chunkAtUnit(unit)];
    return chunk ? chunk.text.charCodeAt(unit - chunk.startUnit) : Number.NaN;
  }

  /** Where an anchor sits in the text, or `null` until its bytes have loaded. */
  rangeFor(anchor: TxtAnchor): { startUnit: number; endUnit: number } | null {
    const startUnit = this.unitAtSourceOffset(anchor.startByteOffset, 'down');
    const endUnit = this.unitAtSourceOffset(anchor.endByteOffset, 'up');
    return startUnit === null || endUnit === null ? null : { startUnit, endUnit };
  }

  /**
   * An anchor for a reading position. Core requires anchors to cover a byte, so
   * the empty row after a final newline reports the row before it.
   */
  cursorAnchorForRow(row: number): TxtAnchor | null {
    for (let candidate = row; candidate >= 0; candidate -= 1) {
      const start = this.rowStart(candidate);
      const end = this.rowStart(candidate + 1);
      if (end > start) return this.anchor(start, end);
    }
    return null;
  }

  /**
   * Searches all loaded text (including unrendered rows) and maps every match
   * to source-file byte offsets (`TxtAnchor`).
   */
  search(query: string, options?: { caseSensitive?: boolean }): TxtSearchMatch[] {
    if (query.trim() === '' || this.units === 0) return [];
    const caseSensitive = options?.caseSensitive ?? false;
    const fullText = this.slice(0, this.units);
    const rawMatches = findSubstringMatches(fullText, query, caseSensitive);
    return rawMatches.map(({ start, end }, index) => {
      const anchor = this.anchor(start, end);
      const rowIndex = this.rowAtUnit(start);
      const lineNumber = anchor.lineIndex + 1;
      const snippet = buildSearchSnippet(fullText, start, end);
      return {
        id: `txt-${anchor.startByteOffset}-${anchor.endByteOffset}-${index}`,
        anchor,
        startUnit: start,
        endUnit: end,
        rowIndex,
        lineNumber,
        locationLabel: `Line ${lineNumber}`,
        ...snippet,
      };
    });
  }
}

const isLineBreak = (code: number) => code === 0x0a || code === 0x0d;

/**
 * Source bytes minus decoded bytes for every span fully before `decoded`. A span
 * that ends exactly at `decoded` counts, which places a position after a BOM
 * rather than on it.
 */
function spanAdjustment(spans: readonly SourceSpan[], decoded: number): number {
  let adjustment = 0;
  for (const span of spans) {
    if (span.textOffset + span.textLen > decoded) break;
    adjustment += span.sourceLen - span.textLen;
  }
  return adjustment;
}
