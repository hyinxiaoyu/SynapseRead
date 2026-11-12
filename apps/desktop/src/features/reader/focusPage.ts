import { type RefObject, useCallback, useEffect, useSyncExternalStore } from 'react';

import { isEditableShortcutTarget } from '@/features/commands/registry';

export interface FocusReadingPageOptions {
  /**
   * Takes the keyboard even from a field or the tablist. Reserved for an explicit
   * "leave this": Esc out of the sidebar, or hiding it while its filter is focused.
   */
  force?: boolean;
}

/** A widget the reader drives with the arrow keys; taking it would break that. */
function isArrowKeyWidgetFocus(active: Element): boolean {
  return active.closest('[role="tablist"]') !== null;
}

/**
 * Hands the keyboard to the reading page, so Page Down and the arrow keys work
 * the moment a document opens or a tab is activated. `preventScroll` keeps the
 * reader's place: focusing a scroll container can otherwise scroll it to its
 * edges. Text entry and the tablist keep focus, because switching tabs must not
 * interrupt a note, a search, or walking the tabs with the arrow keys.
 */
export function focusReadingPage(
  page: HTMLElement | null,
  options: FocusReadingPageOptions = {},
): boolean {
  if (page === null || !page.isConnected) return false;
  const active = page.ownerDocument.activeElement;
  if (!(options.force ?? false) && active !== null) {
    if (isEditableShortcutTarget(active) || isArrowKeyWidgetFocus(active)) return false;
  }
  page.focus({ preventScroll: true });
  return true;
}

let focusRequestVersion = 0;
const focusRequestListeners = new Set<() => void>();

function subscribeFocusRequests(listener: () => void): () => void {
  focusRequestListeners.add(listener);
  return () => {
    focusRequestListeners.delete(listener);
  };
}

function getFocusRequestSnapshot(): number {
  return focusRequestVersion;
}

const noopSubscribe = (): (() => void) => () => {};
const zeroSnapshot = (): number => 0;

/**
 * Asks whichever reading page is active after the current render to take the
 * keyboard, using the same non-forced rules as tab activation (so keyboard
 * Enter/Space inside `[role="tablist"]` or an undisturbed text field keeps focus).
 */
export function requestActivePageFocus(): void {
  focusRequestVersion += 1;
  for (const listener of focusRequestListeners) listener();
}

/**
 * Gives the page the keyboard when this tab opens, becomes active, or is
 * explicitly re-selected by pointer click. One place for the three viewers'
 * activation rule; an explicit leave can force it.
 */
export function useFocusPageOnActivate<T extends HTMLElement>(
  ref: RefObject<T | null>,
  isActive: boolean,
): (force?: boolean) => boolean {
  const focusRequest = useSyncExternalStore(
    isActive ? subscribeFocusRequests : noopSubscribe,
    isActive ? getFocusRequestSnapshot : zeroSnapshot,
    zeroSnapshot,
  );
  const focusPage = useCallback((force = false) => focusReadingPage(ref.current, { force }), [ref]);
  useEffect(() => {
    if (isActive) focusPage();
  }, [isActive, focusRequest, focusPage]);
  return focusPage;
}
