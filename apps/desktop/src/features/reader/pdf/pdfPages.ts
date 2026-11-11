/**
 * Page arithmetic that does not need pdf.js: how Two Pages pairs pages into
 * spreads, and how printed page labels map to physical pages.
 */

/** Rows of a Two Pages layout. With the cover alone: 1, then 2-3, 4-5, and so on. */
export function spreadCount(pageCount: number, coverPageAlone: boolean): number {
  if (pageCount <= 0) return 0;
  return coverPageAlone ? 1 + Math.ceil((pageCount - 1) / 2) : Math.ceil(pageCount / 2);
}

/** The spread that shows `pageIndex`. */
export function spreadOfPage(pageIndex: number, coverPageAlone: boolean): number {
  return Math.floor((coverPageAlone ? pageIndex + 1 : pageIndex) / 2);
}

/** The pages of `spread`, left to right: one for the cover or a trailing page, else two. */
export function pagesInSpread(
  spread: number,
  pageCount: number,
  coverPageAlone: boolean,
): readonly number[] {
  if (coverPageAlone && spread === 0) return pageCount > 0 ? [0] : [];
  const first = coverPageAlone ? spread * 2 - 1 : spread * 2;
  if (first < 0 || first >= pageCount) return [];
  return first + 1 < pageCount ? [first, first + 1] : [first];
}

/**
 * Printed page labels (`/PageLabels`), or null when they would only repeat the
 * physical page numbers. A page the document leaves unlabelled shows its number.
 */
export function normalizePageLabels(
  raw: readonly string[] | null | undefined,
  pageCount: number,
): readonly string[] | null {
  if (!raw || raw.length !== pageCount) return null;
  const labels = raw.map((label, index) => label.trim() || String(index + 1));
  return labels.every((label, index) => label === String(index + 1)) ? null : labels;
}

/** What the page box shows for `pageIndex`. */
export function pageLabelOf(labels: readonly string[] | null, pageIndex: number): string {
  return labels?.[pageIndex] ?? String(pageIndex + 1);
}

/** `#5` or `(5)`: the physical page, whatever the printed labels say. */
const PHYSICAL_PAGE = /^(?:#\s*(\d+)|\(\s*(\d+)\s*\))$/;

/**
 * The page index typed into the page box, or null when nothing matches. A printed
 * label wins over a physical number, because the label is what the reader sees on
 * the page: in a book numbered i, ii, 1, 2, typing 2 goes to the fourth page.
 * `#2` or `(2)` names the physical page instead.
 */
export function resolvePageInput(
  input: string,
  labels: readonly string[] | null,
  pageCount: number,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const inRange = (page: number) =>
    Number.isInteger(page) && page >= 1 && page <= pageCount ? page - 1 : null;

  const physical = PHYSICAL_PAGE.exec(trimmed);
  if (physical) return inRange(Number(physical[1] ?? physical[2]));
  if (labels) {
    const exact = labels.indexOf(trimmed);
    if (exact !== -1) return exact;
    const folded = trimmed.toLocaleLowerCase();
    const loose = labels.findIndex((label) => label.toLocaleLowerCase() === folded);
    if (loose !== -1) return loose;
  }
  return /^\d+$/.test(trimmed) ? inRange(Number(trimmed)) : null;
}
