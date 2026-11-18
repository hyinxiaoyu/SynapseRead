import type { Viewport } from '@/types/domain';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Space kept between a card and the canvas edge for it to count as in view, in pixels. */
export const REVEAL_MARGIN = 24;
/** Lowest zoom `viewportRevealing` will drop to; matches React Flow's `minZoom`. */
export const MIN_REVEAL_ZOOM = 0.1;
/** How long the pan to a card takes; reduced motion jumps instead. */
export const REVEAL_DURATION_MS = 250;

/**
 * The viewport that reveals `node` (in flow coordinates) centered in `pane`, or
 * `null` when it is already fully in view and the canvas should not move. Keeps
 * the current zoom when the card fits inside the margin, and zooms out only far
 * enough to fit it otherwise.
 */
export function viewportRevealing(
  node: Rect,
  viewport: Viewport,
  pane: { width: number; height: number },
): Viewport | null {
  const { zoom } = viewport;
  const left = node.x * zoom + viewport.x;
  const top = node.y * zoom + viewport.y;
  const right = left + node.width * zoom;
  const bottom = top + node.height * zoom;
  if (
    left >= REVEAL_MARGIN &&
    top >= REVEAL_MARGIN &&
    right <= pane.width - REVEAL_MARGIN &&
    bottom <= pane.height - REVEAL_MARGIN
  ) {
    return null;
  }

  const usableWidth = pane.width - REVEAL_MARGIN * 2;
  const usableHeight = pane.height - REVEAL_MARGIN * 2;
  const fitWidth =
    node.width > 0 ? (usableWidth > 0 ? usableWidth : pane.width) / node.width : zoom;
  const fitHeight =
    node.height > 0 ? (usableHeight > 0 ? usableHeight : pane.height) / node.height : zoom;
  const nextZoom = Math.min(zoom, Math.max(MIN_REVEAL_ZOOM, Math.min(fitWidth, fitHeight)));

  return {
    x: pane.width / 2 - (node.x + node.width / 2) * nextZoom,
    y: pane.height / 2 - (node.y + node.height / 2) * nextZoom,
    zoom: nextZoom,
  };
}

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
