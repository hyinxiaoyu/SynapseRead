import { describe, expect, it } from 'vitest';

import {
  buildConflictOverrideDecision,
  buildImportDecisions,
  buildRetryFailedDecisions,
  collectOpenDocumentIdsForPositionImport,
  createInitialDecisions,
  formatImportActionSummary,
  mergeExecutionReports,
  toggleBookBookmarks,
  toggleBookFile,
  toggleBookPosition,
  toggleSingleBookmark,
} from '@/features/lanSync/importDecisions';
import type {
  BookPlanSummary,
  LanImportExecutionReport,
  LanImportPlanResult,
} from '@/types/domain';

function makeBook(
  overrides: Partial<BookPlanSummary> & { bookId: string; title: string },
): BookPlanSummary {
  return {
    format: 'txt',
    extension: 'txt',
    sizeBytes: 1024,
    state: 'new',
    eligible: true,
    needsFileDownload: true,
    localDocumentId: null,
    localTitle: null,
    position: {
      remoteAvailable: true,
      remoteProgress: 0.4,
      localHasPosition: false,
      localProgress: null,
      differs: true,
      defaultAdopt: true,
    },
    bookmarks: {
      newCount: 2,
      existingCount: 0,
      skippedCount: 0,
      entries: [
        { index: 0, label: 'Ch 1', createdAt: '2026-11-18T00:00:00Z', status: { status: 'new' } },
        { index: 1, label: 'Ch 2', createdAt: '2026-11-18T01:00:00Z', status: { status: 'new' } },
      ],
      defaultImport: true,
    },
    ...overrides,
  };
}

describe('importDecisions', () => {
  it('enforces §2.3 defaults, separate-version opt-in, dependency disabling, and bookmark deselection', () => {
    const newBook = makeBook({ bookId: 'b-new', title: 'New Book' });
    const missingBook = makeBook({
      bookId: 'b-missing',
      title: 'Missing Book',
      state: 'missingFile',
      localDocumentId: 'doc-missing',
      position: {
        remoteAvailable: true,
        remoteProgress: 0.5,
        localHasPosition: true,
        localProgress: 0.2,
        differs: true,
        defaultAdopt: false,
      },
      bookmarks: {
        newCount: 1,
        existingCount: 1,
        skippedCount: 0,
        entries: [
          { index: 0, label: 'Keep', createdAt: null, status: { status: 'existing' } },
          { index: 1, label: 'Add me', createdAt: null, status: { status: 'new' } },
        ],
        defaultImport: true,
      },
    });
    const presentBook = makeBook({
      bookId: 'b-present',
      title: 'Present Book',
      state: 'alreadyPresent',
      needsFileDownload: false,
      localDocumentId: 'doc-present',
      position: {
        remoteAvailable: true,
        remoteProgress: 0.7,
        localHasPosition: true,
        localProgress: 0.3,
        differs: true,
        defaultAdopt: false,
      },
    });
    const separateVersion = makeBook({
      bookId: 'b-sep',
      title: 'Separate Version',
      state: 'sameTitleDifferentVersion',
    });
    const changedBook = makeBook({
      bookId: 'b-changed',
      title: 'Changed Book',
      state: 'localFileChanged',
      eligible: false,
      needsFileDownload: false,
      localDocumentId: 'doc-changed',
    });

    const plan: LanImportPlanResult = {
      planId: 'plan-1',
      summary: { books: [newBook, missingBook, presentBook, separateVersion, changedBook] },
      defaultDecisions: [
        { bookId: 'b-new', importFile: true, importPosition: true, importBookmarks: true },
        { bookId: 'b-missing', importFile: true, importPosition: false, importBookmarks: true },
        { bookId: 'b-present', importFile: false, importPosition: false, importBookmarks: true },
      ],
    };

    let map = createInitialDecisions(plan);
    expect(map['b-new']).toMatchObject({
      importFile: true,
      importPosition: true,
      importBookmarks: true,
      selectedBookmarkIndices: [0, 1],
    });
    expect(map['b-missing']).toMatchObject({
      importFile: true,
      importPosition: false,
      importBookmarks: true,
      selectedBookmarkIndices: [1],
    });
    expect(map['b-present']).toMatchObject({
      importFile: false,
      importPosition: false,
      importBookmarks: true,
    });
    // Separate version starts unchecked until explicitly confirmed (§2.3).
    expect(map['b-sep']).toMatchObject({
      importFile: false,
      importPosition: false,
      importBookmarks: false,
    });
    expect(map['b-changed']).toMatchObject({
      importFile: false,
      importPosition: false,
      importBookmarks: false,
    });

    expect(formatImportActionSummary(plan, map)).toBe(
      'Download 1 book, restore 1 file, use 1 source position, add 5 bookmarks',
    );

    // Unchecking a required file disables position and bookmarks.
    map = { ...map, 'b-new': toggleBookFile(newBook, map['b-new']!, false) };
    expect(map['b-new']).toMatchObject({
      importFile: false,
      importPosition: false,
      importBookmarks: false,
    });
    expect(toggleBookPosition(newBook, map['b-new']!, true).importPosition).toBe(false);
    expect(toggleBookBookmarks(newBook, map['b-new']!, true).importBookmarks).toBe(false);

    // Confirming separate version enables file + position + bookmarks.
    map = { ...map, 'b-sep': toggleBookFile(separateVersion, map['b-sep']!, true) };
    expect(map['b-sep']).toMatchObject({
      importFile: true,
      importPosition: true,
      importBookmarks: true,
    });

    // Deselecting 1 of 2 new bookmarks on b-present passes explicit selectedBookmarkIndices.
    map = { ...map, 'b-present': toggleSingleBookmark(presentBook, map['b-present']!, 1) };
    expect(map['b-present']?.selectedBookmarkIndices).toEqual([0]);

    const submitted = buildImportDecisions(plan, map);
    expect(submitted).toEqual([
      {
        bookId: 'b-missing',
        importFile: true,
        importPosition: false,
        importBookmarks: true,
        overridePositionConflict: false,
      },
      {
        bookId: 'b-present',
        importFile: false,
        importPosition: false,
        importBookmarks: true,
        selectedBookmarkIndices: [0],
        overridePositionConflict: false,
      },
      {
        bookId: 'b-sep',
        importFile: true,
        importPosition: true,
        importBookmarks: true,
        overridePositionConflict: false,
      },
    ]);

    // Open-book position collection includes only open documents adopting position.
    map = { ...map, 'b-present': toggleBookPosition(presentBook, map['b-present']!, true) };
    const withOpenPresent = buildImportDecisions(plan, map);
    expect(
      collectOpenDocumentIdsForPositionImport(plan, withOpenPresent, ['doc-present', 'doc-other']),
    ).toEqual(['doc-present']);
  });

  it('builds retry decisions for failed/unexecuted books and merges conflict overrides', () => {
    const lastDecisions = [
      { bookId: 'b-ok', importFile: true, importPosition: true, importBookmarks: true },
      { bookId: 'b-fail', importFile: true, importPosition: true, importBookmarks: true },
      { bookId: 'b-unrun', importFile: true, importPosition: false, importBookmarks: true },
    ];
    const firstReport: LanImportExecutionReport = {
      cancelled: true,
      books: [
        {
          bookId: 'b-ok',
          documentId: 'doc-1',
          state: 'new',
          file: { status: 'applied' },
          position: {
            status: 'conflict',
            code: 'lan_position_conflict',
            hasCurrentPosition: true,
            currentProgress: 0.6,
          },
          bookmarks: { status: 'applied' },
          bookmarkCounts: { inserted: 2, existing: 0, skipped: 0 },
        },
        {
          bookId: 'b-fail',
          documentId: null,
          state: 'new',
          file: { status: 'cancelled' },
          position: { status: 'cancelled' },
          bookmarks: { status: 'cancelled' },
          bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
        },
      ],
    };

    const retries = buildRetryFailedDecisions(firstReport, lastDecisions);
    expect(retries.map((d) => d.bookId)).toEqual(['b-fail', 'b-unrun']);

    // Conflict override preserves earlier file/bookmarks outcomes on b-ok.
    const override = buildConflictOverrideDecision('b-ok');
    expect(override).toEqual({
      bookId: 'b-ok',
      importFile: false,
      importPosition: true,
      importBookmarks: false,
      overridePositionConflict: true,
    });
    const merged = mergeExecutionReports(
      firstReport,
      {
        cancelled: false,
        books: [
          {
            bookId: 'b-ok',
            documentId: 'doc-1',
            state: 'alreadyPresent',
            file: { status: 'skipped' },
            position: { status: 'applied' },
            bookmarks: { status: 'skipped' },
            bookmarkCounts: { inserted: 0, existing: 2, skipped: 0 },
          },
        ],
      },
      'conflictOverride',
    );
    const updatedOk = merged.books.find((b) => b.bookId === 'b-ok');
    expect(updatedOk?.file.status).toBe('applied');
    expect(updatedOk?.bookmarks.status).toBe('applied');
    expect(updatedOk?.bookmarkCounts.inserted).toBe(2);
    expect(updatedOk?.position.status).toBe('applied');
  });
});
