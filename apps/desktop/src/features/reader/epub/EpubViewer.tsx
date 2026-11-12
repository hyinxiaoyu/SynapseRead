import { BookOpen, FileText, PanelLeft, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { type SegmentedOption, SegmentedControl } from '@/components/ui/segmented-control';
import { dispatchEscape } from '@/features/commands/escape';
import { dispatchCommandKeydown } from '@/features/commands/registry';
import {
  type AnnotationPlacement,
  localHighlights,
  useAnnotationsController,
} from '@/features/reader/AnnotationsPanel';
import { BookmarkToggleButton, useBookmarksController } from '@/features/reader/BookmarksPanel';
import { useFocusPageOnActivate } from '@/features/reader/focusPage';
import { GoToField, parseGoToInput, useGoToField } from '@/features/reader/GoToField';
import {
  SEARCH_HIGHLIGHT_COLOR,
  SEARCH_HIGHLIGHT_ID,
  SEARCH_MATCH_COLOR,
  searchMatchId,
  type SearchOptions,
  ToolbarSearchField,
  useDocumentSearch,
} from '@/features/reader/DocumentSearch';
import { MarkupBar, MarkupToggleButton } from '@/features/reader/markup/MarkupBar';
import { dispatchColorShortcut } from '@/features/reader/markup/colorShortcut';
import { SelectionPopover } from '@/features/reader/markup/SelectionPopover';
import { useSelectionPopover } from '@/features/reader/markup/useSelectionPopover';
import { ReaderNavigator } from '@/features/reader/navigator/NavigatorSidebar';
import { indexOutline, type OutlineNode } from '@/features/reader/navigator/OutlineTree';
import { useNavigator } from '@/features/reader/navigator/useNavigator';
import { PULSE_MS } from '@/features/reader/pulse';
import { AppearanceMenu, useAppearancePanel } from '@/features/reader/appearance/AppearancePopover';
import { ReaderNotice, ReaderPopoverLayer } from '@/features/reader/ReaderNotice';
import {
  computeReadingLayout,
  EPUB_BASE_FONT_REM,
  measureCharWidth,
  rootFontSizePx,
} from '@/features/reader/appearance/measure';
import {
  DEFAULT_SERIF_STACK,
  fontStack,
  PAGE_PALETTES,
  pageFooterStyle,
  pageSurfaceStyle,
} from '@/features/reader/appearance/themes';
import { useResolvedReadingTheme } from '@/features/reader/appearance/useResolvedTheme';
import {
  HistoryButtons,
  ReaderToolbar,
  TOOLBAR_HEIGHT_PX,
  ToolbarButton,
  ToolbarSeparator,
  ToolbarTitle,
} from '@/features/reader/ReaderToolbar';
import {
  animatePageTurn,
  type TurnDirection,
  usePageTurnGestures,
  zoneCursor,
} from '@/features/reader/paging/pageTurn';
import { PageTurnChevrons } from '@/features/reader/paging/PageTurnChevrons';
import { PageTurnShadow } from '@/features/reader/paging/PageTurnShadow';
import {
  ReaderFooter,
  type ScrubberModel,
  scrubberSearchMarks,
} from '@/features/reader/progress/ReaderFooter';
import { useBackChip } from '@/features/reader/progress/useBackChip';
import type { FooterReadouts } from '@/features/reader/progress/useFooterReadout';
import { useMarkupToolbar, useReaderCommands } from '@/features/reader/useReaderCommands';
import { useJumpHistory, useSearchTrip } from '@/features/reader/useJumpHistory';
import { cn, describeError } from '@/lib/utils';
import {
  type Annotation,
  type AnnotationStyle,
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
import {
  bookFraction,
  locateBookFraction,
  measureBook,
  minutesLeftInSection,
  minutesLeftText,
  readCachedWeights,
  type TextWeights,
  writeCachedWeights,
} from './textWeights';

const CURSOR_DEBOUNCE_MS = 400;
const FALLBACK_HIGHLIGHT = '#fde047';
/** Marks are drawn just after a chapter displays, so a pulse waits for them this long. */
const MARK_WAIT_MS = 2000;
const MARK_POLL_MS = 50;

const READING_MODES: readonly SegmentedOption<EpubReadingMode>[] = [
  { value: 'spread', label: 'Two pages', icon: BookOpen, command: 'view.layoutTwoPage' },
  { value: 'paged', label: 'Single page', icon: FileText, command: 'view.layoutSingle' },
  { value: 'scroll', label: 'Scroll', icon: ScrollText, command: 'view.layoutScroll' },
];

/** A mark the viewer has asked epub.js to draw. */
interface PaintedMark {
  cfiRange: string;
  color: string;
  style: AnnotationStyle;
  hasNote: boolean;
}

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

function flattenToc(items: readonly EpubTocItem[]): EpubTocItem[] {
  return items.flatMap((item) => [item, ...flattenToc(item.children)]);
}

/** The title to show for each spine chapter: the last TOC entry at or before it. */
function chapterTitlesBySpine(handle: EpubHandle | null): readonly (string | null)[] {
  const count = handle?.chapterCount ?? 0;
  if (!handle || count === 0) return [];
  const titles: (string | null)[] = Array.from({ length: count }, () => null);
  for (const item of flattenToc(handle.toc)) {
    const index = handle.spineIndexOf(item.href);
    if (index >= 0 && titles[index] === null) titles[index] = item.label;
  }
  for (let index = 1; index < count; index += 1) titles[index] ??= titles[index - 1] ?? null;
  return titles;
}

/**
 * A tick where each top-level chapter starts, or each spine file without a TOC,
 * placed by the text before it once the book has been measured.
 */
function chapterTicks(
  handle: EpubHandle | null,
  weights: TextWeights | null,
): ScrubberModel['ticks'] {
  const count = handle?.chapterCount ?? 0;
  if (!handle || count <= 1) return [];
  const starts = new Map<number, string>();
  for (const item of handle.toc) {
    const index = handle.spineIndexOf(item.href);
    if (index > 0 && !starts.has(index)) starts.set(index, item.label);
  }
  if (handle.toc.length === 0) {
    for (let index = 1; index < count; index += 1) starts.set(index, `Chapter ${index + 1}`);
  }
  return [...starts].map(([index, label]) => ({
    position: bookFraction(weights, count, index, 0),
    label,
  }));
}

/**
 * How far through the book a location's page ends, `0..1`, once the book's text
 * has been measured: what "of book" and the Recent list say. Undefined before.
 */
function measuredProgress(location: EpubLocation, weights: TextWeights | null): number | undefined {
  const { chapterIndex, totalChapters } = location;
  if (!weights || chapterIndex === undefined || totalChapters === undefined) return undefined;
  if (weights.sections.length !== totalChapters) return undefined;
  const within = location.chapterEnd ?? location.chapterStart ?? 0;
  // Four places is finer than any percentage shown and keeps reports from jittering.
  return Math.round(bookFraction(weights, totalChapters, chapterIndex, within) * 1e4) / 1e4;
}

const pagesLeftText = (left: number) =>
  left <= 0
    ? 'Last page in chapter'
    : left === 1
      ? '1 page left in chapter'
      : `${left} pages left in chapter`;

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
  onExcerptSelection,
  canExcerpt,
}: DocumentViewerProps<'epub'>) {
  const documentId = document.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const turnShadowRef = useRef<HTMLDivElement>(null);
  const readerAreaRef = useRef<HTMLDivElement>(null);
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
  const preferencesPanel = useAppearancePanel();
  const theme = useResolvedReadingTheme(effectivePreferences.theme);
  // The engine paints the page; it gets the theme already settled against the system.
  const enginePreferences = useMemo(
    () => ({ ...effectivePreferences, theme }),
    [effectivePreferences, theme],
  );

  // ---- Reading measure: column count and page width -------------------------

  const areaRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    setAvailableWidth(area.clientWidth);
    const observer = new ResizeObserver(() => setAvailableWidth(area.clientWidth));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [chapterFontFamily, setChapterFontFamily] = useState<string | null>(null);
  // Measure the base (100%) advance so font size scales glyphs without changing page width.
  const charWidth = measureCharWidth(
    fontStack(effectivePreferences.fontFamily) ?? (chapterFontFamily || DEFAULT_SERIF_STACK),
    rootFontSizePx() * EPUB_BASE_FONT_REM,
  );
  const layout = computeReadingLayout({
    availableWidth,
    charWidth,
    margins: effectivePreferences.margins,
    pageWidth: effectivePreferences.pageWidth,
    spread: readingMode === 'spread',
  });
  // Read when the book opens, so the first render already has the right pages.
  const columnsRef = useRef(layout.columns);
  useEffect(() => {
    columnsRef.current = layout.columns;
  });
  const navigator = useNavigator('epub', ['contents', 'notes', 'bookmarks']);
  // Opening the book, or activating its tab, hands the keyboard to the page so
  // Page Down and the arrows work at once. Text entry and the tablist keep focus (#50).
  const focusPage = useFocusPageOnActivate(hostRef, isActive);

  const updatePreferences = (patch: Partial<ReadingPreferences>) => {
    setLocalPreferences((prev) => ({ ...(preferences ?? prev), ...patch }));
    onPreferencesChange?.(patch);
  };
  const [staleBookmarkIds, setStaleBookmarkIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pageInfo, setPageInfo] = useState<{ page: number; totalPages: number } | null>(null);
  const [chapterPosition, setChapterPosition] = useState<{
    chapter: number;
    totalChapters: number;
    /** The engine's own estimate, used when it reports no in-chapter position. */
    percent: number;
    fraction: number;
    /** Where the page starts and ends in its chapter, `0..1`. */
    chapterStart?: number;
    chapterEnd?: number;
  } | null>(null);
  /** Each chapter's share of the text, for the book it was measured in. */
  const [measured, setMeasured] = useState<{ book: EpubHandle; weights: TextWeights } | null>(null);
  const textWeightsRef = useRef<TextWeights | null>(null);
  const textWeights = measured !== null && measured.book === handle ? measured.weights : null;
  /**
   * The book position shown in the footer and scrubber: by characters once the
   * book is measured, by spine file until then.
   */
  const bookProgress = useMemo(() => {
    if (!chapterPosition) return null;
    const { chapter, totalChapters, chapterStart, chapterEnd } = chapterPosition;
    const weighted =
      textWeights !== null &&
      textWeights.sections.length === totalChapters &&
      chapterStart !== undefined;
    if (!weighted) return chapterPosition;
    return {
      ...chapterPosition,
      percent: Math.round(
        bookFraction(textWeights, totalChapters, chapter - 1, chapterEnd ?? chapterStart) * 100,
      ),
      fraction: bookFraction(textWeights, totalChapters, chapter - 1, chapterStart),
    };
  }, [chapterPosition, textWeights]);
  const history = useJumpHistory<string>();
  const pushHistory = history.push;
  const searchTrip = useSearchTrip(pushHistory);
  const backChip = useBackChip(history.canGoBack);
  const offerBackChip = backChip.offer;
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
  const lastReportedProgress = useRef<number | undefined>(undefined);
  /**
   * The percentage saved last session, sent with the cursor until this book is
   * measured. Leaving progress out clears the saved one, and a reader who turns a
   * page and closes the book before measuring finishes should not lose it.
   */
  const savedProgress = useRef<number | undefined>(undefined);
  const flushCursorRef = useRef<() => void>(() => undefined);
  const pendingLocation = useRef<EpubLocation | null>(null);
  const cursorTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let opened: EpubHandle | null = null;
    savedProgress.current = document.lastProgress ?? undefined;
    lastReportedProgress.current = savedProgress.current;

    const flushCursor = () => {
      const location = pendingLocation.current;
      pendingLocation.current = null;
      if (!location) return;
      const progress = measuredProgress(location, textWeightsRef.current) ?? savedProgress.current;
      if (location.cfi === lastReported.current && progress === lastReportedProgress.current) {
        return;
      }
      lastReported.current = location.cfi;
      lastReportedProgress.current = progress;
      latest.current.onCursorChange(
        { format: 'epub', cfiRange: location.cfi, chapterHref: location.href },
        progress,
      );
    };
    flushCursorRef.current = flushCursor;

    void (async () => {
      try {
        const source = await content.loadDocumentSource(document);
        if (cancelled) return;
        const engine = await openEpubDocument(
          source,
          host,
          effectivePreferences.epubReadingMode,
          enginePreferences,
          columnsRef.current,
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
          const body = host.querySelector('iframe')?.contentDocument?.body;
          setChapterFontFamily(
            body
              ? (body.ownerDocument.defaultView?.getComputedStyle(body).fontFamily ?? null)
              : null,
          );
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
            setChapterPosition({
              chapter: location.chapterIndex + 1,
              totalChapters: location.totalChapters,
              percent,
              fraction: location.fraction ?? location.chapterIndex / location.totalChapters,
              ...(location.chapterStart === undefined
                ? {}
                : { chapterStart: location.chapterStart }),
              ...(location.chapterEnd === undefined ? {} : { chapterEnd: location.chapterEnd }),
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
      flushCursorRef.current = () => undefined;
      opened?.destroy();
    };
    // Only the file matters: `document` changes each time the cursor is reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, documentId]);

  // ---- Measuring the book's text, behind the first page ----------------------

  // Starts once the first page is showing and measures one chapter per idle
  // moment, so it never holds up opening or a page turn. Closing the book aborts
  // it before the next chapter loads. A fixed-layout book is a page per file, so
  // equal shares are already right for it.
  useEffect(() => {
    const count = handle?.chapterCount ?? 0;
    const measure = handle?.measureChapter;
    if (!handle || !measure || handle.isFixedLayout || count <= 1) return;
    const fileHash = document.fileHash;
    const accept = (weights: TextWeights) => {
      textWeightsRef.current = weights;
      setMeasured({ book: handle, weights });
      // The saved position gains the percentage the Recent list shows.
      const here = currentLocationRef.current;
      if (restored.current && here) {
        pendingLocation.current = here;
        flushCursorRef.current();
      }
    };
    // Measured on an earlier open: no pass, and no jump from the by-file
    // percentage to the by-text one.
    const cached = readCachedWeights(fileHash, count);
    if (cached) {
      accept(cached);
      return () => {
        textWeightsRef.current = null;
      };
    }
    const controller = new AbortController();
    measureBook(count, (index) => measure.call(handle, index), controller.signal)
      .then((weights) => {
        if (controller.signal.aborted) return;
        writeCachedWeights(fileHash, weights);
        accept(weights);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      textWeightsRef.current = null;
    };
  }, [handle, document.fileHash]);

  // ---- Highlights ----------------------------------------------------------

  const painted = useRef(new Map<string, PaintedMark>());
  const searchPulseCleanupRef = useRef<(() => void) | null>(null);
  /**
   * `describeHere` is built below, where the chapter title is known, but a search
   * jump needs it to name where the trip started; it is read through a ref.
   */
  const describeHereRef = useRef<() => string>(() => 'previous location');

  /** A search starts at the first match at or after the reading position. */
  const findSearchStart = useCallback(
    (matches: readonly EpubSearchMatch[]): number => {
      const here = currentLocationRef.current;
      // Nothing has been read yet: start at the first match.
      if (!handle || !here) return 0;
      return matches.findIndex((match) => handle.compareCfi(match.cfiRange, here.cfi) >= 0);
    },
    [handle],
  );

  /** Whether the visible page already holds the match, so no move is needed. */
  const isSearchMatchOnScreen = useCallback(
    (match: EpubSearchMatch): boolean => {
      const here = currentLocationRef.current;
      if (!handle || !here || !here.endCfi) return false;
      return (
        handle.compareCfi(match.cfiRange, here.cfi) >= 0 &&
        handle.compareCfi(match.cfiRange, here.endCfi) <= 0
      );
    },
    [handle],
  );

  const navigateToSearchMatch = useCallback(
    (match: EpubSearchMatch, _index: number, trip: number) => {
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

      // The highlight sync effect owns every mark, including the active search
      // one; painting here as well would race a search-tint cleanup for the same
      // CFI and let epub.js remove both marks at once.

      const startPulse = () => {
        const waitedSince = performance.now();
        const pulse = () => {
          if (cancelled) return;
          const hasMarks = handle.setPulse(SEARCH_HIGHLIGHT_ID, true);
          if (!hasMarks && performance.now() - waitedSince < MARK_WAIT_MS) {
            pollForMarks = window.setTimeout(pulse, MARK_POLL_MS);
            return;
          }
          endPulse = window.setTimeout(() => {
            handle.setPulse(SEARCH_HIGHLIGHT_ID, false);
          }, PULSE_MS);
        };
        pulse();
      };

      // The match is already in view: show it without moving the page.
      if (isSearchMatchOnScreen(match)) {
        startPulse();
        return;
      }

      const previous = currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? null;
      const origin = describeHereRef.current();
      void handle
        .display(match.cfiRange)
        .then(() => {
          if (cancelled) return;
          // One history entry per search, not one per match.
          if (previous && previous !== match.cfiRange && searchTrip(trip, previous)) {
            offerBackChip(`Back to ${origin}`);
          }
          startPulse();
        })
        .catch(() => undefined);
    },
    [handle, isSearchMatchOnScreen, offerBackChip, searchTrip],
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
      options: SearchOptions,
      signal: AbortSignal,
      onProgress: (matchesSoFar: readonly EpubSearchMatch[]) => void,
    ): Promise<readonly EpubSearchMatch[]> => {
      if (!handle?.searchChapter) return [];
      const count = handle.chapterCount ?? 0;
      const matches: EpubSearchMatch[] = [];
      for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
        if (signal.aborted) return [];
        const chapterMatches = await handle.searchChapter(chapterIndex, query, options);
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
    findSearchStart,
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

  const prevHighlightCount = useRef(highlights.length);
  useEffect(() => {
    const grew = highlights.length > prevHighlightCount.current;
    prevHighlightCount.current = highlights.length;
    if (grew && activeSelection) clearSelectionAfterAnnotate();
  }, [highlights.length, activeSelection, clearSelectionAfterAnnotate]);

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
    return [...highlights, ...localHighlights(annotationsController.annotations)];
  }, [annotations, annotationsController.annotations, highlights]);

  const getSelectionRect = useCallback(() => handle?.selectionRect() ?? null, [handle]);
  const popover = useSelectionPopover({
    isActive,
    selection: activeSelection,
    annotations: annotationsController,
    surfaceRef: areaRef,
    getSelectionRect,
  });
  const { openForAnnotation, reportPointer } = popover;
  useEffect(() => {
    if (!handle) return;
    handle.onMarkClick((annotationId, rect) => {
      if (!latest.current.isActive) return;
      openForAnnotation(annotationId, rect);
    });
    handle.onPointer(reportPointer);
  }, [handle, openForAnnotation, reportPointer]);

  useEffect(() => {
    if (!handle) return;
    const wanted = new Map<string, PaintedMark>();
    // epub.js keys marks by `(cfiRange, style)`, not by our annotation id, and
    // overwrites an existing mark at the same range without detaching it. Keep
    // one owner per mark so a search tint can never orphan a user highlight.
    const ownerByMark = new Map<string, string>();
    const markKey = (mark: { cfiRange: string; style: AnnotationStyle }) =>
      `${mark.style}\u0000${mark.cfiRange}`;
    const setWanted = (annotationId: string, mark: PaintedMark) => {
      const key = markKey(mark);
      const previousOwner = ownerByMark.get(key);
      if (previousOwner !== undefined && previousOwner !== annotationId) {
        wanted.delete(previousOwner);
      }
      wanted.set(annotationId, mark);
      ownerByMark.set(key, annotationId);
    };

    for (const {
      annotationId,
      anchor,
      color,
      style = 'highlight',
      hasNote = false,
    } of effectiveHighlights) {
      const epubAnchor = asEpubAnchor(anchor);
      if (epubAnchor) {
        setWanted(annotationId, { cfiRange: epubAnchor.cfiRange, color, style, hasNote });
      }
    }
    // A jump can target an annotation from another notebook, with no highlight here.
    const jumpAnchor = asEpubAnchor(jumpRequest?.anchor);
    if (jumpRequest && jumpAnchor && !wanted.has(jumpRequest.annotationId)) {
      setWanted(jumpRequest.annotationId, {
        cfiRange: jumpAnchor.cfiRange,
        color: FALLBACK_HIGHLIGHT,
        style: 'highlight',
        hasNote: false,
      });
    }
    for (const [index, match] of search.results.entries()) {
      if (index === search.activeIndex) continue;
      if (currentHref && !sameChapter(match.chapterHref, currentHref)) continue;
      setWanted(searchMatchId(index), {
        cfiRange: match.cfiRange,
        color: SEARCH_MATCH_COLOR,
        style: 'highlight',
        hasNote: false,
      });
    }
    if (activeSearchMatch) {
      setWanted(SEARCH_HIGHLIGHT_ID, {
        cfiRange: activeSearchMatch.cfiRange,
        color: SEARCH_HIGHLIGHT_COLOR,
        style: 'highlight',
        hasNote: false,
      });
    }

    for (const [annotationId, existing] of painted.current) {
      const next = wanted.get(annotationId);
      if (
        !next ||
        next.cfiRange !== existing.cfiRange ||
        next.color !== existing.color ||
        next.style !== existing.style ||
        next.hasNote !== existing.hasNote
      ) {
        handle.removeHighlight(existing.cfiRange, existing.style);
        painted.current.delete(annotationId);
      }
    }
    for (const [annotationId, mark] of wanted) {
      if (!painted.current.has(annotationId)) {
        handle.highlight(annotationId, mark.cfiRange, mark.color, mark.style, {
          hasNote: mark.hasNote,
        });
        painted.current.set(annotationId, mark);
      }
    }
  }, [
    handle,
    effectiveHighlights,
    jumpRequest,
    search.results,
    search.activeIndex,
    activeSearchMatch,
    currentHref,
  ]);

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
    handle.setPreferences(enginePreferences);
  }, [handle, enginePreferences]);

  useEffect(() => {
    handle?.setColumns(layout.columns);
  }, [handle, layout.columns]);

  useLayoutEffect(() => {
    if (!handle || !isActive) return;
    // Keys typed inside a chapter's iframe never reach the window, so the frame
    // forwards them: Esc takes the app's dismissal order, and every shortcut
    // reaches the registry.
    const onFrameKeyDown = (event: KeyboardEvent) => {
      // 1–5 pick a color while the selection popover is open, even from in here.
      if (dispatchColorShortcut(event)) {
        event.preventDefault();
        return;
      }
      if (dispatchEscape(event)) return;
      dispatchCommandKeydown(event);
    };
    handle.onKeyDown(onFrameKeyDown);
    return () => {
      handle.onKeyDown(() => undefined);
    };
  }, [handle, isActive]);

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
  }, [handle, readingMode]);

  const outlineItems = useMemo(() => toOutlineNodes(handle?.toc ?? []), [handle]);

  const tocIndex = useMemo(() => indexOutline(outlineItems), [outlineItems]);
  const chapterTitles = useMemo(() => chapterTitlesBySpine(handle), [handle]);
  const annotationPlacement = (annotation: Annotation): AnnotationPlacement => {
    const anchor = asEpubAnchor(annotation.anchor);
    if (!anchor) return { group: 'Unknown chapter', order: Number.MAX_SAFE_INTEGER };
    const item = findOutlineItem(handle?.toc ?? [], anchor.chapterHref);
    const spineIndex = handle?.spineIndexOf(anchor.chapterHref) ?? -1;
    // Readers know chapters by title; the file name is an implementation detail.
    const title =
      item?.label ??
      (spineIndex >= 0 ? (chapterTitles[spineIndex] ?? `Chapter ${spineIndex + 1}`) : null) ??
      'Unknown chapter';
    return {
      group: title,
      label: title,
      // Book order by spine position, then the TOC for chapters outside the spine;
      // CFI order within a chapter comes from `compareAnnotationCfis`.
      order:
        spineIndex >= 0
          ? spineIndex
          : item
            ? (handle?.chapterCount ?? 0) + (tocIndex.get(item.id)?.order ?? 0)
            : Number.MAX_SAFE_INTEGER,
    };
  };
  const compareAnnotationCfis = (a: Annotation, b: Annotation): number => {
    const one = asEpubAnchor(a.anchor);
    const two = asEpubAnchor(b.anchor);
    if (!handle || !one || !two) return 0;
    try {
      return handle.compareCfi(one.cfiRange, two.cfiRange);
    } catch {
      // A malformed CFI from an old import keeps its creation order.
      return 0;
    }
  };

  const ticks = useMemo(() => chapterTicks(handle, textWeights), [handle, textWeights]);
  const chapterCount = handle?.chapterCount ?? 0;
  const currentChapterIndex = bookProgress ? bookProgress.chapter - 1 : 0;
  const chapterTitle =
    (currentHref ? findOutlineLabel(handle?.toc ?? [], currentHref) : null) ??
    chapterTitles[currentChapterIndex] ??
    (bookProgress ? `Chapter ${bookProgress.chapter}` : null);
  const transition = effectivePreferences.pageTransition;
  const paged = readingMode !== 'scroll';
  const toolbarMargin = paged && chromeHidden;

  /** Where the reader is, for "Back to …". */
  const describeHere = useCallback(() => {
    const place = chapterTitle ?? 'previous location';
    return paged && pageInfo ? `${place}, page ${pageInfo.page}` : place;
  }, [chapterTitle, paged, pageInfo]);

  useEffect(() => {
    describeHereRef.current = describeHere;
  }, [describeHere]);

  /** A big jump: remembered in history, with a chip that leads back. */
  const jumpWithBackChip = useCallback(
    (go: () => Promise<void>, target?: string) => {
      const loc = currentLocationRef.current;
      const previous = loc?.cfi ?? loc?.href ?? null;
      const alreadyAtTarget =
        target !== undefined &&
        (target === previous ||
          (!target.includes('#') &&
            loc?.href !== undefined &&
            sameChapter(target, loc.href) &&
            (loc.page ?? 1) === 1));
      const origin = describeHere();
      void go()
        .then(() => {
          if (previous && !alreadyAtTarget) {
            pushHistory(previous);
            offerBackChip(`Back to ${origin}`);
          }
        })
        .catch(() => undefined);
    },
    [describeHere, offerBackChip, pushHistory],
  );

  const handleTocSelect = (target: string) => {
    if (!handle) return;
    jumpWithBackChip(() => handle.display(target), target);
  };

  // An internal link comes from the chapter's frame. The engine only forwards the
  // href, so the jump joins the reader's history and offers the way back here.
  useEffect(() => {
    if (!handle) return;
    handle.onInternalLink((href) => {
      if (!isActive) return;
      jumpWithBackChip(() => handle.display(href), href);
    });
    return () => {
      handle.onInternalLink(() => undefined);
    };
  }, [handle, isActive, jumpWithBackChip]);

  const turnPage = (direction: TurnDirection) => {
    if (!handle) return;
    backChip.dismiss();
    void (direction > 0 ? handle.next() : handle.previous())
      .then(() => {
        if (paged) animatePageTurn(hostRef.current, direction, transition, turnShadowRef.current);
      })
      .catch(() => undefined);
  };

  const goToChapter = (index: number) => {
    const href = handle?.spineHref(index);
    if (!handle || href === undefined) return;
    backChip.dismiss();
    void handle.display(href).catch(() => undefined);
  };

  const goToChapterEdge = (edge: 'start' | 'end') => {
    if (!handle || !bookProgress) return;
    backChip.dismiss();
    void handle
      .displayChapterFraction(currentChapterIndex, edge === 'start' ? 0 : 1)
      .catch(() => undefined);
  };

  const scrubber: ScrubberModel | null =
    handle && chapterCount > 0 && bookProgress
      ? {
          value: Math.min(Math.max(bookProgress.fraction, 0), 1),
          valueText: `Chapter ${bookProgress.chapter} of ${chapterCount}, ${bookProgress.percent}%`,
          ticks,
          searchMarks: scrubberSearchMarks(
            search.results.map((match) =>
              bookFraction(
                textWeights,
                chapterCount,
                match.chapterIndex,
                match.chapterFraction ?? 0.5,
              ),
            ),
          ),
          describe: (fraction) => {
            const { index } = locateBookFraction(textWeights, chapterCount, fraction);
            const title = chapterTitles[index] ?? `Chapter ${index + 1}`;
            return `${title} · ${Math.round(fraction * 100)}%`;
          },
          onCommit: (fraction) => {
            const { index, within } = locateBookFraction(textWeights, chapterCount, fraction);
            jumpWithBackChip(() => handle.displayChapterFraction(index, within));
          },
          onStepPage: turnPage,
          onStepChapter: (direction) => goToChapter(currentChapterIndex + direction),
        }
      : null;

  // ---- Go To: a percentage of the book, by text once it has been measured ----

  const goTo = useGoToField();
  const goToInput = (text: string): boolean => {
    const target = parseGoToInput(text, 'percent');
    if (!handle || chapterCount === 0 || target?.kind !== 'percent') return false;
    const { index, within } = locateBookFraction(textWeights, chapterCount, target.percent / 100);
    jumpWithBackChip(() => handle.displayChapterFraction(index, within));
    return true;
  };

  const readouts: FooterReadouts = {};
  if (paged && pageInfo) {
    readouts.remaining = pagesLeftText(pageInfo.totalPages - pageInfo.page);
    readouts.position = `Page ${pageInfo.page} of ${pageInfo.totalPages} in chapter`;
  }
  const chapterText = textWeights?.sections[currentChapterIndex];
  if (chapterText && chapterText.characters > 0 && chapterPosition) {
    readouts.minutes = minutesLeftText(
      minutesLeftInSection(
        chapterText,
        chapterPosition.chapterEnd ?? chapterPosition.chapterStart ?? 0,
      ),
    );
  }
  if (bookProgress) readouts.percent = `${bookProgress.percent}% of book`;

  // ---- Page-turn gestures: edge clicks and swipes, also from inside the frame ----

  const gestures = usePageTurnGestures({
    enabled: handle !== null && isActive && paged,
    areaRef,
    pageRef: hostRef,
    onTurn: turnPage,
  });
  const { handleSample, handleWheel, zone } = gestures;
  useEffect(() => {
    if (!handle) return;
    handle.onGesture(handleSample);
    handle.onWheel(handleWheel);
  }, [handle, handleSample, handleWheel]);
  useEffect(() => {
    handle?.setCursor(zoneCursor(zone));
  }, [handle, zone]);

  const currentHistoryLocation = (): string =>
    currentLocationRef.current?.cfi ?? currentLocationRef.current?.href ?? currentCfi ?? '';

  const handleReturnBack = () => {
    if (!handle) return;
    backChip.dismiss();
    const target = history.goBack(currentHistoryLocation());
    if (target) void handle.display(target).catch(() => undefined);
  };

  const handleForward = () => {
    if (!handle) return;
    backChip.dismiss();
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
    focusPage,
    search,
    navigator,
    bookmarks: bookmarksController,
    annotations: annotationsController,
    selectionText: activeSelection?.text ?? null,
    markup,
    popover,
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
      'go.previousPage': { run: () => turnPage(-1), enabled: ready },
      'go.nextPage': { run: () => turnPage(1), enabled: ready },
      'go.previousChapter': {
        run: () => goToChapter(currentChapterIndex - 1),
        enabled: ready && currentChapterIndex > 0,
      },
      'go.nextChapter': {
        run: () => goToChapter(currentChapterIndex + 1),
        enabled: ready && currentChapterIndex < chapterCount - 1,
      },
      'go.chapterStart': { run: () => goToChapterEdge('start'), enabled: ready },
      'go.chapterEnd': { run: () => goToChapterEdge('end'), enabled: ready },
      'go.page': { run: goTo.focus, enabled: ready, title: 'Go to Percentage…' },
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
  return (
    <div
      className="flex h-full flex-col"
      data-testid="epub-viewer"
      data-reading-mode={readingMode}
      data-reading-theme={effectivePreferences.theme}
      data-resolved-theme={theme}
      data-reading-margins={effectivePreferences.margins}
      data-columns={layout.columns}
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
              onClick={() => navigator.toggle()}
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
        center={<ToolbarTitle title={document.title} subtitle={chapterTitle} />}
        trailing={
          <>
            <AppearanceMenu
              open={preferencesPanel.open}
              onToggle={preferencesPanel.toggle}
              onClose={preferencesPanel.close}
              preferences={effectivePreferences}
              onChange={updatePreferences}
              format="epub"
              disabled={!handle}
            />
            <MarkupToggleButton
              visible={markup.visible}
              highlightMode={annotationsController.highlightMode}
              onToggle={markup.toggle}
            />
            <ToolbarSeparator />
            <GoToField
              inputRef={goTo.inputRef}
              label="Go to percentage of book"
              tooltipLabel="Go to a percentage of the book, such as 50%"
              placeholder="Go to %"
              disabled={!handle}
              onGo={goToInput}
              onReturnFocus={() => focusPage(true)}
            />
            <BookmarkToggleButton
              bookmarked={bookmarksController.isCurrentBookmarked}
              disabled={!handle}
              onToggle={bookmarksController.toggleCurrentBookmark}
            />
            <ToolbarSearchField
              search={search}
              disabled={!handle}
              onReturnFocus={() => hostRef.current?.focus({ preventScroll: true })}
              onShowResults={() => navigator.show('search')}
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
            onReturnFocus={focusPage}
            contents={{
              items: outlineItems,
              currentId: currentTocId(handle?.toc ?? [], currentHref),
              emptyMessage: 'No table of contents in this book.',
              onSelect: handleTocSelect,
            }}
            annotationPlacement={annotationPlacement}
            compareAnnotations={compareAnnotationCfis}
          />
        )}
        {/* Notices float over the page column only, never over the sidebar. */}
        <div ref={readerAreaRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {markup.visible && <MarkupBar controller={annotationsController} onClose={markup.hide} />}
          <SelectionPopover
            popover={popover}
            annotations={annotationsController}
            selection={activeSelection}
            boundsRef={readerAreaRef}
            onExcerpt={onExcerptSelection}
            canExcerpt={canExcerpt}
            onReturnFocus={() => hostRef.current?.focus({ preventScroll: true })}
          />
          <ReaderPopoverLayer hidden={chromeHidden}>
            {missedJump && (
              <ReaderNotice tone="warning" onDismiss={() => setMissedJump(false)}>
                That excerpt could not be found in this book. The file may have changed.
              </ReaderNotice>
            )}
          </ReaderPopoverLayer>
          {/*
            The page's color fills the margins too, so the page never sits in a
            frame of bright chrome, and nothing flashes while a chapter loads.
          */}
          <div
            ref={areaRef}
            data-testid="epub-page-area"
            data-turn-zone={zone ?? undefined}
            data-toolbar-margin={toolbarMargin || undefined}
            className="group/page relative flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden pt-1.5"
            style={{
              ...pageSurfaceStyle(theme),
              cursor: zoneCursor(zone) || undefined,
              // The toolbar floats over the page in focus mode. A page does not
              // scroll out from under it, so its band is the page's top margin and
              // showing the toolbar never covers the first line (#45).
              ...(toolbarMargin ? { paddingTop: TOOLBAR_HEIGHT_PX } : undefined),
            }}
          >
            <PageTurnShadow
              shadowRef={turnShadowRef}
              color={PAGE_PALETTES[theme].spine}
              className={availableWidth > 0 ? 'inset-y-0 left-1/2 -translate-x-1/2' : 'inset-0'}
              style={availableWidth > 0 ? { width: layout.pageWidth } : undefined}
            />
            <div
              ref={hostRef}
              tabIndex={-1}
              data-testid="epub-host"
              className={cn('relative h-full overflow-hidden', availableWidth === 0 && 'w-full')}
              style={{
                ...pageSurfaceStyle(theme),
                ...(availableWidth > 0 ? { width: layout.pageWidth } : undefined),
              }}
            />
            {readingMode === 'spread' && layout.columns === 2 && (
              <div
                aria-hidden="true"
                data-testid="epub-spine"
                className="pointer-events-none absolute inset-y-3 left-1/2 w-12 -translate-x-1/2"
                style={{
                  background: `linear-gradient(to right, transparent, ${PAGE_PALETTES[theme].spine} 50%, transparent)`,
                }}
              />
            )}
            {paged && (
              <PageTurnChevrons
                disabled={!handle}
                onPrevious={() => turnPage(-1)}
                onNext={() => turnPage(1)}
              />
            )}
          </div>
          <ReaderFooter
            readouts={readouts}
            scrubber={scrubber}
            backLabel={backChip.label}
            onBack={handleReturnBack}
            disabled={!handle}
            style={pageFooterStyle(theme)}
          />
        </div>
      </div>
    </div>
  );
}
