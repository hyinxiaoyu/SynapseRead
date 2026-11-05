import type { NormalizedRect } from '@/types/domain';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/** Keeps anchors compact: six decimals is far below a pixel at any zoom. */
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Client-space boxes as fractions of a page, clipped to it. Empty results are dropped. */
export function normalizeBoxes(boxes: Iterable<Box>, page: Box): NormalizedRect[] {
  const rects: NormalizedRect[] = [];
  for (const box of boxes) {
    const x = clampUnit((box.left - page.left) / page.width);
    const y = clampUnit((box.top - page.top) / page.height);
    const right = clampUnit((box.left + box.width - page.left) / page.width);
    const bottom = clampUnit((box.top + box.height - page.top) / page.height);
    if (right > x && bottom > y) {
      const rect = { x: round(x), y: round(y), width: 0, height: 0 };
      // Derived from the rounded edges, so `x + width` cannot pass 1 by rounding.
      rect.width = round(round(right) - rect.x);
      rect.height = round(round(bottom) - rect.y);
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

const sameLine = (a: NormalizedRect, b: NormalizedRect) => {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > 0.5 * Math.min(a.height, b.height);
};

/**
 * Joins the rectangles of each line of text. pdf.js positions every run of text
 * separately, so without this a paragraph anchor holds dozens of fragments.
 */
export function mergeLineRects(rects: readonly NormalizedRect[]): NormalizedRect[] {
  const merged: NormalizedRect[] = [];
  for (const rect of rects) {
    const line = merged.find((candidate) => sameLine(candidate, rect));
    if (!line) {
      merged.push({ ...rect });
      continue;
    }
    const right = Math.max(line.x + line.width, rect.x + rect.width);
    const bottom = Math.max(line.y + line.height, rect.y + rect.height);
    line.x = Math.min(line.x, rect.x);
    line.y = Math.min(line.y, rect.y);
    line.width = round(right - line.x);
    line.height = round(bottom - line.y);
  }
  return merged;
}

/** Pixels of a canvas that a normalized rectangle covers, always at least one. */
export function canvasRegion(
  rect: NormalizedRect,
  canvas: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(rect.x * canvas.width);
  const y = Math.floor(rect.y * canvas.height);
  return {
    x,
    y,
    width: Math.max(1, Math.round(rect.width * canvas.width)),
    height: Math.max(1, Math.round(rect.height * canvas.height)),
  };
}
