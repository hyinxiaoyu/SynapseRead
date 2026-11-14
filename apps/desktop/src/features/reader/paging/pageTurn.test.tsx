import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  animatePageTurn,
  directionOf,
  easeOut,
  PAGE_TURN_ANIMATION_ID,
  type PageTurnGestures,
  rubberBand,
  SCRUB_COMMIT_FRACTION,
  SCRUB_COMMIT_VELOCITY,
  SCRUB_IDLE_MS,
  slideScroll,
  turningLeafSides,
  usePageTurnGestures,
  WheelScrub,
  zoneAt,
} from './pageTurn';

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

describe('WheelScrub', () => {
  const WIDTH = 1000;
  const context = (canTurn: (direction: 1 | -1) => boolean = () => true) => ({
    pageWidth: () => WIDTH,
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

  it('commits on release once a fifth of the page has been dragged', () => {
    const scrub = make();
    const { at } = run(
      scrub,
      Array.from({ length: 20 }, () => 10),
    );
    const released = scrub.release(at + SCRUB_IDLE_MS);
    expect(released).toEqual([{ kind: 'end', velocity: expect.any(Number), committed: 1 }]);
    // 200 px of 1000 is past the 18% the release needs.
    expect(SCRUB_COMMIT_FRACTION * WIDTH).toBeLessThan(200);
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

  it('measures the page once per gesture', () => {
    const pageWidth = vi.fn(() => WIDTH);
    const scrub = new WheelScrub();
    for (let event = 0; event < 5; event += 1) {
      scrub.push(10, event * 16, { pageWidth, canTurn: () => true });
    }
    expect(pageWidth).toHaveBeenCalledTimes(1);
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
}: {
  onTurn: (direction: 1 | -1) => void;
  enabled?: boolean;
  expose: (gestures: PageTurnGestures) => void;
  scrub?: {
    start: () => void;
    move: (displacement: number) => void;
    end: (velocity: number, committed: 1 | -1 | null) => void;
  };
  canTurn?: (direction: 1 | -1) => boolean;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  expose(
    usePageTurnGestures({
      enabled,
      areaRef,
      onTurn,
      ...(canTurn === undefined ? {} : { canTurn }),
      ...(scrub === undefined
        ? {}
        : {
            onScrubStart: scrub.start,
            onScrubMove: scrub.move,
            onScrubEnd: scrub.end,
          }),
    }),
  );
  return <div ref={areaRef} data-testid="area" />;
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
});

describe('turningLeafSides', () => {
  const whole = { top: '0', right: '0', bottom: '0', left: '0' };

  it('splits a spread at its spine and leaves a single page whole', () => {
    expect(turningLeafSides(1, true)).toEqual({
      leaf: { ...whole, left: '50%' },
      rest: { ...whole, right: '50%' },
    });
    expect(turningLeafSides(-1, true)).toEqual({
      leaf: { ...whole, right: '50%' },
      rest: { ...whole, left: '50%' },
    });
    expect(turningLeafSides(1, false)).toEqual({ leaf: whole, rest: whole });
    expect(turningLeafSides(-1, false)).toEqual({ leaf: whole, rest: whole });
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

  /** The curl overlay the viewers render, with each layer's animations recorded. */
  const mountShadow = () => {
    const shadow = document.createElement('div');
    const layer = (name: 'fold' | 'cast') => {
      const element = document.createElement('div');
      element.dataset.pageTurnLayer = name;
      const animate = vi.fn<Animate>();
      animate.mockReturnValue(fakeAnimation());
      element.animate = animate as unknown as HTMLElement['animate'];
      shadow.append(element);
      return { element, animate };
    };
    const fold = layer('fold');
    const cast = layer('cast');
    return { shadow, fold, cast };
  };

  afterEach(() => {
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

  it('flips around the leading edge: left for next, right for previous', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'flip');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      {
        transform: 'perspective(1400px) rotateY(-20deg) scaleX(0.99)',
        transformOrigin: '0% 50%',
      },
      { transform: 'perspective(1400px) rotateY(0deg) scaleX(1)', transformOrigin: '0% 50%' },
    ]);
    animatePageTurn(element, -1, 'flip');
    expect(animate.mock.calls[1]?.[0]).toEqual([
      {
        transform: 'perspective(1400px) rotateY(20deg) scaleX(0.99)',
        transformOrigin: '100% 50%',
      },
      { transform: 'perspective(1400px) rotateY(0deg) scaleX(1)', transformOrigin: '100% 50%' },
    ]);
    expect(animate.mock.calls[1]?.[1]).toMatchObject({ duration: 320 });
  });

  it('hinges a two-page spread at its centre spine, without dimming the paper', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'flip', null, { spread: true });
    expect(animate.mock.calls[0]?.[0]).toEqual([
      {
        transform: 'perspective(1800px) rotateY(-9deg) scaleX(0.994)',
        transformOrigin: '50% 50%',
      },
      { transform: 'perspective(1800px) rotateY(0deg) scaleX(1)', transformOrigin: '50% 50%' },
    ]);
    for (const frame of animate.mock.calls[0]?.[0] ?? []) {
      expect(frame).not.toHaveProperty('opacity');
    }
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
    for (const mode of ['slide', 'fade', 'flip', 'stack'] as const) {
      animatePageTurn(element, 1, mode);
    }
    expect(animate).toHaveBeenCalledTimes(4);
    for (const call of animate.mock.calls) {
      expect(call[1]?.fill).toBeUndefined();
    }
    // Without the id the next turn could not tell its own animation apart.
    expect((animate.mock.results[0]?.value as Animation).id).toBe(PAGE_TURN_ANIMATION_ID);
  });

  it('curls a spread: the fold on the turning half, the cast shadow on the other', () => {
    const { element } = mountPage();
    const { shadow, fold, cast } = mountShadow();

    animatePageTurn(element, 1, 'flip', shadow, { spread: true });
    // Each layer covers only its own side of the spine, so neither spills across.
    expect(fold.element.style.left).toBe('50%');
    expect(fold.element.style.right).toBe('0px');
    expect(cast.element.style.right).toBe('50%');
    expect(cast.element.style.left).toBe('0px');
    // The fold darkens away from the hinge; the cast shadow darkens toward it.
    expect(fold.element.style.backgroundImage).toContain('to right');
    expect(cast.element.style.backgroundImage).toContain('to left');
    expect(fold.element.style.transformOrigin).toBe('left center');
    expect(cast.element.style.transformOrigin).toBe('right center');
    // Both fall off as the leaf settles: out from the hinge, then away.
    expect(fold.animate.mock.calls[0]?.[0]).toEqual([
      { opacity: 0, transform: 'scaleX(0.55)' },
      { opacity: 1, transform: 'scaleX(1)', offset: 0.3 },
      { opacity: 0, transform: 'scaleX(1.18)' },
    ]);
    expect(cast.animate.mock.calls[0]?.[0]).toEqual([
      { opacity: 0, transform: 'scaleX(0.6)' },
      { opacity: 0.9, transform: 'scaleX(1)', offset: 0.42 },
      { opacity: 0, transform: 'scaleX(1.1)' },
    ]);
    for (const call of [fold.animate.mock.calls[0], cast.animate.mock.calls[0]]) {
      expect(call?.[1]).toMatchObject({ duration: 320 });
      expect(call?.[1]?.fill).toBeUndefined();
    }

    // Back turns mirror both the sides and the shading.
    animatePageTurn(element, -1, 'flip', shadow, { spread: true });
    expect(fold.element.style.right).toBe('50%');
    expect(fold.element.style.left).toBe('0px');
    expect(cast.element.style.left).toBe('50%');
    expect(cast.element.style.right).toBe('0px');
    expect(fold.element.style.backgroundImage).toContain('to left');
    expect(cast.element.style.backgroundImage).toContain('to right');
    expect(fold.animate).toHaveBeenCalledTimes(2);
    expect(cast.animate).toHaveBeenCalledTimes(2);
  });

  it('curls a single page on its leading edge, with no page under it to shade', () => {
    const { element } = mountPage();
    const { shadow, fold, cast } = mountShadow();

    animatePageTurn(element, 1, 'flip', shadow);
    expect(fold.element.style.left).toBe('0px');
    expect(fold.element.style.right).toBe('0px');
    expect(fold.element.style.backgroundImage).toContain('to right');
    expect(fold.animate).toHaveBeenCalledTimes(1);
    // A single page is its own leaf: the cast layer stays out of the way.
    expect(cast.animate).not.toHaveBeenCalled();
    expect(cast.element.style.opacity).toBe('0');

    animatePageTurn(element, -1, 'flip', shadow);
    expect(fold.element.style.backgroundImage).toContain('to left');
    expect(fold.element.style.transformOrigin).toBe('right center');
  });

  it('leaves the shadow alone for every other mode', () => {
    const { element } = mountPage();
    const { shadow, fold, cast } = mountShadow();
    for (const mode of ['slide', 'fade', 'stack'] as const) {
      animatePageTurn(element, 1, mode, shadow, { spread: true });
    }
    expect(fold.animate).not.toHaveBeenCalled();
    expect(cast.animate).not.toHaveBeenCalled();
  });

  it('turns instantly with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const { element, animate } = mountPage();
    const { shadow, fold, cast } = mountShadow();
    for (const mode of ['slide', 'fade', 'flip', 'stack'] as const) {
      animatePageTurn(element, 1, mode, shadow, { spread: true });
    }
    expect(animate).not.toHaveBeenCalled();
    expect(fold.animate).not.toHaveBeenCalled();
    expect(cast.animate).not.toHaveBeenCalled();
  });

  it('tolerates a page that is not mounted', () => {
    expect(() => animatePageTurn(null, 1, 'flip')).not.toThrow();
  });
});

describe('slideScroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mountScroller = () => {
    const scroller = document.createElement('div');
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    Object.defineProperty(scroller, 'scrollLeft', { value: 100, writable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });
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
