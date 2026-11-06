import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useCallback, useState } from 'react';

import { commandDefinition, formatShortcut } from '@/features/commands/commands';
import {
  formatShortDate,
  NavigatorEmptyState,
  RowDeleteButton,
  rowClassName,
} from '@/features/reader/navigator/parts';
import { isDeleteKey, useRovingList } from '@/features/reader/navigator/useRovingList';
import { ToolbarButton } from '@/features/reader/ReaderToolbar';
import {
  type AnchorOf,
  type Bookmark,
  bookmarkLocationKey,
  defaultBookmarkLabel,
  type DocumentFormat,
} from '@/types/domain';

export interface UseBookmarksOptions<F extends DocumentFormat> {
  documentId: string;
  bookmarks?: readonly Bookmark[] | undefined;
  onAddBookmark?: ((anchor: AnchorOf<F>, label?: string) => void) | undefined;
  onRemoveBookmark?: ((bookmarkId: string) => void) | undefined;
  getCurrentLocation: () => { anchor: AnchorOf<F>; label: string } | null;
  isActiveBookmark?: (bookmark: Bookmark) => boolean;
  isStaleBookmark?: (bookmark: Bookmark) => boolean;
  onSelectBookmark: (bookmark: Bookmark) => void;
}

export interface BookmarksController {
  bookmarks: readonly Bookmark[];
  isCurrentBookmarked: boolean;
  /** A removed bookmark can be put back (⌘Z). */
  canUndoRemove: boolean;
  toggleCurrentBookmark: () => void;
  selectBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
  undoRemove: () => void;
  isBookmarkActive: (bookmark: Bookmark) => boolean;
  isBookmarkStale: (bookmark: Bookmark) => boolean;
}

export function useBookmarksController<F extends DocumentFormat>({
  documentId,
  bookmarks,
  onAddBookmark,
  onRemoveBookmark,
  getCurrentLocation,
  isActiveBookmark,
  isStaleBookmark,
  onSelectBookmark,
}: UseBookmarksOptions<F>): BookmarksController {
  const [localBookmarks, setLocalBookmarks] = useState<Bookmark[]>([]);
  const effectiveBookmarks = bookmarks ?? localBookmarks;

  const isBookmarkActive = useCallback(
    (bookmark: Bookmark): boolean => {
      if (isActiveBookmark) return isActiveBookmark(bookmark);
      const current = getCurrentLocation();
      if (!current) return false;
      return bookmarkLocationKey(bookmark.anchor) === bookmarkLocationKey(current.anchor);
    },
    [getCurrentLocation, isActiveBookmark],
  );

  const isBookmarkStale = useCallback(
    (bookmark: Bookmark): boolean => (isStaleBookmark ? isStaleBookmark(bookmark) : false),
    [isStaleBookmark],
  );

  const currentMatchedBookmark = effectiveBookmarks.find((bookmark) => isBookmarkActive(bookmark));
  const isCurrentBookmarked = currentMatchedBookmark !== undefined;

  const addBookmark = useCallback(
    (anchor: AnchorOf<F>, label?: string) => {
      if (onAddBookmark) {
        onAddBookmark(anchor, label);
        return;
      }
      const key = bookmarkLocationKey(anchor);
      const resolvedLabel = label?.trim() || defaultBookmarkLabel(anchor);
      setLocalBookmarks((prev) => {
        const existing = prev.find((candidate) => bookmarkLocationKey(candidate.anchor) === key);
        if (existing) {
          return prev.map((candidate) =>
            candidate.id === existing.id
              ? { ...candidate, anchor, label: resolvedLabel }
              : candidate,
          );
        }
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            documentId,
            anchor,
            label: resolvedLabel,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    },
    [documentId, onAddBookmark],
  );

  const [removed, setRemoved] = useState<readonly Bookmark[]>([]);

  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      const target = effectiveBookmarks.find((candidate) => candidate.id === bookmarkId);
      if (target) setRemoved((prev) => [...prev, target]);
      if (onRemoveBookmark) {
        onRemoveBookmark(bookmarkId);
        return;
      }
      setLocalBookmarks((prev) => prev.filter((candidate) => candidate.id !== bookmarkId));
    },
    [effectiveBookmarks, onRemoveBookmark],
  );

  // Restores the place and label; the store gives the bookmark a new id.
  const undoRemove = useCallback(() => {
    const last = removed.at(-1);
    if (!last) return;
    setRemoved((prev) => prev.slice(0, -1));
    addBookmark(last.anchor as AnchorOf<F>, last.label);
  }, [addBookmark, removed]);

  const toggleCurrentBookmark = useCallback(() => {
    const existing = effectiveBookmarks.find((bookmark) => isBookmarkActive(bookmark));
    if (existing) {
      removeBookmark(existing.id);
      return;
    }
    const current = getCurrentLocation();
    if (!current) return;
    addBookmark(current.anchor, current.label);
  }, [addBookmark, effectiveBookmarks, getCurrentLocation, isBookmarkActive, removeBookmark]);

  return {
    bookmarks: effectiveBookmarks,
    isCurrentBookmarked,
    canUndoRemove: removed.length > 0,
    toggleCurrentBookmark,
    selectBookmark: onSelectBookmark,
    removeBookmark,
    undoRemove,
    isBookmarkActive,
    isBookmarkStale,
  };
}

export function BookmarkToggleButton({
  bookmarked,
  disabled = false,
  onToggle,
}: {
  bookmarked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <ToolbarButton
      icon={bookmarked ? BookmarkCheck : BookmarkPlus}
      label="Bookmark current location"
      command="bookmarks.toggle"
      pressed={bookmarked}
      testId="toggle-bookmark-button"
      disabled={disabled}
      onClick={onToggle}
    />
  );
}

function bookmarkShortcut(): string {
  const { shortcut } = commandDefinition('bookmarks.toggle');
  return shortcut ? formatShortcut(shortcut) : '';
}

/** The Navigator's Bookmarks tab. */
export function BookmarksList({
  controller,
  filter,
  onRemoved,
}: {
  controller: BookmarksController;
  filter: string;
  /** Told after a row is deleted, so ⌘Z knows what to restore. */
  onRemoved?: () => void;
}) {
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? controller.bookmarks.filter((bookmark) => bookmark.label.toLowerCase().includes(needle))
    : controller.bookmarks;
  const roving = useRovingList(shown.length);

  if (controller.bookmarks.length === 0) {
    return (
      <NavigatorEmptyState testId="bookmarks-empty" title="No bookmarks yet">
        Press {bookmarkShortcut()} to bookmark this page.
      </NavigatorEmptyState>
    );
  }
  if (shown.length === 0) {
    return <NavigatorEmptyState title="No matching bookmarks" />;
  }

  const remove = (bookmark: Bookmark, index: number, from: HTMLElement) => {
    roving.refocusAfterRemoval(from, index);
    controller.removeBookmark(bookmark.id);
    onRemoved?.();
  };

  return (
    <ol
      {...roving.listProps}
      aria-label="Bookmarks"
      data-testid="bookmarks-list"
      data-arrow-keys=""
      className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
    >
      {shown.map((bookmark, index) => {
        const active = controller.isBookmarkActive(bookmark);
        const stale = controller.isBookmarkStale(bookmark);
        return (
          <li
            key={bookmark.id}
            data-testid="bookmark-item"
            className="group/row flex items-center gap-0.5"
          >
            <button
              type="button"
              data-roving-row=""
              data-testid="bookmark-jump-button"
              tabIndex={roving.tabIndexFor(index)}
              aria-current={active ? 'location' : undefined}
              aria-keyshortcuts="Backspace"
              title={bookmark.label}
              onFocus={() => roving.onRowFocus(index)}
              onClick={() => controller.selectBookmark(bookmark)}
              onKeyDown={(event) => {
                if (roving.onRowKeyDown(event, index)) return;
                if (isDeleteKey(event)) {
                  event.preventDefault();
                  remove(bookmark, index, event.currentTarget);
                }
              }}
              className={rowClassName(active)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  data-testid="bookmark-label"
                  className={`line-clamp-2 min-w-0 break-words ${active ? 'font-semibold' : ''}`}
                >
                  {bookmark.label}
                </span>
                {stale && (
                  <span
                    data-testid="bookmark-stale"
                    className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                  >
                    Stale
                  </span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatShortDate(bookmark.createdAt)}
              </span>
            </button>
            <RowDeleteButton
              label={`Remove bookmark ${bookmark.label}`}
              testId="bookmark-remove-button"
              onDelete={(from) => remove(bookmark, index, from)}
            />
          </li>
        );
      })}
    </ol>
  );
}
