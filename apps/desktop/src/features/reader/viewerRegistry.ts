import type { ComponentType } from 'react';

import { EnginePendingViewer } from '@/features/reader/EnginePendingViewer';
import { PdfViewer } from '@/features/reader/pdf/PdfViewer';
import { TxtViewer } from '@/features/reader/txt/TxtViewer';
import type { DocumentFormat, DocumentViewerProps } from '@/types/domain';

/**
 * Maps each format to its engine; this is the only place readers are wired in.
 * The remaining pending entries are replaced as their engines land. Markdown
 * stays reserved until V1.1.
 */
const pending = <F extends DocumentFormat>() =>
  EnginePendingViewer as unknown as ComponentType<DocumentViewerProps<F>>;

export const viewerRegistry: {
  [F in DocumentFormat]: ComponentType<DocumentViewerProps<F>>;
} = {
  pdf: PdfViewer,
  epub: pending(),
  txt: TxtViewer,
  md: pending(),
};
