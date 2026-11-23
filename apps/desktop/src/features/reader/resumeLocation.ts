import { defaultBookmarkLabel, type PositionPlanSummary, type StudyDocument } from '@/types/domain';

export function formatProgressPercent(progress: number | null | undefined): string | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
}

export function describeResumeLocation(
  document: Pick<StudyDocument, 'lastCursorAnchor' | 'lastProgress'>,
): string {
  const anchor = document.lastCursorAnchor;
  if (!anchor) return 'Start reading';
  const percent = formatProgressPercent(document.lastProgress);
  // An EPUB position is a chapter file name, which means nothing to a reader, so
  // it says only how far in the reader is, once the book's text has been measured.
  if (anchor.format === 'epub')
    return percent ? `Continue reading · ${percent}` : 'Continue reading';
  const place = defaultBookmarkLabel(anchor);
  return `Continue reading · ${percent ? `${place} · ${percent}` : place}`;
}

export interface SyncPositionSummaryPresentation {
  localLabel: string;
  remoteLabel: string;
  statusNote: string | null;
}

/**
 * Reader-owned position summary for LAN sync preview (`F-20`), keeping
 * `AnchorLocation` fields opaque outside `features/reader/`.
 */
export function describeSyncPositionSummary({
  localDocument,
  position,
}: {
  localDocument: Pick<StudyDocument, 'lastCursorAnchor' | 'lastProgress'> | null;
  position: PositionPlanSummary;
}): SyncPositionSummaryPresentation {
  let localLabel: string;
  if (localDocument && localDocument.lastCursorAnchor !== null) {
    localLabel = describeResumeLocation(localDocument);
  } else if (position.localHasPosition) {
    const percent = formatProgressPercent(position.localProgress);
    localLabel = percent ? `Continue reading · ${percent}` : 'Continue reading';
  } else {
    localLabel = 'Not started';
  }

  let remoteLabel: string;
  if (!position.remoteAvailable) {
    remoteLabel = 'No saved position';
  } else {
    const percent = formatProgressPercent(position.remoteProgress);
    remoteLabel = percent ? `Continue reading · ${percent}` : 'Continue reading';
  }

  let statusNote: string | null = null;
  if (position.skippedReason) {
    statusNote = position.skippedReason;
  } else if (position.remoteAvailable) {
    statusNote = position.differs
      ? 'Different reading position on source device'
      : 'Matches your current reading position';
  }

  return { localLabel, remoteLabel, statusNote };
}

/**
 * Reader-owned summary of the receiver's newly flushed cursor after a
 * `lan_position_conflict` (`F-20`, `T-30`).
 */
export function describeConflictCurrentPosition({
  localDocument,
  hasCurrentPosition,
  currentProgress,
}: {
  localDocument: Pick<StudyDocument, 'lastCursorAnchor' | 'lastProgress'> | null;
  hasCurrentPosition: boolean;
  currentProgress: number | null;
}): string {
  if (!hasCurrentPosition) return 'Not started';
  // Prefer the rich anchor label only when `localDocument` reflects the same
  // newly flushed progress reported by the conflict outcome; otherwise use
  // the authoritative server `currentProgress` so stale store state never wins.
  if (
    localDocument &&
    localDocument.lastCursorAnchor !== null &&
    (localDocument.lastProgress ?? null) === currentProgress
  ) {
    return describeResumeLocation(localDocument);
  }
  const percent = formatProgressPercent(currentProgress);
  return percent ? `Continue reading · ${percent}` : 'Continue reading';
}
