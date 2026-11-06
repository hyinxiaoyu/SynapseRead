import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const SEARCH_HIGHLIGHT_ID = '__search_active__';
export const SEARCH_HIGHLIGHT_COLOR = '#fb923c';

export interface DocumentSearchResultItem {
  id: string;
  locationLabel: string;
  contextBefore: string;
  matchText: string;
  contextAfter: string;
}

export type DocumentSearchStatus = 'idle' | 'searching' | 'done' | 'cancelled';

/** Non-overlapping substring ranges in `text` matching `query`. */
export function findSubstringMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  if (query.trim() === '' || text.length === 0) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0) return [];

  const matches: { start: number; end: number }[] = [];
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    fromIndex = index + Math.max(needle.length, 1);
  }
  return matches;
}

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ');

/** Context snippet around `[matchStart, matchEnd]` for search result lists. */
export function buildSearchSnippet(
  text: string,
  matchStart: number,
  matchEnd: number,
  radius = 36,
): { contextBefore: string; matchText: string; contextAfter: string } {
  const beforeStart = Math.max(0, matchStart - radius);
  const afterEnd = Math.min(text.length, matchEnd + radius);
  const rawBefore = collapseWhitespace(text.slice(beforeStart, matchStart)).trimStart();
  const rawAfter = collapseWhitespace(text.slice(matchEnd, afterEnd)).trimEnd();
  return {
    contextBefore: `${beforeStart > 0 ? '…' : ''}${rawBefore}`,
    matchText: collapseWhitespace(text.slice(matchStart, matchEnd)),
    contextAfter: `${rawAfter}${afterEnd < text.length ? '…' : ''}`,
  };
}

export interface UseDocumentSearchOptions<TMatch extends DocumentSearchResultItem> {
  isActive: boolean;
  runSearch: (
    query: string,
    caseSensitive: boolean,
    signal: AbortSignal,
  ) => Promise<readonly TMatch[]> | readonly TMatch[];
  onNavigateToMatch: (match: TMatch, index: number) => void;
  searchRevision?: unknown;
}

export interface DocumentSearchController<TMatch extends DocumentSearchResultItem> {
  open: boolean;
  focusNonce: number;
  query: string;
  caseSensitive: boolean;
  status: DocumentSearchStatus;
  results: readonly TMatch[];
  activeIndex: number;
  activeMatch: TMatch | null;
  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setQuery: (nextQuery: string) => void;
  toggleCaseSensitive: () => void;
  cancelSearch: () => void;
  nextMatch: () => void;
  previousMatch: () => void;
  selectMatch: (index: number) => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export function useDocumentSearch<TMatch extends DocumentSearchResultItem>({
  isActive,
  runSearch,
  onNavigateToMatch,
  searchRevision,
}: UseDocumentSearchOptions<TMatch>): DocumentSearchController<TMatch> {
  const [open, setOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [query, setQueryState] = useState('');
  const [caseSensitive, setCaseSensitiveState] = useState(false);
  const [status, setStatus] = useState<DocumentSearchStatus>('idle');
  const [results, setResults] = useState<readonly TMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const latestRef = useRef({
    runSearch,
    onNavigateToMatch,
    query,
    caseSensitive,
    open,
    status,
  });

  useEffect(() => {
    latestRef.current = {
      runSearch,
      onNavigateToMatch,
      query,
      caseSensitive,
      open,
      status,
    };
  });

  const executeSearch = useCallback(
    (nextQuery: string, nextCaseSensitive: boolean, autoNavigate: boolean) => {
      runIdRef.current += 1;
      const runId = runIdRef.current;
      abortRef.current?.abort();
      abortRef.current = null;

      if (nextQuery.trim() === '') {
        setStatus('idle');
        setResults([]);
        setActiveIndex(-1);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('searching');
      setResults([]);
      setActiveIndex(-1);

      Promise.resolve()
        .then(() => latestRef.current.runSearch(nextQuery, nextCaseSensitive, controller.signal))
        .then((matches) => {
          if (controller.signal.aborted || runIdRef.current !== runId) return;
          abortRef.current = null;
          setResults(matches);
          setStatus('done');
          if (matches.length === 0) {
            setActiveIndex(-1);
            return;
          }
          const first = matches[0];
          setActiveIndex(0);
          if (autoNavigate && first) {
            latestRef.current.onNavigateToMatch(first, 0);
          }
        })
        .catch(() => {
          if (controller.signal.aborted || runIdRef.current !== runId) return;
          abortRef.current = null;
          setResults([]);
          setActiveIndex(-1);
          setStatus('done');
        });
    },
    [],
  );

  const cancelSearch = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('cancelled');
  }, []);

  const openSearch = useCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  }, []);

  const closeSearch = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
  }, []);

  const toggleSearch = useCallback(() => {
    if (open) closeSearch();
    else openSearch();
  }, [closeSearch, open, openSearch]);

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryState(nextQuery);
      executeSearch(nextQuery, caseSensitive, true);
    },
    [caseSensitive, executeSearch],
  );

  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitiveState(next);
    executeSearch(query, next, true);
  }, [caseSensitive, executeSearch, query]);

  const selectMatch = useCallback(
    (index: number) => {
      const target = results[index];
      if (!target) return;
      setActiveIndex(index);
      latestRef.current.onNavigateToMatch(target, index);
    },
    [results],
  );

  const nextMatch = useCallback(() => {
    if (results.length === 0) return;
    const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % results.length;
    selectMatch(nextIndex);
  }, [activeIndex, results.length, selectMatch]);

  const previousMatch = useCallback(() => {
    if (results.length === 0) return;
    const prevIndex = activeIndex <= 0 ? results.length - 1 : (activeIndex - 1) % results.length;
    selectMatch(prevIndex);
  }, [activeIndex, results.length, selectMatch]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.defaultPrevented) return false;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        openSearch();
        return true;
      }
      if (
        event.key === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        latestRef.current.open
      ) {
        event.preventDefault();
        if (latestRef.current.status === 'searching') cancelSearch();
        else closeSearch();
        return true;
      }
      return false;
    },
    [cancelSearch, closeSearch, openSearch],
  );

  useEffect(() => {
    if (!isActive) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      handleKeyDown(event);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [handleKeyDown, isActive]);

  // Cancel any in-flight search if the user switches away from this document tab.
  useEffect(() => {
    if (isActive || !abortRef.current) return;
    runIdRef.current += 1;
    abortRef.current.abort();
    abortRef.current = null;
    const timer = window.setTimeout(() => setStatus('cancelled'), 0);
    return () => window.clearTimeout(timer);
  }, [isActive]);

  // Re-run an active query when the underlying document model finishes loading more content.
  const prevRevision = useRef(searchRevision);
  useEffect(() => {
    if (prevRevision.current === searchRevision) return;
    prevRevision.current = searchRevision;
    if (!latestRef.current.open || latestRef.current.query.trim() === '') return;
    const timer = window.setTimeout(() => {
      executeSearch(latestRef.current.query, latestRef.current.caseSensitive, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [executeSearch, searchRevision]);

  useEffect(
    () => () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const activeMatch = open && activeIndex >= 0 ? (results[activeIndex] ?? null) : null;

  return {
    open,
    focusNonce,
    query,
    caseSensitive,
    status,
    results,
    activeIndex,
    activeMatch,
    openSearch,
    closeSearch,
    toggleSearch,
    setQuery,
    toggleCaseSensitive,
    cancelSearch,
    nextMatch,
    previousMatch,
    selectMatch,
    handleKeyDown,
  };
}

export function DocumentSearchToggleButton({
  open,
  disabled = false,
  onToggle,
}: {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant={open ? 'secondary' : 'ghost'}
      size="sm"
      className="h-6 px-2 text-xs"
      aria-label="Find in document"
      aria-pressed={open}
      disabled={disabled}
      onClick={onToggle}
    >
      <Search />
      Find
    </Button>
  );
}

export function DocumentSearchBar<TMatch extends DocumentSearchResultItem>({
  search,
}: {
  search: DocumentSearchController<TMatch>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!search.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [search.open, search.focusNonce]);

  if (!search.open) return null;

  const hasQuery = search.query.trim() !== '';
  const hasResults = search.results.length > 0;

  let statusLabel = 'Enter a search term';
  if (hasQuery) {
    if (search.status === 'searching') {
      statusLabel = 'Searching…';
    } else if (search.status === 'cancelled') {
      statusLabel = 'Search cancelled';
    } else if (hasResults) {
      statusLabel = `${search.activeIndex + 1} of ${search.results.length}`;
    } else {
      statusLabel = 'No matches';
    }
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) search.previousMatch();
      else search.nextMatch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (search.status === 'searching') search.cancelSearch();
      else search.closeSearch();
    }
  };

  return (
    <div
      role="search"
      aria-label="Find in document"
      data-testid="document-search-bar"
      className="shrink-0 border-b bg-background text-xs text-foreground"
    >
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        <input
          ref={inputRef}
          type="search"
          aria-label="Find in document"
          data-testid="search-input"
          placeholder="Find in document…"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          className="h-7 min-w-44 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          variant={search.caseSensitive ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 px-2 font-mono text-xs"
          aria-label="Match case"
          aria-pressed={search.caseSensitive}
          onClick={search.toggleCaseSensitive}
        >
          Aa
        </Button>
        <span
          role="status"
          aria-live="polite"
          data-testid="search-status"
          className="min-w-20 text-center text-xs text-muted-foreground tabular-nums"
        >
          {statusLabel}
        </span>
        {search.status === 'searching' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label="Cancel search"
            onClick={search.cancelSearch}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Previous match"
          disabled={!hasResults}
          onClick={search.previousMatch}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Next match"
          disabled={!hasResults}
          onClick={search.nextMatch}
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close search"
          onClick={search.closeSearch}
        >
          <X />
        </Button>
      </div>
      {hasResults && (
        <ol
          aria-label="Search results"
          data-testid="search-results"
          className="max-h-36 divide-y overflow-y-auto border-t bg-muted/20"
        >
          {search.results.map((item, index) => {
            const active = index === search.activeIndex;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid="search-result-item"
                  aria-current={active ? 'location' : undefined}
                  onClick={() => search.selectMatch(index)}
                  className={cn(
                    'flex w-full items-baseline gap-2 px-3 py-1 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground/85 hover:bg-accent/60',
                  )}
                >
                  <span
                    data-testid="search-result-location"
                    className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
                  >
                    {item.locationLabel}
                  </span>
                  <span data-testid="search-result-snippet" className="truncate">
                    {item.contextBefore}
                    <mark className="rounded-xs bg-amber-300/80 px-0.5 text-black">
                      {item.matchText}
                    </mark>
                    {item.contextAfter}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
