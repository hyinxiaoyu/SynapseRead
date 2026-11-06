import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSearchSnippet,
  findSubstringMatches,
  SEARCH_HIGHLIGHT_ID,
} from '@/features/reader/DocumentSearchBar';
import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import {
  createStudySyncStore,
  selectBookmarks,
  selectHighlights,
} from '@/stores/useStudySyncStore';

import type {
  EpubLocation,
  EpubReadingMode,
  EpubSearchMatch,
  EpubSelection,
  EpubTocItem,
} from './epubEngine';
import { EpubViewer } from './EpubViewer';

// jsdom has no layout for epub.js to render into: this replaces only the engine seam,
// and `pnpm e2e` drives the real one. Everything above that seam here is real.
const engine = vi.hoisted(() => ({
  toc: [] as EpubTocItem[],
  isFixedLayout: false,
  chapters: [
    {
      href: 'OEBPS/chapter1.xhtml',
      label: 'One',
      text: 'The quick brown fox jumps over the lazy dog.',
      cfi: 'epubcfi(/6/2!/4/6,/1:4,/1:19)',
    },
    {
      href: 'OEBPS/chapter2.xhtml',
      label: 'Two',
      text: 'Second chapter contains final target sentence and Fox.',
      cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:10)',
    },
  ],
  displayed: [] as (string | undefined)[],
  highlighted: new Map<string, string>(),
  removed: [] as string[],
  pulsing: new Set<string>(),
  selectionCleared: 0,
  destroyed: 0,
  failCfi: null as string | null,
  emitSelection: (() => undefined) as (selection: unknown) => void,
  emitLocation: (() => undefined) as (location: unknown) => void,
  emitKeyDown: (() => undefined) as (event: KeyboardEvent) => void,
  next: vi.fn(async () => undefined),
  previous: vi.fn(async () => undefined),
  setReadingMode: vi.fn<(mode: EpubReadingMode) => Promise<void>>(async () => undefined),
  setPreferences: vi.fn(),
}));

vi.mock('./epubEngine', () => ({
  openEpubDocument: vi.fn(async () => ({
    get toc() {
      return engine.toc;
    },
    get isFixedLayout() {
      return engine.isFixedLayout;
    },
    get chapterCount() {
      return engine.chapters.length;
    },
    async searchChapter(
      chapterIndex: number,
      query: string,
      options?: { caseSensitive?: boolean },
    ): Promise<readonly EpubSearchMatch[]> {
      const chapter = engine.chapters[chapterIndex];
      if (!chapter) return [];
      const matches = findSubstringMatches(chapter.text, query, options?.caseSensitive ?? false);
      return matches.map((match, index) => ({
        id: `epub-${chapterIndex}-${index}`,
        cfiRange: chapter.cfi,
        chapterHref: chapter.href,
        chapterIndex,
        locationLabel: chapter.label,
        ...buildSearchSnippet(chapter.text, match.start, match.end),
      }));
    },
    async display(target?: string) {
      if (target && target === engine.failCfi) throw new Error('no such location');
      engine.displayed.push(target);
    },
    next: engine.next,
    previous: engine.previous,
    setReadingMode: engine.setReadingMode,
    setPreferences: engine.setPreferences,
    highlight: (annotationId: string, cfiRange: string) =>
      void engine.highlighted.set(annotationId, cfiRange),
    removeHighlight: (cfiRange: string) => void engine.removed.push(cfiRange),
    setPulse(annotationId: string, pulsing: boolean) {
      if (pulsing) engine.pulsing.add(annotationId);
      else engine.pulsing.delete(annotationId);
      return engine.highlighted.has(annotationId);
    },
    clearSelection() {
      engine.selectionCleared += 1;
    },
    resize: () => undefined,
    onSelection(listener: (selection: EpubSelection | null) => void) {
      engine.emitSelection = listener as (selection: unknown) => void;
    },
    onLocation(listener: (location: EpubLocation) => void) {
      engine.emitLocation = listener as (location: unknown) => void;
    },
    onKeyDown(listener: (event: KeyboardEvent) => void) {
      engine.emitKeyDown = listener;
    },
    destroy() {
      engine.destroyed += 1;
    },
  })),
}));

const CFI = 'epubcfi(/6/2!/4/6,/1:4,/1:19)';
const FAR_CFI = 'epubcfi(/6/4!/4/4,/1:0,/1:10)';

type Store = ReturnType<typeof createStudySyncStore>;

function Harness({
  store,
  documentId,
  isActive = true,
}: {
  store: Store;
  documentId: string;
  isActive?: boolean;
}) {
  const state = store();
  const document = state.documents.find((candidate) => candidate.id === documentId);
  const highlights = useMemo(
    () => selectHighlights(state.annotations, documentId),
    [state.annotations, documentId],
  );
  const bookmarks = useMemo(
    () => selectBookmarks(state.bookmarks, documentId),
    [state.bookmarks, documentId],
  );
  if (document?.format !== 'epub') throw new Error('expected an epub document');
  return (
    <EpubViewer
      document={{ ...document, format: 'epub' }}
      isActive={isActive}
      content={state.content}
      highlights={highlights}
      jumpRequest={state.jumpRequest?.documentId === documentId ? state.jumpRequest : null}
      onSelectionChange={state.setSelection}
      onJumpHandled={state.completeJump}
      onCursorChange={(anchor) => state.reportCursor(documentId, anchor)}
      preferences={state.readingPreferences}
      onPreferencesChange={(patch) => void state.updateReadingPreferences(patch)}
      bookmarks={bookmarks}
      onAddBookmark={(anchor, label) => void state.addBookmark(documentId, anchor, label)}
      onRemoveBookmark={(id) => void state.removeBookmark(id)}
    />
  );
}

const setup = async () => {
  const backend = createMemoryBackend({ library: { '/books/book.epub': new Uint8Array([1]) } });
  const store = createStudySyncStore(backend);
  await store.getState().initialize();
  await store.getState().openDocument();
  return { backend, store, documentId: store.getState().activeDocumentId as string };
};

const reopen = async (backend: ReturnType<typeof createMemoryBackend>) => {
  const store = createStudySyncStore(backend);
  await store.getState().initialize();
  await store.getState().openDocument();
  return store;
};

const opened = () =>
  waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());

const select = (cfiRange = CFI, text = 'quick brown fox') =>
  act(() => engine.emitSelection({ cfiRange, chapterHref: 'OEBPS/chapter1.xhtml', text }));

describe('EpubViewer', () => {
  beforeEach(() => {
    engine.toc = [
      {
        id: 'toc-1',
        label: 'One',
        href: 'OEBPS/chapter1.xhtml',
        children: [
          { id: 'toc-1-1', label: 'Section 1.1', href: 'OEBPS/chapter1.xhtml#s1', children: [] },
        ],
      },
      { id: 'toc-2', label: 'Two', href: 'OEBPS/chapter2.xhtml', children: [] },
    ];
    engine.displayed = [];
    engine.highlighted = new Map();
    engine.removed = [];
    engine.pulsing = new Set();
    engine.selectionCleared = 0;
    engine.destroyed = 0;
    engine.failCfi = null;
    engine.next.mockClear();
    engine.previous.mockClear();
    engine.setReadingMode.mockClear();
    engine.setPreferences.mockClear();
  });

  it('runs selection -> CFI anchor -> persist -> reopen', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    select();
    expect(store.getState().selection).toEqual({
      documentId,
      anchor: { format: 'epub', cfiRange: CFI, chapterHref: 'OEBPS/chapter1.xhtml' },
      text: 'quick brown fox',
      imagePng: null,
    });

    await act(() => store.getState().excerptSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    await waitFor(() => expect(engine.highlighted.get(annotationId)).toBe(CFI));
    expect(store.getState().cards[0]?.title).toBe('quick brown fox');
    view.unmount();

    engine.highlighted = new Map();
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    await waitFor(() => expect(engine.highlighted.get(annotationId)).toBe(CFI));
  });

  it('clears the selection when the frame reports it collapsed', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    select();
    expect(store.getState().selection).not.toBeNull();

    act(() => engine.emitSelection(null));
    expect(store.getState().selection).toBeNull();
  });

  it('ignores selection reports while its tab is hidden, and clears the frame', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    view.rerender(<Harness store={store} documentId={documentId} isActive={false} />);
    await waitFor(() => expect(engine.selectionCleared).toBe(1));
    act(() => undefined);
    select();
    expect(store.getState().selection).toBeNull();
  });

  it('runs a jump round trip: display, pulse, complete', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    select(FAR_CFI, 'far away');
    await act(() => store.getState().excerptSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    await waitFor(() => expect(engine.highlighted.has(annotationId)).toBe(true));
    const nodeId = store.getState().nodes[0]?.id as string;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => store.getState().jumpToNode(nodeId));
      await waitFor(() => expect(engine.pulsing.has(annotationId)).toBe(true));
      expect(engine.displayed.at(-1)).toBe(FAR_CFI);
      expect(store.getState().jumpRequest).not.toBeNull();

      await act(async () => void vi.advanceTimersByTime(PULSE_MS + 10));
      expect(store.getState().jumpRequest).toBeNull();
      expect(engine.pulsing.has(annotationId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a jump to a location the book no longer has, and says so', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    engine.failCfi = FAR_CFI;
    act(() =>
      store.setState({
        jumpRequest: {
          nonce: 5,
          documentId,
          annotationId: 'gone',
          anchor: { format: 'epub', cfiRange: FAR_CFI, chapterHref: 'gone.xhtml' },
        },
      }),
    );
    await waitFor(() => expect(store.getState().jumpRequest).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent(/could not be found/);
  });

  it('reopens at the last reading position, without overwriting it first', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();
    expect(engine.displayed).toEqual([undefined]);

    act(() => engine.emitLocation({ cfi: FAR_CFI, href: 'OEBPS/chapter2.xhtml' }));
    await waitFor(
      () =>
        expect(store.getState().documents[0]?.lastCursorAnchor).toEqual({
          format: 'epub',
          cfiRange: FAR_CFI,
          chapterHref: 'OEBPS/chapter2.xhtml',
        }),
      { timeout: 2000 },
    );
    view.unmount();

    engine.displayed = [];
    const reopened = await reopen(backend);
    const update = vi.spyOn(backend, 'updateDocumentCursor');
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    expect(engine.displayed).toEqual([FAR_CFI]);

    // Displaying reports where it landed, which is not news.
    act(() => engine.emitLocation({ cfi: FAR_CFI, href: 'OEBPS/chapter2.xhtml' }));
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(update).not.toHaveBeenCalled();
  });

  it('opens the book anyway if the saved position is unusable', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();
    act(() =>
      store.getState().reportCursor(documentId, {
        format: 'epub',
        cfiRange: FAR_CFI,
        chapterHref: 'gone.xhtml',
      }),
    );
    view.unmount();

    engine.displayed = [];
    engine.failCfi = FAR_CFI;
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    expect(engine.displayed).toEqual([undefined]);
  });

  it('flushes a debounced position when the tab closes', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();
    const update = vi.spyOn(backend, 'updateDocumentCursor');

    act(() => engine.emitLocation({ cfi: FAR_CFI, href: 'OEBPS/chapter2.xhtml' }));
    view.unmount();

    expect(update).toHaveBeenCalledWith(
      documentId,
      expect.objectContaining({ format: 'epub', cfiRange: FAR_CFI }),
    );
    expect(engine.destroyed).toBe(1);
  });

  it('moves through the book with its controls and Left/Right arrow keys', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(engine.next).toHaveBeenCalledOnce();
    expect(engine.previous).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(engine.next).toHaveBeenCalledTimes(2);
    expect(engine.previous).toHaveBeenCalledTimes(2);

    act(() => engine.emitKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    act(() => engine.emitKeyDown(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
    expect(engine.next).toHaveBeenCalledTimes(3);
    expect(engine.previous).toHaveBeenCalledTimes(3);

    view.rerender(<Harness store={store} documentId={documentId} isActive={false} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(engine.next).toHaveBeenCalledTimes(3);
  });

  it('defaults to two-page spread mode and switches between reading modes', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    const viewer = screen.getByTestId('epub-viewer');
    const host = screen.getByTestId('epub-host');
    expect(viewer).toHaveAttribute('data-reading-mode', 'spread');
    expect(host).toHaveClass('max-w-none');
    expect(screen.getByRole('button', { name: 'Two pages' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Single page' }));
    expect(viewer).toHaveAttribute('data-reading-mode', 'paged');
    expect(host).toHaveClass('max-w-6xl');
    expect(engine.setReadingMode).toHaveBeenLastCalledWith('paged');

    fireEvent.click(screen.getByRole('button', { name: 'Scroll' }));
    expect(viewer).toHaveAttribute('data-reading-mode', 'scroll');
    expect(host).toHaveClass('max-w-6xl');
    expect(engine.setReadingMode).toHaveBeenLastCalledWith('scroll');
  });

  it('persists reading mode and appearance preferences across restart', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    fireEvent.click(screen.getByRole('button', { name: 'Single page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reading appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sepia' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sans' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wide' }));

    await waitFor(() =>
      expect(store.getState().readingPreferences).toEqual({
        theme: 'sepia',
        fontFamily: 'sans',
        fontSize: 110,
        lineSpacing: 1.75,
        readingWidth: 'wide',
        epubReadingMode: 'paged',
      }),
    );
    expect(engine.setPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'sepia',
        fontFamily: 'sans',
        fontSize: 110,
        readingWidth: 'wide',
      }),
    );
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-theme', 'sepia');
    expect(screen.getByTestId('epub-host')).toHaveClass('max-w-7xl');
    view.unmount();

    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-mode', 'paged');
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-theme', 'sepia');
    expect(screen.getByTestId('epub-host')).toHaveClass('max-w-7xl');
  });

  it('distinguishes chapter-local pages from whole-book progress', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 2,
        totalPages: 4,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 25,
      }),
    );

    expect(screen.getByTestId('epub-chapter-page')).toHaveTextContent('Chapter page 2 of 4');
    expect(screen.getByTestId('epub-book-progress')).toHaveTextContent('Book 25% (Ch. 1/2)');

    // Scroll mode hides chapter pages while keeping whole-book progress visible.
    fireEvent.click(screen.getByRole('button', { name: 'Scroll' }));
    expect(screen.queryByTestId('epub-chapter-page')).not.toBeInTheDocument();
    expect(screen.getByTestId('epub-book-progress')).toHaveTextContent('Book 25% (Ch. 1/2)');
  });

  it('navigates nested TOC entries, handles empty TOCs, and returns to previous locations', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 1,
        totalPages: 3,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 17,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Table of contents' }));
    const toc = screen.getByTestId('reader-toc');
    expect(toc).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('button', { name: 'Section 1.1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe('OEBPS/chapter2.xhtml'));

    const backButton = await screen.findByRole('button', { name: 'Return to previous location' });
    fireEvent.click(backButton);
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(CFI));
    expect(
      screen.queryByRole('button', { name: 'Return to previous location' }),
    ).not.toBeInTheDocument();

    view.unmount();

    // Empty outline state
    engine.toc = [];
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Table of contents' }));
    expect(screen.getByTestId('reader-toc')).toHaveTextContent(
      'No table of contents in this book.',
    );
  });

  it('opens search via iframe Cmd/Ctrl+F, searches across chapters, highlights CFI matches, and supports return', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 1,
        totalPages: 2,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 25,
      }),
    );

    // Trigger Cmd+F from inside the EPUB iframe via `emitKeyDown`.
    act(() =>
      engine.emitKeyDown(
        new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true }),
      ),
    );
    const searchInput = await screen.findByTestId('search-input');

    // Search for "fox", matching both Chapter One ("fox") and unrendered Chapter Two ("Fox").
    fireEvent.change(searchInput, { target: { value: 'fox' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 2'));
    expect(engine.highlighted.get(SEARCH_HIGHLIGHT_ID)).toBe(CFI);

    // Jump to the next match in Chapter Two.
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('2 of 2'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(FAR_CFI));
    expect(engine.highlighted.get(SEARCH_HIGHLIGHT_ID)).toBe(FAR_CFI);
    expect(engine.pulsing.has(SEARCH_HIGHLIGHT_ID)).toBe(true);

    // Return to previous location returns to Chapter One (`CFI`).
    const backButton = await screen.findByRole('button', { name: 'Return to previous location' });
    fireEvent.click(backButton);
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(CFI));

    // Case-sensitive search narrows to only Chapter Two's "Fox".
    fireEvent.change(searchInput, { target: { value: 'Fox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
    expect(screen.getByTestId('search-result-location')).toHaveTextContent('Two');
  });

  it('adds, lists, jumps to, persists, removes, and handles stale bookmarks without creating cards or annotations', async () => {
    const { backend, store, documentId } = await setup();
    const first = render(<Harness store={store} documentId={documentId} />);
    await opened();

    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 1,
        totalPages: 2,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 25,
      }),
    );

    // Trigger Cmd+D from inside the EPUB iframe via `emitKeyDown`.
    act(() =>
      engine.emitKeyDown(
        new KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true }),
      ),
    );
    await waitFor(() => expect(store.getState().bookmarks).toHaveLength(1));
    expect(store.getState().annotations).toEqual([]);
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'true');

    // Move to Chapter Two (`FAR_CFI`) and verify the toggle button reflects the new location.
    act(() =>
      engine.emitLocation({
        cfi: FAR_CFI,
        href: 'OEBPS/chapter2.xhtml',
        page: 1,
        totalPages: 2,
        chapterIndex: 1,
        totalChapters: 2,
        bookProgress: 75,
      }),
    );
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'false');

    // Open the bookmarks panel and jump back to Chapter One's bookmark.
    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
    expect(await screen.findByTestId('bookmark-label')).toHaveTextContent('One · Page 1');
    fireEvent.click(screen.getByTestId('bookmark-jump-button'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(CFI));

    // Return to previous location returns to Chapter Two (`FAR_CFI`).
    const backButton = await screen.findByRole('button', { name: 'Return to previous location' });
    fireEvent.click(backButton);
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(FAR_CFI));

    // Add a stale bookmark whose CFI fails `display` and verify stale badge & status.
    const staleCfi = 'epubcfi(/6/99!/4/2/1:0)';
    engine.failCfi = staleCfi;
    await act(() =>
      store.getState().addBookmark(
        documentId,
        {
          format: 'epub',
          chapterHref: 'OEBPS/missing.xhtml',
          cfiRange: staleCfi,
        },
        'Missing chapter',
      ),
    );
    const jumpButtons = screen.getAllByTestId('bookmark-jump-button');
    fireEvent.click(jumpButtons[1] as HTMLElement);
    expect(await screen.findByTestId('bookmark-stale')).toHaveTextContent('Stale');
    expect(await screen.findByRole('status')).toHaveTextContent(/could not be found in this book/);

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
    expect(await screen.findAllByTestId('bookmark-item')).toHaveLength(2);

    const removeButtons = screen.getAllByTestId('bookmark-remove-button');
    fireEvent.click(removeButtons[0] as HTMLElement);
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));
  });

  it('shows why a book could not open', async () => {
    const backend = createMemoryBackend({
      library: {
        '/books/book.epub': async () => {
          throw { code: 'io', message: 'file is gone' };
        },
      },
    });
    const store = createStudySyncStore(backend);
    await store.getState().initialize();
    await store.getState().openDocument();
    render(<Harness store={store} documentId={store.getState().activeDocumentId as string} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('file is gone');
  });
});
