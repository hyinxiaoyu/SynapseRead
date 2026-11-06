import type { CSSProperties } from 'react';

import { readerChromeStyle } from '@/features/reader/appearance/themes';
import { useResolvedReadingTheme } from '@/features/reader/appearance/useResolvedTheme';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { ResolvedReadingTheme } from '@/types/domain';

/**
 * The reading theme the reader's chrome takes: the active document's, when it
 * reflows. PDF pages keep their own colors, so their chrome follows the system,
 * as Preview's does. The MindMap and inspector never take it.
 */
export function useReaderChromeTheme(): {
  theme: ResolvedReadingTheme | null;
  style: CSSProperties | undefined;
} {
  const reflowable = useStudySyncStore((state) => {
    const active = state.documents.find((document) => document.id === state.activeDocumentId);
    return active !== undefined && active.format !== 'pdf';
  });
  const resolved = useResolvedReadingTheme(
    useStudySyncStore((state) => state.readingPreferences.theme),
  );
  const theme = reflowable ? resolved : null;
  return { theme, style: theme ? readerChromeStyle(theme) : undefined };
}
