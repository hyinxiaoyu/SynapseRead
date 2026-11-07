import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import type { BookmarksController } from '@/features/reader/BookmarksPanel';
import { useDocumentSearch } from '@/features/reader/DocumentSearch';

import { ReaderNavigator } from './NavigatorSidebar';
import {
  NAVIGATOR_DEFAULT_WIDTH,
  NAVIGATOR_MAX_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  useNavigator,
} from './useNavigator';

const bookmarks: BookmarksController = {
  bookmarks: [],
  isCurrentBookmarked: false,
  canUndoRemove: false,
  toggleCurrentBookmark: vi.fn(),
  selectBookmark: vi.fn(),
  removeBookmark: vi.fn(),
  undoRemove: vi.fn(),
  isBookmarkActive: () => false,
  isBookmarkStale: () => false,
};

const annotations = {
  annotations: [],
  canUndoDelete: false,
} as unknown as AnnotationsController;

function Sidebar() {
  const navigator = useNavigator('pdf', ['thumbnails', 'contents', 'notes', 'bookmarks']);
  const search = useDocumentSearch({
    isActive: true,
    runSearch: () => [],
    onNavigateToMatch: vi.fn(),
  });
  return (
    <>
      <button type="button" onClick={navigator.toggle}>
        toggle
      </button>
      {navigator.open && (
        <ReaderNavigator
          navigator={navigator}
          bookmarks={bookmarks}
          annotations={annotations}
          search={search}
          groupSearchResults
          contents={{ items: [], currentId: null, emptyMessage: 'No outline.', onSelect: vi.fn() }}
          renderThumbnails={() => <p>pages</p>}
        />
      )}
    </>
  );
}

describe('useNavigator', () => {
  it('remembers the chosen tab and width per document format', () => {
    const pdf = renderHook(() => useNavigator('pdf', ['thumbnails', 'contents', 'notes']));
    expect(pdf.result.current.tab).toBe('thumbnails');
    expect(pdf.result.current.width).toBe(NAVIGATOR_DEFAULT_WIDTH);
    act(() => pdf.result.current.show('notes'));
    act(() => pdf.result.current.setWidth(9999));
    expect(pdf.result.current.open).toBe(true);
    expect(pdf.result.current.width).toBe(NAVIGATOR_MAX_WIDTH);
    pdf.unmount();

    const again = renderHook(() => useNavigator('pdf', ['thumbnails', 'contents', 'notes']));
    expect(again.result.current.tab).toBe('notes');
    expect(again.result.current.width).toBe(NAVIGATOR_MAX_WIDTH);
    // Opening is not remembered; each document starts with the sidebar put away.
    expect(again.result.current.open).toBe(false);

    const epub = renderHook(() => useNavigator('epub', ['contents', 'notes', 'bookmarks']));
    expect(epub.result.current.tab).toBe('contents');
    expect(epub.result.current.width).toBe(NAVIGATOR_DEFAULT_WIDTH);
  });

  it('shows search results while a query runs and then restores the previous view', () => {
    const { result } = renderHook(() => useNavigator('txt', ['notes', 'bookmarks']));
    act(() => result.current.beginSearch());
    expect(result.current).toMatchObject({ open: true, tab: 'search' });
    act(() => result.current.endSearch());
    expect(result.current).toMatchObject({ open: false, tab: 'notes' });

    act(() => result.current.show('bookmarks'));
    act(() => result.current.beginSearch());
    act(() => result.current.endSearch());
    expect(result.current).toMatchObject({ open: true, tab: 'bookmarks' });
  });

  it('returns deletions newest first, for ⌘Z', () => {
    const { result } = renderHook(() => useNavigator('txt', ['notes', 'bookmarks']));
    act(() => result.current.recordDeletion('bookmark'));
    act(() => result.current.recordDeletion('annotation'));
    let taken: string | undefined;
    act(() => {
      taken = result.current.takeDeletion();
    });
    expect(taken).toBe('annotation');
    act(() => {
      taken = result.current.takeDeletion();
    });
    expect(taken).toBe('bookmark');
  });
});

describe('ReaderNavigator', () => {
  it('switches tabs from the segmented header and explains empty tabs', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('toggle'));
    const tablist = screen.getByRole('tablist', { name: 'Sidebar views' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Thumbnails',
      'Table of Contents',
      'Highlights & Notes',
      'Bookmarks',
    ]);
    expect(screen.getByText('pages')).toBeInTheDocument();

    const thumbnails = screen.getByTestId('navigator-tab-thumbnails');
    thumbnails.focus();
    fireEvent.keyDown(thumbnails, { key: 'End' });
    expect(screen.getByTestId('navigator-tab-bookmarks')).toHaveFocus();
    expect(screen.getByTestId('bookmarks-empty')).toHaveTextContent(/to bookmark this page/);
    expect(screen.getByLabelText('Filter bookmarks')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('navigator-tab-bookmarks'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('annotations-empty')).toHaveTextContent(/highlight it/);
  });

  it('resizes from the keyboard within its limits and keeps the width', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('toggle'));
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(handle).toHaveAttribute('aria-valuenow', String(NAVIGATOR_DEFAULT_WIDTH));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', String(NAVIGATOR_DEFAULT_WIDTH + 16));
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', String(NAVIGATOR_MIN_WIDTH));
    expect(screen.getByTestId('navigator-sidebar')).toHaveStyle({
      width: `${NAVIGATOR_MIN_WIDTH}px`,
    });
  });
});
