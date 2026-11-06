import { BookOpen, ChevronLeft, ChevronRight, FileText, ScrollText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { PULSE_MS } from '@/features/reader/pulse';
import { cn, describeError } from '@/lib/utils';
import type { DocumentViewerProps, EpubAnchor } from '@/types/domain';

import {
  type EpubHandle,
  type EpubLocation,
  type EpubReadingMode,
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
}: DocumentViewerProps<'epub'>) {
  const documentId = document.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<EpubHandle | null>(null);
  const [readingMode, setReadingMode] = useState<EpubReadingMode>('spread');
  const [pageInfo, setPageInfo] = useState<{ page: number; totalPages: number } | null>(null);
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
          if (location.page !== undefined && location.totalPages !== undefined) {
            setPageInfo({ page: location.page, totalPages: location.totalPages });
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

  // ---- Reading mode, keyboard navigation, and pane changes -----------------

  useEffect(() => {
    if (!handle) return;
    void handle.setReadingMode(readingMode);
  }, [handle, readingMode]);

  useEffect(() => {
    if (!handle || !isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
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

  if (error) {
    return (
      <div role="alert" className="p-6 text-sm text-destructive">
        Could not open {document.title}: {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="epub-viewer" data-reading-mode={readingMode}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <div role="group" aria-label="Reading mode" className="flex items-center gap-0.5">
          {READING_MODES.map(({ mode, label, icon: Icon }) => {
            const active = readingMode === mode;
            return (
              <Button
                key={mode}
                variant={active ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={active}
                disabled={!handle}
                onClick={() => setReadingMode(mode)}
              >
                <Icon />
                {label}
              </Button>
            );
          })}
        </div>
        {readingMode !== 'scroll' && pageInfo && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {pageInfo.page} of {pageInfo.totalPages}
          </span>
        )}
        <div className="flex items-center gap-1">
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
      </div>
      {missedJump && (
        <p role="status" className="shrink-0 border-b bg-muted px-4 py-1.5 text-xs">
          That excerpt could not be found in this book. The file may have changed.
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/30 px-2 py-1.5">
        <div
          ref={hostRef}
          data-testid="epub-host"
          className={cn(
            'relative h-full w-full overflow-hidden rounded-sm bg-[#fbfaf7] shadow-sm ring-1 ring-black/5',
            readingMode === 'spread' && 'max-w-none',
            readingMode === 'paged' && 'max-w-6xl',
            readingMode === 'scroll' && 'max-w-7xl',
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
  );
}
