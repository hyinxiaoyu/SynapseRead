import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import { createStudySyncStore, selectHighlights } from '@/stores/useStudySyncStore';
import type { PdfAnchor } from '@/types/domain';

import { PdfViewer } from './PdfViewer';

// jsdom cannot run pdf.js or draw a canvas: this replaces only the engine seam, and
// `pnpm e2e` drives the real one. Everything above that seam here is real.
const engineState = vi.hoisted(() => ({ usesRealWorker: true, opened: 0, destroyed: 0 }));

const PNG = 'iVBORw0KGgoAAAA';

vi.mock('./pdfEngine', () => ({
  cropCanvasToPng: vi.fn(() => PNG),
  openPdfDocument: vi.fn(async () => {
    engineState.opened += 1;
    const done = () => ({ promise: Promise.resolve(), cancel() {} });
    return {
      pageCount: 5,
      get usesRealWorker() {
        return engineState.usesRealWorker;
      },
      pageSize: async (index: number) =>
        index === 3 ? { width: 306, height: 400 } : { width: 612, height: 800 },
      renderPage: done,
      renderTextLayer(pageIndex: number, container: HTMLElement) {
        container.replaceChildren();
        for (const line of [
          `First line of page ${pageIndex}`,
          `Second line of page ${pageIndex}`,
        ]) {
          const span = document.createElement('span');
          span.textContent = line;
          container.append(span, document.createElement('br'));
        }
        return done();
      },
      destroy() {
        engineState.destroyed += 1;
      },
    };
  }),
}));

const PANE_PX = 636; // 12 px of padding either side leaves 612, so scale is exactly 1.
const VIEWPORT_PX = 600;
const GAP_PX = 12;
const PAGE_PX = 800;

type Store = ReturnType<typeof createStudySyncStore>;

function Harness({ store, documentId }: { store: Store; documentId: string }) {
  const state = store();
  const document = state.documents.find((candidate) => candidate.id === documentId);
  const highlights = useMemo(
    () => selectHighlights(state.annotations, documentId),
    [state.annotations, documentId],
  );
  if (document?.format !== 'pdf') throw new Error('expected a pdf document');
  return (
    <PdfViewer
      document={{ ...document, format: 'pdf' }}
      isActive
      content={state.content}
      highlights={highlights}
      jumpRequest={state.jumpRequest?.documentId === documentId ? state.jumpRequest : null}
      onSelectionChange={state.setSelection}
      onJumpHandled={state.completeJump}
      onCursorChange={(anchor) => state.reportCursor(documentId, anchor)}
    />
  );
}

const setup = async () => {
  const backend = createMemoryBackend({ library: { '/books/book.pdf': new Uint8Array([1]) } });
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

const scroller = () => screen.findByTestId('pdf-scroll');

const pageElement = (index: number) =>
  waitFor(() => {
    const page = document.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (!page?.querySelector('.textLayer span')) throw new Error(`page ${index} is not rendered`);
    return page;
  });

const textNode = (page: HTMLElement, line: number) =>
  page.querySelectorAll('.textLayer span')[line]?.firstChild as Text;

/** Selects DOM text from one point to another, and notifies as a browser would. */
const select = (start: [Text, number], end: [Text, number]) => {
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => void document.dispatchEvent(new Event('selectionchange')));
};

const scrollTo = async (top: number) => {
  const element = await scroller();
  element.scrollTop = top;
  act(() => void element.dispatchEvent(new Event('scroll')));
};

describe('PdfViewer', () => {
  beforeEach(() => {
    engineState.usesRealWorker = true;
    engineState.opened = 0;
    engineState.destroyed = 0;
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(PANE_PX);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT_PX);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100_000);
    Element.prototype.scrollTo = function (this: Element, options) {
      this.scrollTop = (options as ScrollToOptions).top ?? 0;
      this.dispatchEvent(new Event('scroll'));
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('[data-page-index], [data-testid="pdf-capture-surface"]')) {
        return { left: 100, top: 50, width: 612, height: 800 } as DOMRect;
      }
      return { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
    });
    // Each line of the fake text layer sits at a known place on the page.
    Range.prototype.getClientRects = function (this: Range) {
      const span = this.startContainer.parentElement as Element;
      const line = [...(span.parentElement as Element).children]
        .filter((child) => child.tagName === 'SPAN')
        .indexOf(span);
      const rect = {
        left: 100 + 61.2 + this.startOffset,
        top: 50 + 80 + line * 40,
        width: this.endOffset - this.startOffset,
        height: 16,
      };
      return [rect] as unknown as DOMRectList;
    };
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('runs text selection -> normalized anchor -> persist -> reopen', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    const page = await pageElement(0);
    const node = textNode(page, 0);

    select([node, 0], [node, 10]);
    const selection = store.getState().selection;
    expect(selection?.text).toBe('First line');
    expect(selection?.imagePng).toBeNull();
    expect(selection?.anchor).toEqual({
      format: 'pdf',
      pageIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: expect.closeTo(10 / 612, 5), height: 0.02 }],
    });

    await act(() => store.getState().excerptSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    const painted = page.querySelector<HTMLElement>(`[data-annotation-id="${annotationId}"]`);
    expect(painted?.style.left).toBe('10%');
    expect(painted?.style.top).toBe('10%');
    view.unmount();

    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    const repainted = await pageElement(0);
    expect(repainted.querySelector(`[data-annotation-id="${annotationId}"]`)).not.toBeNull();
  });

  it('merges a selection into one rectangle per line, with its line breaks', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const page = await pageElement(1);

    select([textNode(page, 0), 6], [textNode(page, 1), 6]);
    const selection = store.getState().selection;
    expect(selection?.text).toBe('line of page 1\nSecond');
    expect((selection?.anchor as PdfAnchor).pageIndex).toBe(1);
    expect((selection?.anchor as PdfAnchor).rects).toHaveLength(2);
  });

  it('keeps the first page of a selection that crosses pages', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const first = await pageElement(0);
    const second = await pageElement(1);

    select([textNode(first, 1), 0], [textNode(second, 0), 5]);
    const selection = store.getState().selection;
    expect((selection?.anchor as PdfAnchor).pageIndex).toBe(0);
    expect(selection?.text).toBe('Second line of page 0');
  });

  it('clears the selection when the browser selection collapses', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const node = textNode(await pageElement(0), 0);
    select([node, 0], [node, 5]);
    expect(store.getState().selection).not.toBeNull();

    window.getSelection()?.removeAllRanges();
    act(() => void document.dispatchEvent(new Event('selectionchange')));
    expect(store.getState().selection).toBeNull();
  });

  describe('rectangle capture', () => {
    const dragCapture = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Capture area' }));
      const surface = (await waitFor(() => {
        const element = document.querySelector(
          '[data-page-index="0"] [data-testid="pdf-capture-surface"]',
        );
        if (!element) throw new Error('no capture surface');
        return element;
      })) as HTMLElement;
      fireEvent.pointerDown(surface, { clientX: 100 + 61.2, clientY: 50 + 80, pointerId: 1 });
      fireEvent.pointerMove(surface, { clientX: 100 + 306, clientY: 50 + 400, pointerId: 1 });
      fireEvent.pointerUp(surface, { clientX: 100 + 306, clientY: 50 + 400, pointerId: 1 });
    };

    it('runs drag -> PNG selection -> stored capture -> reopen', async () => {
      const { backend, store, documentId } = await setup();
      const view = render(<Harness store={store} documentId={documentId} />);
      await pageElement(0);
      await dragCapture();

      const selection = store.getState().selection;
      expect(selection?.text).toBeNull();
      expect(selection?.imagePng).toBe(PNG);
      const anchor = selection?.anchor as PdfAnchor;
      expect(anchor.rects[0]?.x).toBeCloseTo(0.1, 5);
      expect(anchor.rects[0]?.y).toBeCloseTo(0.1, 5);
      expect(anchor.rects[0]?.width).toBeCloseTo(0.4, 5);
      expect(anchor.rects[0]?.height).toBeCloseTo(0.4, 5);
      expect(screen.getByTestId('pdf-capture-box')).toBeInTheDocument();
      expect(screen.queryByTestId('pdf-capture-surface')).not.toBeInTheDocument();

      await act(() => store.getState().excerptSelection());
      const annotation = store.getState().annotations[0];
      expect(annotation?.excerptImagePath).toBe(`captures/${annotation?.id}.png`);
      expect(store.getState().cards[0]?.title).toBe('Image excerpt');
      expect(await store.getState().captureUrl(annotation?.id as string)).toBe(
        `data:image/png;base64,${PNG}`,
      );
      expect(screen.queryByTestId('pdf-capture-box')).not.toBeInTheDocument();
      view.unmount();

      const reopened = await reopen(backend);
      render(<Harness store={reopened} documentId={documentId} />);
      const page = await pageElement(0);
      expect(page.querySelector(`[data-annotation-id="${annotation?.id}"]`)).not.toBeNull();
    });

    it('ignores a stray click', async () => {
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await pageElement(0);
      fireEvent.click(await screen.findByRole('button', { name: 'Capture area' }));
      const surface = (await screen.findAllByTestId('pdf-capture-surface'))[0] as HTMLElement;
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 200, pointerId: 1 });
      fireEvent.pointerUp(surface, { clientX: 201, clientY: 201, pointerId: 1 });
      expect(store.getState().selection).toBeNull();
    });

    it('discards a capture when capture mode is turned on again', async () => {
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await pageElement(0);
      await dragCapture();
      expect(store.getState().selection).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Capture area' }));
      expect(store.getState().selection).toBeNull();
    });

    it('does not lose a capture to the selection change it causes', async () => {
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      await pageElement(0);
      await dragCapture();
      act(() => void document.dispatchEvent(new Event('selectionchange')));
      expect(store.getState().selection?.imagePng).toBe(PNG);
    });
  });

  it('runs a jump round trip: scroll, pulse, complete', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    await act(async () => {
      store.getState().setSelection({
        documentId,
        anchor: {
          format: 'pdf',
          pageIndex: 2,
          rects: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.02 }],
        },
        text: 'far away',
        imagePng: null,
      });
      await store.getState().excerptSelection();
    });
    const nodeId = store.getState().nodes[0]?.id as string;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => store.getState().jumpToNode(nodeId));
      const expectedTop = 2 * (PAGE_PX + GAP_PX) + 0.5 * PAGE_PX - VIEWPORT_PX / 3;
      expect((await scroller()).scrollTop).toBeCloseTo(expectedTop, 0);

      const page = await pageElement(2);
      expect(page.querySelector('.anchor-pulse')).not.toBeNull();
      await act(async () => void vi.advanceTimersByTime(PULSE_MS + 10));
      expect(store.getState().jumpRequest).toBeNull();
      expect(page.querySelector('.anchor-pulse')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a jump to a page that no longer exists, and says so', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    act(() =>
      store.setState({
        jumpRequest: {
          nonce: 9,
          documentId,
          annotationId: 'gone',
          anchor: {
            format: 'pdf',
            pageIndex: 99,
            rects: [{ x: 0, y: 0, width: 1, height: 1 }],
          },
        },
      }),
    );
    await waitFor(() => expect(store.getState().jumpRequest).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent(/does not have/);
  });

  it('reopens at the last reading position, including within a page', async () => {
    const { backend, store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const pageStart = 2 * (PAGE_PX + GAP_PX);
    await scrollTo(pageStart + PAGE_PX / 4);
    await waitFor(
      () => {
        const cursor = store.getState().documents[0]?.lastCursorAnchor as PdfAnchor | null;
        expect(cursor?.pageIndex).toBe(2);
        expect(cursor?.rects[0]?.y).toBeCloseTo(0.25, 2);
      },
      { timeout: 2000 },
    );
    view.unmount();

    const reopened = await reopen(backend);
    const update = vi.spyOn(backend, 'updateDocumentCursor');
    render(<Harness store={reopened} documentId={documentId} />);
    await waitFor(async () =>
      expect((await scroller()).scrollTop).toBeCloseTo(pageStart + PAGE_PX / 4, 0),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(update).not.toHaveBeenCalled();
  });

  it('accounts for pages of different sizes when placing later pages', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    act(() =>
      store.setState({
        jumpRequest: {
          nonce: 3,
          documentId,
          annotationId: 'x',
          anchor: { format: 'pdf', pageIndex: 4, rects: [{ x: 0, y: 0, width: 1, height: 0.1 }] },
        },
      }),
    );
    // Page 3 is half as wide and proportionally taller once fit to the same width.
    const heights = [800, 800, 800, 800, 800].map((height, index) =>
      index === 3 ? (612 / 306) * 400 : height,
    );
    const start = heights.slice(0, 4).reduce((sum, height) => sum + height + GAP_PX, 0);
    await waitFor(async () =>
      expect((await scroller()).scrollTop).toBeCloseTo(start - VIEWPORT_PX / 3, 0),
    );
  });

  it('labels a fallback to the main thread, which otherwise renders silently', async () => {
    engineState.usesRealWorker = false;
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    expect(await screen.findByTestId('pdf-viewer')).toHaveAttribute(
      'data-pdf-worker',
      'main-thread',
    );
  });

  it('shows why a document could not open', async () => {
    const backend = createMemoryBackend({
      library: {
        '/books/book.pdf': async () => {
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

  it('opens once, and releases the document when the tab closes', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    act(() =>
      store.getState().reportCursor(documentId, {
        format: 'pdf',
        pageIndex: 1,
        rects: [{ x: 0, y: 0, width: 1, height: 0.001 }],
      }),
    );
    await pageElement(0);
    expect(engineState.opened).toBe(1);
    view.unmount();
    expect(engineState.destroyed).toBe(1);
  });
});
