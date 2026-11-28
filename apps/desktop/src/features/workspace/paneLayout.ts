import type { WorkspacePaneLayout } from '@/types/domain';

export const DEFAULT_MIND_MAP_SIZE = 35;
export const DEFAULT_INSPECTOR_SIZE = 20;
export const MAX_MIND_MAP_SIZE = 50;
export const MAX_INSPECTOR_SIZE = 30;
export const MIN_READER_PERCENT = 20;
/** Keeps the active tab, Open, Recent, and Excerpt to MindMap visible at 960px (#180). */
export const MIN_READER_PX = 420;
/** Two 1px `ResizableHandle` separators between Reader, MindMap, and Inspector. */
export const RESIZE_HANDLE_TOTAL_PX = 2;

export type PanelLayout = {
  reader: number;
  mindmap: number;
  inspector: number;
};

export type PreferredSidePane = 'mindmap' | 'inspector';

export const roundPercent = (value: number): number => Math.round(value * 10) / 10;

export function clampMindMapSize(size: number | null | undefined): number {
  if (size == null || !Number.isFinite(size)) return DEFAULT_MIND_MAP_SIZE;
  return roundPercent(Math.min(MAX_MIND_MAP_SIZE, Math.max(DEFAULT_MIND_MAP_SIZE, size)));
}

export function clampInspectorSize(size: number | null | undefined): number {
  if (size == null || !Number.isFinite(size)) return DEFAULT_INSPECTOR_SIZE;
  return roundPercent(Math.min(MAX_INSPECTOR_SIZE, Math.max(DEFAULT_INSPECTOR_SIZE, size)));
}

/**
 * Minimum percentage the reader panel needs so it stays above both the
 * percentage floor and `MIN_READER_PX` at the current container width.
 */
export function effectiveMinReaderPercent(containerWidthPx?: number | null): number {
  if (containerWidthPx == null || !Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return MIN_READER_PERCENT;
  }
  const availableWidth = Math.max(1, containerWidthPx - RESIZE_HANDLE_TOTAL_PX);
  const pxPercent = Math.ceil((MIN_READER_PX / availableWidth) * 1000) / 10;
  return Math.min(100, Math.max(MIN_READER_PERCENT, pxPercent));
}

/**
 * Computes an explicit 3-panel layout (`reader + mindmap + inspector = 100`)
 * from persisted preferences and the current container width (#180):
 * - Hidden side panes return their width to the reader, never to the other side pane.
 * - Restored widths are clamped so stale or inflated values cannot squeeze the reader.
 * - When the container cannot fit all requested panes above `MIN_READER_PX`,
 *   side panes trim toward their minimums; if even minimums do not fit, the
 *   Inspector collapses first (unless `preferKeep === 'inspector'`).
 */
export function computePanelLayout(
  paneLayout: WorkspacePaneLayout,
  immersive: boolean,
  containerWidthPx?: number | null,
  preferKeep: PreferredSidePane = 'mindmap',
): PanelLayout {
  if (immersive) {
    return { reader: 100, mindmap: 0, inspector: 0 };
  }

  const minReader = effectiveMinReaderPercent(containerWidthPx);
  const maxSideCombined = Math.max(0, roundPercent(100 - minReader));

  let mindmap = paneLayout.mindMapOpen ? clampMindMapSize(paneLayout.mindMapSize) : 0;
  let inspector = paneLayout.inspectorOpen ? clampInspectorSize(paneLayout.inspectorSize) : 0;

  // If both panes are requested but their minimums cannot fit alongside the
  // reader's minimum, collapse one side pane (Inspector first by default).
  if (
    mindmap > 0 &&
    inspector > 0 &&
    DEFAULT_MIND_MAP_SIZE + DEFAULT_INSPECTOR_SIZE > maxSideCombined
  ) {
    if (preferKeep === 'inspector') {
      mindmap = 0;
    } else {
      inspector = 0;
    }
  }

  if (mindmap > 0 && DEFAULT_MIND_MAP_SIZE > maxSideCombined) {
    mindmap = 0;
  }
  if (inspector > 0 && DEFAULT_INSPECTOR_SIZE > maxSideCombined) {
    inspector = 0;
  }

  if (mindmap + inspector > maxSideCombined) {
    let excess = roundPercent(mindmap + inspector - maxSideCombined);
    if (mindmap > 0 && excess > 0) {
      const trimMindMap = Math.min(
        excess,
        Math.max(0, roundPercent(mindmap - DEFAULT_MIND_MAP_SIZE)),
      );
      mindmap = roundPercent(mindmap - trimMindMap);
      excess = roundPercent(excess - trimMindMap);
    }
    if (inspector > 0 && excess > 0) {
      const trimInspector = Math.min(
        excess,
        Math.max(0, roundPercent(inspector - DEFAULT_INSPECTOR_SIZE)),
      );
      inspector = roundPercent(inspector - trimInspector);
    }
  }

  const reader = roundPercent(100 - mindmap - inspector);
  return { reader, mindmap, inspector };
}
