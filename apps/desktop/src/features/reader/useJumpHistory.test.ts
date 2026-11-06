import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useJumpHistory } from '@/features/reader/useJumpHistory';

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
