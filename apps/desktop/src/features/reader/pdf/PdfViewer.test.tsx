import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_HIGHLIGHT_ID } from '@/features/reader/DocumentSearch';
import { PULSE_MS } from '@/features/reader/pulse';
import { INFO_NOTICE_MS, NOTICE_FADE_MS } from '@/features/reader/ReaderNotice';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import {
  createStudySyncStore,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
} from '@/stores/useStudySyncStore';
import {
  DEFAULT_READING_PREFERENCES,
  type PdfAnchor,
  type PdfLayout,
  type ReadingPreferences,
} from '@/types/domain';

import type { PdfOutlineItem, PdfPageAnnotations, PdfPageText } from './pdfEngine';
import { getBoundedLru, MAX_CACHED_TEXT_PAGES, setBoundedLru } from './pdfGeometry';
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
  /** Holds back one page's annotations until the test resolves it. */
  pageAnnotationsGate: new Map<number, Promise<void>>(),
  pageLabels: null as string[] | null,
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
      getPageLabels: async () => engineState.pageLabels,
      getPageAnnotations: async (pageIndex: number): Promise<PdfPageAnnotations> => {
        await engineState.pageAnnotationsGate.get(pageIndex);
        return (
          engineState.pageAnnotations.get(pageIndex) ?? {
            links: [],
            embeddedAnnotations: [],
            unsupportedSubtypes: [],
          }
        );
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
  chromeHidden = false,
  preferences,
}: {
  store: Store;
  documentId: string;
  isActive?: boolean;
  chromeHidden?: boolean;
  preferences?: ReadingPreferences;
}) {
  const state = store();
  const document = state.documents.find((candidate) => candidate.id === documentId);
  // As ReaderPane does: the layout comes from the store once loaded.
  const pdfLayout = state.pdfLayouts[documentId];
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
      {...(chromeHidden ? { chromeHidden } : {})}
      content={state.content}
      highlights={highlights}
      jumpRequest={state.jumpRequest?.documentId === documentId ? state.jumpRequest : null}
      onSelectionChange={state.setSelection}
      onJumpHandled={state.completeJump}
      onCursorChange={(anchor) => state.reportCursor(documentId, anchor)}
      {...(preferences ? { preferences } : {})}
      {...(pdfLayout
        ? {
            pdfLayout,
            onPdfLayoutChange: (layout: PdfLayout) => void state.savePdfLayout(documentId, layout),
          }
        : {})}
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
    engineState.pageAnnotationsGate = new Map();
    engineState.pageLabels = null;
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

  it('tints page canvases for a Dark theme without changing the bitmap', async () => {
    const { store, documentId } = await setup();
    const dark: ReadingPreferences = {
      ...DEFAULT_READING_PREFERENCES,
      theme: 'dark',
      tintPdfPages: true,
    };
    const view = render(<Harness store={store} documentId={documentId} preferences={dark} />);
    const page = await pageElement(0);
    const canvas = page.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(getComputedStyle(canvas as HTMLElement).filter).toContain('invert');
    expect(page.dataset.pageTint).toBe('on');
    expect(
      document.querySelector('[data-testid="pdf-viewer"]')?.getAttribute('data-tint-pdf'),
    ).toBe('dark');

    // A filled highlight turns translucent while tinted, so the inverted page
    // text stays visible; the untinted page keeps its multiply blending.
    select([textNode(page, 0), 0], [textNode(page, 0), 10]);
    await act(() => store.getState().createAnnotationFromSelection());
    const annotationId = store.getState().annotations[0]?.id as string;
    await waitFor(() => {
      expect(
        page.querySelector<HTMLElement>(`[data-annotation-id="${annotationId}"]`)?.className,
      ).toContain('opacity-40');
    });

    // The page keeps its own colors when the switch is off, and in Light.
    view.rerender(
      <Harness
        store={store}
        documentId={documentId}
        preferences={{ ...dark, tintPdfPages: false }}
      />,
    );
    await waitFor(() => {
      expect(getComputedStyle(canvas as HTMLElement).filter).toBe('none');
      expect(
        page.querySelector<HTMLElement>(`[data-annotation-id="${annotationId}"]`)?.className,
      ).toBe('pointer-events-none absolute mix-blend-multiply');
    });
    expect(page.dataset.pageTint).toBeUndefined();
    view.rerender(
      <Harness store={store} documentId={documentId} preferences={{ ...dark, theme: 'light' }} />,
    );
    await waitFor(() => {
      expect(getComputedStyle(canvas as HTMLElement).filter).toBe('none');
    });
  });

  it('closes the appearance popover when focus mode begins', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Reading appearance' }));
    expect(await screen.findByTestId('appearance-popover')).toBeInTheDocument();

    view.rerender(<Harness store={store} documentId={documentId} chromeHidden />);
    await waitFor(() => expect(screen.queryByTestId('appearance-popover')).toBeNull());
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
    expect(await screen.findByText(/does not have/)).toHaveAttribute('role', 'status');
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

  it('opens in its saved layout, reports every change whole, and keeps it across a restart', async () => {
    const { backend, store, documentId } = await setup();
    await store.getState().loadPdfLayout(documentId);
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const viewer = screen.getByTestId('pdf-viewer');
    expect(viewer).toHaveAttribute('data-display-mode', 'continuous');
    expect(screen.queryByRole('button', { name: 'Cover page alone' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Two pages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cover page alone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = screen.getByTestId('pdf-zoom-level').textContent;

    const chosen = expect.objectContaining({
      displayMode: 'two-page',
      zoomMode: 'custom',
      rotation: 90,
      coverPageAlone: true,
    });
    await waitFor(() => expect(store.getState().pdfLayouts[documentId]).toEqual(chosen));
    await expect(backend.getPdfLayout(documentId)).resolves.toEqual(chosen);
    const saved = await backend.getPdfLayout(documentId);
    view.unmount();

    // A restart: a new store over the same backend, and a clean mount.
    const restarted = await reopen(backend);
    expect(restarted.getState().activeDocumentId).toBe(documentId);
    await restarted.getState().loadPdfLayout(documentId);
    expect(restarted.getState().pdfLayouts[documentId]).toEqual(saved);
    const saveSpy = vi.spyOn(backend, 'savePdfLayout');
    render(<Harness store={restarted} documentId={documentId} />);
    await pageElement(0);
    const reopened = screen.getByTestId('pdf-viewer');
    expect(reopened).toHaveAttribute('data-display-mode', 'two-page');
    expect(reopened).toHaveAttribute('data-zoom-mode', 'custom');
    expect(reopened).toHaveAttribute('data-rotation', '90');
    expect(reopened).toHaveAttribute('data-cover-page-alone', 'true');
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent(zoomed ?? '');
    expect(screen.getByRole('button', { name: 'Cover page alone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Opening in a layout is not a change to it.
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('shows the cover page alone in two pages, then pairs 2-3 and 4-5', async () => {
    window.localStorage.clear();
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const pane = await scroller();
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, PANE_PX, 600));
    const readout = screen.getByTestId('reader-footer-readout');
    fireEvent.click(readout); // Page N of M
    /** The pages drawn side by side with `index`. */
    const rowWith = (index: number) => {
      const page = document.querySelector(`[data-page-index="${index}"]`);
      const row = page?.parentElement?.parentElement;
      return [...(row?.querySelectorAll('[data-page-index]') ?? [])].map((element) =>
        Number(element.getAttribute('data-page-index')),
      );
    };

    fireEvent.click(screen.getByRole('radio', { name: 'Two pages' }));
    await pageElement(1);
    expect(rowWith(0)).toEqual([0, 1]);
    expect(rowWith(2)).toEqual([2, 3]);

    fireEvent.click(screen.getByRole('button', { name: 'Cover page alone' }));
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('data-cover-page-alone', 'true');
    await waitFor(() => expect(rowWith(0)).toEqual([0]));
    expect(rowWith(1)).toEqual([1, 2]);

    // A turn moves a whole spread, whether it holds one page or two.
    const edgeClick = (x: number) =>
      fireEvent.click(pane, { clientX: x, clientY: 300, button: 0, detail: 1 });
    edgeClick(PANE_PX - 10);
    expect(readout).toHaveTextContent('Page 2 of 5');
    edgeClick(PANE_PX - 10);
    expect(readout).toHaveTextContent('Page 4 of 5');
    await waitFor(() => expect(rowWith(3)).toEqual([3, 4]));
    edgeClick(10);
    expect(readout).toHaveTextContent('Page 2 of 5');
    edgeClick(10);
    expect(readout).toHaveTextContent('Page 1 of 5');
  });

  it('shows printed page labels and jumps by label or physical page', async () => {
    engineState.pageLabels = ['i', 'ii', '1', '2', '3'];
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    const form = pageInput.closest('form') as HTMLFormElement;
    await waitFor(() => expect(pageInput).toHaveValue('i'));
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('(1 of 5)');

    // A printed label wins: "2" is the fourth page.
    fireEvent.change(pageInput, { target: { value: '2' } });
    fireEvent.submit(form);
    expect(pageInput).toHaveAttribute('aria-invalid', 'false');
    expect((await scroller()).scrollTop).toBeCloseTo(3 * (PAGE_PX + GAP_PX), 0);
    expect(pageInput).toHaveValue('2');
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('(4 of 5)');

    // #n is the nth page, shown by its label.
    fireEvent.change(pageInput, { target: { value: '#2' } });
    fireEvent.submit(form);
    expect((await scroller()).scrollTop).toBeCloseTo(PAGE_PX + GAP_PX, 0);
    expect(pageInput).toHaveValue('ii');
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('(2 of 5)');

    fireEvent.change(pageInput, { target: { value: 'iv' } });
    fireEvent.submit(form);
    expect(pageInput).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(pageInput);
    expect(pageInput).toHaveValue('ii');

    // No page is printed 5, and the fifth page is printed 3: reject, do not jump.
    fireEvent.change(pageInput, { target: { value: '5' } });
    fireEvent.submit(form);
    expect(pageInput).toHaveAttribute('aria-invalid', 'true');
    expect((await scroller()).scrollTop).toBeCloseTo(PAGE_PX + GAP_PX, 0);
  });

  it('jumps to the nearest of repeated labels', async () => {
    // Two sections, each numbered from 1.
    engineState.pageLabels = ['1', '2', '1', '2', '3'];
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    const form = pageInput.closest('form') as HTMLFormElement;
    await waitFor(() => expect(pageInput).toHaveValue('1'));

    fireEvent.change(pageInput, { target: { value: '#5' } });
    fireEvent.submit(form);
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('(5 of 5)');
    // From the second section, "1" is that section's first page, not the book's.
    fireEvent.change(pageInput, { target: { value: '1' } });
    fireEvent.submit(form);
    expect((await scroller()).scrollTop).toBeCloseTo(2 * (PAGE_PX + GAP_PX), 0);
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('(3 of 5)');
  });

  it('shows plain page numbers when the labels only repeat them', async () => {
    engineState.pageLabels = ['1', '2', '3', '4', '5'];
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    expect(screen.getByLabelText('Page number')).toHaveValue('1');
    expect(screen.getByTestId('pdf-page-count')).toHaveTextContent('of 5');
    expect(screen.getByTestId('pdf-page-count')).not.toHaveTextContent('(');
  });

  it('shows page progress in a footer, chapter ticks, and the chapter as the toolbar subtitle', async () => {
    window.localStorage.clear();
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    expect(await screen.findByTestId('reader-toolbar-subtitle')).toHaveTextContent('Part One');
    const readout = screen.getByTestId('reader-footer-readout');
    // Part Two starts on page 4.
    expect(readout).toHaveTextContent('2 pages left in chapter');
    fireEvent.click(readout);
    expect(readout).toHaveTextContent('Page 1 of 5');
    fireEvent.click(readout);
    expect(readout).toHaveTextContent('20%');

    const slider = screen.getByRole('slider', { name: 'Reading position' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Page 1 of 5, Part One, 20%');
    const ticks = screen.getAllByTestId('progress-scrubber-tick');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveStyle({ left: '75%' });

    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
    fireEvent.pointerMove(slider, { clientX: 100 });
    expect(screen.getByTestId('progress-scrubber-tooltip')).toHaveTextContent('Part Two · p. 5');
    fireEvent.pointerDown(slider, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 100, button: 0, pointerId: 1 });
    expect(readout).toHaveTextContent('100%');
    expect(screen.getByTestId('reader-toolbar-subtitle')).toHaveTextContent('Part Two');
    const chip = screen.getByTestId('reader-back-chip');
    expect(chip).toHaveTextContent('Back to page 1');
    fireEvent.click(chip);
    expect(readout).toHaveTextContent('20%');
    expect(screen.queryByTestId('reader-back-chip')).not.toBeInTheDocument();
  });

  it('turns pages by edge click, swipe, and keys in single and two-page modes only', async () => {
    window.localStorage.clear();
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    const pane = await scroller();
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, PANE_PX, 600));
    const readout = screen.getByTestId('reader-footer-readout');
    fireEvent.click(readout); // Page N of M
    const edgeClick = (x: number) =>
      fireEvent.click(pane, { clientX: x, clientY: 300, button: 0, detail: 1 });

    // Continuous scroll keeps native scrolling: no zones, no chevrons, Space untouched.
    edgeClick(PANE_PX - 10);
    expect(readout).toHaveTextContent('Page 1 of 5');
    expect(screen.queryByRole('button', { name: 'Next Page' })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(pane, { key: ' ', code: 'Space' })).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    edgeClick(PANE_PX - 10);
    expect(readout).toHaveTextContent('Page 2 of 5');
    edgeClick(10);
    expect(readout).toHaveTextContent('Page 1 of 5');
    edgeClick(PANE_PX / 2);
    expect(readout).toHaveTextContent('Page 1 of 5');
    expect(fireEvent.keyDown(pane, { key: ' ', code: 'Space' })).toBe(false);
    expect(readout).toHaveTextContent('Page 2 of 5');
    fireEvent.keyDown(pane, { key: 'PageUp', code: 'PageUp' });
    expect(readout).toHaveTextContent('Page 1 of 5');
    fireEvent.wheel(pane, { deltaX: 80, deltaY: 0 });
    fireEvent.wheel(pane, { deltaX: 80, deltaY: 0 });
    expect(readout).toHaveTextContent('Page 2 of 5');
    fireEvent.click(screen.getByRole('button', { name: 'Next Page' }));
    expect(readout).toHaveTextContent('Page 3 of 5');

    // Chapters: ⌥↓ to Part Two, End to its last page, Home back to its start.
    fireEvent.keyDown(pane, { key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(readout).toHaveTextContent('Page 4 of 5');
    fireEvent.keyDown(pane, { key: 'End', code: 'End' });
    expect(readout).toHaveTextContent('Page 5 of 5');
    fireEvent.keyDown(pane, { key: 'Home', code: 'Home' });
    expect(readout).toHaveTextContent('Page 4 of 5');
    fireEvent.keyDown(pane, { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    expect(readout).toHaveTextContent('Page 1 of 5');

    // Two pages turn a whole spread.
    fireEvent.click(screen.getByRole('radio', { name: 'Two pages' }));
    edgeClick(PANE_PX - 10);
    expect(readout).toHaveTextContent('Page 3 of 5');
  });

  it('renders nested PDF outlines, jumps to outline destinations, and handles empty outlines', async () => {
    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);

    // ⌥⌘3: Contents, in Preview's mapping.
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true, metaKey: true });
    expect(screen.getByTestId('reader-toc')).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: 'Part One' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    const nested = screen.getByRole('treeitem', { name: 'Blue Box Section' });
    expect(nested).toHaveAttribute('aria-level', '2');
    // Page numbers sit right-aligned beside each title.
    expect(nested).toHaveTextContent('3');

    fireEvent.click(nested);
    expect((await scroller()).scrollTop).toBeCloseTo(2 * (PAGE_PX + GAP_PX), 0);
    expect(screen.getByRole('treeitem', { name: 'Blue Box Section' })).toHaveAttribute(
      'aria-current',
      'location',
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Return to previous location' }));
    expect((await scroller()).scrollTop).toBeCloseTo(0, 0);
    view.unmount();

    // Empty outline state
    engineState.outline = [];
    render(<Harness store={store} documentId={documentId} />);
    await pageElement(0);
    // The sidebar reopens on the tab chosen last time.
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
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
    // Every match is tinted, not just the active one, and the scrubber marks each page.
    await waitFor(() =>
      expect(document.querySelector('[data-annotation-id^="__search_match_"]')).not.toBeNull(),
    );
    expect(screen.getAllByTestId('progress-scrubber-search-mark')).toHaveLength(5);
    // The active match paints once (orange); no inactive tint is stacked on its page.
    expect(
      document.querySelector('[data-page-index="0"] [data-annotation-id^="__search_match_"]'),
    ).toBeNull();
    // Typing leaves the sidebar alone, so the field's list button opens the results.
    expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show search results' }));
    const resultItems = screen.getAllByTestId('search-result-item');
    expect(resultItems).toHaveLength(5);
    // Grouped by page in the sidebar, with the match in bold.
    expect(screen.getAllByTestId('search-result-location')[4]).toHaveTextContent('Page 5');
    expect(resultItems[0]?.querySelector('mark')).toHaveTextContent('First line of page');

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
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Match case/ }));
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('No matches'),
    );

    // Single-page mode: searching from page 1 for a match on page 5 still turns to page 5 (#55).
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(screen.getByLabelText('Page number')).toHaveValue('1');
    fireEvent.click(screen.getByRole('radio', { name: 'Single page' }));
    expect(screen.getByLabelText('Page number')).toHaveValue('1');
    fireEvent.change(searchInput, { target: { value: 'Fox' } });
    await waitFor(() => expect(screen.getByTestId('search-status')).toHaveTextContent('1 of 1'));
    expect(screen.getByLabelText('Page number')).toHaveValue('5');
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

    fireEvent.keyDown(window, { key: '5', code: 'Digit5', altKey: true, metaKey: true });
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
    expect(await screen.findByText(/page this file does not have/)).toHaveAttribute(
      'role',
      'status',
    );

    // Persist across reopen and remove bookmarks.
    first.unmount();
    const reopened = await reopen(backend);
    render(<Harness store={reopened} documentId={documentId} />);
    await pageElement(0);
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
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

    // Pick Green in the markup bar, select text, and add a note from the popover.
    fireEvent.click(screen.getByTestId('markup-toggle'));
    fireEvent.click(screen.getByTestId('markup-color-green'));
    select([node, 0], [node, 10]);
    const popover = await screen.findByTestId('selection-popover');
    // The composer is mounted but inert until Add Note asks for it.
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).not.toBeNull();
    fireEvent.click(within(popover).getByRole('button', { name: 'Add Note' }));
    expect(screen.getByTestId('popover-note-form').closest('[inert]')).toBeNull();
    const noteComposerInput = await screen.findByTestId('popover-note-input');
    fireEvent.change(noteComposerInput, { target: { value: 'Margin note on page 1' } });
    fireEvent.click(screen.getByTestId('popover-note-save'));

    await waitFor(() => expect(store.getState().annotations).toHaveLength(1));
    expect(store.getState().cards).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
    expect(store.getState().annotations[0]).toMatchObject({
      excerptText: 'First line',
      color: '#86efac',
      note: 'Margin note on page 1',
    });

    // A click on the highlight opens the popover in edit mode, here to make it an underline.
    const mark = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-page-index="0"] [data-annotation-id]',
      );
      if (!element) throw new Error('no highlight yet');
      return element;
    });
    // The note shows on the page as a marker where the highlight ends.
    const marker = document.querySelector<HTMLElement>('[data-page-index="0"] [data-note-marker]');
    expect(marker?.dataset.noteMarker).toBe(store.getState().annotations[0]?.id);
    expect(marker?.style.backgroundColor).not.toBe('');
    fireEvent.click(mark);
    const editor = await screen.findByTestId('selection-popover');
    expect(editor).toHaveAttribute('data-popover-mode', 'edit');
    // It opens with the note showing and an Edit button.
    expect(within(editor).getByTestId('popover-note-text')).toHaveTextContent(
      'Margin note on page 1',
    );
    expect(within(editor).getByTestId('popover-note-edit')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Underline' }));
    await waitFor(() => expect(store.getState().annotations[0]?.style).toBe('underline'));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-page-index="0"] [data-annotation-id]')?.dataset
          .annotationStyle,
      ).toBe('underline'),
    );
    fireEvent.keyDown(within(editor).getByRole('button', { name: 'Underline' }), {
      key: 'Escape',
    });
    expect(screen.queryByTestId('selection-popover')).toBeNull();

    // Open annotations panel, edit note & color, jump to annotation, delete, and undo delete.
    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true, metaKey: true });
    const item = await screen.findByTestId('annotation-item');
    expect(item).toHaveTextContent('Page 1');
    expect(item).toHaveTextContent('First line');
    expect(screen.getByTestId('annotation-note-preview')).toHaveTextContent(
      'Margin note on page 1',
    );
    // Grouped under the outline chapter that holds the page.
    expect(await screen.findByTestId('annotation-group')).toHaveTextContent('Part One');

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
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

  it('gives a type a later page adds to the unsupported-annotations notice its full time on screen', async () => {
    const annotations = (subtype: string): PdfPageAnnotations => ({
      links: [],
      embeddedAnnotations: [],
      unsupportedSubtypes: [subtype],
    });
    engineState.pageAnnotations.set(0, annotations('Stamp'));
    engineState.pageAnnotations.set(1, annotations('Sound'));
    let releasePage1 = () => undefined as void;
    engineState.pageAnnotationsGate.set(
      1,
      new Promise<void>((settle) => {
        releasePage1 = settle;
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { store, documentId } = await setup();
      render(<Harness store={store} documentId={documentId} />);
      const notice = () => screen.queryByTestId('pdf-unsupported-annotations-notice');
      await waitFor(() => expect(notice()).toHaveTextContent('Stamp'));
      expect(notice()).not.toHaveTextContent('Sound');

      await act(async () => void vi.advanceTimersByTime(INFO_NOTICE_MS - 1000));
      await act(async () => releasePage1());
      await waitFor(() => expect(notice()).toHaveTextContent('Sound, Stamp'));

      // Past the first type's 6 s, the notice is still up, not fading, for the one
      // just added. Stepped, so each timer's effects run before the next second.
      for (let second = 0; second < 2; second += 1) {
        await act(async () => void vi.advanceTimersByTime(1000));
      }
      expect(notice()).not.toBeNull();
      expect(notice()).not.toHaveAttribute('data-fading');

      await act(async () => void vi.advanceTimersByTime(INFO_NOTICE_MS + NOTICE_FADE_MS));
      await waitFor(() => expect(notice()).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports lazy thumbnails, continuous/single/two-page display modes, view rotation, internal links, and embedded annotations disclosure', async () => {
    engineState.pageAnnotations.set(0, {
      links: [
        {
          id: 'link-0-0',
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
          targetPageIndex: 3,
          targetFraction: 0.25,
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
    // It only informs, so it can be closed and fades by itself (ReaderNotice.test.tsx).
    expect(screen.getByTestId('pdf-unsupported-annotations-notice')).toHaveAttribute(
      'data-tone',
      'info',
    );
    fireEvent.click(
      within(screen.getByTestId('pdf-unsupported-annotations-notice')).getByRole('button', {
        name: 'Close notice',
      }),
    );
    expect(screen.queryByTestId('pdf-unsupported-annotations-notice')).toBeNull();

    // Create a user highlight on Page 1 to verify geometry across rotation and display modes.
    const node = textNode(page0, 0);
    select([node, 0], [node, 10]);
    fireEvent.click(await screen.findByRole('button', { name: 'Yellow highlight' }));
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

    // Internal link on Page 1 navigates to Page 4 (pageIndex 3), partway down it,
    // with a chip that leads back.
    const pageInput = screen.getByLabelText('Page number') as HTMLInputElement;
    fireEvent.click(await screen.findByTestId('pdf-internal-link'));
    expect(pageInput).toHaveValue('4');
    expect((await scroller()).scrollTop).toBeCloseTo(3 * (PAGE_PX + GAP_PX) + 0.25 * PAGE_PX, 0);
    expect(screen.getByTestId('reader-back-chip')).toHaveTextContent('Back to page 1');
    fireEvent.click(screen.getByRole('button', { name: 'Return to previous location' }));
    expect(pageInput).toHaveValue('1');

    // Lazy thumbnails sidebar shows active page and jumps on click.
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true, metaKey: true });
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

  it('releases unmounted page and thumbnail canvas bitmaps and bounds per-document LRU caches', async () => {
    const cache = new Map<number, string>();
    for (let i = 0; i < MAX_CACHED_TEXT_PAGES + 8; i += 1) {
      setBoundedLru(cache, i, `page-${i}`, MAX_CACHED_TEXT_PAGES);
    }
    expect(cache.size).toBe(MAX_CACHED_TEXT_PAGES);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(7)).toBe(false);
    expect(getBoundedLru(cache, 8)).toBe('page-8');
    setBoundedLru(cache, 999, 'page-999', MAX_CACHED_TEXT_PAGES);
    expect(cache.has(8)).toBe(true);
    expect(cache.has(9)).toBe(false);

    const { store, documentId } = await setup();
    const view = render(<Harness store={store} documentId={documentId} />);
    const page0 = await pageElement(0);
    const page0Canvas = page0.querySelector('canvas') as HTMLCanvasElement;
    expect(page0Canvas.width).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    fireEvent.click(screen.getByTestId('navigator-tab-thumbnails'));
    const thumb0 = await screen.findByTestId('pdf-thumbnail-0');
    const thumb0Canvas = thumb0.querySelector('canvas') as HTMLCanvasElement;
    expect(thumb0Canvas.width).toBeGreaterThan(0);

    // Hiding the sidebar (⌥⌘1) unmounts thumbnail canvases and zeroes their backing store.
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true, metaKey: true });
    expect(screen.queryByTestId('navigator-sidebar')).not.toBeInTheDocument();
    expect(thumb0Canvas.width).toBe(0);
    expect(thumb0Canvas.height).toBe(0);

    // Unmounting the viewer zeroes page canvas backing stores and clears text layers.
    view.unmount();
    expect(page0Canvas.width).toBe(0);
    expect(page0Canvas.height).toBe(0);
  });
});
