import { BookmarkCheck, Bookmark as BookmarkIcon, BookmarkPlus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { type ToolbarCollapse, ToolbarButton } from '@/features/reader/ReaderToolbar';
import { cn } from '@/lib/utils';
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
  open: boolean;
  bookmarks: readonly Bookmark[];
  isCurrentBookmarked: boolean;
  togglePanel: () => void;
  closePanel: () => void;
  toggleCurrentBookmark: () => void;
  selectBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
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
  const [open, setOpen] = useState(false);
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

  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      if (onRemoveBookmark) {
        onRemoveBookmark(bookmarkId);
        return;
      }
      setLocalBookmarks((prev) => prev.filter((candidate) => candidate.id !== bookmarkId));
    },
    [onRemoveBookmark],
  );

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
    open,
    bookmarks: effectiveBookmarks,
    isCurrentBookmarked,
    togglePanel: () => setOpen((current) => !current),
    closePanel: () => setOpen(false),
    toggleCurrentBookmark,
    selectBookmark: onSelectBookmark,
    removeBookmark,
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

export function BookmarksListToggleButton({
  open,
  count,
  disabled = false,
  collapse,
  onToggle,
}: {
  open: boolean;
  count: number;
  disabled?: boolean;
  collapse?: ToolbarCollapse;
  onToggle: () => void;
}) {
  return (
    <ToolbarButton
      icon={BookmarkIcon}
      label="Bookmarks"
      command="view.sidebarBookmarks"
      pressed={open}
      testId="bookmarks-toggle-button"
      badge={count}
      badgeTestId="bookmarks-count"
      disabled={disabled}
      {...(collapse ? { collapse } : {})}
      onClick={onToggle}
    />
  );
}

export function BookmarksPanel({ controller }: { controller: BookmarksController }) {
  if (!controller.open) return null;

  return (
    <div
      role="region"
      aria-label="Bookmarks"
      data-testid="bookmarks-panel"
      data-reader-popover=""
      className="shrink-0 border-b bg-background text-xs text-foreground"
    >
      {controller.bookmarks.length === 0 ? (
        <p data-testid="bookmarks-empty" className="px-3 py-2 text-xs text-muted-foreground">
          No bookmarks in this document.
        </p>
      ) : (
        <ol
          aria-label="Bookmark list"
          data-testid="bookmarks-list"
          className="max-h-36 divide-y overflow-y-auto bg-muted/20"
        >
          {controller.bookmarks.map((bookmark) => {
            const active = controller.isBookmarkActive(bookmark);
            const stale = controller.isBookmarkStale(bookmark);
            return (
              <li
                key={bookmark.id}
                data-testid="bookmark-item"
                className="flex items-center justify-between gap-2 px-3 py-1"
              >
                <button
                  type="button"
                  data-testid="bookmark-jump-button"
                  aria-current={active ? 'location' : undefined}
                  onClick={() => controller.selectBookmark(bookmark)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground/85 hover:bg-accent/60',
                  )}
                >
                  <span data-testid="bookmark-label" className="truncate">
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
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={`Remove bookmark ${bookmark.label}`}
                  data-testid="bookmark-remove-button"
                  onClick={() => controller.removeBookmark(bookmark.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
