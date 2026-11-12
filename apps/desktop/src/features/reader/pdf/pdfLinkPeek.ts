import type { NormalizedRect } from '@/types/domain';

import type { PdfPageText, PdfTextRun } from './pdfEngine';

/** The most text a card shows; longer notes end in an ellipsis. */
export const PDF_PEEK_MAX_CHARS = 600;
const MAX_LINES = 8;

/**
 * Whether a link's own text reads as a note or citation marker: `3`, `*`, `†`, `[12]`,
 * `(4)`, or `[3, 5–7]`. A PDF does not say which links are footnotes, so the marker is
 * the tell (#49); a link on words still jumps straight away.
 */
export function isNoteMarker(label: string): boolean {
  const compact = label.replace(/\s+/g, '');
  return /^[[(]?(?:\d{1,4}|[*†‡§¶]{1,3})(?:[,–-]\d{1,4})*[\])]?$/.test(compact);
}

/**
 * The text under a link's box on its page. A run can be wider than the link, so its
 * characters are spread evenly across it and only those centered in the box count.
 */
export function linkLabel(pageText: PdfPageText, rect: NormalizedRect): string {
  const parts: string[] = [];
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  for (const run of pageText.runs) {
    const box = run.rect;
    const centerY = box.y + box.height / 2;
    if (centerY < rect.y || centerY > bottom) continue;
    if (box.x > right || box.x + box.width < rect.x) continue;
    const chars = Array.from(run.text);
    const step = chars.length > 0 ? box.width / chars.length : 0;
    let taken = '';
    chars.forEach((char, index) => {
      const center = box.x + step * (index + 0.5);
      if (center >= rect.x && center <= right) taken += char;
    });
    parts.push(taken);
  }
  return parts.join('').trim();
}

interface Line {
  top: number;
  bottom: number;
  runs: PdfTextRun[];
}

/** Runs grouped into lines, top to bottom; a run joins a line it overlaps by half. */
function lines(pageText: PdfPageText): Line[] {
  const result: Line[] = [];
  const runs = pageText.runs
    .filter((run) => run.text.trim() !== '' && run.rect.height > 0)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  for (const run of runs) {
    const top = run.rect.y;
    const bottom = run.rect.y + run.rect.height;
    const line = result.find((candidate) => {
      const overlap = Math.min(candidate.bottom, bottom) - Math.max(candidate.top, top);
      return overlap >= Math.min(candidate.bottom - candidate.top, bottom - top) / 2;
    });
    if (line) {
      line.runs.push(run);
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
    } else {
      result.push({ top, bottom, runs: [run] });
    }
  }
  for (const line of result) line.runs.sort((a, b) => a.rect.x - b.rect.x);
  return result.sort((a, b) => a.top - b.top);
}

const lineText = (line: Line) =>
  line.runs
    .map((run) => run.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * How far down a line's box a destination may sit and still point at that line. A
 * run's box reaches 0.2 of its font height below the baseline and 0.85 above it, so
 * the baseline is about 0.81 of the way down: producers that aim `/XYZ` at the
 * baseline, not the line's top, would otherwise skip the line they point at.
 */
const LINE_REACH = 0.85;
/** Lines whose left edges differ by less than this, as a page fraction, are aligned. */
const ALIGNED = 0.002;

/**
 * The note marker a line begins with, if any: a run of its own (`2`, `2.`, `[2]`) or
 * the start of the line's first run (`2. The note…`), as some producers write it.
 */
function leadingMarker(line: Line): { superscript: boolean; punctuated: boolean } | null {
  const first = line.runs[0];
  if (!first) return null;
  const text = first.text.trim();
  const punctuated = (marker: string) => /^[[(]|[\]).]$/.test(marker);
  if (isNoteMarker(text.replace(/\.$/, ''))) {
    const body = Math.max(0, ...line.runs.slice(1).map((run) => run.rect.height));
    return { superscript: first.rect.height < body * 0.85, punctuated: punctuated(text) };
  }
  const inline = /^([[(]?(?:\d{1,4}|[*†‡§¶]{1,3})[\])]?\.?)\s+\S/.exec(text)?.[1];
  if (inline && isNoteMarker(inline.replace(/\.$/, ''))) {
    return { superscript: false, punctuated: punctuated(inline) };
  }
  return null;
}

/**
 * Whether `line` starts the next note rather than continuing this one. A number at
 * the start of a wrapped line (`1998`, `10`) is not enough: the marker must be raised,
 * or the line must leave the previous line's edge for the edge this note began on (a
 * hanging or first-line indent), or the marker must be punctuated on that edge.
 */
function startsNote(line: Line, previous: Line, noteStart: Line): boolean {
  const marker = leadingMarker(line);
  if (!marker) return false;
  if (marker.superscript) return true;
  const left = line.runs[0]?.rect.x ?? 0;
  const onNoteEdge = Math.abs(left - (noteStart.runs[0]?.rect.x ?? 0)) <= ALIGNED;
  if (!onNoteEdge) return false;
  const leavesPrevious = Math.abs(left - (previous.runs[0]?.rect.x ?? 0)) > ALIGNED;
  return leavesPrevious || marker.punctuated;
}

/**
 * The paragraph a destination points at: lines from the first one the destination
 * reaches (`0` the page's top) until a gap wider than a line, the next note, or the
 * card's limit. Empty when nothing is there.
 */
export function textNearDestination(pageText: PdfPageText, fraction: number): string {
  const all = lines(pageText);
  const start = all.findIndex(
    (line) => line.top + (line.bottom - line.top) * LINE_REACH >= fraction,
  );
  if (start < 0) return '';
  const taken: string[] = [];
  let length = 0;
  for (let index = start; index < all.length && taken.length < MAX_LINES; index += 1) {
    const line = all[index];
    if (!line) break;
    if (index > start) {
      const previous = all[index - 1];
      const height = previous ? previous.bottom - previous.top : 0;
      if (previous && line.top - previous.bottom > height) break;
      const noteStart = all[start];
      if (previous && noteStart && startsNote(line, previous, noteStart)) break;
    }
    const text = lineText(line);
    // A hyphen at a line's end joins a word, as it would in the paragraph.
    const last = taken.at(-1);
    if (last?.endsWith('-')) taken[taken.length - 1] = last.slice(0, -1) + text;
    else taken.push(text);
    length += text.length + 1;
    if (length >= PDF_PEEK_MAX_CHARS) break;
  }
  const text = taken.join(' ').trim();
  if (text.length <= PDF_PEEK_MAX_CHARS) return text;
  return `${text.slice(0, PDF_PEEK_MAX_CHARS).trimEnd()}…`;
}
