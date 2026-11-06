import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  ListTree,
  RotateCcw,
  ScrollText,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  AnnotationsListToggleButton,
  AnnotationsPanel,
  SelectionAnnotationControls,
  SelectionNoteComposer,
  useAnnotationsController,
} from '@/features/reader/AnnotationsPanel';
import {
  BookmarksListToggleButton,
  BookmarksPanel,
  BookmarkToggleButton,
  useBookmarksController,
} from '@/features/reader/BookmarksPanel';
import {
  DocumentSearchBar,
  DocumentSearchToggleButton,
  SEARCH_HIGHLIGHT_COLOR,
  SEARCH_HIGHLIGHT_ID,
  useDocumentSearch,
} from '@/features/reader/DocumentSearchBar';
import { type OutlineNode, OutlineSidebar } from '@/features/reader/OutlineSidebar';
import { PULSE_MS } from '@/features/reader/pulse';
import {
  READING_WIDTH_CLASSES,
  ReadingPreferencesBar,
  ReadingPreferencesToggleButton,
  THEME_SURFACE_CLASSES,
  useReadingPreferencesPanel,
} from '@/features/reader/ReadingPreferencesBar';
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

const READING_MODES: readonly {
  mode: EpubReadingMode;
  label: string;
  icon: typeof BookOpen;
}[] = [
  { mode: 'spread', label: 'Two pages', icon: BookOpen },
  { mode: 'paged', label: 'Single page', icon: FileText },
  { mode: 'scroll', label: 'Scroll', icon: ScrollText },
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

function findOutlineLabel(items: readonly EpubTocItem[], href: string): string | null {
  const cleanHref = (href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');
  for (const item of items) {
    const cleanTarget = (item.href.split('#')[0] ?? '').replace(/^(\.\/|\/)+/, '');
    if (
      cleanHref &&
      cleanTarget &&
      (cleanHref === cleanTarget ||
        cleanHref.endsWith(`/${cleanTarget}`) ||
        cleanTarget.endsWith(`/${cleanHref}`))
    ) {
      return item.label;
    }
    const nested = findOutlineLabel(item.children, href);
    if (nested) return nested;
  }
  return null;
}

function shouldIgnoreKeyEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return true;
  }
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
    return true;
  }
  return (
    target.closest(
      '[contenteditable="true"], [role="textbox"], [role="slider"], [role="separator"], [role="tablist"], .react-flow',
    ) !== null
  );
}
/** EPUB reader: epub.js renders each chapter in an iframe, addressed by CFI. */
export function EpubViewer({
  document,
  isActive,
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
  const [tocOpen, setTocOpen] = useState(false);

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
  const [returnStack, setReturnStack] = useState<string[]>([]);
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
            setReturnStack((stack) => (stack.at(-1) === previous ? stack : [...stack, previous]));
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
    [handle],
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
    ): Promise<readonly EpubSearchMatch[]> => {
      if (!handle?.searchChapter) return [];
      const count = handle.chapterCount ?? 0;
      const matches: EpubSearchMatch[] = [];
      for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
        if (signal.aborted) return [];
        const chapterMatches = await handle.searchChapter(chapterIndex, query, { caseSensitive });
        if (signal.aborted) return [];
        matches.push(...chapterMatches);
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
            setReturnStack((stack) => (stack.at(-1) === previous ? stack : [...stack, previous]));
          }
        })
        .catch(() => {
          setStaleBookmarkIds((prev) => new Set(prev).add(bookmark.id));
          setMissedJump(true);
        });
    },
    [handle],
  );

  const bookmarksController = useBookmarksController<'epub'>({
    documentId,
    isActive,
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
            setReturnStack((stack) => (stack.at(-1) === previous ? stack : [...stack, previous]));
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
    [handle],
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
        setReturnStack((stack) => (stack.at(-1) === previous ? stack : [...stack, previous]));
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
  }, [handle, jumpRequest, onJumpHandled]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (search.handleKeyDown(event)) return;
      if (bookmarksController.handleKeyDown(event)) return;
      if (shouldIgnoreKeyEvent(event)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void handle.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void handle.previous();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    handle.onKeyDown(onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      handle.onKeyDown(() => undefined);
    };
  }, [bookmarksController, handle, isActive, search]);

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

  const isTocTargetActive = (target: string): boolean => {
    if (!currentHref || target.includes('#')) return false;
    const cleanTarget = target.replace(/^(\.\/|\/)+/, '');
    const cleanHref = currentHref.replace(/^(\.\/|\/)+/, '');
    return (
      cleanHref === cleanTarget ||
      cleanHref.endsWith(`/${cleanTarget}`) ||
      cleanTarget.endsWith(`/${cleanHref}`)
    );
  };

  const handleTocSelect = (target: string) => {
    if (!handle) return;
    const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
    void handle
      .display(target)
      .then(() => {
        if (previous && previous !== target) {
          setReturnStack((stack) => (stack.at(-1) === previous ? stack : [...stack, previous]));
        }
      })
      .catch(() => undefined);
  };

  const handleReturnBack = () => {
    const target = returnStack.at(-1);
    if (!handle || !target) return;
    setReturnStack((stack) => stack.slice(0, -1));
    void handle.display(target).catch(() => undefined);
  };

  if (error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not open {document.title}: {error}
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      data-testid="epub-viewer"
      data-reading-mode={readingMode}
      data-reading-theme={effectivePreferences.theme}
      data-reading-width={effectivePreferences.readingWidth}
    >
      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b bg-background px-2 py-1 text-foreground">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant={tocOpen ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs"
            aria-label="Table of contents"
            aria-pressed={tocOpen}
            disabled={!handle}
            onClick={() => setTocOpen((open) => !open)}
          >
            <ListTree />
            Contents
          </Button>
          {returnStack.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              aria-label="Return to previous location"
              disabled={!handle}
              onClick={handleReturnBack}
            >
              <RotateCcw />
              Back
            </Button>
          )}
          <div role="group" aria-label="Reading mode" className="flex items-center gap-0.5">
            {READING_MODES.map(({ mode, label, icon: Icon }) => {
              const active = readingMode === mode;
              return (
                <Button
                  key={mode}
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  aria-pressed={active}
                  disabled={!handle}
                  onClick={() => updatePreferences({ epubReadingMode: mode })}
                >
                  <Icon />
                  {label}
                </Button>
              );
            })}
          </div>
          <ReadingPreferencesToggleButton
            open={preferencesPanel.open}
            disabled={!handle}
            onToggle={preferencesPanel.toggle}
          />
          <DocumentSearchToggleButton
            open={search.open}
            disabled={!handle}
            onToggle={search.toggleSearch}
          />
          <BookmarkToggleButton
            bookmarked={bookmarksController.isCurrentBookmarked}
            disabled={!handle}
            onToggle={bookmarksController.toggleCurrentBookmark}
          />
          <BookmarksListToggleButton
            open={bookmarksController.open}
            count={bookmarksController.bookmarks.length}
            disabled={!handle}
            onToggle={bookmarksController.togglePanel}
          />
          <AnnotationsListToggleButton
            open={annotationsController.open}
            count={annotationsController.annotations.length}
            disabled={!handle}
            onToggle={annotationsController.togglePanel}
          />
          <SelectionAnnotationControls
            hasSelection={activeSelection !== null}
            controller={annotationsController}
            disabled={!handle}
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
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
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!handle}
            onClick={() => void handle?.previous()}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!handle}
            onClick={() => void handle?.next()}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
      {preferencesPanel.open && (
        <ReadingPreferencesBar
          preferences={effectivePreferences}
          disabled={!handle}
          onChange={updatePreferences}
        />
      )}
      <DocumentSearchBar search={search} />
      <BookmarksPanel controller={bookmarksController} />
      <SelectionNoteComposer
        hasSelection={activeSelection !== null}
        controller={annotationsController}
      />
      <AnnotationsPanel controller={annotationsController} />
      {missedJump && (
        <p role="status" className="shrink-0 border-b bg-muted px-4 py-1.5 text-xs">
          That excerpt could not be found in this book. The file may have changed.
        </p>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {tocOpen && (
          <OutlineSidebar
            items={outlineItems}
            isActive={isTocTargetActive}
            emptyMessage="No table of contents in this book."
            onSelect={handleTocSelect}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden bg-muted/30 px-2 py-1.5">
          <div
            ref={hostRef}
            data-testid="epub-host"
            className={cn(
              'relative h-full w-full overflow-hidden rounded-sm shadow-sm ring-1 ring-black/5',
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
  );
}
