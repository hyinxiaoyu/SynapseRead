import { type KeyboardEvent, useState } from 'react';

const LIST_SELECTOR = '[data-roving-list]';
const ROW_SELECTOR = '[data-roving-row]';

function rowsOf(list: Element | null): HTMLElement[] {
  return list ? [...list.querySelectorAll<HTMLElement>(ROW_SELECTOR)] : [];
}

/**
 * Roving tabindex for a sidebar list: the list is one tab stop, ↑/↓ (and Home,
 * End) move between rows, and Return activates the row's own button. The list
 * element carries `data-roving-list`; each row's focus target `data-roving-row`.
 */
export function useRovingList(count: number) {
  const [activeIndex, setActiveIndex] = useState(0);
  const current = count === 0 ? -1 : Math.min(activeIndex, count - 1);

  const focusRow = (list: Element | null, index: number) => {
    const rows = rowsOf(list);
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setActiveIndex(clamped);
    rows[clamped]?.focus();
  };

  /** Handles the list's navigation keys for the row at `index`; reports whether it did. */
  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, index: number): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const list = event.currentTarget.closest(LIST_SELECTOR);
    const last = rowsOf(list).length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, last);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return false;
    event.preventDefault();
    focusRow(list, next);
    return true;
  };

  /** After the row at `index` is removed, keeps focus on the row that took its place. */
  const refocusAfterRemoval = (from: Element, index: number) => {
    const list = from.closest(LIST_SELECTOR);
    window.setTimeout(() => focusRow(list, index), 0);
  };

  return {
    listProps: { 'data-roving-list': '' },
    tabIndexFor: (index: number) => (index === current ? 0 : -1),
    onRowFocus: (index: number) => setActiveIndex(index),
    onRowKeyDown,
    refocusAfterRemoval,
  };
}

/** ⌫ or Delete, unmodified: removes the focused row in a sidebar list. */
export function isDeleteKey(event: KeyboardEvent): boolean {
  return (
    (event.key === 'Backspace' || event.key === 'Delete') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}
