import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MARKUP,
  readMarkupDefaults,
  useMarkupDefaults,
  writeMarkupDefaults,
} from '@/features/reader/markup/markupDefaults';

describe('markup defaults', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts as a yellow highlight', () => {
    expect(readMarkupDefaults()).toEqual(DEFAULT_MARKUP);
  });

  it('remembers the last color and style separately', () => {
    writeMarkupDefaults({ color: '#86efac' });
    writeMarkupDefaults({ style: 'underline' });
    expect(readMarkupDefaults()).toEqual({ color: '#86efac', style: 'underline' });
  });

  it('ignores entries that are not a color or a style', () => {
    localStorage.setItem(
      'synapseread.markup.v1',
      JSON.stringify({ color: 'red; background: url(x)', style: 'strike' }),
    );
    expect(readMarkupDefaults()).toEqual(DEFAULT_MARKUP);
    localStorage.setItem('synapseread.markup.v1', '{not json');
    expect(readMarkupDefaults()).toEqual(DEFAULT_MARKUP);
  });

  it('keeps the choice for the session when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useMarkupDefaults());
    expect(() => act(() => writeMarkupDefaults({ color: '#86efac' }))).not.toThrow();
    expect(readMarkupDefaults()).toEqual(DEFAULT_MARKUP);
    expect(result.current.color).toBe('#86efac');
    vi.restoreAllMocks();
    // Once storage takes writes again, it is the source of truth.
    act(() => writeMarkupDefaults({ color: '#93c5fd' }));
    expect(readMarkupDefaults().color).toBe('#93c5fd');
  });

  it('tells every reader showing the defaults when one changes them', () => {
    const one = renderHook(() => useMarkupDefaults());
    const two = renderHook(() => useMarkupDefaults());
    act(() => writeMarkupDefaults({ color: '#f9a8d4', style: 'underline' }));
    expect(one.result.current).toEqual({ color: '#f9a8d4', style: 'underline' });
    expect(two.result.current).toBe(one.result.current);
  });
});
