import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSearchSnippet,
  findSearchMatches,
  type SearchOptions,
  SEARCH_HIGHLIGHT_ID,
  searchMatchId,
} from '@/features/reader/DocumentSearch';
import type { PageGestureSample, WheelSample } from '@/features/reader/paging/pageTurn';
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
  highlightStyles: new Map<string, string>(),
  noted: new Set<string>(),
  removed: [] as string[],
  pulsing: new Set<string>(),
  selectionCleared: 0,
  destroyed: 0,
  failCfi: null as string | null,
  emitSelection: (() => undefined) as (selection: unknown) => void,
  emitLocation: (() => undefined) as (location: unknown) => void,
  emitInternalLink: (() => undefined) as (href: string) => void,
  emitKeyDown: (() => undefined) as (event: KeyboardEvent) => void,
  emitGesture: (() => undefined) as (sample: PageGestureSample) => void,
  emitWheel: (() => false) as (wheel: WheelSample) => boolean,
  emitMarkClick: (() => undefined) as (annotationId: string, rect: null) => void,
  emitPointer: (() => undefined) as (down: boolean) => void,
  cursor: '',
  displayedFractions: [] as [number, number][],
  /** The engine's text measurement; null leaves it out, as the old seam did. */
  measure: null as ((index: number) => Promise<{ characters: number; cjk: number } | null>) | null,
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
      options?: SearchOptions,
    ): Promise<readonly EpubSearchMatch[]> {
      const chapter = engine.chapters[chapterIndex];
      if (!chapter) return [];
      const matches = findSearchMatches(chapter.text, query, options);
      return matches.map((match, index) => ({
        id: `epub-${chapterIndex}-${index}`,
        // Distinct ranges: epub.js keys marks by CFI, not by annotation id.
        cfiRange: index === 0 ? chapter.cfi : `${chapter.cfi}@${index}`,
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
    // Stands in for `EpubCFI.compare`: the fixture's CFIs sort in book order.
    compareCfi: (one: string, two: string) => (one === two ? 0 : one < two ? -1 : 1),
    spineIndexOf: (href: string) =>
      engine.chapters.findIndex((chapter) => chapter.href === href.split('#')[0]),
    spineHref: (index: number) => engine.chapters[index]?.href,
    get measureChapter() {
      return engine.measure ?? undefined;
    },
    async displayChapterFraction(index: number, fraction: number) {
      engine.displayedFractions.push([index, fraction]);
      engine.displayed.push(engine.chapters[index]?.href);
    },
    next: engine.next,
    previous: engine.previous,
    setReadingMode: engine.setReadingMode,
    setPreferences: engine.setPreferences,
    setColumns: engine.setColumns,
    highlight(
      annotationId: string,
      cfiRange: string,
      _color: string,
      style = 'highlight',
      options: { hasNote?: boolean } = {},
    ) {
      engine.highlighted.set(annotationId, cfiRange);
      engine.highlightStyles.set(annotationId, style);
      if (options.hasNote) engine.noted.add(annotationId);
      else engine.noted.delete(annotationId);
    },
    removeHighlight: (cfiRange: string) => {
      engine.removed.push(cfiRange);
      // epub.js keys marks by CFI, so removing one removes every id at that range.
      for (const [id, range] of engine.highlighted) {
        if (range === cfiRange) engine.highlighted.delete(id);
      }
    },
    setPulse(annotationId: string, pulsing: boolean) {
      if (pulsing) engine.pulsing.add(annotationId);
      else engine.pulsing.delete(annotationId);
      return engine.highlighted.has(annotationId);
    },
    clearSelection() {
      engine.selectionCleared += 1;
    },
    resize: () => undefined,
    selectionRect: () => null,
    onMarkClick(listener: (annotationId: string, rect: null) => void) {
      engine.emitMarkClick = listener;
    },
    onPointer(listener: (down: boolean) => void) {
      engine.emitPointer = listener;
    },
    onSelection(listener: (selection: EpubSelection | null) => void) {
      engine.emitSelection = listener as (selection: unknown) => void;
    },
    onLocation(listener: (location: EpubLocation) => void) {
      engine.emitLocation = listener as (location: unknown) => void;
    },
    onInternalLink(listener: (href: string) => void) {
      engine.emitInternalLink = listener;
    },
    onKeyDown(listener: (event: KeyboardEvent) => void) {
      engine.emitKeyDown = listener;
    },
    onGesture(listener: (sample: PageGestureSample) => void) {
      engine.emitGesture = listener;
    },
    onWheel(listener: (wheel: WheelSample) => boolean) {
      engine.emitWheel = listener;
    },
    setCursor(cursor: string) {
      engine.cursor = cursor;
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
  chromeHidden = false,
}: {
  store: Store;
  documentId: string;
  isActive?: boolean;
  chromeHidden?: boolean;
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
      chromeHidden={chromeHidden}
      content={state.content}
      highlights={highlights}
      jumpRequest={state.jumpRequest?.documentId === documentId ? state.jumpRequest : null}
      onSelectionChange={state.setSelection}
      onJumpHandled={state.completeJump}
      onCursorChange={(anchor, progress) => state.reportCursor(documentId, anchor, progress)}
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

/**
 * The book is open and wired up. The button enables on the commit that sets the
 * handle, but that commit's effects (the engine's preferences, the page-turn
 * callbacks) run in a later task, which under load is after the test's next
 * synchronous assertion. Every such commit hands the engine its preferences.
 */
const opened = () =>
  waitFor(() => {
    expect(screen.getByRole('button', { name: 'Next Page' })).toBeEnabled();
    expect(engine.setPreferences).toHaveBeenCalled();
  });

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
    engine.highlightStyles = new Map();
    engine.noted = new Set();
    engine.removed = [];
    engine.pulsing = new Set();
    engine.selectionCleared = 0;
    engine.destroyed = 0;
    engine.failCfi = null;
    engine.displayedFractions = [];
    engine.cursor = '';
    engine.measure = null;
    window.localStorage.clear();
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

  it('gives the page the keyboard on open and on tab activation, unless a field has focus', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} isActive={false} />);
    const host = await screen.findByTestId('epub-host');
    expect(host).not.toHaveFocus();

    view.rerender(<Harness store={store} documentId={documentId} isActive />);
    await waitFor(() => expect(screen.getByTestId('epub-host')).toHaveFocus());

    // Switching tabs while typing must not take the keyboard away from the field.
    const field = screen.getByTestId('search-input') as HTMLInputElement;
    field.focus();
    view.rerender(<Harness store={store} documentId={documentId} isActive={false} />);
    view.rerender(<Harness store={store} documentId={documentId} isActive />);
    expect(field).toHaveFocus();
  });

  it('goes to a percentage of the book from the Go To box (go.page)', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const host = await screen.findByTestId('epub-host');
    await waitFor(() => expect(host).toHaveFocus());
    const input = screen.getByTestId('go-to-input');
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveAccessibleName('Go to percentage of book');

    fireEvent.keyDown(window, { key: 'g', code: 'KeyG', altKey: true, ctrlKey: true });
    expect(input).toHaveFocus();
    // A bare number is a percentage: a book has no lines to count.
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(engine.displayedFractions.at(-1)).toEqual([1, 0.5]));
    expect(host).toHaveFocus();
    expect(input).toHaveValue('');

    input.focus();
    fireEvent.change(input, { target: { value: '150%' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();

    // Esc gives the page the keyboard back without going anywhere.
    const jumps = engine.displayedFractions.length;
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(host).toHaveFocus();
    expect(input).toHaveValue('');
    expect(engine.displayedFractions).toHaveLength(jumps);
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
      undefined,
    );
    expect(engine.destroyed).toBe(1);
  });

  it('moves through the book with its controls and Left/Right arrow keys', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Next Page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous Page' }));
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
    fireEvent.click(screen.getByRole('radio', { name: 'Full width' }));
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
        pageWidth: 'full',
        justify: false,
        dimImages: true,
        epubReadingMode: 'paged',
        pageTransition: 'slide',
        tintPdfPages: false,
        focusModeFullScreen: false,
      }),
    );
    expect(engine.setPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 110,
        margins: 'wide',
        pageWidth: 'full',
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

  it('keeps font size and page width independent across adjustments', async () => {
    pageAreaWidth = 1440;
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    const host = screen.getByTestId('epub-host');
    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);

    fireEvent.click(screen.getByRole('button', { name: 'Reading appearance' }));
    // Increase font size to 160%, then switch page width across Wide, Full width, and Standard.
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }));
    }
    expect(screen.getByTestId('reading-font-size')).toHaveTextContent('160%');
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }));
    expect(screen.getByTestId('reading-font-size')).toHaveTextContent('160%');
    expect(host.style.width).toBe(`${110 * 8.4 + 64}px`);

    fireEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    expect(screen.getByTestId('reading-font-size')).toHaveTextContent('160%');
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);

    // Increasing font size all the way to 200% in Standard width never expands to full width.
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }));
    }
    expect(screen.getByTestId('reading-font-size')).toHaveTextContent('200%');
    expect(host.style.width).toBe(ONE_PAGE_WIDTH);
    await waitFor(() =>
      expect(store.getState().readingPreferences).toMatchObject({
        fontSize: 200,
        pageWidth: 'standard',
      }),
    );
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

  it('shows progress in a footer whose readout cycles, and the chapter in the toolbar', async () => {
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
        fraction: 0.125,
      }),
    );

    expect(screen.getByTestId('reader-toolbar-subtitle')).toHaveTextContent('One');
    const readout = screen.getByTestId('reader-footer-readout');
    expect(readout).toHaveTextContent('2 pages left in chapter');
    fireEvent.click(readout);
    expect(readout).toHaveTextContent('Page 2 of 4 in chapter');
    fireEvent.click(readout);
    expect(readout).toHaveTextContent('25% of book');
    fireEvent.click(readout);
    expect(readout).toHaveTextContent('2 pages left in chapter');

    // Scroll mode has no pages: only whole-book progress remains, and it is remembered.
    fireEvent.click(readout);
    fireEvent.click(readout);
    fireEvent.click(screen.getByRole('radio', { name: 'Scroll' }));
    expect(screen.getByTestId('reader-footer-readout')).toHaveTextContent('25% of book');
    expect(JSON.parse(window.localStorage.getItem('synapseread.footer.v1') ?? '{}')).toEqual({
      readout: 'percent',
    });
  });

  it('scrubs by chapter with ticks, a spoken position, keys, and a Back chip', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 3,
        totalPages: 4,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 38,
        fraction: 0.25,
      }),
    );

    const slider = screen.getByRole('slider', { name: 'Reading position' });
    expect(slider).toHaveAttribute('aria-valuenow', '25');
    expect(slider).toHaveAttribute('aria-valuetext', 'Chapter 1 of 2, 38%');
    // Chapter Two starts halfway through the spine.
    const ticks = screen.getAllByTestId('progress-scrubber-tick');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveStyle({ left: '50%' });

    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 20));
    fireEvent.pointerMove(slider, { clientX: 150 });
    expect(screen.getByTestId('progress-scrubber-tooltip')).toHaveTextContent('Two · 75%');
    fireEvent.pointerDown(slider, { clientX: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 150, button: 0, pointerId: 1 });
    await waitFor(() => expect(engine.displayedFractions).toEqual([[1, 0.5]]));
    const chip = await screen.findByTestId('reader-back-chip');
    expect(chip).toHaveTextContent('Back to One, page 3');
    fireEvent.click(chip);
    expect(engine.displayed.at(-1)).toBe(CFI);
    expect(screen.queryByTestId('reader-back-chip')).not.toBeInTheDocument();

    // Arrow keys turn a page, Page Up and Page Down move a chapter.
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(engine.next).toHaveBeenCalledOnce();
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(engine.displayed.at(-1)).toBe('OEBPS/chapter2.xhtml');
  });

  it('follows an internal book link, remembers where it came from, and returns', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 3,
        totalPages: 4,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 38,
        fraction: 0.25,
      }),
    );

    act(() => engine.emitInternalLink('OEBPS/chapter2.xhtml'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe('OEBPS/chapter2.xhtml'));
    const chip = await screen.findByTestId('reader-back-chip');
    expect(chip).toHaveTextContent('Back to One, page 3');

    fireEvent.click(chip);
    expect(engine.displayed.at(-1)).toBe(CFI);
    await waitFor(() => expect(screen.queryByTestId('reader-back-chip')).not.toBeInTheDocument());

    act(() =>
      engine.emitLocation({
        cfi: CFI,
        href: 'OEBPS/chapter1.xhtml',
        page: 1,
        totalPages: 4,
        chapterIndex: 0,
        totalChapters: 2,
        bookProgress: 12,
        fraction: 0,
      }),
    );
    act(() => engine.emitInternalLink('/OEBPS/chapter1.xhtml'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe('/OEBPS/chapter1.xhtml'));
    expect(screen.queryByTestId('reader-back-chip')).not.toBeInTheDocument();
  });

  it('turns pages from the page edges, swipes, and Space, never over text', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    vi.spyOn(screen.getByTestId('epub-host'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 0, 1000, 800),
    );

    const click = (x: number, overContent = false, hasSelection = false) =>
      act(() => {
        engine.emitGesture({ kind: 'down', x, y: 300, hasSelection });
        engine.emitGesture({ kind: 'click', x, y: 300, overContent, hasSelection });
      });
    click(1050);
    expect(engine.next).toHaveBeenCalledOnce();
    click(150);
    expect(engine.previous).toHaveBeenCalledOnce();
    // Text, a selection, and the middle of the page are the reader's.
    click(1050, true);
    click(1050, false, true);
    click(600);
    expect(engine.next).toHaveBeenCalledOnce();
    expect(engine.previous).toHaveBeenCalledOnce();

    act(() => engine.emitGesture({ kind: 'move', x: 1080, y: 300, overContent: false }));
    expect(engine.cursor).toBe('e-resize');
    act(() => engine.emitGesture({ kind: 'move', x: 1080, y: 300, overContent: true }));
    expect(engine.cursor).toBe('');

    // One swipe turns one page, however many events its momentum sends.
    let used = false;
    act(() => {
      for (let event = 0; event < 8; event += 1) {
        used = engine.emitWheel({ deltaX: 30, deltaY: 2, ctrlKey: false });
      }
    });
    expect(used).toBe(true);
    expect(engine.next).toHaveBeenCalledTimes(2);
    expect(engine.emitWheel({ deltaX: 0, deltaY: 40, ctrlKey: false })).toBe(false);

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    fireEvent.keyDown(window, { key: 'PageUp', code: 'PageUp' });
    expect(engine.next).toHaveBeenCalledTimes(3);
    expect(engine.previous).toHaveBeenCalledTimes(2);

    // Scroll mode scrolls: no edge zones.
    fireEvent.click(screen.getByRole('radio', { name: 'Scroll' }));
    click(1050);
    expect(engine.next).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: 'Next Page' })).not.toBeInTheDocument();
  });

  it('goes by chapter with Option-arrows and to chapter edges with Home and End', async () => {
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
      }),
    );
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(engine.displayed.at(-1)).toBe('OEBPS/chapter2.xhtml');
    fireEvent.keyDown(window, { key: 'End', code: 'End' });
    fireEvent.keyDown(window, { key: 'Home', code: 'Home' });
    await waitFor(() =>
      expect(engine.displayedFractions).toEqual([
        [0, 1],
        [0, 0],
      ]),
    );
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

  it('keeps one mark per CFI when a search match coincides with a user highlight', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    select();
    await act(() => store.getState().excerptSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    await waitFor(() => expect(engine.highlighted.get(annotationId)).toBe(CFI));

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    const searchInput = await screen.findByTestId('search-input');
    fireEvent.change(searchInput, { target: { value: 'quick brown fox' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));

    // The search mark and the user highlight share one CFI: epub.js can hold
    // only one, so the search mark owns it while search is active.
    await waitFor(() => expect(engine.highlighted.get(SEARCH_HIGHLIGHT_ID)).toBe(CFI));
    expect(engine.highlighted.has(annotationId)).toBe(false);
    expect(engine.removed).toContain(CFI);

    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => expect(engine.highlighted.get(annotationId)).toBe(CFI));
    expect(engine.highlighted.has(SEARCH_HIGHLIGHT_ID)).toBe(false);
  });

  it('tints every match in the rendered chapter and marks it on the scrubber', async () => {
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

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    const searchInput = await screen.findByTestId('search-input');
    // "The" opens Chapter One and "the" sits later in the same sentence: two
    // matches on the rendered chapter, one of which is not the active match.
    fireEvent.change(searchInput, { target: { value: 'the' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 2'));

    await waitFor(() => expect(engine.highlighted.get(searchMatchId(1))).toBe(`${CFI}@1`));
    expect(engine.highlightStyles.get(searchMatchId(1))).toBe('highlight');
    expect(screen.getAllByTestId('progress-scrubber-search-mark')).toHaveLength(1);
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
    // Typing leaves the sidebar alone: opening it would resize the page.
    expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
    await waitFor(() => expect(engine.highlighted.get(SEARCH_HIGHLIGHT_ID)).toBe(CFI));

    // Jump to the next match in Chapter Two.
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('2 of 2'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(FAR_CFI));
    await waitFor(() => expect(engine.highlighted.get(SEARCH_HIGHLIGHT_ID)).toBe(FAR_CFI));
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
    // The field's list button lists the results where the reader asks for them.
    fireEvent.click(screen.getByRole('button', { name: 'Show search results' }));
    expect(screen.getByTestId('navigator-sidebar')).toHaveAttribute('data-navigator-tab', 'search');
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
    // The selection popover offers the colors; choosing one highlights at once.
    const popover = await screen.findByTestId('selection-popover');
    expect(popover).toHaveAttribute('data-popover-mode', 'create');
    fireEvent.click(screen.getByRole('button', { name: 'Pink highlight' }));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().cards).toEqual([]);
    expect(engine.noted.size).toBe(0);
    expect(store.getState().nodes).toEqual([]);
    const annotationId = store.getState().annotations[0]?.id as string;
    expect(store.getState().annotations[0]?.color).toBe('#f9a8d4');
    expect(engine.highlighted.get(annotationId)).toBe(CFI);
    await waitFor(() => expect(screen.queryByTestId('selection-popover')).toBeNull());

    // Clicking the mark reopens the popover to restyle it as an underline.
    act(() => engine.emitMarkClick(annotationId, null));
    expect(await screen.findByTestId('selection-popover')).toHaveAttribute(
      'data-popover-mode',
      'edit',
    );
    expect(screen.getByRole('button', { name: 'Pink highlight' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Underline' }));
    await waitFor(() => expect(store.getState().annotations[0]?.style).toBe('underline'));
    await waitFor(() => expect(engine.highlightStyles.get(annotationId)).toBe('underline'));
    // A press in the page puts the popover away.
    act(() => engine.emitPointer(true));
    await waitFor(() => expect(screen.queryByTestId('selection-popover')).toBeNull());
    act(() => engine.emitPointer(false));

    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true, metaKey: true });
    expect(await screen.findByTestId('annotation-item')).toHaveTextContent('quick brown fox');
    // Grouped under the chapter's TOC title.
    expect(screen.getByTestId('annotation-group')).toHaveTextContent('One');

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    const noteInput = screen.getByTestId('annotation-note-input');
    fireEvent.change(noteInput, { target: { value: 'EPUB chapter note' } });
    fireEvent.blur(noteInput);
    await waitFor(() => expect(store.getState().annotations[0]?.note).toBe('EPUB chapter note'));
    // A note repaints the mark with its marker.
    await waitFor(() => expect(engine.noted.has(annotationId)).toBe(true));
    // The row names the chapter, never its file.
    expect(screen.getByTestId('annotation-location')).toHaveTextContent('One');
    expect(screen.getByTestId('annotation-item')).not.toHaveTextContent('chapter1.xhtml');

    fireEvent.click(screen.getByTestId('annotation-jump-button'));
    await waitFor(() => expect(engine.displayed.at(-1)).toBe(CFI));

    fireEvent.click(screen.getByTestId('annotation-delete-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));
    expect(engine.removed).toContain(CFI);

    fireEvent.click(await screen.findByTestId('undo-delete-annotation-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.note).toBe('EPUB chapter note');
  });

  it('lists highlights in one chapter by CFI, not by when they were made', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();

    const LATER_CFI = 'epubcfi(/6/2!/4/8,/1:0,/1:5)';
    select(LATER_CFI, 'lazy dog');
    fireEvent.click(await screen.findByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    select(CFI, 'quick brown fox');
    fireEvent.click(await screen.findByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(2));

    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true, metaKey: true });
    await screen.findAllByTestId('annotation-item');
    expect(screen.getAllByTestId('annotation-excerpt').map((e) => e.textContent)).toEqual([
      'quick brown fox',
      'lazy dog',
    ]);
    expect(screen.getAllByTestId('annotation-group')).toHaveLength(1);
  });

  it('takes Esc from inside a chapter: note, then popover, then Find (#45)', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    const frameEscape = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      act(() => engine.emitKeyDown(event));
      return event;
    };

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'fox' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 2'));
    select();
    fireEvent.click(await screen.findByTestId('popover-note'));
    expect(screen.getByTestId('popover-note')).toHaveAttribute('aria-pressed', 'true');
    // A click back into the chapter moves focus into its frame, out of this document.
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    expect(frameEscape().defaultPrevented).toBe(true);
    expect(screen.getByTestId('popover-note')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('selection-popover')).toBeInTheDocument();

    frameEscape();
    expect(screen.queryByTestId('selection-popover')).toBeNull();
    expect(screen.getByTestId('search-input')).toHaveValue('fox');

    frameEscape();
    expect(screen.getByTestId('search-input')).toHaveValue('');
    // Nothing left to close here: the key goes on to the app (focus mode, if on).
    expect(frameEscape().defaultPrevented).toBe(false);
  });

  it('keeps the toolbar band as the top margin of a paged book in focus mode (#45)', async () => {
    const { store, documentId } = await setup();
    const { rerender } = render(<Harness store={store} documentId={documentId} />);
    await opened();
    const pageArea = () => screen.getByTestId('epub-page-area');
    expect(pageArea().style.paddingTop).toBe('');

    rerender(<Harness store={store} documentId={documentId} chromeHidden />);
    expect(pageArea().style.paddingTop).toBe('48px');
    expect(pageArea()).toHaveAttribute('data-toolbar-margin', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    await waitFor(() =>
      expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-mode', 'paged'),
    );
    expect(pageArea().style.paddingTop).toBe('48px');

    // Scrolled text moves out from under the toolbar by itself.
    fireEvent.click(screen.getByRole('radio', { name: 'Scroll' }));
    await waitFor(() =>
      expect(screen.getByTestId('epub-viewer')).toHaveAttribute('data-reading-mode', 'scroll'),
    );
    expect(pageArea().style.paddingTop).toBe('');
  });

  it('lets a missed-jump notice be closed, and keeps it off the page in focus mode', async () => {
    const { store, documentId } = await setup();
    const { rerender } = render(<Harness store={store} documentId={documentId} />);
    await opened();
    engine.failCfi = FAR_CFI;
    act(() =>
      store.setState({
        jumpRequest: {
          nonce: 6,
          documentId,
          annotationId: 'gone',
          anchor: { format: 'epub', cfiRange: FAR_CFI, chapterHref: 'gone.xhtml' },
        },
      }),
    );
    expect(await screen.findByText(/could not be found/)).toBeInTheDocument();

    rerender(<Harness store={store} documentId={documentId} chromeHidden />);
    expect(screen.queryByText(/could not be found/)).toBeNull();
    rerender(<Harness store={store} documentId={documentId} />);
    expect(screen.getByText(/could not be found/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByText(/could not be found/)).toBeNull();
  });

  describe('with chapters of uneven length (#52)', () => {
    const twoChapters = engine.chapters;
    /** Two short front-matter files, then chapters of 7,800 and 4,940 characters. */
    const COUNTS = [130, 130, 7800, 4940].map((characters) => ({ characters, cjk: 0 }));
    const ONE_CFI = 'epubcfi(/6/6!/4/2,/1:0,/1:5)';

    beforeEach(() => {
      engine.chapters = [
        { href: 'OEBPS/title.xhtml', label: 'Title', text: 'Uneven', cfi: 'epubcfi(/6/2!/4/2)' },
        { href: 'OEBPS/copyright.xhtml', label: 'Copyright', text: 'C', cfi: 'epubcfi(/6/4!/4/2)' },
        { href: 'OEBPS/one.xhtml', label: 'One', text: 'One', cfi: ONE_CFI },
        { href: 'OEBPS/two.xhtml', label: 'Two', text: 'Two', cfi: 'epubcfi(/6/8!/4/2)' },
      ];
      engine.toc = engine.chapters.map((chapter, index) => ({
        id: `toc-${index}`,
        label: chapter.label,
        href: chapter.href,
        children: [],
      }));
    });

    afterEach(() => {
      engine.chapters = twoChapters;
      engine.isFixedLayout = false;
    });

    /** The first page of three in chapter One, by spine file 58% of the way in. */
    const onFirstPageOfOne = () =>
      act(() =>
        engine.emitLocation({
          cfi: ONE_CFI,
          href: 'OEBPS/one.xhtml',
          page: 1,
          totalPages: 3,
          chapterIndex: 2,
          totalChapters: 4,
          bookProgress: 58,
          fraction: 0.5,
          chapterStart: 0,
          chapterEnd: 1 / 3,
        }),
      );

    const tickPositions = () =>
      screen.getAllByTestId('progress-scrubber-tick').map((tick) => parseFloat(tick.style.left));

    it('weighs the percentage, scrubber, and ticks by text once the book is measured', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const displayedWhenMeasuring: number[] = [];
      engine.measure = vi.fn(async (index: number) => {
        displayedWhenMeasuring.push(engine.displayed.length);
        if (index === 3) await gate;
        return COUNTS[index] ?? null;
      });
      const { backend, store, documentId } = await setup();
      const update = vi.spyOn(backend, 'updateDocumentCursor');
      render(<Harness store={store} documentId={documentId} />);
      await opened();
      onFirstPageOfOne();

      // Until the pass finishes, every file is an equal share, as before.
      const slider = screen.getByRole('slider', { name: 'Reading position' });
      expect(slider).toHaveAttribute('aria-valuetext', 'Chapter 3 of 4, 58%');
      expect(tickPositions()).toEqual([25, 50, 75]);
      await waitFor(() => expect(engine.measure).toHaveBeenCalledTimes(4));
      // Measuring starts behind the first page, never before it.
      expect(Math.min(...displayedWhenMeasuring)).toBeGreaterThan(0);

      release();
      // (260 + 7,800 / 3) of 13,000 characters lie behind the end of this page.
      await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Chapter 3 of 4, 22%'));
      expect(slider).toHaveAttribute('aria-valuenow', '2');
      const ticks = tickPositions();
      expect(ticks).toHaveLength(3);
      expect(ticks[0]).toBeCloseTo(1);
      expect(ticks[1]).toBeCloseTo(2);
      expect(ticks[2]).toBeCloseTo(62);

      // Halfway along the scrubber is 6,500 characters in: most of the way through One.
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 20));
      fireEvent.pointerMove(slider, { clientX: 100 });
      expect(screen.getByTestId('progress-scrubber-tooltip')).toHaveTextContent('One · 50%');
      fireEvent.pointerDown(slider, { clientX: 100, button: 0, pointerId: 1 });
      fireEvent.pointerUp(slider, { clientX: 100, button: 0, pointerId: 1 });
      await waitFor(() => expect(engine.displayedFractions).toHaveLength(1));
      const [index, within] = engine.displayedFractions[0] ?? [];
      expect(index).toBe(2);
      expect(within).toBeCloseTo(6240 / 7800);

      // The saved position gains the measured percentage, for the Recent list.
      await waitFor(() =>
        expect(update).toHaveBeenLastCalledWith(
          documentId,
          { format: 'epub', cfiRange: ONE_CFI, chapterHref: 'OEBPS/one.xhtml' },
          0.22,
        ),
      );
      expect(store.getState().documents.find((doc) => doc.id === documentId)?.lastProgress).toBe(
        0.22,
      );
    });

    it('offers the minutes left in the chapter once the chapter is measured', async () => {
      engine.measure = vi.fn(async (index: number) => COUNTS[index] ?? null);
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await opened();
      onFirstPageOfOne();

      const readout = screen.getByTestId('reader-footer-readout');
      expect(readout).toHaveTextContent('2 pages left in chapter');
      // Not offered before the text is measured: pages left goes straight to the page number.
      fireEvent.click(readout);
      expect(readout).toHaveAttribute('data-readout', 'position');
      fireEvent.click(readout);
      fireEvent.click(readout);
      expect(readout).toHaveAttribute('data-readout', 'remaining');

      await waitFor(() => expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '2'));
      fireEvent.click(readout);
      // Two thirds of 7,800 characters at 1,300 a minute.
      expect(readout).toHaveAttribute('data-readout', 'minutes');
      expect(readout).toHaveTextContent('About 4 minutes left in chapter');
    });

    it('stops measuring when the book closes', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      engine.measure = vi.fn(async (index: number) => {
        await gate;
        return COUNTS[index] ?? null;
      });
      const { store, documentId } = await setup();
      const view = render(<Harness store={store} documentId={documentId} />);
      await opened();
      await waitFor(() => expect(engine.measure).toHaveBeenCalledOnce());
      view.unmount();
      release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(engine.measure).toHaveBeenCalledOnce();
    });

    it('leaves a fixed-layout book in equal shares: a page per file', async () => {
      engine.isFixedLayout = true;
      engine.measure = vi.fn(async (index: number) => COUNTS[index] ?? null);
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await opened();
      onFirstPageOfOne();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(engine.measure).not.toHaveBeenCalled();
      expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Chapter 3 of 4, 58%');
    });

    it('reopens a measured book by text at once, without measuring it again', async () => {
      engine.measure = vi.fn(async (index: number) => COUNTS[index] ?? null);
      const { store, documentId } = await setup();
      const first = render(<Harness store={store} documentId={documentId} />);
      await opened();
      onFirstPageOfOne();
      const slider = () => screen.getByRole('slider', { name: 'Reading position' });
      await waitFor(() =>
        expect(slider()).toHaveAttribute('aria-valuetext', 'Chapter 3 of 4, 22%'),
      );
      expect(engine.measure).toHaveBeenCalledTimes(4);
      first.unmount();

      render(<Harness store={store} documentId={documentId} />);
      await opened();
      onFirstPageOfOne();
      // No by-file 58% first: the weights come from the last open.
      expect(slider()).toHaveAttribute('aria-valuetext', 'Chapter 3 of 4, 22%');
      expect(engine.measure).toHaveBeenCalledTimes(4);
    });

    it('measures again when the cached weights do not fit the book', async () => {
      engine.measure = vi.fn(async (index: number) => COUNTS[index] ?? null);
      const { store, documentId } = await setup();
      const fileHash = store.getState().documents.find((doc) => doc.id === documentId)?.fileHash;
      window.localStorage.setItem(
        'synapseread.epubTextWeights.v1',
        JSON.stringify({ [fileHash ?? '']: { at: 1, sections: [[5, 0]] } }),
      );
      render(<Harness store={store} documentId={documentId} />);
      await opened();
      await waitFor(() => expect(engine.measure).toHaveBeenCalledTimes(4));
    });

    it('keeps the saved percentage when the reader moves before measuring finishes', async () => {
      engine.measure = vi.fn(() => new Promise<null>(() => undefined));
      const { backend, store, documentId } = await setup();
      store
        .getState()
        .reportCursor(
          documentId,
          { format: 'epub', cfiRange: ONE_CFI, chapterHref: 'OEBPS/one.xhtml' },
          0.37,
        );
      const update = vi.spyOn(backend, 'updateDocumentCursor');
      const view = render(<Harness store={store} documentId={documentId} />);
      await opened();
      act(() =>
        engine.emitLocation({
          cfi: 'epubcfi(/6/8!/4/2)',
          href: 'OEBPS/two.xhtml',
          chapterIndex: 3,
          totalChapters: 4,
        }),
      );
      view.unmount();

      expect(update).toHaveBeenLastCalledWith(
        documentId,
        expect.objectContaining({ cfiRange: 'epubcfi(/6/8!/4/2)' }),
        0.37,
      );
      expect(store.getState().documents.find((doc) => doc.id === documentId)?.lastProgress).toBe(
        0.37,
      );
    });
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
