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
      <button type="button" onClick={() => navigator.toggle()}>
        toggle
      </button>
      {navigator.open && (
        <ReaderNavigator
          navigator={navigator}
          bookmarks={bookmarks}
          annotations={annotations}
          search={search}
          groupSearchResults
          onReturnFocus={vi.fn()}
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

  it('shows search results in the sidebar it already has, and never opens or closes it', () => {
    const { result } = renderHook(() => useNavigator('txt', ['notes', 'bookmarks']));

    // Typing must not open the sidebar: that resizes the page.
    act(() => result.current.beginSearch());
    expect(result.current).toMatchObject({ open: false, tab: 'notes' });
    act(() => result.current.endSearch());
    expect(result.current).toMatchObject({ open: false, tab: 'notes' });

    // An open sidebar lends itself to the results, and gets its view back after.
    act(() => result.current.show('bookmarks'));
    act(() => result.current.beginSearch());
    expect(result.current).toMatchObject({ open: true, tab: 'search' });
    act(() => result.current.endSearch());
    expect(result.current).toMatchObject({ open: true, tab: 'bookmarks' });

    // A sidebar the reader opened for results stays open once the query is cleared.
    act(() => result.current.hide());
    act(() => result.current.beginSearch());
    expect(result.current).toMatchObject({ open: false, tab: 'bookmarks' });
    act(() => result.current.show('search'));
    expect(result.current).toMatchObject({ open: true, tab: 'search' });
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

describe('sidebar keyboard flow', () => {
  const CONTENTS = [{ id: 'ch1', label: 'Chapter 1', target: 1, children: [] }];

  function KeyboardSidebar({ onReturnFocus }: { onReturnFocus: () => void }) {
    const navigator = useNavigator('pdf', ['contents']);
    const search = useDocumentSearch({
      isActive: true,
      runSearch: () => [],
      onNavigateToMatch: vi.fn(),
    });
    return (
      <>
        <button type="button" onClick={() => navigator.toggle()}>
          toggle
        </button>
        <button type="button" onClick={() => navigator.toggle({ focus: true })}>
          open sidebar
        </button>
        <button type="button" onClick={() => navigator.show('contents', { focus: true })}>
          focus sidebar
        </button>
        <div tabIndex={-1} data-testid="page-surface" />
        {navigator.open && (
          <ReaderNavigator
            navigator={navigator}
            bookmarks={bookmarks}
            annotations={annotations}
            search={search}
            groupSearchResults
            onReturnFocus={onReturnFocus}
            contents={{
              items: CONTENTS,
              currentId: 'ch1',
              emptyMessage: 'No outline.',
              onSelect: vi.fn(),
            }}
          />
        )}
      </>
    );
  }

  it('focuses the current row when a shortcut opens it, and gives the keyboard back', () => {
    const onReturnFocus = () => screen.getByTestId('page-surface').focus();
    render(<KeyboardSidebar onReturnFocus={onReturnFocus} />);
    fireEvent.click(screen.getByText('open sidebar'));

    const current = screen.getByRole('treeitem', { name: 'Chapter 1' });
    expect(current).toHaveFocus();
    expect(current).toHaveAttribute('aria-current', 'location');

    // Return jumps and leaves the reader's keyboard on the page.
    fireEvent.keyDown(current, { key: 'Enter' });
    expect(screen.getByTestId('page-surface')).toHaveFocus();

    // Esc comes back to the page too, and leaves the sidebar where it was.
    fireEvent.click(screen.getByText('focus sidebar'));
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: 'Escape' });
    expect(screen.getByTestId('page-surface')).toHaveFocus();
    expect(screen.getByTestId('navigator-sidebar')).toBeInTheDocument();
  });

  it('keeps focus where it is when the sidebar was not opened by a shortcut', () => {
    render(<KeyboardSidebar onReturnFocus={vi.fn()} />);
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('navigator-sidebar')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Chapter 1' })).not.toHaveFocus();
  });
});

describe('useNavigator focus requests', () => {
  it('asks for the keyboard only when a shortcut does, and forgets it when hidden', () => {
    const { result } = renderHook(() => useNavigator('pdf', ['thumbnails', 'contents']));
    expect(result.current.focusRequest).toBe(0);

    act(() => result.current.show('contents'));
    expect(result.current.focusRequest).toBe(0);

    act(() => result.current.show('contents', { focus: true }));
    expect(result.current.focusRequest).toBe(1);

    // Putting the sidebar away retires the request: a later open from a click is quiet.
    act(() => result.current.hide());
    expect(result.current.focusRequest).toBe(0);

    act(() => result.current.toggle({ focus: true }));
    expect(result.current.open).toBe(true);
    expect(result.current.focusRequest).toBe(1);
  });
});
