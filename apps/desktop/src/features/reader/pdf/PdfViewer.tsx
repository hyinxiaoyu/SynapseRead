import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Columns2,
  Crop,
  Expand,
  FileText,
  MoveHorizontal,
  PanelLeft,
  RotateCcw,
  RotateCw,
  ScrollText,
  Scan,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';

import { type SegmentedOption, SegmentedControl } from '@/components/ui/segmented-control';
import {
  type AnnotationPlacement,
  SelectionAnnotationControls,
  SelectionNoteComposer,
  useAnnotationsController,
} from '@/features/reader/AnnotationsPanel';
import { BookmarkToggleButton, useBookmarksController } from '@/features/reader/BookmarksPanel';
import {
  buildSearchSnippet,
  type DocumentSearchResultItem,
  findSubstringMatches,
  SEARCH_HIGHLIGHT_COLOR,
  SEARCH_HIGHLIGHT_ID,
  ToolbarSearchField,
  useDocumentSearch,
} from '@/features/reader/DocumentSearch';
import { ReaderNavigator } from '@/features/reader/navigator/NavigatorSidebar';
import { NavigatorEmptyState } from '@/features/reader/navigator/parts';
import type { OutlineNode } from '@/features/reader/navigator/OutlineTree';
import { useNavigator } from '@/features/reader/navigator/useNavigator';
import { PULSE_MS } from '@/features/reader/pulse';
import {
  HistoryButtons,
  ReaderPopoverLayer,
  ReaderToolbar,
  ToolbarButton,
  ToolbarOverflowMenu,
  ToolbarSeparator,
} from '@/features/reader/ReaderToolbar';
import { useJumpHistory } from '@/features/reader/useJumpHistory';
import { useMarkupToolbar, useReaderCommands } from '@/features/reader/useReaderCommands';
import { cn, describeError } from '@/lib/utils';
import type {
  Annotation,
  Bookmark,
  DocumentViewerProps,
  NormalizedRect,
  PdfAnchor,
  PdfPageSpan,
  ReaderHighlight,
  ReaderSelection,
} from '@/types/domain';

import {
  type Cancellable,
  cropCanvasToPng,
  openPdfDocument,
  type PageSize,
  type PdfDocumentHandle,
  type PdfInternalLink,
  type PdfOutlineItem,
  type PdfPageAnnotations,
  type PdfPageText,
} from './pdfEngine';
import {
  mergeLineRects,
  normalizeBoxes,
  type PdfRotation,
  rotateNormalizedRect,
  unrotateNormalizedRect,
} from './pdfGeometry';

const PAGE_GAP_PX = 12;
const SIDE_PADDING_PX = 12;
const OVERSCAN_PAGES = 1;
const CURSOR_DEBOUNCE_MS = 400;
const SIZE_BATCH = 50;
/** Smaller than this is a stray click, not a capture. */
const MIN_CAPTURE_PX = 4;
const CURSOR_RECT_HEIGHT = 0.001;
/** Only until the first page's size has loaded. */
const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
const MIN_ZOOM_SCALE = 0.25;
const MAX_ZOOM_SCALE = 4;
const ZOOM_STEP = 0.25;
const THUMBNAIL_WIDTH_PX = 92;
const THUMBNAIL_ROW_HEIGHT_PX = 148;

export type PdfZoomMode = 'fit-width' | 'fit-page' | 'actual-size' | 'custom';
export type PdfDisplayMode = 'continuous' | 'single' | 'two-page';
export type { PdfRotation };

const asPdfAnchor = (anchor: { format: string } | null | undefined): PdfAnchor | null =>
  anchor?.format === 'pdf' ? (anchor as PdfAnchor) : null;

/** Follows an element's dimensions, settling first so a dragged pane does not re-render pages. */
function useSettledSize(ref: React.RefObject<HTMLElement | null>): {
  width: number;
  height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: number | undefined;
    let currentWidth = element.clientWidth;
    let currentHeight = element.clientHeight;
    setSize({ width: currentWidth, height: currentHeight });
    const observer = new ResizeObserver(() => {
      const nextWidth = element.clientWidth;
      const nextHeight = element.clientHeight;
      if (nextWidth === currentWidth && nextHeight === currentHeight) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        currentWidth = element.clientWidth;
        currentHeight = element.clientHeight;
        setSize({ width: currentWidth, height: currentHeight });
      }, 150);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

/** Loads every page's size in order. Known sizes make scroll offsets exact. */
function usePageSizes(engine: PdfDocumentHandle): PageSize[] {
  const [sizes, setSizes] = useState<PageSize[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: PageSize[] = [];
      for (let index = 0; index < engine.pageCount && !cancelled; index += 1) {
        loaded.push(await engine.pageSize(index));
        // The first page shows at once; after that, batches avoid a render per page.
        if (index === 0 || loaded.length % SIZE_BATCH === 0 || index === engine.pageCount - 1) {
          if (!cancelled) setSizes([...loaded]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine]);
  return sizes;
}

function usePdfOutline(engine: PdfDocumentHandle, enabled: boolean): readonly PdfOutlineItem[] {
  const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([]);
  useEffect(() => {
    if (!enabled || !engine.getOutline) return;
    let cancelled = false;
    engine
      .getOutline()
      .then((items) => {
        if (!cancelled) setOutline(items);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, enabled]);
  return outline;
}

function toPdfOutlineNodes(items: readonly PdfOutlineItem[]): OutlineNode<number>[] {
  return items.map((item) => ({
    id: item.id,
    label: item.title,
    target: item.pageIndex,
    children: toPdfOutlineNodes(item.children),
    ...(item.pageIndex !== null ? { hint: String(item.pageIndex + 1) } : {}),
  }));
}

/**
 * The outline entry for `pageIndex`: the one starting closest before it, the
 * deepest of several on the same page.
 */
function currentOutlineId(items: readonly OutlineNode<number>[], pageIndex: number): string | null {
  let bestId: string | null = null;
  let bestPage = -1;
  const walk = (nodes: readonly OutlineNode<number>[]) => {
    for (const node of nodes) {
      if (node.target !== null && node.target <= pageIndex && node.target >= bestPage) {
        bestId = node.id;
        bestPage = node.target;
      }
      walk(node.children);
    }
  };
  walk(items);
  return bestId;
}

/** The top-level outline section containing `pageIndex`, for grouping highlights. */
function chapterOfPage(items: readonly OutlineNode<number>[], pageIndex: number): string | null {
  let best: OutlineNode<number> | null = null;
  for (const node of items) {
    if (node.target !== null && node.target <= pageIndex && node.target >= (best?.target ?? -1)) {
      best = node;
    }
  }
  return best?.label ?? null;
}

const DISPLAY_MODES: readonly SegmentedOption<PdfDisplayMode>[] = [
  { value: 'single', label: 'Single page', icon: FileText, testId: 'pdf-mode-single' },
  { value: 'two-page', label: 'Two pages', icon: Columns2, testId: 'pdf-mode-two-page' },
  {
    value: 'continuous',
    label: 'Continuous scroll',
    icon: ScrollText,
    testId: 'pdf-mode-continuous',
  },
];

const isSamePdfLocation = (a: PdfReturnLocation, b: PdfReturnLocation) =>
  a.pageIndex === b.pageIndex && Math.abs(a.fraction - b.fraction) <= 0.02;

interface PdfReturnLocation {
  pageIndex: number;
  fraction: number;
}

export interface PdfSearchMatch extends DocumentSearchResultItem {
  pageIndex: number;
  rects: readonly NormalizedRect[];
}

function searchPdfPage(
  pageText: PdfPageText,
  query: string,
  caseSensitive: boolean,
): PdfSearchMatch[] {
  let fullText = '';
  const spans: { start: number; end: number; rect: NormalizedRect }[] = [];
  let prevHadEOL = false;

  for (const run of pageText.runs) {
    if (
      fullText.length > 0 &&
      prevHadEOL &&
      !fullText.endsWith(' ') &&
      !fullText.endsWith('\n') &&
      !run.text.startsWith(' ')
    ) {
      fullText += '\n';
    }
    const start = fullText.length;
    fullText += run.text;
    const end = fullText.length;
    spans.push({ start, end, rect: run.rect });
    prevHadEOL = Boolean(run.hasEOL);
  }

  const rawMatches = findSubstringMatches(fullText, query, caseSensitive);
  return rawMatches.map(({ start, end }, matchIndex) => {
    const rawRects: NormalizedRect[] = [];
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue;
      const overlapStart = Math.max(start, span.start) - span.start;
      const overlapEnd = Math.min(end, span.end) - span.start;
      const spanLen = Math.max(span.end - span.start, 1);
      const x = Math.min(1, Math.max(0, span.rect.x + span.rect.width * (overlapStart / spanLen)));
      const width = Math.min(
        1 - x,
        Math.max(0.004, span.rect.width * ((overlapEnd - overlapStart) / spanLen)),
      );
      rawRects.push({
        x,
        y: span.rect.y,
        width,
        height: span.rect.height,
      });
    }
    const rects = mergeLineRects(rawRects);
    const snippet = buildSearchSnippet(fullText, start, end);
    return {
      id: `pdf-${pageText.pageIndex}-${matchIndex}`,
      pageIndex: pageText.pageIndex,
      rects: rects.length > 0 ? rects : [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
      locationLabel: `Page ${pageText.pageIndex + 1}`,
      ...snippet,
    };
  });
}

function runCancellable(start: () => Cancellable): () => void {
  const task = start();
  // pdf.js rejects a cancelled render, which is expected here.
  task.promise.catch(() => undefined);
  return () => task.cancel();
}

interface CaptureBox {
  pageIndex: number;
  rect: NormalizedRect;
}

const EMPTY_PAGE_ANNOTATIONS: PdfPageAnnotations = {
  links: [],
  embeddedAnnotations: [],
  unsupportedSubtypes: [],
};

function PdfThumbnailItem({
  engine,
  pageIndex,
  pageSize,
  rotation,
  isActive,
  onSelect,
}: {
  engine: PdfDocumentHandle;
  pageIndex: number;
  pageSize: PageSize;
  rotation: PdfRotation;
  isActive: boolean;
  onSelect: (pageIndex: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotatedWidth = rotation === 90 || rotation === 270 ? pageSize.height : pageSize.width;
  const rotatedHeight = rotation === 90 || rotation === 270 ? pageSize.width : pageSize.height;
  const scale = Math.max(0.05, THUMBNAIL_WIDTH_PX / Math.max(rotatedWidth, 1));
  const displayWidth = Math.max(24, Math.round(rotatedWidth * scale));
  const displayHeight = Math.max(24, Math.min(116, Math.round(rotatedHeight * scale)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCancellable(() => engine.renderPage(pageIndex, canvas, scale, rotation));
  }, [engine, pageIndex, scale, rotation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  return (
    <button
      type="button"
      data-testid={`pdf-thumbnail-${pageIndex}`}
      aria-label={`Thumbnail page ${pageIndex + 1}`}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(pageIndex)}
      className={cn(
        'flex w-full flex-col items-center gap-1 rounded p-1.5 text-xs transition-colors hover:bg-muted',
        isActive && 'bg-primary/10 font-medium text-primary ring-1 ring-primary',
      )}
    >
      <div
        className="overflow-hidden rounded border bg-white shadow-xs"
        style={{ width: displayWidth, height: displayHeight }}
      >
        <canvas ref={canvasRef} className="block size-full object-contain" />
      </div>
      <span className="tabular-nums">{pageIndex + 1}</span>
    </button>
  );
}

function PdfThumbnailsList({
  engine,
  sizes,
  rotation,
  currentPageIndex,
  filter,
  onSelectPage,
}: {
  engine: PdfDocumentHandle;
  sizes: readonly PageSize[];
  rotation: PdfRotation;
  currentPageIndex: number;
  /** Page numbers containing this text, as Preview's sidebar filter does. */
  filter: string;
  onSelectPage: (pageIndex: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const needle = filter.trim();
  const pages = useMemo(() => {
    const all = Array.from({ length: engine.pageCount }, (_, index) => index);
    return needle ? all.filter((index) => String(index + 1).includes(needle)) : all;
  }, [engine.pageCount, needle]);
  // eslint-disable-next-line react-hooks/incompatible-library -- used only in this component, never memoized across renders.
  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => THUMBNAIL_ROW_HEIGHT_PX,
    overscan: 2,
  });

  const currentRow = pages.indexOf(currentPageIndex);
  useEffect(() => {
    if (currentRow >= 0) virtualizer.scrollToIndex(currentRow, { align: 'auto' });
  }, [currentRow, virtualizer]);

  if (pages.length === 0) return <NavigatorEmptyState title="No matching pages" />;

  return (
    <div
      ref={listRef}
      data-testid="pdf-thumbnails-sidebar"
      aria-label="Page thumbnails"
      role="group"
      className="min-h-0 flex-1 overflow-y-auto p-1.5"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const pageIndex = pages[item.index] ?? 0;
          return (
            <div
              key={item.key}
              className="absolute top-0 left-0 w-full px-0.5"
              style={{
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <PdfThumbnailItem
                engine={engine}
                pageIndex={pageIndex}
                pageSize={sizes[pageIndex] ?? sizes[0] ?? DEFAULT_PAGE_SIZE}
                rotation={rotation}
                isActive={pageIndex === currentPageIndex}
                onSelect={onSelectPage}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PdfPage({
  engine,
  pageIndex,
  scale,
  rotation,
  highlights,
  pulsingAnnotationId,
  captureMode,
  captureBox,
  onCapture,
  onNavigateLink,
  onPageAnnotationsLoaded,
}: {
  engine: PdfDocumentHandle;
  pageIndex: number;
  scale: number;
  rotation: PdfRotation;
  highlights: readonly ReaderHighlight[];
  pulsingAnnotationId: string | null;
  captureMode: boolean;
  captureBox: NormalizedRect | null;
  onCapture: (canvas: HTMLCanvasElement, rect: NormalizedRect) => void;
  onNavigateLink: (link: PdfInternalLink) => void;
  onPageAnnotationsLoaded: (pageIndex: number, annotations: PdfPageAnnotations) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; x: number; y: number } | null>(
    null,
  );
  const [pageAnnotations, setPageAnnotations] =
    useState<PdfPageAnnotations>(EMPTY_PAGE_ANNOTATIONS);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCancellable(() => engine.renderPage(pageIndex, canvas, scale, rotation));
  }, [engine, pageIndex, scale, rotation]);

  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    return runCancellable(() => engine.renderTextLayer(pageIndex, layer, scale, rotation));
  }, [engine, pageIndex, scale, rotation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = textLayerRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      layer?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (!engine.getPageAnnotations) return;
    let cancelled = false;
    engine
      .getPageAnnotations(pageIndex)
      .then((loaded) => {
        if (cancelled) return;
        setPageAnnotations(loaded);
        onPageAnnotationsLoaded(pageIndex, loaded);
      })
      .catch(() => {
        if (!cancelled) setPageAnnotations(EMPTY_PAGE_ANNOTATIONS);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, pageIndex, onPageAnnotationsLoaded]);

  const pointIn = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    setDrag(null);
    if (!drag || !canvas) return;
    const box = event.currentTarget.getBoundingClientRect();
    const end = pointIn(event);
    const width = Math.abs(end.x - drag.startX);
    const height = Math.abs(end.y - drag.startY);
    if (width < MIN_CAPTURE_PX || height < MIN_CAPTURE_PX) return;
    const [rect] = normalizeBoxes(
      [{ left: Math.min(end.x, drag.startX), top: Math.min(end.y, drag.startY), width, height }],
      { left: 0, top: 0, width: box.width, height: box.height },
    );
    if (rect) onCapture(canvas, rect);
  };

  const rotatedCaptureBox = captureBox ? rotateNormalizedRect(captureBox, rotation) : null;

  return (
    <div
      data-page-index={pageIndex}
      data-page-rotation={rotation}
      className="pdf-page relative bg-white shadow"
      style={{ '--scale-factor': scale, width: '100%', height: '100%' } as CSSProperties}
    >
      <canvas ref={canvasRef} className="block size-full" />

      {pageAnnotations.embeddedAnnotations.map((annot) =>
        annot.rects.map((rawRect, index) => {
          const rect = rotateNormalizedRect(rawRect, rotation);
          const isLineStyle = annot.subtype === 'Underline' || annot.subtype === 'StrikeOut';
          return (
            <div
              key={`embedded-${annot.id}-${index}`}
              data-testid="pdf-embedded-annotation"
              data-annotation-subtype={annot.subtype}
              title={
                annot.contents
                  ? `${annot.author ? `${annot.author}: ` : ''}${annot.contents}`
                  : `${annot.subtype} annotation`
              }
              aria-label={
                annot.contents
                  ? `Embedded ${annot.subtype}: ${annot.contents}`
                  : `Embedded ${annot.subtype}`
              }
              className={cn(
                'pointer-events-auto absolute',
                annot.subtype === 'Underline'
                  ? 'border-b-2 border-amber-600/80'
                  : annot.subtype === 'StrikeOut'
                    ? 'border-b-2 border-rose-600/80'
                    : 'mix-blend-multiply',
              )}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                backgroundColor: isLineStyle ? 'transparent' : annot.color,
              }}
            >
              {index === 0 && annot.contents && (
                <span data-testid="pdf-embedded-annotation-note" className="sr-only">
                  {annot.contents}
                </span>
              )}
            </div>
          );
        }),
      )}

      {highlights.map(({ annotationId, anchor, color }) =>
        asPdfAnchor(anchor)?.rects.map((rawRect, index) => {
          const rect = rotateNormalizedRect(rawRect, rotation);
          return (
            <div
              key={`${annotationId}-${index}`}
              data-annotation-id={annotationId}
              className={cn(
                'pointer-events-none absolute mix-blend-multiply',
                pulsingAnnotationId === annotationId && 'anchor-pulse',
              )}
              style={
                {
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                  backgroundColor: color,
                  '--anchor-pulse-color': color,
                } as CSSProperties
              }
            />
          );
        }),
      )}

      <div ref={textLayerRef} data-testid="pdf-text-layer" className="textLayer" />

      {pageAnnotations.links.map((link) => {
        const rect = rotateNormalizedRect(link.rect, rotation);
        return (
          <button
            key={link.id}
            type="button"
            data-testid="pdf-internal-link"
            data-target-page={link.targetPageIndex}
            aria-label={`Jump to linked page ${link.targetPageIndex + 1}`}
            onClick={(event) => {
              event.stopPropagation();
              onNavigateLink(link);
            }}
            className="absolute z-10 cursor-pointer rounded-xs border border-transparent transition-colors hover:border-primary/50 hover:bg-primary/10 focus-visible:border-primary focus-visible:outline-none"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        );
      })}

      {rotatedCaptureBox && (
        <div
          data-testid="pdf-capture-box"
          className="pointer-events-none absolute border-2 border-primary"
          style={{
            left: `${rotatedCaptureBox.x * 100}%`,
            top: `${rotatedCaptureBox.y * 100}%`,
            width: `${rotatedCaptureBox.width * 100}%`,
            height: `${rotatedCaptureBox.height * 100}%`,
          }}
        />
      )}

      {captureMode && (
        <div
          data-testid="pdf-capture-surface"
          className="absolute inset-0 z-10 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const point = pointIn(event);
            setDrag({ startX: point.x, startY: point.y, ...point });
          }}
          onPointerMove={(event) => {
            if (drag) setDrag({ ...drag, ...pointIn(event) });
          }}
          onPointerUp={finishDrag}
        >
          {drag && (
            <div
              className="absolute border-2 border-dashed border-primary bg-primary/10"
              style={{
                left: Math.min(drag.startX, drag.x),
                top: Math.min(drag.startY, drag.y),
                width: Math.abs(drag.x - drag.startX),
                height: Math.abs(drag.y - drag.startY),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The selected text on one page, and where it is, read from the text layer's runs. */
function readPageSelection(
  range: Range,
  pageElement: HTMLElement,
  rotation: PdfRotation = 0,
): { rects: NormalizedRect[]; text: string } | null {
  const layer = pageElement.querySelector('.textLayer');
  if (!layer) return null;
  const view = layer.ownerDocument;
  const box = pageElement.getBoundingClientRect();
  const walker = view.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);

  const boxes: DOMRect[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === 'BR' && text && range.intersectsNode(node)) text += '\n';
      continue;
    }
    if (!range.intersectsNode(node)) continue;
    const textNode = node as Text;
    const part = view.createRange();
    part.selectNodeContents(textNode);
    if (range.startContainer === textNode) part.setStart(textNode, range.startOffset);
    if (range.endContainer === textNode) part.setEnd(textNode, range.endOffset);
    if (part.collapsed) continue;
    boxes.push(...part.getClientRects());
    text += part.toString();
  }

  const viewportRects = mergeLineRects(normalizeBoxes(boxes, box));
  const rects = viewportRects.map((rect) => unrotateNormalizedRect(rect, rotation));
  const cleaned = text.replace(/\n{2,}/g, '\n').trim();
  return rects.length > 0 && cleaned ? { rects, text: cleaned } : null;
}

function PdfPages({
  engine,
  document,
  isActive,
  chromeHidden = false,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
  onCursorChange,
  bookmarks,
  onAddBookmark,
  onRemoveBookmark,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  canUndoAnnotationDelete,
  onUndoAnnotationDelete,
}: { engine: PdfDocumentHandle } & Omit<DocumentViewerProps<'pdf'>, 'content'>) {
  const documentId = document.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSettledSize(scrollRef);
  const sizes = usePageSizes(engine);
  const navigator = useNavigator('pdf', ['thumbnails', 'contents', 'notes', 'bookmarks']);
  // Loaded once the sidebar first opens; highlights group under its chapters too.
  const outline = usePdfOutline(engine, navigator.open);
  const outlineNodes = useMemo(() => toPdfOutlineNodes(outline), [outline]);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>('fit-width');
  const [customScale, setCustomScale] = useState(1);
  const [displayMode, setDisplayMode] = useState<PdfDisplayMode>('continuous');
  const [rotation, setRotation] = useState<PdfRotation>(0);
  const [unsupportedSubtypes, setUnsupportedSubtypes] = useState<readonly string[]>([]);
  const contentWidth = Math.max(width - SIDE_PADDING_PX * 2, 1);
  const availableHeight = Math.max(height - PAGE_GAP_PX * 2, 1);
  const availablePageWidth =
    displayMode === 'two-page' ? Math.max((contentWidth - PAGE_GAP_PX) / 2, 1) : contentWidth;

  const sizeOf = useCallback(
    (index: number): PageSize => {
      const raw = sizes[index] ?? sizes[0] ?? DEFAULT_PAGE_SIZE;
      return rotation === 90 || rotation === 270 ? { width: raw.height, height: raw.width } : raw;
    },
    [rotation, sizes],
  );
  const scaleOf = useCallback(
    (index: number) => {
      const size = sizeOf(index);
      switch (zoomMode) {
        case 'fit-width':
          return availablePageWidth / size.width;
        case 'fit-page':
          return Math.min(availablePageWidth / size.width, availableHeight / size.height);
        case 'actual-size':
          return 1;
        case 'custom':
          return customScale;
      }
    },
    [availableHeight, availablePageWidth, customScale, sizeOf, zoomMode],
  );
  const pageWidth = useCallback(
    (index: number) =>
      zoomMode === 'fit-width' ? availablePageWidth : sizeOf(index).width * scaleOf(index),
    [availablePageWidth, sizeOf, scaleOf, zoomMode],
  );
  const pageHeight = useCallback(
    (index: number) => sizeOf(index).height * scaleOf(index),
    [sizeOf, scaleOf],
  );

  const [pinnedPages, setPinnedPages] = useState<readonly number[]>([]);
  const [activeSelection, setActiveSelection] = useState<ReaderSelection | null>(null);
  const [captureMode, setCaptureMode] = useState(false);
  const [capture, setCapture] = useState<(CaptureBox & { highlightCount: number }) | null>(null);
  const [missedJump, setMissedJump] = useState(false);
  const history = useJumpHistory<PdfReturnLocation>(isSamePdfLocation);
  const pushHistory = history.push;
  const markup = useMarkupToolbar();
  const pageInputRef = useRef<HTMLInputElement>(null);
  const pendingZoomTarget = useRef<PdfReturnLocation | null>(null);

  // ---- Reopen at the last reading position ---------------------------------

  const [initialCursor] = useState(() => asPdfAnchor(document.lastCursorAnchor));
  const [initialJump] = useState(jumpRequest);
  const [currentPageIndex, setCurrentPageIndex] = useState(() =>
    initialCursor && initialCursor.pageIndex < engine.pageCount ? initialCursor.pageIndex : 0,
  );
  const [pageInput, setPageInput] = useState(() => String(currentPageIndex + 1));
  const [pageInputInvalid, setPageInputInvalid] = useState(false);
  const restored = useRef(initialCursor === null || initialJump !== null);
  const lastReported = useRef(
    initialCursor ? `${initialCursor.pageIndex}:${initialCursor.rects[0]?.y ?? 0}` : `0:0`,
  );

  useEffect(() => {
    setPageInput(String(currentPageIndex + 1));
    setPageInputInvalid(false);
  }, [currentPageIndex]);

  const rowCount =
    displayMode === 'single'
      ? 1
      : displayMode === 'two-page'
        ? Math.ceil(engine.pageCount / 2)
        : engine.pageCount;

  const rowOfPage = useCallback(
    (pageIndex: number): number => {
      if (displayMode === 'single') return 0;
      if (displayMode === 'two-page') return Math.floor(pageIndex / 2);
      return pageIndex;
    },
    [displayMode],
  );

  const pagesInRow = useCallback(
    (rowIndex: number): readonly number[] => {
      if (displayMode === 'single') return [currentPageIndex];
      if (displayMode === 'two-page') {
        const first = rowIndex * 2;
        const second = first + 1;
        return second < engine.pageCount ? [first, second] : [first];
      }
      return [rowIndex];
    },
    [currentPageIndex, displayMode, engine.pageCount],
  );

  const rowHeight = useCallback(
    (rowIndex: number) => {
      const pages = pagesInRow(rowIndex);
      return Math.max(...pages.map((p) => pageHeight(p)), 1);
    },
    [pageHeight, pagesInRow],
  );

  const rowWidth = useCallback(
    (rowIndex: number) => {
      const pages = pagesInRow(rowIndex);
      return (
        pages.reduce((sum, p) => sum + pageWidth(p), 0) +
        Math.max(0, pages.length - 1) * PAGE_GAP_PX
      );
    },
    [pageWidth, pagesInRow],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- used only in this component, never memoized across renders.
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (rowIndex) => rowHeight(rowIndex) + PAGE_GAP_PX,
    overscan: OVERSCAN_PAGES,
    rangeExtractor: (range) => {
      const rows = new Set<number>();
      for (
        let row = range.startIndex - range.overscan;
        row <= range.endIndex + range.overscan;
        row += 1
      ) {
        if (row >= 0 && row < range.count) rows.add(row);
      }
      for (const page of pinnedPages) {
        const row = rowOfPage(page);
        if (row >= 0 && row < range.count) rows.add(row);
      }
      return [...rows].sort((a, b) => a - b);
    },
  });

  // ---- Selection -----------------------------------------------------------

  const hasSelection = useRef(false);
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const view = root.ownerDocument;
    const selection = view.getSelection();

    if (!isActive) {
      if (selection?.anchorNode && root.contains(selection.anchorNode)) selection.removeAllRanges();
      hasSelection.current = false;
      setActiveSelection(null);
      return;
    }

    const clear = () => {
      if (!hasSelection.current) return;
      hasSelection.current = false;
      setPinnedPages([]);
      setActiveSelection(null);
      onSelectionChange(null);
    };
    const onChange = () => {
      const current = view.getSelection();
      const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : null;
      if (!range || range.collapsed || !root.contains(range.commonAncestorContainer)) {
        // A capture is a selection too, and a click on its surface must not drop it.
        if (!capture) clear();
        return;
      }
      const pageElements = Array.from(root.querySelectorAll<HTMLElement>('[data-page-index]'));
      const spans: PdfPageSpan[] = [];
      const texts: string[] = [];
      for (const pageElement of pageElements) {
        if (!range.intersectsNode(pageElement)) continue;
        const selected = readPageSelection(range, pageElement, rotation);
        if (!selected) continue;
        const pageIndex = Number(pageElement.dataset.pageIndex);
        spans.push({ pageIndex, rects: selected.rects });
        texts.push(selected.text);
      }
      spans.sort((a, b) => a.pageIndex - b.pageIndex);
      const firstSpan = spans[0];
      if (!firstSpan) {
        clear();
        return;
      }
      const anchor: PdfAnchor = {
        format: 'pdf',
        pageIndex: firstSpan.pageIndex,
        rects: firstSpan.rects,
        ...(spans.length > 1 ? { pageSpans: spans } : {}),
      };
      const nextSelection: ReaderSelection = {
        documentId,
        anchor,
        text: texts.join('\n'),
        imagePng: null,
      };
      hasSelection.current = true;
      setCapture(null);
      setPinnedPages(spans.map((span) => span.pageIndex));
      setActiveSelection(nextSelection);
      onSelectionChange(nextSelection);
    };
    view.addEventListener('selectionchange', onChange);
    return () => view.removeEventListener('selectionchange', onChange);
  }, [isActive, documentId, onSelectionChange, capture, rotation]);

  const onCapture = useCallback(
    (pageIndex: number, canvas: HTMLCanvasElement, viewportRect: NormalizedRect) => {
      scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      hasSelection.current = true;
      const canonicalRect = unrotateNormalizedRect(viewportRect, rotation);
      setCapture({ pageIndex, rect: canonicalRect, highlightCount: highlights.length });
      setCaptureMode(false);
      const nextSelection: ReaderSelection = {
        documentId,
        anchor: { format: 'pdf', pageIndex, rects: [canonicalRect] },
        text: null,
        imagePng: cropCanvasToPng(canvas, viewportRect),
      };
      setActiveSelection(nextSelection);
      onSelectionChange(nextSelection);
    },
    [documentId, highlights.length, onSelectionChange, rotation],
  );

  const toggleCaptureMode = () => {
    if (!captureMode) scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    if (capture) {
      setCapture(null);
      hasSelection.current = false;
      setActiveSelection(null);
      onSelectionChange(null);
    }
    setCaptureMode(!captureMode);
  };

  // Excerpting adds a highlight, which then replaces the box.
  const visibleCapture = capture?.highlightCount === highlights.length ? capture : null;

  const offsetWithin = useCallback(
    (pageIndex: number, fraction: number) => {
      const rowIndex = rowOfPage(pageIndex);
      const [start] = virtualizer.getOffsetForIndex(rowIndex, 'start') ?? [0];
      return start + fraction * pageHeight(pageIndex);
    },
    [virtualizer, pageHeight, rowOfPage],
  );

  const lastScrollTop = useRef(0);
  const programmaticScrollRef = useRef<{ pageIndex: number; scrollTop: number } | null>(null);
  /**
   * Where the reader is, as a page and fraction, kept current by every scroll.
   * When the pane's width changes (a sidebar opens, the window resizes) and fit
   * width rescales the pages, the view returns here rather than to a pixel
   * offset that now belongs to another part of the document.
   */
  const layoutAnchor = useRef<PdfReturnLocation | null>(null);
  const scrollToPageOffset = useCallback(
    (pageIndex: number, offset: number) => {
      setCurrentPageIndex(pageIndex);
      virtualizer.scrollToOffset(offset);
      const actualScrollTop = scrollRef.current?.scrollTop ?? offset;
      lastScrollTop.current = actualScrollTop;
      programmaticScrollRef.current = { pageIndex, scrollTop: actualScrollTop };
      const height = pageHeight(pageIndex);
      const fraction = height > 0 ? (offset - offsetWithin(pageIndex, 0)) / height : 0;
      layoutAnchor.current = { pageIndex, fraction: Math.min(Math.max(fraction, 0), 0.99) };
    },
    [offsetWithin, pageHeight, virtualizer],
  );
  const currentReturnLocation = useCallback((): PdfReturnLocation => {
    if (
      programmaticScrollRef.current &&
      Math.abs(lastScrollTop.current - programmaticScrollRef.current.scrollTop) <= 2
    ) {
      // Where the viewer was sent, exactly; geometry may still be settling.
      const anchor = layoutAnchor.current;
      const { pageIndex } = programmaticScrollRef.current;
      return anchor?.pageIndex === pageIndex ? anchor : { pageIndex, fraction: 0 };
    }
    if (displayMode === 'single') {
      const height = pageHeight(currentPageIndex);
      const fraction = height > 0 ? Math.min(Math.max(lastScrollTop.current / height, 0), 0.99) : 0;
      return { pageIndex: currentPageIndex, fraction };
    }
    const item = virtualizer.getVirtualItemForOffset(lastScrollTop.current);
    if (!item) return { pageIndex: currentPageIndex, fraction: 0 };
    const pages = pagesInRow(item.index);
    const pageIndex = pages.includes(currentPageIndex)
      ? currentPageIndex
      : (pages[0] ?? currentPageIndex);
    const height = pageHeight(pageIndex);
    const fraction =
      height > 0 ? Math.min(Math.max((lastScrollTop.current - item.start) / height, 0), 0.99) : 0;
    return { pageIndex, fraction };
  }, [virtualizer, pageHeight, currentPageIndex, displayMode, pagesInRow]);

  const currentScale = scaleOf(currentPageIndex);
  const zoomPercent = Math.round(currentScale * 100);

  const applyZoom = useCallback(
    (nextMode: PdfZoomMode, nextScale?: number) => {
      pendingZoomTarget.current = currentReturnLocation();
      setZoomMode(nextMode);
      if (nextScale !== undefined) {
        const clamped = Math.min(
          MAX_ZOOM_SCALE,
          Math.max(MIN_ZOOM_SCALE, Math.round(nextScale * 100) / 100),
        );
        setCustomScale(clamped);
      }
    },
    [currentReturnLocation],
  );

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction > 0
          ? Math.floor(currentScale / ZOOM_STEP + 1e-4) * ZOOM_STEP + ZOOM_STEP
          : Math.ceil(currentScale / ZOOM_STEP - 1e-4) * ZOOM_STEP - ZOOM_STEP;
      applyZoom('custom', next);
    },
    [applyZoom, currentScale],
  );

  const applyDisplayMode = useCallback(
    (nextMode: PdfDisplayMode) => {
      if (nextMode === displayMode) return;
      pendingZoomTarget.current = currentReturnLocation();
      setDisplayMode(nextMode);
    },
    [currentReturnLocation, displayMode],
  );

  const rotateBy = useCallback(
    (degrees: 90 | -90) => {
      pendingZoomTarget.current = currentReturnLocation();
      setRotation((prev) => ((prev + degrees + 360) % 360) as PdfRotation);
    },
    [currentReturnLocation],
  );
  const rotateClockwise = useCallback(() => rotateBy(90), [rotateBy]);

  const handlePageAnnotationsLoaded = useCallback(
    (_pageIndex: number, loaded: PdfPageAnnotations) => {
      if (loaded.unsupportedSubtypes.length === 0) return;
      setUnsupportedSubtypes((prev) => {
        const merged = new Set([...prev, ...loaded.unsupportedSubtypes]);
        if (merged.size === prev.length) return prev;
        return [...merged].sort();
      });
    },
    [],
  );

  // Page heights are computed rather than measured, so a change must be pushed in
  // before anything below reads an offset.
  const anchoredWidth = useRef(contentWidth);
  useLayoutEffect(() => {
    virtualizer.measure();
    const widthChanged = anchoredWidth.current !== contentWidth;
    anchoredWidth.current = contentWidth;
    const target =
      pendingZoomTarget.current ?? (widthChanged && restored.current ? layoutAnchor.current : null);
    if (target) {
      pendingZoomTarget.current = null;
      const nextTop = offsetWithin(target.pageIndex, target.fraction);
      lastScrollTop.current = nextTop;
      setCurrentPageIndex(target.pageIndex);
      virtualizer.scrollToOffset(nextTop);
    }
  }, [
    virtualizer,
    sizes,
    contentWidth,
    availableHeight,
    zoomMode,
    customScale,
    displayMode,
    rotation,
    offsetWithin,
  ]);

  useLayoutEffect(() => {
    if (restored.current || !initialCursor || width === 0) return;
    const pageIndex = initialCursor.pageIndex;
    if (pageIndex >= engine.pageCount) {
      restored.current = true;
      return;
    }
    if (sizes.length <= pageIndex) return;
    setCurrentPageIndex(pageIndex);
    const nextTop = offsetWithin(pageIndex, initialCursor.rects[0]?.y ?? 0);
    virtualizer.scrollToOffset(nextTop);
    lastScrollTop.current = scrollRef.current?.scrollTop ?? nextTop;
    restored.current = true;
  }, [engine, initialCursor, offsetWithin, sizes, virtualizer, width]);

  // ---- Reporting the reading position --------------------------------------

  const navigateToPage = useCallback(
    (targetPageIndex: number, targetFraction = 0) => {
      if (targetPageIndex < 0 || targetPageIndex >= engine.pageCount) return;
      const previous = currentReturnLocation();
      if (
        previous.pageIndex !== targetPageIndex ||
        Math.abs(previous.fraction - targetFraction) > 0.05
      ) {
        pushHistory(previous);
      }
      scrollToPageOffset(targetPageIndex, offsetWithin(targetPageIndex, targetFraction));
    },
    [pushHistory, engine.pageCount, currentReturnLocation, offsetWithin, scrollToPageOffset],
  );

  const navigateToInternalLink = useCallback(
    (link: PdfInternalLink) => {
      navigateToPage(link.targetPageIndex, 0);
    },
    [navigateToPage],
  );

  const handleReturnBack = () => {
    const target = history.goBack(currentReturnLocation());
    if (target)
      scrollToPageOffset(target.pageIndex, offsetWithin(target.pageIndex, target.fraction));
  };

  const handleForward = () => {
    const target = history.goForward(currentReturnLocation());
    if (target)
      scrollToPageOffset(target.pageIndex, offsetWithin(target.pageIndex, target.fraction));
  };

  const navigateToBookmark = useCallback(
    (bookmark: Bookmark) => {
      const pdfAnchor = asPdfAnchor(bookmark.anchor);
      if (!pdfAnchor || pdfAnchor.pageIndex < 0 || pdfAnchor.pageIndex >= engine.pageCount) {
        setMissedJump(true);
        return;
      }
      setMissedJump(false);
      const targetFraction = pdfAnchor.rects[0]?.y ?? 0;
      const previous = currentReturnLocation();
      if (
        previous.pageIndex !== pdfAnchor.pageIndex ||
        Math.abs(previous.fraction - targetFraction) > 0.02
      ) {
        pushHistory(previous);
      }
      scrollToPageOffset(pdfAnchor.pageIndex, offsetWithin(pdfAnchor.pageIndex, targetFraction));
    },
    [pushHistory, currentReturnLocation, engine.pageCount, offsetWithin, scrollToPageOffset],
  );

  const bookmarksController = useBookmarksController<'pdf'>({
    documentId,
    bookmarks,
    onAddBookmark,
    onRemoveBookmark,
    getCurrentLocation: () => {
      const loc = currentReturnLocation();
      const y = Math.round(loc.fraction * 1e4) / 1e4;
      return {
        anchor: {
          format: 'pdf',
          pageIndex: loc.pageIndex,
          rects: [{ x: 0, y, width: 1, height: CURSOR_RECT_HEIGHT }],
        },
        label: `Page ${loc.pageIndex + 1}`,
      };
    },
    isActiveBookmark: (bookmark) => {
      const pdfAnchor = asPdfAnchor(bookmark.anchor);
      return pdfAnchor !== null && pdfAnchor.pageIndex === currentPageIndex;
    },
    isStaleBookmark: (bookmark) => {
      const pdfAnchor = asPdfAnchor(bookmark.anchor);
      return (
        pdfAnchor === null || pdfAnchor.pageIndex < 0 || pdfAnchor.pageIndex >= engine.pageCount
      );
    },
    onSelectBookmark: navigateToBookmark,
  });

  const submitPageInput = () => {
    const trimmed = pageInput.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed < 1 || parsed > engine.pageCount) {
      setPageInputInvalid(true);
      return;
    }
    setPageInputInvalid(false);
    navigateToPage(parsed - 1);
  };

  const reportCursor = useCallback(() => {
    if (!restored.current) return;
    const loc = currentReturnLocation();
    const y = Math.round(loc.fraction * 1e4) / 1e4;
    const key = `${loc.pageIndex}:${y}`;
    if (key === lastReported.current) return;
    lastReported.current = key;
    onCursorChange({
      format: 'pdf',
      pageIndex: loc.pageIndex,
      rects: [{ x: 0, y, width: 1, height: CURSOR_RECT_HEIGHT }],
    });
  }, [currentReturnLocation, onCursorChange]);

  const pendingCursor = useRef<number | null>(null);
  const reportCursorRef = useRef(reportCursor);
  useEffect(() => {
    reportCursorRef.current = reportCursor;
  }, [reportCursor]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    lastScrollTop.current = nextScrollTop;
    const isProgrammatic =
      programmaticScrollRef.current !== null &&
      Math.abs(nextScrollTop - programmaticScrollRef.current.scrollTop) <= 2;
    // A programmatic scroll already recorded its exact target.
    if (!isProgrammatic) layoutAnchor.current = currentReturnLocation();
    if (
      programmaticScrollRef.current &&
      Math.abs(nextScrollTop - programmaticScrollRef.current.scrollTop) <= 2
    ) {
      if (programmaticScrollRef.current.pageIndex !== currentPageIndex) {
        setCurrentPageIndex(programmaticScrollRef.current.pageIndex);
      }
    } else {
      programmaticScrollRef.current = null;
      if (displayMode !== 'single') {
        const item = virtualizer.getVirtualItemForOffset(nextScrollTop);
        if (item) {
          const pages = pagesInRow(item.index);
          const firstPage = pages[0];
          if (firstPage !== undefined && !pages.includes(currentPageIndex)) {
            setCurrentPageIndex(firstPage);
          }
        }
      }
    }
    if (pendingCursor.current !== null) window.clearTimeout(pendingCursor.current);
    pendingCursor.current = window.setTimeout(() => {
      pendingCursor.current = null;
      reportCursor();
    }, CURSOR_DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (pendingCursor.current === null) return;
      window.clearTimeout(pendingCursor.current);
      reportCursorRef.current();
    },
    [],
  );

  // ---- Jumping -------------------------------------------------------------

  const jumpAnchor = asPdfAnchor(jumpRequest?.anchor);
  const jumpNonce = jumpRequest?.nonce ?? null;
  const jumpExists = jumpAnchor !== null && jumpAnchor.pageIndex < engine.pageCount;
  const jumpReady = jumpExists && sizes.length > jumpAnchor.pageIndex && width > 0;
  const [searchPulsing, setSearchPulsing] = useState(false);
  const searchPulseTimerRef = useRef<number | null>(null);
  const [annotationPulsingId, setAnnotationPulsingId] = useState<string | null>(null);
  const annotationPulseTimerRef = useRef<number | null>(null);

  const navigateToAnnotation = useCallback(
    (annotation: Annotation) => {
      const pdfAnchor = asPdfAnchor(annotation.anchor);
      if (!pdfAnchor || pdfAnchor.pageIndex < 0 || pdfAnchor.pageIndex >= engine.pageCount) {
        setMissedJump(true);
        return;
      }
      setMissedJump(false);
      const targetFraction = pdfAnchor.rects[0]?.y ?? 0;
      const previous = currentReturnLocation();
      if (
        previous.pageIndex !== pdfAnchor.pageIndex ||
        Math.abs(previous.fraction - targetFraction) > 0.02
      ) {
        pushHistory(previous);
      }
      const pageStart = offsetWithin(pdfAnchor.pageIndex, 0);
      const top = offsetWithin(pdfAnchor.pageIndex, targetFraction);
      const currentViewportHeight = scrollRef.current?.clientHeight ?? 0;
      scrollToPageOffset(pdfAnchor.pageIndex, Math.max(top - currentViewportHeight / 3, pageStart));
      if (annotationPulseTimerRef.current !== null)
        window.clearTimeout(annotationPulseTimerRef.current);
      setAnnotationPulsingId(annotation.id);
      annotationPulseTimerRef.current = window.setTimeout(() => {
        annotationPulseTimerRef.current = null;
        setAnnotationPulsingId(null);
      }, PULSE_MS);
    },
    [pushHistory, currentReturnLocation, engine.pageCount, offsetWithin, scrollToPageOffset],
  );

  const clearSelectionAfterAnnotate = useCallback(() => {
    scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    hasSelection.current = false;
    setPinnedPages([]);
    setActiveSelection(null);
    setCapture(null);
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
      const pdfAnchor = asPdfAnchor(annotation.anchor);
      if (!pdfAnchor) return true;
      if (pdfAnchor.pageSpans && pdfAnchor.pageSpans.length > 0) {
        return pdfAnchor.pageSpans.some(
          (span) => span.pageIndex < 0 || span.pageIndex >= engine.pageCount,
        );
      }
      return pdfAnchor.pageIndex < 0 || pdfAnchor.pageIndex >= engine.pageCount;
    },
    onSelectAnnotation: navigateToAnnotation,
  });

  const navigateToSearchMatch = useCallback(
    (match: PdfSearchMatch) => {
      const previous = currentReturnLocation();
      const targetFraction = match.rects[0]?.y ?? 0;
      if (
        previous.pageIndex !== match.pageIndex ||
        Math.abs(previous.fraction - targetFraction) > 0.02
      ) {
        pushHistory(previous);
      }
      const pageStart = offsetWithin(match.pageIndex, 0);
      const top = offsetWithin(match.pageIndex, targetFraction);
      const currentViewportHeight = scrollRef.current?.clientHeight ?? 0;
      scrollToPageOffset(match.pageIndex, Math.max(top - currentViewportHeight / 3, pageStart));
      if (searchPulseTimerRef.current !== null) window.clearTimeout(searchPulseTimerRef.current);
      setSearchPulsing(true);
      searchPulseTimerRef.current = window.setTimeout(() => {
        searchPulseTimerRef.current = null;
        setSearchPulsing(false);
      }, PULSE_MS);
    },
    [pushHistory, currentReturnLocation, offsetWithin, scrollToPageOffset],
  );

  useEffect(
    () => () => {
      if (searchPulseTimerRef.current !== null) window.clearTimeout(searchPulseTimerRef.current);
      if (annotationPulseTimerRef.current !== null)
        window.clearTimeout(annotationPulseTimerRef.current);
    },
    [],
  );

  const runPdfSearch = useCallback(
    async (
      query: string,
      caseSensitive: boolean,
      signal: AbortSignal,
      onProgress: (matchesSoFar: readonly PdfSearchMatch[]) => void,
    ): Promise<readonly PdfSearchMatch[]> => {
      if (!engine.getPageText) return [];
      const matches: PdfSearchMatch[] = [];
      for (let pageIndex = 0; pageIndex < engine.pageCount; pageIndex += 1) {
        if (signal.aborted) return [];
        const pageText = await engine.getPageText(pageIndex);
        if (signal.aborted) return [];
        const pageMatches = searchPdfPage(pageText, query, caseSensitive);
        if (pageMatches.length > 0) {
          matches.push(...pageMatches);
          onProgress([...matches]);
        }
      }
      return matches;
    },
    [engine],
  );

  const search = useDocumentSearch<PdfSearchMatch>({
    isActive,
    runSearch: runPdfSearch,
    onNavigateToMatch: navigateToSearchMatch,
  });

  const activeSearchMatch = search.activeMatch;
  const effectiveHighlights = useMemo(() => {
    if (annotations !== undefined) return highlights;
    const localHighlights: ReaderHighlight[] = annotationsController.annotations.map(
      ({ id, anchor, color }) => ({
        annotationId: id,
        anchor,
        color,
      }),
    );
    return [...highlights, ...localHighlights];
  }, [annotations, annotationsController.annotations, highlights]);

  const pulsingAnnotationId = jumpReady
    ? (jumpRequest?.annotationId ?? null)
    : annotationPulsingId
      ? annotationPulsingId
      : searchPulsing && activeSearchMatch
        ? SEARCH_HIGHLIGHT_ID
        : null;

  const viewportHeight = scrollRef.current?.clientHeight;
  const lastHandledJumpNonce = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!jumpReady || !jumpAnchor || jumpNonce === null) return;
    if (lastHandledJumpNonce.current !== jumpNonce) {
      lastHandledJumpNonce.current = jumpNonce;
      const previous = currentReturnLocation();
      const targetFraction = jumpAnchor.rects[0]?.y ?? 0;
      if (
        previous.pageIndex !== jumpAnchor.pageIndex ||
        Math.abs(previous.fraction - targetFraction) > 0.02
      ) {
        pushHistory(previous);
      }
    }
    setCurrentPageIndex(jumpAnchor.pageIndex);
    const top = offsetWithin(jumpAnchor.pageIndex, jumpAnchor.rects[0]?.y ?? 0);
    virtualizer.scrollToOffset(Math.max(top - (viewportHeight ?? 0) / 3, 0));
    // Only a new jump, or the layout it depends on, should move the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce, jumpReady, contentWidth]);

  useEffect(() => {
    if (jumpNonce === null) return;
    if (jumpExists) {
      if (!jumpReady) return;
      const timer = window.setTimeout(() => onJumpHandled(jumpNonce), PULSE_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setMissedJump(true);
      onJumpHandled(jumpNonce);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [jumpNonce, jumpExists, jumpReady, onJumpHandled]);

  // ---- Commands -----------------------------------------------------------

  const stepPage = (direction: 1 | -1) => {
    const currentPage =
      displayMode === 'single'
        ? currentPageIndex
        : (pagesInRow(virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? 0)[0] ??
          currentPageIndex);
    const target = currentPage + direction;
    if (target < 0 || target >= engine.pageCount) return;
    scrollToPageOffset(target, offsetWithin(target, 0));
  };

  const goToPage = () => {
    const input = pageInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  };

  // Entering focus mode puts the panels away; leaving it does not reopen them.
  const [wasChromeHidden, setWasChromeHidden] = useState(chromeHidden);
  if (wasChromeHidden !== chromeHidden) {
    setWasChromeHidden(chromeHidden);
  }

  const showSidebar = navigator.open && !chromeHidden;
  const canZoomIn = currentScale < MAX_ZOOM_SCALE - 1e-4;
  const canZoomOut = currentScale > MIN_ZOOM_SCALE + 1e-4;

  useReaderCommands({
    isActive,
    chromeHidden,
    search,
    navigator,
    bookmarks: bookmarksController,
    annotations: annotationsController,
    selectionText: activeSelection?.text ?? null,
    markup,
    extra: {
      'view.layoutSingle': { run: () => applyDisplayMode('single') },
      'view.layoutTwoPage': { run: () => applyDisplayMode('two-page') },
      'view.layoutScroll': { run: () => applyDisplayMode('continuous') },
      'view.zoomIn': { run: () => stepZoom(1), enabled: canZoomIn },
      'view.zoomOut': { run: () => stepZoom(-1), enabled: canZoomOut },
      'view.actualSize': { run: () => applyZoom('actual-size') },
      'view.zoomToFit': { run: () => applyZoom('fit-page') },
      'view.zoomToWidth': { run: () => applyZoom('fit-width') },
      'view.rotateLeft': { run: () => rotateBy(-90) },
      'view.rotateRight': { run: () => rotateBy(90) },
      'go.previousPage': { run: () => stepPage(-1) },
      'go.nextPage': { run: () => stepPage(1) },
      'go.page': { run: goToPage },
      'go.back': { run: handleReturnBack, enabled: history.canGoBack },
      'go.forward': { run: handleForward, enabled: history.canGoForward },
    },
  });

  // ---- Rendering -----------------------------------------------------------

  const byPage = useMemo(() => {
    const pages = new Map<number, ReaderHighlight[]>();
    const addPageHighlight = (
      pageIndex: number,
      annotationId: string,
      rects: NormalizedRect[],
      color: string,
    ) => {
      pages.set(pageIndex, [
        ...(pages.get(pageIndex) ?? []),
        {
          annotationId,
          anchor: { format: 'pdf', pageIndex, rects },
          color,
        },
      ]);
    };
    for (const highlight of effectiveHighlights) {
      const anchor = asPdfAnchor(highlight.anchor);
      if (!anchor) continue;
      if (anchor.pageSpans && anchor.pageSpans.length > 0) {
        for (const span of anchor.pageSpans) {
          addPageHighlight(span.pageIndex, highlight.annotationId, span.rects, highlight.color);
        }
      } else {
        addPageHighlight(anchor.pageIndex, highlight.annotationId, anchor.rects, highlight.color);
      }
    }
    if (activeSearchMatch) {
      addPageHighlight(
        activeSearchMatch.pageIndex,
        SEARCH_HIGHLIGHT_ID,
        [...activeSearchMatch.rects],
        SEARCH_HIGHLIGHT_COLOR,
      );
    }
    return pages;
  }, [effectiveHighlights, activeSearchMatch]);

  const virtualItems = virtualizer.getVirtualItems();
  const maxRowWidth = virtualItems.reduce(
    (max, item) => Math.max(max, rowWidth(item.index)),
    rowWidth(rowOfPage(currentPageIndex)),
  );
  const innerMinWidth =
    width > 0 && maxRowWidth > contentWidth + 1
      ? `${Math.ceil(maxRowWidth + SIDE_PADDING_PX * 2)}px`
      : '100%';

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden"
      data-testid="pdf-viewer"
      data-pdf-worker={engine.usesRealWorker ? 'worker' : 'main-thread'}
      data-zoom-mode={zoomMode}
      data-display-mode={displayMode}
      data-rotation={rotation}
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
              disabled={chromeHidden}
              onClick={navigator.toggle}
            />
            <SegmentedControl
              label="Display mode"
              options={DISPLAY_MODES}
              value={displayMode}
              onChange={applyDisplayMode}
            />
            <HistoryButtons
              canGoBack={history.canGoBack}
              canGoForward={history.canGoForward}
              onBack={handleReturnBack}
              onForward={handleForward}
            />
          </>
        }
        center={
          <div className="flex min-w-0 flex-col items-center leading-tight">
            <span
              data-testid="reader-toolbar-title"
              className="max-w-full truncate text-xs font-semibold"
            >
              {document.title}
            </span>
            <form
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
              onSubmit={(event) => {
                event.preventDefault();
                submitPageInput();
              }}
            >
              <label htmlFor={`pdf-page-input-${documentId}`}>Page</label>
              <input
                ref={pageInputRef}
                id={`pdf-page-input-${documentId}`}
                type="text"
                inputMode="numeric"
                aria-label="Page number"
                aria-invalid={pageInputInvalid}
                value={pageInput}
                onChange={(event) => {
                  setPageInput(event.target.value);
                  if (pageInputInvalid) setPageInputInvalid(false);
                }}
                onBlur={() => {
                  if (pageInputInvalid) {
                    setPageInput(String(currentPageIndex + 1));
                    setPageInputInvalid(false);
                  }
                }}
                className={cn(
                  'h-4.5 w-9 rounded border bg-background px-1 text-center text-[11px] text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  pageInputInvalid && 'border-destructive text-destructive',
                )}
              />
              <span data-testid="pdf-page-count" className="tabular-nums">
                of {engine.pageCount}
              </span>
            </form>
          </div>
        }
        trailing={
          <>
            <div role="group" aria-label="Zoom controls" className="flex items-center gap-0.5">
              <ToolbarButton
                icon={MoveHorizontal}
                label="Fit width"
                command="view.zoomToWidth"
                pressed={zoomMode === 'fit-width'}
                collapse="xl"
                onClick={() => applyZoom('fit-width')}
              />
              <ToolbarButton
                icon={Expand}
                label="Fit page"
                command="view.zoomToFit"
                pressed={zoomMode === 'fit-page'}
                collapse="xl"
                onClick={() => applyZoom('fit-page')}
              />
              <ToolbarButton
                icon={Scan}
                label="Actual size"
                command="view.actualSize"
                pressed={zoomMode === 'actual-size'}
                collapse="xl"
                onClick={() => applyZoom('actual-size')}
              />
              <ToolbarButton
                icon={ZoomOut}
                label="Zoom out"
                command="view.zoomOut"
                disabled={!canZoomOut}
                onClick={() => stepZoom(-1)}
              />
              <span
                data-testid="pdf-zoom-level"
                className="min-w-9 text-center text-xs text-foreground tabular-nums"
              >
                {zoomPercent}%
              </span>
              <ToolbarButton
                icon={ZoomIn}
                label="Zoom in"
                command="view.zoomIn"
                disabled={!canZoomIn}
                onClick={() => stepZoom(1)}
              />
            </div>
            <ToolbarButton
              icon={RotateCcw}
              label="Rotate counterclockwise"
              command="view.rotateLeft"
              collapse="lg"
              onClick={() => rotateBy(-90)}
            />
            <ToolbarButton
              icon={RotateCw}
              label="Rotate clockwise"
              command="view.rotateRight"
              testId="pdf-rotate-button"
              collapse="lg"
              onClick={rotateClockwise}
            />
            <ToolbarSeparator />
            <ToolbarButton
              icon={Crop}
              label="Capture area"
              pressed={captureMode}
              onClick={toggleCaptureMode}
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
            <ToolbarOverflowMenu
              items={[
                {
                  label: 'Fit width',
                  collapse: 'xl',
                  pressed: zoomMode === 'fit-width',
                  onSelect: () => applyZoom('fit-width'),
                },
                {
                  label: 'Fit page',
                  collapse: 'xl',
                  pressed: zoomMode === 'fit-page',
                  onSelect: () => applyZoom('fit-page'),
                },
                {
                  label: 'Actual size',
                  collapse: 'xl',
                  pressed: zoomMode === 'actual-size',
                  onSelect: () => applyZoom('actual-size'),
                },
                { label: 'Rotate counterclockwise', collapse: 'lg', onSelect: () => rotateBy(-90) },
                { label: 'Rotate clockwise', collapse: 'lg', onSelect: rotateClockwise },
              ]}
            />
            <ToolbarSearchField
              search={search}
              onReturnFocus={() => scrollRef.current?.focus({ preventScroll: true })}
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
              items: outlineNodes,
              currentId: currentOutlineId(outlineNodes, currentPageIndex),
              emptyMessage: 'No outline in this document.',
              onSelect: (pageIndex: number) => navigateToPage(pageIndex),
            }}
            renderThumbnails={(filter) => (
              <PdfThumbnailsList
                engine={engine}
                sizes={sizes}
                rotation={rotation}
                currentPageIndex={currentPageIndex}
                filter={filter}
                onSelectPage={(pageIndex) => navigateToPage(pageIndex)}
              />
            )}
            annotationPlacement={(annotation): AnnotationPlacement => {
              const anchor = asPdfAnchor(annotation.anchor);
              if (!anchor) return { order: Number.MAX_SAFE_INTEGER };
              return {
                group:
                  chapterOfPage(outlineNodes, anchor.pageIndex) ?? `Page ${anchor.pageIndex + 1}`,
                order: anchor.pageIndex + (anchor.rects[0]?.y ?? 0),
              };
            }}
          />
        )}
        {/* Notices float over the page column only, never over the sidebar. */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ReaderPopoverLayer>
            <SelectionNoteComposer
              hasSelection={activeSelection !== null}
              controller={annotationsController}
            />
            {unsupportedSubtypes.length > 0 && !chromeHidden && (
              <p
                role="status"
                data-testid="pdf-unsupported-annotations-notice"
                className="bg-muted px-4 py-1 text-xs text-muted-foreground"
              >
                Unsupported PDF annotation types not shown: {unsupportedSubtypes.join(', ')}. Source
                PDF is never modified.
              </p>
            )}
            {missedJump && (
              <p role="status" className="bg-muted px-4 py-1.5 text-xs">
                That excerpt is on a page this file does not have. The file may have changed.
              </p>
            )}
          </ReaderPopoverLayer>
          {/*
            The scrollbar is always present. If it appeared once page sizes loaded, the pane
            would narrow, every page would re-render at a new scale, and that destroys any
            selection already made.
          */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            tabIndex={-1}
            data-testid="pdf-scroll"
            className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-scroll bg-muted outline-none"
          >
            <div
              className="relative"
              style={{
                width: innerMinWidth,
                height: virtualizer.getTotalSize(),
              }}
            >
              {width > 0 &&
                virtualItems.map((item) => {
                  const pages = pagesInRow(item.index);
                  const itemWidth = rowWidth(item.index);
                  const itemHeight = rowHeight(item.index);
                  const itemLeft = Math.max(SIDE_PADDING_PX, (width - itemWidth) / 2);
                  return (
                    <div
                      key={`${displayMode}-${item.key}`}
                      className="absolute flex items-start"
                      style={{
                        top: 0,
                        left: itemLeft,
                        width: itemWidth,
                        height: itemHeight,
                        gap: PAGE_GAP_PX,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      {pages.map((pageIndex) => (
                        <div
                          key={pageIndex}
                          style={{
                            width: pageWidth(pageIndex),
                            height: pageHeight(pageIndex),
                          }}
                        >
                          <PdfPage
                            engine={engine}
                            pageIndex={pageIndex}
                            scale={scaleOf(pageIndex)}
                            rotation={rotation}
                            highlights={byPage.get(pageIndex) ?? EMPTY_HIGHLIGHTS}
                            pulsingAnnotationId={pulsingAnnotationId}
                            captureMode={captureMode}
                            captureBox={
                              visibleCapture?.pageIndex === pageIndex ? visibleCapture.rect : null
                            }
                            onCapture={(canvas, rect) => onCapture(pageIndex, canvas, rect)}
                            onNavigateLink={navigateToInternalLink}
                            onPageAnnotationsLoaded={handlePageAnnotationsLoaded}
                          />
                        </div>
                      ))}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const EMPTY_HIGHLIGHTS: readonly ReaderHighlight[] = [];

/** PDF reader: canvas and text layer from pdf.js, virtualized by page. */
export function PdfViewer({ content, ...props }: DocumentViewerProps<'pdf'>) {
  const { document } = props;
  const [opened, setOpened] = useState<{
    engine: PdfDocumentHandle | null;
    error: string | null;
  }>({ engine: null, error: null });

  useEffect(() => {
    let cancelled = false;
    let engine: PdfDocumentHandle | null = null;
    content
      .loadDocumentSource(document)
      .then(openPdfDocument)
      .then((handle) => {
        if (cancelled) handle.destroy();
        else {
          engine = handle;
          setOpened({ engine: handle, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setOpened({ engine: null, error: describeError(error) });
      });
    return () => {
      cancelled = true;
      engine?.destroy();
    };
    // Only the file matters: `document` changes each time the cursor is reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, document.id]);

  if (opened.error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not open {document.title}: {opened.error}
      </div>
    );
  }
  if (!opened.engine) {
    return <div className="p-6 text-sm text-muted-foreground">Opening {document.title}…</div>;
  }
  return <PdfPages engine={opened.engine} {...props} />;
}
