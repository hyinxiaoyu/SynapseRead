import { useVirtualizer } from '@tanstack/react-virtual';
import { Crop } from 'lucide-react';
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

import { Button } from '@/components/ui/button';
import { PULSE_MS } from '@/features/reader/pulse';
import { cn, describeError } from '@/lib/utils';
import type {
  DocumentViewerProps,
  NormalizedRect,
  PdfAnchor,
  ReaderHighlight,
} from '@/types/domain';

import {
  type Cancellable,
  cropCanvasToPng,
  openPdfDocument,
  type PageSize,
  type PdfDocumentHandle,
} from './pdfEngine';
import { mergeLineRects, normalizeBoxes } from './pdfGeometry';

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

const asPdfAnchor = (anchor: { format: string } | null | undefined): PdfAnchor | null =>
  anchor?.format === 'pdf' ? (anchor as PdfAnchor) : null;

/** Follows an element's width, settling first so a dragged pane does not re-render pages. */
function useSettledWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: number | undefined;
    const initial = window.setTimeout(() => setWidth(element.clientWidth), 0);
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(element.clientWidth), 150);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(initial);
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref]);
  return width;
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

function PdfPage({
  engine,
  pageIndex,
  scale,
  highlights,
  pulsingAnnotationId,
  captureMode,
  captureBox,
  onCapture,
}: {
  engine: PdfDocumentHandle;
  pageIndex: number;
  scale: number;
  highlights: readonly ReaderHighlight[];
  pulsingAnnotationId: string | null;
  captureMode: boolean;
  captureBox: NormalizedRect | null;
  onCapture: (canvas: HTMLCanvasElement, rect: NormalizedRect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCancellable(() => engine.renderPage(pageIndex, canvas, scale));
  }, [engine, pageIndex, scale]);

  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    return runCancellable(() => engine.renderTextLayer(pageIndex, layer, scale));
  }, [engine, pageIndex, scale]);

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

  return (
    <div
      data-page-index={pageIndex}
      className="pdf-page relative bg-white shadow"
      style={{ '--scale-factor': scale, width: '100%', height: '100%' } as CSSProperties}
    >
      <canvas ref={canvasRef} className="block size-full" />

      {highlights.map(({ annotationId, anchor, color }) =>
        asPdfAnchor(anchor)?.rects.map((rect, index) => (
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
        )),
      )}

      <div ref={textLayerRef} data-testid="pdf-text-layer" className="textLayer" />

      {captureBox && (
        <div
          data-testid="pdf-capture-box"
          className="pointer-events-none absolute border-2 border-primary"
          style={{
            left: `${captureBox.x * 100}%`,
            top: `${captureBox.y * 100}%`,
            width: `${captureBox.width * 100}%`,
            height: `${captureBox.height * 100}%`,
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

  const rects = mergeLineRects(normalizeBoxes(boxes, box));
  const cleaned = text.replace(/\n{2,}/g, '\n').trim();
  return rects.length > 0 && cleaned ? { rects, text: cleaned } : null;
}

function PdfPages({
  engine,
  document,
  isActive,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
  onCursorChange,
}: { engine: PdfDocumentHandle } & Omit<DocumentViewerProps<'pdf'>, 'content'>) {
  const documentId = document.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useSettledWidth(scrollRef);
  const sizes = usePageSizes(engine);
  const contentWidth = Math.max(width - SIDE_PADDING_PX * 2, 1);

  const sizeOf = useCallback(
    (index: number) => sizes[index] ?? sizes[0] ?? DEFAULT_PAGE_SIZE,
    [sizes],
  );
  const scaleOf = useCallback(
    (index: number) => contentWidth / sizeOf(index).width,
    [contentWidth, sizeOf],
  );
  const pageHeight = useCallback(
    (index: number) => sizeOf(index).height * scaleOf(index),
    [sizeOf, scaleOf],
  );

  const [pinnedPage, setPinnedPage] = useState<number | null>(null);
  const [captureMode, setCaptureMode] = useState(false);
  const [capture, setCapture] = useState<(CaptureBox & { highlightCount: number }) | null>(null);
  const [missedJump, setMissedJump] = useState(false);

  // eslint-disable-next-line react-hooks/incompatible-library -- used only in this component, never memoized across renders.
  const virtualizer = useVirtualizer({
    count: engine.pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => pageHeight(index) + PAGE_GAP_PX,
    overscan: OVERSCAN_PAGES,
    rangeExtractor: (range) => {
      const pages = new Set<number>();
      for (
        let page = range.startIndex - range.overscan;
        page <= range.endIndex + range.overscan;
        page += 1
      ) {
        if (page >= 0 && page < range.count) pages.add(page);
      }
      if (pinnedPage !== null && pinnedPage < range.count) pages.add(pinnedPage);
      return [...pages].sort((a, b) => a - b);
    },
  });

  // Page heights are computed rather than measured, so a change must be pushed in
  // before anything below reads an offset.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, sizes, contentWidth]);

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
      return;
    }

    const clear = () => {
      if (!hasSelection.current) return;
      hasSelection.current = false;
      setPinnedPage(null);
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
      const startElement =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const pageElement = startElement?.closest<HTMLElement>('[data-page-index]');
      const selected = pageElement && readPageSelection(range, pageElement);
      if (!pageElement || !selected) {
        clear();
        return;
      }
      // `PdfAnchor` addresses one page, so a selection crossing pages keeps the first.
      const pageIndex = Number(pageElement.dataset.pageIndex);
      hasSelection.current = true;
      setCapture(null);
      setPinnedPage(pageIndex);
      onSelectionChange({
        documentId,
        anchor: { format: 'pdf', pageIndex, rects: selected.rects },
        text: selected.text,
        imagePng: null,
      });
    };
    view.addEventListener('selectionchange', onChange);
    return () => view.removeEventListener('selectionchange', onChange);
  }, [isActive, documentId, onSelectionChange, capture]);

  const onCapture = useCallback(
    (pageIndex: number, canvas: HTMLCanvasElement, rect: NormalizedRect) => {
      scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      hasSelection.current = true;
      setCapture({ pageIndex, rect, highlightCount: highlights.length });
      setCaptureMode(false);
      onSelectionChange({
        documentId,
        anchor: { format: 'pdf', pageIndex, rects: [rect] },
        text: null,
        imagePng: cropCanvasToPng(canvas, rect),
      });
    },
    [documentId, highlights.length, onSelectionChange],
  );

  const toggleCaptureMode = () => {
    if (!captureMode) scrollRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    if (capture) {
      setCapture(null);
      hasSelection.current = false;
      onSelectionChange(null);
    }
    setCaptureMode(!captureMode);
  };

  // Excerpting adds a highlight, which then replaces the box.
  const visibleCapture = capture?.highlightCount === highlights.length ? capture : null;

  // ---- Reopen at the last reading position ---------------------------------

  const [initialCursor] = useState(() => asPdfAnchor(document.lastCursorAnchor));
  const [initialJump] = useState(jumpRequest);
  const restored = useRef(initialCursor === null || initialJump !== null);
  const lastReported = useRef(
    initialCursor ? `${initialCursor.pageIndex}:${initialCursor.rects[0]?.y ?? 0}` : `0:0`,
  );

  const offsetWithin = useCallback(
    (pageIndex: number, fraction: number) => {
      const [start] = virtualizer.getOffsetForIndex(pageIndex, 'start') ?? [0];
      return start + fraction * pageHeight(pageIndex);
    },
    [virtualizer, pageHeight],
  );

  useLayoutEffect(() => {
    if (restored.current || !initialCursor || width === 0) return;
    const pageIndex = initialCursor.pageIndex;
    if (pageIndex >= engine.pageCount) {
      restored.current = true;
      return;
    }
    if (sizes.length <= pageIndex) return;
    virtualizer.scrollToOffset(offsetWithin(pageIndex, initialCursor.rects[0]?.y ?? 0));
    restored.current = true;
  }, [engine, initialCursor, offsetWithin, sizes, virtualizer, width]);

  // ---- Reporting the reading position --------------------------------------

  const lastScrollTop = useRef(0);
  const reportCursor = useCallback(() => {
    if (!restored.current) return;
    const item = virtualizer.getVirtualItemForOffset(lastScrollTop.current);
    if (!item) return;
    const height = pageHeight(item.index);
    const fraction = Math.min(Math.max((lastScrollTop.current - item.start) / height, 0), 0.99);
    const y = Math.round(fraction * 1e4) / 1e4;
    const key = `${item.index}:${y}`;
    if (key === lastReported.current) return;
    lastReported.current = key;
    onCursorChange({
      format: 'pdf',
      pageIndex: item.index,
      rects: [{ x: 0, y, width: 1, height: CURSOR_RECT_HEIGHT }],
    });
  }, [virtualizer, pageHeight, onCursorChange]);

  const pendingCursor = useRef<number | null>(null);
  const reportCursorRef = useRef(reportCursor);
  useEffect(() => {
    reportCursorRef.current = reportCursor;
  }, [reportCursor]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    lastScrollTop.current = event.currentTarget.scrollTop;
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

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
        if (
          target.closest(
            '[contenteditable="true"], [role="textbox"], [role="slider"], [role="separator"], [role="tablist"], .react-flow',
          )
        ) {
          return;
        }
      }
      const currentPage = virtualizer.getVirtualItemForOffset(lastScrollTop.current)?.index ?? 0;
      if (event.key === 'ArrowRight' && currentPage + 1 < engine.pageCount) {
        event.preventDefault();
        virtualizer.scrollToOffset(offsetWithin(currentPage + 1, 0));
      } else if (event.key === 'ArrowLeft' && currentPage > 0) {
        event.preventDefault();
        virtualizer.scrollToOffset(offsetWithin(currentPage - 1, 0));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, engine.pageCount, offsetWithin, virtualizer]);
  // ---- Jumping -------------------------------------------------------------

  const jumpAnchor = asPdfAnchor(jumpRequest?.anchor);
  const jumpNonce = jumpRequest?.nonce ?? null;
  const jumpExists = jumpAnchor !== null && jumpAnchor.pageIndex < engine.pageCount;
  const jumpReady = jumpExists && sizes.length > jumpAnchor.pageIndex && width > 0;
  const pulsingAnnotationId = jumpReady ? (jumpRequest?.annotationId ?? null) : null;

  const viewportHeight = scrollRef.current?.clientHeight;
  useLayoutEffect(() => {
    if (!jumpReady || !jumpAnchor) return;
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

  // ---- Rendering -----------------------------------------------------------

  const byPage = useMemo(() => {
    const pages = new Map<number, ReaderHighlight[]>();
    for (const highlight of highlights) {
      const anchor = asPdfAnchor(highlight.anchor);
      if (anchor) pages.set(anchor.pageIndex, [...(pages.get(anchor.pageIndex) ?? []), highlight]);
    }
    return pages;
  }, [highlights]);

  return (
    <div
      className="flex h-full flex-col"
      data-testid="pdf-viewer"
      data-pdf-worker={engine.usesRealWorker ? 'worker' : 'main-thread'}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs text-muted-foreground">
        <span>
          {engine.pageCount} {engine.pageCount === 1 ? 'page' : 'pages'}
        </span>
        <Button
          variant={captureMode ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={captureMode}
          onClick={toggleCaptureMode}
        >
          <Crop />
          Capture area
        </Button>
      </div>
      {missedJump && (
        <p role="status" className="shrink-0 border-b bg-muted px-4 py-1.5 text-xs">
          That excerpt is on a page this file does not have. The file may have changed.
        </p>
      )}
      {/*
        The scrollbar is always present. If it appeared once page sizes loaded, the pane
        would narrow, every page would re-render at a new scale, and that destroys any
        selection already made.
      */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="pdf-scroll"
        className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll bg-muted"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {width > 0 &&
            virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="absolute"
                style={{
                  top: 0,
                  left: SIDE_PADDING_PX,
                  width: contentWidth,
                  height: pageHeight(item.index),
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <PdfPage
                  engine={engine}
                  pageIndex={item.index}
                  scale={scaleOf(item.index)}
                  highlights={byPage.get(item.index) ?? EMPTY_HIGHLIGHTS}
                  pulsingAnnotationId={pulsingAnnotationId}
                  captureMode={captureMode}
                  captureBox={visibleCapture?.pageIndex === item.index ? visibleCapture.rect : null}
                  onCapture={(canvas, rect) => onCapture(item.index, canvas, rect)}
                />
              </div>
            ))}
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
