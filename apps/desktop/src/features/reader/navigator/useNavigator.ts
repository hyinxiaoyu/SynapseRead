import { useCallback, useRef, useState } from 'react';

import type { DocumentFormat } from '@/types/domain';

/**
 * The Navigator sidebar's views, in Preview's order. `search` appears only while
 * a query is active and is never remembered as the chosen tab.
 */
export type NavigatorTab = 'thumbnails' | 'contents' | 'notes' | 'bookmarks' | 'search';

export const NAVIGATOR_MIN_WIDTH = 180;
export const NAVIGATOR_MAX_WIDTH = 480;
export const NAVIGATOR_DEFAULT_WIDTH = 260;

const STORAGE_KEY = 'synapseread.navigator.v1';

interface StoredFormatPrefs {
  tab?: NavigatorTab;
  width?: number;
}

interface StoredPrefs {
  formats?: Partial<Record<DocumentFormat, StoredFormatPrefs>>;
  dimReadChapters?: boolean;
}

/**
 * Layout preferences, not study data: they stay in this webview's storage and
 * never reach the database or the network.
 */
function readStored(): StoredPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StoredPrefs) : {};
  } catch {
    return {};
  }
}

function writeStored(update: (current: StoredPrefs) => StoredPrefs) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(update(readStored())));
  } catch {
    // Storage can be full or disabled; the sidebar still works for this session.
  }
}

export function clampNavigatorWidth(width: number): number {
  if (!Number.isFinite(width)) return NAVIGATOR_DEFAULT_WIDTH;
  return Math.round(Math.min(NAVIGATOR_MAX_WIDTH, Math.max(NAVIGATOR_MIN_WIDTH, width)));
}

export interface NavigatorController {
  open: boolean;
  tab: NavigatorTab;
  width: number;
  /** The tabs this document supports, in display order (without `search`). */
  tabs: readonly NavigatorTab[];
  hasTab: (tab: NavigatorTab) => boolean;
  dimReadChapters: boolean;
  setDimReadChapters: (value: boolean) => void;
  toggle: () => void;
  hide: () => void;
  /** Opens the sidebar on `tab`. */
  show: (tab: NavigatorTab) => void;
  setWidth: (width: number) => void;
  /** A query started: its results take over the sidebar if it is open. */
  beginSearch: () => void;
  /** The query was cleared: the view search replaced comes back. */
  endSearch: () => void;
  /** Notes a deletion from the sidebar, so ⌘Z restores the most recent kind first. */
  recordDeletion: (kind: DeletedKind) => void;
  /** Takes the most recent recorded deletion, if any. */
  takeDeletion: () => DeletedKind | undefined;
}

export type DeletedKind = 'bookmark' | 'annotation';

/**
 * State for one reader's Navigator sidebar. The width and chosen tab persist per
 * document format, as Preview remembers them per window type.
 */
export function useNavigator(
  format: DocumentFormat,
  tabs: readonly Exclude<NavigatorTab, 'search'>[],
): NavigatorController {
  const fallbackTab = tabs[0] ?? 'bookmarks';
  const [open, setOpen] = useState(false);
  const [tab, setTabState] = useState<NavigatorTab>(() => {
    const stored = readStored().formats?.[format]?.tab;
    return stored && (tabs as readonly NavigatorTab[]).includes(stored) ? stored : fallbackTab;
  });
  const [width, setWidthState] = useState(() =>
    clampNavigatorWidth(readStored().formats?.[format]?.width ?? NAVIGATOR_DEFAULT_WIDTH),
  );
  const [dimReadChapters, setDimState] = useState(() => readStored().dimReadChapters === true);
  const [deletions, setDeletions] = useState<readonly DeletedKind[]>([]);
  /** The last tab that was not Search, so clearing a query can put it back. */
  const lastTab = useRef<NavigatorTab>(tab);

  const rememberFormat = useCallback(
    (patch: StoredFormatPrefs) => {
      writeStored((current) => ({
        ...current,
        formats: { ...current.formats, [format]: { ...current.formats?.[format], ...patch } },
      }));
    },
    [format],
  );

  const selectTab = useCallback(
    (next: NavigatorTab) => {
      setTabState(next);
      if (next !== 'search') {
        lastTab.current = next;
        rememberFormat({ tab: next });
      }
    },
    [rememberFormat],
  );

  const show = useCallback(
    (next: NavigatorTab) => {
      setOpen(true);
      selectTab(next);
    },
    [selectTab],
  );

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampNavigatorWidth(next);
      setWidthState(clamped);
      rememberFormat({ width: clamped });
    },
    [rememberFormat],
  );

  const setDimReadChapters = useCallback((value: boolean) => {
    setDimState(value);
    writeStored((current) => ({ ...current, dimReadChapters: value }));
  }, []);

  /**
   * A query started. Results replace the current view only when the sidebar is
   * already open: opening it would resize the page, and a fit-width PDF would
   * rescale and jump. Otherwise the reader asks for results from the search
   * field's list button or `view.sidebarSearch`.
   */
  const beginSearch = useCallback(() => {
    if (!open || tab === 'search') return;
    setTabState('search');
  }, [open, tab]);

  /**
   * The query was cleared. The view search replaced comes back and the sidebar
   * stays as it is: clearing must not resize the page either, and a sidebar the
   * reader opened for results stays open.
   */
  const endSearch = useCallback(() => {
    if (tab !== 'search') return;
    setTabState(lastTab.current);
  }, [tab]);

  return {
    open,
    tab,
    width,
    tabs,
    hasTab: (candidate) =>
      candidate === 'search' || (tabs as readonly NavigatorTab[]).includes(candidate),
    dimReadChapters,
    setDimReadChapters,
    toggle: () => setOpen((current) => !current),
    hide: () => setOpen(false),
    show,
    setWidth,
    beginSearch,
    endSearch,
    recordDeletion: (kind) => setDeletions((current) => [...current, kind]),
    takeDeletion: () => {
      const last = deletions.at(-1);
      if (last) setDeletions(deletions.slice(0, -1));
      return last;
    },
  };
}
