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
 * The paragraph a destination points at: lines from the first one at or below
 * `fraction` (`0` the page's top) until a gap wider than a line, the next note's
 * marker, or the card's limit. Empty when nothing is there.
 */
export function textNearDestination(pageText: PdfPageText, fraction: number): string {
  const all = lines(pageText);
  const start = all.findIndex((line) => (line.top + line.bottom) / 2 >= fraction);
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
      if (isNoteMarker(line.runs[0]?.text ?? '')) break;
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
