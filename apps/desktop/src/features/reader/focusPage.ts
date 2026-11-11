import { isEditableShortcutTarget } from '@/features/commands/registry';

/**
 * Hands the keyboard to the reading page, so Page Down and the arrow keys work
 * the moment a document opens or a tab is activated. `preventScroll` keeps the
 * reader's place: focusing a scroll container can otherwise scroll it to its
 * edges. Text entry keeps focus, because switching tabs must not interrupt a
 * note or a search the reader is still typing.
 */
export function focusReadingPage(page: HTMLElement | null): boolean {
  if (page === null || !page.isConnected) return false;
  const active = page.ownerDocument.activeElement;
  if (active !== null && isEditableShortcutTarget(active)) return false;
  page.focus({ preventScroll: true });
  return true;
}
