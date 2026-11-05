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

import { describeError, cn } from '@/lib/utils';
import type {
  DocumentContentReader,
  DocumentViewerProps,
  ReaderHighlight,
  TxtAnchor,
} from '@/types/domain';

import { UNIT_ATTRIBUTE, unitAtBoundary } from './selectionMapping';
import { TxtTextModel } from './textModel';

export const PULSE_MS = 1200;
export const ROW_ESTIMATE_PX = 26;
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
      .readTextStream(documentId, encoding, (chunk) => {
        if (cancelled) return;
        model.append(chunk);
        const now = performance.now();
        if (chunk.isLast || now - lastPublish >= PUBLISH_INTERVAL_MS) {
          lastPublish = now;
          publish(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) publish(describeError(error));
      });
    return () => {
      cancelled = true;
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
}: DocumentViewerProps<'txt'>) {
  const load = useTextStream(content, document.id, document.encoding);
  const { model, rowCount, complete } = load;
  const documentId = document.id;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Rows holding the selection's ends stay rendered: if the browser's selection
  // endpoints left the DOM, scrolling away would silently destroy the selection.
  const [pinnedRows, setPinnedRows] = useState<readonly number[]>([]);
  const [missedJump, setMissedJump] = useState(false);

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
      return;
    }

    const clear = () => {
      if (!hasSelection.current) return;
      hasSelection.current = false;
      setPinnedRows([]);
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
      onSelectionChange({
        documentId,
        anchor: selected.anchor,
        text: selected.text,
        imagePath: null,
      });
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
  const pulsingAnnotationId = jumpResolved ? (jumpRequest?.annotationId ?? null) : null;

  useLayoutEffect(() => {
    if (jumpRow !== null) virtualizer.scrollToIndex(jumpRow, { align: 'center' });
  }, [jumpNonce, jumpRow, virtualizer]);

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
    const painted = paint(model, highlights);
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
    return painted;
    // `rowCount` and `complete` stand in for the mutable model's loaded length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    model,
    rowCount,
    complete,
    highlights,
    jumpRequest,
    jumpRange?.startUnit,
    jumpRange?.endUnit,
  ]);

  if (load.error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not read {document.title}: {load.error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {(load.hadReplacements || missedJump) && (
        <p role="status" className="shrink-0 border-b bg-muted px-4 py-1.5 text-xs">
          {missedJump
            ? 'That excerpt is past the end of this file, which may have changed since it was saved.'
            : 'This file has bytes that are not valid UTF-8. They are shown as �.'}
        </p>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="txt-scroll"
        className="min-h-0 flex-1 overflow-auto"
      >
        <div
          role="document"
          aria-label={document.title}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 min-h-[1lh] w-full px-6 text-base leading-relaxed break-words whitespace-pre-wrap"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TxtRow
                segments={segmentRow(model.rowStart(item.index), model.rowText(item.index), ranges)}
                pulsingAnnotationId={pulsingAnnotationId}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
