import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import { PanelLeft } from 'lucide-react';

import {
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
import { AppearanceMenu, useAppearancePanel } from '@/features/reader/appearance/AppearancePopover';
import {
  measureCharWidth,
  rootFontSizePx,
  singleColumnPage,
} from '@/features/reader/appearance/measure';
import {
  DEFAULT_SERIF_STACK,
  fontStack,
  pageFooterStyle,
  pageSurfaceStyle,
} from '@/features/reader/appearance/themes';
import { useResolvedReadingTheme } from '@/features/reader/appearance/useResolvedTheme';
import {
  animatePageTurn,
  type TurnDirection,
  usePageTurnGestures,
  zoneCursor,
} from '@/features/reader/paging/pageTurn';
import { PageTurnChevrons } from '@/features/reader/paging/PageTurnChevrons';
import { ReaderFooter, type ScrubberModel } from '@/features/reader/progress/ReaderFooter';
import { useBackChip } from '@/features/reader/progress/useBackChip';
import { useJumpHistory } from '@/features/reader/useJumpHistory';
import { useMarkupToolbar, useReaderCommands } from '@/features/reader/useReaderCommands';
import { cn, describeError } from '@/lib/utils';
import {
  type Annotation,
  type Bookmark,
  DEFAULT_READING_PREFERENCES,
  type DocumentContentReader,
  type DocumentViewerProps,
  type ReaderHighlight,
  type ReaderSelection,
  type ReadingPreferences,
  type TxtAnchor,
} from '@/types/domain';

import { UNIT_ATTRIBUTE, unitAtBoundary } from './selectionMapping';
import { type TxtSearchMatch, TxtTextModel } from './textModel';

export const ROW_ESTIMATE_PX = 26;
/** Plain text has no chapters: Page Up and Page Down on the scrubber move a tenth. */
const SCRUB_STEP = 0.1;
const OVERSCAN_ROWS = 12;
const CURSOR_DEBOUNCE_MS = 400;
/** A long file should fill in steadily, not re-render for every 64 KiB chunk. */
const PUBLISH_INTERVAL_MS = 100;

interface LoadState {
  model: TxtTextModel;
  rowCount: number;
  complete: boolean;
  hadReplacements: boolean;
  error: string | null;
}

function useTextStream(content: DocumentContentReader, documentId: string, encoding: string) {
  const [state, setState] = useState<LoadState>(() => ({
    model: new TxtTextModel(),
    rowCount: 1,
    complete: false,
    hadReplacements: false,
    error: null,
  }));

  useEffect(() => {
    const model = new TxtTextModel();
    const controller = new AbortController();
    let cancelled = false;
    let lastPublish = -Infinity;
    const publish = (error: string | null) =>
      setState({
        model,
        rowCount: model.rowCount,
        complete: model.complete,
        hadReplacements: model.hadReplacements,
        error,
      });

    content
      .readTextStream(
        documentId,
        encoding,
        (chunk) => {
          if (cancelled || controller.signal.aborted) return;
          model.append(chunk);
          const now = performance.now();
          if (chunk.isLast || now - lastPublish >= PUBLISH_INTERVAL_MS) {
            lastPublish = now;
            publish(null);
          }
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        if (!cancelled && !controller.signal.aborted) publish(describeError(error));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [content, documentId, encoding]);

  return state;
}

interface PaintedRange {
  annotationId: string;
  color: string;
  startUnit: number;
  endUnit: number;
}

interface Segment {
  unit: number;
  text: string;
  range: PaintedRange | null;
}

/** Cuts a row at highlight edges. The last highlight painted over a character wins. */
function segmentRow(rowStart: number, text: string, ranges: readonly PaintedRange[]): Segment[] {
  const rowEnd = rowStart + text.length;
  const overlapping = ranges.filter((r) => r.startUnit < rowEnd && r.endUnit > rowStart);
  if (overlapping.length === 0) return [{ unit: rowStart, text, range: null }];

  const edges = new Set([rowStart, rowEnd]);
  for (const range of overlapping) {
    if (range.startUnit > rowStart) edges.add(range.startUnit);
    if (range.endUnit < rowEnd) edges.add(range.endUnit);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const start = sorted[index] as number;
    const end = sorted[index + 1] as number;
    segments.push({
      unit: start,
      text: text.slice(start - rowStart, end - rowStart),
      range: overlapping.findLast((r) => r.startUnit <= start && r.endUnit >= end) ?? null,
    });
  }
  return segments;
}

const TxtRow = memo(function TxtRow({
  segments,
  pulsingAnnotationId,
}: {
  segments: Segment[];
  pulsingAnnotationId: string | null;
}) {
  return (
    <>
      {segments.map(({ unit, text, range }) => {
        const unitAttribute = { [UNIT_ATTRIBUTE]: unit };
        if (!range) {
          return (
            <span key={unit} {...unitAttribute}>
              {text}
            </span>
          );
        }
        const style: CSSProperties & Record<'--anchor-pulse-color', string> = {
          backgroundColor: range.color,
          color: '#000',
          '--anchor-pulse-color': range.color,
        };
        return (
          <span
            key={unit}
            {...unitAttribute}
            data-annotation-id={range.annotationId}
            style={style}
            className={cn(pulsingAnnotationId === range.annotationId && 'anchor-pulse')}
          >
            {text}
          </span>
        );
      })}
    </>
  );
});

const asTxtAnchor = (anchor: { format: string } | null | undefined): TxtAnchor | null =>
  anchor?.format === 'txt' ? (anchor as TxtAnchor) : null;

function paint(model: TxtTextModel, highlights: readonly ReaderHighlight[]): PaintedRange[] {
  const ranges: PaintedRange[] = [];
  for (const { annotationId, anchor, color } of highlights) {
    const txtAnchor = asTxtAnchor(anchor);
    const range = txtAnchor && model.rangeFor(txtAnchor);
    if (range) ranges.push({ annotationId, color, ...range });
  }
  return ranges;
}

/**
 * Virtualized TXT reader. Rows come from {@link TxtTextModel}, which also owns
 * every conversion between DOM positions and source bytes.
 */
export function TxtViewer({
  document,
  isActive,
  content,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
  onCursorChange,
  chromeHidden = false,
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
}: DocumentViewerProps<'txt'>) {
  const load = useTextStream(content, document.id, document.encoding);
  const { model, rowCount, complete } = load;
  const documentId = document.id;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [localPreferences, setLocalPreferences] = useState<ReadingPreferences>(
    () => preferences ?? DEFAULT_READING_PREFERENCES,
  );
  const effectivePreferences = preferences ?? localPreferences;
  const preferencesPanel = useAppearancePanel();
  const theme = useResolvedReadingTheme(effectivePreferences.theme);
  const fontFamily = fontStack(effectivePreferences.fontFamily) ?? DEFAULT_SERIF_STACK;
  const page = singleColumnPage(
    measureCharWidth(fontFamily, (rootFontSizePx() * effectivePreferences.fontSize) / 100),
    effectivePreferences.margins,
  );

  const updatePreferences = (patch: Partial<ReadingPreferences>) => {
    setLocalPreferences((prev) => ({ ...(preferences ?? prev), ...patch }));
    onPreferencesChange?.(patch);
  };

  // Rows holding the selection's ends stay rendered: if the browser's selection
  // endpoints left the DOM, scrolling away would silently destroy the selection.
  const [pinnedRows, setPinnedRows] = useState<readonly number[]>([]);
  const [activeSelection, setActiveSelection] = useState<ReaderSelection | null>(null);
  const [missedJump, setMissedJump] = useState(false);
  const history = useJumpHistory<number>();
  const pushHistory = history.push;
  const backChip = useBackChip(history.canGoBack);
  const markup = useMarkupToolbar();
  const [currentRow, setCurrentRow] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const [annotationPulsingId, setAnnotationPulsingId] = useState<string | null>(null);
  const annotationPulseTimerRef = useRef<number | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- used only in this component, never memoized across renders.
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN_ROWS,
    rangeExtractor: (range) => {
      const rows = new Set(defaultRangeExtractor(range));
      for (const row of pinnedRows) if (row < range.count) rows.add(row);
      return [...rows].sort((a, b) => a - b);
    },
  });

  // ---- Selection -----------------------------------------------------------

  const hasSelection = useRef(false);
  // A layout effect, so the listener swaps to a new model in the same commit that
  // renders its rows. With a passive effect, a selection in between reads an empty model.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const view = root.ownerDocument;
    const selection = view.getSelection();

    if (!isActive) {
      // The store drops the selection on a tab switch; keep the DOM in step.
      if (selection?.anchorNode && root.contains(selection.anchorNode)) selection.removeAllRanges();
      hasSelection.current = false;
      setActiveSelection(null);
      return;
    }

    const clear = () => {
      if (!hasSelection.current) return;
      hasSelection.current = false;
      setPinnedRows([]);
      setActiveSelection(null);
      onSelectionChange(null);
    };
    const onChange = () => {
      const current = view.getSelection();
      const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : null;
      if (
        !range ||
        range.collapsed ||
        !root.contains(range.startContainer) ||
        !root.contains(range.endContainer)
      ) {
        clear();
        return;
      }
      const startUnit = unitAtBoundary(range.startContainer, range.startOffset);
      const endUnit = unitAtBoundary(range.endContainer, range.endOffset);
      const selected =
        startUnit === null || endUnit === null ? null : model.selectionFor(startUnit, endUnit);
      if (!selected || startUnit === null || endUnit === null) {
        clear();
        return;
      }
      hasSelection.current = true;
      setPinnedRows([model.rowAtUnit(startUnit), model.rowAtUnit(endUnit)]);
      const nextSelection: ReaderSelection = {
        documentId,
        anchor: selected.anchor,
        text: selected.text,
        imagePng: null,
      };
      setActiveSelection(nextSelection);
      onSelectionChange(nextSelection);
    };
    view.addEventListener('selectionchange', onChange);
    return () => view.removeEventListener('selectionchange', onChange);
  }, [isActive, model, documentId, onSelectionChange]);

  // ---- Reopen at the last reading position ---------------------------------

  // Taken once: the store feeds every cursor report back through this prop, and
  // treating those as new targets would fight the user's scrolling.
  const [initialCursor] = useState(() => asTxtAnchor(document.lastCursorAnchor));
  const [initialJump] = useState(jumpRequest);
  const restored = useRef(initialCursor === null || initialJump !== null);
  const lastReportedByte = useRef(initialCursor?.startByteOffset ?? null);

  useLayoutEffect(() => {
    if (restored.current || !initialCursor) return;
    const range = model.rangeFor(initialCursor);
    if (range) {
      virtualizer.scrollToIndex(model.rowAtUnit(range.startUnit), { align: 'start' });
      restored.current = true;
    } else if (complete) {
      restored.current = true;
    }
  }, [model, rowCount, complete, initialCursor, virtualizer]);

  // ---- Reporting the reading position --------------------------------------

  // Recorded while scrolling: by the time an unmount flush runs, the ref is detached.
  const lastScrollTop = useRef(0);
  const layoutSnapshot = useRef({
    fontFamily: effectivePreferences.fontFamily,
    fontSize: effectivePreferences.fontSize,
    lineSpacing: effectivePreferences.lineSpacing,
    margins: effectivePreferences.margins,
    justify: effectivePreferences.justify,
  });

  useLayoutEffect(() => {
    const prev = layoutSnapshot.current;
    const changed =
      prev.fontFamily !== effectivePreferences.fontFamily ||
      prev.fontSize !== effectivePreferences.fontSize ||
      prev.lineSpacing !== effectivePreferences.lineSpacing ||
      prev.margins !== effectivePreferences.margins ||
      prev.justify !== effectivePreferences.justify;
    if (!changed) return;
    layoutSnapshot.current = {
      fontFamily: effectivePreferences.fontFamily,
      fontSize: effectivePreferences.fontSize,
      lineSpacing: effectivePreferences.lineSpacing,
      margins: effectivePreferences.margins,
      justify: effectivePreferences.justify,
    };
    const anchorRow = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? 0;
    const frame = window.requestAnimationFrame(() => {
      virtualizer.measure();
      if (anchorRow > 0) {
        virtualizer.scrollToIndex(anchorRow, { align: 'start' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    effectivePreferences.fontFamily,
    effectivePreferences.fontSize,
    effectivePreferences.lineSpacing,
    effectivePreferences.margins,
    effectivePreferences.justify,
    virtualizer,
  ]);
  const reportCursor = useCallback(() => {
    if (!restored.current) return;
    const row = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? 0;
    const anchor = model.cursorAnchorForRow(row);
    if (!anchor || anchor.startByteOffset === lastReportedByte.current) return;
    lastReportedByte.current = anchor.startByteOffset;
    onCursorChange(anchor);
  }, [virtualizer, model, onCursorChange]);

  const pendingCursor = useRef<number | null>(null);
  const reportCursorRef = useRef(reportCursor);
  useEffect(() => {
    reportCursorRef.current = reportCursor;
  }, [reportCursor]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    lastScrollTop.current = event.currentTarget.scrollTop;
    const row = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? 0;
    setCurrentRow(row);
    if (pendingCursor.current !== null) window.clearTimeout(pendingCursor.current);
    pendingCursor.current = window.setTimeout(() => {
      pendingCursor.current = null;
      reportCursor();
    }, CURSOR_DEBOUNCE_MS);
  };

  // Closing a tab must not lose the position from a scroll still being debounced.
  useEffect(
    () => () => {
      if (pendingCursor.current === null) return;
      window.clearTimeout(pendingCursor.current);
      reportCursorRef.current();
    },
    [],
  );

  // ---- Jumping -------------------------------------------------------------

  const jumpAnchor = asTxtAnchor(jumpRequest?.anchor);
  const jumpRange = jumpAnchor && model.rangeFor(jumpAnchor);
  const jumpNonce = jumpRequest?.nonce ?? null;
  const jumpResolved = jumpRange !== null;
  const jumpRow = jumpRange ? model.rowAtUnit(jumpRange.startUnit) : null;
  const lastHandledJumpNonce = useRef<number | null>(null);
  const [searchPulsing, setSearchPulsing] = useState(false);
  const searchPulseTimerRef = useRef<number | null>(null);

  const navigateToSearchMatch = useCallback(
    (match: TxtSearchMatch) => {
      const range = model.rangeFor(match.anchor);
      if (!range) return;
      const previousTop = lastScrollTop.current;
      pushHistory(previousTop);
      const targetRow = model.rowAtUnit(range.startUnit);
      setCurrentRow(targetRow);
      virtualizer.scrollToIndex(targetRow, { align: 'center' });
      if (searchPulseTimerRef.current !== null) window.clearTimeout(searchPulseTimerRef.current);
      setSearchPulsing(true);
      searchPulseTimerRef.current = window.setTimeout(() => {
        searchPulseTimerRef.current = null;
        setSearchPulsing(false);
      }, PULSE_MS);
    },
    [pushHistory, model, virtualizer],
  );

  useEffect(
    () => () => {
      if (searchPulseTimerRef.current !== null) window.clearTimeout(searchPulseTimerRef.current);
      if (annotationPulseTimerRef.current !== null)
        window.clearTimeout(annotationPulseTimerRef.current);
    },
    [],
  );

  // Plain text has no outline or pages: the sidebar holds bookmarks and notes.
  const navigator = useNavigator('txt', ['notes', 'bookmarks']);
  const showSidebar = navigator.open && !chromeHidden;

  const search = useDocumentSearch<TxtSearchMatch>({
    isActive,
    runSearch: (query, caseSensitive) => model.search(query, { caseSensitive }),
    onNavigateToMatch: navigateToSearchMatch,
    searchRevision: `${rowCount}:${complete}`,
  });

  const getCurrentLocation = useCallback(() => {
    const row = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? currentRow;
    const anchor = model.cursorAnchorForRow(row);
    if (!anchor) return null;
    const snippet = model.rowText(row).trim();
    const label = snippet
      ? `Line ${row + 1} · ${snippet.length > 48 ? `${snippet.slice(0, 48)}…` : snippet}`
      : `Line ${row + 1}`;
    return { anchor, label };
  }, [virtualizer, currentRow, model]);

  const isActiveBookmark = useCallback(
    (bookmark: Bookmark) => {
      const txtAnchor = asTxtAnchor(bookmark.anchor);
      if (!txtAnchor) return false;
      const range = model.rangeFor(txtAnchor);
      if (!range) return false;
      const row = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? currentRow;
      return model.rowAtUnit(range.startUnit) === row;
    },
    [model, virtualizer, currentRow],
  );

  const isStaleBookmark = useCallback(
    (bookmark: Bookmark) => {
      if (!complete) return false;
      const txtAnchor = asTxtAnchor(bookmark.anchor);
      return !txtAnchor || model.rangeFor(txtAnchor) === null;
    },
    [complete, model],
  );

  const handleSelectBookmark = useCallback(
    (bookmark: Bookmark) => {
      const txtAnchor = asTxtAnchor(bookmark.anchor);
      const range = txtAnchor ? model.rangeFor(txtAnchor) : null;
      if (!range) {
        if (complete) setMissedJump(true);
        return;
      }
      setMissedJump(false);
      const previousTop = lastScrollTop.current;
      pushHistory(previousTop);
      const targetRow = model.rowAtUnit(range.startUnit);
      setCurrentRow(targetRow);
      virtualizer.scrollToIndex(targetRow, { align: 'start' });
    },
    [pushHistory, model, complete, virtualizer],
  );

  const bookmarksController = useBookmarksController<'txt'>({
    documentId,
    bookmarks,
    onAddBookmark,
    onRemoveBookmark,
    getCurrentLocation,
    isActiveBookmark,
    isStaleBookmark,
    onSelectBookmark: handleSelectBookmark,
  });

  const handleSelectAnnotation = useCallback(
    (annotation: Annotation) => {
      const txtAnchor = asTxtAnchor(annotation.anchor);
      const range = txtAnchor ? model.rangeFor(txtAnchor) : null;
      if (!range) {
        if (complete) setMissedJump(true);
        return;
      }
      setMissedJump(false);
      const previousTop = lastScrollTop.current;
      pushHistory(previousTop);
      const targetRow = model.rowAtUnit(range.startUnit);
      setCurrentRow(targetRow);
      virtualizer.scrollToIndex(targetRow, { align: 'center' });
      if (annotationPulseTimerRef.current !== null)
        window.clearTimeout(annotationPulseTimerRef.current);
      setAnnotationPulsingId(annotation.id);
      annotationPulseTimerRef.current = window.setTimeout(() => {
        annotationPulseTimerRef.current = null;
        setAnnotationPulsingId(null);
      }, PULSE_MS);
    },
    [pushHistory, model, complete, virtualizer],
  );

  const clearSelectionAfterAnnotate = useCallback(() => {
    scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    hasSelection.current = false;
    setPinnedRows([]);
    setActiveSelection(null);
    onSelectionChange(null);
  }, [onSelectionChange]);

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
    isStaleAnnotation: (annotation) => {
      if (!complete) return false;
      const txtAnchor = asTxtAnchor(annotation.anchor);
      return !txtAnchor || model.rangeFor(txtAnchor) === null;
    },
    onSelectAnnotation: handleSelectAnnotation,
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

  const activeSearchMatch = search.activeMatch;
  const activeSearchRange = useMemo(
    () => (activeSearchMatch ? model.rangeFor(activeSearchMatch.anchor) : null),
    // `rowCount` and `complete` stand in for the mutable model's loaded length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, rowCount, complete, activeSearchMatch],
  );

  const pulsingAnnotationId = jumpResolved
    ? (jumpRequest?.annotationId ?? null)
    : annotationPulsingId
      ? annotationPulsingId
      : searchPulsing && activeSearchRange
        ? SEARCH_HIGHLIGHT_ID
        : null;

  useLayoutEffect(() => {
    if (jumpRow === null || jumpNonce === null) return;
    if (lastHandledJumpNonce.current !== jumpNonce) {
      lastHandledJumpNonce.current = jumpNonce;
      const previousTop = lastScrollTop.current;
      pushHistory(previousTop);
    }
    virtualizer.scrollToIndex(jumpRow, { align: 'center' });
  }, [pushHistory, jumpNonce, jumpRow, virtualizer]);

  const handleReturnBack = () => {
    backChip.dismiss();
    const targetTop = history.goBack(scrollRef.current?.scrollTop ?? lastScrollTop.current);
    if (targetTop !== undefined) scrollRef.current?.scrollTo({ top: targetTop });
  };

  const handleForward = () => {
    backChip.dismiss();
    const targetTop = history.goForward(scrollRef.current?.scrollTop ?? lastScrollTop.current);
    if (targetTop !== undefined) scrollRef.current?.scrollTo({ top: targetTop });
  };

  // Entering focus mode puts the panels away; leaving it does not reopen them.
  const [wasChromeHidden, setWasChromeHidden] = useState(chromeHidden);
  if (wasChromeHidden !== chromeHidden) {
    setWasChromeHidden(chromeHidden);
    if (chromeHidden) {
      preferencesPanel.close();
    }
  }

  const pageBy = (direction: 1 | -1) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollBy({ top: direction * scroller.clientHeight * 0.9 });
  };

  const turnPage = (direction: TurnDirection) => {
    backChip.dismiss();
    pageBy(direction);
    animatePageTurn(pageRef.current, direction, effectivePreferences.pageTransition);
  };

  const scrollToEdge = (edge: 'start' | 'end') => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    backChip.dismiss();
    scroller.scrollTo({ top: edge === 'start' ? 0 : scroller.scrollHeight });
  };

  // ---- Progress: by source byte, so it does not depend on row heights ----------

  // `rowCount` and `complete` stand in for the mutable model's loaded length.
  const loadedBytes = useMemo(
    () => model.loadedBytes,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, rowCount, complete],
  );
  const currentByte = model.cursorAnchorForRow(currentRow)?.startByteOffset ?? 0;
  const fraction = loadedBytes > 0 ? Math.min(currentByte / loadedBytes, 1) : 0;
  const percent = Math.round(fraction * 100);
  const rowAtFraction = (at: number) => {
    const byte = Math.floor(Math.min(Math.max(at, 0), 1) * loadedBytes);
    return model.rowAtUnit(model.unitAtSourceOffset(byte, 'down') ?? 0);
  };
  const showRow = (row: number) => {
    setCurrentRow(row);
    virtualizer.scrollToIndex(row, { align: 'start' });
  };
  const scrubber: ScrubberModel | null =
    loadedBytes > 0
      ? {
          value: fraction,
          valueText: `Line ${currentRow + 1} of ${rowCount}, ${percent}%`,
          ticks: [],
          describe: (at) => `Line ${rowAtFraction(at) + 1} · ${Math.round(at * 100)}%`,
          onCommit: (at) => {
            const origin = currentRow + 1;
            pushHistory(lastScrollTop.current);
            showRow(rowAtFraction(at));
            backChip.offer(`Back to line ${origin}`);
          },
          onStepPage: turnPage,
          onStepChapter: (direction) => {
            backChip.dismiss();
            showRow(rowAtFraction(fraction + direction * SCRUB_STEP));
          },
        }
      : null;

  const gestures = usePageTurnGestures({
    enabled: isActive,
    areaRef: scrollRef,
    pageRef,
    onTurn: turnPage,
    canSwipe: () => {
      const scroller = scrollRef.current;
      return !scroller || scroller.scrollWidth <= scroller.clientWidth + 1;
    },
  });

  useReaderCommands({
    isActive,
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
      'go.previousPage': { run: () => turnPage(-1) },
      'go.nextPage': { run: () => turnPage(1) },
      // A text file is one chapter: Home and End go to its start and end.
      'go.chapterStart': { run: () => scrollToEdge('start'), title: 'Start of Document' },
      'go.chapterEnd': { run: () => scrollToEdge('end'), title: 'End of Document' },
      'go.back': { run: handleReturnBack, enabled: history.canGoBack },
      'go.forward': { run: handleForward, enabled: history.canGoForward },
    },
  });

  useEffect(() => {
    if (jumpNonce === null) return;
    if (jumpResolved) {
      const timer = window.setTimeout(() => onJumpHandled(jumpNonce), PULSE_MS);
      return () => window.clearTimeout(timer);
    }
    // Not loaded yet: this effect re-runs as chunks arrive. Once the file has
    // ended the anchor is unreachable, which means the file changed on disk.
    if (!complete && jumpAnchor) return;
    const timer = window.setTimeout(() => {
      setMissedJump(true);
      onJumpHandled(jumpNonce);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [jumpNonce, jumpResolved, jumpAnchor, complete, onJumpHandled]);

  // ---- Rendering -----------------------------------------------------------

  const ranges = useMemo(() => {
    const painted = paint(model, effectiveHighlights);
    // A jump can target an annotation from another notebook, with no highlight here.
    if (
      jumpRange &&
      jumpRequest &&
      !painted.some((range) => range.annotationId === jumpRequest.annotationId)
    ) {
      painted.push({
        annotationId: jumpRequest.annotationId,
        color: '#fde047',
        ...jumpRange,
      });
    }
    if (activeSearchRange) {
      painted.push({
        annotationId: SEARCH_HIGHLIGHT_ID,
        color: SEARCH_HIGHLIGHT_COLOR,
        ...activeSearchRange,
      });
    }
    return painted;
    // `rowCount` and `complete` stand in for the mutable model's loaded length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    model,
    rowCount,
    complete,
    effectiveHighlights,
    jumpRequest,
    jumpRange?.startUnit,
    jumpRange?.endUnit,
    activeSearchRange?.startUnit,
    activeSearchRange?.endUnit,
  ]);

  if (load.error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not read {document.title}: {load.error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col bg-background text-foreground"
      data-testid="txt-viewer"
      data-reading-theme={effectivePreferences.theme}
      data-resolved-theme={theme}
      data-reading-margins={effectivePreferences.margins}
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
              disabled={chromeHidden}
              onClick={navigator.toggle}
            />
            <HistoryButtons
              canGoBack={history.canGoBack}
              canGoForward={history.canGoForward}
              onBack={handleReturnBack}
              onForward={handleForward}
            />
          </>
        }
        center={<ToolbarTitle title={document.title} />}
        trailing={
          <>
            <AppearanceMenu
              open={preferencesPanel.open}
              onToggle={preferencesPanel.toggle}
              onClose={preferencesPanel.close}
              preferences={effectivePreferences}
              onChange={updatePreferences}
              format="txt"
            />
            {markup.visible && (
              <SelectionAnnotationControls
                hasSelection={activeSelection !== null}
                controller={annotationsController}
              />
            )}
            <ToolbarSeparator />
            <BookmarkToggleButton
              bookmarked={bookmarksController.isCurrentBookmarked}
              onToggle={bookmarksController.toggleCurrentBookmark}
            />
            <ToolbarSearchField
              search={search}
              onReturnFocus={() => scrollRef.current?.focus({ preventScroll: true })}
            />
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1">
        {showSidebar && (
          <ReaderNavigator
            navigator={navigator}
            bookmarks={bookmarksController}
            annotations={annotationsController}
            search={search}
            groupSearchResults={false}
            annotationPlacement={(annotation) => ({
              order: asTxtAnchor(annotation.anchor)?.startByteOffset ?? Number.MAX_SAFE_INTEGER,
            })}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ReaderPopoverLayer>
            <SelectionNoteComposer
              hasSelection={activeSelection !== null}
              controller={annotationsController}
            />
            {(load.hadReplacements || missedJump) && (
              <p role="status" className="bg-muted px-4 py-1.5 text-xs text-foreground">
                {missedJump
                  ? 'That excerpt is past the end of this file, which may have changed since it was saved.'
                  : 'This file has bytes that are not valid UTF-8. They are shown as �.'}
              </p>
            )}
          </ReaderPopoverLayer>
          <div className="group/page relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              tabIndex={-1}
              data-testid="txt-scroll"
              data-turn-zone={gestures.zone ?? undefined}
              className="min-h-0 flex-1 overflow-auto outline-none"
              style={{ ...pageSurfaceStyle(theme), cursor: zoneCursor(gestures.zone) || undefined }}
            >
              <div
                ref={pageRef}
                role="document"
                aria-label={document.title}
                // Hyphenation needs a language; a text file declares none.
                lang={window.navigator.language || undefined}
                className="relative mx-auto w-full"
                style={{
                  height: virtualizer.getTotalSize(),
                  maxWidth: page.maxWidth,
                  fontFamily,
                  fontSize: `${(effectivePreferences.fontSize / 100).toFixed(2)}rem`,
                  lineHeight:
                    effectivePreferences.lineSpacing === 1.75
                      ? 1.625
                      : effectivePreferences.lineSpacing,
                }}
              >
                {virtualizer.getVirtualItems().map((item) => (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 min-h-[1lh] w-full break-words whitespace-pre-wrap"
                    style={{
                      transform: `translateY(${item.start}px)`,
                      paddingInline: page.sidePadding,
                      ...(effectivePreferences.justify
                        ? { textAlign: 'justify', hyphens: 'auto' }
                        : { textAlign: 'start', hyphens: 'manual' }),
                    }}
                  >
                    <TxtRow
                      segments={segmentRow(
                        model.rowStart(item.index),
                        model.rowText(item.index),
                        ranges,
                      )}
                      pulsingAnnotationId={pulsingAnnotationId}
                    />
                  </div>
                ))}
              </div>
            </div>
            <PageTurnChevrons onPrevious={() => turnPage(-1)} onNext={() => turnPage(1)} />
          </div>
          <ReaderFooter
            readouts={{
              position: `Line ${currentRow + 1} of ${rowCount}${complete ? '' : '…'}`,
              percent: `${percent}%${complete ? '' : '…'}`,
            }}
            scrubber={scrubber}
            backLabel={backChip.label}
            onBack={handleReturnBack}
            style={pageFooterStyle(theme)}
          />
        </div>
      </div>
    </div>
  );
}
