import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  type DocumentSearchResultItem,
  type RunDocumentSearch,
  searchStatusLabel,
  useDocumentSearch,
} from './DocumentSearch';

const match = (id: string): DocumentSearchResultItem => ({
  id,
  locationLabel: `Page ${id}`,
  contextBefore: '',
  matchText: 'fox',
  contextAfter: '',
});

describe('useDocumentSearch', () => {
  it('streams results in and shows the first match before the search finishes', async () => {
    let finish: (() => void) | undefined;
    const runSearch: RunDocumentSearch<DocumentSearchResultItem> = async (
      _query,
      _caseSensitive,
      _signal,
      onProgress,
    ) => {
      onProgress([match('1')]);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [match('1'), match('2')];
    };
    const onNavigateToMatch = vi.fn();
    const { result } = renderHook(() =>
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch }),
    );

    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.status).toBe('searching');
    expect(onNavigateToMatch).toHaveBeenCalledWith(match('1'), 0);
    expect(searchStatusLabel(result.current)).toBe('1 of 1…');

    await act(async () => finish?.());
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.results).toHaveLength(2);
    expect(onNavigateToMatch).toHaveBeenCalledTimes(1);
    expect(searchStatusLabel(result.current)).toBe('1 of 2');
  });

  it('keeps what it found when cancelled, and aborts the run', async () => {
    let signal: AbortSignal | undefined;
    const runSearch: RunDocumentSearch<DocumentSearchResultItem> = (
      _query,
      _caseSensitive,
      abort,
      onProgress,
    ) => {
      signal = abort;
      onProgress([match('1')]);
      return new Promise(() => undefined);
    };
    const { result } = renderHook(() =>
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch: vi.fn() }),
    );
    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    act(() => result.current.cancelSearch());
    expect(signal?.aborted).toBe(true);
    expect(searchStatusLabel(result.current)).toBe('Search cancelled · 1 found');
  });

  it('searches for the selected text, and clears with an empty label', async () => {
    const runSearch = vi.fn(() => [match('1')]);
    const { result } = renderHook(() =>
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch: vi.fn() }),
    );
    act(() => result.current.findSelection('  quick\n brown  '));
    expect(result.current.query).toBe('quick brown');
    expect(result.current.focusNonce).toBe(1);
    await waitFor(() => expect(result.current.status).toBe('done'));

    act(() => result.current.clearSearch());
    expect(result.current.active).toBe(false);
    expect(result.current.activeMatch).toBeNull();
    expect(searchStatusLabel(result.current)).toBe('');
  });
});
