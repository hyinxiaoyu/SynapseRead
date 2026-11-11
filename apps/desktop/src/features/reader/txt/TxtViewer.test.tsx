import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_HIGHLIGHT_ID } from '@/features/reader/DocumentSearch';
import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend, type MemoryFile } from '@/lib/backend/memoryBackend';
import {
  createStudySyncStore,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
} from '@/stores/useStudySyncStore';
import { documentFixture } from '@/test/fixtures';
import type { TxtAnchor } from '@/types/domain';

import { ROW_ESTIMATE_PX, TxtViewer } from './TxtViewer';

// Matching the estimate keeps offsets exact for rows that have not been measured.
const ROW_PX = ROW_ESTIMATE_PX;
const VIEWPORT_PX = 400;

type Store = ReturnType<typeof createStudySyncStore>;

/** Wires a viewer to a real store and memory backend, as `ReaderPane` does. */
function Harness({
  store,
  documentId,
  chromeHidden = false,
}: {
  store: Store;
  documentId: string;
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
  if (document?.format !== 'txt') throw new Error('expected a txt document');
  return (
    <TxtViewer
      document={{ ...document, format: 'txt' }}
      isActive
      chromeHidden={chromeHidden}
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
      onExcerptSelection={() => void state.excerptSelection()}
      canExcerpt={!state.isExcerpting}
    />
  );
}

const setup = async (file: MemoryFile, chunkBytes?: number) => {
  const backend = createMemoryBackend({
    library: { '/books/book.txt': file },
    ...(chunkBytes === undefined ? {} : { chunkBytes }),
  });
  const store = createStudySyncStore(backend);
  await store.getState().initialize();
  await store.getState().openDocument();
  const documentId = store.getState().activeDocumentId as string;
  return { backend, store, documentId };
};

const scroller = () => screen.getByTestId('txt-scroll');

/** A rendered text segment containing `text`. */
const segmentWith = async (text: string) =>
  waitFor(() => {
    const match = [...scroller().querySelectorAll('[data-unit]')].find((element) =>
      element.textContent?.includes(text),
    );
    if (!match) throw new Error(`no rendered segment contains: ${text}`);
    return match as HTMLElement;
  });

/** Makes a real DOM selection over `text`, then tells the viewer, as a browser would. */
const selectText = async (text: string) => {
  const segment = await segmentWith(text);
  const node = segment.firstChild as Text;
  const start = (node.textContent as string).indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => void document.dispatchEvent(new Event('selectionchange')));
};

const clearSelection = () => {
  window.getSelection()?.removeAllRanges();
  act(() => void document.dispatchEvent(new Event('selectionchange')));
};

const scrollTo = (top: number) => {
  const element = scroller();
  element.scrollTop = top;
  act(() => void element.dispatchEvent(new Event('scroll')));
};

const sourceSlice = (bytes: Uint8Array, anchor: TxtAnchor) =>
  bytes.slice(anchor.startByteOffset, anchor.endByteOffset);

describe('TxtViewer', () => {
  beforeEach(() => {
    // jsdom has no layout, so give the virtualizer a viewport and row heights.
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT_PX);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(ROW_PX * 10_000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW_PX);
    Element.prototype.scrollTo = function (this: Element, options) {
      this.scrollTop = (options as ScrollToOptions).top ?? 0;
      this.dispatchEvent(new Event('scroll'));
    };
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  describe('with the plain fixture', () => {
    const bytes = documentFixture('sample.txt');
    const decoded = new TextDecoder().decode(bytes);

    it('shows line and byte progress in the footer, and scrubs with a Back chip', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');

      const readout = await screen.findByTestId('reader-footer-readout');
      await waitFor(() => expect(readout).toHaveTextContent(/^Line 1 of \d+$/));
      fireEvent.click(readout);
      expect(readout).toHaveTextContent('0%');

      const slider = screen.getByRole('slider', { name: 'Reading position' });
      expect(slider).toHaveAttribute(
        'aria-valuetext',
        expect.stringMatching(/^Line 1 of \d+, 0%$/),
      );
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
      fireEvent.pointerDown(slider, { clientX: 99, button: 0, pointerId: 1 });
      fireEvent.pointerUp(slider, { clientX: 99, button: 0, pointerId: 1 });
      await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
      const chip = await screen.findByTestId('reader-back-chip');
      expect(chip).toHaveTextContent('Back to line 1');
      fireEvent.click(chip);
      expect(scroller().scrollTop).toBe(0);
      expect(screen.queryByTestId('reader-back-chip')).not.toBeInTheDocument();
    });

    it('pages with edge clicks, Space, and Page Down, and goes to the ends with Home and End', async () => {
      const scrollBy = vi.fn();
      Element.prototype.scrollBy = scrollBy as unknown as Element['scrollBy'];
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');
      vi.spyOn(screen.getByRole('document'), 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 800, VIEWPORT_PX),
      );

      fireEvent.click(scroller(), { clientX: 790, clientY: 100, button: 0, detail: 1 });
      expect(scrollBy).toHaveBeenLastCalledWith({ top: VIEWPORT_PX * 0.9 });
      fireEvent.click(scroller(), { clientX: 10, clientY: 100, button: 0, detail: 1 });
      expect(scrollBy).toHaveBeenLastCalledWith({ top: -VIEWPORT_PX * 0.9 });
      // The middle of the page never turns it.
      fireEvent.click(scroller(), { clientX: 400, clientY: 100, button: 0, detail: 1 });
      expect(scrollBy).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(scroller(), { key: ' ', code: 'Space' });
      fireEvent.keyDown(scroller(), { key: 'PageDown', code: 'PageDown' });
      fireEvent.keyDown(scroller(), { key: ' ', code: 'Space', shiftKey: true });
      expect(scrollBy.mock.calls.map(([options]) => (options as ScrollToOptions).top)).toEqual([
        VIEWPORT_PX * 0.9,
        -VIEWPORT_PX * 0.9,
        VIEWPORT_PX * 0.9,
        VIEWPORT_PX * 0.9,
        -VIEWPORT_PX * 0.9,
      ]);
      // Space on a focused button presses the button instead.
      fireEvent.keyDown(screen.getByRole('button', { name: 'Next Page' }), {
        key: ' ',
        code: 'Space',
      });
      expect(scrollBy).toHaveBeenCalledTimes(5);

      fireEvent.keyDown(scroller(), { key: 'End', code: 'End' });
      expect(scroller().scrollTop).toBe(ROW_PX * 10_000);
      fireEvent.keyDown(scroller(), { key: 'Home', code: 'Home' });
      expect(scroller().scrollTop).toBe(0);
    });

    it('virtualizes: renders only rows near the viewport', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');
      const rendered = scroller().querySelectorAll('[data-index]').length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(decoded.split('\n').length / 2);
      expect(screen.queryByText(/final target sentence/)).not.toBeInTheDocument();
    });

    it('turns a DOM selection into an anchor on the source bytes', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await selectText('café and € and 😀');

      const selection = store.getState().selection;
      expect(selection?.text).toBe('café and € and 😀');
      const anchor = selection?.anchor as TxtAnchor;
      expect(new TextDecoder().decode(sourceSlice(bytes, anchor))).toBe('café and € and 😀');
      expect(anchor.lineIndex).toBe(3);

      clearSelection();
      expect(store.getState().selection).toBeNull();
    });

    it('runs selection -> anchor -> persist -> reopen', async () => {
      const { backend, store, documentId } = await setup(bytes);
      const first = render(<Harness store={store} documentId={documentId} />);
      await selectText('quick brown fox');
      await act(() => store.getState().excerptSelection());

      const painted = await segmentWith('quick brown fox');
      const annotation = store.getState().annotations[0];
      expect(painted).toHaveAttribute('data-annotation-id', annotation?.id);
      expect(painted.textContent).toBe('quick brown fox');
      expect(store.getState().cards[0]?.title).toBe('quick brown fox');
      first.unmount();

      // A new session over the same backend: everything comes back from storage.
      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      await reopened.getState().openDocument();
      render(<Harness store={reopened} documentId={documentId} />);

      const repainted = await segmentWith('quick brown fox');
      expect(repainted).toHaveAttribute('data-annotation-id', annotation?.id);
      expect(repainted.textContent).toBe('quick brown fox');
    });

    it('reopens at the last reading position, without overwriting it first', async () => {
      const { backend, store, documentId } = await setup(bytes);
      const first = render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');

      scrollTo(60 * ROW_PX);
      await waitFor(
        () =>
          expect(store.getState().documents[0]?.lastCursorAnchor).toMatchObject({ lineIndex: 60 }),
        { timeout: 2000 },
      );
      first.unmount();

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      await reopened.getState().openDocument();
      const update = vi.spyOn(backend, 'updateDocumentCursor');
      render(<Harness store={reopened} documentId={documentId} />);

      await waitFor(() => expect(scroller().scrollTop).toBe(60 * ROW_PX));
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      // The scroll from restoring is not news: storage must still say line 60.
      expect(update).not.toHaveBeenCalled();
      expect(reopened.getState().documents[0]?.lastCursorAnchor).toMatchObject({ lineIndex: 60 });
    });

    it('flushes a debounced position when the tab closes', async () => {
      const { backend, store, documentId } = await setup(bytes);
      const view = render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');
      const update = vi.spyOn(backend, 'updateDocumentCursor');

      scrollTo(30 * ROW_PX);
      view.unmount();

      expect(update).toHaveBeenCalledWith(
        documentId,
        expect.objectContaining({ format: 'txt', lineIndex: 30 }),
      );
    });

    it('runs a jump round trip: scroll, pulse, complete', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);

      // Make an excerpt near the end of the document.
      const start = decoded.indexOf('final target sentence');
      await act(async () => {
        store.getState().setSelection({
          documentId,
          anchor: {
            format: 'txt',
            startByteOffset: new TextEncoder().encode(decoded.slice(0, start)).length,
            endByteOffset: bytes.length - 1,
            lineIndex: decoded.slice(0, start).split('\n').length - 1,
          },
          text: 'final target sentence',
          imagePng: null,
        });
        await store.getState().excerptSelection();
      });
      expect(screen.queryByText(/final target sentence/)).not.toBeInTheDocument();
      const nodeId = store.getState().nodes[0]?.id as string;

      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => store.getState().jumpToNode(nodeId));
        const target = await segmentWith('final target sentence');
        expect(target).toHaveClass('anchor-pulse');
        expect(store.getState().jumpRequest).not.toBeNull();

        await act(async () => void vi.advanceTimersByTime(PULSE_MS + 10));
        expect(store.getState().jumpRequest).toBeNull();
        expect(await segmentWith('final target sentence')).not.toHaveClass('anchor-pulse');

        // Return to the previous location before the jump.
        const backButton = screen.getByRole('button', { name: 'Return to previous location' });
        act(() => backButton.click());
        expect(scroller().scrollTop).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('completes a jump whose bytes no longer exist, and says so', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');

      act(() =>
        store.setState({
          jumpRequest: {
            nonce: 77,
            documentId,
            annotationId: 'gone',
            anchor: {
              format: 'txt',
              startByteOffset: bytes.length + 10,
              endByteOffset: bytes.length + 20,
              lineIndex: 0,
            },
          },
        }),
      );
      await waitFor(() => expect(store.getState().jumpRequest).toBeNull());
      expect(await screen.findByText(/past the end/)).toHaveAttribute('role', 'status');
    });

    it('keeps the selected rows rendered while scrolled away', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      await selectText('SynapseRead sample');
      const selected = await segmentWith('SynapseRead sample');

      scrollTo(100 * ROW_PX);
      await waitFor(() => expect(scroller().querySelector('[data-index="100"]')).not.toBeNull());
      expect(selected).toBeInTheDocument();
      expect(store.getState().selection?.text).toBe('SynapseRead sample');
    });

    it('applies appearance preferences, preserves reading location, and persists across reopen', async () => {
      const { backend, store, documentId } = await setup(bytes);
      const first = render(<Harness store={store} documentId={documentId} />);
      await segmentWith('SynapseRead sample text');

      scrollTo(40 * ROW_PX);
      await act(async () => {
        screen.getByRole('button', { name: 'Reading appearance' }).click();
      });
      // TXT has no publisher fonts, so Original reads as the default face.
      expect(screen.getByRole('radio', { name: 'Default' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      for (const [role, name] of [
        ['radio', 'Dark'],
        ['radio', 'Monospace'],
        ['button', 'Increase font size'],
        ['button', 'Customize'],
        ['radio', 'Relaxed'],
        ['radio', 'Narrow'],
        ['switch', 'Justify'],
      ] as const) {
        await act(async () => {
          screen.getByRole(role, { name }).click();
        });
      }
      // Image dimming only applies to formats with images.
      expect(screen.queryByRole('switch', { name: /Dim images/ })).not.toBeInTheDocument();

      const viewer = screen.getByTestId('txt-viewer');
      expect(viewer).toHaveAttribute('data-reading-theme', 'dark');
      expect(viewer).toHaveAttribute('data-reading-margins', 'narrow');
      expect(scroller().scrollTop).toBe(40 * ROW_PX);
      expect(scroller().style.backgroundColor).toBe('rgb(24, 24, 27)');
      const docEl = screen.getByRole('document');
      expect(docEl.style.fontSize).toBe('1.1rem');
      expect(docEl.style.lineHeight).toBe('2.1');
      // Capped at 75ch (fallback 0.5em of 17.6 px) plus 32 px a side at narrow margins.
      expect(docEl.style.maxWidth).toBe(`${75 * 8.8 + 64}px`);
      await act(async () => {
        screen.getByRole('radio', { name: 'Full width' }).click();
      });
      expect(docEl.style.maxWidth).toBe('100%');
      expect(scroller().scrollTop).toBe(40 * ROW_PX);
      const row = docEl.querySelector<HTMLElement>('[data-index]');
      expect(row?.style.textAlign).toBe('start');
      first.unmount();

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      await reopened.getState().openDocument();
      render(<Harness store={reopened} documentId={documentId} />);
      await waitFor(() => expect(scroller().scrollTop).toBe(40 * ROW_PX));
      expect(screen.getByRole('document').style.maxWidth).toBe('100%');
      expect(reopened.getState().readingPreferences.pageWidth).toBe('full');
      expect(screen.getByTestId('txt-viewer')).toHaveAttribute('data-reading-theme', 'dark');
      expect(screen.getByTestId('txt-viewer')).toHaveAttribute('data-reading-margins', 'narrow');
    });
  });

  describe('with BOM, CRLF, and malformed bytes', () => {
    const bytes = documentFixture('sample-lossy.txt');

    /** The source bytes for a passage, found by searching the raw file. */
    const sourceRange = (text: string, fromIndex = 0) => {
      const needle = new TextEncoder().encode(text);
      for (let index = fromIndex; index <= bytes.length - needle.length; index += 1) {
        if (needle.every((byte, offset) => bytes[index + offset] === byte)) {
          return { start: index, end: index + needle.length };
        }
      }
      throw new Error(`not in source: ${text}`);
    };

    it.each([4, 7, 16, 64 * 1024])(
      'anchors exactly, at chunk size %i, where decoded length would drift',
      async (chunkBytes) => {
        const { store, documentId } = await setup(bytes, chunkBytes);
        render(<Harness store={store} documentId={documentId} />);

        await selectText('middle target');
        const expected = sourceRange('middle target');
        expect(store.getState().selection?.anchor).toMatchObject({
          startByteOffset: expected.start,
          endByteOffset: expected.end,
          lineIndex: 1,
        });

        await selectText('汉字 target two');
        const second = sourceRange('汉字 target two');
        expect(store.getState().selection?.anchor).toMatchObject({
          startByteOffset: second.start,
          endByteOffset: second.end,
          lineIndex: 2,
        });
      },
    );

    it('persists across a reopen at a different chunk size', async () => {
      const backend = createMemoryBackend({
        library: { '/books/book.txt': bytes },
        chunkBytes: 7,
      });
      const store = createStudySyncStore(backend);
      await store.getState().initialize();
      await store.getState().openDocument();
      const documentId = store.getState().activeDocumentId as string;
      const first = render(<Harness store={store} documentId={documentId} />);
      await selectText('middle target');
      const text = store.getState().selection?.text;
      await act(() => store.getState().excerptSelection());
      first.unmount();

      const rechunked = createMemoryBackend({
        library: { '/books/book.txt': bytes },
        chunkBytes: 4096,
      });
      const anchors = await backend.loadNotebookGraph(store.getState().notebook?.id as string);
      const second = createStudySyncStore(rechunked);
      await second.getState().initialize();
      await second.getState().openDocument();
      act(() =>
        second.setState({
          annotations: anchors.annotations.map((annotation) => ({
            ...annotation,
            documentId: second.getState().activeDocumentId as string,
          })),
        }),
      );
      render(<Harness store={second} documentId={second.getState().activeDocumentId as string} />);

      const painted = await segmentWith('middle target');
      expect(painted.textContent).toBe(text);
    });

    it('tells the reader the file has malformed bytes', async () => {
      const { store, documentId } = await setup(bytes);
      render(<Harness store={store} documentId={documentId} />);
      expect(await screen.findByText(/not valid UTF-8/)).toHaveAttribute('role', 'status');
    });

    it('keeps the malformed-bytes notice off the page in focus mode, and lets it be closed', async () => {
      const { store, documentId } = await setup(bytes);
      const view = render(<Harness store={store} documentId={documentId} />);
      expect(await screen.findByText(/not valid UTF-8/)).toBeInTheDocument();
      expect(screen.getByTestId('txt-replacements-notice')).toHaveAttribute('data-tone', 'warning');

      view.rerender(<Harness store={store} documentId={documentId} chromeHidden />);
      expect(screen.queryByText(/not valid UTF-8/)).toBeNull();
      view.rerender(<Harness store={store} documentId={documentId} />);
      fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
      expect(screen.queryByText(/not valid UTF-8/)).toBeNull();
    });

    it('warns again about malformed bytes after the file is reopened with another encoding', async () => {
      const { store, documentId, backend } = await setup(bytes);
      // The memory backend decodes only UTF-8; the point is the reload, not the decoder.
      const originalRead = backend.readTextStream.bind(backend);
      backend.readTextStream = vi.fn((docId, _encoding, onChunk, signal) =>
        originalRead(docId, 'utf-8', onChunk, signal),
      );
      render(<Harness store={store} documentId={documentId} />);
      expect(await screen.findByText(/not valid UTF-8/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
      expect(screen.queryByText(/not valid UTF-8/)).toBeNull();

      act(() =>
        store.setState((state) => ({
          documents: state.documents.map((document) =>
            document.id === documentId ? { ...document, encoding: 'windows-1252' } : document,
          ),
        })),
      );
      expect(await screen.findByText(/not valid UTF-8/)).toBeInTheDocument();
    });

    it('searches lossy TXT files while retaining source-byte highlight mapping', async () => {
      const { store, documentId } = await setup(bytes, 7);
      render(<Harness store={store} documentId={documentId} />);
      await segmentWith('middle target');

      fireEvent.keyDown(window, { key: 'f', metaKey: true });
      const searchInput = await screen.findByTestId('search-input');
      fireEvent.change(searchInput, { target: { value: '汉字 target two' } });

      await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
      const highlighted = await segmentWith('汉字 target two');
      expect(highlighted).toHaveAttribute('data-annotation-id', SEARCH_HIGHLIGHT_ID);
    });
  });

  it('opens search with Cmd/Ctrl+F, searches unrendered rows, highlights matches, and supports return', async () => {
    const bytes = documentFixture('sample.txt');
    const { store, documentId } = await setup(bytes);
    render(<Harness store={store} documentId={documentId} />);
    await segmentWith('SynapseRead sample text');
    expect(screen.queryByText(/final target sentence/)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const searchInput = await screen.findByTestId('search-input');
    expect(searchInput).toHaveFocus();
    expect(searchInput).toHaveAttribute('role', 'searchbox');
    expect(searchInput).toHaveAttribute('placeholder', 'Search');
    expect(screen.getByTestId('search-status').textContent).toBe('');
    expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();

    // Search for a phrase that exists both near the top and in an unrendered row at the end.
    fireEvent.change(searchInput, { target: { value: 'final target sentence' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
    // Typing does not open the sidebar: that would resize the page under the reader.
    expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
    // The field's list button lists the results where the reader asks for them.
    fireEvent.click(screen.getByRole('button', { name: 'Show search results' }));
    expect(screen.getByTestId('navigator-sidebar')).toHaveAttribute('data-navigator-tab', 'search');
    expect(screen.getByTestId('search-result-location')).toHaveTextContent(/Line \d+/);
    expect(screen.getByTestId('search-result-snippet')).toHaveTextContent('final target sentence');

    // The virtualizer scrolled to the unrendered row and painted the search highlight.
    const highlighted = await segmentWith('final target sentence');
    expect(highlighted).toHaveAttribute('data-annotation-id', SEARCH_HIGHLIGHT_ID);
    expect(highlighted).toHaveClass('anchor-pulse');
    expect(scroller().scrollTop).toBeGreaterThan(0);

    // Return to previous location restores the top scroll position.
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(scroller().scrollTop).toBe(0);

    // Case sensitivity and no-match behavior.
    fireEvent.change(searchInput, { target: { value: 'QUICK BROWN FOX' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Match case/ }));
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('No matches'),
    );

    // Empty query resets search state, and the sidebar the reader opened stays as it is.
    fireEvent.change(searchInput, { target: { value: '   ' } });
    expect(screen.getByTestId('search-status').textContent).toBe('');
    expect(screen.getByTestId('navigator-sidebar')).toHaveAttribute('data-navigator-tab', 'notes');

    // Esc clears the query and gives focus back to the text.
    fireEvent.change(searchInput, { target: { value: 'quick' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of'));
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(searchInput).toHaveValue('');
    expect(scroller()).toHaveFocus();
  });

  it('finds a phrase across a line break and tints every match on the rendered rows', async () => {
    const bytes = documentFixture('sample.txt');
    const { store, documentId } = await setup(bytes);
    render(<Harness store={store} documentId={documentId} />);
    await segmentWith('SynapseRead sample text');

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    const searchInput = await screen.findByTestId('search-input');

    // The fixture has "lazy dog." on one line and "Pack my box" on the next.
    fireEvent.change(searchInput, { target: { value: 'dog. Pack' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));

    fireEvent.change(searchInput, { target: { value: 'quick' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 2'));
    // "quick" sits on two rendered lines: the inactive one is tinted, and the
    // active one keeps its orange highlight; both tick the scrubber.
    expect(document.querySelectorAll('[data-annotation-id^="__search_match_"]')).toHaveLength(1);
    const activeMark = document.querySelector('[data-annotation-id="__search_active__"]');
    expect(activeMark).not.toBeNull();
    // The active match keeps its own orange layer; no inactive tint is stacked on it.
    expect(
      activeMark?.closest('[data-index]')?.querySelector('[data-annotation-id^="__search_match_"]'),
    ).toBeNull();
    expect(screen.queryAllByTestId('progress-scrubber-search-mark')).toHaveLength(2);
  });

  it('uses the selection for Find with Cmd/Ctrl+E', async () => {
    const bytes = documentFixture('sample.txt');
    const { store, documentId } = await setup(bytes);
    render(<Harness store={store} documentId={documentId} />);
    await selectText('quick brown fox');
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE', ctrlKey: true });
    const searchInput = await screen.findByTestId('search-input');
    expect(searchInput).toHaveValue('quick brown fox');
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of'));
  });

  it('adds, lists, jumps to, persists, removes, and handles stale bookmarks without creating cards or annotations', async () => {
    const bytes = documentFixture('sample.txt');
    const { backend, store, documentId } = await setup(bytes);
    const first = render(<Harness store={store} documentId={documentId} />);
    await segmentWith('SynapseRead sample text');

    // Scroll to row 20 and add a bookmark with Cmd/Ctrl+D.
    scrollTo(20 * ROW_PX);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    await waitFor(() => expect(store.getState().bookmarks).toHaveLength(1));
    expect(store.getState().annotations).toEqual([]);
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'true');

    // Cmd/Ctrl+D inside an editable input is ignored.
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const searchInput = await screen.findByTestId('search-input');
    fireEvent.keyDown(searchInput, { key: 'd', ctrlKey: true });
    expect(store.getState().bookmarks).toHaveLength(1);
    fireEvent.keyDown(searchInput, { key: 'Escape' });

    // Scroll back to top, show Bookmarks in the sidebar (⌥⌘5), and jump to the saved bookmark.
    scrollTo(0);
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: '5', code: 'Digit5', altKey: true, ctrlKey: true });
    expect(screen.getByTestId('navigator-tab-bookmarks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByTestId('bookmark-item');
    expect(screen.getByTestId('bookmark-label')).toHaveTextContent(/Line 21/);
    const jumpButton = screen.getByTestId('bookmark-jump-button');
    fireEvent.click(jumpButton);
    expect(scroller().scrollTop).toBe(20 * ROW_PX);
    expect(jumpButton).toHaveAttribute('aria-current', 'location');

    // Return to previous location restores the top scroll position.
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(scroller().scrollTop).toBe(0);

    // Add a stale bookmark past the end of the file and verify stale status handling.
    await act(() =>
      store.getState().addBookmark(
        documentId,
        {
          format: 'txt',
          startByteOffset: bytes.byteLength + 500,
          endByteOffset: bytes.byteLength + 520,
          lineIndex: 999,
        },
        'Stale line',
      ),
    );
    expect(await screen.findByTestId('bookmark-stale')).toHaveTextContent('Stale');
    const jumpButtons = screen.getAllByTestId('bookmark-jump-button');
    fireEvent.click(jumpButtons[1] as HTMLElement);
    expect(await screen.findByText(/past the end of this file/)).toHaveAttribute('role', 'status');

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = createStudySyncStore(backend);
    await reopened.getState().initialize();
    await reopened.getState().openDocument();
    render(<Harness store={reopened} documentId={documentId} />);
    await segmentWith('SynapseRead sample text');
    // The sidebar remembers the Bookmarks tab for TXT documents.
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    expect(screen.getByTestId('navigator-tab-bookmarks')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findAllByTestId('bookmark-item')).toHaveLength(2);

    const removeButtons = screen.getAllByTestId('bookmark-remove-button');
    fireEvent.click(removeButtons[0] as HTMLElement);
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));

    // ⌘Z puts it back; ⌫ on a focused row removes it again.
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(2));
    const rows = await screen.findAllByTestId('bookmark-jump-button');
    (rows[0] as HTMLElement).focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Backspace' });
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));
  });

  it('creates, lists, jumps to, edits, deletes, and undoes independent highlights and notes without creating MindMap cards', async () => {
    const bytes = documentFixture('sample.txt');
    const { store, documentId } = await setup(bytes);
    render(<Harness store={store} documentId={documentId} />);

    // The markup bar (⇧⌘A) picks the color new marks use.
    expect(screen.queryByTestId('markup-bar')).toBeNull();
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', shiftKey: true, ctrlKey: true });
    fireEvent.click(
      within(await screen.findByTestId('markup-bar')).getByRole('button', {
        name: 'Pink highlight',
      }),
    );

    await selectText('quick brown fox');
    const popover = await screen.findByTestId('selection-popover');
    // The note stays mounted so its disclosure can grow, but inert until asked for.
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).not.toBeNull();
    fireEvent.click(within(popover).getByRole('button', { name: 'Add Note' }));
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).toBeNull();
    const composerInput = await screen.findByTestId('popover-note-input');
    fireEvent.change(composerInput, { target: { value: 'TXT note on line 2' } });
    fireEvent.click(screen.getByTestId('popover-note-save'));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.color).toBe('#f9a8d4');
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    const annotationId = store.getState().annotations[0]?.id as string;
    const painted = await segmentWith('quick brown fox');
    expect(painted).toHaveAttribute('data-annotation-id', annotationId);

    // Show Highlights & Notes (⌥⌘4): the row has its color, note, and date.
    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true, ctrlKey: true });
    expect(await screen.findByTestId('annotation-note-preview')).toHaveTextContent(
      'TXT note on line 2',
    );
    expect(screen.getByTestId('annotation-date').textContent).not.toBe('');

    // Edit note & color.
    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    const editNoteInput = await screen.findByTestId('annotation-note-input');
    fireEvent.change(editNoteInput, { target: { value: 'Updated TXT note' } });
    fireEvent.blur(editNoteInput);
    await waitFor(() => expect(store.getState().annotations[0]?.note).toBe('Updated TXT note'));

    // Delete and undo within the current session.
    fireEvent.click(screen.getByTestId('annotation-delete-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));

    fireEvent.click(await screen.findByTestId('undo-delete-annotation-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.note).toBe('Updated TXT note');

    // ⌫ on the focused row deletes; ⌘Z restores.
    const row = await screen.findByTestId('annotation-jump-button');
    row.focus();
    fireEvent.keyDown(row, { key: 'Backspace' });
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));
    expect(await screen.findByTestId('annotations-empty')).toHaveTextContent(/highlight it/);
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
  });

  it('offers a selection popover with named swatches, the keyboard, edit mode, and excerpting', async () => {
    const { store, documentId } = await setup(documentFixture('sample.txt'));
    render(<Harness store={store} documentId={documentId} />);

    // Nothing to act on yet: no popover, and no disabled Highlight or Add Note buttons.
    await segmentWith('quick brown fox');
    expect(screen.queryByTestId('selection-popover')).toBeNull();
    expect(screen.queryByRole('button', { name: /highlight selection/i })).toBeNull();

    await selectText('quick brown fox');
    const popover = await screen.findByTestId('selection-popover');
    expect(popover).toHaveAttribute('data-popover-mode', 'create');
    const swatches = within(popover).getAllByRole('button', { name: / highlight$/ });
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
      'Yellow highlight',
      'Green highlight',
      'Blue highlight',
      'Pink highlight',
      'Purple highlight',
    ]);
    // The last color is marked by a check, not by its hue alone.
    expect(swatches[0]).toHaveAttribute('aria-pressed', 'true');
    expect(swatches[0]?.querySelector('svg')).not.toBeNull();
    for (const name of ['Underline', 'Add Note', 'Excerpt to MindMap', 'Copy']) {
      expect(within(popover).getByRole('button', { name })).toBeInTheDocument();
    }

    // ⇧F10 moves focus into the popover; arrows move along it; Esc puts it away.
    fireEvent.keyDown(window, { key: 'F10', code: 'F10', shiftKey: true });
    expect(swatches[0]).toHaveFocus();
    fireEvent.keyDown(swatches[0] as HTMLElement, { key: 'ArrowRight' });
    expect(swatches[1]).toHaveFocus();
    fireEvent.keyDown(swatches[1] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByTestId('selection-popover')).toBeNull();
    // The context-menu key brings it back.
    fireEvent.keyDown(window, { key: 'ContextMenu', code: 'ContextMenu' });
    expect(await screen.findByTestId('selection-popover')).toBeInTheDocument();

    // Underline uses the last color.
    fireEvent.click(screen.getByRole('button', { name: 'Underline' }));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    const underlined = store.getState().annotations[0];
    expect(underlined?.style).toBe('underline');
    expect(underlined?.color).toBe('#fde047');
    const painted = await segmentWith('quick brown fox');
    expect(painted).toHaveAttribute('data-annotation-style', 'underline');
    expect(painted.style.textDecorationLine).toBe('underline');
    expect(screen.queryByTestId('selection-popover')).toBeNull();

    // Clicking it opens the same popover in edit mode: color, note, delete.
    fireEvent.click(painted);
    const editor = await screen.findByTestId('selection-popover');
    expect(editor).toHaveAttribute('data-popover-mode', 'edit');
    expect(within(editor).getByRole('button', { name: 'Underline' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(editor).queryByRole('button', { name: 'Excerpt to MindMap' })).toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: 'Green highlight' }));
    await waitFor(() => expect(store.getState().annotations[0]?.color).toBe('#86efac'));
    expect(store.getState().annotations[0]?.style).toBe('underline');
    fireEvent.click(within(editor).getByRole('button', { name: 'Underline' }));
    await waitFor(() => expect(store.getState().annotations[0]?.style).toBe('highlight'));
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).not.toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: 'Add Note' }));
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).toBeNull();
    fireEvent.change(await screen.findByTestId('popover-note-input'), {
      target: { value: 'Edited in place' },
    });
    fireEvent.click(screen.getByTestId('popover-note-save'));
    await waitFor(() => expect(store.getState().annotations[0]?.note).toBe('Edited in place'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Delete Highlight' }));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));
    expect(screen.queryByTestId('selection-popover')).toBeNull();

    // ⇧⌘H highlights with the last color (green, from the edit above).
    await selectText('quick brown fox');
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH', shiftKey: true, ctrlKey: true });
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.color).toBe('#86efac');
    expect(store.getState().annotations[0]?.style).toBe('highlight');

    // Excerpt to MindMap from the popover.
    await selectText('quick brown fox');
    fireEvent.click(
      within(await screen.findByTestId('selection-popover')).getByRole('button', {
        name: 'Excerpt to MindMap',
      }),
    );
    await waitFor(() => expect(store.getState().cards).toHaveLength(1));
  });

  it('highlights every pointer selection while highlight mode is on', async () => {
    const { store, documentId } = await setup(documentFixture('sample.txt'));
    render(<Harness store={store} documentId={documentId} />);
    await segmentWith('quick brown fox');

    // ⌃⌘H arms it and shows the markup bar, where it reads as on.
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH', altKey: true, ctrlKey: true });
    const toggle = within(await screen.findByTestId('markup-bar')).getByRole('switch', {
      name: 'Highlight Mode',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Underline' }));

    fireEvent.pointerDown(scroller(), { button: 0 });
    await selectText('quick brown fox');
    expect(screen.queryByTestId('selection-popover')).toBeNull();
    fireEvent.pointerUp(window, { button: 0 });
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]?.style).toBe('underline');
    expect(screen.queryByTestId('selection-popover')).toBeNull();

    // Off again, a selection gets the popover instead.
    fireEvent.click(toggle);
    fireEvent.pointerDown(scroller(), { button: 0 });
    await selectText('quick brown fox');
    fireEvent.pointerUp(window, { button: 0 });
    expect(await screen.findByTestId('selection-popover')).toBeInTheDocument();
    expect(store.getState().annotations).toHaveLength(1);
  });

  it('shows a read failure instead of an empty page', async () => {
    const { store, documentId } = await setup(async () => {
      throw { code: 'io', message: 'file is gone' };
    });
    render(<Harness store={store} documentId={documentId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('file is gone');
  });

  it('cancels in-flight backend text streams when the reader tab unmounts and bounds DOM rows for large files', async () => {
    const largeLines = Array.from(
      { length: 2400 },
      (_, index) => `Line ${index + 1}: large text fixture payload for bounded virtualization`,
    ).join('\n');
    const largeBytes = new TextEncoder().encode(largeLines);
    const { store, documentId, backend } = await setup(largeBytes, 4096);

    let receivedSignal: AbortSignal | undefined;
    const originalRead = backend.readTextStream.bind(backend);
    backend.readTextStream = vi.fn((docId, encoding, onChunk, signal) => {
      receivedSignal = signal;
      return originalRead(docId, encoding, onChunk, signal);
    });

    const view = render(<Harness store={store} documentId={documentId} />);
    await segmentWith('Line 1: large text fixture payload');

    // Only the visible window + overscan rows are mounted in the DOM, never all 2,400 lines.
    const renderedRows = document.querySelectorAll('[data-testid="txt-scroll"] [data-index]');
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(80);
    expect(receivedSignal?.aborted).toBe(false);

    // Unmounting (closing the tab) immediately aborts the backend stream signal.
    view.unmount();
    expect(receivedSignal?.aborted).toBe(true);

    // A stream invoked with an already-aborted signal delivers 0 chunks.
    const abortedController = new AbortController();
    abortedController.abort();
    let chunksDeliveredAfterAbort = 0;
    const count = await originalRead(
      documentId,
      'utf-8',
      () => {
        chunksDeliveredAfterAbort += 1;
      },
      abortedController.signal,
    );
    expect(count).toBe(0);
    expect(chunksDeliveredAfterAbort).toBe(0);
  });
});
