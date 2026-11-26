import type { MindMapNode } from '@/types/domain';

export interface NodeSize {
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementOptions {
  /** Known card dimensions by node id; unmeasured nodes fall back to `DEFAULT_CARD_SIZE`. */
  nodeSizes?: Readonly<Record<string, NodeSize>>;
  /** Size reserved for the new card being placed; defaults to `DEFAULT_CARD_SIZE`. */
  newSize?: NodeSize;
}

/** Card width (`w-60` in `CardNode.tsx`) and a conservative default height for unmeasured cards. */
export const DEFAULT_CARD_SIZE: NodeSize = { width: 240, height: 112 };
export const CHILD_OFFSET_X = 320;
export const SIBLING_OFFSET_Y = 140;
export const ROOT_ORIGIN = { x: 40, y: 40 };
/** Horizontal and vertical gap kept between auto-placed root cards. */
export const ROOT_CARD_GAP = 20;
/** Column stride for root cards: `w-60` (240 px) + 20 px gap = 260 px. */
export const ROOT_COLUMN_STEP = DEFAULT_CARD_SIZE.width + ROOT_CARD_GAP;
/** Maximum bottom coordinate before wrapping new roots into the next column to the right. */
export const ROOT_COLUMN_MAX_BOTTOM = 600;

const SLOT_EPSILON = 24;

function isSlotOccupied(nodes: readonly MindMapNode[], x: number, y: number): boolean {
  return nodes.some(
    (node) => Math.abs(node.posX - x) < SLOT_EPSILON && Math.abs(node.posY - y) < SLOT_EPSILON,
  );
}

/**
 * Conservative upper-bound size for a card whose DOM dimensions have not been
 * measured yet (for example, while the MindMap pane is collapsed).
 */
export function estimateCardSize(options: {
  hasCapture?: boolean;
  hasNotes?: boolean;
  hasTags?: boolean;
}): NodeSize {
  let height = DEFAULT_CARD_SIZE.height;
  if (options.hasCapture) height += 108;
  if (options.hasNotes) height += 40;
  if (options.hasTags) height += 44;
  return { width: DEFAULT_CARD_SIZE.width, height };
}

/**
 * Returns the lowest `box.y + box.height + gap` among obstacles intersecting
 * the candidate rectangle `(x, y, size)` padded by `gap`, or `null` if free.
 */
function findMaxOverlappingBottom(
  obstacles: readonly Rect[],
  x: number,
  y: number,
  size: NodeSize,
  gap: number,
): number | null {
  let maxBottom: number | null = null;
  for (const box of obstacles) {
    const overlapsX = x < box.x + box.width + gap && x + size.width + gap > box.x;
    if (!overlapsX) continue;
    const overlapsY = y < box.y + box.height + gap && y + size.height + gap > box.y;
    if (!overlapsY) continue;
    const nextY = box.y + box.height + gap;
    if (maxBottom === null || nextY > maxBottom) {
      maxBottom = nextY;
    }
  }
  return maxBottom;
}

/**
 * Children stack to the right of their parent; roots fill columns from the top
 * down, choosing the first spot whose rectangle (with gap) does not intersect
 * any existing card (#116, #128). Existing cards are never moved.
 */
export function nextNodePosition(
  nodes: readonly MindMapNode[],
  parentNodeId: string | null,
  options?: PlacementOptions,
): { x: number; y: number } {
  const parent = parentNodeId ? nodes.find((node) => node.id === parentNodeId) : undefined;
  if (parent) {
    const siblings = nodes.filter((node) => node.parentNodeId === parent.id).length;
    const x = parent.posX + CHILD_OFFSET_X;
    for (let slot = siblings; ; slot += 1) {
      const y = parent.posY + slot * SIBLING_OFFSET_Y;
      if (!isSlotOccupied(nodes, x, y)) return { x, y };
    }
  }

  const obstacles: Rect[] = nodes.map((node) => {
    const measured = options?.nodeSizes?.[node.id];
    const width =
      measured && Number.isFinite(measured.width) && measured.width > 0
        ? measured.width
        : DEFAULT_CARD_SIZE.width;
    const height =
      measured && Number.isFinite(measured.height) && measured.height > 0
        ? measured.height
        : DEFAULT_CARD_SIZE.height;
    return { x: node.posX, y: node.posY, width, height };
  });
  const newSize = options?.newSize ?? DEFAULT_CARD_SIZE;
  const columnStep = Math.max(ROOT_COLUMN_STEP, newSize.width + ROOT_CARD_GAP);

  for (let col = 0; ; col += 1) {
    const x = ROOT_ORIGIN.x + col * columnStep;
    let y = ROOT_ORIGIN.y;
    for (;;) {
      const overlappingBottom = findMaxOverlappingBottom(obstacles, x, y, newSize, ROOT_CARD_GAP);
      if (overlappingBottom === null) {
        if (y === ROOT_ORIGIN.y || y + newSize.height <= ROOT_COLUMN_MAX_BOTTOM) {
          return { x, y };
        }
        break;
      }
      y = overlappingBottom;
      if (y + newSize.height > ROOT_COLUMN_MAX_BOTTOM) {
        break;
      }
    }
  }
}
