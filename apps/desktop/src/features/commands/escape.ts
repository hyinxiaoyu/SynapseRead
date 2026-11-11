import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * The order Esc puts things away in, innermost first. A layer that is open and
 * accepts the key consumes it; the next Esc reaches the layer below.
 *
 * Popovers opened from the toolbar (Aa, the overflow menu, Find's options) are not
 * layers: they close on their own capture-phase listener, before any of these.
 */
export const ESCAPE_LAYER = {
  noteField: 40,
  selectionPopover: 30,
  find: 20,
  focusMode: 10,
} as const;

/** Returns whether it handled the key; `false` lets the next layer down try. */
export type EscapeHandler = (event: KeyboardEvent) => boolean;

interface Layer {
  priority: number;
  read: () => EscapeHandler | null;
}

const layers: Layer[] = [];
let listenerInstalled = false;

/**
 * Offers an Esc keydown to the open layers, innermost first. The window calls it for
 * its own keys; readers whose content lives in an iframe (EPUB chapters) forward the
 * frame's keys here, since those never reach the window. Returns whether a layer took it.
 */
export function dispatchEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // Highest priority first; among equals, the most recently registered.
  const ordered = layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => b.layer.priority - a.layer.priority || b.index - a.index);
  for (const { layer } of ordered) {
    const handler = layer.read();
    if (handler?.(event)) {
      event.preventDefault();
      return true;
    }
  }
  return false;
}

function ensureListener() {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('keydown', (event) => {
    dispatchEscape(event);
  });
}

export function registerEscapeLayer(priority: number, read: () => EscapeHandler | null) {
  const layer: Layer = { priority, read };
  layers.push(layer);
  ensureListener();
  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
  };
}

/**
 * Takes part in the Esc order while `handler` is not null, for example while a
 * popover is shown. The latest handler is always the one called.
 */
export function useEscapeLayer(priority: number, handler: EscapeHandler | null) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => registerEscapeLayer(priority, () => latest.current), [priority]);
}
