import { Loader2, RefreshCw, Unplug } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  describeLanError,
  formatBytes,
  formatCatalogFormatLabel,
} from '@/features/lanSync/lanSyncCopy';
import { cn } from '@/lib/utils';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { BookSyncState } from '@/types/domain';

const FATAL_SESSION_ERROR_CODES = new Set([
  'lan_auth_expired',
  'lan_source_stopped',
  'lan_network_changed',
]);

function syncStateBadge(state: BookSyncState): {
  label: string;
  className: string;
} {
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

function ineligibleExplanation(state: BookSyncState): string {
  switch (state) {
    case 'localFileChanged':
      return 'Local file changed. Open this book to resolve the change first.';
    case 'sourceUnavailable':
      return 'This book file is missing or unreadable on the source device.';
    case 'formatMismatch':
      return 'This format is not supported for import on this device.';
    default:
      return 'Not eligible for import in this session.';
  }
}

export function LanImportCatalogStep({
  selectedBookIds,
  onToggleBook,
  onSelectAllEligible,
  onClearSelection,
}: {
  selectedBookIds: ReadonlySet<string>;
  onToggleBook: (bookId: string) => void;
  onSelectAllEligible: (eligibleBookIds: readonly string[]) => void;
  onClearSelection: () => void;
}) {
  const phase = useStudySyncStore((state) => state.lanImport.phase);
  const session = useStudySyncStore((state) => state.lanImport.session);
  const catalog = useStudySyncStore((state) => state.lanImport.catalog);
  const planProgress = useStudySyncStore((state) => state.lanImport.planProgress);
  const error = useStudySyncStore((state) => state.lanImport.error);
  const refreshLanImportCatalog = useStudySyncStore((state) => state.refreshLanImportCatalog);
  const cancelLanImportOperation = useStudySyncStore((state) => state.cancelLanImportOperation);
  const disconnectLanImport = useStudySyncStore((state) => state.disconnectLanImport);
  const clearLanImportError = useStudySyncStore((state) => state.clearLanImportError);

  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const isPlanning = phase === 'planning';

  const filteredCatalog = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter(
      (book) =>
        book.title.toLowerCase().includes(query) ||
        formatCatalogFormatLabel(book).toLowerCase().includes(query),
    );
  }, [catalog, searchQuery]);

  const eligibleIds = useMemo(
    () => catalog.filter((book) => book.eligible).map((book) => book.bookId),
    [catalog],
  );

  const currentPlanningTitle = useMemo(() => {
    if (!planProgress?.bookId) return null;
    return catalog.find((book) => book.bookId === planProgress.bookId)?.title ?? null;
  }, [catalog, planProgress]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshLanImportCatalog();
    } finally {
      setRefreshing(false);
    }
  };

  const errorPresentation = error ? describeLanError(error) : null;
  const isFatalSessionError = error !== null && FATAL_SESSION_ERROR_CODES.has(error.code);

  return (
    <div className="space-y-4 text-sm">
      {session && (
        <section
          aria-label="Connected source device"
          data-testid="lan-import-session-header"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5 text-xs"
        >
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Connected to</span>
              <span
                data-testid="lan-import-session-address"
                className="font-mono font-semibold text-foreground"
              >
                {session.address}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <span className="rounded bg-background px-1.5 py-0.5 text-foreground">
                Positions: {session.permissions.positions ? 'Included' : 'Off'}
              </span>
              <span className="rounded bg-background px-1.5 py-0.5 text-foreground">
                Bookmarks: {session.permissions.bookmarks ? 'Included' : 'Off'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="lan-import-catalog-refresh"
              disabled={isPlanning || refreshing}
              onClick={() => void handleRefresh()}
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="lan-import-disconnect"
              disabled={isPlanning}
              onClick={() => void disconnectLanImport()}
            >
              <Unplug className="size-3.5" />
              Disconnect
            </Button>
          </div>
        </section>
      )}

      {isPlanning && (
        <div
          role="status"
          data-testid="lan-import-plan-progress"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3.5 py-2.5 text-xs"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                Comparing {planProgress?.completedBooks ?? 0} of{' '}
                {planProgress?.totalBooks ?? selectedBookIds.size} selected books…
              </p>
              {currentPlanningTitle && (
                <p className="truncate text-muted-foreground">{currentPlanningTitle}</p>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-plan-cancel"
            onClick={() => void cancelLanImportOperation()}
          >
            Cancel
          </Button>
        </div>
      )}

      {errorPresentation && error && (
        <div
          role="alert"
          data-testid="lan-import-catalog-error"
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
                data-testid="lan-import-catalog-reconnect"
                onClick={() => void disconnectLanImport()}
              >
                Reconnect
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-48 flex-1">
          <label htmlFor="lan-import-catalog-search" className="sr-only">
            Filter shared books
          </label>
          <Input
            id="lan-import-catalog-search"
            data-testid="lan-import-catalog-search"
            type="search"
            placeholder="Filter shared books by title or format…"
            disabled={isPlanning}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-catalog-select-all"
            disabled={isPlanning || eligibleIds.length === 0}
            onClick={() => onSelectAllEligible(eligibleIds)}
          >
            Select all eligible
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="lan-import-catalog-clear"
            disabled={isPlanning || selectedBookIds.size === 0}
            onClick={onClearSelection}
          >
            Clear
          </Button>
        </div>
      </div>

      <div
        data-testid="lan-import-catalog-list"
        className="max-h-80 overflow-y-auto rounded-md border divide-y"
      >
        {catalog.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            The source device did not share any books in this session.
          </p>
        ) : filteredCatalog.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            No shared books match &ldquo;{searchQuery.trim()}&rdquo;.
          </p>
        ) : (
          filteredCatalog.map((book) => {
            const badge = syncStateBadge(book.state);
            const checked = book.eligible && selectedBookIds.has(book.bookId);
            const formatLabel = formatCatalogFormatLabel(book);
            return (
              <label
                key={book.bookId}
                data-testid={`lan-import-catalog-row-${book.bookId}`}
                data-sync-state={book.state}
                className={cn(
                  'flex items-start gap-3 px-3.5 py-2.5 transition-colors',
                  book.eligible && !isPlanning
                    ? 'cursor-pointer hover:bg-muted/40'
                    : 'cursor-not-allowed bg-muted/20 opacity-85',
                )}
              >
                <input
                  type="checkbox"
                  data-testid={`lan-import-catalog-checkbox-${book.bookId}`}
                  className="mt-0.5 size-4 rounded border-border accent-primary"
                  checked={checked}
                  disabled={!book.eligible || isPlanning}
                  onChange={() => onToggleBook(book.bookId)}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground">{book.title}</span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                        badge.className,
                      )}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{formatLabel}</span>
                    <span>{formatBytes(book.sizeBytes)}</span>
                    {session?.permissions.positions && book.hasPosition === true && (
                      <span>Has reading position</span>
                    )}
                    {session?.permissions.bookmarks &&
                      book.bookmarkCount !== null &&
                      book.bookmarkCount > 0 && (
                        <span>
                          {book.bookmarkCount} {book.bookmarkCount === 1 ? 'bookmark' : 'bookmarks'}
                        </span>
                      )}
                  </div>
                  {!book.eligible && (
                    <p
                      data-testid={`lan-import-catalog-ineligible-${book.bookId}`}
                      className="text-xs font-medium text-red-900 dark:text-red-100"
                    >
                      {ineligibleExplanation(book.state)}
                    </p>
                  )}
                </div>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

export function LanImportCatalogFooter({
  selectedCount,
  eligibleCount,
  isPlanning,
  onReview,
  onCloseAndDisconnect,
}: {
  selectedCount: number;
  eligibleCount: number;
  isPlanning: boolean;
  onReview: () => void;
  onCloseAndDisconnect: () => void;
}) {
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {selectedCount} of {eligibleCount} eligible {eligibleCount === 1 ? 'book' : 'books'}{' '}
        selected
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPlanning}
          onClick={onCloseAndDisconnect}
        >
          Close
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="lan-import-review"
          disabled={isPlanning || selectedCount === 0}
          onClick={onReview}
        >
          {isPlanning ? 'Comparing…' : 'Review import'}
        </Button>
      </div>
    </>
  );
}
