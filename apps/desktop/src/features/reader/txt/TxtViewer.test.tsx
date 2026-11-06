import { act, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend, type MemoryFile } from '@/lib/backend/memoryBackend';
import { createStudySyncStore, selectHighlights } from '@/stores/useStudySyncStore';
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
  });

  it('shows a read failure instead of an empty page', async () => {
    const { store, documentId } = await setup(async () => {
      throw { code: 'io', message: 'file is gone' };
    });
    render(<Harness store={store} documentId={documentId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('file is gone');
  });
});
