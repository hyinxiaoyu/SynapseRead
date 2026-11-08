import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { PageTransition } from '@/types/domain';

export type TurnDirection = 1 | -1;
export type TurnZone = 'previous' | 'next';

/** How much of each side of the page turns it when clicked, as in Books. */
export const CLICK_ZONE_FRACTION = 0.12;
/** A pointer that moved further than this between press and release was a drag. */
const CLICK_SLOP_PX = 4;
/** Horizontal wheel travel that makes one swipe. */
export const SWIPE_THRESHOLD_PX = 50;
/**
 * A swipe turns one page, then nothing more until the wheel has been quiet this
 * long: trackpad momentum keeps sending events well after the fingers lift.
 */
export const SWIPE_IDLE_MS = 300;
/** Marks the animations this module starts, so a new turn cancels only the last one. */
export const PAGE_TURN_ANIMATION_ID = 'page-turn';

const INTERACTIVE =
  'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [contenteditable="true"], [data-annotation-id], [data-no-page-turn]';

/** Which zone a point is in, if any. Everything beside the page counts too. */
export function zoneAt(x: number, page: { left: number; width: number }): TurnZone | null {
  if (page.width <= 0) return null;
  const zone = page.width * CLICK_ZONE_FRACTION;
  if (x < page.left + zone) return 'previous';
  if (x > page.left + page.width - zone) return 'next';
  return null;
}

/**
 * Whether a point is over a glyph. A click there belongs to the text (placing a
 * caret, starting a double-click), so it never turns the page. Works in any
 * document, the EPUB chapter frames included.
 */
export function isOverText(doc: Document, x: number, y: number): boolean {
  const withPosition = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof withPosition.caretPositionFromPoint === 'function') {
    const position = withPosition.caretPositionFromPoint(x, y);
    node = position?.offsetNode ?? null;
    offset = position?.offset ?? 0;
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const length = (node as Text).length;
  const range = doc.createRange();
  range.setStart(node, Math.max(0, offset - 1));
  range.setEnd(node, Math.min(length, offset + 1));
  for (const rect of range.getClientRects()) {
    if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
      return true;
    }
  }
  return false;
}

/** Over a link, a control, a highlight, or text: the click is the reader's. */
export function isOverContent(target: EventTarget | null, x: number, y: number): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return false;
  if (element.closest(INTERACTIVE)) return true;
  return isOverText(element.ownerDocument, x, y);
}

/** What a page reports about the pointer, in the top window's client coordinates. */
export type PageGestureSample =
  | { kind: 'down'; x: number; y: number; hasSelection: boolean }
  | { kind: 'move'; x: number; y: number; overContent: boolean }
  | { kind: 'leave' }
  | { kind: 'click'; x: number; y: number; overContent: boolean; hasSelection: boolean };

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
}

export interface PageTurnGestures {
  /** The zone under the pointer, for a direction cursor. */
  zone: TurnZone | null;
  /** For pages in another document (EPUB chapters), which forward their events. */
  handleSample: (sample: PageGestureSample) => void;
  /** Whether a wheel event was a swipe the page used; the caller then cancels it. */
  handleWheel: (wheel: WheelSample) => boolean;
}

function hasSelectionIn(doc: Document): boolean {
  const selection = doc.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * Page turns from the page itself: clicks in the outer edges of the page and
 * two-finger horizontal swipes. Neither ever starts on top of text, so
 * selecting text works everywhere, edges included.
 *
 * `areaRef` is where gestures are heard; zones are measured on `pageRef` (the
 * page, which can be narrower than the area) or else the area.
 */
export function usePageTurnGestures({
  enabled,
  areaRef,
  pageRef,
  onTurn,
  canSwipe,
}: {
  enabled: boolean;
  areaRef: RefObject<HTMLElement | null>;
  pageRef?: RefObject<HTMLElement | null>;
  onTurn: (direction: TurnDirection) => void;
  /** False while the page scrolls sideways itself (a zoomed PDF). */
  canSwipe?: () => boolean;
}): PageTurnGestures {
  const [zone, setZone] = useState<TurnZone | null>(null);
  const latest = useRef({ enabled, onTurn, canSwipe });
  useEffect(() => {
    latest.current = { enabled, onTurn, canSwipe };
  });
  const press = useRef<{ x: number; y: number; hadSelection: boolean } | null>(null);
  const swipe = useRef({ travel: 0, turned: false, timer: undefined as number | undefined });

  const zoneFor = useCallback(
    (x: number): TurnZone | null => {
      const page = pageRef?.current ?? areaRef.current;
      if (!page) return null;
      const rect = page.getBoundingClientRect();
      return zoneAt(x, rect);
    },
    [areaRef, pageRef],
  );

  const handleSample = useCallback(
    (sample: PageGestureSample) => {
      if (!latest.current.enabled) {
        setZone(null);
        return;
      }
      switch (sample.kind) {
        case 'down':
          press.current = { x: sample.x, y: sample.y, hadSelection: sample.hasSelection };
          return;
        case 'move':
          setZone(sample.overContent ? null : zoneFor(sample.x));
          return;
        case 'leave':
          setZone(null);
          return;
        case 'click': {
          const pressed = press.current;
          press.current = null;
          if (sample.overContent || sample.hasSelection) return;
          // The click that dismisses a selection does only that.
          if (pressed?.hadSelection) return;
          if (pressed && Math.hypot(sample.x - pressed.x, sample.y - pressed.y) > CLICK_SLOP_PX) {
            return;
          }
          const turnZone = zoneFor(sample.x);
          if (turnZone) latest.current.onTurn(turnZone === 'next' ? 1 : -1);
        }
      }
    },
    [zoneFor],
  );

  const handleWheel = useCallback((wheel: WheelSample): boolean => {
    const { enabled: on, onTurn: turn, canSwipe: swipeAllowed } = latest.current;
    if (!on || wheel.ctrlKey) return false;
    if (Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY) * 1.5) return false;
    if (swipeAllowed && !swipeAllowed()) return false;
    const state = swipe.current;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.travel = 0;
      state.turned = false;
    }, SWIPE_IDLE_MS);
    if (state.turned) return true;
    state.travel += wheel.deltaX;
    if (Math.abs(state.travel) >= SWIPE_THRESHOLD_PX) {
      state.turned = true;
      // Fingers moving left scroll content right: the next page.
      turn(state.travel > 0 ? 1 : -1);
    }
    return true;
  }, []);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const doc = area.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      handleSample({
        kind: 'down',
        x: event.clientX,
        y: event.clientY,
        hasSelection: hasSelectionIn(doc),
      });
    };
    let frame = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) return;
      const { clientX: x, clientY: y, target } = event;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        handleSample({ kind: 'move', x, y, overContent: isOverContent(target, x, y) }),
      );
    };
    const onPointerLeave = () => {
      window.cancelAnimationFrame(frame);
      handleSample({ kind: 'leave' });
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.detail > 1 || event.defaultPrevented) return;
      handleSample({
        kind: 'click',
        x: event.clientX,
        y: event.clientY,
        overContent: isOverContent(event.target, event.clientX, event.clientY),
        hasSelection: hasSelectionIn(doc),
      });
    };
    const onWheel = (event: WheelEvent) => {
      if (handleWheel(event)) event.preventDefault();
    };
    area.addEventListener('pointerdown', onPointerDown);
    area.addEventListener('pointermove', onPointerMove);
    area.addEventListener('pointerleave', onPointerLeave);
    area.addEventListener('click', onClick);
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.cancelAnimationFrame(frame);
      area.removeEventListener('pointerdown', onPointerDown);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerleave', onPointerLeave);
      area.removeEventListener('click', onClick);
      area.removeEventListener('wheel', onWheel);
    };
  }, [areaRef, handleSample, handleWheel]);

  useEffect(() => {
    const state = swipe.current;
    return () => window.clearTimeout(state.timer);
  }, []);

  return { zone: enabled ? zone : null, handleSample, handleWheel };
}

/** The cursor that hints which way a click turns. */
export function zoneCursor(zone: TurnZone | null): string {
  if (zone === 'previous') return 'w-resize';
  if (zone === 'next') return 'e-resize';
  return '';
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** How one mode draws the incoming page. */
export interface PageTurnMotion {
  duration: number;
  easing: string;
  keyframes: (direction: TurnDirection) => Keyframe[];
}

/** The edge the incoming page swings around: its leading edge. */
function flipOrigin(direction: TurnDirection): string {
  return direction > 0 ? '0% 50%' : '100% 50%';
}

/**
 * How each mode draws the incoming page. Durations and easings are starting
 * points to tune by eye; the shape of each motion is not.
 */
export const PAGE_TURN_MOTION = {
  slide: {
    duration: 220,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    keyframes: (direction: TurnDirection): Keyframe[] => [
      { transform: `translateX(${direction * 32}px)`, opacity: 0.35 },
      { transform: 'translateX(0)', opacity: 1 },
    ],
  },
  fade: {
    duration: 200,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    keyframes: (): Keyframe[] => [{ opacity: 0.2 }, { opacity: 1 }],
  },
  flip: {
    duration: 300,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    keyframes: (direction: TurnDirection): Keyframe[] => {
      // Both frames carry the origin so it never has to be written to the
      // element and then restored.
      const transformOrigin = flipOrigin(direction);
      return [
        {
          transform: `perspective(1400px) rotateY(${direction * -18}deg)`,
          transformOrigin,
        },
        { transform: 'perspective(1400px) rotateY(0deg)', transformOrigin },
      ];
    },
  },
  stack: {
    duration: 240,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    keyframes: (direction: TurnDirection): Keyframe[] => [
      { transform: `scale(0.965) translateX(${direction * 16}px)`, opacity: 0.6 },
      { transform: 'scale(1) translateX(0)', opacity: 1 },
    ],
  },
} satisfies Record<Exclude<PageTransition, 'none'>, PageTurnMotion>;

/**
 * Stops the turn still running on an element, so fast keyboard repeats replace
 * it instead of stacking. Only our own animations are cancelled: CSS
 * transitions and the readers' own effects are left alone.
 */
function cancelPageTurn(element: HTMLElement): void {
  if (typeof element.getAnimations !== 'function') return;
  for (const animation of element.getAnimations()) {
    if (animation.id === PAGE_TURN_ANIMATION_ID) animation.cancel();
  }
}

/**
 * The shadow a `flip` casts from its hinge. It lives beside the page, not
 * inside it, so the EPUB iframe and the PDF text layers are never transformed,
 * and only its opacity moves.
 */
function animateTurnShadow(shadow: HTMLElement | null, direction: TurnDirection): void {
  if (!shadow || typeof shadow.animate !== 'function') return;
  shadow.style.backgroundImage = `linear-gradient(to ${
    direction > 0 ? 'right' : 'left'
  }, var(--page-turn-shadow, rgb(0 0 0 / 0.28)), transparent 55%)`;
  cancelPageTurn(shadow);
  const animation = shadow.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
    duration: PAGE_TURN_MOTION.flip.duration,
    easing: 'ease-out',
  });
  animation.id = PAGE_TURN_ANIMATION_ID;
}

/**
 * Shows which way the page turned: the new page slides in from that side, fades
 * in, flips in around its leading edge, or rises from behind. Instant with
 * reduced motion, and never delays the turn itself.
 *
 * `shadow` is the overlay the viewer owns beside the page; only `flip` uses it.
 * Nothing fills forwards, so hit-testing and selection geometry are accurate
 * again as soon as the animation ends.
 */
export function animatePageTurn(
  element: HTMLElement | null,
  direction: TurnDirection,
  transition: PageTransition,
  shadow: HTMLElement | null = null,
): void {
  if (!element || transition === 'none' || prefersReducedMotion()) return;
  if (typeof element.animate !== 'function') return;
  const motion = PAGE_TURN_MOTION[transition];
  cancelPageTurn(element);
  const animation = element.animate(motion.keyframes(direction), {
    duration: motion.duration,
    easing: motion.easing,
  });
  animation.id = PAGE_TURN_ANIMATION_ID;
  if (transition === 'flip') animateTurnShadow(shadow, direction);
}
