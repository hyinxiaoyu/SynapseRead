import type { ViewportRect } from '@/features/reader/markup/geometry';

/** Hover/focus snapshot of a copyable `<pre>` code block inside an EPUB chapter frame. */
export interface EpubCodeBlockHover {
  id: string;
  rect: ViewportRect;
  getText: () => string;
}

const SKIPPED_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const BLOCK_TAGS = new Set(['div', 'p', 'tr', 'li']);
const LINE_NUMBER_CLASSES = new Set([
  'lineno',
  'linenos',
  'linenodiv',
  'line-number',
  'line-numbers-rows',
  'hljs-ln-numbers',
  'ln',
  'gutter',
]);
const GUTTER_CONTAINER_SELECTOR =
  '.linenos, .linenodiv, .gutter, [data-line-numbers], td.hljs-ln-numbers';

const MIN_VISIBLE_WIDTH_PX = 24;
const MIN_VISIBLE_HEIGHT_PX = 16;

function isLineNumberDescendant(element: Element): boolean {
  const classAttr = element.getAttribute('class');
  if (classAttr) {
    for (const token of classAttr.split(/\s+/)) {
      if (token && LINE_NUMBER_CLASSES.has(token)) return true;
    }
  }
  if (element.hasAttribute('data-line-number')) {
    const text = (element.textContent ?? '').trim();
    if (text === '' || /^\d+$/.test(text)) return true;
  }
  return false;
}

function shouldSkipDescendant(element: Element, tag: string): boolean {
  if (SKIPPED_TAGS.has(tag) || element.hasAttribute('data-synapse-ui')) return true;
  if (tag === 'code') return false;
  return element.getAttribute('aria-hidden') === 'true' || isLineNumberDescendant(element);
}

/**
 * Extracts plain source text from a `<pre>` element without using `innerText`, so
 * CSS soft-wrapping, counters, and platform differences never alter indentation or breaks.
 */
export function extractCodeBlockText(pre: Element): string {
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
      if (shouldSkipDescendant(element, tag)) continue;
      if (tag === 'br') {
        pendingBlockBreak = false;
        out += '\n';
        continue;
      }
      if (tag === 'img') {
        appendText(element.getAttribute('alt') ?? '');
        continue;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) {
        pendingBlockBreak = false;
        if (out.length > 0 && !out.endsWith('\n')) {
          out += '\n';
        }
      }
      walk(element);
      if (isBlock && out.length > 0 && !out.endsWith('\n')) {
        pendingBlockBreak = true;
      }
    }
  };

  walk(pre);
  return out.replace(/^\n/, '').replace(/\n+$/, '');
}

/** Whether `pre` is a real code block with copyable text rather than a line-number gutter. */
export function isCopyableCodeBlock(pre: Element): boolean {
  if (pre.localName.toLowerCase() !== 'pre') return false;
  if (pre.closest(GUTTER_CONTAINER_SELECTOR) !== null) return false;
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
