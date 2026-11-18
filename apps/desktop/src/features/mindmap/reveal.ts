import type { Viewport } from '@/types/domain';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Space kept between a card and the canvas edge for it to count as in view, in pixels. */
export const REVEAL_MARGIN = 24;
/** How long the pan to a card takes; reduced motion jumps instead. */
export const REVEAL_DURATION_MS = 250;

/**
 * The viewport that centers `node` (in flow coordinates) at the current zoom, or
 * `null` when it is already fully in view and the canvas should not move.
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
  return {
    x: pane.width / 2 - (node.x + node.width / 2) * zoom,
    y: pane.height / 2 - (node.y + node.height / 2) * zoom,
    zoom,
  };
}

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
