import { useCallback, useState } from 'react';

/**
 * "Back to page 12" after a big jump (a scrub or a contents entry), as in Books.
 * The jump history (⌘[) does the going back; the chip only names where it goes.
 * It stays until it is used, the reader turns a page, or history runs out.
 */
export function useBackChip(canGoBack: boolean) {
  const [label, setLabel] = useState<string | null>(null);
  const offer = useCallback((origin: string) => setLabel(origin), []);
  const dismiss = useCallback(() => setLabel(null), []);
  return { label: canGoBack ? label : null, offer, dismiss };
}

export type BackChip = ReturnType<typeof useBackChip>;
