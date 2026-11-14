import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  animatePageTurn,
  PAGE_TURN_ANIMATION_ID,
  type PageTurnGestures,
  SWIPE_IDLE_MS,
  usePageTurnGestures,
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

function Probe({
  onTurn,
  enabled = true,
  expose,
}: {
  onTurn: (direction: 1 | -1) => void;
  enabled?: boolean;
  expose: (gestures: PageTurnGestures) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  expose(usePageTurnGestures({ enabled, areaRef, onTurn }));
  return <div ref={areaRef} data-testid="area" />;
}

describe('usePageTurnGestures', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = (enabled = true) => {
    const onTurn = vi.fn();
    let gestures: PageTurnGestures | null = null;
    const view = render(
      <Probe onTurn={onTurn} enabled={enabled} expose={(value) => (gestures = value)} />,
    );
    vi.spyOn(
      view.container.firstElementChild as HTMLElement,
      'getBoundingClientRect',
    ).mockReturnValue(new DOMRect(0, 0, 1000, 600));
    return { onTurn, gestures: () => gestures as unknown as PageTurnGestures };
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

  it('turns once per swipe, again after the wheel goes quiet, and never when disabled', () => {
    vi.useFakeTimers();
    const { onTurn, gestures } = mount();
    const swipe = (deltaX: number) => {
      for (let event = 0; event < 10; event += 1) {
        gestures().handleWheel({ deltaX, deltaY: 0, ctrlKey: false });
      }
    };
    act(() => swipe(-20));
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenLastCalledWith(-1);
    act(() => vi.advanceTimersByTime(SWIPE_IDLE_MS + 10));
    act(() => swipe(20));
    expect(onTurn).toHaveBeenCalledTimes(2);
    expect(onTurn).toHaveBeenLastCalledWith(1);
    // Vertical scrolling and pinch zoom are not swipes.
    expect(gestures().handleWheel({ deltaX: 10, deltaY: 40, ctrlKey: false })).toBe(false);
    expect(gestures().handleWheel({ deltaX: 90, deltaY: 0, ctrlKey: true })).toBe(false);

    const disabled = mount(false);
    act(() => {
      for (let event = 0; event < 10; event += 1) {
        disabled.gestures().handleWheel({ deltaX: 30, deltaY: 0, ctrlKey: false });
      }
    });
    expect(disabled.onTurn).not.toHaveBeenCalled();
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('slides in from the side it turned to', () => {
    const { element, animate } = mountPage();
    animatePageTurn(element, 1, 'slide');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'translateX(32px)', opacity: 0.35 },
      { transform: 'translateX(0)', opacity: 1 },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 220 });

    animatePageTurn(element, -1, 'slide');
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { transform: 'translateX(-32px)', opacity: 0.35 },
      { transform: 'translateX(0)', opacity: 1 },
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
      { transform: 'perspective(1400px) rotateY(-18deg)', transformOrigin: '0% 50%' },
      { transform: 'perspective(1400px) rotateY(0deg)', transformOrigin: '0% 50%' },
    ]);
    animatePageTurn(element, -1, 'flip');
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { transform: 'perspective(1400px) rotateY(18deg)', transformOrigin: '100% 50%' },
      { transform: 'perspective(1400px) rotateY(0deg)', transformOrigin: '100% 50%' },
    ]);
    expect(animate.mock.calls[1]?.[1]).toMatchObject({ duration: 300 });
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

  it('moves only the shadow of a flip, from the hinge inward', () => {
    const { element } = mountPage();
    const shadow = document.createElement('div');
    const animateShadow = vi.fn<Animate>();
    animateShadow.mockReturnValue(fakeAnimation());
    shadow.animate = animateShadow as unknown as HTMLElement['animate'];

    animatePageTurn(element, 1, 'flip', shadow);
    expect(animateShadow).toHaveBeenCalledTimes(1);
    expect(animateShadow.mock.calls[0]?.[0]).toEqual([
      { opacity: 0 },
      { opacity: 1, offset: 0.35 },
      { opacity: 0 },
    ]);
    expect(shadow.style.backgroundImage).toContain('to right');

    animatePageTurn(element, -1, 'flip', shadow);
    expect(shadow.style.backgroundImage).toContain('to left');

    // Every other mode leaves the shadow alone.
    animatePageTurn(element, 1, 'stack', shadow);
    animatePageTurn(element, 1, 'slide', shadow);
    expect(animateShadow).toHaveBeenCalledTimes(2);
  });

  it('turns instantly with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const { element, animate } = mountPage();
    const shadow = document.createElement('div');
    const animateShadow = vi.fn();
    shadow.animate = animateShadow as unknown as HTMLElement['animate'];
    for (const mode of ['slide', 'fade', 'flip', 'stack'] as const) {
      animatePageTurn(element, 1, mode, shadow);
    }
    expect(animate).not.toHaveBeenCalled();
    expect(animateShadow).not.toHaveBeenCalled();
  });

  it('tolerates a page that is not mounted', () => {
    expect(() => animatePageTurn(null, 1, 'flip')).not.toThrow();
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
