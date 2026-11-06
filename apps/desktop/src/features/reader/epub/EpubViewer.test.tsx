import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSearchSnippet,
  findSubstringMatches,
  SEARCH_HIGHLIGHT_ID,
} from '@/features/reader/DocumentSearch';
import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import {
  createStudySyncStore,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
} from '@/stores/useStudySyncStore';

import {
  type EpubLocation,
  type EpubReadingMode,
  type EpubSearchMatch,
  type EpubSelection,
  type EpubTocItem,
  openEpubDocument,
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
  setColumns: vi.fn<(columns: 1 | 2) => void>(),
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
    setColumns: engine.setColumns,
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
  const annotations = useMemo(
    () => selectDocumentAnnotations(state.annotations, documentId),
    [state.annotations, documentId],
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
      annotations={annotations}
      onCreateAnnotation={(options) => void state.createAnnotationFromSelection(options)}
      onUpdateAnnotation={(id, patch) => void state.updateAnnotation(id, patch)}
      onDeleteAnnotation={(id) => void state.removeAnnotation(id)}
      canUndoAnnotationDelete={state.deletedAnnotationHistory.length > 0}
      onUndoAnnotationDelete={() => void state.undoRemoveAnnotation()}
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

/**
 * At 1440 px, with the fallback character width (0.5em of 16.8 px = 8.4 px) and
 * normal margins (16 px): two columns of 75ch = 630 px, each page 630 + 64 px.
 */
let pageAreaWidth = 1440;
const TWO_PAGE_WIDTH = '1388px';
const ONE_PAGE_WIDTH = '694px';

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
    engine.setColumns.mockClear();
    // jsdom has no layout: give the page area a width, so the measure has room to work.
    pageAreaWidth = 1440;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.testid === 'epub-page-area' ? pageAreaWidth : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(await screen.findByText(/could not be found/)).toHaveAttribute('role', 'status');
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
    expect(viewer).toHaveAttribute('data-columns', '2');
    expect(host.style.width).toBe(TWO_PAGE_WIDTH);
    expect(screen.getByTestId('epub-spine')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Reading mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Two pages' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    expect(viewer).toHaveAttribute('data-reading-mode', 'paged');
    expect(viewer).toHaveAttribute('data-columns', '1');
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);
    expect(screen.queryByTestId('epub-spine')).not.toBeInTheDocument();
    expect(engine.setReadingMode).toHaveBeenLastCalledWith('paged');

    fireEvent.click(screen.getByRole('radio', { name: 'Scroll' }));
    expect(viewer).toHaveAttribute('data-reading-mode', 'scroll');
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);
    expect(engine.setReadingMode).toHaveBeenLastCalledWith('scroll');

    // The segmented control is one tab stop; arrow keys move and select, wrapping,
    // and do not also turn the page.
    const scroll = screen.getByRole('radio', { name: 'Scroll' });
    expect(scroll).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Two pages' })).toHaveAttribute('tabindex', '-1');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'ArrowLeft' });
    expect(viewer).toHaveAttribute('data-reading-mode', 'paged');
    expect(screen.getByRole('radio', { name: 'Single page' })).toHaveFocus();
    expect(engine.previous).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Single page' }), { key: 'End' });
    expect(viewer).toHaveAttribute('data-reading-mode', 'scroll');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Scroll' }), { key: 'ArrowRight' });
    expect(viewer).toHaveAttribute('data-reading-mode', 'spread');
  });

  it('persists reading mode and appearance preferences across restart', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reading appearance' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Sepia' }));
    fireEvent.click(screen.getByRole('radio', { name: 'San Francisco' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const margins = screen.getByRole('radiogroup', { name: 'Margins' });
    fireEvent.click(within(margins).getByRole('radio', { name: 'Wide' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Justify' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Dim images in Dark theme' }));

    await waitFor(() =>
      expect(store.getState().readingPreferences).toEqual({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 110,
        lineSpacing: 1.75,
        margins: 'wide',
        justify: false,
        dimImages: true,
        epubReadingMode: 'paged',
      }),
    );
    expect(engine.setPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 110,
        margins: 'wide',
        justify: false,
      }),
    );
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-theme', 'sepia');
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-margins', 'wide');
    // The page's color fills the margins around it.
    expect(screen.getByTestId('epub-page-area').style.backgroundColor).toBe('rgb(244, 236, 216)');
    view.unmount();

    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-mode', 'paged');
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-theme', 'sepia');
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-margins', 'wide');
  });

  it('shows two pages only where each column holds the minimum measure', async () => {
    // 900 px: two columns would be (868 / 2 - 64) = 370 px, under 45ch (378 px).
    pageAreaWidth = 900;
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();

    const viewer = screen.getByTestId('epub-viewer');
    expect(viewer).toHaveAttribute('data-reading-mode', 'spread');
    expect(viewer).toHaveAttribute('data-columns', '1');
    expect(screen.queryByTestId('epub-spine')).not.toBeInTheDocument();
    expect(vi.mocked(openEpubDocument).mock.lastCall?.[4]).toBe(1);
    view.unmount();

    pageAreaWidth = 2560;
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-columns', '2');
    // Capped at 75ch per column: the pages stay 1388 px and center in the window.
    expect(screen.getByTestId('epub-host').style.width).toBe(TWO_PAGE_WIDTH);
    expect(vi.mocked(openEpubDocument).mock.lastCall?.[4]).toBe(2);
  });

  it('settles the Auto theme against the system appearance', async () => {
    const listeners = new Set<() => void>();
    let dark = true;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return dark;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      })),
    );
    try {
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await opened();

      const viewer = screen.getByTestId('epub-viewer');
      expect(viewer).toHaveAttribute('data-reading-theme', 'auto');
      expect(viewer).toHaveAttribute('data-resolved-theme', 'dark');
      expect(engine.setPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'dark' }),
      );

      dark = false;
      act(() => {
        for (const listener of listeners) listener();
      });
      expect(viewer).toHaveAttribute('data-resolved-theme', 'light');
      expect(engine.setPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'light' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
    fireEvent.click(screen.getByRole('radio', { name: 'Scroll' }));
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

    // The sidebar opens on Contents, with the current chapter's path expanded.
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    const toc = screen.getByTestId('reader-toc');
    expect(toc).toBeInTheDocument();
    expect(screen.getByTestId('navigator-tab-contents')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('navigator-tab-thumbnails')).not.toBeInTheDocument();
    const one = screen.getByRole('treeitem', { name: 'One' });
    expect(one).toHaveAttribute('aria-current', 'location');
    expect(one).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'Section 1.1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('treeitem', { name: 'Two' }));
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
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true, metaKey: true });
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
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Match case/ }));
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

    // Show Bookmarks in the sidebar and jump back to Chapter One's bookmark.
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    fireEvent.click(screen.getByTestId('navigator-tab-bookmarks'));
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
    expect(await screen.findByText(/could not be found in this book/)).toHaveAttribute(
      'role',
      'status',
    );

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await opened();
    // The Bookmarks tab is remembered for EPUB documents.
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    expect(await screen.findAllByTestId('bookmark-item')).toHaveLength(2);

    const removeButtons = screen.getAllByTestId('bookmark-remove-button');
    fireEvent.click(removeButtons[0] as HTMLElement);
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));
  });

  it('creates, lists, jumps to, edits, deletes, and undoes independent highlights and notes without creating MindMap cards', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    select(CFI, 'quick brown fox');
    fireEvent.click(screen.getByTestId('annotation-color-pink'));
    fireEvent.click(screen.getByTestId('highlight-selection-button'));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    const annotationId = store.getState().annotations[0]?.id as string;
    expect(engine.highlighted.get(annotationId)).toBe(CFI);

    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true, metaKey: true });
    expect(await screen.findByTestId('annotation-item')).toHaveTextContent('quick brown fox');
    // Grouped under the chapter's TOC title.
    expect(screen.getByTestId('annotation-group')).toHaveTextContent('One');

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    const noteInput = screen.getByTestId('annotation-note-input');
    fireEvent.change(noteInput, { target: { value: 'EPUB chapter note' } });
    fireEvent.blur(noteInput);
    await waitFor(() => expect(store.getState().annotations[0]?.note).toBe('EPUB chapter note'));

    fireEvent.click(screen.getByTestId('annotation-jump-button'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(CFI));

    fireEvent.click(screen.getByTestId('annotation-delete-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));
    expect(engine.removed).toContain(CFI);

    fireEvent.click(await screen.findByTestId('undo-delete-annotation-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.note).toBe('EPUB chapter note');
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
