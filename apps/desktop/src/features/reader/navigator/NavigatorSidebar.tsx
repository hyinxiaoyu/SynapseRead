import {
  Bookmark,
  CircleCheck,
  Highlighter,
  LayoutGrid,
  ListTree,
  type LucideIcon,
  Search,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';

import { type CommandId, commandTooltip } from '@/features/commands/commands';
import { AnnotationsList, type AnnotationPlacement } from '@/features/reader/AnnotationsPanel';
import { BookmarksList, type BookmarksController } from '@/features/reader/BookmarksPanel';
import {
  type DocumentSearchController,
  type DocumentSearchResultItem,
  SearchResultsList,
} from '@/features/reader/DocumentSearch';
import { type OutlineNode, OutlineTree } from '@/features/reader/navigator/OutlineTree';
import {
  clampNavigatorWidth,
  NAVIGATOR_MAX_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  type NavigatorController,
  type NavigatorTab,
} from '@/features/reader/navigator/useNavigator';
import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import { cn } from '@/lib/utils';
import type { Annotation } from '@/types/domain';

interface TabSpec {
  label: string;
  icon: LucideIcon;
  command: CommandId;
  filterLabel?: string;
}

const TAB_SPECS: Record<NavigatorTab, TabSpec> = {
  thumbnails: {
    label: 'Thumbnails',
    icon: LayoutGrid,
    command: 'view.sidebarThumbnails',
    filterLabel: 'Filter pages',
  },
  contents: {
    label: 'Table of Contents',
    icon: ListTree,
    command: 'view.sidebarContents',
    filterLabel: 'Filter contents',
  },
  notes: {
    label: 'Highlights & Notes',
    icon: Highlighter,
    command: 'view.sidebarAnnotations',
    filterLabel: 'Filter highlights and notes',
  },
  bookmarks: {
    label: 'Bookmarks',
    icon: Bookmark,
    command: 'view.sidebarBookmarks',
    filterLabel: 'Filter bookmarks',
  },
  search: { label: 'Search Results', icon: Search, command: 'view.sidebarSearch' },
};

const KEYBOARD_RESIZE_STEP = 16;

export interface NavigatorContents<T> {
  items: readonly OutlineNode<T>[];
  currentId: string | null;
  emptyMessage: string;
  onSelect: (target: T) => void;
}

export interface ReaderNavigatorProps<TMatch extends DocumentSearchResultItem, T> {
  navigator: NavigatorController;
  bookmarks: BookmarksController;
  annotations: AnnotationsController;
  search: DocumentSearchController<TMatch>;
  /** Group search results under their location (chapters, pages). */
  groupSearchResults: boolean;
  contents?: NavigatorContents<T>;
  /** The PDF page strip, given the tab's filter text. */
  renderThumbnails?: (filter: string) => ReactNode;
  annotationPlacement?: (annotation: Annotation) => AnnotationPlacement;
  /** Orders annotations with the same placement order, such as by CFI in one chapter. */
  compareAnnotations?: (a: Annotation, b: Annotation) => number;
  linkedAnnotationIds?: ReadonlySet<string>;
}

/**
 * The reader's one left sidebar, after Preview: a segmented header switches
 * between Thumbnails, Contents, Highlights & Notes, and Bookmarks (and Search
 * while a query runs), each with its own filter. Collapsible and resizable.
 */
export function ReaderNavigator<TMatch extends DocumentSearchResultItem, T>({
  navigator,
  bookmarks,
  annotations,
  search,
  groupSearchResults,
  contents,
  renderThumbnails,
  annotationPlacement,
  compareAnnotations,
  linkedAnnotationIds,
}: ReaderNavigatorProps<TMatch, T>) {
  const baseId = useId();
  const [filters, setFilters] = useState<Partial<Record<NavigatorTab, string>>>({});
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const tabButtons = useRef(new Map<NavigatorTab, HTMLButtonElement>());

  const tabs: NavigatorTab[] = search.active ? [...navigator.tabs, 'search'] : [...navigator.tabs];
  const tab = tabs.includes(navigator.tab) ? navigator.tab : (tabs[0] ?? 'bookmarks');
  const spec = TAB_SPECS[tab];
  const filter = filters[tab] ?? '';
  const width = liveWidth ?? navigator.width;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    navigator.show(target);
    tabButtons.current.get(target)?.focus();
  };

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };
  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setLiveWidth(
      clampNavigatorWidth(drag.current.startWidth + event.clientX - drag.current.startX),
    );
  };
  const onResizePointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (liveWidth !== null) navigator.setWidth(liveWidth);
    setLiveWidth(null);
  };
  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - KEYBOARD_RESIZE_STEP;
    else if (event.key === 'ArrowRight') next = width + KEYBOARD_RESIZE_STEP;
    else if (event.key === 'Home') next = NAVIGATOR_MIN_WIDTH;
    else if (event.key === 'End') next = NAVIGATOR_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    navigator.setWidth(next);
  };

  let body: ReactNode = null;
  switch (tab) {
    case 'thumbnails':
      body = renderThumbnails?.(filter) ?? null;
      break;
    case 'contents':
      body = contents ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OutlineTree
            items={contents.items}
            currentId={contents.currentId}
            filter={filter}
            dimRead={navigator.dimReadChapters}
            emptyMessage={contents.emptyMessage}
            onSelect={contents.onSelect}
          />
        </div>
      ) : null;
      break;
    case 'notes':
      body = (
        <AnnotationsList
          controller={annotations}
          filter={filter}
          {...(linkedAnnotationIds ? { linkedAnnotationIds } : {})}
          {...(annotationPlacement ? { placementOf: annotationPlacement } : {})}
          {...(compareAnnotations ? { compareWithinOrder: compareAnnotations } : {})}
          onDeleted={() => navigator.recordDeletion('annotation')}
        />
      );
      break;
    case 'bookmarks':
      body = (
        <BookmarksList
          controller={bookmarks}
          filter={filter}
          onRemoved={() => navigator.recordDeletion('bookmark')}
        />
      );
      break;
    case 'search':
      body = <SearchResultsList search={search} grouped={groupSearchResults} />;
      break;
  }

  return (
    <aside
      aria-label="Sidebar"
      data-testid="navigator-sidebar"
      data-navigator-tab={tab}
      className="relative flex h-full shrink-0 flex-col border-r bg-background text-foreground"
      style={{ width }}
    >
      <div
        role="tablist"
        aria-label="Sidebar views"
        className="mx-2 mt-2 mb-1.5 flex shrink-0 items-center rounded-md bg-muted p-0.5"
      >
        {tabs.map((candidate, index) => {
          const candidateSpec = TAB_SPECS[candidate];
          const Icon = candidateSpec.icon;
          const selected = candidate === tab;
          return (
            <button
              key={candidate}
              ref={(element) => {
                if (element) tabButtons.current.set(candidate, element);
                else tabButtons.current.delete(candidate);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${candidate}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              aria-label={candidateSpec.label}
              title={commandTooltip(candidateSpec.label, candidateSpec.command)}
              tabIndex={selected ? 0 : -1}
              data-testid={`navigator-tab-${candidate}`}
              onClick={() => navigator.show(candidate)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                'flex h-6 flex-1 items-center justify-center rounded-[5px] text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
                selected
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'hover:bg-background/60 hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        data-testid={`navigator-panel-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {spec.filterLabel && (
          <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
            <input
              type="search"
              aria-label={spec.filterLabel}
              placeholder="Filter"
              data-testid="navigator-filter"
              value={filter}
              onChange={(event) => setFilters({ ...filters, [tab]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter !== '') {
                  event.preventDefault();
                  event.stopPropagation();
                  setFilters({ ...filters, [tab]: '' });
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {tab === 'contents' && (
              <button
                type="button"
                aria-label="Dim chapters already read"
                aria-pressed={navigator.dimReadChapters}
                title="Dim chapters already read"
                data-testid="toc-dim-read-toggle"
                onClick={() => navigator.setDimReadChapters(!navigator.dimReadChapters)}
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                  navigator.dimReadChapters && 'bg-accent text-foreground',
                )}
              >
                <CircleCheck className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {body}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={NAVIGATOR_MIN_WIDTH}
        aria-valuemax={NAVIGATOR_MAX_WIDTH}
        tabIndex={0}
        data-testid="navigator-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onKeyDown={onResizeKeyDown}
        className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring"
      />
    </aside>
  );
}
