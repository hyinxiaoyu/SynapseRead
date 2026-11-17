import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type ReactNode, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAPER_CURL_PALETTES } from '@/features/reader/appearance/themes';
import { PageTurnShadow } from './PageTurnShadow';
import {
  animatePageTurn,
  animatePaperCurl,
  applyPaperCurl,
  computePaperCurl,
  directionOf,
  easeOut,
  hasScrollableAncestor,
  hasSelectionIn,
  hasTextSelection,
  isOverContent,
  normalizeWheelDelta,
  PAGE_CURL_MS,
  PAGE_TURN_ANIMATION_ID,
  type PageTurnGestures,
  resetPaperCurl,
  rubberBand,
  SCRUB_COMMIT_FRACTION,
  SCRUB_COMMIT_MAX_PX,
  SCRUB_COMMIT_MIN_PX,
  SCRUB_COMMIT_VELOCITY,
  SCRUB_IDLE_MS,
  scrubCommitDistance,
  slideScroll,
  SWIPE_THRESHOLD_PX,
  type TurnDirection,
  usePageTurnGestures,
  type UsePageTurnGesturesOptions,
  VerticalWheelTurn,
  WHEEL_LINE_PX,
  type WheelSample,
  WheelScrub,
  zoneAt,
} from './pageTurn';
import { PageTurnChevrons } from './PageTurnChevrons';

describe('zoneAt', () => {
  const page = { left: 100, width: 1000 };

  it('turns back in the left 12% and forward in the right 12%, beside the page too', () => {
    expect(zoneAt(150, page)).toBe('previous');
    expect(zoneAt(20, page)).toBe('previous');
    expect(zoneAt(1050, page)).toBe('next');
    expect(zoneAt(1500, page)).toBe('next');
    expect(zoneAt(600, page)).toBeNull();
    expect(zoneAt(230, page)).toBeNull();
    expect(zoneAt(150, { left: 0, width: 0 })).toBeNull();
  });
});

describe('rubberBand', () => {
  it('follows the fingers at first and then ever less, never past the limit', () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(10, 100)).toBeGreaterThan(9);
    expect(rubberBand(10, 100)).toBeLessThan(10);
    expect(rubberBand(-10, 100)).toBeLessThan(-9);
    expect(rubberBand(1000, 100)).toBeLessThan(100);
    expect(rubberBand(-1000, 100)).toBeGreaterThan(-100);
    // A page with no width cannot be dragged anywhere.
    expect(rubberBand(50, 0)).toBe(0);
  });
});

describe('normalizeWheelDelta', () => {
  it('converts pixel, line, and page wheel deltas to CSS pixels', () => {
    expect(normalizeWheelDelta(25, undefined, 600)).toBe(25);
    expect(normalizeWheelDelta(-40, 0, 600)).toBe(-40);
    expect(normalizeWheelDelta(2, 1, 600)).toBe(2 * WHEEL_LINE_PX);
    expect(normalizeWheelDelta(-1, 2, 600)).toBe(-600);
    expect(normalizeWheelDelta(1, 2, 0)).toBe(800);
  });
});

describe('scrubCommitDistance', () => {
  it('clamps 18% of the page width to 50–160 px', () => {
    expect(scrubCommitDistance(200)).toBe(SCRUB_COMMIT_MIN_PX);
    expect(scrubCommitDistance(277)).toBe(SCRUB_COMMIT_MIN_PX);
    expect(scrubCommitDistance(600)).toBe(108);
    expect(scrubCommitDistance(889)).toBe(SCRUB_COMMIT_MAX_PX);
    expect(scrubCommitDistance(2000)).toBe(SCRUB_COMMIT_MAX_PX);
    // A page with no measured width still needs the minimum drag.
    expect(scrubCommitDistance(0)).toBe(SCRUB_COMMIT_MIN_PX);
  });
});

describe('WheelScrub', () => {
  const WIDTH = 1000;
  const context = (canTurn: (direction: 1 | -1) => boolean = () => true) => ({
    pageWidth: () => WIDTH,
    canTurn,
  });
  const contextOf = (width: number, canTurn: (direction: 1 | -1) => boolean = () => true) => ({
    pageWidth: () => width,
    canTurn,
  });
  const make = () => new WheelScrub();
  const push = (
    scrub: WheelScrub,
    deltaX: number,
    at: number,
    canTurn: (direction: 1 | -1) => boolean = () => true,
  ) => scrub.push(deltaX, at, context(canTurn));

  /** Feeds a run of wheel events 16 ms apart, starting at `from`. */
  const run = (
    scrub: WheelScrub,
    deltas: number[],
    from = 0,
    canTurn: (direction: 1 | -1) => boolean = () => true,
  ) => {
    const updates = [];
    let at = from;
    for (const deltaX of deltas) {
      updates.push(...push(scrub, deltaX, at, canTurn));
      at += 16;
    }
    return { updates, at };
  };

  it('reports the start and then follows the fingers 1:1', () => {
    const scrub = make();
    const { updates } = run(scrub, [12, 12, 12]);
    expect(updates[0]).toEqual({ kind: 'start' });
    expect(updates.filter((update) => update.kind === 'move')).toEqual([
      { kind: 'move', displacement: 12 },
      { kind: 'move', displacement: 24 },
      { kind: 'move', displacement: 36 },
    ]);
  });

  it('keeps following the fingers until the moving surface is dragged, not the page', () => {
    const scrub = make();
    const wideSurface = {
      // A 640 px reading measure inside a 1600 px slide pane.
      pageWidth: () => 640,
      surfaceWidth: () => 1600,
      canTurn: () => true,
    };
    const updates = [];
    let at = 0;
    for (let event = 0; event < 40; event += 1) {
      updates.push(...scrub.push(20, at, wideSurface));
      at += 16;
    }
    // 800 px is past the 640 px measure but well short of the 1600 px pane.
    expect(updates.some((update) => update.kind === 'end')).toBe(false);
    expect(updates.filter((update) => update.kind === 'move').at(-1)).toEqual({
      kind: 'move',
      displacement: 800,
    });
    // A full pane drag finishes the gesture under the fingers.
    expect(scrub.push(800, at, wideSurface)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);
  });

  it('commits on release once a fifth of the page has been dragged', () => {
    const scrub = make();
    const { at } = run(
      scrub,
      Array.from({ length: 20 }, () => 10),
    );
    const released = scrub.release(at + SCRUB_IDLE_MS);
    expect(released).toEqual([{ kind: 'end', velocity: expect.any(Number), committed: 1 }]);
    // 200 px of 1000 is past the 160 px the clamped release needs.
    expect(SCRUB_COMMIT_FRACTION * WIDTH).toBeLessThan(200);
  });

  it('commits a 200 px drag on a 2000 px page, because the threshold is clamped to 160 px', () => {
    const scrub = make();
    const wide = contextOf(2000);
    let at = 0;
    for (let event = 0; event < 10; event += 1) {
      scrub.push(20, at, wide);
      at += 50;
    }
    // 200 px of travel released 90 ms after the last event. The measured release
    // speed is 0.4 px/ms, under the velocity threshold, so only the clamped
    // distance can commit it: unclamped, 18% of 2000 px would need 360 px.
    const [end] = scrub.release(at - 50 + SCRUB_IDLE_MS);
    expect(end).toMatchObject({ kind: 'end', committed: 1 });
    if (end?.kind === 'end') expect(end.velocity).toBeCloseTo(0.4);
  });

  it('raises the release distance to 50 px on a page narrower than 278 px', () => {
    const narrow = contextOf(200);
    // 18% of 200 px is 36 px, below the clamp: 40 px of slow travel must not turn.
    const short = make();
    for (let event = 0; event < 5; event += 1) short.push(8, event * 20, narrow);
    expect(short.release(80 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);

    // 56 px is past the clamp, and still slow enough that only distance commits it.
    const long = make();
    for (let event = 0; event < 7; event += 1) long.push(8, event * 20, narrow);
    expect(long.release(120 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);
  });

  it('uses 18% of the width between the clamps', () => {
    const page = contextOf(600);
    // 18% of 600 px is 108 px: 100 px of slow travel is short of it...
    const short = make();
    for (let event = 0; event < 10; event += 1) short.push(10, event * 30, page);
    expect(short.release(270 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);

    // ...and 110 px reaches it.
    const reached = make();
    for (let event = 0; event < 11; event += 1) reached.push(10, event * 30, page);
    expect(reached.release(300 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);
  });

  it('caps the release distance at 160 px on a wide page', () => {
    const wide = contextOf(2000);
    // 150 px of slow travel is short of the 160 px cap...
    const short = make();
    for (let event = 0; event < 15; event += 1) short.push(10, event * 30, wide);
    expect(short.release(420 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);

    // ...and 160 px reaches it, even though 18% of 2000 px would be 360 px.
    const reached = make();
    for (let event = 0; event < 16; event += 1) reached.push(10, event * 30, wide);
    expect(reached.release(450 + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);
  });

  it('springs back when the fingers stop short of the threshold', () => {
    const scrub = make();
    // Slow: 4 px every 16 ms is 0.25 px/ms, under the release speed.
    const { at } = run(
      scrub,
      Array.from({ length: 10 }, () => 4),
    );
    expect(scrub.release(at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);
  });

  it('commits a short but fast flick on release velocity alone', () => {
    const scrub = make();
    // 12 px per 16 ms is 0.75 px/ms, well over the 0.45 the release needs.
    const { at } = run(scrub, [12, 12, 12]);
    expect(SCRUB_COMMIT_VELOCITY).toBeLessThan(0.75);
    expect(scrub.release(at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);

    const backward = make();
    const back = run(backward, [-12, -12, -12]);
    expect(backward.release(back.at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: -1 },
    ]);
  });

  it('cancels when a scrub returns to zero even with fast return velocity', () => {
    const wideSurface = {
      pageWidth: () => 1000,
      surfaceWidth: () => 1728,
      canTurn: () => true,
    };
    const scrubOutAndBack = (outSteps: number, backSteps: number, delta = -20) => {
      const scrub = make();
      let at = 0;
      for (const [steps, stepDelta] of [
        [outSteps, delta],
        [backSteps, -delta],
      ] as const) {
        for (let step = 0; step < steps; step += 1) {
          scrub.push(stepDelta, at, wideSurface);
          if (step % 20 === 19) at += 1;
        }
      }
      return scrub.release(at + SCRUB_IDLE_MS);
    };

    const returnedToZero = scrubOutAndBack(70, 70);
    expect(returnedToZero).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);
    if (returnedToZero[0]?.kind === 'end') {
      expect(returnedToZero[0].velocity).toBeGreaterThanOrEqual(SCRUB_COMMIT_VELOCITY);
    }
    expect(scrubOutAndBack(70, 70, 20)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);

    // Returning nearly to zero (small non-zero travel opposite the return velocity) also cancels.
    expect(scrubOutAndBack(70, 69)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);
    expect(scrubOutAndBack(70, 69, 20)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);
  });

  it('rubber-bands and refuses to commit at the end of the document', () => {
    const scrub = make();
    const canTurn = (direction: 1 | -1) => direction === -1;
    const { updates, at } = run(
      scrub,
      Array.from({ length: 40 }, () => 30),
      0,
      canTurn,
    );
    const moves = updates.filter((update) => update.kind === 'move');
    const last = moves.at(-1);
    expect(last).toBeDefined();
    // 1200 px of travel, but the page only leans by the rubber-band limit.
    expect(last).toMatchObject({ kind: 'move' });
    if (last?.kind === 'move') {
      expect(last.displacement).toBeGreaterThan(0);
      expect(last.displacement).toBeLessThan(WIDTH * 0.35);
    }
    expect(scrub.release(at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: null },
    ]);
  });

  it('turns under the fingers once a whole page is dragged, then absorbs the tail', () => {
    const scrub = make();
    const { updates, at } = run(
      scrub,
      Array.from({ length: 40 }, () => 30),
    );
    const ends = updates.filter((update) => update.kind === 'end');
    expect(ends).toEqual([{ kind: 'end', velocity: expect.any(Number), committed: 1 }]);
    // Everything after that is inertia, and must not turn another page.
    expect(run(scrub, [8, 6, 4, 3, 2, 1], at).updates).toEqual([]);
  });

  it('starts a new scrub on a faster event, without waiting out the tail', () => {
    const scrub = make();
    const { at } = run(
      scrub,
      Array.from({ length: 40 }, () => 30),
    );
    expect(push(scrub, 4, at)).toEqual([]);
    // 40 px is more than 1.6 × 4 + 2: a new physical flick.
    expect(push(scrub, 40, at + 16)).toEqual([
      { kind: 'start' },
      { kind: 'move', displacement: 40 },
    ]);
  });

  it('starts a new scrub when the fingers reverse', () => {
    const scrub = make();
    const { at } = run(
      scrub,
      Array.from({ length: 40 }, () => 30),
    );
    expect(push(scrub, -3, at)).toEqual([{ kind: 'start' }, { kind: 'move', displacement: -3 }]);
  });

  it('returns to idle once the tail has died away', () => {
    const scrub = make();
    const { at } = run(
      scrub,
      Array.from({ length: 40 }, () => 30),
    );
    expect(scrub.release(at + SCRUB_IDLE_MS)).toEqual([]);
    // Idle again: the next event begins a fresh scrub rather than being absorbed.
    expect(push(scrub, 3, at + 500)).toEqual([
      { kind: 'start' },
      { kind: 'move', displacement: 3 },
    ]);
  });

  it('forgets a gesture on reset', () => {
    const scrub = make();
    run(scrub, [20, 20, 20]);
    scrub.reset();
    expect(push(scrub, 5, 1000)).toEqual([{ kind: 'start' }, { kind: 'move', displacement: 5 }]);
  });

  it('knows a scrub still under the fingers from one that already turned', () => {
    const scrub = make();
    expect(scrub.isDragging()).toBe(false);
    push(scrub, 20, 0);
    expect(scrub.isDragging()).toBe(true);
    // A gesture that turned under the fingers is settling, not dragging: the page
    // must not be pulled back off the turn it already made.
    run(
      scrub,
      Array.from({ length: 40 }, () => 30),
      16,
    );
    expect(scrub.isDragging()).toBe(false);
  });

  it('measures the page once per gesture', () => {
    const pageWidth = vi.fn(() => WIDTH);
    const scrub = new WheelScrub();
    for (let event = 0; event < 5; event += 1) {
      scrub.push(10, event * 16, { pageWidth, canTurn: () => true });
    }
    expect(pageWidth).toHaveBeenCalledTimes(1);
  });

  it('commits an isolated single-sample swipe past SWIPE_THRESHOLD_PX', () => {
    const notch = make();
    push(notch, SWIPE_THRESHOLD_PX + 10, 0);
    expect(notch.release(SCRUB_IDLE_MS)).toEqual([{ kind: 'end', velocity: 0, committed: 1 }]);

    const short = make();
    push(short, SWIPE_THRESHOLD_PX - 20, 0);
    expect(short.release(SCRUB_IDLE_MS)).toEqual([{ kind: 'end', velocity: 0, committed: null }]);
  });

  it('returns to idle after a release commit so a later same-speed swipe still turns', () => {
    const scrub = make();
    const first = run(
      scrub,
      Array.from({ length: 8 }, () => 30),
      0,
    );
    expect(scrub.release(first.at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);

    const secondStart = first.at + SCRUB_IDLE_MS + 50;
    const second = run(
      scrub,
      Array.from({ length: 8 }, () => 30),
      secondStart,
    );
    expect(second.updates[0]).toEqual({ kind: 'start' });
    expect(scrub.release(second.at + SCRUB_IDLE_MS)).toEqual([
      { kind: 'end', velocity: expect.any(Number), committed: 1 },
    ]);
  });
});

describe('directionOf', () => {
  it('reads a forward drag as the next page', () => {
    expect(directionOf(1)).toBe(1);
    expect(directionOf(0)).toBe(1);
    expect(directionOf(-1)).toBe(-1);
  });
});

function Probe({
  onTurn,
  enabled = true,
  expose,
  scrub,
  canTurn,
  hasSelection,
  verticalWheel,
  children,
}: {
  onTurn: (direction: TurnDirection) => void;
  enabled?: boolean;
  expose: (gestures: PageTurnGestures) => void;
  scrub?: {
    start: () => void;
    move: (displacement: number) => void;
    end: (velocity: number, committed: TurnDirection | null) => void;
  };
  canTurn?: UsePageTurnGesturesOptions['canTurn'];
  hasSelection?: UsePageTurnGesturesOptions['hasSelection'];
  verticalWheel?: UsePageTurnGesturesOptions['verticalWheel'];
  children?: ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  expose(
    usePageTurnGestures({
      enabled,
      areaRef,
      onTurn,
      ...(canTurn === undefined ? {} : { canTurn }),
      ...(hasSelection === undefined ? {} : { hasSelection }),
      ...(verticalWheel === undefined ? {} : { verticalWheel }),
      ...(scrub === undefined
        ? {}
        : {
            onScrubStart: scrub.start,
            onScrubMove: scrub.move,
            onScrubEnd: scrub.end,
          }),
    }),
  );
  return (
    <div ref={areaRef} data-testid="area">
      {children}
    </div>
  );
}

/** A page that only reports turns, with no scrub callbacks of its own. */
function PlainProbe({
  onTurn,
  expose,
}: {
  onTurn: (direction: 1 | -1) => void;
  expose: (gestures: PageTurnGestures) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  expose(usePageTurnGestures({ enabled: true, areaRef, onTurn }));
  return <div ref={areaRef} data-testid="area" />;
}

describe('usePageTurnGestures', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = (enabled = true, canTurn?: (direction: 1 | -1) => boolean) => {
    const onTurn = vi.fn();
    const scrub = { start: vi.fn(), move: vi.fn(), end: vi.fn() };
    let gestures: PageTurnGestures | null = null;
    const view = render(
      <Probe
        onTurn={onTurn}
        enabled={enabled}
        expose={(value) => (gestures = value)}
        scrub={scrub}
        {...(canTurn === undefined ? {} : { canTurn })}
      />,
    );
    vi.spyOn(
      view.container.firstElementChild as HTMLElement,
      'getBoundingClientRect',
    ).mockReturnValue(new DOMRect(0, 0, 1000, 600));
    return { onTurn, scrub, gestures: () => gestures as unknown as PageTurnGestures };
  };

  it('ignores a drag, a click that ends a selection, and one that dismisses it', () => {
    const { onTurn, gestures } = mount();
    act(() => {
      gestures().handleSample({ kind: 'down', x: 950, y: 100, hasSelection: false });
      gestures().handleSample({
        kind: 'click',
        x: 990,
        y: 140,
        overContent: false,
        hasSelection: false,
      });
      gestures().handleSample({ kind: 'down', x: 950, y: 100, hasSelection: true });
      gestures().handleSample({
        kind: 'click',
        x: 950,
        y: 100,
        overContent: false,
        hasSelection: false,
      });
      gestures().handleSample({ kind: 'down', x: 950, y: 100, hasSelection: false });
      gestures().handleSample({
        kind: 'click',
        x: 950,
        y: 100,
        overContent: false,
        hasSelection: true,
      });
    });
    expect(onTurn).not.toHaveBeenCalled();
    act(() => {
      gestures().handleSample({ kind: 'down', x: 950, y: 100, hasSelection: false });
      gestures().handleSample({
        kind: 'click',
        x: 951,
        y: 101,
        overContent: false,
        hasSelection: false,
      });
    });
    expect(onTurn).toHaveBeenCalledWith(1);
  });

  it('scrubs live, then commits a long swipe on release', () => {
    vi.useFakeTimers();
    const { scrub, onTurn, gestures } = mount();
    act(() => {
      for (let event = 0; event < 20; event += 1) {
        expect(gestures().handleWheel({ deltaX: 10, deltaY: 0, ctrlKey: false })).toBe(true);
      }
    });
    expect(scrub.start).toHaveBeenCalledTimes(1);
    expect(scrub.move).toHaveBeenCalledTimes(20);
    expect(scrub.move).toHaveBeenLastCalledWith(200);
    expect(scrub.end).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(scrub.end).toHaveBeenCalledWith(expect.any(Number), 1);
    // The viewer commits the turn itself, from where the fingers left it.
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('springs back when a slow swipe stops short', () => {
    vi.useFakeTimers();
    const { scrub, gestures } = mount();
    act(() => {
      for (let event = 0; event < 6; event += 1) {
        gestures().handleWheel({ deltaX: 4, deltaY: 0, ctrlKey: false });
      }
    });
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(scrub.end).toHaveBeenCalledWith(expect.any(Number), null);
  });

  it('turns once per flick, and again on a fresh flick without waiting for quiet', () => {
    vi.useFakeTimers();
    const { scrub, gestures } = mount();
    const flick = (deltaX: number) => {
      for (let event = 0; event < 40; event += 1) {
        gestures().handleWheel({ deltaX, deltaY: 0, ctrlKey: false });
      }
    };
    act(() => flick(30));
    expect(scrub.end).toHaveBeenCalledTimes(1);
    expect(scrub.end).toHaveBeenLastCalledWith(expect.any(Number), 1);
    // The inertial tail is absorbed, not turned into another page.
    act(() => {
      for (const deltaX of [8, 6, 4, 3, 2, 1]) {
        gestures().handleWheel({ deltaX, deltaY: 0, ctrlKey: false });
      }
    });
    expect(scrub.end).toHaveBeenCalledTimes(1);
    // A new flick of the other way turns back at once, with no 300 ms lockout.
    act(() => flick(-30));
    expect(scrub.end).toHaveBeenCalledTimes(2);
    expect(scrub.end).toHaveBeenLastCalledWith(expect.any(Number), -1);
  });

  it('turns a committed swipe even without scrub callbacks', () => {
    vi.useFakeTimers();
    const onTurn = vi.fn();
    let gestures: PageTurnGestures | null = null;
    const view = render(<PlainProbe onTurn={onTurn} expose={(value) => (gestures = value)} />);
    vi.spyOn(
      view.container.firstElementChild as HTMLElement,
      'getBoundingClientRect',
    ).mockReturnValue(new DOMRect(0, 0, 1000, 600));
    act(() => {
      for (let event = 0; event < 20; event += 1) {
        (gestures as unknown as PageTurnGestures).handleWheel({
          deltaX: 10,
          deltaY: 0,
          ctrlKey: false,
        });
      }
    });
    expect(onTurn).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(onTurn).toHaveBeenCalledWith(1);
  });

  it('does not swipe vertically, with a pinch, or when disabled', () => {
    vi.useFakeTimers();
    const { scrub, gestures } = mount();
    expect(gestures().handleWheel({ deltaX: 10, deltaY: 40, ctrlKey: false })).toBe(false);
    expect(gestures().handleWheel({ deltaX: 90, deltaY: 0, ctrlKey: true })).toBe(false);
    expect(scrub.start).not.toHaveBeenCalled();

    const disabled = mount(false);
    act(() => {
      for (let event = 0; event < 10; event += 1) {
        disabled.gestures().handleWheel({ deltaX: 30, deltaY: 0, ctrlKey: false });
      }
    });
    expect(disabled.scrub.start).not.toHaveBeenCalled();
  });

  it('rubber-bands toward the end of the document', () => {
    vi.useFakeTimers();
    const { scrub, gestures } = mount(true, (direction) => direction === -1);
    act(() => {
      for (let event = 0; event < 40; event += 1) {
        gestures().handleWheel({ deltaX: 30, deltaY: 0, ctrlKey: false });
      }
    });
    const last = scrub.move.mock.calls.at(-1)?.[0] as number;
    expect(last).toBeLessThan(1000 * 0.35);
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(scrub.end).toHaveBeenLastCalledWith(expect.any(Number), null);
  });

  it('turns once per discrete Windows pixel notch while idle without scrubbing', () => {
    const { onTurn, scrub, gestures } = mount();
    act(() => {
      expect(gestures().handleWheel({ deltaX: 120, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(
        true,
      );
      expect(
        gestures().handleWheel({ deltaX: -100, deltaY: 0, deltaMode: 0, ctrlKey: false }),
      ).toBe(true);
    });
    expect(scrub.start).not.toHaveBeenCalled();
    expect(onTurn).toHaveBeenNthCalledWith(1, 1);
    expect(onTurn).toHaveBeenNthCalledWith(2, -1);
  });

  it('reads a fast flick that starts past the notch size as one flick, not five notches', () => {
    vi.useFakeTimers();
    const { onTurn, scrub, gestures } = mount();
    // A plausible decaying trackpad sequence at about one event a frame. Its first
    // events are as large as a mouse notch, but the whole run is one physical flick.
    act(() => {
      for (const deltaX of [120, 110, 100, 90, 65, 40]) {
        expect(gestures().handleWheel({ deltaX, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(
          true,
        );
        vi.advanceTimersByTime(16);
      }
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);
    // The tail was absorbed, so it never started a scrub of its own either.
    expect(scrub.start).not.toHaveBeenCalled();
    expect(scrub.end).not.toHaveBeenCalled();
  });

  it('absorbs a tail that wobbles back up a little, without turning again', () => {
    vi.useFakeTimers();
    const { onTurn, scrub, gestures } = mount();
    // Real inertia is not monotonic: it dies away with small upward wobbles. The
    // 2 px bump from 110 to 112 is still the same flick, not a second notch.
    act(() => {
      for (const deltaX of [120, 110, 112, 100, 90, 65, 40]) {
        expect(gestures().handleWheel({ deltaX, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(
          true,
        );
        vi.advanceTimersByTime(16);
      }
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);
    expect(scrub.start).not.toHaveBeenCalled();
  });

  it('turns again when an event overtakes the peak the gesture started at', () => {
    vi.useFakeTimers();
    const { onTurn, gestures } = mount();
    act(() => {
      gestures().handleWheel({ deltaX: 120, deltaY: 0, deltaMode: 0, ctrlKey: false });
      vi.advanceTimersByTime(16);
      // Inertia never grows past its own peak, so this is a new physical notch.
      gestures().handleWheel({ deltaX: 130, deltaY: 0, deltaMode: 0, ctrlKey: false });
    });
    expect(onTurn).toHaveBeenCalledTimes(2);
  });

  it('turns a page for each genuine wheel notch, however fast it is spun', () => {
    vi.useFakeTimers();
    const { onTurn, gestures } = mount();
    act(() => {
      for (let notch = 0; notch < 3; notch += 1) {
        gestures().handleWheel({ deltaX: 120, deltaY: 0, deltaMode: 0, ctrlKey: false });
        vi.advanceTimersByTime(16);
      }
    });
    // Equal, not decaying: each one is a deliberate notch, not inertia.
    expect(onTurn).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(SCRUB_IDLE_MS + 10);
      gestures().handleWheel({ deltaX: 120, deltaY: 0, deltaMode: 0, ctrlKey: false });
    });
    expect(onTurn).toHaveBeenCalledTimes(4);
  });

  it('cancels the scrub it was in the middle of when the reader loses focus', () => {
    vi.useFakeTimers();
    const onTurn = vi.fn();
    const scrub = { start: vi.fn(), move: vi.fn(), end: vi.fn() };
    let gestures: PageTurnGestures | null = null;
    const expose = (value: PageTurnGestures) => (gestures = value);
    const view = render(<Probe onTurn={onTurn} enabled expose={expose} scrub={scrub} />);
    vi.spyOn(
      view.container.firstElementChild as HTMLElement,
      'getBoundingClientRect',
    ).mockReturnValue(new DOMRect(0, 0, 1000, 600));
    act(() => {
      (gestures as unknown as PageTurnGestures).handleWheel({
        deltaX: 60,
        deltaY: 0,
        ctrlKey: false,
      });
    });
    expect(scrub.start).toHaveBeenCalledTimes(1);
    expect(scrub.move).toHaveBeenLastCalledWith(60);

    // Switching tabs drops the gesture without a release: the viewer is only told
    // to undo its displacement by a cancelled `end`.
    view.rerender(<Probe onTurn={onTurn} enabled={false} expose={expose} scrub={scrub} />);
    expect(scrub.end).toHaveBeenCalledTimes(1);
    expect(scrub.end).toHaveBeenCalledWith(0, null);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('normalizes line-mode wheel events and accumulates sub-line ticks', () => {
    vi.useFakeTimers();
    const { onTurn, scrub, gestures } = mount();
    act(() => {
      expect(gestures().handleWheel({ deltaX: 1, deltaY: 0, deltaMode: 1, ctrlKey: false })).toBe(
        true,
      );
    });
    expect(scrub.start).not.toHaveBeenCalled();
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenLastCalledWith(1);

    act(() => {
      gestures().handleWheel({ deltaX: -0.5, deltaY: 0, deltaMode: 1, ctrlKey: false });
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    act(() => {
      gestures().handleWheel({ deltaX: -0.5, deltaY: 0, deltaMode: 1, ctrlKey: false });
    });
    expect(onTurn).toHaveBeenCalledTimes(2);
    expect(onTurn).toHaveBeenLastCalledWith(-1);

    // An abandoned partial tick expires after idle silence.
    act(() => {
      gestures().handleWheel({ deltaX: 0.5, deltaY: 0, deltaMode: 1, ctrlKey: false });
    });
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    act(() => {
      gestures().handleWheel({ deltaX: 0.5, deltaY: 0, deltaMode: 1, ctrlKey: false });
    });
    expect(onTurn).toHaveBeenCalledTimes(2);
  });

  it('normalizes page-mode wheel events and respects boundaries', () => {
    const allowed = mount();
    act(() => {
      expect(
        allowed.gestures().handleWheel({ deltaX: 1, deltaY: 0, deltaMode: 2, ctrlKey: false }),
      ).toBe(true);
    });
    expect(allowed.onTurn).toHaveBeenCalledWith(1);

    const atEnd = mount(true, (direction) => direction < 0);
    act(() => {
      expect(
        atEnd.gestures().handleWheel({ deltaX: 1, deltaY: 0, deltaMode: 2, ctrlKey: false }),
      ).toBe(true);
    });
    expect(atEnd.onTurn).not.toHaveBeenCalled();
  });
});

describe('VerticalWheelTurn', () => {
  it('accumulates sub-threshold travel and commits once at WHEEL_LINE_PX', () => {
    const controller = new VerticalWheelTurn();
    expect(controller.isActive(0)).toBe(false);
    expect(controller.push(15, 0)).toBeNull();
    expect(controller.isActive(0)).toBe(true);
    expect(controller.push(15, 16)).toBeNull();
    expect(controller.push(15, 32)).toBe(1);
    expect(controller.isActive(32)).toBe(true);
    expect(controller.release(32 + SCRUB_IDLE_MS)).toBeNull();
    expect(controller.isActive(32 + SCRUB_IDLE_MS)).toBe(false);
  });

  it('absorbs an accelerating trackpad ramp-up and decaying inertia as one turn', () => {
    const controller = new VerticalWheelTurn();
    const turns: TurnDirection[] = [];
    const sequence = [4, 10, 22, 45, 95, 110, 80, 50, 30, 15, 5];
    sequence.forEach((deltaY, index) => {
      const result = controller.push(deltaY, index * 16);
      if (result !== null) turns.push(result);
    });
    expect(turns).toEqual([1]);
    expect(controller.release(sequence.length * 16 + SCRUB_IDLE_MS)).toBeNull();
  });

  it('absorbs small upward wobbles in a decaying inertial tail', () => {
    const controller = new VerticalWheelTurn();
    const turns: TurnDirection[] = [];
    for (const [index, deltaY] of [15, 30, 45, 30, 32, 20, 10].entries()) {
      const result = controller.push(deltaY, index * 16);
      if (result !== null) turns.push(result);
    }
    expect(turns).toEqual([1]);
  });

  it('breaks settling immediately on direction reversal and starts a new turn', () => {
    const controller = new VerticalWheelTurn();
    expect(controller.push(25, 0)).toBeNull();
    expect(controller.push(25, 16)).toBe(1);
    // Reversal immediately breaks SETTLING and commits backward once -40px is reached.
    expect(controller.push(-20, 32)).toBeNull();
    expect(controller.push(-25, 48)).toBe(-1);
  });

  it('starts a new turn when a second physical impulse spikes past decayed tail', () => {
    const controller = new VerticalWheelTurn();
    const turns: TurnDirection[] = [];
    for (const [index, deltaY] of [30, 30, 20, 5, 25, 30].entries()) {
      const result = controller.push(deltaY, index * 16);
      if (result !== null) turns.push(result);
    }
    expect(turns).toEqual([1, 1]);
  });

  it('commits isolated slow mouse detents >= 12px and fast flicks on release, ignoring tiny touches', () => {
    const detent = new VerticalWheelTurn();
    expect(detent.push(15, 0, 0)).toBeNull();
    expect(detent.release(SCRUB_IDLE_MS)).toBe(1);

    const diagonalTouch = new VerticalWheelTurn();
    expect(diagonalTouch.push(15, 0, 2)).toBeNull();
    expect(diagonalTouch.release(SCRUB_IDLE_MS)).toBeNull();

    const tinyTouch = new VerticalWheelTurn();
    expect(tinyTouch.push(8, 0, 0)).toBeNull();
    expect(tinyTouch.release(SCRUB_IDLE_MS)).toBeNull();

    const fastFlick = new VerticalWheelTurn();
    expect(fastFlick.push(10, 0, 1)).toBeNull();
    expect(fastFlick.push(10, 10, 1)).toBeNull();
    expect(fastFlick.push(10, 20, 1)).toBeNull();
    expect(fastFlick.release(20 + SCRUB_IDLE_MS)).toBe(1);

    const slowShortDrag = new VerticalWheelTurn();
    expect(slowShortDrag.push(8, 0, 1)).toBeNull();
    expect(slowShortDrag.push(8, 35, 1)).toBeNull();
    expect(slowShortDrag.push(8, 70, 1)).toBeNull();
    expect(slowShortDrag.release(70 + SCRUB_IDLE_MS)).toBeNull();
  });

  it('expires stale accumulation after SCRUB_IDLE_MS and clears on reset', () => {
    const controller = new VerticalWheelTurn();
    expect(controller.push(25, 0)).toBeNull();
    expect(controller.push(25, SCRUB_IDLE_MS + 10)).toBeNull();
    controller.reset();
    expect(controller.isActive()).toBe(false);
  });
});

describe('hasScrollableAncestor', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('detects scrollable nested ancestors and [data-no-page-turn] strictly inside boundary', () => {
    const boundary = document.createElement('div');
    const scrollable = document.createElement('div');
    scrollable.style.overflowY = 'auto';
    Object.defineProperty(scrollable, 'clientHeight', { value: 120, configurable: true });
    Object.defineProperty(scrollable, 'scrollHeight', { value: 360, configurable: true });
    const inner = document.createElement('p');
    const text = document.createTextNode('Code line');
    inner.append(text);
    scrollable.append(inner);

    const nonOverflowing = document.createElement('div');
    nonOverflowing.style.overflowY = 'scroll';
    Object.defineProperty(nonOverflowing, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(nonOverflowing, 'scrollHeight', { value: 200, configurable: true });
    const child = document.createElement('span');
    nonOverflowing.append(child);

    const blocked = document.createElement('div');
    blocked.setAttribute('data-no-page-turn', '');
    const blockedChild = document.createElement('span');
    blocked.append(blockedChild);

    boundary.append(scrollable, nonOverflowing, blocked);
    document.body.append(boundary);

    expect(hasScrollableAncestor(null, boundary)).toBe(false);
    expect(hasScrollableAncestor(boundary, boundary)).toBe(false);
    expect(hasScrollableAncestor(inner, boundary)).toBe(true);
    expect(hasScrollableAncestor(text, boundary)).toBe(true);
    expect(hasScrollableAncestor(child, boundary)).toBe(false);
    expect(hasScrollableAncestor(blockedChild, boundary)).toBe(true);

    // Even if boundary itself is scrollable (like PdfViewer scrollRef), boundary is ignored.
    boundary.style.overflowY = 'scroll';
    Object.defineProperty(boundary, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(boundary, 'scrollHeight', { value: 900, configurable: true });
    expect(hasScrollableAncestor(child, boundary)).toBe(false);
  });

  it('stops before body/documentElement in cross-realm documents without instanceof', () => {
    const boundary = document.createElement('div');
    const chapterDoc = document.implementation.createHTMLDocument('chapter');
    chapterDoc.body.style.overflowY = 'auto';
    Object.defineProperty(chapterDoc.body, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(chapterDoc.body, 'scrollHeight', { value: 1200, configurable: true });

    const paragraph = chapterDoc.createElement('p');
    const pre = chapterDoc.createElement('pre');
    pre.style.overflowY = 'overlay';
    Object.defineProperty(pre, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(pre, 'scrollHeight', { value: 260, configurable: true });
    const codeText = chapterDoc.createTextNode('const x = 1;');
    pre.append(codeText);
    chapterDoc.body.append(paragraph, pre);

    const fakeView = {
      getComputedStyle: (el: Element) => ({
        overflowY: (el as HTMLElement).style.overflowY || 'visible',
      }),
    } as unknown as Window;
    Object.defineProperty(chapterDoc, 'defaultView', { value: fakeView, configurable: true });

    expect(hasScrollableAncestor(chapterDoc.body, boundary)).toBe(false);
    expect(hasScrollableAncestor(paragraph, boundary)).toBe(false);
    expect(hasScrollableAncestor(codeText, boundary)).toBe(true);
  });
});

describe('usePageTurnGestures consecutive clicks (#107) and vertical wheel (#106)', () => {
  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mountWith = (
    options: Partial<Omit<UsePageTurnGesturesOptions, 'areaRef' | 'onTurn'>> & {
      children?: ReactNode;
    } = {},
  ) => {
    const onTurn = vi.fn();
    const scrub = { start: vi.fn(), move: vi.fn(), end: vi.fn() };
    let gestures: PageTurnGestures | null = null;
    const { children, ...rest } = options;
    const view = render(
      <Probe onTurn={onTurn} expose={(value) => (gestures = value)} scrub={scrub} {...rest}>
        {children}
      </Probe>,
    );
    const area = view.getByTestId('area');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    return {
      view,
      area,
      onTurn,
      scrub,
      gestures: () => gestures as unknown as PageTurnGestures,
    };
  };

  it('turns on consecutive blank-edge clicks including detail 2 and 3', () => {
    const { area, onTurn } = mountWith();

    for (const detail of [1, 2, 3]) {
      fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 120 });
      fireEvent.click(area, { button: 0, detail, clientX: 950, clientY: 120 });
    }
    expect(onTurn).toHaveBeenCalledTimes(3);
    expect(onTurn.mock.calls).toEqual([[1], [1], [1]]);

    onTurn.mockClear();
    for (const detail of [1, 2, 3]) {
      fireEvent.pointerDown(area, { button: 0, clientX: 40, clientY: 120 });
      fireEvent.click(area, { button: 0, detail, clientX: 40, clientY: 120 });
    }
    expect(onTurn).toHaveBeenCalledTimes(3);
    expect(onTurn.mock.calls).toEqual([[-1], [-1], [-1]]);
  });

  it('does not turn on multi-clicks over text, links, interactive elements, or selections', () => {
    const externalSelection = vi.fn(() => false);
    const { area, onTurn } = mountWith({
      hasSelection: externalSelection,
      children: (
        <div>
          <a href="#ch2" data-testid="link">
            Link
          </a>
          <span data-annotation-id="note-1" data-testid="mark">
            Mark
          </span>
          <p data-testid="prose">Readable words</p>
        </div>
      ),
    });

    const link = screen.getByTestId('link');
    fireEvent.pointerDown(link, { button: 0, clientX: 950, clientY: 100 });
    fireEvent.click(link, { button: 0, detail: 2, clientX: 950, clientY: 100 });
    const mark = screen.getByTestId('mark');
    fireEvent.pointerDown(mark, { button: 0, clientX: 950, clientY: 100 });
    fireEvent.click(mark, { button: 0, detail: 3, clientX: 950, clientY: 100 });
    expect(onTurn).not.toHaveBeenCalled();

    // Multi-click directly over glyph text is blocked by isOverText.
    const prose = screen.getByTestId('prose');
    const textNode = prose.firstChild as Text;
    const origCaretRange = document.caretRangeFromPoint;
    const origGetClientRects = Range.prototype.getClientRects;
    document.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(textNode, 3);
      range.setEnd(textNode, 3);
      return range;
    };
    Range.prototype.getClientRects = () => [new DOMRect(940, 90, 30, 20)] as unknown as DOMRectList;
    try {
      fireEvent.pointerDown(prose, { button: 0, clientX: 950, clientY: 100 });
      fireEvent.click(prose, { button: 0, detail: 2, clientX: 950, clientY: 100 });
      expect(onTurn).not.toHaveBeenCalled();
    } finally {
      document.caretRangeFromPoint = origCaretRange;
      Range.prototype.getClientRects = origGetClientRects;
    }

    // Active host document selection blocks multi-click turns.
    const selRange = document.createRange();
    selRange.setStart(textNode, 0);
    selRange.setEnd(textNode, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selRange);
    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 100 });
    fireEvent.click(area, { button: 0, detail: 2, clientX: 950, clientY: 100 });
    expect(onTurn).not.toHaveBeenCalled();
    selection?.removeAllRanges();

    // External selection (e.g., EPUB iframe) blocks both active selection clicks and dismissal clicks.
    externalSelection.mockReturnValue(true);
    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 100 });
    // Even if selection collapses before click fires, hadSelection on pointerDown blocks Click 1.
    externalSelection.mockReturnValue(false);
    fireEvent.click(area, { button: 0, detail: 1, clientX: 950, clientY: 100 });
    expect(onTurn).not.toHaveBeenCalled();

    // Subsequent rapid Click 2 (detail: 2) after dismissal turns once.
    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 100 });
    fireEvent.click(area, { button: 0, detail: 2, clientX: 950, clientY: 100 });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);
  });

  it('ignores whitespace-only and empty non-collapsed selections in hasTextSelection and hasSelectionIn', () => {
    const host = document.createElement('div');
    const blankNode = document.createTextNode(' \n ');
    const wordNode = document.createTextNode('word');
    host.append(blankNode, wordNode);
    document.body.append(host);

    const selection = window.getSelection();
    if (!selection) throw new Error('missing selection');
    selection.removeAllRanges();
    expect(hasSelectionIn(document)).toBe(false);
    expect(hasTextSelection(null)).toBe(false);

    // Non-collapsed range over whitespace only is not treated as a text selection.
    const blankRange = document.createRange();
    blankRange.setStart(blankNode, 0);
    blankRange.setEnd(blankNode, blankNode.length);
    selection.addRange(blankRange);
    expect(selection.isCollapsed).toBe(false);
    expect(hasSelectionIn(document)).toBe(false);

    // Non-collapsed empty boundary selection (as Chromium creates on blank margins) is ignored.
    const getSelectionSpy = vi.spyOn(document, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '',
    } as unknown as Selection);
    expect(hasSelectionIn(document)).toBe(false);
    getSelectionSpy.mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => ' \n\t ',
    } as unknown as Selection);
    expect(hasSelectionIn(document)).toBe(false);
    getSelectionSpy.mockRestore();

    // Real text selection is recognized.
    selection.removeAllRanges();
    const wordRange = document.createRange();
    wordRange.setStart(wordNode, 0);
    wordRange.setEnd(wordNode, wordNode.length);
    selection.addRange(wordRange);
    expect(selection.isCollapsed).toBe(false);
    expect(hasSelectionIn(document)).toBe(true);

    selection.removeAllRanges();
    host.remove();
  });

  it('prevents native multi-click selection on blank turn margins while leaving detail 1, content, code, selections, and center zones untouched', () => {
    const externalSelection = vi.fn(() => false);
    const { view, area, onTurn } = mountWith({
      hasSelection: externalSelection,
      children: (
        <div>
          <a href="#ch2" data-testid="link">
            Link
          </a>
          <button type="button" data-testid="chevron">
            Next
          </button>
          <span data-annotation-id="note-1" data-testid="mark">
            Mark
          </span>
          <pre data-testid="pre-block">
            <code data-testid="inline-code">let x = 1;</code>
          </pre>
          <p data-testid="prose">Readable words</p>
        </div>
      ),
    });

    const fireMouseDown = (
      target: Element,
      init: { button?: number; detail?: number; clientX?: number; clientY?: number },
    ) => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: init.button ?? 0,
        detail: init.detail ?? 1,
        clientX: init.clientX ?? 950,
        clientY: init.clientY ?? 120,
      });
      target.dispatchEvent(event);
      return event;
    };

    // detail: 1 on blank turn margin does NOT preventDefault (so real selections dismiss naturally).
    expect(fireMouseDown(area, { detail: 1, clientX: 950 }).defaultPrevented).toBe(false);

    // detail: 2 and 3 on blank right and left turn margins DO preventDefault.
    expect(fireMouseDown(area, { detail: 2, clientX: 950 }).defaultPrevented).toBe(true);
    expect(fireMouseDown(area, { detail: 3, clientX: 40 }).defaultPrevented).toBe(true);

    // Non-primary button does NOT preventDefault.
    expect(fireMouseDown(area, { button: 2, detail: 2, clientX: 950 }).defaultPrevented).toBe(
      false,
    );

    // Center non-turn zone (outside left/right 12%) does NOT preventDefault.
    expect(fireMouseDown(area, { detail: 2, clientX: 500 }).defaultPrevented).toBe(false);

    // Interactive elements, highlights, <pre>, and <code> in turn zones do NOT preventDefault.
    for (const testId of ['link', 'chevron', 'mark', 'pre-block', 'inline-code']) {
      const target = screen.getByTestId(testId);
      expect(isOverContent(target, 950, 120)).toBe(true);
      expect(fireMouseDown(target, { detail: 2, clientX: 950 }).defaultPrevented).toBe(false);
    }

    // Glyph text in turn zones does NOT preventDefault.
    const prose = screen.getByTestId('prose');
    const textNode = prose.firstChild as Text;
    const origCaretRange = document.caretRangeFromPoint;
    const origGetClientRects = Range.prototype.getClientRects;
    document.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(textNode, 3);
      range.setEnd(textNode, 3);
      return range;
    };
    Range.prototype.getClientRects = () =>
      [new DOMRect(940, 110, 30, 20)] as unknown as DOMRectList;
    try {
      expect(fireMouseDown(prose, { detail: 2, clientX: 950, clientY: 120 }).defaultPrevented).toBe(
        false,
      );
    } finally {
      document.caretRangeFromPoint = origCaretRange;
      Range.prototype.getClientRects = origGetClientRects;
    }

    // Active external selection blocks preventDefault on detail: 2; once cleared, detail: 2 preventsDefault.
    externalSelection.mockReturnValue(true);
    expect(fireMouseDown(area, { detail: 2, clientX: 950 }).defaultPrevented).toBe(false);
    externalSelection.mockReturnValue(false);

    // Whitespace-only host Selection (" \n ") does NOT block mousedown prevention or click turns.
    const whitespaceNode = document.createTextNode(' \n ');
    area.append(whitespaceNode);
    const selection = window.getSelection();
    if (!selection) throw new Error('missing selection');
    const wsRange = document.createRange();
    wsRange.setStart(whitespaceNode, 0);
    wsRange.setEnd(whitespaceNode, whitespaceNode.length);
    selection.removeAllRanges();
    selection.addRange(wsRange);
    expect(fireMouseDown(area, { detail: 2, clientX: 950 }).defaultPrevented).toBe(true);
    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 120 });
    fireEvent.click(area, { button: 0, detail: 2, clientX: 950, clientY: 120 });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);

    // Real text selection blocks Click 1 (detail: 1) without preventing mousedown,
    // and rapid Click 2 (detail: 2) after dismissal prevents native selection and turns once.
    onTurn.mockClear();
    const realRange = document.createRange();
    realRange.setStart(textNode, 0);
    realRange.setEnd(textNode, 4);
    selection.removeAllRanges();
    selection.addRange(realRange);
    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 120 });
    expect(fireMouseDown(area, { detail: 1, clientX: 950 }).defaultPrevented).toBe(false);
    selection.removeAllRanges();
    fireEvent.click(area, { button: 0, detail: 1, clientX: 950, clientY: 120 });
    expect(onTurn).not.toHaveBeenCalled();

    fireEvent.pointerDown(area, { button: 0, clientX: 950, clientY: 120 });
    expect(fireMouseDown(area, { detail: 2, clientX: 950 }).defaultPrevented).toBe(true);
    fireEvent.click(area, { button: 0, detail: 2, clientX: 950, clientY: 120 });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);

    // Disabled gestures do NOT preventDefault.
    view.rerender(<Probe onTurn={onTurn} enabled={false} expose={() => undefined} />);
    expect(fireMouseDown(area, { detail: 2, clientX: 950 }).defaultPrevented).toBe(false);
  });

  it('keeps vertical wheel disabled by default so continuous-scrolling viewers stay untouched', () => {
    const { area, onTurn, gestures } = mountWith();
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false })).toBe(
      false,
    );
    const notCanceled = fireEvent.wheel(area, { deltaX: 0, deltaY: 120, deltaMode: 0 });
    expect(notCanceled).toBe(true);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('turns pages on vertical discrete pixel notches, line mode, and page mode when enabled', () => {
    vi.useFakeTimers();
    const { area, onTurn, gestures } = mountWith({ verticalWheel: true });

    // Rapid Windows pixel notches turn once per notch in both directions.
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    vi.advanceTimersByTime(16);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    vi.advanceTimersByTime(16);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn.mock.calls).toEqual([[1], [1], [-1]]);

    onTurn.mockClear();
    vi.advanceTimersByTime(SCRUB_IDLE_MS + 10);

    // DOM_DELTA_LINE: 3-line notch turns once; partial 0.5-line ticks accumulate; idle clears.
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false })).toBe(
      true,
    );
    expect(gestures().handleWheel({ deltaX: 0, deltaY: -0.5, deltaMode: 1, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: -0.5, deltaMode: 1, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn.mock.calls).toEqual([[1], [-1]]);

    onTurn.mockClear();
    // DOM_DELTA_PAGE through DOM wheel listener prevents default and turns once.
    const canceled = !fireEvent.wheel(area, { deltaX: 0, deltaY: 1, deltaMode: 2 });
    expect(canceled).toBe(true);
    expect(onTurn).toHaveBeenCalledWith(1);
  });

  it('latches vertical trackpad momentum to one turn and breaks immediately on reversal', () => {
    vi.useFakeTimers();
    const { onTurn, gestures } = mountWith({ verticalWheel: true });

    for (const deltaY of [4, 10, 22, 45, 95, 110, 80, 50, 30, 15, 5]) {
      expect(gestures().handleWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false })).toBe(
        true,
      );
      vi.advanceTimersByTime(16);
    }
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);

    // Reversal turns immediately without waiting for momentum to die.
    expect(gestures().handleWheel({ deltaX: 0, deltaY: -50, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn).toHaveBeenCalledTimes(2);
    expect(onTurn).toHaveBeenLastCalledWith(-1);

    // Decaying fast flick starting past 100px turns only once too.
    onTurn.mockClear();
    vi.advanceTimersByTime(SCRUB_IDLE_MS + 10);
    for (const deltaY of [120, 110, 112, 100, 90, 65, 40]) {
      expect(gestures().handleWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false })).toBe(
        true,
      );
      vi.advanceTimersByTime(16);
    }
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);
  });

  it('respects modifier chords, defaultPrevented, active drag buttons, scrollable ancestors, and predicate vetoes', () => {
    vi.useFakeTimers();
    const veto = vi.fn<(direction: TurnDirection, wheel: WheelSample) => boolean>(() => true);
    const { area, onTurn, gestures } = mountWith({
      verticalWheel: veto,
      children: (
        <div data-testid="nested-scroll" style={{ overflowY: 'auto' }}>
          <span data-testid="nested-child">Scrollable</span>
        </div>
      ),
    });
    const nested = screen.getByTestId('nested-scroll');
    Object.defineProperty(nested, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(nested, 'scrollHeight', { value: 300, configurable: true });
    const nestedChild = screen.getByTestId('nested-child');

    // Modifiers, defaultPrevented, and active pointer drag return false (native behavior).
    for (const sample of [
      { deltaX: 0, deltaY: 120, ctrlKey: true },
      { deltaX: 0, deltaY: 120, ctrlKey: false, metaKey: true },
      { deltaX: 0, deltaY: 120, ctrlKey: false, altKey: true },
      { deltaX: 0, deltaY: 120, ctrlKey: false, shiftKey: true },
      { deltaX: 0, deltaY: 120, ctrlKey: false, defaultPrevented: true },
      { deltaX: 0, deltaY: 120, ctrlKey: false, buttons: 1 },
      { deltaX: 0, deltaY: 120, ctrlKey: false, target: nestedChild },
    ] satisfies WheelSample[]) {
      expect(gestures().handleWheel(sample)).toBe(false);
    }
    expect(onTurn).not.toHaveBeenCalled();

    // Accumulate 25px, then veto: VerticalWheelTurn must reset so next 20px does not commit 45px!
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 25, ctrlKey: false })).toBe(true);
    veto.mockReturnValue(false);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 10, ctrlKey: false })).toBe(false);
    veto.mockReturnValue(true);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 20, ctrlKey: false })).toBe(true);
    expect(onTurn).not.toHaveBeenCalled();

    // Waiting SCRUB_IDLE_MS commits the fresh 20px single detent.
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(1);

    // Ensure DOM wheel over area outside nested child does turn and preventDefault.
    onTurn.mockClear();
    const canceled = !fireEvent.wheel(area, { deltaX: 0, deltaY: -120 });
    expect(canceled).toBe(true);
    expect(onTurn).toHaveBeenCalledWith(-1);
  });

  it('prevents default at book boundaries without calling onTurn and keeps horizontal scrubs isolated', () => {
    vi.useFakeTimers();
    const { onTurn, scrub, gestures } = mountWith({
      verticalWheel: true,
      canTurn: (direction) => direction < 0,
    });

    // At end boundary: forward vertical wheel is consumed (returns true) but does not call onTurn.
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn).not.toHaveBeenCalled();

    // Backward still turns.
    expect(gestures().handleWheel({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false })).toBe(
      true,
    );
    expect(onTurn).toHaveBeenCalledWith(-1);

    // Horizontal scrub in progress blocks vertical wheel from firing mid-swipe.
    vi.advanceTimersByTime(SCRUB_IDLE_MS + 10);
    expect(gestures().handleWheel({ deltaX: 20, deltaY: 0, ctrlKey: false })).toBe(true);
    expect(scrub.start).toHaveBeenCalledTimes(1);
    expect(gestures().handleWheel({ deltaX: 0, deltaY: 120, ctrlKey: false })).toBe(false);
  });

  it('cancels pending vertical wheel detents when disabled or switched off and measures pageRef height for page mode', () => {
    vi.useFakeTimers();
    const onTurn = vi.fn();
    let gestures: PageTurnGestures | null = null;
    const CustomProbe = ({
      enabled,
      verticalWheel,
      expose,
    }: {
      enabled: boolean;
      verticalWheel: boolean;
      expose: (value: PageTurnGestures) => void;
    }) => {
      const areaRef = useRef<HTMLDivElement>(null);
      const pageRef = useRef<HTMLDivElement>(null);
      expose(
        usePageTurnGestures({
          enabled,
          areaRef,
          pageRef,
          verticalWheel,
          onTurn,
        }),
      );
      return (
        <div ref={areaRef} data-testid="area">
          <div ref={pageRef} data-testid="page" />
        </div>
      );
    };

    const expose = (value: PageTurnGestures) => {
      gestures = value;
    };
    const view = render(<CustomProbe enabled verticalWheel expose={expose} />);
    const page = view.getByTestId('page');
    const pageRectSpy = vi
      .spyOn(page, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 0, 800, 640));

    // DOM_DELTA_PAGE reads pageRef height.
    expect(
      (gestures as unknown as PageTurnGestures).handleWheel({
        deltaX: 0,
        deltaY: 1,
        deltaMode: 2,
        ctrlKey: false,
      }),
    ).toBe(true);
    expect(pageRectSpy).toHaveBeenCalled();
    expect(onTurn).toHaveBeenCalledWith(1);

    // Partial vertical detent should not fire after verticalWheel turns off.
    onTurn.mockClear();
    expect(
      (gestures as unknown as PageTurnGestures).handleWheel({
        deltaX: 0,
        deltaY: 20,
        deltaMode: 0,
        ctrlKey: false,
      }),
    ).toBe(true);
    view.rerender(<CustomProbe enabled verticalWheel={false} expose={expose} />);
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('preserves the 90ms inertia window after slow synchronous onTurn/capture across vertical and horizontal wheel paths', () => {
    vi.useFakeTimers();
    let delayInsideTurnMs = 0;
    const onTurn = vi.fn(() => {
      if (delayInsideTurnMs > 0) {
        vi.setSystemTime(Date.now() + delayInsideTurnMs);
      }
    });
    const canTurn = vi.fn(() => true);
    let gestures: PageTurnGestures | null = null;
    const view = render(
      <Probe
        onTurn={onTurn}
        canTurn={canTurn}
        verticalWheel
        expose={(value) => {
          gestures = value;
        }}
      />,
    );
    vi.spyOn(
      view.container.firstElementChild as HTMLElement,
      'getBoundingClientRect',
    ).mockReturnValue(new DOMRect(0, 0, 1000, 600));
    const g = () => gestures as unknown as PageTurnGestures;

    // 1. VerticalWheelTurn: synchronous 60ms inside onTurn must not shrink the 90ms post-return window.
    delayInsideTurnMs = 60;
    act(() => {
      expect(g().handleWheel({ deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    delayInsideTurnMs = 0;
    // 50ms post-return is < 90ms post-commit (even though 110ms > 90ms since pre-commit entry).
    act(() => {
      vi.advanceTimersByTime(50);
      for (const deltaY of [40, 25, 10]) {
        expect(g().handleWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false })).toBe(true);
        vi.advanceTimersByTime(16);
      }
    });
    expect(onTurn).toHaveBeenCalledTimes(1);

    // 2. Vertical discrete pixel notch (verticalNotchTail): post-commit timestamp + canTurn guard.
    onTurn.mockClear();
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    canTurn.mockReturnValue(false);
    act(() => {
      expect(g().handleWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).not.toHaveBeenCalled();
    // Since canTurn was false, verticalNotchTail must not swallow subsequent turns once canTurn recovers.
    canTurn.mockReturnValue(true);
    delayInsideTurnMs = 60;
    act(() => {
      expect(g().handleWheel({ deltaX: 0, deltaY: 105, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    delayInsideTurnMs = 0;
    act(() => {
      vi.advanceTimersByTime(50);
      for (const deltaY of [80, 45, 20]) {
        expect(g().handleWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false })).toBe(true);
        vi.advanceTimersByTime(16);
      }
    });
    expect(onTurn).toHaveBeenCalledTimes(1);

    // 3. Horizontal WheelScrub full-surface commit + discrete horizontal notch tail.
    onTurn.mockClear();
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    delayInsideTurnMs = 60;
    act(() => {
      expect(g().handleWheel({ deltaX: 1000, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    delayInsideTurnMs = 0;
    act(() => {
      vi.advanceTimersByTime(50);
      for (const deltaX of [40, 20, 10]) {
        expect(g().handleWheel({ deltaX, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(true);
        vi.advanceTimersByTime(16);
      }
    });
    expect(onTurn).toHaveBeenCalledTimes(1);

    onTurn.mockClear();
    act(() => vi.advanceTimersByTime(SCRUB_IDLE_MS + 10));
    delayInsideTurnMs = 60;
    act(() => {
      expect(g().handleWheel({ deltaX: 120, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
    delayInsideTurnMs = 0;
    act(() => {
      vi.advanceTimersByTime(50);
      expect(g().handleWheel({ deltaX: 80, deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(true);
    });
    expect(onTurn).toHaveBeenCalledTimes(1);
  });
});

/** Parses `[x, y]` percent pairs from a `polygon(...)` clip path. */
const clipPoints = (clip: string): [number, number][] =>
  clip
    .replace(/^polygon\(|\)$/g, '')
    .split(', ')
    .map((point) => {
      const [rawX = '0', rawY = '0'] = point.split(' ');
      return [Number.parseFloat(rawX), Number.parseFloat(rawY)];
    });

describe('computePaperCurl', () => {
  it('stays inactive at flat endpoints 0 and 1, collapsing outgoing at end', () => {
    for (const p of [0, 0.0005]) {
      const curl = computePaperCurl(p, 1, { spread: true });
      expect(curl.active).toBe(false);
      expect(curl.unpeeledClip).toBe('none');
      expect(curl.leafClip).toBe('none');
      expect(curl.castClip).toBe('none');
      expect(curl.underClip).toBe('none');
      expect(curl.leafOpacity).toBe(0);
      expect(curl.castOpacity).toBe(0);
      expect(curl.underOpacity).toBe(0);
      expect(curl.spineOpacity).toBe(0);
      expect(curl.spineBackground).toBe('none');
    }

    for (const p of [0.9995, 1]) {
      const fwd = computePaperCurl(p, 1, { spread: true });
      expect(fwd.active).toBe(false);
      expect(fwd.unpeeledClip).toBe('polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%)');
      expect(fwd.leafClip).toBe('none');
      expect(fwd.castClip).toBe('none');
      expect(fwd.underClip).toBe('none');
      expect(fwd.leafOpacity).toBe(0);
      expect(fwd.castOpacity).toBe(0);
      expect(fwd.underOpacity).toBe(0);
      expect(fwd.spineOpacity).toBe(0);
      expect(fwd.spineBackground).toBe('none');

      const bwd = computePaperCurl(p, -1, { spread: true });
      expect(bwd.active).toBe(false);
      expect(bwd.unpeeledClip).toBe('polygon(100% 0%, 100% 0%, 100% 100%, 100% 100%)');
    }
  });

  it('sweeps the crease monotonically, leads at the lower corner, and mirrors directions', () => {
    const samples = [0.15, 0.5, 0.85].map((p) => computePaperCurl(p, 1));
    const midpointsFwd = samples.map(
      (curl) => clipPoints(curl.unpeeledClip).slice(1, -1)[5]?.[0] ?? 0,
    );
    expect(midpointsFwd[0]).toBeGreaterThan(midpointsFwd[1] ?? 0);
    expect(midpointsFwd[1]).toBeGreaterThan(midpointsFwd[2] ?? 0);

    const midFwdCrease = clipPoints(samples[1]!.unpeeledClip).slice(1, -1);
    const midBwd = computePaperCurl(0.5, -1);
    const midBwdCrease = clipPoints(midBwd.unpeeledClip).slice(1, -1);

    // Lower outer corner leads top outer corner.
    expect(midFwdCrease[0]![0]).toBeGreaterThan(midFwdCrease.at(-1)![0]);
    expect(midBwdCrease[0]![0]).toBeLessThan(midBwdCrease.at(-1)![0]);

    // Direction -1 mirrors direction 1 horizontally.
    for (let i = 0; i < midFwdCrease.length; i += 1) {
      expect((midFwdCrease[i]?.[0] ?? 0) + (midBwdCrease[i]?.[0] ?? 0)).toBeCloseTo(100, 1);
      expect(midFwdCrease[i]?.[1]).toBeCloseTo(midBwdCrease[i]?.[1] ?? 0, 2);
    }
  });

  it('flares the conical backside wider at the bottom and shares crease vertices', () => {
    const curl = computePaperCurl(0.45, 1);
    const unpeeledCrease = clipPoints(curl.unpeeledClip).slice(1, -1);
    const leafPoints = clipPoints(curl.leafClip);
    const count = unpeeledCrease.length;
    expect(leafPoints).toHaveLength(count * 2);

    // First half of `leafClip` shares the exact crease vertices with `unpeeledClip`.
    for (let i = 0; i < count; i += 1) {
      expect(leafPoints[i]?.[0]).toBeCloseTo(unpeeledCrease[i]?.[0] ?? 0, 2);
      expect(leafPoints[i]?.[1]).toBeCloseTo(unpeeledCrease[i]?.[1] ?? 0, 2);
    }

    // Second half runs upward along the lifted free edge, flared wider near the bottom.
    const freeEdgeUp = leafPoints.slice(count).reverse();
    const topWidth = Math.abs((unpeeledCrease[0]?.[0] ?? 0) - (freeEdgeUp[0]?.[0] ?? 0));
    const bottomWidth = Math.abs((unpeeledCrease.at(-1)?.[0] ?? 0) - (freeEdgeUp.at(-1)?.[0] ?? 0));
    expect(bottomWidth).toBeGreaterThan(topWidth);
  });

  it('emits 4-layer CSS tokens and activates spine valley only in two-page spreads', () => {
    const single = computePaperCurl(0.5, 1, { spread: false });
    expect(single.leafBackground).toContain('--page-turn-rim');
    expect(single.leafBackground).toContain('--page-turn-highlight');
    expect(single.leafBackground).toContain('--page-turn-roll-shade');
    expect(single.leafBackground).toContain('repeating-linear-gradient');
    expect(single.leafBackground).toContain('--page-turn-bleed');
    expect(single.leafBackground).toContain('--page-turn-paper');
    expect(single.castBackground).toContain('--page-turn-cast');
    expect(single.underBackground).toContain('--page-turn-under');
    expect(single.spineOpacity).toBe(0);
    expect(single.spineBackground).toBe('none');

    const edgeSpread = computePaperCurl(0.15, 1, { spread: true });
    const midSpread = computePaperCurl(0.5, 1, { spread: true });
    expect(midSpread.spineBackground).toContain('--page-turn-spine');
    expect(midSpread.spineOpacity).toBeGreaterThan(edgeSpread.spineOpacity);
  });
});

describe('applyPaperCurl and animatePaperCurl', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mountShadow = () => {
    const shadowRef = createRef<HTMLDivElement>();
    const utils = render(
      <PageTurnShadow
        shadowRef={shadowRef}
        palette={PAPER_CURL_PALETTES.light}
        className="inset-0"
      />,
    );
    const outgoing = document.createElement('div');
    const shadow = shadowRef.current!;
    const layer = (part: 'leaf' | 'cast-shadow' | 'under-shadow' | 'spine') =>
      shadow.querySelector<HTMLElement>(`[data-curl-part="${part}"]`)!;
    return { ...utils, outgoing, shadow, layer };
  };

  it('applies conical clip + shading layers and clears every residual style on reset', () => {
    const { outgoing, shadow, layer } = mountShadow();
    const expected = computePaperCurl(0.45, 1, { spread: true });
    applyPaperCurl(outgoing, shadow, 0.45, 1, { spread: true });

    expect(outgoing.style.clipPath).toBe(expected.unpeeledClip);
    expect(Number(layer('leaf').style.opacity)).toBeGreaterThan(0.5);
    expect(layer('leaf').style.clipPath).toBe(expected.leafClip);
    expect(Number(layer('cast-shadow').style.opacity)).toBeGreaterThan(0.2);
    expect(Number(layer('under-shadow').style.opacity)).toBeGreaterThan(0.2);
    expect(Number(layer('spine').style.opacity)).toBeGreaterThan(0.3);

    resetPaperCurl(outgoing, shadow);
    expect(outgoing.style.clipPath).toBe('');
    for (const part of ['leaf', 'cast-shadow', 'under-shadow', 'spine'] as const) {
      expect(layer(part).style.opacity).toBe('0');
      expect(layer(part).style.clipPath).toBe('');
      expect(layer(part).style.backgroundImage).toBe('');
    }
  });

  it('interpolates multiple rAF frames and cleans up on finish or cancel', () => {
    let nextId = 1;
    const queue = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queue.delete(id);
    });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const flushFrame = (dt: number) => {
      clock += dt;
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, cb] of entries) cb(clock);
    };

    const { outgoing, shadow, layer } = mountShadow();
    const onFinish = vi.fn();
    animatePaperCurl({ outgoing, shadow, direction: 1, spread: true, onFinish });

    const seenClips = new Set<string>([layer('leaf').style.clipPath]);
    flushFrame(60);
    seenClips.add(layer('leaf').style.clipPath);
    flushFrame(100);
    seenClips.add(layer('leaf').style.clipPath);
    flushFrame(100);
    seenClips.add(layer('leaf').style.clipPath);
    expect(seenClips.size).toBeGreaterThan(3);
    expect(outgoing.style.clipPath).not.toBe('');

    // At t = 0.93, easeOut(t) > 0.999 while t < 1; keep outgoing clipped to 0 area so it
    // never flashes back before `onFinish` swaps/hides it.
    flushFrame(Math.round(PAGE_CURL_MS * 0.93) - 260);
    expect(onFinish).not.toHaveBeenCalled();
    expect(outgoing.style.clipPath).toBe('polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%)');

    flushFrame(PAGE_CURL_MS);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(outgoing.style.clipPath).toBe('');
    expect(layer('leaf').style.opacity).toBe('0');

    // Preempting / cancelling clears residual geometry immediately without firing onFinish.
    const onCancelled = vi.fn();
    const cancel = animatePaperCurl({ outgoing, shadow, direction: -1, onFinish: onCancelled });
    flushFrame(80);
    expect(outgoing.style.clipPath).not.toBe('');
    cancel();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(outgoing.style.clipPath).toBe('');
    expect(layer('leaf').style.opacity).toBe('0');
  });

  it('settles synchronously without scheduling rAF under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const { outgoing, shadow, layer } = mountShadow();
    const onFinish = vi.fn();

    animatePaperCurl({ outgoing, shadow, direction: 1, onFinish });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    expect(outgoing.style.clipPath).toBe('');
    expect(layer('leaf').style.opacity).toBe('0');
  });
});

describe('animatePageTurn', () => {
  type Animate = (keyframes: Keyframe[], options?: KeyframeAnimationOptions) => Animation;
  const fakeAnimation = () => ({ id: '' }) as unknown as Animation;

  /** A page whose Web Animations calls are recorded instead of run. */
  const mountPage = () => {
    const element = document.createElement('div');
    const animate = vi.fn<Animate>();
    animate.mockReturnValue(fakeAnimation());
    element.animate = animate as unknown as HTMLElement['animate'];
    return { element, animate };
  };

  /** The 4-layer curl overlay the viewers render. */
  const mountShadow = () => {
    const shadowRef = createRef<HTMLDivElement>();
    render(
      <PageTurnShadow
        shadowRef={shadowRef}
        palette={PAPER_CURL_PALETTES.light}
        className="inset-0"
      />,
    );
    const shadow = shadowRef.current!;
    const layer = (part: 'leaf' | 'cast-shadow' | 'under-shadow' | 'spine') =>
      shadow.querySelector<HTMLElement>(`[data-curl-part="${part}"]`)!;
    return { shadow, layer };
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('slides in from the side it turned to, without dimming the page', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'slide');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'translateX(32px)' },
      { transform: 'translateX(0)' },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 220 });

    animatePageTurn(element, -1, 'slide');
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { transform: 'translateX(-32px)' },
      { transform: 'translateX(0)' },
    ]);
  });

  it('fades the incoming page in', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, -1, 'fade');
    expect(animate.mock.calls[0]?.[0]).toEqual([{ opacity: 0.2 }, { opacity: 1 }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 200 });
  });

  it('drives the 4-layer curl overlay without rotateY-transforming the element', () => {
    let frame = 0;
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame += 1;
      callbacks.push(cb);
      return frame;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const { element, animate } = mountPage();
    const cancelTurn = vi.fn();
    element.getAnimations = vi.fn(() => [
      { id: PAGE_TURN_ANIMATION_ID, cancel: cancelTurn },
    ]) as unknown as HTMLElement['getAnimations'];
    const { shadow, layer } = mountShadow();

    animatePageTurn(element, 1, 'curl', shadow, { spread: true });
    expect(animate).not.toHaveBeenCalled();
    expect(cancelTurn).toHaveBeenCalledTimes(1);

    clock = 40;
    callbacks.shift()?.(clock);
    expect(Number(layer('leaf').style.opacity)).toBeGreaterThan(0.5);
    expect(layer('leaf').style.clipPath).toContain('polygon(');
    expect(Number(layer('cast-shadow').style.opacity)).toBeGreaterThan(0.2);
    expect(Number(layer('under-shadow').style.opacity)).toBeGreaterThan(0.2);
    expect(Number(layer('spine').style.opacity)).toBeGreaterThan(0.3);

    // Settles back to hidden.
    clock = PAGE_CURL_MS + 10;
    callbacks.shift()?.(clock);
    expect(layer('leaf').style.opacity).toBe('0');
  });

  it('keeps the spine valley inactive in single-page curl mode', () => {
    let clock = 0;
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const { element } = mountPage();
    const { shadow, layer } = mountShadow();
    animatePageTurn(element, 1, 'curl', shadow, { spread: false });

    clock = 40;
    callbacks.shift()?.(clock);
    expect(Number(layer('leaf').style.opacity)).toBeGreaterThan(0.5);
    expect(layer('spine').style.opacity).toBe('0');
  });

  it('raises the incoming page from behind', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'stack');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'scale(0.965) translateX(16px)', opacity: 0.6 },
      { transform: 'scale(1) translateX(0)', opacity: 1 },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 240 });
  });

  it('does nothing for none', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'none');
    expect(animate).not.toHaveBeenCalled();
  });

  it('cancels the turn still running, and only that one', () => {
    const { element, animate } = mountPage();
    const cancelTurn = vi.fn();
    const cancelOther = vi.fn();
    element.getAnimations = vi.fn(() => [
      { id: PAGE_TURN_ANIMATION_ID, cancel: cancelTurn },
      { id: 'pulse-annotation', cancel: cancelOther },
    ]) as unknown as HTMLElement['getAnimations'];

    animatePageTurn(element, 1, 'slide');
    expect(cancelTurn).toHaveBeenCalledTimes(1);
    // Another animation on the same element is none of our business.
    expect(cancelOther).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('tags its animation, and never fills forwards', () => {
    const { element, animate } = mountPage();
    for (const mode of ['slide', 'fade', 'stack'] as const) {
      animatePageTurn(element, 1, mode);
    }
    expect(animate).toHaveBeenCalledTimes(3);
    for (const call of animate.mock.calls) {
      expect(call[1]?.fill).toBeUndefined();
    }
    // Without the id the next turn could not tell its own animation apart.
    expect((animate.mock.results[0]?.value as Animation).id).toBe(PAGE_TURN_ANIMATION_ID);
  });

  it('leaves the shadow alone for every other mode', () => {
    const { element } = mountPage();
    const { shadow, layer } = mountShadow();
    for (const mode of ['slide', 'fade', 'stack'] as const) {
      animatePageTurn(element, 1, mode, shadow, { spread: true });
    }
    expect(layer('leaf').style.opacity).toBe('');
    expect(layer('cast-shadow').style.opacity).toBe('');
    expect(layer('under-shadow').style.opacity).toBe('');
    expect(layer('spine').style.opacity).toBe('');
  });

  it('turns instantly with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const { element, animate } = mountPage();
    const { shadow, layer } = mountShadow();
    for (const mode of ['slide', 'fade', 'curl', 'stack'] as const) {
      animatePageTurn(element, 1, mode, shadow, { spread: true });
    }
    expect(animate).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    expect(layer('leaf').style.opacity).toBe('');
  });

  it('tolerates a page that is not mounted', () => {
    expect(() => animatePageTurn(null, 1, 'curl')).not.toThrow();
  });
});

describe('slideScroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mountScroller = () => {
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollLeft', { value: 100, writable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });
    // As a real scroller does: the position follows what was asked for, so the
    // motion can tell its own writes from a reader's scroll.
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollLeft = options.left ?? scroller.scrollLeft;
      scroller.scrollTop = options.top ?? scroller.scrollTop;
    });
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    return { scroller, scrollTo };
  };

  it('drives the whole page across, both pages travelling together', async () => {
    let frame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame += 1;
      callback(0);
      return frame;
    });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 130;
      return clock;
    });
    const { scroller, scrollTo } = mountScroller();
    await slideScroll(scroller, { left: 500 }, 260);
    // First frame is part-way, the last is exactly one page on.
    expect(scrollTo.mock.calls.length).toBeGreaterThan(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ left: expect.any(Number) });
    expect((scrollTo.mock.calls[0]?.[0] as ScrollToOptions).left).toBeGreaterThan(100);
    expect((scrollTo.mock.calls[0]?.[0] as ScrollToOptions).left).toBeLessThan(600);
    expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ left: 600 });
  });

  it('stops when the reader scrolls by hand, instead of dragging them back', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { scroller, scrollTo } = mountScroller();
    scroller.scrollTop = 1000;

    const slide = slideScroll(scroller, { top: 500 }, 260);
    clock = 0;
    frames.shift()?.(clock);
    expect(scroller.scrollTop).toBe(1000);

    // The reader scrolls up 600 px before the motion's next frame. The browser has
    // already applied it, so the motion must stop there rather than overwrite it.
    scroller.scrollTop = 400;
    clock = 130;
    frames.shift()?.(clock);
    await slide;
    expect(scroller.scrollTop).toBe(400);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('moves at once with reduced motion, and does nothing for no travel', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const { scroller, scrollTo } = mountScroller();
    await slideScroll(scroller, { left: 500 });
    expect(scrollTo).toHaveBeenCalledWith({ left: 600, top: 0 });

    scrollTo.mockClear();
    await slideScroll(scroller, {});
    await slideScroll(null, { left: 500 });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('easeOut', () => {
  it('starts at 0, ends at 1, and is ahead of linear in between', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.25)).toBeGreaterThan(0.25);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    // Out of range times are clamped rather than extrapolated.
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
  });
});

describe('PageTurnChevrons', () => {
  afterEach(cleanup);

  it('keeps vertical centering and gates hover/press transforms on motion-safe', () => {
    render(<PageTurnChevrons onPrevious={vi.fn()} onNext={vi.fn()} />);

    const previous = screen.getByRole('button', { name: 'Previous Page' });
    const next = screen.getByRole('button', { name: 'Next Page' });

    expect(previous).toHaveClass(
      '-translate-y-1/2',
      'motion-safe:hover:-translate-x-[2px]',
      'motion-safe:active:scale-95',
    );
    expect(next).toHaveClass(
      '-translate-y-1/2',
      'motion-safe:hover:translate-x-[2px]',
      'motion-safe:active:scale-95',
    );
    expect(previous).not.toHaveClass('hover:-translate-x-[2px]');
    expect(next).not.toHaveClass('hover:translate-x-[2px]');

    for (const button of [previous, next]) {
      expect(button).not.toHaveClass('active:scale-95');
      expect(button).not.toHaveClass('motion-reduce:translate-none');
      expect(button).not.toHaveClass('motion-reduce:scale-none');
    }
  });
});
