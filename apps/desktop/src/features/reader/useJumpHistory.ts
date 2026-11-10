import { useCallback, useRef, useState } from 'react';

/**
 * Back and Forward through the places a reader jumped from (⌘[ and ⌘]), as in a
 * browser: a new jump clears the forward list. Entries are whatever location a
 * format can return to: a CFI, a scroll offset, a page and fraction.
 */
export function useJumpHistory<T>(isSameLocation: (a: T, b: T) => boolean = Object.is) {
  const [back, setBack] = useState<readonly T[]>([]);
  const [forward, setForward] = useState<readonly T[]>([]);

  /** Records where a jump started. Repeating the latest entry is a no-op. */
  const push = useCallback(
    (from: T) => {
      setBack((stack) => {
        const top = stack.at(-1);
        return top !== undefined && isSameLocation(top, from) ? stack : [...stack, from];
      });
      setForward([]);
    },
    [isSameLocation],
  );

  /** The location to show, having remembered `current` for Forward. */
  const goBack = (current: T): T | undefined => {
    const target = back.at(-1);
    if (target === undefined) return undefined;
    setBack(back.slice(0, -1));
    setForward([...forward, current]);
    return target;
  };

  const goForward = (current: T): T | undefined => {
    const target = forward.at(-1);
    if (target === undefined) return undefined;
    setForward(forward.slice(0, -1));
    setBack([...back, current]);
    return target;
  };

  return {
    canGoBack: back.length > 0,
    canGoForward: forward.length > 0,
    push,
    goBack,
    goForward,
  };
}

/**
 * A search is one trip through the document, not one jump per match: the first
 * step that moves the view is remembered, and the steps after it are not, so ⌘[
 * and the Back chip return to where the search started. `trip` changes when a
 * new search runs; the return value says whether this step was the trip's first
 * move, which is when the way back is offered.
 */
export function useSearchTrip<T>(push: (from: T) => void) {
  const trip = useRef<{ id: number; pushed: boolean }>({ id: -1, pushed: false });
  return useCallback(
    (id: number, from: T): boolean => {
      if (trip.current.id !== id) trip.current = { id, pushed: false };
      if (trip.current.pushed) return false;
      trip.current.pushed = true;
      push(from);
      return true;
    },
    [push],
  );
}
