/**
 * Consistent copy for excerpting when a MindMap card is active as the nesting
 * target (#127). Used by the reader toolbar, selection popover, and post-excerpt
 * notices so the target is never invisible from the reader.
 */

export function excerptActionLabel(targetTitle: string | null | undefined): string {
  const title = targetTitle?.trim();
  return title ? `Excerpt under ‘${title}’` : 'Excerpt to MindMap';
}

export function excerptNoticeText(parentTitle: string | null | undefined): string {
  const title = parentTitle?.trim();
  return title ? `Added under ‘${title}’` : 'Added to MindMap';
}
