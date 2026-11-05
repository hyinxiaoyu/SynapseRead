import type { ComponentType } from 'react';

import { EpubViewer } from '@/features/reader/epub/EpubViewer';
import { PdfViewer } from '@/features/reader/pdf/PdfViewer';
import { TxtViewer } from '@/features/reader/txt/TxtViewer';
import { UnsupportedFormatViewer } from '@/features/reader/UnsupportedFormatViewer';
import type { DocumentFormat, DocumentViewerProps } from '@/types/domain';

/**
 * Maps each format to its engine; this is the only place readers are wired in.
 * Markdown stays reserved until V1.1.
 */
export const viewerRegistry: {
  [F in DocumentFormat]: ComponentType<DocumentViewerProps<F>>;
} = {
  pdf: PdfViewer,
  epub: EpubViewer,
  txt: TxtViewer,
  md: UnsupportedFormatViewer,
};
