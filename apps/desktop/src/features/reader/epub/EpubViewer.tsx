import { BookOpen, ChevronLeft, ChevronRight, FileText, PanelLeft, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { type SegmentedOption, SegmentedControl } from '@/components/ui/segmented-control';
import { dispatchCommandKeydown } from '@/features/commands/registry';
import {
  type AnnotationPlacement,
  SelectionAnnotationControls,
  SelectionNoteComposer,
  useAnnotationsController,
} from '@/features/reader/AnnotationsPanel';
import { BookmarkToggleButton, useBookmarksController } from '@/features/reader/BookmarksPanel';
import {
  SEARCH_HIGHLIGHT_COLOR,
  SEARCH_HIGHLIGHT_ID,
  ToolbarSearchField,
  useDocumentSearch,
} from '@/features/reader/DocumentSearch';
import { ReaderNavigator } from '@/features/reader/navigator/NavigatorSidebar';
import { indexOutline, type OutlineNode } from '@/features/reader/navigator/OutlineTree';
import { useNavigator } from '@/features/reader/navigator/useNavigator';
import { PULSE_MS } from '@/features/reader/pulse';
import {
  HistoryButtons,
  ReaderPopoverLayer,
  ReaderToolbar,
  ToolbarButton,
  ToolbarSeparator,
  ToolbarTitle,
} from '@/features/reader/ReaderToolbar';
import {
  READING_WIDTH_CLASSES,
  ReadingPreferencesBar,
  ReadingPreferencesToggleButton,
  THEME_SURFACE_CLASSES,
  useReadingPreferencesPanel,
} from '@/features/reader/ReadingPreferencesBar';
import { useMarkupToolbar, useReaderCommands } from '@/features/reader/useReaderCommands';
import { useJumpHistory } from '@/features/reader/useJumpHistory';
import { cn, describeError } from '@/lib/utils';
import {
  type Annotation,
  type Bookmark,
  DEFAULT_READING_PREFERENCES,
  type DocumentViewerProps,
  type EpubAnchor,
  type ReaderSelection,
  type ReadingPreferences,
} from '@/types/domain';

import {
  type EpubHandle,
  type EpubLocation,
  type EpubReadingMode,
  type EpubSearchMatch,
  type EpubTocItem,
  openEpubDocument,
} from './epubEngine';

const CURSOR_DEBOUNCE_MS = 400;
const FALLBACK_HIGHLIGHT = '#fde047';
/** Marks are drawn just after a chapter displays, so a pulse waits for them this long. */
const MARK_WAIT_MS = 2000;
const MARK_POLL_MS = 50;

const READING_MODES: readonly SegmentedOption<EpubReadingMode>[] = [
  { value: 'spread', label: 'Two pages', icon: BookOpen },
  { value: 'paged', label: 'Single page', icon: FileText },
  { value: 'scroll', label: 'Scroll', icon: ScrollText },
];

const asEpubAnchor = (anchor: { format: string } | null | undefined): EpubAnchor | null =>
  anchor?.format === 'epub' ? (anchor as EpubAnchor) : null;

function toOutlineNodes(items: readonly EpubTocItem[]): OutlineNode<string>[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    target: item.href || null,
    children: toOutlineNodes(item.children),
  }));
}

const cleanChapterPath = (href: string) => (href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');

/** Whether two hrefs name the same chapter file, ignoring fragments and relative prefixes. */
function sameChapter(a: string, b: string): boolean {
  const left = cleanChapterPath(a);
  const right = cleanChapterPath(b);
  return (
    left !== '' &&
    right !== '' &&
    (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`))
  );
}

function findOutlineItem(items: readonly EpubTocItem[], href: string): EpubTocItem | null {
  for (const item of items) {
    if (sameChapter(item.href, href)) return item;
    const nested = findOutlineItem(item.children, href);
    if (nested) return nested;
  }
  return null;
}

function findOutlineLabel(items: readonly EpubTocItem[], href: string): string | null {
  return findOutlineItem(items, href)?.label ?? null;
}

/**
 * The TOC entry for the chapter being read: one that names the chapter file
 * itself, else the first that points into it.
 */
function currentTocId(items: readonly EpubTocItem[], href: string | null): string | null {
  if (!href) return null;
  let inFile: string | null = null;
  const walk = (nodes: readonly EpubTocItem[]): string | null => {
    for (const item of nodes) {
      if (sameChapter(item.href, href)) {
        if (!item.href.includes('#')) return item.id;
        inFile ??= item.id;
      }
      const nested = walk(item.children);
      if (nested) return nested;
    }
    return null;
  };
  return walk(items) ?? inFile;
}

/** EPUB reader: epub.js renders each chapter in an iframe, addressed by CFI. */
export function EpubViewer({
  document,
  isActive,
  chromeHidden = false,
  content,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
  onCursorChange,
  preferences,
  onPreferencesChange,
  bookmarks,
  onAddBookmark,
  onRemoveBookmark,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  canUndoAnnotationDelete,
  onUndoAnnotationDelete,
}: DocumentViewerProps<'epub'>) {
  const documentId = document.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<EpubHandle | null>(null);
  const [activeSelection, setActiveSelection] = useState<ReaderSelection | null>(null);
  const [staleAnnotationIds, setStaleAnnotationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [localPreferences, setLocalPreferences] = useState<ReadingPreferences>(
    () => preferences ?? DEFAULT_READING_PREFERENCES,
  );
  const effectivePreferences = preferences ?? localPreferences;
  const readingMode = effectivePreferences.epubReadingMode;
  const preferencesPanel = useReadingPreferencesPanel();
  const navigator = useNavigator('epub', ['contents', 'notes', 'bookmarks']);

  const updatePreferences = (patch: Partial<ReadingPreferences>) => {
    setLocalPreferences((prev) => ({ ...(preferences ?? prev), ...patch }));
    onPreferencesChange?.(patch);
  };
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [staleBookmarkIds, setStaleBookmarkIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pageInfo, setPageInfo] = useState<{ page: number; totalPages: number } | null>(null);
  const [bookProgress, setBookProgress] = useState<{
    chapter: number;
    totalChapters: number;
    percent: number;
  } | null>(null);
  const history = useJumpHistory<string>();
  const pushHistory = history.push;
  const markup = useMarkupToolbar();
  const [error, setError] = useState<string | null>(null);
  const [missedJump, setMissedJump] = useState(false);
  // Taken once: the store feeds every cursor report back through this prop.
  const [initialCursor] = useState(() => asEpubAnchor(document.lastCursorAnchor));
  const [initialJump] = useState(jumpRequest);
  const currentLocationRef = useRef<EpubLocation | null>(null);

  // Callbacks and flags the long-lived engine listeners read at the time they fire.
  const latest = useRef({ isActive, onSelectionChange, onCursorChange });
  useEffect(() => {
    latest.current = { isActive, onSelectionChange, onCursorChange };
  });

  // ---- Opening, and reporting the reading position -------------------------

  const restored = useRef(false);
  const lastReported = useRef(initialCursor?.cfiRange ?? null);
  const pendingLocation = useRef<EpubLocation | null>(null);
  const cursorTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let opened: EpubHandle | null = null;

    const flushCursor = () => {
      const location = pendingLocation.current;
      pendingLocation.current = null;
      if (!location || location.cfi === lastReported.current) return;
      lastReported.current = location.cfi;
      latest.current.onCursorChange({
        format: 'epub',
        cfiRange: location.cfi,
        chapterHref: location.href,
      });
    };

    void (async () => {
      try {
        const source = await content.loadDocumentSource(document);
        if (cancelled) return;
        const engine = await openEpubDocument(
          source,
          host,
          effectivePreferences.epubReadingMode,
          effectivePreferences,
        );
        if (cancelled) {
          engine.destroy();
          return;
        }
        opened = engine;

        let hasSelection = false;
        engine.onSelection((selection) => {
          if (!latest.current.isActive) return;
          if (!selection) {
            if (hasSelection) {
              setActiveSelection(null);
              latest.current.onSelectionChange(null);
            }
            hasSelection = false;
            return;
          }
          hasSelection = true;
          const nextSelection: ReaderSelection = {
            documentId,
            anchor: {
              format: 'epub',
              cfiRange: selection.cfiRange,
              chapterHref: selection.chapterHref,
            },
            text: selection.text,
            imagePng: null,
          };
          setActiveSelection(nextSelection);
          latest.current.onSelectionChange(nextSelection);
        });
        engine.onLocation((location) => {
          currentLocationRef.current = location;
          setCurrentHref(location.href);
          setCurrentCfi(location.cfi);
          if (location.page !== undefined && location.totalPages !== undefined) {
            setPageInfo({ page: location.page, totalPages: location.totalPages });
          }
          if (
            location.chapterIndex !== undefined &&
            location.totalChapters !== undefined &&
            location.totalChapters > 0
          ) {
            const percent =
              location.bookProgress ??
              Math.round(((location.chapterIndex + 1) / location.totalChapters) * 100);
            setBookProgress({
              chapter: location.chapterIndex + 1,
              totalChapters: location.totalChapters,
              percent,
            });
          }
          // Layout during opening reports positions the reader never chose.
          if (!restored.current) return;
          pendingLocation.current = location;
          window.clearTimeout(cursorTimer.current);
          cursorTimer.current = window.setTimeout(flushCursor, CURSOR_DEBOUNCE_MS);
        });
        const target = initialJump ? undefined : initialCursor?.cfiRange;
        // An unusable saved position must not stop the book from opening.
        await engine.display(target).catch(() => engine.display());
        if (cancelled) return;
        restored.current = true;
        setHandle(engine);
      } catch (cause) {
        if (!cancelled) setError(describeError(cause));
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(cursorTimer.current);
      flushCursor();
      restored.current = false;
      opened?.destroy();
    };
    // Only the file matters: `document` changes each time the cursor is reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, documentId]);

  // ---- Highlights ----------------------------------------------------------

  const painted = useRef(new Map<string, { cfiRange: string; color: string }>());
  const searchPulseCleanupRef = useRef<(() => void) | null>(null);

  const navigateToSearchMatch = useCallback(
    (match: EpubSearchMatch) => {
      if (!handle) return;
      searchPulseCleanupRef.current?.();
      searchPulseCleanupRef.current = null;

      let cancelled = false;
      let endPulse: number | undefined;
      let pollForMarks: number | undefined;
      searchPulseCleanupRef.current = () => {
        cancelled = true;
        window.clearTimeout(endPulse);
        window.clearTimeout(pollForMarks);
        handle.setPulse(SEARCH_HIGHLIGHT_ID, false);
      };

      const existingSearch = painted.current.get(SEARCH_HIGHLIGHT_ID);
      if (existingSearch && existingSearch.cfiRange !== match.cfiRange) {
        handle.removeHighlight(existingSearch.cfiRange);
        painted.current.delete(SEARCH_HIGHLIGHT_ID);
      }
      if (!painted.current.has(SEARCH_HIGHLIGHT_ID)) {
        handle.highlight(SEARCH_HIGHLIGHT_ID, match.cfiRange, SEARCH_HIGHLIGHT_COLOR);
        painted.current.set(SEARCH_HIGHLIGHT_ID, {
          cfiRange: match.cfiRange,
          color: SEARCH_HIGHLIGHT_COLOR,
        });
      }

      const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
      void handle
        .display(match.cfiRange)
        .then(() => {
          if (cancelled) return;
          if (previous && previous !== match.cfiRange) {
            pushHistory(previous);
          }
          const waitedSince = performance.now();
          const startPulse = () => {
            if (cancelled) return;
            const hasMarks = handle.setPulse(SEARCH_HIGHLIGHT_ID, true);
            if (!hasMarks && performance.now() - waitedSince < MARK_WAIT_MS) {
              pollForMarks = window.setTimeout(startPulse, MARK_POLL_MS);
              return;
            }
            endPulse = window.setTimeout(() => {
              handle.setPulse(SEARCH_HIGHLIGHT_ID, false);
            }, PULSE_MS);
          };
          startPulse();
        })
        .catch(() => undefined);
    },
    [handle, pushHistory],
  );

  useEffect(
    () => () => {
      searchPulseCleanupRef.current?.();
    },
    [],
  );

  const runEpubSearch = useCallback(
    async (
      query: string,
      caseSensitive: boolean,
      signal: AbortSignal,
      onProgress: (matchesSoFar: readonly EpubSearchMatch[]) => void,
    ): Promise<readonly EpubSearchMatch[]> => {
      if (!handle?.searchChapter) return [];
      const count = handle.chapterCount ?? 0;
      const matches: EpubSearchMatch[] = [];
      for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
        if (signal.aborted) return [];
        const chapterMatches = await handle.searchChapter(chapterIndex, query, { caseSensitive });
        if (signal.aborted) return [];
        if (chapterMatches.length > 0) {
          matches.push(...chapterMatches);
          onProgress([...matches]);
        }
      }
      return matches;
    },
    [handle],
  );

  const search = useDocumentSearch<EpubSearchMatch>({
    isActive,
    runSearch: runEpubSearch,
    onNavigateToMatch: navigateToSearchMatch,
    searchRevision: Boolean(handle),
  });

  const activeSearchMatch = search.activeMatch;

  const navigateToBookmark = useCallback(
    (bookmark: Bookmark) => {
      if (!handle) return;
      const epubAnchor = asEpubAnchor(bookmark.anchor);
      if (!epubAnchor) {
        setMissedJump(true);
        return;
      }
      const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
      void handle
        .display(epubAnchor.cfiRange)
        .then(() => {
          setMissedJump(false);
          if (previous && previous !== epubAnchor.cfiRange) {
            pushHistory(previous);
          }
        })
        .catch(() => {
          setStaleBookmarkIds((prev) => new Set(prev).add(bookmark.id));
          setMissedJump(true);
        });
    },
    [handle, pushHistory],
  );

  const bookmarksController = useBookmarksController<'epub'>({
    documentId,
    bookmarks,
    onAddBookmark,
    onRemoveBookmark,
    getCurrentLocation: () => {
      const loc = currentLocationRef.current;
      const cfiRange = loc?.cfi ?? currentCfi ?? initialCursor?.cfiRange ?? 'epubcfi(/6/2!/4/2)';
      const chapterHref =
        loc?.href ??
        currentHref ??
        initialCursor?.chapterHref ??
        handle?.toc[0]?.href ??
        'chapter-1.xhtml';
      const chapterTitle =
        findOutlineLabel(handle?.toc ?? [], chapterHref) ??
        (bookProgress ? `Ch. ${bookProgress.chapter}` : chapterHref);
      const label =
        readingMode !== 'scroll' && pageInfo
          ? `${chapterTitle} · Page ${pageInfo.page}`
          : chapterTitle;
      return {
        anchor: { format: 'epub', cfiRange, chapterHref },
        label,
      };
    },
    isActiveBookmark: (bookmark) => {
      const epubAnchor = asEpubAnchor(bookmark.anchor);
      if (!epubAnchor) return false;
      const activeCfi = currentCfi ?? currentLocationRef.current?.cfi ?? initialCursor?.cfiRange;
      if (activeCfi) return epubAnchor.cfiRange === activeCfi;
      return currentHref !== null && epubAnchor.chapterHref === currentHref;
    },
    isStaleBookmark: (bookmark) => staleBookmarkIds.has(bookmark.id),
    onSelectBookmark: navigateToBookmark,
  });

  const navigateToAnnotation = useCallback(
    (annotation: Annotation) => {
      if (!handle) return;
      const epubAnchor = asEpubAnchor(annotation.anchor);
      if (!epubAnchor) {
        setMissedJump(true);
        return;
      }
      const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
      void handle
        .display(epubAnchor.cfiRange)
        .then(() => {
          setMissedJump(false);
          if (previous && previous !== epubAnchor.cfiRange) {
            pushHistory(previous);
          }
          handle.setPulse(annotation.id, true);
          window.setTimeout(() => {
            handle.setPulse(annotation.id, false);
          }, PULSE_MS);
        })
        .catch(() => {
          setStaleAnnotationIds((prev) => new Set(prev).add(annotation.id));
          setMissedJump(true);
        });
    },
    [handle, pushHistory],
  );

  const clearSelectionAfterAnnotate = useCallback(() => {
    handle?.clearSelection();
    setActiveSelection(null);
    onSelectionChange(null);
  }, [handle, onSelectionChange]);

  const annotationsController = useAnnotationsController({
    documentId,
    selection: activeSelection,
    annotations,
    onCreateAnnotation: onCreateAnnotation
      ? (options) => {
          onCreateAnnotation(options);
          clearSelectionAfterAnnotate();
        }
      : undefined,
    onUpdateAnnotation,
    onDeleteAnnotation,
    canUndoAnnotationDelete,
    onUndoAnnotationDelete,
    isStaleAnnotation: (annotation) => staleAnnotationIds.has(annotation.id),
    onSelectAnnotation: navigateToAnnotation,
  });

  const effectiveHighlights = useMemo(() => {
    if (annotations !== undefined) return highlights;
    return [
      ...highlights,
      ...annotationsController.annotations.map(({ id, anchor, color }) => ({
        annotationId: id,
        anchor,
        color,
      })),
    ];
  }, [annotations, annotationsController.annotations, highlights]);

  useEffect(() => {
    if (!handle) return;
    const wanted = new Map<string, { cfiRange: string; color: string }>();
    for (const { annotationId, anchor, color } of effectiveHighlights) {
      const epubAnchor = asEpubAnchor(anchor);
      if (epubAnchor) wanted.set(annotationId, { cfiRange: epubAnchor.cfiRange, color });
    }
    // A jump can target an annotation from another notebook, with no highlight here.
    const jumpAnchor = asEpubAnchor(jumpRequest?.anchor);
    if (jumpRequest && jumpAnchor && !wanted.has(jumpRequest.annotationId)) {
      wanted.set(jumpRequest.annotationId, {
        cfiRange: jumpAnchor.cfiRange,
        color: FALLBACK_HIGHLIGHT,
      });
    }
    if (activeSearchMatch) {
      wanted.set(SEARCH_HIGHLIGHT_ID, {
        cfiRange: activeSearchMatch.cfiRange,
        color: SEARCH_HIGHLIGHT_COLOR,
      });
    }

    for (const [annotationId, existing] of painted.current) {
      const next = wanted.get(annotationId);
      if (!next || next.cfiRange !== existing.cfiRange || next.color !== existing.color) {
        handle.removeHighlight(existing.cfiRange);
        painted.current.delete(annotationId);
      }
    }
    for (const [annotationId, { cfiRange, color }] of wanted) {
      if (!painted.current.has(annotationId)) {
        handle.highlight(annotationId, cfiRange, color);
        painted.current.set(annotationId, { cfiRange, color });
      }
    }
  }, [handle, effectiveHighlights, jumpRequest, activeSearchMatch]);

  // ---- Jumping -------------------------------------------------------------

  useEffect(() => {
    if (!handle || !jumpRequest) return;
    const { nonce, annotationId } = jumpRequest;
    const anchor = asEpubAnchor(jumpRequest.anchor);
    let cancelled = false;
    let endPulse: number | undefined;
    let pollForMarks: number | undefined;

    const finish = (found: boolean) => {
      if (cancelled) return;
      setMissedJump(!found);
      onJumpHandled(nonce);
    };

    void (async () => {
      const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
      try {
        if (!anchor) throw new Error('not an EPUB anchor');
        await handle.display(anchor.cfiRange);
      } catch {
        finish(false);
        return;
      }
      if (cancelled) return;
      if (previous && previous !== anchor.cfiRange) {
        pushHistory(previous);
      }
      const waitedSince = performance.now();
      const startPulse = () => {
        if (cancelled) return;
        const hasMarks = handle.setPulse(annotationId, true);
        if (!hasMarks && performance.now() - waitedSince < MARK_WAIT_MS) {
          pollForMarks = window.setTimeout(startPulse, MARK_POLL_MS);
          return;
        }
        endPulse = window.setTimeout(() => {
          handle.setPulse(annotationId, false);
          finish(true);
        }, PULSE_MS);
      };
      startPulse();
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(endPulse);
      window.clearTimeout(pollForMarks);
      handle.setPulse(annotationId, false);
    };
  }, [handle, jumpRequest, onJumpHandled, pushHistory]);

  // ---- Reading mode, keyboard navigation, and pane changes -----------------

  useEffect(() => {
    if (!handle) return;
    void handle.setReadingMode(readingMode);
  }, [handle, readingMode]);

  useEffect(() => {
    if (!handle) return;
    handle.setPreferences(effectivePreferences);
  }, [handle, effectivePreferences]);

  useLayoutEffect(() => {
    if (!handle || !isActive) return;
    // Keys typed inside a chapter's iframe never reach the window, so the frame
    // forwards them: Escape closes Find, and every shortcut reaches the registry.
    const onFrameKeyDown = (event: KeyboardEvent) => {
      if (search.handleKeyDown(event)) return;
      dispatchCommandKeydown(event);
    };
    handle.onKeyDown(onFrameKeyDown);
    return () => {
      handle.onKeyDown(() => undefined);
    };
  }, [handle, isActive, search]);

  useEffect(() => {
    // The store drops the selection on a tab switch; keep the frame in step.
    if (handle && !isActive) handle.clearSelection();
  }, [handle, isActive]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !handle) return;
    let timer: number | undefined;
    let size = { width: host.clientWidth, height: host.clientHeight };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = { width: host.clientWidth, height: host.clientHeight };
        if (next.width === size.width && next.height === size.height) return;
        size = next;
        handle.resize(next.width, next.height);
      }, 150);
    });
    observer.observe(host);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [handle, readingMode, effectivePreferences.readingWidth]);

  const outlineItems = useMemo(() => toOutlineNodes(handle?.toc ?? []), [handle]);

  const tocIndex = useMemo(() => indexOutline(outlineItems), [outlineItems]);
  const annotationPlacement = (annotation: Annotation): AnnotationPlacement => {
    const anchor = asEpubAnchor(annotation.anchor);
    const item = anchor ? findOutlineItem(handle?.toc ?? [], anchor.chapterHref) : null;
    return {
      group: item?.label ?? anchor?.chapterHref ?? 'Unknown chapter',
      // Book order where the TOC knows the chapter; others after, as created.
      order: item ? (tocIndex.get(item.id)?.order ?? 0) : Number.MAX_SAFE_INTEGER,
    };
  };

  const handleTocSelect = (target: string) => {
    if (!handle) return;
    const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
    void handle
      .display(target)
      .then(() => {
        if (previous && previous !== target) {
          pushHistory(previous);
        }
      })
      .catch(() => undefined);
  };

  const currentHistoryLocation = (): string =>
    currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? currentCfi ?? '';

  const handleReturnBack = () => {
    if (!handle) return;
    const target = history.goBack(currentHistoryLocation());
    if (target) void handle.display(target).catch(() => undefined);
  };

  const handleForward = () => {
    if (!handle) return;
    const target = history.goForward(currentHistoryLocation());
    if (target) void handle.display(target).catch(() => undefined);
  };

  // Entering focus mode puts the panels away; leaving it does not reopen them.
  const [wasChromeHidden, setWasChromeHidden] = useState(chromeHidden);
  if (wasChromeHidden !== chromeHidden) {
    setWasChromeHidden(chromeHidden);
    if (chromeHidden) {
      preferencesPanel.close();
    }
  }

  const ready = handle !== null;
  useReaderCommands({
    isActive,
    ready,
    chromeHidden,
    search,
    navigator,
    bookmarks: bookmarksController,
    annotations: annotationsController,
    selectionText: activeSelection?.text ?? null,
    markup,
    reflowable: {
      preferences: effectivePreferences,
      onChange: updatePreferences,
      panel: preferencesPanel,
    },
    extra: {
      'view.layoutSingle': {
        run: () => updatePreferences({ epubReadingMode: 'paged' }),
        enabled: ready,
      },
      'view.layoutTwoPage': {
        run: () => updatePreferences({ epubReadingMode: 'spread' }),
        enabled: ready,
      },
      'view.layoutScroll': {
        run: () => updatePreferences({ epubReadingMode: 'scroll' }),
        enabled: ready,
      },
      'go.previousPage': { run: () => void handle?.previous(), enabled: ready },
      'go.nextPage': { run: () => void handle?.next(), enabled: ready },
      'go.back': { run: handleReturnBack, enabled: ready && history.canGoBack },
      'go.forward': { run: handleForward, enabled: ready && history.canGoForward },
    },
  });

  if (error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not open {document.title}: {error}
      </div>
    );
  }

  const showSidebar = navigator.open && !chromeHidden;
  const progress = (
    <>
      {readingMode !== 'scroll' && pageInfo && (
        <span data-testid="epub-chapter-page">
          Chapter page {pageInfo.page} of {pageInfo.totalPages}
        </span>
      )}
      {bookProgress && (
        <span data-testid="epub-book-progress">
          Book {bookProgress.percent}% (Ch. {bookProgress.chapter}/{bookProgress.totalChapters})
        </span>
      )}
    </>
  );

  return (
    <div
      className="flex h-full flex-col"
      data-testid="epub-viewer"
      data-reading-mode={readingMode}
      data-reading-theme={effectivePreferences.theme}
      data-reading-width={effectivePreferences.readingWidth}
      data-chrome-hidden={chromeHidden || undefined}
    >
      <ReaderToolbar
        isActive={isActive}
        leading={
          <>
            <ToolbarButton
              icon={PanelLeft}
              label="Sidebar"
              command="view.toggleSidebar"
              pressed={showSidebar}
              testId="sidebar-toggle"
              disabled={!handle || chromeHidden}
              onClick={navigator.toggle}
            />
            <SegmentedControl
              label="Reading mode"
              options={READING_MODES}
              value={readingMode}
              disabled={!handle}
              onChange={(mode) => updatePreferences({ epubReadingMode: mode })}
            />
            <HistoryButtons
              canGoBack={history.canGoBack}
              canGoForward={history.canGoForward}
              disabled={!handle}
              onBack={handleReturnBack}
              onForward={handleForward}
            />
          </>
        }
        center={
          <>
            <ToolbarButton
              icon={ChevronLeft}
              label="Previous"
              command="go.previousPage"
              disabled={!handle}
              onClick={() => void handle?.previous()}
            />
            <ToolbarTitle title={document.title} subtitle={progress} />
            <ToolbarButton
              icon={ChevronRight}
              label="Next"
              command="go.nextPage"
              disabled={!handle}
              onClick={() => void handle?.next()}
            />
          </>
        }
        trailing={
          <>
            <ReadingPreferencesToggleButton
              open={preferencesPanel.open}
              disabled={!handle}
              onToggle={preferencesPanel.toggle}
            />
            {markup.visible && (
              <SelectionAnnotationControls
                hasSelection={activeSelection !== null}
                controller={annotationsController}
                disabled={!handle}
              />
            )}
            <ToolbarSeparator />
            <BookmarkToggleButton
              bookmarked={bookmarksController.isCurrentBookmarked}
              disabled={!handle}
              onToggle={bookmarksController.toggleCurrentBookmark}
            />
            <ToolbarSearchField
              search={search}
              disabled={!handle}
              onReturnFocus={() => hostRef.current?.focus({ preventScroll: true })}
            />
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {showSidebar && (
          <ReaderNavigator
            navigator={navigator}
            bookmarks={bookmarksController}
            annotations={annotationsController}
            search={search}
            groupSearchResults
            contents={{
              items: outlineItems,
              currentId: currentTocId(handle?.toc ?? [], currentHref),
              emptyMessage: 'No table of contents in this book.',
              onSelect: handleTocSelect,
            }}
            annotationPlacement={annotationPlacement}
          />
        )}
        {/* Notices float over the page column only, never over the sidebar. */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ReaderPopoverLayer>
            {preferencesPanel.open && (
              <ReadingPreferencesBar
                preferences={effectivePreferences}
                disabled={!handle}
                onChange={updatePreferences}
              />
            )}
            <SelectionNoteComposer
              hasSelection={activeSelection !== null}
              controller={annotationsController}
            />
            {missedJump && (
              <p role="status" className="bg-muted px-4 py-1.5 text-xs">
                That excerpt could not be found in this book. The file may have changed.
              </p>
            )}
          </ReaderPopoverLayer>
          <div
            className={cn(
              'relative flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden px-2 pt-1.5 pb-3',
              // In focus mode the whole reading area takes the page's theme color.
              chromeHidden ? THEME_SURFACE_CLASSES[effectivePreferences.theme] : 'bg-muted/30',
            )}
          >
            <div
              ref={hostRef}
              tabIndex={-1}
              data-testid="epub-host"
              className={cn(
                'relative h-full w-full overflow-hidden rounded-sm',
                !chromeHidden && 'shadow-sm ring-1 ring-black/5',
                THEME_SURFACE_CLASSES[effectivePreferences.theme],
                readingMode === 'spread'
                  ? 'max-w-none'
                  : READING_WIDTH_CLASSES[effectivePreferences.readingWidth],
              )}
            />
            {readingMode === 'spread' && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-black/8 max-md:hidden"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
