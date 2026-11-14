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
/** How long a committed conical paper curl takes to sweep across the page. */
export const PAGE_CURL_MS = 360;
/** How long a cancelled scrub takes to spring back. */
export const PAGE_SPRING_BACK_MS = 200;

/** How one mode draws the incoming page. */
export interface PageTurnMotion {
  duration: number;
  easing: string;
  keyframes: (direction: TurnDirection, spread?: boolean) => Keyframe[];
}

/** Points sampled vertically to draw the curved crease and conical leaf outline. */
const CURL_STEPS = 10;

/** Computed CSS geometry and multi-layer shading for one frame of a paper curl. */
export interface PaperCurlGeometry {
  active: boolean;
  progress: number;
  direction: TurnDirection;
  unpeeledClip: string;
  leafClip: string;
  leafBackground: string;
  leafOpacity: number;
  castClip: string;
  castBackground: string;
  castOpacity: number;
  underClip: string;
  underBackground: string;
  underOpacity: number;
  spineBackground: string;
  spineOpacity: number;
}

function clampPct(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function formatPolygon(points: readonly (readonly [number, number])[]): string {
  return `polygon(${points.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ')})`;
}

function normalizedStop(start: number, end: number, fraction: number): string {
  const span = Math.max(end - start, 0.05);
  return `${(start + span * fraction).toFixed(2)}%`;
}

/**
 * Computes the geometry and optical shading for a conical paper-curl peel at
 * `progress` (`0` = flat outgoing page, `1` = completely peeled away).
 *
 * Both the outgoing and incoming pages stay stationary at `(0, 0)`. An angled,
 * gently arched crease sweeps across the page with the lower outer corner
 * leading naturally, clipping the outgoing page (`unpeeledClip`) while painting
 * a flared conical paper backside (`leaf`), soft cast shadow onto the incoming
 * page (`cast-shadow`), tight ambient occlusion ahead of the lifted edge
 * (`under-shadow`), and a center `50%` spine valley for two-page spreads.
 */
export function computePaperCurl(
  progress: number,
  direction: TurnDirection,
  { spread = false }: { spread?: boolean | undefined } = {},
): PaperCurlGeometry {
  const p = Math.min(Math.max(progress, 0), 1);
  if (p <= 0.001 || p >= 0.999) {
    const hingeX = direction > 0 ? 0 : 100;
    // Keep the outgoing page collapsed at 0 area through tail rAF frames (easeOut reaches 0.999
    // before t = 1) so it never flashes back full-screen right before `resetPaperCurl`.
    const unpeeledClip =
      p >= 0.999
        ? `polygon(${hingeX}% 0%, ${hingeX}% 0%, ${hingeX}% 100%, ${hingeX}% 100%)`
        : 'none';
    return {
      active: false,
      progress: p,
      direction,
      unpeeledClip,
      leafClip: 'none',
      leafBackground: 'none',
      leafOpacity: 0,
      castClip: 'none',
      castBackground: 'none',
      castOpacity: 0,
      underClip: 'none',
      underBackground: 'none',
      underOpacity: 0,
      spineBackground: 'none',
      spineOpacity: 0,
    };
  }

  const s = Math.sin(Math.PI * p);
  const tilt = 6.0 * s;
  const arch = 1.6 * s;
  const curlSpan = 21 * s;

  const ys: number[] = [];
  const creaseXs: number[] = [];
  const freeXs: number[] = [];
  const castXs: number[] = [];
  const underXs: number[] = [];

  for (let step = 0; step <= CURL_STEPS; step += 1) {
    const y = step / CURL_STEPS;
    const sineY = Math.sin(Math.PI * y);
    const fwdCrease = clampPct((1 - p) * 100 + tilt * (1 - 2 * y) - arch * sineY);
    const crease = direction > 0 ? fwdCrease : 100 - fwdCrease;
    const leafWidth = curlSpan * (0.76 + 0.4 * y + 0.08 * sineY);
    const free = clampPct(crease - direction * leafWidth);
    const castWidth = s * (8.5 + 8.5 * y);
    const cast = clampPct(crease + direction * castWidth);
    const underWidth = s * (3.2 + 2.2 * y);
    const under = clampPct(free - direction * underWidth);

    ys.push(y * 100);
    creaseXs.push(crease);
    freeXs.push(free);
    castXs.push(cast);
    underXs.push(under);
  }

  const anchorX = direction > 0 ? 0 : 100;
  const unpeeledPoints: [number, number][] = [
    [anchorX, 0],
    ...ys.map((y, index): [number, number] => [creaseXs[index] ?? anchorX, y]),
    [anchorX, 100],
  ];
  const unpeeledClip = formatPolygon(unpeeledPoints);

  const traceBand = (left: readonly number[], right: readonly number[]): string => {
    const down = ys.map((y, index): [number, number] => [left[index] ?? 0, y]);
    const up: [number, number][] = [];
    for (let index = CURL_STEPS; index >= 0; index -= 1) {
      up.push([right[index] ?? 0, ys[index] ?? 0]);
    }
    return formatPolygon([...down, ...up]);
  };

  const leafClip = traceBand(creaseXs, freeXs);
  const castClip = traceBand(creaseXs, castXs);
  const underClip = traceBand(underXs, freeXs);

  const midIndex = CURL_STEPS / 2;
  const cMid = creaseXs[midIndex] ?? 50;
  const fMid = freeXs[midIndex] ?? 50;
  const castMid = castXs[midIndex] ?? 50;
  const underMid = underXs[midIndex] ?? 50;

  const tiltDeg = (Math.atan2(2 * tilt, 100) * 180) / Math.PI;
  const gradAngle = direction > 0 ? 90 + tiltDeg : 270 - tiltDeg;
  const axisPct = (x: number) => (direction > 0 ? x : 100 - x);

  const leafStart = axisPct(fMid);
  const leafEnd = axisPct(cMid);
  const sheenLayer = `linear-gradient(${gradAngle.toFixed(1)}deg, transparent ${normalizedStop(leafStart, leafEnd, -0.02)}, var(--page-turn-rim, rgba(255, 255, 255, 0.96)) ${normalizedStop(leafStart, leafEnd, 0)}, var(--page-turn-rim, rgba(255, 255, 255, 0.96)) ${normalizedStop(leafStart, leafEnd, 0.04)}, transparent ${normalizedStop(leafStart, leafEnd, 0.09)}, transparent ${normalizedStop(leafStart, leafEnd, 0.54)}, var(--page-turn-highlight, rgba(255, 255, 255, 0.92)) ${normalizedStop(leafStart, leafEnd, 0.74)}, transparent ${normalizedStop(leafStart, leafEnd, 0.87)}, var(--page-turn-roll-shade, rgba(38, 32, 24, 0.17)) ${normalizedStop(leafStart, leafEnd, 1)})`;
  const bleedAngle = (180 - direction * 2 * tiltDeg).toFixed(1);
  const bleedLayer = `repeating-linear-gradient(${bleedAngle}deg, transparent 0px, transparent 15px, var(--page-turn-bleed, rgba(28, 25, 23, 0.048)) 15px, var(--page-turn-bleed, rgba(28, 25, 23, 0.048)) 20px, transparent 20px, transparent 26px)`;
  const stockLayer = `linear-gradient(${gradAngle.toFixed(1)}deg, var(--page-turn-paper, #f7f5ef), var(--page-turn-paper, #f7f5ef))`;
  const leafBackground = `${sheenLayer}, ${bleedLayer}, ${stockLayer}`;

  const castStart = axisPct(cMid);
  const castEnd = axisPct(castMid);
  const castBackground = `linear-gradient(${gradAngle.toFixed(1)}deg, var(--page-turn-cast, rgba(20, 16, 12, 0.25)) ${normalizedStop(castStart, castEnd, 0)}, color-mix(in srgb, var(--page-turn-cast, rgba(20, 16, 12, 0.25)) 32%, transparent) ${normalizedStop(castStart, castEnd, 0.42)}, transparent ${normalizedStop(castStart, castEnd, 1)})`;

  const underStart = axisPct(underMid);
  const underEnd = axisPct(fMid);
  const underBackground = `linear-gradient(${gradAngle.toFixed(1)}deg, transparent ${normalizedStop(underStart, underEnd, 0)}, color-mix(in srgb, var(--page-turn-under, rgba(20, 16, 12, 0.18)) 40%, transparent) ${normalizedStop(underStart, underEnd, 0.55)}, var(--page-turn-under, rgba(20, 16, 12, 0.18)) ${normalizedStop(underStart, underEnd, 1)})`;

  const spineOpacity = spread
    ? Number((s * (0.35 + 0.65 * Math.exp(-Math.pow((p - 0.5) / 0.28, 2)))).toFixed(3))
    : 0;
  const spineBackground = spread
    ? 'linear-gradient(to right, transparent, var(--page-turn-spine, rgba(28, 25, 23, 0.16)) 50%, transparent)'
    : 'none';

  return {
    active: true,
    progress: p,
    direction,
    unpeeledClip,
    leafClip,
    leafBackground,
    leafOpacity: Number(Math.min(1, s * 6).toFixed(3)),
    castClip,
    castBackground,
    castOpacity: Number((0.95 * s).toFixed(3)),
    underClip,
    underBackground,
    underOpacity: Number((0.9 * s).toFixed(3)),
    spineBackground,
    spineOpacity,
  };
}

function curlPart(shadow: HTMLElement | null, name: string): HTMLElement | null {
  return shadow?.querySelector<HTMLElement>(`[data-curl-part="${name}"]`) ?? null;
}

function applyCurlLayer(
  layer: HTMLElement | null,
  clip: string,
  background: string,
  opacity: number,
): void {
  if (!layer) return;
  layer.style.clipPath = clip === 'none' ? '' : clip;
  layer.style.backgroundImage = background === 'none' ? '' : background;
  layer.style.opacity = String(opacity);
}

/**
 * Applies one frame of `computePaperCurl` to a stationary outgoing surface and
 * its sibling `PageTurnShadow` overlay.
 */
export function applyPaperCurl(
  outgoing: HTMLElement | null,
  shadow: HTMLElement | null,
  progress: number,
  direction: TurnDirection,
  options: { spread?: boolean | undefined } = {},
): PaperCurlGeometry {
  const curl = computePaperCurl(progress, direction, options);
  if (outgoing) {
    outgoing.style.clipPath = curl.unpeeledClip === 'none' ? '' : curl.unpeeledClip;
  }
  applyCurlLayer(curlPart(shadow, 'leaf'), curl.leafClip, curl.leafBackground, curl.leafOpacity);
  applyCurlLayer(
    curlPart(shadow, 'cast-shadow'),
    curl.castClip,
    curl.castBackground,
    curl.castOpacity,
  );
  applyCurlLayer(
    curlPart(shadow, 'under-shadow'),
    curl.underClip,
    curl.underBackground,
    curl.underOpacity,
  );
  const spine = curlPart(shadow, 'spine');
  if (spine) {
    spine.style.backgroundImage = curl.spineBackground === 'none' ? '' : curl.spineBackground;
    spine.style.opacity = String(curl.spineOpacity);
  }
  return curl;
}

/** Clears every curl clip and shading layer so zero geometry state remains after settle. */
export function resetPaperCurl(outgoing: HTMLElement | null, shadow: HTMLElement | null): void {
  if (outgoing) outgoing.style.clipPath = '';
  for (const name of ['leaf', 'cast-shadow', 'under-shadow', 'spine'] as const) {
    const layer = curlPart(shadow, name);
    if (!layer) continue;
    layer.style.opacity = '0';
    layer.style.clipPath = '';
    layer.style.backgroundImage = '';
  }
}

const activeCurlAnimations = new WeakMap<HTMLElement, () => void>();

/**
 * Runs a rAF-interpolated conical paper curl between `from` and `to`, returning
 * an idempotent cancel handle. Resolves immediately to flat under reduced motion.
 */
export function animatePaperCurl({
  outgoing = null,
  shadow,
  direction,
  from = 0,
  to = 1,
  duration = PAGE_CURL_MS,
  spread = false,
  onFinish,
}: {
  outgoing?: HTMLElement | null | undefined;
  shadow: HTMLElement | null;
  direction: TurnDirection;
  from?: number | undefined;
  to?: number | undefined;
  duration?: number | undefined;
  spread?: boolean | undefined;
  onFinish?: (() => void) | undefined;
}): () => void {
  const key = outgoing ?? shadow;
  if (key) activeCurlAnimations.get(key)?.();

  let frame = 0;
  let finished = false;
  const finish = (notify: boolean) => {
    if (finished) return;
    finished = true;
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    if (key) activeCurlAnimations.delete(key);
    resetPaperCurl(outgoing, shadow);
    if (notify) onFinish?.();
  };

  if (
    (!outgoing && !shadow) ||
    prefersReducedMotion() ||
    duration <= 0 ||
    Math.abs(to - from) < 0.001 ||
    typeof window.requestAnimationFrame !== 'function'
  ) {
    finish(true);
    return () => undefined;
  }

  const cancel = () => finish(false);
  if (key) activeCurlAnimations.set(key, cancel);

  applyPaperCurl(outgoing, shadow, from, direction, { spread });
  const started = performance.now();
  const step = () => {
    if (finished) return;
    const t = Math.min((performance.now() - started) / duration, 1);
    const current = from + (to - from) * easeOut(t);
    if (t >= 1) {
      finish(true);
      return;
    }
    applyPaperCurl(outgoing, shadow, current, direction, { spread });
    frame = window.requestAnimationFrame(step);
  };
  frame = window.requestAnimationFrame(step);
  return cancel;
}

/**
 * How each single-surface fallback mode draws the incoming page (`slide`, `fade`,
 * `stack`). `curl` is driven across stationary dual-page surfaces by `animatePaperCurl`
 * rather than rotating the page with `rotateY`.
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
  stack: {
    duration: 240,
    easing: PAGE_SLIDE_EASING,
    keyframes: (direction: TurnDirection): Keyframe[] => [
      { transform: `scale(0.965) translateX(${direction * 16}px)`, opacity: 0.6 },
      { transform: 'scale(1) translateX(0)', opacity: 1 },
    ],
  },
} satisfies Record<Exclude<PageTransition, 'none' | 'curl'>, PageTurnMotion>;

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

/**
 * Shows which way the page turned: the new page slides in from that side, fades
 * in, curls across a stationary surface, or rises from behind. Instant with
 * reduced motion, and never delays the turn itself.
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
  { spread = false }: { spread?: boolean | undefined } = {},
): void {
  if (transition === 'none' || prefersReducedMotion()) return;
  if (transition === 'curl') {
    if (element) cancelPageTurn(element);
    if (shadow) animatePaperCurl({ shadow, direction, spread });
    return;
  }
  if (!element || typeof element.animate !== 'function') return;
  const motion = PAGE_TURN_MOTION[transition];
  cancelPageTurn(element);
  const animation = element.animate(motion.keyframes(direction), {
    duration: motion.duration,
    easing: motion.easing,
  });
  animation.id = PAGE_TURN_ANIMATION_ID;
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
