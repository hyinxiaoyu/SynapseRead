import type { ViewportRect } from '@/features/reader/markup/geometry';

/** Hover/focus snapshot of a copyable `<pre>` code block inside an EPUB chapter frame. */
export interface EpubCodeBlockHover {
  id: string;
  rect: ViewportRect;
  getText: () => string;
  focusBlock?: (() => boolean) | undefined;
  focusAfterBlock?: (() => boolean) | undefined;
}

const SKIPPED_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const BLOCK_TAGS = new Set(['div', 'p', 'tr', 'li']);
const TABLE_GUTTER_SELECTOR = '.linenos, .linenodiv, .gutter, .rouge-gutter, .hljs-ln-numbers';
const INLINE_TABLE_COLUMN_PAIRS: ReadonlyArray<readonly [gutterClass: string, codeClass: string]> =
  [
    ['hljs-ln-numbers', 'hljs-ln-code'],
    ['rouge-gutter', 'rouge-code'],
    ['linenos', 'code'],
    ['gutter', 'code'],
  ];

const MIN_VISIBLE_WIDTH_PX = 24;
const MIN_VISIBLE_HEIGHT_PX = 16;

function hasClass(element: Element, token: string): boolean {
  const classAttr = element.getAttribute('class');
  if (!classAttr) return false;
  return classAttr.split(/\s+/).includes(token);
}

function shouldSkipDescendant(element: Element, tag: string): boolean {
  return (
    SKIPPED_TAGS.has(tag) ||
    element.hasAttribute('hidden') ||
    element.hasAttribute('data-synapse-ui')
  );
}

function parsePositiveLineNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function isConsecutiveSequence(numbers: readonly number[]): boolean {
  if (numbers.length === 0) return false;
  for (let index = 1; index < numbers.length; index += 1) {
    const prev = numbers[index - 1];
    const curr = numbers[index];
    if (prev === undefined || curr === undefined || curr !== prev + 1) return false;
  }
  return true;
}

function isCleanLineContainer(line: Element, gutterEl: Element, codeEl: Element): boolean {
  for (const node of Array.from(line.childNodes)) {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if ((node as CharacterData).data.trim() !== '') return false;
      continue;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      if (
        el !== gutterEl &&
        el !== codeEl &&
        !shouldSkipDescendant(el, el.localName.toLowerCase())
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Recognizes Hugo/Chroma inline line-number markup (`<span class="line"><span class="ln">1</span><span class="cl">...</span></span>`)
 * only when `.ln` and `.cl` pair cleanly across every `.line` with a consecutive integer sequence.
 */
function collectChromaLineNumberNodes(pre: Element): {
  gutterNodes: Element[];
  lineNodes: Element[];
} {
  const lines = Array.from(pre.querySelectorAll('.line')).filter((line) => {
    if (!hasClass(line, 'line')) return false;
    const ancestorCl = line.parentElement?.closest('.cl');
    return !(ancestorCl && pre.contains(ancestorCl));
  });
  if (lines.length === 0) return { gutterNodes: [], lineNodes: [] };

  const gutterNodes: Element[] = [];
  const lineNodes: Element[] = [];
  const numbers: number[] = [];
  let sawClWithoutLn = false;

  for (const line of lines) {
    const lnChildren: Element[] = [];
    const clChildren: Element[] = [];
    for (const child of Array.from(line.children)) {
      const isLn = hasClass(child, 'ln');
      const isCl = hasClass(child, 'cl');
      if (isLn && !isCl) lnChildren.push(child);
      if (isCl && !isLn) clChildren.push(child);
    }
    if (lnChildren.length === 0 && clChildren.length === 0) continue;
    if (lnChildren.length === 0 && clChildren.length > 0) {
      sawClWithoutLn = true;
      continue;
    }
    if (lnChildren.length !== 1 || clChildren.length !== 1) {
      return { gutterNodes: [], lineNodes: [] };
    }
    const lnEl = lnChildren[0];
    const clEl = clChildren[0];
    if (!lnEl || !clEl || !isCleanLineContainer(line, lnEl, clEl)) {
      return { gutterNodes: [], lineNodes: [] };
    }
    if (lnEl.querySelector('img, br') !== null) {
      return { gutterNodes: [], lineNodes: [] };
    }
    const num = parsePositiveLineNumber(lnEl.textContent ?? '');
    if (num === null) return { gutterNodes: [], lineNodes: [] };
    gutterNodes.push(lnEl);
    lineNodes.push(line);
    numbers.push(num);
  }

  if (gutterNodes.length === 0 || sawClWithoutLn) return { gutterNodes: [], lineNodes: [] };
  if (!isConsecutiveSequence(numbers)) return { gutterNodes: [], lineNodes: [] };
  const hasChromaContext = pre.closest('.chroma') !== null || pre.querySelector('.chroma') !== null;
  if (!hasChromaContext && numbers.length === 1 && numbers[0] !== 1) {
    return { gutterNodes: [], lineNodes: [] };
  }
  return { gutterNodes, lineNodes };
}

/**
 * Recognizes paired two-column line-number tables embedded inside `<pre>` (such as `hljs-ln`
 * or `rouge-table`) where every row pairs an explicit gutter cell with an explicit code cell.
 */
function collectInlineTableGutterNodes(pre: Element): Element[] {
  const skippedCells: Element[] = [];
  for (const table of Array.from(pre.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table,
    );
    if (rows.length === 0) continue;

    for (const [gutterClass, codeClass] of INLINE_TABLE_COLUMN_PAIRS) {
      const candidates: Element[] = [];
      const numbers: number[] = [];
      let valid = true;

      for (const row of rows) {
        const cells = Array.from(row.children).filter((child) => {
          const tag = child.localName.toLowerCase();
          return tag === 'td' || tag === 'th';
        });
        const gutterCells = cells.filter(
          (cell) => hasClass(cell, gutterClass) && !hasClass(cell, codeClass),
        );
        const codeCells = cells.filter(
          (cell) => hasClass(cell, codeClass) && !hasClass(cell, gutterClass),
        );
        if (gutterCells.length !== 1 || codeCells.length === 0) {
          valid = false;
          break;
        }
        const gutterCell = gutterCells[0];
        if (!gutterCell || gutterCell.querySelector('img, br') !== null) {
          valid = false;
          break;
        }
        const trimmed = (gutterCell.textContent ?? '').trim();
        if (trimmed !== '') {
          const num = parsePositiveLineNumber(trimmed);
          if (num === null) {
            valid = false;
            break;
          }
          numbers.push(num);
        }
        candidates.push(gutterCell);
      }

      if (!valid || candidates.length === 0) continue;
      if (
        numbers.length > 0 &&
        (!isConsecutiveSequence(numbers) || (numbers.length === 1 && numbers[0] !== 1))
      ) {
        continue;
      }
      skippedCells.push(...candidates);
      break;
    }
  }
  return skippedCells;
}

function collectStructuredLineNodes(pre: Element): {
  gutterNodes: Set<Element>;
  blockLineNodes: Set<Element>;
} {
  const chroma = collectChromaLineNumberNodes(pre);
  const gutterNodes = new Set<Element>(chroma.gutterNodes);
  const blockLineNodes = new Set<Element>(chroma.lineNodes);
  for (const node of collectInlineTableGutterNodes(pre)) gutterNodes.add(node);
  return { gutterNodes, blockLineNodes };
}

/**
 * Extracts plain source text from a `<pre>` element without using `innerText`, so
 * CSS soft-wrapping, counters (`::before`), and platform differences never alter
 * indentation, line breaks, or ambiguous source tokens, while stripping unambiguously
 * marked structural line numbers (such as Chroma `.line > .ln + .cl` or paired tables).
 */
export function extractCodeBlockText(pre: Element): string {
  const { gutterNodes, blockLineNodes } = collectStructuredLineNodes(pre);
  let out = '';
  let pendingBlockBreak = false;

  const appendText = (raw: string) => {
    const normalized = raw.replace(/\r\n|\r/g, '\n');
    if (normalized.length === 0) return;
    if (pendingBlockBreak) {
      pendingBlockBreak = false;
      if (!normalized.startsWith('\n') && out.length > 0 && !out.endsWith('\n')) {
        out += '\n';
      }
    }
    out += normalized;
  };

  const walk = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        appendText((node as CharacterData).data);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = element.localName.toLowerCase();
      if (gutterNodes.has(element) || shouldSkipDescendant(element, tag)) continue;
      if (tag === 'br') {
        pendingBlockBreak = false;
        out += '\n';
        continue;
      }
      if (tag === 'img') {
        appendText(element.getAttribute('alt') ?? '');
        continue;
      }
      const isBlock = BLOCK_TAGS.has(tag) || blockLineNodes.has(element);
      if (isBlock) {
        if (pendingBlockBreak) {
          pendingBlockBreak = false;
          out += '\n';
        } else if (out.length > 0 && !out.endsWith('\n')) {
          out += '\n';
        }
      }
      const bodyStartLen = out.length;
      walk(element);
      if (isBlock) {
        if (out.length > bodyStartLen) {
          if (!out.endsWith('\n')) {
            pendingBlockBreak = true;
          }
        } else if (blockLineNodes.has(element)) {
          // An empty Chroma `.line` still represents an empty line in source output.
          pendingBlockBreak = true;
        }
      }
    }
  };

  walk(pre);
  return out;
}

function isGutterLineNumberSequence(pre: Element): boolean {
  if (pre.querySelector('img') !== null) return false;
  const trimmed = extractCodeBlockText(pre).trim();
  if (trimmed === '') return true;
  if (!/^[0-9\s]+$/.test(trimmed)) return false;
  const numbers: number[] = [];
  for (const token of trimmed.split(/\s+/)) {
    const parsed = parsePositiveLineNumber(token);
    if (parsed === null) return false;
    numbers.push(parsed);
  }
  if (!isConsecutiveSequence(numbers)) return false;
  return numbers.length >= 2 || numbers[0] === 1;
}

function isGutterCellPre(pre: Element, cell: Element): boolean {
  const gutter = pre.closest(TABLE_GUTTER_SELECTOR);
  if (gutter !== null && cell.contains(gutter)) return true;
  return (
    cell.closest('table.lntable') !== null &&
    pre.querySelector('.lnt') !== null &&
    pre.querySelector('.cl') === null
  );
}

/**
 * Only reject `<pre>` elements that live in a dedicated side-by-side table gutter cell
 * paired with a sibling code `<pre>` in the same row, so standalone numeric blocks stay copyable.
 */
function isSideBySideGutterPre(pre: Element): boolean {
  const cell = pre.closest('td, th');
  if (!cell || !isGutterCellPre(pre, cell)) return false;
  const row = cell.parentElement;
  if (!row || row.localName.toLowerCase() !== 'tr') return false;
  const hasSiblingCodePre = Array.from(row.children).some((sibling) => {
    if (sibling === cell) return false;
    const tag = sibling.localName.toLowerCase();
    if (tag !== 'td' && tag !== 'th') return false;
    const siblingPre = sibling.querySelector('pre');
    if (!siblingPre) return false;
    return !isGutterCellPre(siblingPre, sibling);
  });
  if (!hasSiblingCodePre) return false;
  return isGutterLineNumberSequence(pre);
}

/** Whether `pre` is a real code block with copyable text rather than a line-number gutter. */
export function isCopyableCodeBlock(pre: Element): boolean {
  if (pre.localName.toLowerCase() !== 'pre') return false;
  if (isSideBySideGutterPre(pre)) return false;
  return extractCodeBlockText(pre).trim().length > 0;
}

function horizontalDistance(rect: ViewportRect, x: number): number {
  if (x < rect.left) return rect.left - x;
  if (x > rect.right) return x - rect.right;
  return 0;
}

function verticalDistance(rect: ViewportRect, y: number): number {
  if (y < rect.top) return rect.top - y;
  if (y > rect.bottom) return y - rect.bottom;
  return 0;
}

/**
 * Resolves the visible fragment rect of `pre` in top-window viewport coordinates,
 * clipped to `hostRect`. Picks the fragment containing `pointer` when supplied,
 * otherwise the horizontally closest or first visible fragment.
 */
export function visibleCodeBlockRect(
  pre: Element,
  frameRect: DOMRectReadOnly,
  hostRect: DOMRectReadOnly,
  pointer?: { x: number; y: number },
): ViewportRect | null {
  const clientRects =
    typeof pre.getClientRects === 'function' ? Array.from(pre.getClientRects()) : [];
  const fragments = clientRects.length > 0 ? clientRects : [pre.getBoundingClientRect()];

  const visible: ViewportRect[] = [];
  for (const fragment of fragments) {
    const top = Math.max(fragment.top + frameRect.top, hostRect.top);
    const left = Math.max(fragment.left + frameRect.left, hostRect.left);
    const bottom = Math.min(fragment.bottom + frameRect.top, hostRect.bottom);
    const right = Math.min(fragment.right + frameRect.left, hostRect.right);
    if (right - left >= MIN_VISIBLE_WIDTH_PX && bottom - top >= MIN_VISIBLE_HEIGHT_PX) {
      visible.push({ top, left, bottom, right });
    }
  }

  if (visible.length === 0) return null;
  if (!pointer) return visible[0] ?? null;

  const hit = visible.find(
    (rect) =>
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom,
  );
  if (hit) return hit;

  let best = visible[0] ?? null;
  let bestDx = best ? horizontalDistance(best, pointer.x) : Infinity;
  let bestDy = best ? verticalDistance(best, pointer.y) : Infinity;
  for (let index = 1; index < visible.length; index += 1) {
    const candidate = visible[index];
    if (!candidate) continue;
    const dx = horizontalDistance(candidate, pointer.x);
    const dy = verticalDistance(candidate, pointer.y);
    if (dx < bestDx || (dx === bestDx && dy < bestDy)) {
      best = candidate;
      bestDx = dx;
      bestDy = dy;
    }
  }
  return best;
}
