import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { LinkPeekTarget } from '@/features/reader/markup/LinkPeek';

/** A peek that has started: it shows its card, or learns it should jump, only while current. */
export interface LinkPeekRequest<T> {
  /**
   * Shows `peek`, or nothing for null, and returns whether the request was still
   * current. A request that was not does nothing, so the caller must not jump either.
   */
  finish(peek: T | null): boolean;
}

/**
 * The card a reader shows beside a link (#49), and the rules for when it goes away.
 *
 * A card belongs to the page it was opened on. When `context` changes (the tab goes
 * to the background, the page turns, the zoom or layout changes) the card closes, and
 * so does any peek still reading its text, which would otherwise open a card after
 * the reader moved on. Readers build `context` from whatever moves the link without
 * a scroll event, which the card already closes on.
 */
export function useLinkPeek<T extends LinkPeekTarget>(context: string) {
  const [peek, setPeek] = useState<T | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);

  // Clearing during render, not in an effect, so a stale card never paints.
  const [seenContext, setSeenContext] = useState(context);
  if (seenContext !== context) {
    setSeenContext(context);
    setPeek(null);
    setPending(false);
  }
  // A layout effect, so a peek resolving right after the commit already sees it.
  useLayoutEffect(() => {
    request.current += 1;
  }, [context]);

  const dismiss = useCallback(() => {
    request.current += 1;
    setPeek(null);
    setPending(false);
  }, []);

  const begin = useCallback((): LinkPeekRequest<T> => {
    request.current += 1;
    const ticket = request.current;
    setPending(true);
    return {
      finish(next) {
        if (ticket !== request.current) return false;
        setPending(false);
        setPeek(next);
        return true;
      },
    };
  }, []);

  // While the text is still being read there is no card to listen for presses or
  // scrolls, so the reader's next move is heard here and cancels the peek.
  useEffect(() => {
    if (!pending) return;
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [pending, dismiss]);

  return { peek, begin, dismiss };
}
