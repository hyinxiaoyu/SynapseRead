import type { CSSProperties } from 'react';

import { readerChromeStyle } from '@/features/reader/appearance/themes';
import { useResolvedReadingTheme } from '@/features/reader/appearance/useResolvedTheme';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { ResolvedReadingTheme } from '@/types/domain';

/**
 * The reading theme the reader's chrome takes: the active document's, whatever
 * its format. A PDF page keeps its own colors unless the reader turns on "Tint
 * PDF pages", which is off by default because tinting can spoil figure-heavy
 * documents; its chrome still follows the chosen theme, so the window reads as
 * one. With no document open the chrome stays the system's. The MindMap and
 * inspector never take it.
 */
export function useReaderChromeTheme(): {
  theme: ResolvedReadingTheme | null;
  style: CSSProperties | undefined;
} {
  const hasActiveDocument = useStudySyncStore((state) => state.activeDocumentId !== null);
  const resolved = useResolvedReadingTheme(
    useStudySyncStore((state) => state.readingPreferences.theme),
  );
  const theme = hasActiveDocument ? resolved : null;
  return { theme, style: theme ? readerChromeStyle(theme) : undefined };
}
