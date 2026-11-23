import type {
  BookImportDecision,
  BookPlanSummary,
  LanBookImportResult,
  LanComponentOutcome,
  LanImportExecutionReport,
  LanImportPlanResult,
} from '@/types/domain';

export interface EditableBookDecision {
  bookId: string;
  importFile: boolean;
  importPosition: boolean;
  importBookmarks: boolean;
  selectedBookmarkIndices: number[];
}

export function allNewBookmarkIndices(book: BookPlanSummary): number[] {
  return book.bookmarks.entries
    .filter((entry) => entry.status.status === 'new')
    .map((entry) => entry.index);
}

export function createInitialDecisions(
  plan: LanImportPlanResult,
): Record<string, EditableBookDecision> {
  const byId: Record<string, EditableBookDecision> = {};
  for (const book of plan.summary.books) {
    const newIndices = allNewBookmarkIndices(book);
    if (!book.eligible) {
      byId[book.bookId] = {
        bookId: book.bookId,
        importFile: false,
        importPosition: false,
        importBookmarks: false,
        selectedBookmarkIndices: [],
      };
      continue;
    }

    // §2.3: "Same title, different version" starts unchecked and requires explicit
    // confirmation; position and bookmarks follow the file toggle.
    if (book.state === 'sameTitleDifferentVersion') {
      byId[book.bookId] = {
        bookId: book.bookId,
        importFile: false,
        importPosition: false,
        importBookmarks: false,
        selectedBookmarkIndices: newIndices,
      };
      continue;
    }

    const defaultDecision = plan.defaultDecisions.find((item) => item.bookId === book.bookId);
    const importFile = book.needsFileDownload ? (defaultDecision?.importFile ?? true) : false;
    const fileActive = !book.needsFileDownload || importFile;
    const importPosition =
      fileActive &&
      book.position.remoteAvailable &&
      (defaultDecision?.importPosition ?? book.position.defaultAdopt);
    const importBookmarks =
      fileActive &&
      newIndices.length > 0 &&
      (defaultDecision?.importBookmarks ?? book.bookmarks.defaultImport);

    byId[book.bookId] = {
      bookId: book.bookId,
      importFile,
      importPosition,
      importBookmarks,
      selectedBookmarkIndices: newIndices,
    };
  }
  return byId;
}

export function toggleBookFile(
  book: BookPlanSummary,
  decision: EditableBookDecision,
  nextFile: boolean,
): EditableBookDecision {
  if (!book.eligible || !book.needsFileDownload) return decision;
  if (!nextFile) {
    return {
      ...decision,
      importFile: false,
      importPosition: false,
      importBookmarks: false,
    };
  }

  const newIndices = allNewBookmarkIndices(book);
  const nextIndices =
    decision.selectedBookmarkIndices.length > 0 ? decision.selectedBookmarkIndices : newIndices;
  return {
    ...decision,
    importFile: true,
    importPosition: book.position.remoteAvailable && book.position.defaultAdopt,
    importBookmarks: book.bookmarks.defaultImport && nextIndices.length > 0,
    selectedBookmarkIndices: nextIndices,
  };
}

export function toggleBookPosition(
  book: BookPlanSummary,
  decision: EditableBookDecision,
  nextPosition: boolean,
): EditableBookDecision {
  if (!book.eligible || !book.position.remoteAvailable) return decision;
  if (book.needsFileDownload && !decision.importFile) return decision;
  return { ...decision, importPosition: nextPosition };
}

export function toggleBookBookmarks(
  book: BookPlanSummary,
  decision: EditableBookDecision,
  nextBookmarks: boolean,
): EditableBookDecision {
  const newIndices = allNewBookmarkIndices(book);
  if (!book.eligible || newIndices.length === 0) return decision;
  if (book.needsFileDownload && !decision.importFile) return decision;
  if (!nextBookmarks) {
    return { ...decision, importBookmarks: false };
  }
  const nextIndices =
    decision.selectedBookmarkIndices.length > 0 ? decision.selectedBookmarkIndices : newIndices;
  return {
    ...decision,
    importBookmarks: true,
    selectedBookmarkIndices: nextIndices,
  };
}

export function toggleSingleBookmark(
  book: BookPlanSummary,
  decision: EditableBookDecision,
  bookmarkIndex: number,
): EditableBookDecision {
  if (!book.eligible) return decision;
  if (book.needsFileDownload && !decision.importFile) return decision;
  const newIndices = allNewBookmarkIndices(book);
  if (!newIndices.includes(bookmarkIndex)) return decision;

  const selected = new Set(decision.importBookmarks ? decision.selectedBookmarkIndices : []);
  if (selected.has(bookmarkIndex)) {
    selected.delete(bookmarkIndex);
  } else {
    selected.add(bookmarkIndex);
  }
  const ordered = newIndices.filter((index) => selected.has(index));
  return {
    ...decision,
    importBookmarks: ordered.length > 0,
    selectedBookmarkIndices: ordered,
  };
}

export function buildImportDecisions(
  plan: LanImportPlanResult,
  decisionsMap: Readonly<Record<string, EditableBookDecision>>,
): BookImportDecision[] {
  const decisions: BookImportDecision[] = [];
  for (const book of plan.summary.books) {
    if (!book.eligible) continue;
    const editable = decisionsMap[book.bookId];
    if (!editable) continue;
    const importFile = book.needsFileDownload && editable.importFile;
    const fileActive = !book.needsFileDownload || importFile;
    const importPosition = fileActive && book.position.remoteAvailable && editable.importPosition;
    const newIndices = allNewBookmarkIndices(book);
    const importBookmarks =
      fileActive &&
      newIndices.length > 0 &&
      editable.importBookmarks &&
      editable.selectedBookmarkIndices.length > 0;

    if (!importFile && !importPosition && !importBookmarks) continue;

    const decision: BookImportDecision = {
      bookId: book.bookId,
      importFile,
      importPosition,
      importBookmarks,
      overridePositionConflict: false,
    };
    if (importBookmarks && editable.selectedBookmarkIndices.length < newIndices.length) {
      decision.selectedBookmarkIndices = editable.selectedBookmarkIndices;
    }
    decisions.push(decision);
  }
  return decisions;
}

const plural = (count: number, singular: string, pluralWord = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralWord}`;

export function formatImportActionSummary(
  plan: LanImportPlanResult,
  decisionsMap: Readonly<Record<string, EditableBookDecision>>,
): string {
  let downloadCount = 0;
  let restoreCount = 0;
  let positionCount = 0;
  let bookmarkCount = 0;

  for (const book of plan.summary.books) {
    if (!book.eligible) continue;
    const decision = decisionsMap[book.bookId];
    if (!decision) continue;
    const importFile = book.needsFileDownload && decision.importFile;
    const fileActive = !book.needsFileDownload || importFile;

    if (importFile) {
      if (book.state === 'missingFile') {
        restoreCount += 1;
      } else {
        downloadCount += 1;
      }
    }
    if (fileActive && book.position.remoteAvailable && decision.importPosition) {
      positionCount += 1;
    }
    if (fileActive && decision.importBookmarks) {
      bookmarkCount += decision.selectedBookmarkIndices.length;
    }
  }

  const parts: string[] = [];
  if (downloadCount > 0) parts.push(`Download ${plural(downloadCount, 'book')}`);
  if (restoreCount > 0) parts.push(`restore ${plural(restoreCount, 'file')}`);
  if (positionCount > 0) parts.push(`use ${plural(positionCount, 'source position')}`);
  if (bookmarkCount > 0) parts.push(`add ${plural(bookmarkCount, 'bookmark')}`);

  if (parts.length === 0) return 'No changes selected';
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function collectOpenDocumentIdsForPositionImport(
  plan: LanImportPlanResult,
  decisions: readonly BookImportDecision[],
  openDocumentIds: readonly string[],
): string[] {
  const openSet = new Set(openDocumentIds);
  const targets = new Set<string>();
  for (const decision of decisions) {
    if (!decision.importPosition) continue;
    const summary = plan.summary.books.find((book) => book.bookId === decision.bookId);
    if (summary?.localDocumentId && openSet.has(summary.localDocumentId)) {
      targets.add(summary.localDocumentId);
    }
  }
  return [...targets];
}

function outcomeNeedsRetry(outcome: LanComponentOutcome): boolean {
  return outcome.status === 'failed' || outcome.status === 'cancelled';
}

function resultNeedsRetry(result: LanBookImportResult): boolean {
  return (
    outcomeNeedsRetry(result.file) ||
    outcomeNeedsRetry(result.position) ||
    outcomeNeedsRetry(result.bookmarks)
  );
}

export function buildRetryFailedDecisions(
  report: LanImportExecutionReport,
  lastDecisions: readonly BookImportDecision[],
): BookImportDecision[] {
  const resultsById = new Map(report.books.map((book) => [book.bookId, book]));
  const retries: BookImportDecision[] = [];

  for (const prev of lastDecisions) {
    const result = resultsById.get(prev.bookId);
    if (!result) {
      // Rust stops iterating on cancellation, leaving remaining books unexecuted.
      retries.push({ ...prev, overridePositionConflict: false });
      continue;
    }
    if (!resultNeedsRetry(result)) continue;

    const retryFile = prev.importFile && result.file.status !== 'applied';
    const retryPosition =
      prev.importPosition &&
      result.position.status !== 'applied' &&
      result.position.status !== 'conflict';
    const retryBookmarks = prev.importBookmarks && result.bookmarks.status !== 'applied';

    if (!retryFile && !retryPosition && !retryBookmarks) continue;

    const decision: BookImportDecision = {
      bookId: prev.bookId,
      importFile: retryFile,
      importPosition: retryPosition,
      importBookmarks: retryBookmarks,
      overridePositionConflict: false,
    };
    if (retryBookmarks && prev.selectedBookmarkIndices !== undefined) {
      decision.selectedBookmarkIndices = prev.selectedBookmarkIndices;
    }
    retries.push(decision);
  }

  return retries;
}

export function buildConflictOverrideDecision(bookId: string): BookImportDecision {
  return {
    bookId,
    importFile: false,
    importPosition: true,
    importBookmarks: false,
    overridePositionConflict: true,
  };
}

export function mergeExecutionReports(
  previous: LanImportExecutionReport | null,
  next: LanImportExecutionReport,
  mode: 'batch' | 'conflictOverride',
): LanImportExecutionReport {
  if (!previous) return next;
  const merged = new Map(previous.books.map((book) => [book.bookId, book]));
  for (const updated of next.books) {
    const existing = merged.get(updated.bookId);
    if (existing && mode === 'conflictOverride') {
      merged.set(updated.bookId, {
        ...existing,
        documentId: updated.documentId ?? existing.documentId,
        state: updated.state,
        position: updated.position,
      });
    } else if (existing) {
      merged.set(updated.bookId, {
        ...updated,
        documentId: updated.documentId ?? existing.documentId,
        file:
          updated.file.status === 'skipped' && existing.file.status === 'applied'
            ? existing.file
            : updated.file,
        position:
          updated.position.status === 'skipped' && existing.position.status === 'applied'
            ? existing.position
            : updated.position,
        bookmarks:
          updated.bookmarks.status === 'skipped' && existing.bookmarks.status === 'applied'
            ? existing.bookmarks
            : updated.bookmarks,
        bookmarkCounts:
          updated.bookmarks.status === 'skipped' && existing.bookmarks.status === 'applied'
            ? existing.bookmarkCounts
            : updated.bookmarkCounts,
      });
    } else {
      merged.set(updated.bookId, updated);
    }
  }
  const report: LanImportExecutionReport = {
    books: [...merged.values()],
    cancelled: next.cancelled,
  };
  if (next.sessionError !== undefined) {
    report.sessionError = next.sessionError;
  }
  return report;
}
