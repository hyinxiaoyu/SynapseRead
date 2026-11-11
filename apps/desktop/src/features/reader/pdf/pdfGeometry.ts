import type { NormalizedRect, PdfRotation } from '@/types/domain';

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

export type { PdfRotation };

function clampedNormalizedRect(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedRect {
  const clampedX = round(clampUnit(x));
  const clampedY = round(clampUnit(y));
  const right = round(clampUnit(x + width));
  const bottom = round(clampUnit(y + height));
  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(0.0001, round(right - clampedX)),
    height: Math.max(0.0001, round(bottom - clampedY)),
  };
}

/**
 * Rotates a canonical (`0°`) normalized rectangle clockwise into a rotated page viewport.
 */
export function rotateNormalizedRect(rect: NormalizedRect, rotation: PdfRotation): NormalizedRect {
  switch (rotation) {
    case 0:
      return rect;
    case 90:
      return clampedNormalizedRect(1 - rect.y - rect.height, rect.x, rect.height, rect.width);
    case 180:
      return clampedNormalizedRect(
        1 - rect.x - rect.width,
        1 - rect.y - rect.height,
        rect.width,
        rect.height,
      );
    case 270:
      return clampedNormalizedRect(rect.y, 1 - rect.x - rect.width, rect.height, rect.width);
  }
}

/**
 * Where a noted highlight's marker sits on the page as shown: the top right of
 * the last line box it covers, measured on the unrotated page.
 */
export function noteMarkerPoint(
  rects: readonly NormalizedRect[],
  rotation: PdfRotation,
): { x: number; y: number } | null {
  const last = rects.at(-1);
  if (!last) return null;
  const corner = rotateNormalizedRect(
    { x: last.x + last.width, y: last.y, width: 0, height: 0 },
    rotation,
  );
  return { x: corner.x, y: corner.y };
}

/**
 * Converts a normalized rectangle measured on a rotated page back into canonical (`0°`) page space.
 */
export function unrotateNormalizedRect(
  rect: NormalizedRect,
  rotation: PdfRotation,
): NormalizedRect {
  const inverse = ((360 - rotation) % 360) as PdfRotation;
  return rotateNormalizedRect(rect, inverse);
}

export const MAX_CACHED_TEXT_PAGES = 32;
export const MAX_CACHED_ANNOTATION_PAGES = 32;

export function getBoundedLru<K, V>(map: Map<K, V>, key: K): V | undefined {
  const existing = map.get(key);
  if (existing === undefined) return undefined;
  map.delete(key);
  map.set(key, existing);
  return existing;
}

export function setBoundedLru<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}
