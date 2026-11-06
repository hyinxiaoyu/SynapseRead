import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_HIGHLIGHT_ID } from '@/features/reader/DocumentSearchBar';
import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import {
  createStudySyncStore,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
} from '@/stores/useStudySyncStore';
import type { PdfAnchor } from '@/types/domain';

import type { PdfOutlineItem, PdfPageAnnotations, PdfPageText } from './pdfEngine';
import { PdfViewer } from './PdfViewer';

// jsdom cannot run pdf.js or draw a canvas: this replaces only the engine seam, and
// `pnpm e2e` drives the real one. Everything above that seam here is real.
const engineState = vi.hoisted(() => ({
  usesRealWorker: true,
  opened: 0,
  destroyed: 0,
  outline: [] as PdfOutlineItem[],
  pageTextGate: null as (() => Promise<void>) | null,
  pageAnnotations: new Map<number, PdfPageAnnotations>(),
}));

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
      getOutline: async () => engineState.outline,
      getPageAnnotations: async (pageIndex: number): Promise<PdfPageAnnotations> =>
        engineState.pageAnnotations.get(pageIndex) ?? {
          links: [],
          embeddedAnnotations: [],
          unsupportedSubtypes: [],
        },
      getPageText: async (pageIndex: number): Promise<PdfPageText> => {
        if (engineState.pageTextGate) {
          await engineState.pageTextGate();
        }
        return {
          pageIndex,
          runs: [
            {
              text: `First line of page ${pageIndex}`,
              rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.03 },
              hasEOL: true,
            },
            {
              text:
                pageIndex === 4
                  ? `Second line of page ${pageIndex} with 汉字 and Fox`
                  : `Second line of page ${pageIndex}`,
              rect: { x: 0.1, y: 0.4, width: 0.6, height: 0.03 },
            },
          ],
        };
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
  if (document?.format !== 'pdf') throw new Error('expected a pdf document');
  return (
    <PdfViewer
      document={{ ...document, format: 'pdf' }}
      isActive={isActive}
      content={state.content}
      highlights={highlights}
      jumpRequest={state.jumpRequest?.documentId === documentId ? state.jumpRequest : null}
      onSelectionChange={state.setSelection}
      onJumpHandled={state.completeJump}
      onCursorChange={(anchor) => state.reportCursor(documentId, anchor)}
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
    engineState.pageTextGate = null;
    engineState.pageAnnotations = new Map();
    engineState.outline = [
      {
        id: 'outline-0',
        title: 'Part One',
        pageIndex: 0,
        children: [{ id: 'outline-0-0', title: 'Blue Box Section', pageIndex: 2, children: [] }],
      },
      { id: 'outline-1', title: 'Part Two', pageIndex: 3, children: [] },
    ];
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

  it('captures a selection that crosses pages with pageSpans and renders highlights across both pages', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const first = await pageElement(0);
    const second = await pageElement(1);

    select([textNode(first, 1), 0], [textNode(second, 0), 5]);
    const selection = store.getState().selection;
    const anchor = selection?.anchor as PdfAnchor;
    expect(anchor.pageIndex).toBe(0);
    expect(anchor.pageSpans).toHaveLength(2);
    expect(anchor.pageSpans?.[0]?.pageIndex).toBe(0);
    expect(anchor.pageSpans?.[1]?.pageIndex).toBe(1);
    expect(selection?.text).toBe('Second line of page 0\nFirst');

    await act(() => store.getState().createAnnotationFromSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    expect(first.querySelector(`[data-annotation-id="${annotationId}"]`)).not.toBeNull();
    expect(second.querySelector(`[data-annotation-id="${annotationId}"]`)).not.toBeNull();
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

  it('validates page input, navigates to valid pages, and returns to previous locations', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    expect(pageInput).toHaveValue('1');
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('of 5');

    // Invalid page inputs are rejected and marked aria-invalid.
    fireEvent.change(pageInput, { target: { value: '99' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);
    expect(pageInput).toHaveAttribute('aria-invalid', 'true');
    expect((await scroller()).scrollTop).toBe(0);

    fireEvent.blur(pageInput);
    expect(pageInput).toHaveValue('1');
    expect(pageInput).toHaveAttribute('aria-invalid', 'false');

    // Valid page input scrolls to page 3 (0-based index 2) and enables returning back.
    fireEvent.change(pageInput, { target: { value: '3' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);
    expect(pageInput).toHaveAttribute('aria-invalid', 'false');
    expect((await scroller()).scrollTop).toBeCloseTo(2 * (PAGE_PX + GAP_PX), 0);

    const backButton = await screen.findByRole('button', { name: 'Return to previous location' });
    fireEvent.click(backButton);
    expect((await scroller()).scrollTop).toBeCloseTo(0, 0);
    expect(pageInput).toHaveValue('1');
  });

  it('renders nested PDF outlines, jumps to outline destinations, and handles empty outlines', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    fireEvent.click(screen.getByRole('button', { name: 'Table of contents' }));
    expect(screen.getByTestId('reader-toc')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Part One' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    const nested = screen.getByRole('button', { name: 'Blue Box Section' });
    expect(nested).toBeInTheDocument();

    fireEvent.click(nested);
    expect((await scroller()).scrollTop).toBeCloseTo(2 * (PAGE_PX + GAP_PX), 0);

    fireEvent.click(await screen.findByRole('button', { name: 'Return to previous location' }));
    expect((await scroller()).scrollTop).toBeCloseTo(0, 0);
    view.unmount();

    // Empty outline state
    engineState.outline = [];
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    fireEvent.click(screen.getByRole('button', { name: 'Table of contents' }));
    expect(screen.getByTestId('reader-toc')).toHaveTextContent('No outline in this document.');
  });

  it('supports fit-width, fit-page, actual-size, and explicit zoom while preserving the reading target across mixed page sizes', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    const viewer = screen.getByTestId('pdf-viewer');
    const zoomLevel = screen.getByTestId('pdf-zoom-level');
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-width');
    expect(zoomLevel).toHaveTextContent('100%');

    // Scroll to 25% into page 2 (0-based index 2).
    const page2StartAtFitWidth = 2 * (PAGE_PX + GAP_PX);
    await scrollTo(page2StartAtFitWidth + PAGE_PX * 0.25);

    // Switch to Fit page: available height is VIEWPORT_PX - 2 * GAP_PX = 576, so scale is 576 / 800 = 0.72 (72%).
    fireEvent.click(screen.getByRole('button', { name: 'Fit page' }));
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-page');
    expect(zoomLevel).toHaveTextContent('72%');
    const fitPageHeight = PAGE_PX * (576 / 800);
    const expectedFitPageTop = 2 * (fitPageHeight + GAP_PX) + fitPageHeight * 0.25;
    expect((await scroller()).scrollTop).toBeCloseTo(expectedFitPageTop, 0);

    // Zoom in from 72% snaps to 75%, then 100%, then 125%, preserving page 2 at 25%.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(viewer).toHaveAttribute('data-zoom-mode', 'custom');
    expect(zoomLevel).toHaveTextContent('75%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomLevel).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomLevel).toHaveTextContent('125%');
    const custom125Height = PAGE_PX * 1.25;
    expect((await scroller()).scrollTop).toBeCloseTo(
      2 * (custom125Height + GAP_PX) + custom125Height * 0.25,
      0,
    );

    // Navigate to page 4 (0-based index 3, which is 306x400) and compare Fit width vs Actual size.
    const pageInput = screen.getByLabelText('Page number');
    fireEvent.change(pageInput, { target: { value: '4' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);

    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-width');
    // Page 3 is 306px wide in a 612px content width -> 200% scale.
    expect(zoomLevel).toHaveTextContent('200%');

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(viewer).toHaveAttribute('data-zoom-mode', 'actual-size');
    expect(zoomLevel).toHaveTextContent('100%');
    const page3El = await pageElement(3);
    expect(page3El.parentElement?.style.width).toBe('306px');
    expect(page3El.parentElement?.style.height).toBe('400px');
  });

  it('handles keyboard zoom shortcuts and ignores them inside text inputs', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    const viewer = screen.getByTestId('pdf-viewer');
    const zoomLevel = screen.getByTestId('pdf-zoom-level');

    fireEvent.keyDown(window, { key: '+', metaKey: true });
    expect(viewer).toHaveAttribute('data-zoom-mode', 'custom');
    expect(zoomLevel).toHaveTextContent('125%');

    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(zoomLevel).toHaveTextContent('100%');

    fireEvent.keyDown(window, { key: '8', metaKey: true });
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-page');
    expect(zoomLevel).toHaveTextContent('72%');

    fireEvent.keyDown(window, { key: '0', metaKey: true });
    expect(viewer).toHaveAttribute('data-zoom-mode', 'actual-size');
    expect(zoomLevel).toHaveTextContent('100%');

    fireEvent.keyDown(window, { key: '9', metaKey: true });
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-width');
    expect(zoomLevel).toHaveTextContent('100%');

    // Shortcuts fired inside the page number input must not trigger zoom changes.
    const pageInput = screen.getByLabelText('Page number');
    fireEvent.keyDown(pageInput, { key: '+', metaKey: true });
    expect(viewer).toHaveAttribute('data-zoom-mode', 'fit-width');
    expect(zoomLevel).toHaveTextContent('100%');
  });

  it('searches across rendered and unrendered PDF pages, highlights matches, and supports return', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    // Page 4 is far off-screen and not rendered in the virtualizer.
    expect(document.querySelector('[data-page-index="4"]')).toBeNull();

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    const searchInput = await screen.findByTestId('search-input');

    // Search for "First line of page", which matches all 5 pages.
    fireEvent.change(searchInput, { target: { value: 'First line of page' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 5'));
    const resultItems = screen.getAllByTestId('search-result-item');
    expect(resultItems).toHaveLength(5);
    expect(resultItems[4]).toHaveTextContent('Page 5');

    // Direct jump to the 5th match (unrendered page index 4).
    fireEvent.click(resultItems[4] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('5 of 5'));
    expect(screen.getByLabelText('Page number')).toHaveValue('5');
    const page4 = await pageElement(4);
    const painted = page4.querySelector<HTMLElement>(
      `[data-annotation-id="${SEARCH_HIGHLIGHT_ID}"]`,
    );
    expect(painted).not.toBeNull();
    expect(painted).toHaveClass('anchor-pulse');

    // Return to previous location returns to page 1.
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(screen.getByLabelText('Page number')).toHaveValue('1');

    // Case-sensitive search for "fox" vs "Fox" on page 5.
    fireEvent.change(searchInput, { target: { value: 'fox' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('No matches'),
    );
  });

  it('cancels an in-flight PDF search on explicit cancel or tab deactivation', async () => {
    const { store, documentId } = await setup();
    let releaseGate: (() => void) | undefined;
    engineState.pageTextGate = () =>
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    fireEvent.click(screen.getByRole('button', { name: 'Find in document' }));
    const searchInput = await screen.findByTestId('search-input');
    fireEvent.change(searchInput, { target: { value: 'Second line' } });

    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('Searching…'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel search' }));
    expect(screen.getByTestId('search-status')).toHaveTextContent('Search cancelled');
    releaseGate?.();

    // Start another slow search and switch away from the tab (`isActive = false`).
    engineState.pageTextGate = () =>
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    fireEvent.change(searchInput, { target: { value: 'First line' } });
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('Searching…'),
    );
    view.rerender(<Harness store={store} documentId={documentId} isActive={false} />);
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('Search cancelled'),
    );
    releaseGate?.();
  });

  it('adds, lists, jumps to, persists, removes, and handles stale bookmarks without creating cards or annotations', async () => {
    const { backend, store, documentId } = await setup();
    const first = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    // Jump to Page 3 (pageIndex 2) and bookmark with Cmd/Ctrl+D.
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    fireEvent.change(pageInput, { target: { value: '3' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);
    expect(pageInput).toHaveValue('3');

    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    await waitFor(() => expect(store.getState().bookmarks).toHaveLength(1));
    expect(store.getState().annotations).toEqual([]);
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'true');

    // Cmd/Ctrl+D inside the page number input is ignored.
    fireEvent.keyDown(pageInput, { key: 'd', metaKey: true });
    expect(store.getState().bookmarks).toHaveLength(1);

    // Navigate back to Page 1, open bookmarks list, and jump to the saved bookmark.
    fireEvent.change(pageInput, { target: { value: '1' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);
    expect(pageInput).toHaveValue('1');
    expect(screen.getByTestId('toggle-bookmark-button')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
    await screen.findByTestId('bookmark-item');
    expect(screen.getByTestId('bookmark-label')).toHaveTextContent('Page 3');
    const jumpButton = screen.getByTestId('bookmark-jump-button');
    fireEvent.click(jumpButton);
    expect(pageInput).toHaveValue('3');
    expect(jumpButton).toHaveAttribute('aria-current', 'location');

    // Return to previous location returns to Page 1.
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(pageInput).toHaveValue('1');

    // Add a stale bookmark on an out-of-range page and verify stale badge & status.
    await act(() =>
      store.getState().addBookmark(
        documentId,
        {
          format: 'pdf',
          pageIndex: 99,
          rects: [{ x: 0, y: 0, width: 1, height: 0.01 }],
        },
        'Page 100',
      ),
    );
    expect(await screen.findByTestId('bookmark-stale')).toHaveTextContent('Stale');
    const jumpButtons = screen.getAllByTestId('bookmark-jump-button');
    fireEvent.click(jumpButtons[1] as HTMLElement);
    expect(await screen.findByRole('status')).toHaveTextContent(/page this file does not have/);

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await pageElement(0);
    fireEvent.click(screen.getByTestId('bookmarks-toggle-button'));
    expect(await screen.findAllByTestId('bookmark-item')).toHaveLength(2);

    const removeButtons = screen.getAllByTestId('bookmark-remove-button');
    fireEvent.click(removeButtons[0] as HTMLElement);
    await waitFor(() => expect(reopened.getState().bookmarks).toHaveLength(1));
  });

  it('creates, lists, jumps to, edits, deletes, and undoes independent highlights and notes without creating MindMap cards', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const page0 = await pageElement(0);
    const node = textNode(page0, 0);

    // Select text, pick Green highlight color, and add a note via SelectionNoteComposer.
    select([node, 0], [node, 10]);
    fireEvent.click(screen.getByTestId('annotation-color-green'));
    fireEvent.click(screen.getByTestId('add-note-selection-button'));
    const noteComposerInput = await screen.findByTestId('selection-note-input');
    fireEvent.change(noteComposerInput, { target: { value: 'Margin note on page 1' } });
    fireEvent.click(screen.getByTestId('save-selection-note-button'));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    expect(store.getState().annotations[0]).toMatchObject({
      excerptText: 'First line',
      color: '#86efac',
      note: 'Margin note on page 1',
    });

    // Open annotations panel, edit note & color, jump to annotation, delete, and undo delete.
    fireEvent.click(screen.getByTestId('annotations-toggle-button'));
    const item = await screen.findByTestId('annotation-item');
    expect(item).toHaveTextContent('Page 1');
    expect(item).toHaveTextContent('First line');

    const editNoteInput = screen.getByTestId('annotation-note-input') as HTMLInputElement;
    expect(editNoteInput).toHaveValue('Margin note on page 1');
    fireEvent.change(editNoteInput, { target: { value: 'Revised margin note' } });
    fireEvent.blur(editNoteInput);
    await waitFor(() => expect(store.getState().annotations[0]?.note).toBe('Revised margin note'));

    fireEvent.click(screen.getByTestId('annotation-item-color-blue'));
    await waitFor(() => expect(store.getState().annotations[0]?.color).toBe('#93c5fd'));

    // Navigate away to Page 3, then jump back via annotation list.
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    fireEvent.change(pageInput, { target: { value: '3' } });
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement);
    expect(pageInput).toHaveValue('3');

    fireEvent.click(screen.getByTestId('annotation-jump-button'));
    expect(pageInput).toHaveValue('1');

    // Delete annotation and undo within the current session.
    fireEvent.click(screen.getByTestId('annotation-delete-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(0));
    expect(screen.getByTestId('annotations-empty')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('undo-delete-annotation-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().annotations[0]).toMatchObject({
      excerptText: 'First line',
      color: '#93c5fd',
      note: 'Revised margin note',
    });
  });

  it('supports lazy thumbnails, continuous/single/two-page display modes, view rotation, internal links, and embedded annotations disclosure', async () => {
    engineState.pageAnnotations.set(0, {
      links: [
        {
          id: 'link-0-0',
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
          targetPageIndex: 3,
        },
      ],
      embeddedAnnotations: [
        {
          id: 'embed-0-0',
          subtype: 'Highlight',
          rects: [{ x: 0.15, y: 0.3, width: 0.4, height: 0.03 }],
          contents: 'Embedded PDF review note',
          author: 'Reviewer',
          color: 'rgba(255, 217, 51, 0.38)',
        },
      ],
      unsupportedSubtypes: ['Stamp'],
    });

    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    const page0 = await pageElement(0);

    // Embedded annotation and unsupported subtype disclosure on Page 1.
    const embedded = await screen.findByTestId('pdf-embedded-annotation');
    expect(embedded).toHaveAttribute('data-annotation-subtype', 'Highlight');
    expect(screen.getByTestId('pdf-embedded-annotation-note')).toHaveTextContent(
      'Embedded PDF review note',
    );
    expect(await screen.findByTestId('pdf-unsupported-annotations-notice')).toHaveTextContent(
      /Stamp/,
    );

    // Create a user highlight on Page 1 to verify geometry across rotation and display modes.
    const node = textNode(page0, 0);
    select([node, 0], [node, 10]);
    fireEvent.click(screen.getByTestId('highlight-selection-button'));
    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));

    const highlightEl = () =>
      document.querySelector<HTMLElement>('[data-page-index="0"] [data-annotation-id]');
    expect(highlightEl()?.style.left).toBe('10%');
    expect(highlightEl()?.style.top).toBe('10%');

    // Rotate clockwise (0 -> 90 -> 180 -> 270 -> 0) and verify rotated highlight geometry.
    fireEvent.click(screen.getByTestId('pdf-rotate-button'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-rotation', '90');
    // At 90° clockwise, canonical (x=0.1, y=0.1, h=0.02) maps to x' = 1 - (0.1 + 0.02) = 0.88, y' = 0.1.
    expect(parseFloat(highlightEl()?.style.left ?? '0')).toBeCloseTo(88, 2);
    expect(parseFloat(highlightEl()?.style.top ?? '0')).toBeCloseTo(10, 2);

    fireEvent.click(screen.getByTestId('pdf-rotate-button'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-rotation', '180');
    fireEvent.click(screen.getByTestId('pdf-rotate-button'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-rotation', '270');
    fireEvent.click(screen.getByTestId('pdf-rotate-button'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-rotation', '0');
    expect(highlightEl()?.style.left).toBe('10%');

    // Internal link on Page 1 navigates to Page 4 (pageIndex 3) and supports Return Back.
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    fireEvent.click(await screen.findByTestId('pdf-internal-link'));
    expect(pageInput).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(pageInput).toHaveValue('1');

    // Lazy thumbnails sidebar shows active page and jumps on click.
    fireEvent.click(screen.getByTestId('pdf-thumbnails-toggle'));
    expect(await screen.findByTestId('pdf-thumbnails-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-0')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByTestId('pdf-thumbnail-2'));
    expect(pageInput).toHaveValue('3');
    expect(screen.getByTestId('pdf-thumbnail-2')).toHaveAttribute('aria-current', 'page');

    // Display modes: Single page and Two pages preserve current reading location (Page 3).
    fireEvent.click(screen.getByTestId('pdf-mode-single'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-display-mode', 'single');
    expect(pageInput).toHaveValue('3');
    expect(document.querySelectorAll('[data-page-index]')).toHaveLength(1);
    expect(document.querySelector('[data-page-index="2"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('pdf-mode-two-page'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-display-mode', 'two-page');
    expect(pageInput).toHaveValue('3');
    expect(document.querySelector('[data-page-index="2"]')).not.toBeNull();
    expect(document.querySelector('[data-page-index="3"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('pdf-mode-continuous'));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-display-mode', 'continuous');
    expect(pageInput).toHaveValue('3');
  });
});
