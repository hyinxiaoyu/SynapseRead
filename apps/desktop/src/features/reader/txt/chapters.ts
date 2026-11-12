import type { OutlineNode } from '@/features/reader/navigator/OutlineTree';
import type { TxtHeading } from '@/features/reader/txt/textModel';

/** The Contents id of a heading: by source byte, which no re-chunking moves. */
export const headingId = (heading: TxtHeading) => `txt-heading-${heading.startByte}`;

/**
 * Contents for a text file: chapters nest under the part, book or volume before
 * them, and stand at the top level when there is none. Targets are source bytes.
 */
export function headingOutline(headings: readonly TxtHeading[]): OutlineNode<number>[] {
  const items: OutlineNode<number>[] = [];
  let part: { node: OutlineNode<number>; children: OutlineNode<number>[] } | null = null;
  for (const heading of headings) {
    const node = { id: headingId(heading), label: heading.label, target: heading.startByte };
    if (heading.level === 0) {
      const children: OutlineNode<number>[] = [];
      part = { node: { ...node, children }, children };
      items.push(part.node);
    } else if (part) {
      part.children.push({ ...node, children: [] });
    } else {
      items.push({ ...node, children: [] });
    }
  }
  return items;
}

/** The index of the heading the row is under, or -1 before the first. */
export function headingIndexAt(headings: readonly TxtHeading[], row: number): number {
  let low = 0;
  let high = headings.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((headings[middle] as TxtHeading).row <= row) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Where each chapter starts, by row: the places Next and Previous Chapter go. A
 * heading joined to the one before it (`Part Two` then `Chapter 3`) starts no
 * chapter of its own. Text before the first heading (a title page, a preface
 * without a heading) counts as one, so Previous Chapter from the first leads back.
 */
export function chapterStartRows(headings: readonly TxtHeading[]): number[] {
  const rows = headings.filter((heading) => !heading.joined).map((heading) => heading.row);
  if (rows.length > 0 && (rows[0] as number) > 0) rows.unshift(0);
  return rows;
}

/** The index in `starts` of the chapter holding `row`. */
export function chapterAt(starts: readonly number[], row: number): number {
  return Math.max(
    starts.findLastIndex((start) => start <= row),
    0,
  );
}
