import { ArrowRight } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { placePopover, toViewportRect, type ViewportRect } from '@/features/reader/markup/geometry';
import { cn } from '@/lib/utils';

/** A footnote or citation to show beside the link that points at it (#49). */
export interface LinkPeekTarget {
  /**
   * The target's plain text. It is rendered as a React text node and never parsed,
   * so book or document markup cannot reach the app's DOM (ADR 0005).
   */
  text: string;
  /** The link's box in the top window, which the card sits beside. */
  rect: ViewportRect | null;
}

/**
 * Apple Books' footnote card: the note's text beside its reference, with Go to Note
 * to read it in place. Readers decide what is a note and do the going; this only
 * shows the text and reports the reader's choice.
 */
export function LinkPeek({
  peek,
  boundsRef,
  onGo,
  onDismiss,
  onReturnFocus,
}: {
  peek: LinkPeekTarget | null;
  /** The reader's area: the card stays inside it. */
  boundsRef: RefObject<HTMLElement | null>;
  /** Go to Note: the reader jumps to the target, with its way back. */
  onGo: () => void;
  onDismiss: () => void;
  /** Where focus goes when the card is put away with Esc. */
  onReturnFocus: () => void;
}) {
  const textId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  // Placed for one card, so a new card is measured before it shows, not at the old spot.
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    for: LinkPeekTarget;
  } | null>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('below');
  const shown = peek !== null;

  useLayoutEffect(() => {
    if (!peek) return;
    const place = () => {
      const root = rootRef.current;
      if (!root) return;
      const view = root.ownerDocument.defaultView;
      // A parent's ref attaches after this runs on mount; the window bounds it then.
      const bounds = boundsRef.current
        ? toViewportRect(boundsRef.current.getBoundingClientRect())
        : { top: 0, left: 0, right: view?.innerWidth ?? 0, bottom: view?.innerHeight ?? 0 };
      const next = placePopover(
        peek.rect,
        { width: root.offsetWidth, height: root.offsetHeight },
        bounds,
      );
      setPosition((current) =>
        current?.for === peek && current.top === next.top && current.left === next.left
          ? current
          : { top: next.top, left: next.left, for: peek },
      );
      setPlacement(next.placement);
    };
    place();
    const view = rootRef.current?.ownerDocument.defaultView;
    view?.addEventListener('resize', place);
    return () => view?.removeEventListener('resize', place);
  }, [peek, boundsRef]);

  // The keyboard moves to Go to Note, so Return reads the note and Esc puts it away.
  // Only once placed: a browser will not focus it while it is still hidden.
  const placed = peek !== null && position?.for === peek;
  useEffect(() => {
    if (placed) goRef.current?.focus({ preventScroll: true });
  }, [placed]);

  // A press anywhere else puts the card away. Presses inside an EPUB chapter never
  // reach this window, so the EPUB reader dismisses on its own pointer reports.
  useEffect(() => {
    if (!shown) return;
    const view = rootRef.current?.ownerDocument.defaultView;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onDismiss();
    };
    // Scrolling the page moves the link out from under the card, so it goes too;
    // scrolling a long note inside the card does not.
    const onScroll = (event: Event) => {
      // The window's own scroll has the document, or the window, as its target.
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      onDismiss();
    };
    view?.addEventListener('pointerdown', onPointerDown, true);
    view?.addEventListener('scroll', onScroll, true);
    return () => {
      view?.removeEventListener('pointerdown', onPointerDown, true);
      view?.removeEventListener('scroll', onScroll, true);
    };
  }, [shown, onDismiss]);

  const close = () => {
    onDismiss();
    onReturnFocus();
  };

  useEscapeLayer(
    ESCAPE_LAYER.linkPeek,
    shown
      ? () => {
          close();
          return true;
        }
      : null,
  );

  if (!peek) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Note"
      aria-describedby={textId}
      data-testid="link-peek"
      data-placement={placement}
      data-reader-popover=""
      onKeyDown={onKeyDown}
      className={cn(
        // `duration-150` times the opening keyframes; with no transition, the card does not
        // slide from where it was measured or stay unfocusable while it fades in.
        'fixed z-40 flex w-[min(22rem,calc(100vw-1rem))] transition-none animate-in flex-col gap-2 rounded-xl border bg-background p-3 text-foreground shadow-lg duration-150 fade-in-0 zoom-in-[0.96] motion-reduce:animate-none',
        placement === 'above' ? 'origin-bottom' : 'origin-top',
      )}
      style={
        placed
          ? { top: position.top, left: position.left }
          : { top: 0, left: 0, visibility: 'hidden' }
      }
    >
      <p
        id={textId}
        data-testid="link-peek-text"
        className="max-h-48 overflow-y-auto text-sm leading-relaxed break-words select-text"
      >
        {peek.text}
      </p>
      <div className="flex justify-end">
        <Button
          ref={goRef}
          type="button"
          size="sm"
          variant="secondary"
          data-testid="link-peek-go"
          onClick={() => {
            onDismiss();
            onGo();
          }}
        >
          Go to Note
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
