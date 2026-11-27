export interface EpubTocItem {
  id: string;
  label: string;
  href: string;
  children: readonly EpubTocItem[];
}

const cleanChapterPath = (href: string): string =>
  (href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');

/** Whether two hrefs name the same chapter file, ignoring fragments and relative prefixes. */
export function sameChapter(a: string, b: string): boolean {
  const left = cleanChapterPath(a);
  const right = cleanChapterPath(b);
  return (
    left !== '' &&
    right !== '' &&
    (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`))
  );
}

export function flattenToc(items: readonly EpubTocItem[]): EpubTocItem[] {
  return items.flatMap((item) => [item, ...flattenToc(item.children)]);
}

export function extractFragment(href: string): string | null {
  const hashIndex = href.indexOf('#');
  if (hashIndex === -1) return null;
  const raw = href.slice(hashIndex + 1).trim();
  return raw.length > 0 ? raw : null;
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function findFragmentTarget(doc: Document, rawFragment: string): Element | null {
  const decoded = safeDecodeUriComponent(rawFragment);
  const byId =
    doc.getElementById(decoded) ??
    (decoded !== rawFragment ? doc.getElementById(rawFragment) : null);
  if (byId) return byId;
  for (const element of doc.querySelectorAll('[name]')) {
    const name = element.getAttribute('name');
    if (name === decoded || name === rawFragment) return element;
  }
  return null;
}

function createTargetStartRange(doc: Document, target: Element): Range {
  const range = doc.createRange();
  if (target.parentNode && target !== doc.documentElement) {
    range.selectNode(target);
  } else {
    range.selectNodeContents(target);
  }
  return range;
}

function uniqueFileLevelLabel(entries: readonly EpubTocItem[]): string | null {
  const labels = new Set<string>();
  for (const entry of entries) {
    if (extractFragment(entry.href) !== null) continue;
    const trimmed = entry.label.trim();
    if (trimmed.length > 0) labels.add(trimmed);
  }
  if (labels.size !== 1) return null;
  const [only] = labels;
  return only ?? null;
}

export interface ResolveEpubSelectionChapterLabelOptions {
  toc: readonly EpubTocItem[];
  chapterHref: string;
  document: Document | null;
  selectionRange: Range | null;
}

/**
 * Resolves the chapter/section label for a selection inside `chapterHref` (#125).
 *
 * Returns:
 * - `undefined` when the TOC has no entries pointing to `chapterHref` (callers may
 *   fall back to spine-level chapter titles or `Chapter N`).
 * - `string` when the selection maps to a confirmed TOC entry (using DOM order against
 *   `#fragment` targets when multiple chapters or sections share one XHTML file).
 * - `null` when the file has fragment-targeted TOC entries that cannot be safely resolved
 *   and no unique confirmable file-level entry exists (callers fall back to book title only).
 */
export function resolveEpubSelectionChapterLabel({
  toc,
  chapterHref,
  document,
  selectionRange,
}: ResolveEpubSelectionChapterLabelOptions): string | null | undefined {
  const matches = flattenToc(toc).filter(
    (item) => sameChapter(item.href, chapterHref) && item.label.trim().length > 0,
  );
  if (matches.length === 0) return undefined;

  const hasFragments = matches.some((item) => extractFragment(item.href) !== null);
  if (!hasFragments) {
    return uniqueFileLevelLabel(matches);
  }

  const liveDoc =
    document && selectionRange && selectionRange.startContainer.ownerDocument === document
      ? document
      : null;
  if (!liveDoc || !selectionRange) {
    return uniqueFileLevelLabel(matches);
  }

  const startToStart = liveDoc.defaultView?.Range?.START_TO_START ?? 0;

  interface ResolvedEntry {
    label: string;
    order: number;
    /** `null` represents a file-level TOC entry at document start. */
    range: Range | null;
  }

  const resolved: ResolvedEntry[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const item = matches[index];
    if (!item) continue;
    const fragment = extractFragment(item.href);
    if (fragment === null) {
      resolved.push({ label: item.label.trim(), order: index, range: null });
      continue;
    }
    const target = findFragmentTarget(liveDoc, fragment);
    if (!target) {
      // Fail closed if any fragment target in this shared XHTML cannot be resolved, so
      // an excerpt from a later chapter is never misattributed to an earlier one.
      return uniqueFileLevelLabel(matches);
    }
    resolved.push({
      label: item.label.trim(),
      order: index,
      range: createTargetStartRange(liveDoc, target),
    });
  }

  resolved.sort((a, b) => {
    if (a.range === null && b.range === null) return a.order - b.order;
    if (a.range === null) return -1;
    if (b.range === null) return 1;
    try {
      const cmp = a.range.compareBoundaryPoints(startToStart, b.range);
      return cmp !== 0 ? cmp : a.order - b.order;
    } catch {
      return a.order - b.order;
    }
  });

  let chosen: string | null = null;
  for (const entry of resolved) {
    if (entry.range === null) {
      chosen = entry.label;
      continue;
    }
    try {
      if (entry.range.compareBoundaryPoints(startToStart, selectionRange) <= 0) {
        chosen = entry.label;
      } else {
        break;
      }
    } catch {
      return uniqueFileLevelLabel(matches);
    }
  }
  return chosen;
}

/**
 * Fallback resolver used by `EpubViewer` when the engine did not supply `chapterLabel`.
 * Preserves the fail-closed rule for shared XHTML files with `#fragment` entries.
 */
export function resolveEpubFallbackChapterLabel(
  toc: readonly EpubTocItem[],
  chapterHref: string,
  spineIndex: number,
  spineTitles: readonly (string | null)[],
): string | null {
  const fromToc = resolveEpubSelectionChapterLabel({
    toc,
    chapterHref,
    document: null,
    selectionRange: null,
  });
  if (fromToc !== undefined) return fromToc;
  return spineIndex >= 0 ? spineTitles[spineIndex]?.trim() || `Chapter ${spineIndex + 1}` : null;
}
