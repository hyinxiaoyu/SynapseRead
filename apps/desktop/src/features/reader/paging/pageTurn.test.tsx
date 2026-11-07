import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  animatePageTurn,
  type PageTurnGestures,
  SWIPE_IDLE_MS,
  usePageTurnGestures,
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
  it('slides in from the side it turned to, fades, or does nothing', () => {
    const element = document.createElement('div');
    const animate = vi.fn();
    element.animate = animate as unknown as HTMLElement['animate'];
    animatePageTurn(element, 1, 'slide');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'translateX(32px)', opacity: 0.35 },
      { transform: 'translateX(0)', opacity: 1 },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 200 });
    animatePageTurn(element, -1, 'fade');
    expect(animate.mock.calls[1]?.[0]).toEqual([{ opacity: 0.2 }, { opacity: 1 }]);
    animatePageTurn(element, 1, 'none');
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('turns instantly with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const element = document.createElement('div');
    const animate = vi.fn();
    element.animate = animate as unknown as HTMLElement['animate'];
    animatePageTurn(element, 1, 'slide');
    expect(animate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
