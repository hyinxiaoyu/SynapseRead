/** A box in the top window's viewport coordinates. */
export interface ViewportRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function toViewportRect(rect: {
  top: number;
  left: number;
  bottom: number;
  right: number;
}): ViewportRect {
  return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right };
}

/**
 * The box around a range, or null when there is none to measure: a collapsed
 * range, or a DOM without layout (jsdom has no `Range.getBoundingClientRect`).
 */
export function rangeViewportRect(
  range: Range | null | undefined,
  offset: { left: number; top: number } = { left: 0, top: 0 },
): ViewportRect | null {
  if (!range || range.collapsed || typeof range.getBoundingClientRect !== 'function') return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    top: rect.top + offset.top,
    left: rect.left + offset.left,
    bottom: rect.bottom + offset.top,
    right: rect.right + offset.left,
  };
}

/** The current selection's box, if it lies inside `root`. */
export function selectionViewportRect(root: HTMLElement | null): ViewportRect | null {
  const selection = root?.ownerDocument.getSelection();
  if (!root || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return rangeViewportRect(range);
}

/** Marks drawn for something other than an annotation (`__search_active__`). */
const isInternalMark = (id: string) => id.startsWith('__');

/**
 * The annotation mark under a click: the clicked element itself, or for marks
 * that let clicks through to the text above them (PDF), the one whose box holds
 * the point. Returns the box of every part of that mark under `scope`.
 */
export function annotationAtPoint(
  event: { target: EventTarget | null; clientX: number; clientY: number },
  scope: Element,
): { annotationId: string; rect: ViewportRect | null } | null {
  const target = event.target as Element | null;
  const direct =
    typeof target?.closest === 'function'
      ? target.closest<HTMLElement>('[data-annotation-id]')
      : null;
  let annotationId =
    direct && scope.contains(direct) ? (direct.dataset.annotationId ?? null) : null;
  if (annotationId !== null && isInternalMark(annotationId)) annotationId = null;

  const marks = Array.from(scope.querySelectorAll<HTMLElement>('[data-annotation-id]'));
  if (annotationId === null) {
    const hit = marks.find((mark) => {
      const id = mark.dataset.annotationId ?? '';
      if (isInternalMark(id)) return false;
      const box = mark.getBoundingClientRect();
      return (
        box.width > 0 &&
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      );
    });
    annotationId = hit?.dataset.annotationId ?? null;
  }
  if (annotationId === null) return null;
  return { annotationId, rect: markViewportRect(marks, annotationId) };
}

/** The union of the boxes of every mark drawn for one annotation. */
export function markViewportRect(
  marks: readonly Element[],
  annotationId: string,
): ViewportRect | null {
  let union: ViewportRect | null = null;
  for (const mark of marks) {
    if ((mark as HTMLElement).dataset?.annotationId !== annotationId) continue;
    const box = mark.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    union = union
      ? {
          top: Math.min(union.top, box.top),
          left: Math.min(union.left, box.left),
          bottom: Math.max(union.bottom, box.bottom),
          right: Math.max(union.right, box.right),
        }
      : toViewportRect(box);
  }
  return union;
}

const GAP_PX = 8;
const EDGE_PX = 8;

/**
 * Where a popover of `size` goes: centered above `target`, below it when there
 * is no room above, and kept inside `bounds`. With no target it sits at the top
 * of `bounds`, which is where a keyboard user looks after ⇧F10.
 */
export function placePopover(
  target: ViewportRect | null,
  size: { width: number; height: number },
  bounds: ViewportRect,
): { top: number; left: number; placement: 'above' | 'below' } {
  const clampLeft = (left: number) =>
    Math.max(bounds.left + EDGE_PX, Math.min(left, bounds.right - EDGE_PX - size.width));
  if (!target) {
    return {
      top: bounds.top + EDGE_PX * 2,
      left: clampLeft((bounds.left + bounds.right - size.width) / 2),
      placement: 'below',
    };
  }
  const left = clampLeft((target.left + target.right - size.width) / 2);
  const above = target.top - GAP_PX - size.height;
  if (above >= bounds.top + EDGE_PX) return { top: above, left, placement: 'above' };
  const below = target.bottom + GAP_PX;
  const maxTop = bounds.bottom - EDGE_PX - size.height;
  return { top: Math.max(bounds.top + EDGE_PX, Math.min(below, maxTop)), left, placement: 'below' };
}

/**
 * Whether focus is in a reader popover, such as the note field. Typing there moves
 * the document's selection, which must not count as the reader losing its own.
 */
export function focusInReaderPopover(doc: Document): boolean {
  const active = doc.activeElement;
  return active !== null && active.closest('[data-reader-popover]') !== null;
}
