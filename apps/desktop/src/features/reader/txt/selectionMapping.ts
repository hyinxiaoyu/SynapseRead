/** Marks a text segment: its value is the unit offset of the segment's first character. */
export const UNIT_ATTRIBUTE = 'data-unit';

function segmentOf(node: Node | null | undefined, edge: 'first' | 'last'): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;
  const own = element.closest<HTMLElement>(`[${UNIT_ATTRIBUTE}]`);
  if (own) return own;
  const inside = element.querySelectorAll<HTMLElement>(`[${UNIT_ATTRIBUTE}]`);
  return (edge === 'first' ? inside[0] : inside[inside.length - 1]) ?? null;
}

const unitOf = (segment: HTMLElement) => Number(segment.getAttribute(UNIT_ATTRIBUTE));
const endOf = (segment: HTMLElement) => unitOf(segment) + (segment.textContent?.length ?? 0);

/**
 * Resolves a DOM boundary point to a text position. Browsers report boundaries
 * either inside a text node or as a child index on any ancestor (a triple-click
 * often ends at the start of the next row), so both forms are handled.
 */
export function unitAtBoundary(node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const segment = segmentOf(node, 'first');
    return segment ? unitOf(segment) + offset : null;
  }
  const following = segmentOf(node.childNodes[offset], 'first');
  if (following) return unitOf(following);
  const preceding = segmentOf(node.childNodes[offset - 1], 'last') ?? segmentOf(node, 'last');
  return preceding ? endOf(preceding) : null;
}
