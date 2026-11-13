import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetRecentCommandRuns, runCommand } from '@/features/commands/registry';
import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import type { BookmarksController } from '@/features/reader/BookmarksPanel';
import type {
  DocumentSearchController,
  DocumentSearchResultItem,
} from '@/features/reader/DocumentSearch';
import { useFocusPageOnActivate } from '@/features/reader/focusPage';
import type { SelectionPopoverController } from '@/features/reader/markup/useSelectionPopover';
import { useNavigator } from '@/features/reader/navigator/useNavigator';
import { useMarkupToolbar, useReaderCommands } from '@/features/reader/useReaderCommands';

function noop() {}

function stubSearch(): DocumentSearchController<DocumentSearchResultItem> {
  return {
    focusNonce: 0,
    query: '',
    active: false,
    caseSensitive: false,
    wholeWord: false,
    matchDiacritics: false,
    status: 'idle',
    results: [],
    activeIndex: -1,
    activeMatch: null,
    focusSearch: noop,
    clearSearch: noop,
    setQuery: noop,
    findSelection: noop,
    toggleCaseSensitive: noop,
    toggleWholeWord: noop,
    toggleMatchDiacritics: noop,
    cancelSearch: noop,
    nextMatch: noop,
    previousMatch: noop,
    selectMatch: noop,
    handleKeyDown: () => false,
  };
}

function stubBookmarks(): BookmarksController {
  return {
    bookmarks: [],
    isCurrentBookmarked: false,
    canUndoRemove: false,
    toggleCurrentBookmark: noop,
    selectBookmark: noop,
    removeBookmark: noop,
    undoRemove: noop,
    isBookmarkActive: () => false,
    isBookmarkStale: () => false,
  };
}

function stubAnnotations(): AnnotationsController {
  return {
    annotations: [],
    activeColor: '#fde047',
    activeStyle: 'highlight',
    highlightMode: false,
    draftNoteOpen: false,
    draftNote: '',
    canUndoDelete: false,
    setActiveColor: noop,
    setActiveStyle: noop,
    setActiveMarkup: noop,
    toggleHighlightMode: noop,
    setDraftNote: noop,
    toggleDraftNote: noop,
    openDraftNote: noop,
    closeDraftNote: noop,
    createHighlight: noop,
    submitNoteSelection: noop,
    selectAnnotation: noop,
    updateAnnotation: noop,
    deleteAnnotation: noop,
    undoDelete: noop,
    isAnnotationStale: () => false,
  };
}

function stubPopover(): SelectionPopoverController {
  return {
    target: null,
    focusRequest: 0,
    noteOpen: false,
    selectionRect: () => null,
    openForAnnotation: noop,
    showFromKeyboard: noop,
    openNote: noop,
    closeNote: noop,
    dismiss: noop,
    reportPointer: noop,
  };
}

function SidebarFocusHarness() {
  const pageRef = useRef<HTMLDivElement>(null);
  const focusPage = useFocusPageOnActivate(pageRef, true);
  const navigator = useNavigator('txt', ['contents', 'notes', 'bookmarks']);
  const markup = useMarkupToolbar();
  const search = stubSearch();
  const bookmarks = stubBookmarks();
  const annotations = stubAnnotations();
  const popover = stubPopover();

  useReaderCommands({
    isActive: true,
    focusPage,
    search,
    navigator,
    bookmarks,
    annotations,
    selectionText: null,
    markup,
    popover,
  });

  return (
    <div>
      <div role="tablist" aria-label="Open documents">
        <button type="button" role="tab" data-testid="doc-tab" aria-selected="true">
          Doc 1
        </button>
      </div>
      <input data-testid="search-input" />
      <textarea data-testid="popover-note-input" />
      <button type="button" data-testid="toolbar-btn">
        Toolbar
      </button>
      {navigator.open && (
        <aside data-testid="navigator-sidebar">
          <div role="tablist" aria-label="Sidebar views">
            <button type="button" role="tab" data-testid="sidebar-tab" aria-selected="true">
              Contents
            </button>
          </div>
          <input data-testid="navigator-filter" />
        </aside>
      )}
      <div ref={pageRef} data-testid="page-surface" tabIndex={-1} />
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  forgetRecentCommandRuns();
});

afterEach(() => {
  forgetRecentCommandRuns();
  vi.restoreAllMocks();
});

describe('useReaderCommands sidebar focus (#65)', () => {
  for (const command of ['view.hideSidebar', 'view.toggleSidebar'] as const) {
    it(`${command} keeps external text fields and document tabs focused when closing the sidebar`, () => {
      render(<SidebarFocusHarness />);

      act(() => {
        runCommand('view.toggleSidebar', 'menu');
      });
      expect(screen.getByTestId('navigator-sidebar')).toBeInTheDocument();

      for (const testId of ['search-input', 'popover-note-input', 'doc-tab']) {
        if (!screen.queryByTestId('navigator-sidebar')) {
          act(() => {
            runCommand('view.toggleSidebar', 'menu');
          });
        }
        const target = screen.getByTestId(testId);
        target.focus();
        expect(target).toHaveFocus();

        act(() => {
          runCommand(command, 'menu');
        });
        expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
        expect(target).toHaveFocus();
      }
    });

    it(`${command} moves focus to the page when closing from inside the sidebar or from non-field chrome`, () => {
      render(<SidebarFocusHarness />);

      for (const targetTestId of ['navigator-filter', 'sidebar-tab', 'toolbar-btn']) {
        act(() => {
          runCommand('view.toggleSidebar', 'menu');
        });
        expect(screen.getByTestId('navigator-sidebar')).toBeInTheDocument();

        screen.getByTestId(targetTestId).focus();
        expect(screen.getByTestId(targetTestId)).toHaveFocus();

        act(() => {
          runCommand(command, 'menu');
        });
        expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
        expect(screen.getByTestId('page-surface')).toHaveFocus();
      }
    });
  }
});
