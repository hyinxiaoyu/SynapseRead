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
  it('streams results in and shows the match a search starts at before it finishes', async () => {
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
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch, debounceMs: 0 }),
    );

    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.status).toBe('searching');
    expect(onNavigateToMatch).toHaveBeenCalledWith(match('1'), 0, expect.any(Number));
    expect(searchStatusLabel(result.current)).toBe('1 of 1…');

    await act(async () => finish?.());
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.results).toHaveLength(2);
    expect(onNavigateToMatch).toHaveBeenCalledTimes(1);
    expect(searchStatusLabel(result.current)).toBe('1 of 2');
  });

  it('scans once typing pauses, not on every keystroke', async () => {
    const runSearch = vi.fn(() => [match('1')]);
    const { result } = renderHook(() =>
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch: vi.fn() }),
    );

    act(() => result.current.setQuery('f'));
    act(() => result.current.setQuery('fo'));
    act(() => result.current.setQuery('fox'));
    // The field shows every keystroke; the document is read once, after the pause.
    expect(result.current.query).toBe('fox');
    expect(runSearch).not.toHaveBeenCalled();

    await waitFor(() => expect(runSearch).toHaveBeenCalledTimes(1));
    expect(runSearch).toHaveBeenCalledWith('fox', false, expect.anything(), expect.any(Function));
  });

  it('starts at the first match at or after the reading position', async () => {
    const all = [match('1'), match('2'), match('3')];
    const onNavigateToMatch = vi.fn();
    const { result } = renderHook(() =>
      useDocumentSearch({
        isActive: true,
        runSearch: () => all,
        onNavigateToMatch,
        debounceMs: 0,
        // The reading position sits between the first and second match.
        findSearchStart: (found) => found.findIndex((item) => item.id >= '2'),
      }),
    );

    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.activeIndex).toBe(1);
    expect(result.current.activeMatch).toEqual(match('2'));
    expect(onNavigateToMatch).toHaveBeenCalledWith(match('2'), 1, expect.any(Number));
  });

  it('wraps to the first match only once the search has finished', async () => {
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
      useDocumentSearch({
        isActive: true,
        runSearch,
        onNavigateToMatch,
        debounceMs: 0,
        // Nothing is at or after the reading position, so the search must wrap.
        findSearchStart: () => -1,
      }),
    );

    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    // A match further on could still arrive, so the view has not moved yet.
    expect(onNavigateToMatch).not.toHaveBeenCalled();

    await act(async () => finish?.());
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.activeIndex).toBe(0);
    expect(onNavigateToMatch).toHaveBeenCalledWith(match('1'), 0, expect.any(Number));
  });

  it('keeps one trip across the steps of a search and starts a new one per search', async () => {
    const onNavigateToMatch = vi.fn();
    const { result } = renderHook(() =>
      useDocumentSearch({
        isActive: true,
        runSearch: () => [match('1'), match('2')],
        onNavigateToMatch,
        debounceMs: 0,
      }),
    );

    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.status).toBe('done'));
    const trip = onNavigateToMatch.mock.calls[0]?.[2];
    expect(trip).toEqual(expect.any(Number));

    act(() => result.current.nextMatch());
    expect(onNavigateToMatch).toHaveBeenLastCalledWith(match('2'), 1, trip);
    act(() => result.current.previousMatch());
    expect(onNavigateToMatch).toHaveBeenLastCalledWith(match('1'), 0, trip);

    act(() => result.current.setQuery('foxy'));
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(onNavigateToMatch.mock.calls.at(-1)?.[2]).not.toBe(trip);
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
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch: vi.fn(), debounceMs: 0 }),
    );
    act(() => result.current.setQuery('fox'));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    act(() => result.current.cancelSearch());
    expect(signal?.aborted).toBe(true);
    expect(searchStatusLabel(result.current)).toBe('Search cancelled · 1 found');
  });

  it('searches for the selected text at once, and clears with an empty label', async () => {
    const runSearch = vi.fn(() => [match('1')]);
    const { result } = renderHook(() =>
      useDocumentSearch({ isActive: true, runSearch, onNavigateToMatch: vi.fn() }),
    );
    act(() => result.current.findSelection('  quick\n brown  '));
    expect(result.current.query).toBe('quick brown');
    expect(result.current.focusNonce).toBe(1);
    // An explicit command does not wait for a typing pause.
    await act(async () => undefined);
    expect(runSearch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.status).toBe('done'));

    act(() => result.current.clearSearch());
    expect(result.current.active).toBe(false);
    expect(result.current.activeMatch).toBeNull();
    expect(searchStatusLabel(result.current)).toBe('');
  });
});
