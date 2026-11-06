import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_HIGHLIGHT_ID } from '@/features/reader/DocumentSearchBar';
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
function Harness({ store, documentId }: { store: Store; documentId: string }) {
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
      expect(await screen.findByRole('status')).toHaveTextContent(/past the end/);
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
      await act(async () => {
        screen.getByRole('button', { name: 'Dark' }).click();
      });
      await act(async () => {
        screen.getByRole('button', { name: 'Mono' }).click();
      });
      await act(async () => {
        screen.getByRole('button', { name: 'Increase font size' }).click();
      });
      await act(async () => {
        screen.getByRole('button', { name: 'Relaxed' }).click();
      });
      await act(async () => {
        screen.getByRole('button', { name: 'Narrow' }).click();
      });

      const viewer = screen.getByTestId('txt-viewer');
      expect(viewer).toHaveAttribute('data-reading-theme', 'dark');
      expect(viewer).toHaveAttribute('data-reading-width', 'narrow');
      expect(scroller().scrollTop).toBe(40 * ROW_PX);
      const docEl = screen.getByRole('document');
      expect(docEl.style.fontSize).toBe('1.1rem');
      expect(docEl.style.lineHeight).toBe('2.1');
      first.unmount();

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      await reopened.getState().openDocument();
      render(<Harness store={reopened} documentId={documentId} />);
      await waitFor(() => expect(scroller().scrollTop).toBe(40 * ROW_PX));
      expect(screen.getByTestId('txt-viewer')).toHaveAttribute('data-reading-theme', 'dark');
      expect(screen.getByTestId('txt-viewer')).toHaveAttribute('data-reading-width', 'narrow');
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
      expect(await screen.findByRole('status')).toHaveTextContent(/not valid UTF-8/);
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
    expect(screen.getByTestId('search-status')).toHaveTextContent('Enter a search term');

    // Search for a phrase that exists both near the top and in an unrendered row at the end.
    fireEvent.change(searchInput, { target: { value: 'final target sentence' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('No matches'),
    );

    // Empty query resets search state.
    fireEvent.change(searchInput, { target: { value: '   ' } });
    expect(screen.getByTestId('search-status')).toHaveTextContent('Enter a search term');
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

    // Scroll back to top, open bookmarks list, and jump to the saved bookmark.
    scrollTo(0);
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
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
    expect(await screen.findByRole('status')).toHaveTextContent(/past the end of this file/);

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = createStudySyncStore(backend);
    await reopened.getState().initialize();
    await reopened.getState().openDocument();
    render(<Harness store={reopened} documentId={documentId} />);
    await segmentWith('SynapseRead sample text');
    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
    expect(await screen.findAllByTestId('bookmark-item')).toHaveLength(2);

    const removeButtons = screen.getAllByTestId('bookmark-remove-button');
    fireEvent.click(removeButtons[0] as HTMLElement);
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));
  });

  it('creates, lists, jumps to, edits, deletes, and undoes independent highlights and notes without creating MindMap cards', async () => {
    const bytes = documentFixture('sample.txt');
    const { store, documentId } = await setup(bytes);
    render(<Harness store={store} documentId={documentId} />);

    await selectText('quick brown fox');
    fireEvent.click(screen.getByTestId('annotation-color-pink'));
    fireEvent.click(screen.getByTestId('add-note-selection-button'));
    const composerInput = await screen.findByTestId('selection-note-input');
    fireEvent.change(composerInput, { target: { value: 'TXT note on line 2' } });
    fireEvent.click(screen.getByTestId('save-selection-note-button'));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    const annotationId = store.getState().annotations[0]?.id as string;
    const painted = await segmentWith('quick brown fox');
    expect(painted).toHaveAttribute('data-annotation-id', annotationId);

    // Open annotations panel and edit note & color.
    fireEvent.click(screen.getByTestId('annotations-toggle-button'));
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
