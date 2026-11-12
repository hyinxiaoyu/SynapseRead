/**
 * The arithmetic behind pinch and ctrl-wheel zoom (#51), kept free of the DOM so it
 * can be tested. Everything here works in the displayed frame: page sizes are
 * already rotated, so a rotated page needs no special case.
 */

export const MIN_ZOOM_SCALE = 0.25;
export const MAX_ZOOM_SCALE = 4;

/**
 * Wheel travel, in pixels, that doubles or halves the scale (by e^(travel/k)).
 * A trackpad pinch in Chromium sends deltas of a few pixels each.
 */
const WHEEL_PX_PER_E = 100;
/**
 * The most one wheel event may move. A mouse wheel notch is 100 px or 3 lines, which
 * would otherwise jump by 2.7×; this keeps a notch to about 22%.
 */
const MAX_WHEEL_PX = 20;
const LINE_PX = 16;

export interface Point {
  x: number;
  y: number;
}

/** A scale the toolbar can show: whole percent, within the zoom range. */
export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, Math.round(scale * 100) / 100));
}

/** Keeps `base × ratio` within the zoom range, so the preview never overshoots. */
export function clampZoomRatio(base: number, ratio: number): number {
  if (!(base > 0) || !Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_ZOOM_SCALE / base, Math.max(MIN_ZOOM_SCALE / base, ratio));
}

/**
 * The factor one ctrl-wheel event zooms by. Up (negative delta) zooms in, as in
 * every browser. `deltaMode` is the WheelEvent constant: 0 pixels, 1 lines, 2 pages.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pagePx: number): number {
  const unit = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? Math.max(pagePx, 1) : 1;
  const travel = Math.min(MAX_WHEEL_PX, Math.max(-MAX_WHEEL_PX, deltaY * unit));
  return Math.exp(-travel / WHEEL_PX_PER_E);
}

/**
 * Where a point seen on screen during the preview lies in the unscaled content.
 * The preview is `scale(ratio)` about `origin`, so this inverts that.
 */
export function unscalePoint(point: Point, origin: Point, ratio: number): Point {
  const r = ratio > 0 ? ratio : 1;
  return { x: origin.x + (point.x - origin.x) / r, y: origin.y + (point.y - origin.y) / r };
}

/** The style that previews a zoom without re-rendering a single page. */
export function previewStyle(origin: Point, ratio: number) {
  return {
    transform: ratio === 1 ? '' : `scale(${ratio})`,
    transformOrigin: `${origin.x}px ${origin.y}px`,
  };
}

/** The left edge of each page in a row, which lays pages out side by side. */
export function pageLefts(rowLeft: number, widths: readonly number[], gap: number): number[] {
  const lefts: number[] = [];
  let left = rowLeft;
  for (const width of widths) {
    lefts.push(left);
    left += width + gap;
  }
  return lefts;
}

/**
 * Which page of a row holds `x`, and how far across it. A point in a gap or the
 * margin goes to the nearer page and is clamped to its edge.
 */
export function locateInRow(
  x: number,
  rowLeft: number,
  widths: readonly number[],
  gap: number,
): { slot: number; fraction: number } {
  if (widths.length === 0) return { slot: 0, fraction: 0 };
  const lefts = pageLefts(rowLeft, widths, gap);
  let slot = 0;
  for (let index = 1; index < widths.length; index += 1) {
    const previousRight = (lefts[index - 1] ?? 0) + (widths[index - 1] ?? 0);
    if (x >= (previousRight + (lefts[index] ?? 0)) / 2) slot = index;
  }
  const width = widths[slot] ?? 0;
  const fraction = width > 0 ? (x - (lefts[slot] ?? 0)) / width : 0;
  return { slot, fraction: Math.min(1, Math.max(0, fraction)) };
}

/**
 * The scroll position that puts a content point (in pixels from the content's top
 * left) under the pointer (in pixels from the scroller's top left). It cannot go
 * negative, so near the start the point lands as close as the content allows.
 */
export function anchoredScroll(content: Point, pointer: Point): { left: number; top: number } {
  return { left: Math.max(0, content.x - pointer.x), top: Math.max(0, content.y - pointer.y) };
}
