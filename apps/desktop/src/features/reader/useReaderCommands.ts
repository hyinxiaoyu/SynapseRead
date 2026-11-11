import { useState } from 'react';

import { type CommandHandlers, useCommands } from '@/features/commands/registry';
import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import type { BookmarksController } from '@/features/reader/BookmarksPanel';
import type {
  DocumentSearchController,
  DocumentSearchResultItem,
} from '@/features/reader/DocumentSearch';
import type { SelectionPopoverController } from '@/features/reader/markup/useSelectionPopover';
import type { NavigatorController, NavigatorTab } from '@/features/reader/navigator/useNavigator';
import { DEFAULT_FONT_SIZE, steppedFontSize } from '@/features/reader/appearance/AppearancePopover';
import type { ReadingPreferences } from '@/types/domain';

/** The markup bar under the toolbar (⇧⌘A), put away until it is asked for. */
export function useMarkupToolbar() {
  const [visible, setVisible] = useState(false);
  return {
    visible,
    toggle: () => setVisible((current) => !current),
    show: () => setVisible(true),
    hide: () => setVisible(false),
  };
}

export type MarkupToolbar = ReturnType<typeof useMarkupToolbar>;

interface ReflowableOptions {
  preferences: ReadingPreferences;
  onChange: (patch: Partial<ReadingPreferences>) => void;
  panel: { open: boolean; toggle: () => void };
}

/**
 * Shows search results in the Navigator while a query is entered, and puts back
 * the tab it replaced once the query is cleared. The sidebar itself is left
 * alone: typing must not open or close it, because that resizes the page and a
 * fit-width PDF would rescale and jump.
 */
function useSearchInNavigator(searchActive: boolean, navigator: NavigatorController) {
  const [wasActive, setWasActive] = useState(searchActive);
  if (wasActive !== searchActive) {
    setWasActive(searchActive);
    if (searchActive) navigator.beginSearch();
    else navigator.endSearch();
  }
}

/**
 * The commands every reader shares, wired to its controllers, plus whatever
 * the format adds in `extra` (zoom, rotation, layout). Registered only while
 * the tab is active, so the menu always describes the visible tab.
 */
export function useReaderCommands<TMatch extends DocumentSearchResultItem>({
  isActive,
  ready = true,
  chromeHidden = false,
  focusPage,
  search,
  navigator,
  bookmarks,
  annotations,
  selectionText,
  markup,
  popover,
  reflowable,
  appearance,
  extra,
}: {
  isActive: boolean;
  /** False while the document is still opening. */
  ready?: boolean;
  /** Focus mode: the sidebar stays put away. */
  chromeHidden?: boolean;
  /** Gives the keyboard back to the reading page. */
  focusPage: () => void;
  search: DocumentSearchController<TMatch>;
  navigator: NavigatorController;
  bookmarks: BookmarksController;
  annotations: AnnotationsController;
  /** The current selection's text, or null with nothing selected. */
  selectionText: string | null;
  markup: MarkupToolbar;
  popover: SelectionPopoverController;
  /** Text size and the Appearance popover, for formats that reflow. */
  reflowable?: ReflowableOptions;
  /** The Appearance popover alone, for formats with nothing to reflow (PDF). */
  appearance?: ReflowableOptions['panel'];
  extra?: CommandHandlers;
}) {
  useSearchInNavigator(search.active, navigator);

  const hasResults = search.results.length > 0;
  const hasSelection = selectionText !== null;
  const sidebarReady = ready && !chromeHidden;
  const sidebarShown = navigator.open && !chromeHidden;

  const showTab = (tab: NavigatorTab) => ({
    // A sidebar shortcut puts the keyboard in the list it opens, on its current row.
    run: () => navigator.show(tab, { focus: true }),
    enabled: sidebarReady && navigator.hasTab(tab),
  });

  const canUndoDelete = bookmarks.canUndoRemove || annotations.canUndoDelete;
  const undoDelete = () => {
    // The most recent deletion made in the sidebar first, then whatever remains.
    const kind = navigator.takeDeletion();
    if (kind === 'bookmark' && bookmarks.canUndoRemove) bookmarks.undoRemove();
    else if (kind === 'annotation' && annotations.canUndoDelete) annotations.undoDelete();
    else if (annotations.canUndoDelete) annotations.undoDelete();
    else if (bookmarks.canUndoRemove) bookmarks.undoRemove();
  };

  const handlers: CommandHandlers = {
    'edit.find': { run: search.focusSearch, enabled: ready },
    'edit.findNext': { run: search.nextMatch, enabled: ready && hasResults },
    'edit.findPrevious': { run: search.previousMatch, enabled: ready && hasResults },
    'edit.useSelectionForFind': {
      run: () => {
        if (selectionText !== null) search.findSelection(selectionText);
      },
      enabled: ready && hasSelection,
    },
    'edit.undoDelete': { run: undoDelete, enabled: ready && canUndoDelete },
    // The last color and style used, as in Books.
    'edit.highlight': { run: () => annotations.createHighlight(), enabled: ready && hasSelection },
    'edit.addNote': { run: popover.openNote, enabled: ready && hasSelection },
    'edit.selectionActions': {
      run: popover.showFromKeyboard,
      enabled: ready && (hasSelection || popover.target !== null),
    },
    'edit.highlightMode': {
      run: () => {
        // Turning it on shows the bar, so the armed mode is never invisible.
        if (!annotations.highlightMode) markup.show();
        annotations.toggleHighlightMode();
      },
      enabled: ready,
      title: annotations.highlightMode ? 'Turn Off Highlight Mode' : 'Turn On Highlight Mode',
    },
    'view.toggleSidebar': {
      run: () => {
        // Opening hands the sidebar the keyboard; closing gives it back to the page.
        navigator.toggle({ focus: !navigator.open });
        if (navigator.open) focusPage();
      },
      enabled: sidebarReady,
      title: sidebarShown ? 'Hide Sidebar' : 'Show Sidebar',
    },
    'view.hideSidebar': {
      run: () => {
        navigator.hide();
        focusPage();
      },
      enabled: sidebarShown,
    },
    'view.sidebarThumbnails': showTab('thumbnails'),
    'view.sidebarContents': showTab('contents'),
    'view.sidebarAnnotations': showTab('notes'),
    'view.sidebarBookmarks': showTab('bookmarks'),
    'view.sidebarSearch': {
      run: () => navigator.show('search', { focus: true }),
      enabled: sidebarReady && search.active,
    },
    'bookmarks.toggle': {
      run: bookmarks.toggleCurrentBookmark,
      enabled: ready,
      title: bookmarks.isCurrentBookmarked ? 'Remove Bookmark' : 'Add Bookmark',
    },
    'view.markup': {
      run: markup.toggle,
      enabled: ready,
      title: markup.visible ? 'Hide Markup Toolbar' : 'Show Markup Toolbar',
    },
  };
  if (reflowable) {
    const { preferences, onChange, panel } = reflowable;
    const bigger = steppedFontSize(preferences.fontSize, 1);
    const smaller = steppedFontSize(preferences.fontSize, -1);
    // Reflowable text has no page to zoom: ⌘+ and ⌘− change the text size, as in Books.
    handlers['view.zoomIn'] = {
      run: () => onChange({ fontSize: bigger }),
      enabled: ready && bigger !== preferences.fontSize,
      title: 'Bigger Text',
    };
    handlers['view.zoomOut'] = {
      run: () => onChange({ fontSize: smaller }),
      enabled: ready && smaller !== preferences.fontSize,
      title: 'Smaller Text',
    };
    handlers['view.actualSize'] = {
      run: () => onChange({ fontSize: DEFAULT_FONT_SIZE }),
      enabled: ready && preferences.fontSize !== DEFAULT_FONT_SIZE,
      title: 'Actual Text Size',
    };
    handlers['view.appearance'] = { run: panel.toggle, enabled: ready };
  } else if (appearance) {
    // PDF has no text to reflow, but its pages can be tinted from the same popover.
    handlers['view.appearance'] = { run: appearance.toggle, enabled: ready };
  }
  useCommands({ ...handlers, ...extra }, isActive);
}
