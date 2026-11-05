import type { ComponentType } from 'react';

import { EnginePendingViewer } from '@/features/reader/EnginePendingViewer';
import type { DocumentFormat, DocumentViewerProps } from '@/types/domain';

/**
 * Maps each format to its engine; this is the only place readers are wired in.
 * Phase 2 replaces the pdf/epub/txt entries. Markdown stays reserved until V1.1.
 */
export const viewerRegistry: Record<DocumentFormat, ComponentType<DocumentViewerProps>> = {
  pdf: EnginePendingViewer,
  epub: EnginePendingViewer,
  txt: EnginePendingViewer,
  md: EnginePendingViewer,
};
