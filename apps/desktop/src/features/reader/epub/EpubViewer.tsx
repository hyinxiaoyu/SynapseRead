import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { PULSE_MS } from '@/features/reader/pulse';
import { describeError } from '@/lib/utils';
import type { DocumentViewerProps, EpubAnchor } from '@/types/domain';

import { type EpubHandle, type EpubLocation, openEpubDocument } from './epubEngine';

const CURSOR_DEBOUNCE_MS = 400;
const FALLBACK_HIGHLIGHT = '#fde047';
/** Marks are drawn just after a chapter displays, so a pulse waits for them this long. */
const MARK_WAIT_MS = 2000;
const MARK_POLL_MS = 50;

const asEpubAnchor = (anchor: { format: string } | null | undefined): EpubAnchor | null =>
  anchor?.format === 'epub' ? (anchor as EpubAnchor) : null;

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
}: DocumentViewerProps<'epub'>) {
  const documentId = document.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<EpubHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missedJump, setMissedJump] = useState(false);

  // Taken once: the store feeds every cursor report back through this prop.
  const [initialCursor] = useState(() => asEpubAnchor(document.lastCursorAnchor));
  const [initialJump] = useState(jumpRequest);

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
        const engine = await openEpubDocument(source, host);
        if (cancelled) {
          engine.destroy();
          return;
        }
        opened = engine;

        let hasSelection = false;
        engine.onSelection((selection) => {
          if (!latest.current.isActive) return;
          if (!selection) {
            if (hasSelection) latest.current.onSelectionChange(null);
            hasSelection = false;
            return;
          }
          hasSelection = true;
          latest.current.onSelectionChange({
            documentId,
            anchor: {
              format: 'epub',
              cfiRange: selection.cfiRange,
              chapterHref: selection.chapterHref,
            },
            text: selection.text,
            imagePng: null,
          });
        });
        engine.onLocation((location) => {
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

  const painted = useRef(new Map<string, string>());
  useEffect(() => {
    if (!handle) return;
    const wanted = new Map<string, { cfiRange: string; color: string }>();
    for (const { annotationId, anchor, color } of highlights) {
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

    for (const [annotationId, cfiRange] of painted.current) {
      if (!wanted.has(annotationId)) {
        handle.removeHighlight(cfiRange);
        painted.current.delete(annotationId);
      }
    }
    for (const [annotationId, { cfiRange, color }] of wanted) {
      if (!painted.current.has(annotationId)) {
        handle.highlight(annotationId, cfiRange, color);
        painted.current.set(annotationId, cfiRange);
      }
    }
  }, [handle, highlights, jumpRequest]);

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
      try {
        if (!anchor) throw new Error('not an EPUB anchor');
        await handle.display(anchor.cfiRange);
      } catch {
        finish(false);
        return;
      }
      if (cancelled) return;
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

  // ---- Tab and pane changes ------------------------------------------------

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
  }, [handle]);

  if (error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not open {document.title}: {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="epub-viewer">
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b px-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={!handle}
          onClick={() => void handle?.previous()}
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button variant="ghost" size="sm" disabled={!handle} onClick={() => void handle?.next()}>
          Next
          <ChevronRight />
        </Button>
      </div>
      {missedJump && (
        <p role="status" className="shrink-0 border-b bg-muted px-4 py-1.5 text-xs">
          That excerpt could not be found in this book. The file may have changed.
        </p>
      )}
      <div ref={hostRef} data-testid="epub-host" className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
