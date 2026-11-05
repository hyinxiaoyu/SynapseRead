import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PULSE_MS } from '@/features/reader/pulse';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import { createStudySyncStore, selectHighlights } from '@/stores/useStudySyncStore';

import type { EpubLocation, EpubSelection } from './epubEngine';
import { EpubViewer } from './EpubViewer';

// jsdom has no layout for epub.js to render into: this replaces only the engine seam,
// and `pnpm e2e` drives the real one. Everything above that seam here is real.
const engine = vi.hoisted(() => ({
  displayed: [] as (string | undefined)[],
  highlighted: new Map<string, string>(),
  removed: [] as string[],
  pulsing: new Set<string>(),
  selectionCleared: 0,
  destroyed: 0,
  failCfi: null as string | null,
  emitSelection: (() => undefined) as (selection: unknown) => void,
  emitLocation: (() => undefined) as (location: unknown) => void,
  next: vi.fn(async () => undefined),
  previous: vi.fn(async () => undefined),
}));

vi.mock('./epubEngine', () => ({
  openEpubDocument: vi.fn(async () => ({
    async display(target?: string) {
      if (target && target === engine.failCfi) throw new Error('no such location');
      engine.displayed.push(target);
    },
    next: engine.next,
    previous: engine.previous,
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
    engine.displayed = [];
    engine.highlighted = new Map();
    engine.removed = [];
    engine.pulsing = new Set();
    engine.selectionCleared = 0;
    engine.destroyed = 0;
    engine.failCfi = null;
    engine.next.mockClear();
    engine.previous.mockClear();
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

  it('moves through the book with its controls', async () => {
    const { store, documentId } = await setup();
    render(<Harness store={store} documentId={documentId} />);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(engine.next).toHaveBeenCalledOnce();
    expect(engine.previous).toHaveBeenCalledOnce();
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
