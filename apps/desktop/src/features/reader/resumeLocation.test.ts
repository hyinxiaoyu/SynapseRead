import { describe, expect, it } from 'vitest';

import {
  describeConflictCurrentPosition,
  describeResumeLocation,
  describeSyncPositionSummary,
} from '@/features/reader/resumeLocation';
import type { PositionPlanSummary, StudyDocument } from '@/types/domain';

function makeDoc(
  overrides: Partial<Pick<StudyDocument, 'lastCursorAnchor' | 'lastProgress'>> = {},
): Pick<StudyDocument, 'lastCursorAnchor' | 'lastProgress'> {
  return {
    lastCursorAnchor: null,
    lastProgress: null,
    ...overrides,
  };
}

describe('resumeLocation', () => {
  it('summarizes unmeasured EPUB positions and surfaces Rust differs flag clearly (F-20)', () => {
    const position: PositionPlanSummary = {
      remoteAvailable: true,
      remoteProgress: null,
      localHasPosition: true,
      localProgress: null,
      differs: true,
      defaultAdopt: false,
    };
    const localDoc = makeDoc({
      lastCursorAnchor: {
        format: 'epub',
        cfiRange: 'epubcfi(/6/4!/4/2)',
        chapterHref: 'chapter2.xhtml',
      },
      lastProgress: null,
    });

    const summary = describeSyncPositionSummary({ localDocument: localDoc, position });
    expect(summary.localLabel).toBe('Continue reading');
    expect(summary.remoteLabel).toBe('Continue reading');
    expect(summary.statusNote).toBe('Different reading position on source device');
  });

  it('reports matching and missing positions cleanly across formats', () => {
    const localDoc = makeDoc({
      lastCursorAnchor: {
        format: 'pdf',
        pageIndex: 4,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
      },
      lastProgress: 0.4,
    });
    expect(describeResumeLocation(localDoc)).toBe('Continue reading · Page 5 · 40%');

    const matching = describeSyncPositionSummary({
      localDocument: localDoc,
      position: {
        remoteAvailable: true,
        remoteProgress: 0.4,
        localHasPosition: true,
        localProgress: 0.4,
        differs: false,
        defaultAdopt: false,
      },
    });
    expect(matching.localLabel).toBe('Continue reading · Page 5 · 40%');
    expect(matching.remoteLabel).toBe('Continue reading · 40%');
    expect(matching.statusNote).toBe('Matches your current reading position');

    const conflictLabel = describeConflictCurrentPosition({
      localDocument: localDoc,
      hasCurrentPosition: true,
      currentProgress: 0.4,
    });
    expect(conflictLabel).toBe('Continue reading · Page 5 · 40%');
    expect(
      describeConflictCurrentPosition({
        localDocument: localDoc,
        hasCurrentPosition: true,
        currentProgress: 0.72,
      }),
    ).toBe('Continue reading · 72%');
    expect(
      describeConflictCurrentPosition({
        localDocument: null,
        hasCurrentPosition: false,
        currentProgress: null,
      }),
    ).toBe('Not started');
  });
});
