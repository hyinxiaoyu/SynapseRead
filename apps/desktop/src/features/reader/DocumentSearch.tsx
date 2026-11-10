import { ChevronDown, ChevronUp, List, Search, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { commandTooltip } from '@/features/commands/commands';
import { useRovingList } from '@/features/reader/navigator/useRovingList';
import { cn } from '@/lib/utils';

export const SEARCH_HIGHLIGHT_ID = '__search_active__';
export const SEARCH_HIGHLIGHT_COLOR = '#fb923c';
/**
 * How long typing must pause before the document is scanned. A whole-file search
 * cannot be cancelled once it starts (TXT runs it synchronously), so every
 * keystroke would otherwise cost a full pass and a jump.
 */
export const SEARCH_DEBOUNCE_MS = 200;

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

/**
 * Runs a search. Long documents report the matches found so far through
 * `onProgress` (each call carries every match up to that point), so results
 * appear while later pages are still being read; `signal` cancels.
 */
export type RunDocumentSearch<TMatch> = (
  query: string,
  caseSensitive: boolean,
  signal: AbortSignal,
  onProgress: (matchesSoFar: readonly TMatch[]) => void,
) => Promise<readonly TMatch[]> | readonly TMatch[];

export interface UseDocumentSearchOptions<TMatch extends DocumentSearchResultItem> {
  isActive: boolean;
  runSearch: RunDocumentSearch<TMatch>;
  /**
   * Shows a match. `trip` changes when a new search runs, and not between the
   * steps of one search: a reader remembers one place per trip, not per match.
   */
  onNavigateToMatch: (match: TMatch, index: number, trip: number) => void;
  searchRevision?: unknown;
  /** How long typing must pause before the document is scanned. */
  debounceMs?: number;
  /**
   * The index of the first match at or after the reading position, or `-1` when
   * none of `matches` is. A search starts there and wraps to the first match only
   * once it has finished, so a match further on is never skipped. Only a reader
   * may compare positions.
   */
  findSearchStart?: (matches: readonly TMatch[]) => number;
}

export interface DocumentSearchController<TMatch extends DocumentSearchResultItem> {
  /** Bumped to move focus to the search field (⌘F). */
  focusNonce: number;
  query: string;
  /** A query is entered: results, the active match, and the sidebar list apply. */
  active: boolean;
  caseSensitive: boolean;
  status: DocumentSearchStatus;
  results: readonly TMatch[];
  activeIndex: number;
  activeMatch: TMatch | null;
  focusSearch: () => void;
  clearSearch: () => void;
  setQuery: (nextQuery: string) => void;
  /** ⌘E: searches for the selected text. */
  findSelection: (text: string) => void;
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
  debounceMs = SEARCH_DEBOUNCE_MS,
  findSearchStart,
}: UseDocumentSearchOptions<TMatch>): DocumentSearchController<TMatch> {
  const [focusNonce, setFocusNonce] = useState(0);
  const [query, setQueryState] = useState('');
  const [caseSensitive, setCaseSensitiveState] = useState(false);
  const [status, setStatus] = useState<DocumentSearchStatus>('idle');
  const [results, setResults] = useState<readonly TMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  /** Bumped per search run, so a reader records one history entry per search. */
  const tripRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const latestRef = useRef({
    runSearch,
    onNavigateToMatch,
    findSearchStart,
    query,
    caseSensitive,
    status,
  });

  useEffect(() => {
    latestRef.current = {
      runSearch,
      onNavigateToMatch,
      findSearchStart,
      query,
      caseSensitive,
      status,
    };
  });

  const cancelPending = useCallback(() => {
    if (debounceRef.current === null) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }, []);

  /** The match a search starts at, or null while that cannot be known yet. */
  const pickStart = useCallback((matches: readonly TMatch[], complete: boolean): number | null => {
    if (matches.length === 0) return null;
    const atOrAfter = latestRef.current.findSearchStart?.(matches) ?? 0;
    if (atOrAfter >= 0 && atOrAfter < matches.length) return atOrAfter;
    // Nothing at or after the reading position, so the search wraps to the start
    // of the document — but only once every match is known, or a match further on
    // would be skipped.
    return complete ? 0 : null;
  }, []);

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

      if (autoNavigate) tripRef.current += 1;
      const trip = tripRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('searching');
      setResults([]);
      setActiveIndex(-1);

      const isCurrent = () => !controller.signal.aborted && runIdRef.current === runId;
      // The match the search starts at is shown as soon as it is found, not when
      // the last page is read.
      let navigated = false;
      const show = (matches: readonly TMatch[], complete: boolean) => {
        setResults(matches);
        if (navigated) return;
        const start = pickStart(matches, complete);
        if (start === null) return;
        const startMatch = matches[start];
        if (!startMatch) return;
        navigated = true;
        setActiveIndex(start);
        if (autoNavigate) latestRef.current.onNavigateToMatch(startMatch, start, trip);
      };

      Promise.resolve()
        .then(() =>
          latestRef.current.runSearch(nextQuery, nextCaseSensitive, controller.signal, (soFar) => {
            if (isCurrent()) show(soFar, false);
          }),
        )
        .then((matches) => {
          if (!isCurrent()) return;
          abortRef.current = null;
          show(matches, true);
          if (matches.length === 0) setActiveIndex(-1);
          setStatus('done');
        })
        .catch(() => {
          if (!isCurrent()) return;
          abortRef.current = null;
          setResults([]);
          setActiveIndex(-1);
          setStatus('done');
        });
    },
    [pickStart],
  );

  const cancelSearch = useCallback(() => {
    const hadPending = debounceRef.current !== null;
    cancelPending();
    if (!abortRef.current && !hadPending) return;
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('cancelled');
  }, [cancelPending]);

  const focusSearch = useCallback(() => {
    setFocusNonce((nonce) => nonce + 1);
  }, []);

  /** Runs a search once typing has paused, so a burst of keys scans once. */
  const searchSoon = useCallback(
    (nextQuery: string, nextCaseSensitive: boolean) => {
      cancelPending();
      if (debounceMs <= 0 || nextQuery.trim() === '') {
        executeSearch(nextQuery, nextCaseSensitive, true);
        return;
      }
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setStatus('searching');
      setResults([]);
      setActiveIndex(-1);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        executeSearch(nextQuery, nextCaseSensitive, true);
      }, debounceMs);
    },
    [cancelPending, debounceMs, executeSearch],
  );

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryState(nextQuery);
      searchSoon(nextQuery, caseSensitive);
    },
    [caseSensitive, searchSoon],
  );

  const clearSearch = useCallback(() => {
    cancelPending();
    setQueryState('');
    executeSearch('', caseSensitive, false);
  }, [cancelPending, caseSensitive, executeSearch]);

  const findSelection = useCallback(
    (text: string) => {
      const trimmed = collapseWhitespace(text).trim();
      if (!trimmed) return;
      // An explicit command, not typing: it searches now.
      cancelPending();
      setQueryState(trimmed);
      executeSearch(trimmed, caseSensitive, true);
      focusSearch();
    },
    [cancelPending, caseSensitive, executeSearch, focusSearch],
  );

  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitiveState(next);
    cancelPending();
    executeSearch(query, next, true);
  }, [cancelPending, caseSensitive, executeSearch, query]);

  const selectMatch = useCallback(
    (index: number) => {
      const target = results[index];
      if (!target) return;
      setActiveIndex(index);
      latestRef.current.onNavigateToMatch(target, index, tripRef.current);
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

  /** Esc outside the field: stops a running search, then clears the query. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.defaultPrevented) return false;
      if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return false;
      if (latestRef.current.query.trim() === '') return false;
      event.preventDefault();
      if (latestRef.current.status === 'searching') cancelSearch();
      else clearSearch();
      return true;
    },
    [cancelSearch, clearSearch],
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
    if (isActive) return;
    const hadPending = debounceRef.current !== null;
    cancelPending();
    if (!abortRef.current && !hadPending) return;
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const timer = window.setTimeout(() => setStatus('cancelled'), 0);
    return () => window.clearTimeout(timer);
  }, [cancelPending, isActive]);

  // Re-run an active query when the underlying document model finishes loading more content.
  const prevRevision = useRef(searchRevision);
  useEffect(() => {
    if (prevRevision.current === searchRevision) return;
    prevRevision.current = searchRevision;
    if (latestRef.current.query.trim() === '' || debounceRef.current !== null) return;
    const timer = window.setTimeout(() => {
      executeSearch(latestRef.current.query, latestRef.current.caseSensitive, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [executeSearch, searchRevision]);

  useEffect(
    () => () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  const active = query.trim() !== '';
  const activeMatch = active && activeIndex >= 0 ? (results[activeIndex] ?? null) : null;

  return {
    focusNonce,
    query,
    active,
    caseSensitive,
    status,
    results,
    activeIndex,
    activeMatch,
    focusSearch,
    clearSearch,
    setQuery,
    findSelection,
    toggleCaseSensitive,
    cancelSearch,
    nextMatch,
    previousMatch,
    selectMatch,
    handleKeyDown,
  };
}

export function searchStatusLabel(
  search: Pick<
    DocumentSearchController<DocumentSearchResultItem>,
    'active' | 'status' | 'results' | 'activeIndex'
  >,
): string {
  if (!search.active) return '';
  const count = search.results.length;
  const position = `${Math.max(search.activeIndex, 0) + 1} of ${count}`;
  switch (search.status) {
    case 'idle':
      return '';
    case 'searching':
      return count > 0 ? `${position}…` : 'Searching…';
    case 'cancelled':
      return count > 0 ? `Search cancelled · ${count} found` : 'Search cancelled';
    default:
      return count > 0 ? position : 'No matches';
  }
}

/**
 * The one search field, in the toolbar's trailing group (Preview). It widens on
 * focus; the match count and Previous/Next sit inside it, and Match Case lives
 * in the field's menu. Results list in the Navigator sidebar, which the field's
 * list button opens: typing never opens or closes the sidebar by itself.
 */
export function ToolbarSearchField<TMatch extends DocumentSearchResultItem>({
  search,
  disabled = false,
  onReturnFocus,
  onShowResults,
}: {
  search: DocumentSearchController<TMatch>;
  disabled?: boolean;
  /** Esc gives focus back to the page. */
  onReturnFocus?: () => void;
  /** Opens the Navigator on this search's results. */
  onShowResults?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (search.focusNonce === 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [search.focusNonce]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpen]);

  const hasResults = search.results.length > 0;
  const searching = search.status === 'searching';

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) search.previousMatch();
      else search.nextMatch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      search.clearSearch();
      inputRef.current?.blur();
      onReturnFocus?.();
    }
  };

  // The slot keeps its width while the field has focus; the field widens over the
  // controls to its left instead, so nothing in the toolbar moves on focus or blur
  // (a click that blurs the field must land where it was aimed).
  return (
    <div
      className={cn(
        'relative h-7 shrink-0 transition-[width] duration-150 motion-reduce:transition-none',
        search.active ? 'w-60' : 'w-40',
      )}
    >
      <div
        role="search"
        aria-label="Search document"
        data-testid="document-search-field"
        className={cn(
          'absolute inset-y-0 right-0 flex w-full items-center rounded-md border bg-background text-xs text-foreground transition-[width] duration-150 focus-within:z-20 focus-within:w-72 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none',
          disabled && 'opacity-50',
        )}
      >
        <div ref={menuRef} className="relative flex shrink-0">
          <button
            type="button"
            aria-label="Search options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Search options"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-6 items-center gap-0.5 rounded-l-md pr-0.5 pl-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Search className="size-3.5" />
            <ChevronDown className="size-2.5" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Search options"
              data-reader-popover=""
              className="absolute top-full left-0 z-50 mt-1 min-w-40 origin-top-left animate-in rounded-md border bg-background p-1 text-xs shadow-lg duration-150 fade-in-0 slide-in-from-top-1 zoom-in-[0.96] motion-reduce:animate-none"
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={search.caseSensitive}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setMenuOpen(false);
                  search.toggleCaseSensitive();
                }}
                className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span>
                  Match case <span className="font-mono text-muted-foreground">Aa</span>
                </span>
                {search.caseSensitive && <span aria-hidden="true">✓</span>}
              </button>
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="search"
          role="searchbox"
          aria-label="Search document"
          title={commandTooltip('Search', 'edit.find')}
          data-testid="search-input"
          data-command-scope="search"
          placeholder="Search"
          disabled={disabled}
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        <span
          role="status"
          aria-live="polite"
          data-testid="search-status"
          className={cn(
            'shrink-0 px-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums',
            !search.active && 'sr-only',
          )}
        >
          {searchStatusLabel(search)}
        </span>
        {search.active && (
          <>
            {onShowResults && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5.5 shrink-0"
                aria-label="Show search results"
                title="Show search results"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onShowResults}
              >
                <List />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-5.5 shrink-0"
              aria-label="Previous match"
              title={commandTooltip('Previous match', 'edit.findPrevious')}
              disabled={!hasResults}
              onMouseDown={(event) => event.preventDefault()}
              onClick={search.previousMatch}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-5.5 shrink-0"
              aria-label="Next match"
              title={commandTooltip('Next match', 'edit.findNext')}
              disabled={!hasResults}
              onMouseDown={(event) => event.preventDefault()}
              onClick={search.nextMatch}
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="mr-0.5 size-5.5 shrink-0"
              aria-label={searching ? 'Cancel search' : 'Clear search'}
              title={searching ? 'Cancel search' : 'Clear search'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (searching) {
                  search.cancelSearch();
                  return;
                }
                search.clearSearch();
                inputRef.current?.focus();
              }}
            >
              <X />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The Navigator's Search tab: every match with its context, grouped by chapter
 * or page where the format has them. Click or Return jumps.
 */
export function SearchResultsList<TMatch extends DocumentSearchResultItem>({
  search,
  grouped,
}: {
  search: DocumentSearchController<TMatch>;
  /** Group consecutive matches under their location (chapter, page). */
  grouped: boolean;
}) {
  const roving = useRovingList(search.results.length);
  const searching = search.status === 'searching';
  const count = search.results.length;

  let summary = `${count} ${count === 1 ? 'match' : 'matches'}`;
  if (searching) summary = count > 0 ? `${count} so far…` : 'Searching…';
  else if (search.status === 'cancelled') summary = `Cancelled · ${summary}`;

  const rows: { item: TMatch; index: number; groupStart: boolean }[] = search.results.map(
    (item, index) => ({
      item,
      index,
      groupStart: grouped && search.results[index - 1]?.locationLabel !== item.locationLabel,
    }),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="search-results-panel">
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b px-3 text-[11px] text-muted-foreground">
        <span className="truncate">
          {search.active ? (
            <>
              {summary} for “<span className="text-foreground">{search.query}</span>”
            </>
          ) : (
            'Type in the search field to find text.'
          )}
        </span>
        {searching && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={search.cancelSearch}
          >
            Stop
          </Button>
        )}
      </div>
      {search.active && count === 0 && !searching ? (
        <p className="px-3 py-3 text-[13px] text-muted-foreground">
          No matches. Check the spelling, or turn off Match Case in the search field’s menu.
        </p>
      ) : (
        <ol
          {...roving.listProps}
          aria-label="Search results"
          data-testid="search-results"
          data-arrow-keys=""
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {rows.map(({ item, index, groupStart }) => {
            const active = index === search.activeIndex;
            return (
              <li key={item.id}>
                {groupStart && (
                  <div
                    data-testid="search-result-location"
                    className="sticky top-0 z-10 truncate bg-background/95 px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground backdrop-blur-sm"
                  >
                    {item.locationLabel}
                  </div>
                )}
                <button
                  type="button"
                  data-roving-row=""
                  data-testid="search-result-item"
                  tabIndex={roving.tabIndexFor(index)}
                  aria-current={active ? 'location' : undefined}
                  onFocus={() => roving.onRowFocus(index)}
                  onKeyDown={(event) => roving.onRowKeyDown(event, index)}
                  onClick={() => search.selectMatch(index)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-md px-3 py-1.5 text-left text-[13px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                >
                  {!grouped && (
                    <span
                      data-testid="search-result-location"
                      className="text-[11px] text-muted-foreground tabular-nums"
                    >
                      {item.locationLabel}
                    </span>
                  )}
                  <span data-testid="search-result-snippet" className="line-clamp-2 break-words">
                    {item.contextBefore}
                    <mark className="bg-transparent font-bold text-foreground">
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
