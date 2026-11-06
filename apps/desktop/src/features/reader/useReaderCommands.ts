import { useState } from 'react';

import { type CommandHandlers, useCommands } from '@/features/commands/registry';
import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import type { BookmarksController } from '@/features/reader/BookmarksPanel';
import type {
  DocumentSearchController,
  DocumentSearchResultItem,
} from '@/features/reader/DocumentSearchBar';
import { DEFAULT_FONT_SIZE, steppedFontSize } from '@/features/reader/ReadingPreferencesBar';
import type { ReadingPreferences } from '@/types/domain';

/** The markup group (colors, Highlight, Add note) can be put away with ⇧⌘A. */
export function useMarkupToolbar() {
  const [visible, setVisible] = useState(true);
  return { visible, toggle: () => setVisible((current) => !current) };
}

export type MarkupToolbar = ReturnType<typeof useMarkupToolbar>;

interface ReflowableOptions {
  preferences: ReadingPreferences;
  onChange: (patch: Partial<ReadingPreferences>) => void;
  panel: { open: boolean; toggle: () => void };
}

/**
 * The commands every reader shares, wired to its controllers, plus whatever
 * the format adds in `extra` (zoom, rotation, layout, sidebars). Registered
 * only while the tab is active, so the menu always describes the visible tab.
 */
export function useReaderCommands<TMatch extends DocumentSearchResultItem>({
  isActive,
  ready = true,
  search,
  bookmarks,
  annotations,
  hasSelection,
  markup,
  reflowable,
  extra,
}: {
  isActive: boolean;
  /** False while the document is still opening. */
  ready?: boolean;
  search: DocumentSearchController<TMatch>;
  bookmarks: BookmarksController;
  annotations: AnnotationsController;
  hasSelection: boolean;
  markup: MarkupToolbar;
  /** Text size and the Appearance panel, for formats that reflow. */
  reflowable?: ReflowableOptions;
  extra?: CommandHandlers;
}) {
  const hasResults = search.results.length > 0;
  const handlers: CommandHandlers = {
    'edit.find': { run: search.openSearch, enabled: ready },
    'edit.findNext': { run: search.nextMatch, enabled: ready && hasResults },
    'edit.findPrevious': { run: search.previousMatch, enabled: ready && hasResults },
    'view.sidebarSearch': { run: search.toggleSearch, enabled: ready },
    'edit.highlight': { run: annotations.createHighlight, enabled: ready && hasSelection },
    'edit.addNote': { run: annotations.toggleDraftNote, enabled: ready && hasSelection },
    'view.sidebarAnnotations': { run: annotations.togglePanel, enabled: ready },
    'view.sidebarBookmarks': {
      run: bookmarks.togglePanel,
      enabled: ready,
      title: bookmarks.open ? 'Hide Bookmarks' : 'Show Bookmarks',
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
  }
  useCommands({ ...handlers, ...extra }, isActive);
}
