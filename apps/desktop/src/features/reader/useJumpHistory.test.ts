import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useJumpHistory, useSearchTrip } from '@/features/reader/useJumpHistory';

describe('useJumpHistory', () => {
  it('goes back and forward, and a new jump clears forward', () => {
    const { result } = renderHook(() => useJumpHistory<number>());
    expect(result.current.canGoBack).toBe(false);

    act(() => result.current.push(10));
    act(() => result.current.push(10));
    act(() => result.current.push(20));
    expect(result.current.canGoBack).toBe(true);

    let target: number | undefined;
    act(() => {
      target = result.current.goBack(30);
    });
    expect(target).toBe(20);
    expect(result.current.canGoForward).toBe(true);

    act(() => {
      target = result.current.goForward(20);
    });
    expect(target).toBe(30);
    expect(result.current.canGoForward).toBe(false);

    act(() => {
      target = result.current.goBack(30);
    });
    expect(target).toBe(20);
    act(() => result.current.push(40));
    expect(result.current.canGoForward).toBe(false);

    // 10 was pushed twice in a row but recorded once.
    act(() => {
      target = result.current.goBack(50);
    });
    expect(target).toBe(40);
    act(() => {
      target = result.current.goBack(40);
    });
    expect(target).toBe(10);
    expect(result.current.canGoBack).toBe(false);
  });
});

describe('useSearchTrip', () => {
  it('remembers where a search started, once, and again for the next search', () => {
    const push = vi.fn();
    const { result } = renderHook(() => useSearchTrip<number>(push));

    // The first step that moves the view is the one remembered.
    let first = false;
    act(() => {
      first = result.current(1, 10);
    });
    expect(first).toBe(true);
    expect(push).toHaveBeenCalledWith(10);

    // Every later step of the same search leaves history alone.
    let later = true;
    act(() => {
      later = result.current(1, 20);
    });
    expect(later).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);

    // A new search starts a new trip, remembering where it started instead.
    act(() => {
      first = result.current(2, 30);
    });
    expect(first).toBe(true);
    expect(push).toHaveBeenLastCalledWith(30);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
