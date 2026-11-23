import { AlertTriangle, BookOpen, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { buildRetryFailedDecisions } from '@/features/lanSync/importDecisions';
import { describeLanError, formatBytes } from '@/features/lanSync/lanSyncCopy';
import {
  describeConflictCurrentPosition,
  describeSyncPositionSummary,
} from '@/features/reader/resumeLocation';
import { cn } from '@/lib/utils';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type {
  BookImportDecision,
  LanBookImportResult,
  LanComponentOutcome,
  LanImportExecutionReport,
  LanImportPlanResult,
} from '@/types/domain';

const FATAL_SESSION_ERROR_CODES = new Set([
  'lan_auth_expired',
  'lan_source_stopped',
  'lan_network_changed',
]);

function componentBadge(
  label: string,
  outcome: LanComponentOutcome,
  appliedWord = 'Imported',
): { text: string; className: string } | null {
  switch (outcome.status) {
    case 'applied':
      return {
        text: `${label}: ${appliedWord}`,
        className: 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100',
      };
    case 'skipped':
      return {
        text: `${label}: Skipped`,
        className: 'bg-muted text-muted-foreground',
      };
    case 'blocked':
      return {
        text: `${label}: Blocked`,
        className: 'bg-red-500/15 text-red-900 dark:text-red-100',
      };
    case 'conflict':
      return {
        text: `${label}: Needs confirmation`,
        className: 'bg-amber-500/20 text-amber-950 dark:text-amber-100',
      };
    case 'cancelled':
      return {
        text: `${label}: Cancelled`,
        className: 'bg-amber-500/20 text-amber-950 dark:text-amber-100',
      };
    case 'failed':
      return {
        text: `${label}: Failed`,
        className: 'bg-red-500/15 text-red-900 dark:text-red-100',
      };
  }
}

function outcomeNeedsAttention(outcome: LanComponentOutcome): boolean {
  return (
    outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'blocked'
  );
}

function resultNeedsAttention(result: LanBookImportResult): boolean {
  return (
    outcomeNeedsAttention(result.file) ||
    outcomeNeedsAttention(result.position) ||
    outcomeNeedsAttention(result.bookmarks)
  );
}

function firstResultIssueDetail(result: LanBookImportResult): string | null {
  for (const component of [result.file, result.position, result.bookmarks]) {
    if (component.status === 'failed') {
      return describeLanError(component.error).detail;
    }
    if (component.status === 'blocked') {
      return component.reason;
    }
  }
  return null;
}

function canContinueReading(result: LanBookImportResult): boolean {
  if (result.documentId === null) return false;
  return (
    result.file.status !== 'failed' &&
    result.file.status !== 'cancelled' &&
    result.file.status !== 'blocked'
  );
}

export function LanImportProgressStep({
  isPreparingCloseFlush,
}: {
  isPreparingCloseFlush: boolean;
}) {
  const progress = useStudySyncStore((state) => state.lanImport.executionProgress);
  const plan = useStudySyncStore((state) => state.lanImport.plan);
  const catalog = useStudySyncStore((state) => state.lanImport.catalog);
  const error = useStudySyncStore((state) => state.lanImport.error);

  const currentBookTitle = useMemo(() => {
    if (!progress) return null;
    const fromPlan = plan?.summary.books.find((b) => b.bookId === progress.bookId)?.title;
    if (fromPlan) return fromPlan;
    return catalog.find((b) => b.bookId === progress.bookId)?.title ?? progress.bookId;
  }, [catalog, plan, progress]);

  const headingText = useMemo(() => {
    if (isPreparingCloseFlush) {
      return 'Saving and closing open books before applying positions…';
    }
    if (!progress) return 'Starting import…';
    if (progress.phase === 'bookStarted' || progress.phase === 'bookCompleted') {
      return `Importing book ${Math.min(progress.bookIndex + 1, Math.max(progress.totalBooks, 1))} of ${progress.totalBooks}`;
    }
    const total = plan?.summary.books.length ?? 0;
    const idx = plan?.summary.books.findIndex((b) => b.bookId === progress.bookId) ?? -1;
    if (idx >= 0 && total > 0) {
      return `Downloading book ${idx + 1} of ${total}…`;
    }
    return 'Downloading book file…';
  }, [isPreparingCloseFlush, plan, progress]);

  const transferPercent =
    progress?.phase === 'fileTransfer' && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : null;

  const errorPresentation = error ? describeLanError(error) : null;

  return (
    <div data-testid="lan-import-progress" className="space-y-4 text-sm">
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="flex items-center gap-2.5">
          <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">{headingText}</p>
            {!isPreparingCloseFlush && currentBookTitle && (
              <p className="truncate text-xs text-muted-foreground">{currentBookTitle}</p>
            )}
          </div>
        </div>

        {!isPreparingCloseFlush &&
          progress?.phase === 'fileTransfer' &&
          progress.totalBytes > 0 && (
            <div className="space-y-1.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.totalBytes}
                aria-valuenow={progress.downloadedBytes}
                aria-label="Current book download progress"
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${transferPercent ?? 0}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {formatBytes(progress.downloadedBytes)} of {formatBytes(progress.totalBytes)}
                </span>
                {transferPercent !== null && <span>{transferPercent}%</span>}
              </div>
            </div>
          )}
      </div>

      {errorPresentation && (
        <div
          role="alert"
          className="rounded-md border border-red-600/40 bg-red-500/10 p-3 text-xs text-red-900 dark:text-red-100"
        >
          <p className="font-semibold">{errorPresentation.title}</p>
          <p className="mt-0.5 text-foreground">{errorPresentation.detail}</p>
        </div>
      )}
    </div>
  );
}

export function LanImportProgressFooter({
  isPreparingCloseFlush,
  onCancel,
}: {
  isPreparingCloseFlush: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <span className="text-xs text-muted-foreground">
        Partial transfers remain isolated until size and SHA-256 verification succeed.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="lan-import-cancel-transfer"
        disabled={isPreparingCloseFlush}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </>
  );
}

export function LanImportResultsStep({
  report,
  plan,
  isBusy,
  onResolveConflict,
  onContinueReading,
}: {
  report: LanImportExecutionReport;
  plan: LanImportPlanResult | null;
  isBusy: boolean;
  onResolveConflict: (bookId: string) => void;
  onContinueReading: (documentId: string) => void;
}) {
  const documents = useStudySyncStore((state) => state.documents);
  const catalog = useStudySyncStore((state) => state.lanImport.catalog);
  const session = useStudySyncStore((state) => state.lanImport.session);
  const error = useStudySyncStore((state) => state.lanImport.error);

  const documentsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const planByBookId = useMemo(
    () => new Map((plan?.summary.books ?? []).map((book) => [book.bookId, book])),
    [plan],
  );
  const catalogTitleByBookId = useMemo(
    () => new Map(catalog.map((book) => [book.bookId, book.title])),
    [catalog],
  );

  const failedOrCancelledCount = report.books.filter(resultNeedsAttention).length;
  const conflictCount = report.books.filter((item) => item.position.status === 'conflict').length;
  const succeededCount =
    report.books.length -
    report.books.filter((item) => resultNeedsAttention(item) || item.position.status === 'conflict')
      .length;

  const activeSessionError = report.sessionError ?? error;
  const sessionErrorPresentation = activeSessionError ? describeLanError(activeSessionError) : null;
  const reportStatus: 'completed' | 'cancelled' | 'sessionError' =
    report.sessionError !== undefined
      ? 'sessionError'
      : report.cancelled
        ? 'cancelled'
        : 'completed';
  const isFatalSession =
    reportStatus === 'sessionError' ||
    (error !== null && FATAL_SESSION_ERROR_CODES.has(error.code));

  return (
    <div data-testid="lan-import-results" className="space-y-4 text-sm">
      <div
        role={failedOrCancelledCount > 0 || reportStatus !== 'completed' ? 'alert' : 'status'}
        data-testid="lan-import-results-banner"
        data-report-status={reportStatus}
        className={cn(
          'flex items-start gap-2.5 rounded-md border p-3 text-xs',
          reportStatus === 'completed' && failedOrCancelledCount === 0 && conflictCount === 0
            ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100'
            : 'border-amber-600/40 bg-amber-500/10 text-amber-950 dark:text-amber-100',
        )}
      >
        {reportStatus === 'completed' && failedOrCancelledCount === 0 && conflictCount === 0 ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        ) : reportStatus === 'sessionError' ? (
          <XCircle className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        )}
        <div className="space-y-0.5">
          <p className="font-semibold">
            {reportStatus === 'cancelled'
              ? 'Import cancelled'
              : reportStatus === 'sessionError'
                ? (sessionErrorPresentation?.title ?? 'Connection interrupted during import')
                : conflictCount > 0
                  ? 'Import finished — confirm reading position change'
                  : failedOrCancelledCount > 0
                    ? 'Import completed with some items needing attention'
                    : 'Import complete'}
          </p>
          <p>
            {reportStatus === 'cancelled'
              ? 'Completed items were kept, and any partial download was removed cleanly.'
              : reportStatus === 'sessionError'
                ? (sessionErrorPresentation?.detail ??
                  'The sharing session ended before all items finished.')
                : conflictCount > 0
                  ? 'A local book position changed before applying the source position. Review and confirm below if you want to overwrite it.'
                  : `${succeededCount} succeeded${failedOrCancelledCount > 0 ? `, ${failedOrCancelledCount} not completed` : ''}.`}
          </p>
        </div>
      </div>

      <div className="space-y-2.5">
        {report.books.map((result) => {
          const planned = planByBookId.get(result.bookId) ?? null;
          const localDoc =
            result.documentId !== null ? (documentsById.get(result.documentId) ?? null) : null;
          const title =
            planned?.title ??
            catalogTitleByBookId.get(result.bookId) ??
            localDoc?.title ??
            result.bookId;

          const fileBadge = componentBadge('File', result.file);
          const positionBadge = componentBadge('Position', result.position, 'Applied');
          const bookmarksBadge = componentBadge('Bookmarks', result.bookmarks);
          const issueDetail = firstResultIssueDetail(result);

          const conflictOutcome = result.position.status === 'conflict' ? result.position : null;
          const isConflict = conflictOutcome !== null;
          const currentLocalLabel = conflictOutcome
            ? describeConflictCurrentPosition({
                localDocument: localDoc,
                hasCurrentPosition: conflictOutcome.hasCurrentPosition,
                currentProgress: conflictOutcome.currentProgress,
              })
            : null;
          const remoteLabel =
            conflictOutcome && planned
              ? describeSyncPositionSummary({
                  localDocument: localDoc,
                  position: planned.position,
                }).remoteLabel
              : null;

          return (
            <section
              key={result.bookId}
              data-testid="lan-import-result-row"
              data-book-id={result.bookId}
              data-book-status={
                resultNeedsAttention(result) ? 'attention' : isConflict ? 'conflict' : 'completed'
              }
              className="space-y-2 rounded-md border bg-card p-3.5 text-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {fileBadge && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          fileBadge.className,
                        )}
                      >
                        {fileBadge.text}
                      </span>
                    )}
                    {positionBadge && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          positionBadge.className,
                        )}
                      >
                        {positionBadge.text}
                      </span>
                    )}
                    {bookmarksBadge && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          bookmarksBadge.className,
                        )}
                      >
                        {bookmarksBadge.text}
                        {result.bookmarkCounts.inserted > 0
                          ? ` (+${result.bookmarkCounts.inserted})`
                          : ''}
                      </span>
                    )}
                  </div>
                </div>

                {canContinueReading(result) && result.documentId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`lan-import-continue-${result.bookId}`}
                    disabled={isBusy}
                    onClick={() => onContinueReading(result.documentId!)}
                  >
                    <BookOpen className="size-3.5" />
                    Continue reading
                  </Button>
                )}
              </div>

              {isConflict && (
                <div
                  data-testid={`lan-import-conflict-${result.bookId}`}
                  className="space-y-2 rounded border border-amber-600/40 bg-amber-500/10 p-2.5 text-foreground"
                >
                  <p className="font-semibold text-amber-950 dark:text-amber-100">
                    Your local reading position changed before import finished
                  </p>
                  <div className="space-y-0.5 text-muted-foreground">
                    {currentLocalLabel && <p>Current local position: {currentLocalLabel}</p>}
                    {remoteLabel && <p>Source device position: {remoteLabel}</p>}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    data-testid={`lan-import-conflict-override-${result.bookId}`}
                    disabled={isBusy || isFatalSession || session === null}
                    onClick={() => onResolveConflict(result.bookId)}
                  >
                    Replace with source position anyway
                  </Button>
                </div>
              )}

              {issueDetail && !isConflict && (
                <p className="font-medium text-red-900 dark:text-red-100">{issueDetail}</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function LanImportResultsFooter({
  report,
  lastSubmittedDecisions,
  isBusy,
  onRetryFailed,
  onBackToCatalog,
  onReconnect,
  onDone,
}: {
  report: LanImportExecutionReport;
  lastSubmittedDecisions: readonly BookImportDecision[];
  isBusy: boolean;
  onRetryFailed: (retryDecisions: BookImportDecision[]) => void;
  onBackToCatalog: () => void;
  onReconnect: () => void;
  onDone: () => void;
}) {
  const session = useStudySyncStore((state) => state.lanImport.session);
  const error = useStudySyncStore((state) => state.lanImport.error);

  const retryDecisions = useMemo(
    () => buildRetryFailedDecisions(report, lastSubmittedDecisions),
    [lastSubmittedDecisions, report],
  );
  const succeededCount = report.books.filter(
    (item) => !resultNeedsAttention(item) && item.position.status !== 'conflict',
  ).length;
  const isFatalSession =
    report.sessionError !== undefined ||
    (error !== null && FATAL_SESSION_ERROR_CODES.has(error.code));

  return (
    <>
      <span className="text-xs text-muted-foreground">
        {succeededCount} succeeded · {report.books.length} processed
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {retryDecisions.length > 0 && !isFatalSession && session !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-retry-failed"
            disabled={isBusy}
            onClick={() => onRetryFailed(retryDecisions)}
          >
            <RefreshCw className="size-3.5" />
            Retry failed items
          </Button>
        )}

        {isFatalSession || session === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-reconnect"
            disabled={isBusy}
            onClick={onReconnect}
          >
            Reconnect
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-back-to-catalog"
            disabled={isBusy}
            onClick={onBackToCatalog}
          >
            Back to catalog
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          data-testid="lan-import-done"
          disabled={isBusy}
          onClick={onDone}
        >
          Done
        </Button>
      </div>
    </>
  );
}
