import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { PageTransition } from '@/types/domain';

export type TurnDirection = 1 | -1;
export type TurnZone = 'previous' | 'next';

/** How much of each side of the page turns it when clicked, as in Books. */
export const CLICK_ZONE_FRACTION = 0.12;
/** A pointer that moved further than this between press and release was a drag. */
const CLICK_SLOP_PX = 4;
/**
 * A scrub that travelled this fraction of the page width commits the turn when
 * the fingers lift, as a page dragged past its own edge would.
 */
export const SCRUB_COMMIT_FRACTION = 0.18;
/** Release speed, in px/ms, that commits a turn however short the travel was. */
export const SCRUB_COMMIT_VELOCITY = 0.45;
/** How far a scrub may be dragged past the end of the document, as a fraction. */
export const RUBBER_BAND_LIMIT_FRACTION = 0.35;
/** Wheel silence that ends a scrub: the fingers lifted without a commit. */
export const SCRUB_IDLE_MS = 90;
/**
 * A wheel event this much faster than the one before it is a new physical flick,
 * not the decaying inertial tail of the one before. Trackpads keep emitting
 * `wheel` events for 400–800 ms after the fingers lift, and those must not turn
 * another page; a fresh flick must, without waiting for the tail to die.
 */
const MOMENTUM_SPIKE_RATIO = 1.6;
const MOMENTUM_SPIKE_SLACK = 2;
/** How much of the gesture the release velocity is measured over. */
const VELOCITY_WINDOW_MS = 80;
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

/** What the page should do next about one wheel gesture. */
export type ScrubUpdate =
  | { kind: 'start' }
  | { kind: 'move'; displacement: number }
  | { kind: 'end'; velocity: number; committed: TurnDirection | null };

/**
 * A scrub is dragged past the end of the document: it still follows the fingers,
 * but ever less, so the page never leaves the pane and never tears away.
 */
export function rubberBand(displacement: number, limit: number): number {
  if (limit <= 0) return 0;
  const magnitude = Math.abs(displacement);
  const damped = limit * (1 - Math.exp(-magnitude / limit));
  return displacement < 0 ? -damped : damped;
}

/** The direction a displacement of the strip means: positive travels forward. */
export function directionOf(displacement: number): TurnDirection {
  return displacement < 0 ? -1 : 1;
}

const IDLE = 0;
const SCRUBBING = 1;
const SETTLING = 2;

interface Sample {
  deltaX: number;
  at: number;
}

export interface WheelScrubContext {
  /** The page width in px, measured once per gesture; thresholds scale with it. */
  pageWidth: () => number;
  /** Whether a page exists in that direction; a scrub toward nothing rubber-bands. */
  canTurn: (direction: TurnDirection) => boolean;
}

/**
 * Turns horizontal trackpad travel into a page scrub.
 *
 * The old controller waited for 50 px of travel, turned once, then ignored every
 * wheel event for 300 ms of silence. That made the page jump instead of following
 * the fingers, and it swallowed a second flick made while the first one's
 * momentum was still decaying. This one reports every event so the page can move
 * 1:1, commits while the fingers are still down once a whole page has been
 * dragged, and then absorbs the decaying inertial tail — starting a new scrub the
 * moment a faster event or a reversed one shows a new physical flick.
 *
 * It is a plain state machine over `(deltaX, timestamp)` pairs so the physics can
 * be tested without a DOM or a clock.
 */
export class WheelScrub {
  private phase = IDLE;
  private travel = 0;
  private samples: Sample[] = [];
  private width = 0;
  private lastDeltaX = 0;
  private lastAbs = 0;
  private context: WheelScrubContext | null = null;

  /** Feeds one horizontal wheel event, and says what the page should do. */
  push(deltaX: number, at: number, context: WheelScrubContext): readonly ScrubUpdate[] {
    if (this.phase === SETTLING) {
      if (!this.isNewFlick(deltaX)) {
        this.lastDeltaX = deltaX;
        this.lastAbs = Math.abs(deltaX);
        return [];
      }
      return this.start(deltaX, at, context);
    }
    if (this.phase === IDLE) return this.start(deltaX, at, context);
    return this.advance(deltaX, at);
  }

  /** The wheel has been quiet for `SCRUB_IDLE_MS`: the fingers are off the pad. */
  release(at: number): readonly ScrubUpdate[] {
    if (this.phase === SETTLING) {
      this.phase = IDLE;
      this.travel = 0;
      return [];
    }
    if (this.phase === IDLE) return [];
    const velocity = this.velocity(at);
    const committed = this.commitDirection(velocity);
    if (committed === null) {
      this.phase = IDLE;
      this.travel = 0;
      return [{ kind: 'end', velocity, committed: null }];
    }
    return this.finish(velocity, committed);
  }

  /** Forgets any gesture, as when the reader is deactivated mid-scrub. */
  reset(): void {
    this.phase = IDLE;
    this.travel = 0;
    this.samples = [];
    this.lastDeltaX = 0;
    this.lastAbs = 0;
    this.context = null;
  }

  private start(deltaX: number, at: number, context: WheelScrubContext): readonly ScrubUpdate[] {
    this.phase = SCRUBBING;
    this.travel = 0;
    this.samples = [];
    this.lastDeltaX = 0;
    this.lastAbs = 0;
    this.context = context;
    // One layout read per gesture, not one per wheel event.
    this.width = Math.max(context.pageWidth(), 1);
    return [{ kind: 'start' }, ...this.advance(deltaX, at)];
  }

  private advance(deltaX: number, at: number): readonly ScrubUpdate[] {
    this.travel += deltaX;
    this.samples.push({ deltaX, at });
    if (this.samples.length > 32) this.samples.shift();
    this.lastDeltaX = deltaX;
    this.lastAbs = Math.abs(deltaX);
    const direction = directionOf(this.travel);
    if (Math.abs(this.travel) >= this.width && this.canTurn(direction)) {
      // A whole page has been dragged: the turn is made under the fingers, and
      // everything after this in the same gesture is inertia.
      return this.finish(this.velocity(at), direction);
    }
    return [{ kind: 'move', displacement: this.displacement() }];
  }

  private canTurn(direction: TurnDirection): boolean {
    return this.context?.canTurn(direction) ?? true;
  }

  private displacement(): number {
    if (this.canTurn(directionOf(this.travel))) return this.travel;
    return rubberBand(this.travel, this.width * RUBBER_BAND_LIMIT_FRACTION);
  }

  private commitDirection(velocity: number): TurnDirection | null {
    const direction = directionOf(this.travel);
    if (!this.canTurn(direction)) return null;
    if (Math.abs(this.travel) >= this.width * SCRUB_COMMIT_FRACTION) return direction;
    // A short but fast flick still turns, as it does in Books.
    if (Math.abs(velocity) >= SCRUB_COMMIT_VELOCITY && directionOf(velocity) === direction) {
      return direction;
    }
    return null;
  }

  private finish(velocity: number, committed: TurnDirection): readonly ScrubUpdate[] {
    this.phase = SETTLING;
    this.travel = 0;
    return [{ kind: 'end', velocity, committed }];
  }

  private isNewFlick(deltaX: number): boolean {
    if (Math.abs(deltaX) > this.lastAbs * MOMENTUM_SPIKE_RATIO + MOMENTUM_SPIKE_SLACK) return true;
    // Inertia only ever decays one way; a reversal is a new gesture.
    return (
      deltaX !== 0 && this.lastDeltaX !== 0 && Math.sign(deltaX) !== Math.sign(this.lastDeltaX)
    );
  }

  private velocity(at: number): number {
    // Measured over the last moments of the gesture, not up to `at`: the release
    // fires after the wheel has been quiet, and would otherwise average in nothing.
    const end = this.samples.at(-1)?.at ?? at;
    const recent = this.samples.filter((sample) => end - sample.at <= VELOCITY_WINDOW_MS);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last) return 0;
    const span = last.at - first.at;
    if (span <= 0) return 0;
    let travel = 0;
    for (let index = 1; index < recent.length; index += 1) {
      travel += recent[index]?.deltaX ?? 0;
    }
    return travel / span;
  }
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

/** The clock the scrub runs on. Wall time, so fake timers drive it in tests. */
function now(): number {
  return Date.now();
}

/**
 * Page turns from the page itself: clicks in the outer edges of the page and
 * two-finger horizontal swipes. Neither ever starts on top of text, so
 * selecting text works everywhere, edges included.
 *
 * A swipe is reported live through `onScrubStart` / `onScrubMove` /
 * `onScrubEnd`, so the page can follow the fingers and only then commit or
 * spring back. Without those callbacks a swipe turns one page, as before.
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
  canTurn,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: {
  enabled: boolean;
  areaRef: RefObject<HTMLElement | null>;
  pageRef?: RefObject<HTMLElement | null>;
  onTurn: (direction: TurnDirection) => void;
  /** False while the page scrolls sideways itself (a zoomed PDF). */
  canSwipe?: () => boolean;
  /** Whether a page exists in that direction, for the end-of-document rubber band. */
  canTurn?: (direction: TurnDirection) => boolean;
  onScrubStart?: () => void;
  /** Follows the fingers: px of travel, signed, already rubber-banded. */
  onScrubMove?: (displacement: number) => void;
  onScrubEnd?: (velocity: number, committed: TurnDirection | null) => void;
}): PageTurnGestures {
  const [zone, setZone] = useState<TurnZone | null>(null);
  const latest = useRef({
    enabled,
    onTurn,
    canSwipe,
    canTurn,
    onScrubStart,
    onScrubMove,
    onScrubEnd,
  });
  useEffect(() => {
    latest.current = { enabled, onTurn, canSwipe, canTurn, onScrubStart, onScrubMove, onScrubEnd };
  });
  const press = useRef<{ x: number; y: number; hadSelection: boolean } | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  const [scrub] = useState(() => new WheelScrub());

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

  const emit = useCallback((updates: readonly ScrubUpdate[]) => {
    for (const update of updates) {
      switch (update.kind) {
        case 'start':
          latest.current.onScrubStart?.();
          break;
        case 'move':
          latest.current.onScrubMove?.(update.displacement);
          break;
        case 'end': {
          const { onScrubEnd: end, onTurn: turn } = latest.current;
          // A page that cannot follow the fingers still turns on a committed swipe.
          if (end) end(update.velocity, update.committed);
          else if (update.committed !== null) turn(update.committed);
          break;
        }
      }
    }
  }, []);

  const armIdle = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      emit(scrub.release(now()));
    }, SCRUB_IDLE_MS);
  }, [emit, scrub]);

  const handleWheel = useCallback(
    (wheel: WheelSample): boolean => {
      const { enabled: on, canSwipe: swipeAllowed } = latest.current;
      if (!on || wheel.ctrlKey) return false;
      if (Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY) * 1.5) return false;
      if (swipeAllowed && !swipeAllowed()) return false;
      // Built here, in the event, so nothing that reads a ref is handed to the
      // tracker while React is rendering.
      emit(
        scrub.push(wheel.deltaX, now(), {
          pageWidth: () =>
            (pageRef?.current ?? areaRef.current)?.getBoundingClientRect().width ?? 0,
          canTurn: (direction) => latest.current.canTurn?.(direction) ?? true,
        }),
      );
      armIdle();
      return true;
    },
    [areaRef, armIdle, emit, pageRef, scrub],
  );

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
    if (enabled) return;
    // A reader that loses focus mid-scrub must not keep the page off its mark.
    scrub.reset();
    window.clearTimeout(idleTimer.current);
    idleTimer.current = undefined;
  }, [enabled, scrub]);

  useEffect(() => {
    return () => window.clearTimeout(idleTimer.current);
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

/** The easing a whole-page strip slide uses, as in Books. */
export const PAGE_SLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** How long a committed slide takes to cross the page. */
export const PAGE_SLIDE_MS = 260;
/** How long a cancelled scrub takes to spring back. */
export const PAGE_SPRING_BACK_MS = 200;

/** How one mode draws the incoming page. */
export interface PageTurnMotion {
  duration: number;
  easing: string;
  keyframes: (direction: TurnDirection, spread?: boolean) => Keyframe[];
}

/**
 * The edge the incoming page curls around: its leading edge, or the centre spine
 * of a two-page spread, where the turning leaf is hinged.
 */
function curlOrigin(direction: TurnDirection, spread: boolean): string {
  if (spread) return '50% 50%';
  return direction > 0 ? '0% 50%' : '100% 50%';
}

/** Points that approximate the fold curve. More is smoother, not slower. */
const CURL_STEPS = 12;
/**
 * How far the fold pulls the free edge in, as a fraction of the page width. Live
 * text cannot be deformed without rasterizing it (`ADR 0005`), so the fold is the
 * page's own outline bending: the leaf keeps its pixels and loses its straight
 * edge, which is what the eye reads as paper.
 */
export const CURL_BULGE = 0.08;

/** The free edge a curl bends: the page's trailing edge, away from its hinge. */
function curledEdge(direction: TurnDirection): number {
  return direction > 0 ? 100 : 0;
}

/** How far the fold pulls the edge in at `at` (0 top, 1 bottom), in percent. */
function foldOffset(direction: TurnDirection, bulge: number, at: number): number {
  return (direction > 0 ? -1 : 1) * Math.sin(at * Math.PI) * bulge * 100;
}

/**
 * The outline of a page whose free edge is curling, as a clip path. The curve is a
 * half-sine, so the corners stay where they are and the middle of the edge bends.
 * At `bulge` 0 this is the page's own rectangle, which is where the turn ends.
 */
export function curlFoldClip(direction: TurnDirection, bulge: number): string {
  const edge = curledEdge(direction);
  const curve = Array.from({ length: CURL_STEPS + 1 }, (_, step) => {
    const at = step / CURL_STEPS;
    return `${(edge + foldOffset(direction, bulge, at)).toFixed(2)}% ${(at * 100).toFixed(2)}%`;
  });
  const corner = direction > 0 ? '0% 0%' : '100% 0%';
  const foot = direction > 0 ? '0% 100%' : '100% 100%';
  return `polygon(${[corner, ...curve, foot].join(', ')})`;
}

/** The folded-over strip itself: the part of the page beyond the fold. */
export function curlBackClip(direction: TurnDirection, bulge: number): string {
  const edge = curledEdge(direction);
  const curve = Array.from({ length: CURL_STEPS + 1 }, (_, step) => {
    const at = 1 - step / CURL_STEPS;
    return `${(edge + foldOffset(direction, bulge, at)).toFixed(2)}% ${(at * 100).toFixed(2)}%`;
  });
  return `polygon(${[`${edge}% 0%`, `${edge}% 100%`, ...curve].join(', ')})`;
}

/**
 * How each mode draws the incoming page. Durations and easings are starting
 * points to tune by eye; the shape of each motion is not.
 *
 * `slide` here is the fallback for a page that has no second buffer to move with
 * it — an EPUB chapter seam or a TXT row. It nudges the incoming page without
 * touching opacity, so no turn ever flashes the page dimmer. The viewers that do
 * have a strip (EPUB within a chapter, PDF in a paged mode) move both pages
 * together themselves and never use this.
 */
export const PAGE_TURN_MOTION = {
  slide: {
    duration: 220,
    easing: PAGE_SLIDE_EASING,
    keyframes: (direction: TurnDirection): Keyframe[] => [
      { transform: `translateX(${direction * 32}px)` },
      { transform: 'translateX(0)' },
    ],
  },
  fade: {
    duration: 200,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    keyframes: (): Keyframe[] => [{ opacity: 0.2 }, { opacity: 1 }],
  },
  curl: {
    duration: 420,
    easing: PAGE_SLIDE_EASING,
    keyframes: (direction: TurnDirection, spread = false): Keyframe[] => {
      // Both frames carry the origin so it never has to be written to the
      // element and then restored.
      const transformOrigin = curlOrigin(direction, spread);
      // A spread hinges at its own spine, so the leaf lifts instead of the whole
      // spread swinging like a plank. No opacity: the paper never goes grey.
      // The angle stays small because a spread is one element: the half that is
      // not turning cannot be exempted from its transform, so most of the curl
      // has to come from the fold in the leaf's own outline.
      const angle = spread ? 12 : 26;
      const perspective = spread ? 1500 : 1200;
      // The leaf's free edge bends as it lifts and straightens as it settles. The
      // clip is what makes this a curl rather than a card rotating: the page keeps
      // every pixel it had and loses its straight edge, which is the shape paper
      // takes. Both frames carry the same number of points, so it interpolates.
      return [
        {
          transform: `perspective(${perspective}px) rotateY(${direction * -angle}deg)`,
          transformOrigin,
          clipPath: curlFoldClip(direction, CURL_BULGE),
        },
        {
          transform: `perspective(${perspective}px) rotateY(0deg)`,
          transformOrigin,
          clipPath: curlFoldClip(direction, 0),
        },
      ];
    },
  },
  stack: {
    duration: 240,
    easing: PAGE_SLIDE_EASING,
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
export function cancelPageTurn(element: HTMLElement): void {
  if (typeof element.getAnimations !== 'function') return;
  for (const animation of element.getAnimations()) {
    if (animation.id === PAGE_TURN_ANIMATION_ID) animation.cancel();
  }
}

/** One side of the overlay, as the four insets that place a layer on it. */
export interface LeafSides {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

const WHOLE_PAGE: LeafSides = { top: '0', right: '0', bottom: '0', left: '0' };

/**
 * Which part of the overlay a turning leaf occupies, and which part it leaves
 * behind. A spread turns its right half going forward and its left half going
 * back; a single page is its own leaf, so both cover the whole page.
 *
 * The layers are placed on their side rather than clipped to it, because a
 * gradient is drawn across its own box: a full-width layer clipped to one half
 * would show only the end of its gradient, which is already transparent.
 */
export function turningLeafSides(
  direction: TurnDirection,
  spread: boolean,
): { leaf: LeafSides; rest: LeafSides } {
  if (!spread) return { leaf: WHOLE_PAGE, rest: WHOLE_PAGE };
  return direction > 0
    ? { leaf: { ...WHOLE_PAGE, left: '50%' }, rest: { ...WHOLE_PAGE, right: '50%' } }
    : { leaf: { ...WHOLE_PAGE, right: '50%' }, rest: { ...WHOLE_PAGE, left: '50%' } };
}

/** Places a curl layer on one side of the overlay. */
function placeLayer(layer: HTMLElement, sides: LeafSides): void {
  layer.style.top = sides.top;
  layer.style.right = sides.right;
  layer.style.bottom = sides.bottom;
  layer.style.left = sides.left;
}

/** Animates one curl layer, from nothing, through the fold, back to nothing. */
function animateCurlLayer(layer: HTMLElement, keyframes: Keyframe[]): void {
  if (typeof layer.animate !== 'function') return;
  cancelPageTurn(layer);
  const animation = layer.animate(keyframes, {
    duration: PAGE_TURN_MOTION.curl.duration,
    easing: 'ease-out',
  });
  animation.id = PAGE_TURN_ANIMATION_ID;
}

/**
 * The shading a `curl` lays over the page: the curvature of the turning leaf and
 * the shadow it throws on the half that stays put.
 *
 * Both layers are clipped to their own side of the spine, so neither can spill
 * across it, and both scale outwards from the hinge as the leaf settles — that
 * falloff, rather than any deformation of the text, is what makes the turn read
 * as paper curling. It lives beside the page, never inside it, so the EPUB
 * iframe and the PDF text layers are never transformed and only opacity and
 * scale move.
 */
function animateTurnShadow(
  shadow: HTMLElement | null,
  direction: TurnDirection,
  spread: boolean,
): void {
  const fold = shadow?.querySelector<HTMLElement>('[data-page-turn-layer="fold"]') ?? null;
  if (!shadow || !fold) return;
  const back = shadow.querySelector<HTMLElement>('[data-page-turn-layer="back"]');
  const cast = shadow.querySelector<HTMLElement>('[data-page-turn-layer="cast"]');
  const forward = direction > 0;
  const { leaf, rest } = turningLeafSides(direction, spread);
  const shade = 'var(--page-turn-shadow, rgb(0 0 0 / 0.28))';
  const paper = 'var(--page-turn-paper, rgb(252 251 248))';
  // The strip that has folded over: the paper's reverse, lit at its free edge and
  // dark where it meets the fold. It fills exactly the part of the page the fold
  // pulled away from, so the leaf reads as paper bent over rather than cut off.
  if (back) {
    placeLayer(back, leaf);
    back.style.backgroundSize = `${(CURL_BULGE * 100 + 8).toFixed(1)}% 100%`;
    back.style.backgroundPosition = forward ? '100% 0' : '0 0';
    back.style.backgroundImage = `linear-gradient(to ${
      forward ? 'right' : 'left'
    }, ${shade}, ${paper} 72%)`;
    animateCurlLayer(back, [
      { opacity: 0, clipPath: curlBackClip(direction, CURL_BULGE) },
      { opacity: 1, clipPath: curlBackClip(direction, CURL_BULGE), offset: 0.2 },
      { opacity: 0, clipPath: curlBackClip(direction, 0) },
    ]);
  }
  // The fold shadow sits just inside the fold, so it is a band whose darkest part
  // is the bulge's width in from the free edge, not a wash from the edge itself.
  // It is clipped by the same curve as the page, so the two can never disagree
  // about where the paper ends, and it flattens as the leaf straightens.
  placeLayer(fold, leaf);
  fold.style.backgroundImage = `linear-gradient(to ${
    forward ? 'left' : 'right'
  }, transparent 2%, ${shade} ${(CURL_BULGE * 100 + 2).toFixed(1)}%, transparent 32%)`;
  animateCurlLayer(fold, [
    { opacity: 0, clipPath: curlFoldClip(direction, CURL_BULGE) },
    { opacity: 1, clipPath: curlFoldClip(direction, CURL_BULGE), offset: 0.25 },
    { opacity: 0, clipPath: curlFoldClip(direction, 0) },
  ]);
  if (!cast) return;
  if (!spread) {
    // A single page is its own leaf: there is no page underneath to catch a shadow.
    cancelPageTurn(cast);
    cast.style.opacity = '0';
    return;
  }
  // The cast shadow lies on the half that stays put, darkest where it meets the
  // spine and gone within a third of the page: a leaf this close to the paper
  // under it shades the gutter, not the whole page.
  placeLayer(cast, rest);
  cast.style.transformOrigin = forward ? 'right center' : 'left center';
  cast.style.backgroundImage = `linear-gradient(to ${
    forward ? 'left' : 'right'
  }, ${shade}, transparent 38%)`;
  animateCurlLayer(cast, [
    { opacity: 0, transform: 'scaleX(0.6)' },
    { opacity: 0.75, transform: 'scaleX(1)', offset: 0.42 },
    { opacity: 0, transform: 'scaleX(1.1)' },
  ]);
}

/**
 * Shows which way the page turned: the new page slides in from that side, fades
 * in, curls in around its leading edge or spine, or rises from behind. Instant
 * with reduced motion, and never delays the turn itself.
 *
 * `shadow` is the overlay the viewer owns beside the page; only `curl` uses it.
 * Nothing fills forwards, so hit-testing and selection geometry are accurate
 * again as soon as the animation ends.
 */
export function animatePageTurn(
  element: HTMLElement | null,
  direction: TurnDirection,
  transition: PageTransition,
  shadow: HTMLElement | null = null,
  { spread = false }: { spread?: boolean } = {},
): void {
  if (!element || transition === 'none' || prefersReducedMotion()) return;
  if (typeof element.animate !== 'function') return;
  const motion = PAGE_TURN_MOTION[transition];
  cancelPageTurn(element);
  const animation = element.animate(motion.keyframes(direction, spread), {
    duration: motion.duration,
    easing: motion.easing,
  });
  animation.id = PAGE_TURN_ANIMATION_ID;
  if (transition === 'curl') animateTurnShadow(shadow, direction, spread);
}

/**
 * Moves a scroll container one page's width — or height — with the same eased
 * whole-page motion the strip readers use, so both pages travel together at full
 * opacity instead of the incoming one being nudged after a cut.
 *
 * Resolves when the motion has settled, or at once with reduced motion. The
 * caller keeps the element's own scroll position authoritative: nothing is
 * transformed and nothing is left behind. Aborting `signal` stops the motion
 * where it is, so a jump the reader asked for is never overwritten by a frame of
 * a slide they started before it.
 */
export function slideScroll(
  scroller: HTMLElement | null,
  delta: { left?: number; top?: number },
  duration = PAGE_SLIDE_MS,
  signal?: AbortSignal,
): Promise<void> {
  const left = delta.left ?? 0;
  const top = delta.top ?? 0;
  if (!scroller || (left === 0 && top === 0)) return Promise.resolve();
  const fromLeft = scroller.scrollLeft;
  const fromTop = scroller.scrollTop;
  if (typeof scroller.scrollTo !== 'function' || prefersReducedMotion()) {
    scroller.scrollTo({ left: fromLeft + left, top: fromTop + top });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = () => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const progress = Math.min((performance.now() - started) / duration, 1);
      const eased = easeOut(progress);
      scroller.scrollTo({ left: fromLeft + left * eased, top: fromTop + top * eased });
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    window.requestAnimationFrame(step);
  });
}

/**
 * The curve `PAGE_SLIDE_EASING` draws, solved here because motion driven from
 * script cannot hand the browser a CSS easing function.
 */
export function easeOut(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  if (x === 0) return 0;
  if (x === 1) return 1;
  // cubic-bezier(0.22, 1, 0.36, 1): x is monotonic, so bisection finds the
  // parameter whose x matches the time we were asked about.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (bezierAxis(mid, 0.22, 0.36) < x) low = mid;
    else high = mid;
  }
  return bezierAxis((low + high) / 2, 1, 1);
}

function bezierAxis(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}
