import { useEffect, useLayoutEffect, useRef } from 'react';

import { isEditableShortcutTarget } from '@/features/commands/registry';
import { ANNOTATION_COLORS } from '@/features/reader/markup/palette';

/** The color a bare digit stands for while a selection popover is open, or null. */
export function colorForDigit(key: string): string | null {
  if (key.length !== 1 || key < '0' || key > '9') return null;
  const index = Number(key);
  if (!Number.isInteger(index) || index < 1 || index > ANNOTATION_COLORS.length) return null;
  return ANNOTATION_COLORS[index - 1]?.value ?? null;
}

type ColorPicked = (color: string) => void;
type ReadColorPicker = () => ColorPicked | null;

const pickers = new Set<ReadColorPicker>();
let listenerInstalled = false;

/**
 * Bare 1–5 choose a highlight color while a selection popover is open, wherever
 * the keyboard focus is: the page, the popover itself, or a chapter's iframe.
 * Modified keys belong to commands, and a field being typed in keeps its digits.
 */
export function dispatchColorShortcut(event: KeyboardEvent): boolean {
  // Auto-repeat would make a second highlight before the first popover closes.
  if (event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  const color = colorForDigit(event.key);
  if (color === null) return false;
  for (const read of pickers) {
    const pick = read();
    if (pick === null) continue;
    pick(color);
    return true;
  }
  return false;
}

/** One window listener for every open popover, installed with the first one. */
function ensureListener() {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('keydown', (event) => {
    if (dispatchColorShortcut(event)) event.preventDefault();
  });
}

function registerColorPicker(read: ReadColorPicker): () => void {
  pickers.add(read);
  ensureListener();
  return () => pickers.delete(read);
}

/** Picks a color with 1–5 while `pick` is not null (the popover is showing). */
export function useColorShortcut(pick: ColorPicked | null) {
  const latest = useRef(pick);
  useLayoutEffect(() => {
    latest.current = pick;
  });
  const active = pick !== null;
  useEffect(() => {
    if (!active) return;
    return registerColorPicker(() => latest.current);
  }, [active]);
}
