import type { ComponentType } from 'react';

import { EpubViewer } from '@/features/reader/epub/EpubViewer';
import { PdfViewer } from '@/features/reader/pdf/PdfViewer';
import { TxtViewer } from '@/features/reader/txt/TxtViewer';
import { UnsupportedFormatViewer } from '@/features/reader/UnsupportedFormatViewer';
import type { DocumentFormat, DocumentViewerProps } from '@/types/domain';

/**
 * Maps each format to its engine; this is the only place readers are wired in.
 * Markdown files register as `txt` and open in the TXT engine (ADR 0007). `md`
 * stays reserved for the Markdown reader; only a legacy document holding
 * Markdown anchors can still reach the placeholder.
 */
export const viewerRegistry: {
  [F in DocumentFormat]: ComponentType<DocumentViewerProps<F>>;
} = {
  pdf: PdfViewer,
  epub: EpubViewer,
  txt: TxtViewer,
  md: UnsupportedFormatViewer,
};
