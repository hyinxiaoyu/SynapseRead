import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  allNewBookmarkIndices,
  buildImportDecisions,
  type EditableBookDecision,
  formatImportActionSummary,
  toggleBookBookmarks,
  toggleBookFile,
  toggleBookPosition,
  toggleSingleBookmark,
} from '@/features/lanSync/importDecisions';
import {
  describeLanError,
  formatBytes,
  formatCatalogFormatLabel,
} from '@/features/lanSync/lanSyncCopy';
import { describeSyncPositionSummary } from '@/features/reader/resumeLocation';
import { cn } from '@/lib/utils';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type {
  BookmarkPlanSkipReason,
  BookPlanSummary,
  BookSyncState,
  LanImportPlanResult,
} from '@/types/domain';

const FATAL_SESSION_ERROR_CODES = new Set([
  'lan_auth_expired',
  'lan_source_stopped',
  'lan_network_changed',
]);

function formatBookmarkSkipReason(reason: BookmarkPlanSkipReason): string {
  switch (reason.kind) {
    case 'invalidAnchor':
      return 'Invalid bookmark location';
    case 'formatMismatch':
      return 'Bookmark format does not match local book';
    case 'anchorLimitExceeded':
      return 'Bookmark location exceeds size limits';
    case 'bookmarkCapExceeded':
      return 'Bookmark limit reached for this book';
    case 'unsupportedAnchor':
      return reason.reason || 'Bookmark location is not supported';
  }
}

function previewSyncBadge(state: BookSyncState): { label: string; className: string } {
  switch (state) {
    case 'new':
      return {
        label: 'New',
        className: 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100',
      };
    case 'alreadyPresent':
      return {
        label: 'On this device',
        className: 'bg-muted text-foreground',
      };
    case 'missingFile':
      return {
        label: 'File missing',
        className: 'bg-amber-500/20 text-amber-950 dark:text-amber-100',
      };
    case 'sameTitleDifferentVersion':
      return {
        label: 'Same title, different version',
        className: 'bg-amber-500/20 text-amber-950 dark:text-amber-100',
      };
    case 'localFileChanged':
      return {
        label: 'Local file changed',
        className: 'bg-red-500/15 text-red-900 dark:text-red-100',
      };
    case 'sourceUnavailable':
      return {
        label: 'Unavailable on source',
        className: 'bg-red-500/15 text-red-900 dark:text-red-100',
      };
    case 'formatMismatch':
      return {
        label: 'Unsupported format',
        className: 'bg-red-500/15 text-red-900 dark:text-red-100',
      };
  }
}

function fileCheckboxLabel(state: BookSyncState): string | null {
  switch (state) {
    case 'new':
      return 'Download book';
    case 'missingFile':
      return 'Download and restore file';
    case 'sameTitleDifferentVersion':
      return 'Download as a separate version';
    default:
      return null;
  }
}

function ineligibleReasonMessage(book: BookPlanSummary): string {
  if (book.planError) {
    return describeLanError(book.planError).detail;
  }
  switch (book.state) {
    case 'localFileChanged':
      return 'Local file changed. Open this book to resolve the change first.';
    case 'sourceUnavailable':
      return 'This book file is missing or unreadable on the source device.';
    case 'formatMismatch':
      return 'This format is not supported for import on this device.';
    default:
      return 'This book cannot be imported right now.';
  }
}

export function LanImportPreviewStep({
  plan,
  decisionsMap,
  isPreparingCloseFlush,
  onUpdateDecision,
}: {
  plan: LanImportPlanResult;
  decisionsMap: Readonly<Record<string, EditableBookDecision>>;
  isPreparingCloseFlush: boolean;
  onUpdateDecision: (bookId: string, next: EditableBookDecision) => void;
}) {
  const documents = useStudySyncStore((state) => state.documents);
  const openDocumentIds = useStudySyncStore((state) => state.openDocumentIds);
  const session = useStudySyncStore((state) => state.lanImport.session);
  const error = useStudySyncStore((state) => state.lanImport.error);
  const disconnectLanImport = useStudySyncStore((state) => state.disconnectLanImport);
  const clearLanImportError = useStudySyncStore((state) => state.clearLanImportError);

  const [expandedBookmarks, setExpandedBookmarks] = useState<ReadonlySet<string>>(() => new Set());

  const documentsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const openDocSet = useMemo(() => new Set(openDocumentIds), [openDocumentIds]);

  const booksNeedingCloseFlush = useMemo(() => {
    return plan.summary.books.filter((book) => {
      if (book.localDocumentId === null || !openDocSet.has(book.localDocumentId)) {
        return false;
      }
      const decision = decisionsMap[book.bookId];
      return decision?.importPosition === true;
    });
  }, [decisionsMap, openDocSet, plan.summary.books]);

  const toggleExpandBookmarks = (bookId: string) => {
    setExpandedBookmarks((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  };

  const errorPresentation = error ? describeLanError(error) : null;
  const isFatalSessionError = error !== null && FATAL_SESSION_ERROR_CODES.has(error.code);

  return (
    <div className="space-y-4 text-sm">
      {session && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground">
          <span>
            Review changes from{' '}
            <span className="font-mono font-semibold text-foreground">{session.address}</span>
          </span>
          <span>
            Nothing is modified until you click <strong className="text-foreground">Import</strong>.
          </span>
        </div>
      )}

      {errorPresentation && error && (
        <div
          role="alert"
          data-testid="lan-import-preview-error"
          data-error-code={error.code}
          className="space-y-1.5 rounded-md border border-red-600/40 bg-red-500/10 p-3 text-xs"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-red-900 dark:text-red-100">
              {errorPresentation.title}
            </p>
            <button
              type="button"
              className="text-foreground underline hover:opacity-80"
              onClick={clearLanImportError}
            >
              Dismiss
            </button>
          </div>
          <p className="text-foreground">{errorPresentation.detail}</p>
          {errorPresentation.hints.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-foreground">
              {errorPresentation.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
          {isFatalSessionError && (
            <div className="pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="lan-import-preview-reconnect"
                onClick={() => void disconnectLanImport()}
              >
                Reconnect
              </Button>
            </div>
          )}
        </div>
      )}

      {booksNeedingCloseFlush.length > 0 && (
        <div
          role="note"
          data-testid="lan-import-open-book-warning"
          className="flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-0.5">
            <p className="font-semibold">
              {booksNeedingCloseFlush.length === 1
                ? '1 open book will close cleanly before importing its position'
                : `${booksNeedingCloseFlush.length} open books will close cleanly before importing their positions`}
            </p>
            <p>
              Local changes are saved first:{' '}
              {booksNeedingCloseFlush.map((book) => book.title).join(', ')}.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {plan.summary.books.map((book) => {
          const bookId = book.bookId;
          const decision = decisionsMap[bookId];
          const badge = previewSyncBadge(book.state);
          const localDoc =
            book.localDocumentId !== null
              ? (documentsById.get(book.localDocumentId) ?? null)
              : null;
          const isOpenLocally =
            book.localDocumentId !== null && openDocSet.has(book.localDocumentId);
          const positionSummary = describeSyncPositionSummary({
            localDocument: localDoc,
            position: book.position,
          });
          const fileActionLabel = fileCheckboxLabel(book.state);
          const newIndices = allNewBookmarkIndices(book);
          const bookmarksExpanded = expandedBookmarks.has(bookId);

          const metadataNeedsFile = book.needsFileDownload;
          const canSelectFile = book.eligible && fileActionLabel !== null && !isPreparingCloseFlush;
          const fileActive = decision?.importFile ?? false;
          const positionsPermitted = session?.permissions.positions ?? false;
          const bookmarksPermitted = session?.permissions.bookmarks ?? false;

          const canTogglePosition =
            book.eligible &&
            positionsPermitted &&
            book.position.remoteAvailable &&
            (!metadataNeedsFile || fileActive) &&
            !isPreparingCloseFlush;
          const canToggleBookmarks =
            book.eligible &&
            bookmarksPermitted &&
            newIndices.length > 0 &&
            (!metadataNeedsFile || fileActive) &&
            !isPreparingCloseFlush;

          return (
            <section
              key={bookId}
              data-testid="lan-import-preview-row"
              data-book-id={bookId}
              data-sync-state={book.state}
              className="space-y-3 rounded-md border bg-card p-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h3 className="truncate font-semibold text-foreground">{book.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {formatCatalogFormatLabel({
                      format: book.format,
                      rawFormat: book.format ?? book.extension,
                      extension: book.extension,
                    })}{' '}
                    · {formatBytes(book.sizeBytes)}
                  </p>
                </div>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              </div>

              {!book.eligible ? (
                <div
                  data-testid={`lan-import-preview-ineligible-${bookId}`}
                  className="rounded border border-red-600/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-900 dark:text-red-100"
                >
                  {ineligibleReasonMessage(book)}
                </div>
              ) : (
                decision && (
                  <div className="space-y-2.5 text-xs">
                    {fileActionLabel !== null ? (
                      <div className="space-y-1">
                        <label className="flex items-start gap-2 font-medium text-foreground">
                          <input
                            type="checkbox"
                            data-testid={`lan-import-file-checkbox-${bookId}`}
                            className="mt-0.5 size-4 rounded border-border accent-primary"
                            checked={decision.importFile}
                            disabled={!canSelectFile}
                            onChange={(event) =>
                              onUpdateDecision(
                                bookId,
                                toggleBookFile(book, decision, event.target.checked),
                              )
                            }
                          />
                          <span>{fileActionLabel}</span>
                        </label>
                        {book.state === 'missingFile' && (
                          <p className="pl-6 text-muted-foreground">
                            Your reading record will point to the new managed copy. Existing
                            annotations, notes, and MindMap cards stay preserved.
                          </p>
                        )}
                        {book.state === 'sameTitleDifferentVersion' && (
                          <p className="pl-6 text-amber-950 dark:text-amber-100">
                            Requires explicit confirmation: adds a separate book entry alongside
                            your existing copy without modifying your current file or reading data.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p
                        data-testid={`lan-import-file-status-${bookId}`}
                        className="font-medium text-foreground"
                      >
                        On this device — no file transfer needed
                      </p>
                    )}

                    <div className="space-y-1 rounded border bg-muted/20 p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          className={cn(
                            'flex items-center gap-2 font-medium',
                            canTogglePosition
                              ? 'text-foreground'
                              : 'cursor-not-allowed text-muted-foreground',
                          )}
                        >
                          <input
                            type="checkbox"
                            data-testid={`lan-import-position-checkbox-${bookId}`}
                            className="size-4 rounded border-border accent-primary"
                            checked={decision.importPosition}
                            disabled={!canTogglePosition}
                            onChange={(event) =>
                              onUpdateDecision(
                                bookId,
                                toggleBookPosition(book, decision, event.target.checked),
                              )
                            }
                          />
                          <span>
                            {isOpenLocally
                              ? 'Close and use source position'
                              : 'Use source reading position'}
                          </span>
                        </label>
                        {book.state === 'alreadyPresent' &&
                          positionsPermitted &&
                          book.position.remoteAvailable &&
                          !decision.importPosition && (
                            <span
                              data-testid={`lan-import-position-hint-${bookId}`}
                              className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground"
                            >
                              Keep yours
                            </span>
                          )}
                      </div>
                      <div className="space-y-0.5 pl-6 text-muted-foreground">
                        {book.state === 'alreadyPresent' || book.state === 'missingFile' ? (
                          <>
                            <p>Local: {positionSummary.localLabel}</p>
                            <p>Source: {positionSummary.remoteLabel}</p>
                          </>
                        ) : (
                          <p>Source: {positionSummary.remoteLabel}</p>
                        )}
                        {!positionsPermitted ? (
                          <p>Reading positions were not included in this share session.</p>
                        ) : (
                          positionSummary.statusNote && (
                            <p
                              data-testid={`lan-import-position-note-${bookId}`}
                              className="font-medium text-foreground"
                            >
                              {positionSummary.statusNote}
                            </p>
                          )
                        )}
                        {metadataNeedsFile &&
                          !fileActive &&
                          positionsPermitted &&
                          book.position.remoteAvailable && (
                            <p>Select &ldquo;{fileActionLabel}&rdquo; above to import position.</p>
                          )}
                      </div>
                    </div>

                    <div className="space-y-1.5 rounded border bg-muted/20 p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          className={cn(
                            'flex items-center gap-2 font-medium',
                            canToggleBookmarks
                              ? 'text-foreground'
                              : 'cursor-not-allowed text-muted-foreground',
                          )}
                        >
                          <input
                            type="checkbox"
                            data-testid={`lan-import-bookmarks-checkbox-${bookId}`}
                            className="size-4 rounded border-border accent-primary"
                            checked={
                              decision.importBookmarks &&
                              decision.selectedBookmarkIndices.length > 0
                            }
                            disabled={!canToggleBookmarks}
                            onChange={(event) =>
                              onUpdateDecision(
                                bookId,
                                toggleBookBookmarks(book, decision, event.target.checked),
                              )
                            }
                          />
                          <span>
                            Import bookmarks (
                            {decision.importBookmarks ? decision.selectedBookmarkIndices.length : 0}{' '}
                            of {newIndices.length} new selected)
                          </span>
                        </label>

                        {bookmarksPermitted && book.bookmarks.entries.length > 0 && (
                          <button
                            type="button"
                            data-testid={`lan-import-bookmarks-toggle-${bookId}`}
                            aria-expanded={bookmarksExpanded}
                            className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline hover:opacity-80"
                            onClick={() => toggleExpandBookmarks(bookId)}
                          >
                            {bookmarksExpanded ? (
                              <>
                                <ChevronDown className="size-3.5" />
                                Hide bookmarks ({book.bookmarks.entries.length})
                              </>
                            ) : (
                              <>
                                <ChevronRight className="size-3.5" />
                                Show bookmarks ({book.bookmarks.entries.length})
                              </>
                            )}
                          </button>
                        )}
                      </div>

                      <div className="pl-6 text-muted-foreground">
                        {!bookmarksPermitted ? (
                          <p>Bookmarks were not included in this share session.</p>
                        ) : book.bookmarks.entries.length === 0 ? (
                          <p>No bookmarks on source book.</p>
                        ) : (
                          <p>
                            {book.bookmarks.newCount} new · {book.bookmarks.existingCount} already
                            on device
                            {book.bookmarks.skippedCount > 0
                              ? ` · ${book.bookmarks.skippedCount} skipped`
                              : ''}
                          </p>
                        )}
                        {metadataNeedsFile &&
                          !fileActive &&
                          bookmarksPermitted &&
                          newIndices.length > 0 && (
                            <p>Select &ldquo;{fileActionLabel}&rdquo; above to import bookmarks.</p>
                          )}
                      </div>

                      {bookmarksExpanded &&
                        bookmarksPermitted &&
                        book.bookmarks.entries.length > 0 && (
                          <ul
                            data-testid={`lan-import-bookmarks-list-${bookId}`}
                            className="mt-2 space-y-1.5 border-t pt-2 pl-6"
                          >
                            {book.bookmarks.entries.map((item) => {
                              const selected =
                                decision.importBookmarks &&
                                decision.selectedBookmarkIndices.includes(item.index);
                              if (item.status.status === 'new') {
                                return (
                                  <li key={item.index} className="flex items-start gap-2">
                                    <input
                                      type="checkbox"
                                      data-testid={`lan-import-bookmark-checkbox-${bookId}-${item.index}`}
                                      className="mt-0.5 size-3.5 rounded border-border accent-primary"
                                      checked={selected}
                                      disabled={!canToggleBookmarks}
                                      onChange={() =>
                                        onUpdateDecision(
                                          bookId,
                                          toggleSingleBookmark(book, decision, item.index),
                                        )
                                      }
                                    />
                                    <span className="text-foreground">
                                      {item.label || `Bookmark ${item.index + 1}`}
                                    </span>
                                  </li>
                                );
                              }
                              if (item.status.status === 'existing') {
                                return (
                                  <li
                                    key={item.index}
                                    className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"
                                  >
                                    <span>{item.label || `Bookmark ${item.index + 1}`}</span>
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                                      Already on device
                                    </span>
                                  </li>
                                );
                              }
                              return (
                                <li
                                  key={item.index}
                                  className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"
                                >
                                  <span>{item.label || `Bookmark ${item.index + 1}`}</span>
                                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-950 dark:text-amber-100">
                                    {formatBookmarkSkipReason(item.status.reason)}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                    </div>
                  </div>
                )
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function LanImportPreviewFooter({
  plan,
  decisionsMap,
  isBusy,
  onBackToCatalog,
  onDisconnect,
  onStartImport,
}: {
  plan: LanImportPlanResult;
  decisionsMap: Readonly<Record<string, EditableBookDecision>>;
  isBusy: boolean;
  onBackToCatalog: () => void;
  onDisconnect: () => void;
  onStartImport: () => void;
}) {
  const actionableCount = useMemo(
    () => buildImportDecisions(plan, decisionsMap).length,
    [decisionsMap, plan],
  );
  const summaryText = useMemo(
    () => formatImportActionSummary(plan, decisionsMap),
    [decisionsMap, plan],
  );

  return (
    <>
      <span data-testid="lan-import-action-summary" className="text-xs text-muted-foreground">
        {summaryText}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="lan-import-preview-back"
          disabled={isBusy}
          onClick={onBackToCatalog}
        >
          Back to catalog
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="lan-import-preview-disconnect"
          disabled={isBusy}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="lan-import-start-execute"
          disabled={isBusy || actionableCount === 0}
          onClick={onStartImport}
        >
          {isBusy ? 'Preparing…' : 'Import'}
        </Button>
      </div>
    </>
  );
}
