import { useSyncExternalStore } from 'react';

import { resolveReadingTheme } from '@/features/reader/appearance/themes';
import type { ReadingTheme, ResolvedReadingTheme } from '@/types/domain';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;

function subscribe(onChange: () => void): () => void {
  const query = darkQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

const prefersDark = (): boolean => darkQuery()?.matches ?? false;

/** Whether the system appearance is dark; updates live when it changes. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribe, prefersDark, () => false);
}

/** The reading theme with `auto` settled against the system appearance. */
export function useResolvedReadingTheme(theme: ReadingTheme): ResolvedReadingTheme {
  return resolveReadingTheme(theme, usePrefersDark());
}
