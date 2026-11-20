import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { FileDropEvent, StudyBackend } from '@/lib/backend/types';
import {
  type Annotation,
  DEFAULT_PDF_LAYOUT,
  type PdfLayout,
  type ReaderSelection,
  type StudyDocument,
  type TxtAnchor,
} from '@/types/domain';

import {
  createStudySyncStore,
  DEFAULT_NOTEBOOK_TITLE,
  nextNodePosition,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
  selectRecentDocuments,
  selectReopenableDocumentId,
} from './useStudySyncStore';

const pdfAnchor = { format: 'pdf', pageIndex: 2, rects: [{ x: 0, y: 0, width: 0.5, height: 0.1 }] };
const txtAnchor: TxtAnchor = { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 };

describe('useStudySyncStore', () => {
  let backend: StudyBackend;
  let store: ReturnType<typeof createStudySyncStore>;

  const state = () => store.getState();

  /** Opens the next document offered by the memory backend's picker. */
  const openDocument = async () => {
    await state().openDocument();
    return state().activeDocumentId as string;
  };

  const select = (documentId: string, text = 'quoted text'): ReaderSelection => {
    const selection: ReaderSelection = {
      documentId,
      anchor: pdfAnchor as ReaderSelection['anchor'],
      text,
      imagePng: null,
    };
    state().setSelection(selection);
    return selection;
  };

  beforeEach(async () => {
    backend = createMemoryBackend({
      library: Object.fromEntries(
        ['a.pdf', 'b.epub', 'c.txt', 'd.md'].map((name) => [
          `/test/${name}`,
          new TextEncoder().encode(`content:${name}`),
        ]),
      ),
    });
    store = createStudySyncStore(backend);
    await state().initialize();
  });

  describe('initialize', () => {
    it('creates a default notebook on first run', () => {
      expect(state().status).toBe('ready');
      expect(state().notebook?.title).toBe(DEFAULT_NOTEBOOK_TITLE);
    });

    it('reopens the existing notebook with its graph', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      const notebookId = state().notebook?.id;

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();

      expect(reopened.getState().notebook?.id).toBe(notebookId);
      expect(reopened.getState().nodes).toHaveLength(1);
      expect(reopened.getState().documents).toHaveLength(1);
    });

    it('reports failures', async () => {
      const failing = createMemoryBackend();
      vi.spyOn(failing, 'listDocuments').mockRejectedValue({ code: 'database', message: 'locked' });
      const failed = createStudySyncStore(failing);
      await failed.getState().initialize();
      expect(failed.getState().status).toBe('error');
      expect(failed.getState().error).toBe('locked');
    });
  });

  describe('Reader -> MindMap', () => {
    it('turns a selection into annotation, card and node, and clears it', async () => {
      const documentId = await openDocument();
      select(documentId);

      await state().excerptSelection();

      const { annotations, cards, nodes, selection, selectedNodeId } = state();
      expect(annotations).toHaveLength(1);
      expect(annotations[0]?.anchor).toEqual(pdfAnchor);
      expect(cards[0]?.annotationIds).toEqual([annotations[0]?.id]);
      expect(nodes[0]?.cardId).toBe(cards[0]?.id);
      expect(selection).toBeNull();
      expect(selectedNodeId).toBe(nodes[0]?.id);
    });

    it('exposes the new annotation as a highlight for its document only', async () => {
      const documentId = await openDocument();
      const otherId = await openDocument();
      state().activateDocument(documentId);
      select(documentId);
      await state().excerptSelection();

      expect(selectHighlights(state().annotations, documentId)).toEqual([
        {
          annotationId: state().annotations[0]?.id,
          anchor: pdfAnchor,
          color: state().annotations[0]?.color,
          style: 'highlight',
          hasNote: false,
        },
      ]);
      expect(selectHighlights(state().annotations, otherId)).toEqual([]);
    });

    it('marks highlights that carry a note, keeping line breaks and ignoring blank notes', async () => {
      const documentId = await openDocument();
      select(documentId, 'noted text');
      const created = await state().createAnnotationFromSelection({
        note: 'first line\nsecond line',
      });
      expect(created?.note).toBe('first line\nsecond line');
      expect(selectHighlights(state().annotations, documentId)[0]?.hasNote).toBe(true);

      await state().updateAnnotation(created?.id as string, { note: '   ', color: null });
      expect(selectHighlights(state().annotations, documentId)[0]?.hasNote).toBe(false);
    });

    it('nests under a card the reader selected, with a connecting edge', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      const parentId = state().nodes[0]?.id as string;
      state().selectNode(parentId);

      select(documentId, 'second');
      await state().excerptSelection();

      const child = state().nodes[1];
      expect(child?.parentNodeId).toBe(parentId);
      expect(state().edges).toEqual([
        expect.objectContaining({ sourceNodeId: parentId, targetNodeId: child?.id }),
      ]);
      // The new card is selected so it can be found; the reader's choice stays the target.
      expect(state().selectedNodeId).toBe(child?.id);
      expect(state().nestingTargetNodeId).toBe(parentId);
    });

    it('keeps consecutive excerpts as separate roots when the canvas is untouched (#96)', async () => {
      const documentId = await openDocument();
      for (const text of ['one', 'two', 'three']) {
        select(documentId, text);
        await state().excerptSelection();
      }

      expect(state().nodes).toHaveLength(3);
      expect(state().nodes.map((node) => node.parentNodeId)).toEqual([null, null, null]);
      expect(state().edges).toEqual([]);
      expect(state().selectedNodeId).toBe(state().nodes[2]?.id);
      expect(state().nestingTargetNodeId).toBeNull();

      // The memory backend agrees: nothing was linked behind the store's back.
      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      expect(reopened.getState().edges).toEqual([]);
      expect(reopened.getState().nodes.every((node) => node.parentNodeId === null)).toBe(true);
    });

    it('nests each excerpt under the chosen card as siblings, not a chain', async () => {
      const documentId = await openDocument();
      select(documentId, 'topic');
      await state().excerptSelection();
      const parentId = state().nodes[0]?.id as string;
      state().selectNode(parentId);

      for (const text of ['first', 'second']) {
        select(documentId, text);
        await state().excerptSelection();
      }

      const [, first, second] = state().nodes;
      expect(first?.parentNodeId).toBe(parentId);
      expect(second?.parentNodeId).toBe(parentId);
      expect(second?.posY).not.toBe(first?.posY);
      expect(state().edges.map((edge) => edge.sourceNodeId)).toEqual([parentId, parentId]);
    });

    it('creates a floating root once the reader clears the canvas selection', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      state().selectNode(state().nodes[0]?.id as string);
      state().selectNode(null);
      expect(state().nestingTargetNodeId).toBeNull();

      select(documentId, 'second');
      await state().excerptSelection();
      expect(state().nodes[1]?.parentNodeId).toBeNull();
      expect(state().edges).toEqual([]);
    });

    it('asks the canvas to reveal each new card, without making it the nesting target', async () => {
      const documentId = await openDocument();
      const beforeExcerptNonce = state().excerptNonce;
      select(documentId);
      await state().excerptSelection();
      const first = state().revealRequest;
      expect(first).toEqual({ nonce: expect.any(Number), nodeId: state().nodes[0]?.id });
      expect(state().excerptNonce).toBe(beforeExcerptNonce + 1);

      select(documentId, 'second');
      await state().excerptSelection();
      const second = state().revealRequest;
      expect(second?.nodeId).toBe(state().nodes[1]?.id);
      expect(second?.nonce).not.toBe(first?.nonce);
      expect(state().excerptNonce).toBe(beforeExcerptNonce + 2);

      // A stale completion leaves the newer request pending.
      state().completeReveal(first?.nonce as number);
      expect(state().revealRequest).toBe(second);
      state().completeReveal(second?.nonce as number);
      expect(state().revealRequest).toBeNull();

      // Revealing an existing card is not a new excerpt.
      state().revealNode(state().nodes[0]?.id as string);
      expect(state().selectedNodeId).toBe(state().nodes[0]?.id);
      expect(state().nestingTargetNodeId).toBeNull();
      expect(state().revealRequest?.nodeId).toBe(state().nodes[0]?.id);
      expect(state().excerptNonce).toBe(beforeExcerptNonce + 2);
    });

    it('does nothing without a selection', async () => {
      const spy = vi.spyOn(backend, 'createExcerpt');
      await state().excerptSelection();
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores a double-click while the write is in flight', async () => {
      const documentId = await openDocument();
      select(documentId);
      const spy = vi.spyOn(backend, 'createExcerpt');
      await Promise.all([state().excerptSelection(), state().excerptSelection()]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(state().nodes).toHaveLength(1);
    });

    it('keeps a selection made while the write was in flight', async () => {
      const documentId = await openDocument();
      select(documentId, 'first');
      const pending = state().excerptSelection();
      const newer = select(documentId, 'newer');
      await pending;
      expect(state().selection).toBe(newer);
    });

    it('keeps the selection and reports the error when the write fails', async () => {
      const documentId = await openDocument();
      const selection = select(documentId);
      vi.spyOn(backend, 'createExcerpt').mockRejectedValue({ code: 'io', message: 'disk full' });

      await state().excerptSelection();

      expect(state().selection).toBe(selection);
      expect(state().nodes).toEqual([]);
      expect(state().error).toBe('disk full');
      expect(state().isExcerpting).toBe(false);
      expect(state().revealRequest).toBeNull();
    });
  });

  describe('MindMap -> Reader', () => {
    const excerptIn = async (documentId: string) => {
      select(documentId);
      await state().excerptSelection();
      return state().nodes.at(-1)?.id as string;
    };

    it('publishes a jump carrying the anchor', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);

      state().jumpToNode(nodeId);

      expect(state().jumpRequest).toMatchObject({
        documentId,
        annotationId: state().annotations[0]?.id,
        anchor: pdfAnchor,
      });
    });

    it('activates the source document', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      await openDocument();
      expect(state().activeDocumentId).not.toBe(documentId);

      state().jumpToNode(nodeId);

      expect(state().activeDocumentId).toBe(documentId);
    });

    it('reopens a closed source document', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      state().closeDocument(documentId);
      expect(state().openDocumentIds).toEqual([]);

      state().jumpToNode(nodeId);

      expect(state().openDocumentIds).toEqual([documentId]);
      expect(state().activeDocumentId).toBe(documentId);
    });

    it('fires again when jumping twice to the same anchor', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      state().jumpToNode(nodeId);
      const first = state().jumpRequest?.nonce;
      state().jumpToNode(nodeId);
      expect(state().jumpRequest?.nonce).not.toBe(first);
    });

    it('does not let a stale completion clear a newer jump', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      state().jumpToNode(nodeId);
      const stale = state().jumpRequest?.nonce as number;
      state().jumpToNode(nodeId);

      state().completeJump(stale);
      expect(state().jumpRequest).not.toBeNull();

      state().completeJump(state().jumpRequest?.nonce as number);
      expect(state().jumpRequest).toBeNull();
    });

    it('can target a specific annotation of a merged card', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      const annotationId = state().annotations[0]?.id as string;
      state().jumpToNode(nodeId, annotationId);
      expect(state().jumpRequest?.annotationId).toBe(annotationId);
    });

    it('ignores unknown nodes', () => {
      state().jumpToNode('missing');
      expect(state().jumpRequest).toBeNull();
    });

    it('drops the pending jump when its document closes', async () => {
      const documentId = await openDocument();
      const nodeId = await excerptIn(documentId);
      state().jumpToNode(nodeId);
      state().closeDocument(documentId);
      expect(state().jumpRequest).toBeNull();
    });
  });

  describe('tabs', () => {
    it('does not duplicate a tab when the same file is opened again', async () => {
      const single = createStudySyncStore(
        createMemoryBackend({ library: { '/preview/a.txt': new Uint8Array() } }),
      );
      await single.getState().initialize();
      await single.getState().openDocument();
      await single.getState().openDocument();
      expect(single.getState().openDocumentIds).toHaveLength(1);
      expect(single.getState().documents).toHaveLength(1);
    });

    it('leaves state alone when the picker is cancelled', async () => {
      vi.spyOn(backend, 'pickDocument').mockResolvedValue(null);
      await state().openDocument();
      expect(state().openDocumentIds).toEqual([]);
      expect(state().error).toBeNull();
    });

    it('activates a neighbour when the active tab closes', async () => {
      const first = await openDocument();
      const second = await openDocument();
      const third = await openDocument();
      state().activateDocument(second);

      state().closeDocument(second);
      expect(state().activeDocumentId).toBe(third);

      state().closeDocument(third);
      expect(state().activeDocumentId).toBe(first);

      state().closeDocument(first);
      expect(state().activeDocumentId).toBeNull();
    });

    it('clears a selection belonging to the document left behind', async () => {
      const first = await openDocument();
      await openDocument();
      state().activateDocument(first);
      select(first);
      state().closeDocument(first);
      expect(state().selection).toBeNull();
    });

    it('opens dropped files, activates the latest one, and avoids duplicate tabs', async () => {
      const first = new File(['hello'], 'first.txt', { type: 'text/plain' });
      const second = new File(['world'], 'second.md', { type: 'text/markdown' });

      await state().dropFiles([first, second]);
      expect(state().documents.map((d) => d.title)).toEqual(['first', 'second']);
      const [firstId, secondId] = state().openDocumentIds;
      expect(state().openDocumentIds).toHaveLength(2);
      expect(state().activeDocumentId).toBe(secondId);

      await state().dropFiles([first]);
      expect(state().openDocumentIds).toEqual([firstId, secondId]);
      expect(state().activeDocumentId).toBe(firstId);
    });

    it('reports an error when a dropped file has an unsupported extension', async () => {
      const valid = new File(['hello'], 'notes.txt', { type: 'text/plain' });
      const invalid = new File(['archive'], 'archive.zip', { type: 'application/zip' });

      await state().dropFiles([valid, invalid]);

      expect(state().documents.map((d) => d.title)).toEqual(['notes']);
      expect(state().openDocumentIds).toHaveLength(1);
      expect(state().error).toMatch(/unsupported document format: zip/);
    });

    it('tracks native window drag state and opens documents from onFileDrop events', async () => {
      let emitDrop: ((event: FileDropEvent) => void) | undefined;
      const customBackend: StudyBackend = {
        ...backend,
        onFileDrop(listener) {
          emitDrop = listener;
          return () => undefined;
        },
      };
      const nativeStore = createStudySyncStore(customBackend);
      await nativeStore.getState().initialize();

      emitDrop?.({ type: 'enter' });
      expect(nativeStore.getState().isDraggingFile).toBe(true);

      emitDrop?.({ type: 'leave' });
      expect(nativeStore.getState().isDraggingFile).toBe(false);

      emitDrop?.({ type: 'enter' });
      emitDrop?.({
        type: 'drop',
        documents: [
          {
            id: 'doc-native-1',
            title: 'native-book',
            filePath: '/native/native-book.pdf',
            fileHash: 'hash-1',
            format: 'pdf',
            encoding: 'utf-8',
            lastCursorAnchor: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        error: null,
      });

      expect(nativeStore.getState().isDraggingFile).toBe(false);
      expect(nativeStore.getState().activeDocumentId).toBe('doc-native-1');
      expect(nativeStore.getState().openDocumentIds).toEqual(['doc-native-1']);
    });

    it('reopens the most recently closed tab first, and only once', async () => {
      const first = await openDocument();
      const second = await openDocument();
      state().closeDocument(first);
      state().closeDocument(second);
      expect(state().closedDocumentIds).toEqual([first, second]);

      await state().reopenClosedDocument();
      expect(state().openDocumentIds).toEqual([second]);
      expect(state().activeDocumentId).toBe(second);
      expect(state().closedDocumentIds).toEqual([first]);

      await state().reopenClosedDocument();
      expect(state().openDocumentIds).toEqual([second, first]);
      expect(state().closedDocumentIds).toEqual([]);

      // Nothing is closed any more: the command has nothing to do.
      await state().reopenClosedDocument();
      expect(state().openDocumentIds).toEqual([second, first]);
      expect(state().activeDocumentId).toBe(first);
    });

    it('keeps the closed-tab history bounded to the last 20 tabs', async () => {
      const files = Array.from(
        { length: 21 },
        (_, index) => new File([`text-${index}`], `tab-${index}.txt`, { type: 'text/plain' }),
      );
      await state().dropFiles(files);
      const ids = state().openDocumentIds;
      expect(ids).toHaveLength(21);

      for (const id of ids) state().closeDocument(id);
      expect(state().closedDocumentIds).toHaveLength(20);
      // The oldest close fell off; the newest is what ⇧⌘T reopens first.
      expect(state().closedDocumentIds).not.toContain(ids[0]);
      expect(state().closedDocumentIds.at(-1)).toBe(ids.at(-1));
    });

    it('forgets a closed tab once Open or Recent brings it back', async () => {
      const first = await openDocument();
      await openDocument();
      state().closeDocument(first);
      expect(state().closedDocumentIds).toEqual([first]);

      await state().reopenRecentDocument(first);
      expect(state().closedDocumentIds).toEqual([]);
      expect(state().openDocumentIds).toContain(first);
    });

    it('names the tab a Reopen Closed Tab command would bring back', async () => {
      const first = await openDocument();
      expect(
        selectReopenableDocumentId(
          state().closedDocumentIds,
          state().openDocumentIds,
          state().documents,
        ),
      ).toBeNull();

      state().closeDocument(first);
      expect(
        selectReopenableDocumentId(
          state().closedDocumentIds,
          state().openDocumentIds,
          state().documents,
        ),
      ).toBe(first);

      await state().reopenClosedDocument();
      expect(
        selectReopenableDocumentId(
          state().closedDocumentIds,
          state().openDocumentIds,
          state().documents,
        ),
      ).toBeNull();
    });
  });

  describe('graph edits', () => {
    const twoNodes = async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      state().selectNode(null);
      select(documentId);
      await state().excerptSelection();
      return [state().nodes[0]?.id as string, state().nodes[1]?.id as string] as const;
    };

    it('persists a drag only when committed', async () => {
      const [a] = await twoNodes();
      const spy = vi.spyOn(backend, 'updateNodeLayout');

      state().dragNode(a, 100, 200);
      expect(state().nodes[0]).toMatchObject({ posX: 100, posY: 200 });
      expect(spy).not.toHaveBeenCalled();

      await state().commitNodeLayout(a);
      expect(spy).toHaveBeenCalledWith(a, { posX: 100, posY: 200, isCollapsed: false });
    });

    it('connects and removes cross-links', async () => {
      const [a, b] = await twoNodes();
      await state().connectNodes(a, b);
      const edge = state().edges[0];
      expect(edge).toMatchObject({ sourceNodeId: a, targetNodeId: b });

      await state().removeEdge(edge?.id as string);
      expect(state().edges).toEqual([]);
    });

    it('reports a rejected link without adding an edge', async () => {
      const [a] = await twoNodes();
      await state().connectNodes(a, a);
      expect(state().edges).toEqual([]);
      expect(state().error).toMatch(/itself/);
    });

    it('restores an edge when deleting it fails', async () => {
      const [a, b] = await twoNodes();
      await state().connectNodes(a, b);
      const edge = state().edges[0];
      vi.spyOn(backend, 'deleteEdge').mockRejectedValue(new Error('nope'));

      await state().removeEdge(edge?.id as string);

      expect(state().edges).toEqual([edge]);
      expect(state().error).toBe('nope');
    });

    it('applies card patches returned by the backend', async () => {
      await twoNodes();
      const cardId = state().cards[0]?.id as string;
      await state().updateCard(cardId, { title: 'Renamed', markdownNotes: null, tags: ['x'] });
      expect(state().cards[0]).toMatchObject({ title: 'Renamed', tags: ['x'] });
    });

    it('saves the viewport', async () => {
      const spy = vi.spyOn(backend, 'saveNotebookViewport');
      const viewport = { x: 1, y: 2, zoom: 0.5 };
      await state().saveViewport(viewport);
      expect(state().notebook?.viewport).toEqual(viewport);
      expect(spy).toHaveBeenCalledWith(state().notebook?.id, viewport);
    });
  });

  describe('cursor', () => {
    it('records the last reading position', async () => {
      const documentId = await openDocument();
      state().reportCursor(documentId, txtAnchor);
      expect(state().documents[0]?.lastCursorAnchor).toEqual(txtAnchor);
      expect((await backend.listDocuments())[0]?.lastCursorAnchor).toEqual(txtAnchor);
    });

    it('keeps how far in the reader is, and forgets it for a position without one', async () => {
      const documentId = await openDocument();
      state().reportCursor(documentId, txtAnchor, 0.42);
      expect(state().documents[0]?.lastProgress).toBe(0.42);
      await vi.waitFor(async () =>
        expect((await backend.listDocuments())[0]?.lastProgress).toBe(0.42),
      );

      state().reportCursor(documentId, txtAnchor);
      expect(state().documents[0]?.lastProgress).toBeNull();
      await vi.waitFor(async () =>
        expect((await backend.listDocuments())[0]?.lastProgress).toBeNull(),
      );

      // The memory backend refuses what core refuses.
      await expect(backend.updateDocumentCursor(documentId, txtAnchor, 1.5)).rejects.toMatchObject({
        code: 'invalid_progress',
      });
      await expect(
        backend.updateDocumentCursor(documentId, txtAnchor, Number.NaN),
      ).rejects.toMatchObject({ code: 'invalid_progress' });
    });
  });

  describe('reading preferences', () => {
    it('persists reading preferences and rolls back on validation failure', async () => {
      await state().updateReadingPreferences({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 120,
        margins: 'wide',
        pageWidth: 'full',
        justify: false,
        dimImages: true,
        epubReadingMode: 'paged',
        pageTransition: 'fade',
        wheelSensitivity: 5,
      });
      expect(state().readingPreferences).toMatchObject({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 120,
        margins: 'wide',
        pageWidth: 'full',
        justify: false,
        dimImages: true,
        epubReadingMode: 'paged',
        pageTransition: 'fade',
        wheelSensitivity: 5,
      });

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      expect(reopened.getState().readingPreferences).toMatchObject({
        theme: 'sepia',
        fontFamily: 'sf-pro',
        fontSize: 120,
        margins: 'wide',
        pageWidth: 'full',
        justify: false,
        dimImages: true,
        epubReadingMode: 'paged',
        pageTransition: 'fade',
        wheelSensitivity: 5,
      });

      await state().updateReadingPreferences({ pageWidth: 'invalid' as 'full' });
      expect(state().readingPreferences.pageWidth).toBe('full');
      expect(state().error).toMatch(/pageWidth/);

      await state().updateReadingPreferences({ fontSize: 300 });
      expect(state().readingPreferences.fontSize).toBe(120);
      expect(state().error).toMatch(/fontSize/);

      for (const invalidSensitivity of [0, 6]) {
        await state().updateReadingPreferences({ wheelSensitivity: invalidSensitivity });
        expect(state().readingPreferences.wheelSensitivity).toBe(5);
        expect(state().error).toMatch(/wheelSensitivity/);
      }

      // The newer modes are accepted by the backend's validation list too.
      for (const pageTransition of ['curl', 'stack'] as const) {
        await state().updateReadingPreferences({ pageTransition });
        expect(state().readingPreferences.pageTransition).toBe(pageTransition);
        expect((await backend.getReadingPreferences()).pageTransition).toBe(pageTransition);
      }

      // Rapid consecutive updates (e.g. font size then page width) serialize cleanly
      // so an earlier in-flight write never resets a later choice.
      const firstWrite = state().updateReadingPreferences({ fontSize: 170 });
      const secondWrite = state().updateReadingPreferences({ pageWidth: 'standard' });
      await Promise.all([firstWrite, secondWrite]);
      expect(state().readingPreferences).toMatchObject({
        fontSize: 170,
        pageWidth: 'standard',
      });
      expect(await backend.getReadingPreferences()).toMatchObject({
        fontSize: 170,
        pageWidth: 'standard',
      });
    });
  });

  describe('bookmarks', () => {
    it('adds, deduplicates, toggles, jumps to, and persists bookmarks without creating cards or annotations', async () => {
      const documentId = await openDocument();
      const firstAnchor = {
        format: 'pdf' as const,
        pageIndex: 2,
        rects: [{ x: 0, y: 0.1, width: 1, height: 0.01 }],
      };
      const secondAnchor = {
        format: 'pdf' as const,
        pageIndex: 4,
        rects: [{ x: 0, y: 0.2, width: 1, height: 0.01 }],
      };

      const created = await state().addBookmark(documentId, firstAnchor, 'Page 3 · Introduction');
      expect(created).toMatchObject({
        documentId,
        anchor: firstAnchor,
        label: 'Page 3 · Introduction',
      });
      expect(selectBookmarks(state().bookmarks, documentId)).toHaveLength(1);
      expect(state().annotations).toEqual([]);
      expect(state().cards).toEqual([]);
      expect(state().nodes).toEqual([]);

      // Adding a bookmark at the same location updates the existing entry in place.
      const deduped = await state().addBookmark(documentId, firstAnchor, 'Page 3 · Updated');
      expect(deduped?.id).toBe(created?.id);
      expect(selectBookmarks(state().bookmarks, documentId)).toEqual([
        expect.objectContaining({ id: created?.id, label: 'Page 3 · Updated' }),
      ]);

      await state().toggleBookmark(documentId, secondAnchor, 'Page 5');
      expect(selectBookmarks(state().bookmarks, documentId)).toHaveLength(2);

      // Jumping to a bookmark activates the document and emits a jumpRequest.
      state().jumpToBookmark(created?.id as string);
      expect(state().jumpRequest).toMatchObject({
        documentId,
        annotationId: created?.id as string,
        anchor: firstAnchor,
      });

      // Bookmarks persist across store re-initialization.
      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      expect(selectBookmarks(reopened.getState().bookmarks, documentId)).toHaveLength(2);

      // Toggling an existing bookmark removes it.
      await state().toggleBookmark(documentId, firstAnchor);
      expect(selectBookmarks(state().bookmarks, documentId)).toHaveLength(1);
    });

    it('restores a bookmark when deleting it fails', async () => {
      const documentId = await openDocument();
      const created = await state().addBookmark(
        documentId,
        pdfAnchor as ReaderSelection['anchor'],
        'Page 3',
      );
      vi.spyOn(backend, 'deleteBookmark').mockRejectedValue(new Error('delete failed'));

      await state().removeBookmark(created?.id as string);

      expect(selectBookmarks(state().bookmarks, documentId)).toHaveLength(1);
      expect(state().error).toBe('delete failed');
    });
  });

  describe('independent annotations', () => {
    it('creates highlights and notes without MindMap cards/nodes, edits note/color, deletes with shared-card preservation, and undoes deletion', async () => {
      const documentId = await openDocument();
      select(documentId, 'independent highlight text');

      const created = await state().createAnnotationFromSelection({
        color: '#86efac',
        note: 'Key definition',
      });
      expect(created).toMatchObject({
        documentId,
        excerptText: 'independent highlight text',
        color: '#86efac',
        note: 'Key definition',
      });
      expect(selectDocumentAnnotations(state().annotations, documentId)).toHaveLength(1);
      expect(state().cards).toEqual([]);
      expect(state().nodes).toEqual([]);
      expect(state().selection).toBeNull();

      await state().updateAnnotation(created?.id as string, {
        color: '#93c5fd',
        note: 'Updated note text',
      });
      expect(selectDocumentAnnotations(state().annotations, documentId)[0]).toMatchObject({
        color: '#93c5fd',
        note: 'Updated note text',
      });

      state().jumpToAnnotation(created?.id as string);
      expect(state().jumpRequest).toMatchObject({
        documentId,
        annotationId: created?.id as string,
        anchor: pdfAnchor,
      });

      // Excerpt a second selection into the MindMap, then delete its shared annotation:
      // the card and MindMap node must remain intact while the annotation is removed.
      select(documentId, 'shared card excerpt');
      await state().excerptSelection();
      expect(state().cards).toHaveLength(1);
      expect(state().nodes).toHaveLength(1);
      const sharedAnnotationId = state().cards[0]?.annotationIds[0] as string;

      await state().removeAnnotation(sharedAnnotationId);
      expect(state().annotations.some((item) => item.id === sharedAnnotationId)).toBe(false);
      expect(state().cards).toHaveLength(1);
      expect(state().cards[0]?.annotationIds).toEqual([]);
      expect(state().nodes).toHaveLength(1);
      expect(state().deletedAnnotationHistory).toHaveLength(1);

      // Delete the independent annotation and undo both deletions in the current session.
      await state().removeAnnotation(created?.id as string);
      expect(selectDocumentAnnotations(state().annotations, documentId)).toHaveLength(0);

      const restoredIndependent = await state().undoRemoveAnnotation();
      expect(restoredIndependent).toMatchObject({
        documentId,
        excerptText: 'independent highlight text',
        color: '#93c5fd',
        note: 'Updated note text',
      });
      expect(selectDocumentAnnotations(state().annotations, documentId)).toHaveLength(1);
    });

    // #97: Undo must give back the card's source, not a new, unlinked highlight.
    it('relinks a card to its source when a deleted excerpt is undone', async () => {
      const documentId = await openDocument();
      select(documentId, 'card source');
      await state().excerptSelection();
      const card = state().cards[0];
      const node = state().nodes[0];
      const annotationId = card?.annotationIds[0] as string;

      await state().removeAnnotation(annotationId);
      expect(state().cards[0]?.annotationIds).toEqual([]);

      const restored = await state().undoRemoveAnnotation();
      expect(restored?.id).toBe(annotationId);
      expect(state().annotations.map((annotation) => annotation.id)).toEqual([annotationId]);
      expect(state().cards).toEqual([card]);
      expect(state().deletedAnnotationHistory).toEqual([]);

      state().jumpToNode(node?.id as string);
      expect(state().jumpRequest).toMatchObject({ documentId, annotationId, anchor: pdfAnchor });

      // The link is in the backend too, not just in memory.
      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      expect(reopened.getState().cards[0]?.annotationIds).toEqual([annotationId]);
      expect(reopened.getState().annotations.map((annotation) => annotation.id)).toEqual([
        annotationId,
      ]);
    });

    it('restores an area capture with its image', async () => {
      const documentId = await openDocument();
      state().setSelection({
        documentId,
        anchor: pdfAnchor as ReaderSelection['anchor'],
        text: '',
        imagePng: 'iVBORw0KGgo=',
      });
      await state().excerptSelection();
      const annotation = state().annotations[0] as Annotation;
      const image = await state().captureUrl(annotation.id);
      expect(image).not.toBeNull();

      await state().removeAnnotation(annotation.id);
      await state().undoRemoveAnnotation();

      expect(state().annotations).toEqual([annotation]);
      expect(state().cards[0]?.annotationIds).toEqual([annotation.id]);
      expect(await state().captureUrl(annotation.id)).toBe(image);
    });

    it('waits for a delete to reach the backend before undoing it', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      const annotationId = state().annotations[0]?.id as string;

      let finishDelete = () => {};
      const deleteAnnotation = backend.deleteAnnotation.bind(backend);
      vi.spyOn(backend, 'deleteAnnotation').mockImplementation(
        (id) =>
          new Promise<void>((resolve, reject) => {
            finishDelete = () => void deleteAnnotation(id).then(resolve, reject);
          }),
      );
      const restoreAnnotation = vi.spyOn(backend, 'restoreAnnotation');

      const removing = state().removeAnnotation(annotationId);
      const undoing = state().undoRemoveAnnotation();
      await Promise.resolve();
      expect(restoreAnnotation).not.toHaveBeenCalled();

      finishDelete();
      await Promise.all([removing, undoing]);
      expect(restoreAnnotation).toHaveBeenCalledWith(annotationId);
      expect(state().cards[0]?.annotationIds).toEqual([annotationId]);
      expect(state().error).toBeNull();
    });

    it('does not restore a delete that failed and was rolled back', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      const annotationId = state().annotations[0]?.id as string;
      vi.spyOn(backend, 'deleteAnnotation').mockRejectedValueOnce(new Error('disk full'));
      const restoreAnnotation = vi.spyOn(backend, 'restoreAnnotation');

      const removing = state().removeAnnotation(annotationId);
      const undone = await state().undoRemoveAnnotation();
      await removing;

      expect(undone).toBeNull();
      expect(restoreAnnotation).not.toHaveBeenCalled();
      expect(state().annotations.map((annotation) => annotation.id)).toEqual([annotationId]);
      expect(state().cards[0]?.annotationIds).toEqual([annotationId]);
    });

    it('keeps restored card links when an in-flight card edit finishes after Undo', async () => {
      const documentId = await openDocument();
      select(documentId, 'card source');
      await state().excerptSelection();
      const cardId = state().cards[0]?.id as string;
      const annotationId = state().cards[0]?.annotationIds[0] as string;

      await state().removeAnnotation(annotationId);
      expect(state().cards[0]?.annotationIds).toEqual([]);

      let finishCardUpdate = () => {};
      const realUpdateCard = backend.updateCard.bind(backend);
      vi.spyOn(backend, 'updateCard').mockImplementation(
        (id, patch) =>
          new Promise((resolve, reject) => {
            // Execute against backend now (while annotation is still soft-deleted so the
            // returned card has `annotationIds: []`), then delay delivery until after Undo.
            const pending = realUpdateCard(id, patch);
            finishCardUpdate = () => void pending.then(resolve, reject);
          }),
      );

      const updating = state().updateCard(cardId, {
        title: 'Renamed while deleted',
        markdownNotes: null,
        tags: null,
      });
      await state().undoRemoveAnnotation();
      expect(state().cards[0]?.annotationIds).toEqual([annotationId]);

      finishCardUpdate();
      await updating;
      expect(state().cards[0]).toMatchObject({
        id: cardId,
        title: 'Renamed while deleted',
        annotationIds: [annotationId],
      });
    });

    it('preserves concurrent card edits when a failed delete rolls back', async () => {
      const documentId = await openDocument();
      select(documentId, 'card source');
      await state().excerptSelection();
      const cardId = state().cards[0]?.id as string;
      const annotationId = state().cards[0]?.annotationIds[0] as string;

      let rejectDelete: (error: Error) => void = () => {};
      vi.spyOn(backend, 'deleteAnnotation').mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDelete = reject;
          }),
      );

      const removing = state().removeAnnotation(annotationId);
      await state().updateCard(cardId, {
        title: 'Edited during delete',
        markdownNotes: null,
        tags: null,
      });
      rejectDelete(new Error('disk full'));
      await removing;

      expect(state().cards[0]).toMatchObject({
        id: cardId,
        title: 'Edited during delete',
        annotationIds: [annotationId],
      });
    });
  });

  describe('recent documents and workspace session restoration', () => {
    it('orders recent documents by lastOpenedAt and reopens closed recent documents', async () => {
      const firstId = await openDocument();
      const secondId = await openDocument();
      expect(state().openDocumentIds).toEqual([firstId, secondId]);
      expect(state().activeDocumentId).toBe(secondId);

      // Record cursor on first document and close both tabs.
      state().reportCursor(firstId, txtAnchor);
      state().closeDocument(firstId);
      state().closeDocument(secondId);
      expect(state().openDocumentIds).toEqual([]);
      expect(state().activeDocumentId).toBeNull();

      // Reopen first document from the recent list: it moves to the top of recent documents and preserves cursor.
      await state().reopenRecentDocument(firstId);
      expect(state().openDocumentIds).toEqual([firstId]);
      expect(state().activeDocumentId).toBe(firstId);
      const recent = selectRecentDocuments(state().documents);
      expect(recent[0]?.id).toBe(firstId);
      expect(recent[0]?.lastCursorAnchor).toEqual(txtAnchor);
      expect(recent[0]?.lastOpenedAt).toBeTruthy();
    });

    it('restores open tabs, active document, and reading preferences on restart while ignoring unknown document ids', async () => {
      const firstId = await openDocument();
      const secondId = await openDocument();
      state().activateDocument(firstId);
      await state().updateReadingPreferences({
        theme: 'dark',
        fontSize: 130,
      });

      // Inject an unknown document id into the saved session to verify defensive filtering on restart.
      await backend.saveWorkspaceSession({
        openDocumentIds: [firstId, 'deleted-doc-id', secondId],
        activeDocumentId: firstId,
        immersive: false,
      });

      const restarted = createStudySyncStore(backend);
      await restarted.getState().initialize();

      expect(restarted.getState().openDocumentIds).toEqual([firstId, secondId]);
      expect(restarted.getState().activeDocumentId).toBe(firstId);
      expect(restarted.getState().readingPreferences).toMatchObject({
        theme: 'dark',
        fontSize: 130,
      });
    });

    it('persists immersive reading with the session and restores it on restart', async () => {
      const firstId = await openDocument();
      expect(state().immersive).toBe(false);
      state().setImmersive(true);
      await vi.waitFor(async () =>
        expect((await backend.getWorkspaceSession()).immersive).toBe(true),
      );

      const restarted = createStudySyncStore(backend);
      await restarted.getState().initialize();
      expect(restarted.getState().immersive).toBe(true);
      expect(restarted.getState().openDocumentIds).toEqual([firstId]);

      restarted.getState().setImmersive(false);
      await vi.waitFor(async () =>
        expect((await backend.getWorkspaceSession()).immersive).toBe(false),
      );
    });

    describe('focus mode with "Focus mode uses full screen"', () => {
      /** A window whose full screen the test controls, as the reader or the OS would. */
      const withWindow = async () => {
        const appWindow: { fullscreen: boolean; notify: (fullscreen: boolean) => void } = {
          fullscreen: false,
          notify: () => undefined,
        };
        const windowed = createMemoryBackend();
        windowed.isFullscreen = async () => appWindow.fullscreen;
        const setFullscreen = vi.fn(async (fullscreen: boolean) => {
          if (fullscreen === appWindow.fullscreen) return;
          appWindow.fullscreen = fullscreen;
          appWindow.notify(fullscreen);
        });
        windowed.setFullscreen = setFullscreen;
        windowed.onFullscreenChange = (listener) => {
          appWindow.notify = listener;
          return () => undefined;
        };
        const windowStore = createStudySyncStore(windowed);
        await windowStore.getState().initialize();
        return { appWindow, setFullscreen, get: () => windowStore.getState() };
      };

      it('stays out of full screen while the preference is off', async () => {
        const { setFullscreen, get } = await withWindow();
        get().setImmersive(true);
        get().setImmersive(false);
        expect(setFullscreen).not.toHaveBeenCalled();
      });

      it('enters full screen with focus mode and leaves it with focus mode', async () => {
        const { appWindow, get } = await withWindow();
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreen).toBe(true));
        expect(get().fullscreenFromFocusMode).toBe(true);

        get().setImmersive(false);
        await vi.waitFor(() => expect(get().fullscreen).toBe(false));
        expect(appWindow.fullscreen).toBe(false);
        expect(get().fullscreenFromFocusMode).toBe(false);
      });

      it('leaves full screen the reader chose alone', async () => {
        const { appWindow, setFullscreen, get } = await withWindow();
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        await get().setFullscreen(true);
        setFullscreen.mockClear();

        get().setImmersive(true);
        get().setImmersive(false);
        expect(setFullscreen).not.toHaveBeenCalled();
        expect(appWindow.fullscreen).toBe(true);
      });

      it('hands full screen back once the reader leaves it some other way', async () => {
        const { appWindow, setFullscreen, get } = await withWindow();
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreen).toBe(true));

        // The window's own button, or View ▸ Exit Full Screen; then back in by hand.
        await get().setFullscreen(false);
        expect(get().fullscreenFromFocusMode).toBe(false);
        await get().setFullscreen(true);
        setFullscreen.mockClear();

        get().setImmersive(false);
        expect(setFullscreen).not.toHaveBeenCalled();
        expect(appWindow.fullscreen).toBe(true);
      });

      it('does not strand the window in full screen when focus mode ends first', async () => {
        const { appWindow, setFullscreen, get } = await withWindow();
        // The window takes a moment to go full screen: until the test lets it.
        let finishEntering = () => undefined as void;
        const entered = new Promise<void>((settle) => {
          finishEntering = settle;
        });
        setFullscreen.mockImplementationOnce(async (fullscreen: boolean) => {
          await entered;
          appWindow.fullscreen = fullscreen;
          appWindow.notify(fullscreen);
        });
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        // After the request to enter is sent, before it has settled.
        await vi.waitFor(() => expect(setFullscreen).toHaveBeenCalledTimes(1));
        get().setImmersive(false);
        finishEntering();
        // Enter, the exit that found nothing to leave yet, then the exit once it had.
        await vi.waitFor(() => expect(setFullscreen).toHaveBeenCalledTimes(3));
        expect(setFullscreen.mock.calls.map(([fullscreen]) => fullscreen)).toEqual([
          true,
          false,
          false,
        ]);
        await vi.waitFor(() => expect(appWindow.fullscreen).toBe(false));
        await vi.waitFor(() => expect(get().fullscreen).toBe(false));
      });

      it('does not ask for full screen when focus mode ends before the window answers', async () => {
        const { setFullscreen, get } = await withWindow();
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        get().setImmersive(false);
        await new Promise((settle) => setTimeout(settle, 10));
        expect(setFullscreen).not.toHaveBeenCalled();
        expect(get().fullscreenFromFocusMode).toBe(false);
      });

      it('keeps ownership through a stale "not full screen" report during the animation', async () => {
        const { appWindow, setFullscreen, get } = await withWindow();
        // The first resize of the enter animation reports `false` before the window is full screen.
        setFullscreen.mockImplementationOnce(async (fullscreen: boolean) => {
          appWindow.notify(false);
          appWindow.fullscreen = fullscreen;
        });
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreen).toBe(true));
        expect(get().fullscreenFromFocusMode).toBe(true);

        get().setImmersive(false);
        await vi.waitFor(() => expect(appWindow.fullscreen).toBe(false));
        await vi.waitFor(() => expect(get().fullscreen).toBe(false));
      });

      it('leaves a window that started full screen to the reader', async () => {
        const appWindow = { fullscreen: true };
        const windowed = createMemoryBackend();
        windowed.isFullscreen = async () => appWindow.fullscreen;
        const setFullscreen = vi.fn(async (fullscreen: boolean) => {
          appWindow.fullscreen = fullscreen;
        });
        windowed.setFullscreen = setFullscreen;
        windowed.onFullscreenChange = () => () => undefined;
        const windowStore = createStudySyncStore(windowed);
        await windowStore.getState().initialize();
        const get = () => windowStore.getState();
        expect(get().fullscreen).toBe(true);

        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        get().setImmersive(false);
        await new Promise((settle) => setTimeout(settle, 10));
        expect(setFullscreen).not.toHaveBeenCalled();
        expect(appWindow.fullscreen).toBe(true);
      });

      it('finds a full screen the store has not heard about yet before claiming it', async () => {
        const { appWindow, setFullscreen, get } = await withWindow();
        // Full screen with no resize report reaching the store.
        appWindow.fullscreen = true;
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreen).toBe(true));
        expect(get().fullscreenFromFocusMode).toBe(false);
        get().setImmersive(false);
        expect(setFullscreen).not.toHaveBeenCalled();
        expect(appWindow.fullscreen).toBe(true);
      });

      it('leaves focus mode without an error when the window will not leave full screen', async () => {
        const { setFullscreen, get } = await withWindow();
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreenFromFocusMode).toBe(true));
        setFullscreen.mockRejectedValueOnce(new Error('denied'));
        get().setImmersive(false);
        await vi.waitFor(() => expect(setFullscreen).toHaveBeenCalledTimes(2));
        await new Promise((settle) => setTimeout(settle, 0));
        expect(get().immersive).toBe(false);
        expect(get().error).toBeNull();
      });

      it('stays in focus mode, without an error, when full screen is refused', async () => {
        const { setFullscreen, get } = await withWindow();
        setFullscreen.mockRejectedValueOnce(new Error('denied'));
        await get().updateReadingPreferences({ focusModeFullScreen: true });
        get().setImmersive(true);
        await vi.waitFor(() => expect(get().fullscreenFromFocusMode).toBe(false));
        expect(get().immersive).toBe(true);
        expect(get().error).toBeNull();
      });
    });

    it('detects missing, moved, and changed sources across PDF, EPUB, and TXT, and relinks while preserving notes', async () => {
      let pdfBytes = new TextEncoder().encode('pdf-v1');
      let epubBytes = new TextEncoder().encode('epub-v1');
      let txtBytes: Uint8Array | null = new TextEncoder().encode('txt-v1');

      const mutableBackend = createMemoryBackend({
        library: {
          '/lib/paper.pdf': async () => pdfBytes,
          '/lib/book.epub': async () => epubBytes,
          '/lib/notes.txt': async () => {
            if (!txtBytes) throw new Error('missing file');
            return txtBytes;
          },
          '/lib/notes-moved.txt': new TextEncoder().encode('txt-v1'),
        },
      });
      const recoveryStore = createStudySyncStore(mutableBackend);
      await recoveryStore.getState().initialize();

      // Open PDF, EPUB, and TXT.
      await recoveryStore.getState().openDocument();
      const pdfId = recoveryStore.getState().activeDocumentId as string;
      await recoveryStore.getState().openDocument();
      const epubId = recoveryStore.getState().activeDocumentId as string;
      await recoveryStore.getState().openDocument();
      const txtId = recoveryStore.getState().activeDocumentId as string;

      // Create an annotation on the TXT document and record a reading cursor on PDF.
      recoveryStore.getState().setSelection({
        documentId: txtId,
        anchor: txtAnchor,
        text: 'txt-v1',
        imagePng: null,
      });
      await recoveryStore.getState().createAnnotationFromSelection({ note: 'important txt note' });
      recoveryStore.getState().reportCursor(pdfId, pdfAnchor as ReaderSelection['anchor']);

      // 1. Delete `/lib/notes.txt` -> verify reports `missing`, relink to `/lib/notes-moved.txt` (identical hash).
      txtBytes = null;
      const missingStatus = await recoveryStore.getState().verifyDocumentSource(txtId);
      expect(missingStatus?.state).toBe('missing');
      expect(recoveryStore.getState().documentSourceStatuses[txtId]?.state).toBe('missing');
      // Annotations remain preserved even while source is missing.
      expect(selectDocumentAnnotations(recoveryStore.getState().annotations, txtId)).toHaveLength(
        1,
      );

      const movedRelink = await recoveryStore.getState().relinkDocument(txtId, false);
      expect(movedRelink?.contentChanged).toBe(false);
      expect(movedRelink?.document.title).toBe('notes-moved');
      expect(recoveryStore.getState().documentSourceStatuses[txtId]?.state).toBe('ok');
      expect(recoveryStore.getState().relinkedNonceByDocumentId[txtId]).toBe(1);

      // 2. Modify PDF and EPUB in place -> verify reports `changed`, confirm in-place relink clears stale cursor.
      pdfBytes = new TextEncoder().encode('pdf-v2-revised');
      epubBytes = new TextEncoder().encode('epub-v2-revised');

      const pdfStatus = await recoveryStore.getState().verifyDocumentSource(pdfId);
      const epubStatus = await recoveryStore.getState().verifyDocumentSource(epubId);
      expect(pdfStatus?.state).toBe('changed');
      expect(epubStatus?.state).toBe('changed');

      const pdfRelinked = await recoveryStore.getState().relinkDocument(pdfId, true);
      expect(pdfRelinked?.contentChanged).toBe(true);
      expect(pdfRelinked?.document.lastCursorAnchor).toBeNull();
      expect(recoveryStore.getState().documentSourceStatuses[pdfId]?.state).toBe('ok');

      const epubRelinked = await recoveryStore.getState().relinkDocument(epubId, true);
      expect(epubRelinked?.contentChanged).toBe(true);
      expect(recoveryStore.getState().documentSourceStatuses[epubId]?.state).toBe('ok');
    });
  });
});

describe('nextNodePosition', () => {
  const node = (id: string, parentNodeId: string | null, posX = 0, posY = 0) => ({
    id,
    notebookId: 'n',
    cardId: 'c',
    parentNodeId,
    posX,
    posY,
    isCollapsed: false,
    style: null,
  });

  it('cascades roots so they do not stack exactly', () => {
    const first = nextNodePosition([], null);
    const second = nextNodePosition([node('a', null)], null);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });

  it('places children to the right of the parent, below their siblings', () => {
    const parent = node('p', null, 100, 100);
    const first = nextNodePosition([parent], 'p');
    const second = nextNodePosition([parent, node('c', 'p')], 'p');
    expect(first.x).toBeGreaterThan(100);
    expect(first.y).toBe(100);
    expect(second.x).toBe(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });

  it('treats an unknown parent as no parent', () => {
    expect(nextNodePosition([], 'missing')).toEqual(nextNodePosition([], null));
  });
});

describe('PDF layouts', () => {
  const twoPage: PdfLayout = {
    displayMode: 'two-page',
    zoomMode: 'custom',
    scale: 1.5,
    rotation: 270,
    coverPageAlone: true,
  };

  const setup = async () => {
    const backend = createMemoryBackend({
      library: Object.fromEntries(
        ['first.pdf', 'second.pdf', 'notes.txt'].map((name) => [
          `/test/${name}`,
          new TextEncoder().encode(`content:${name}`),
        ]),
      ),
    });
    const store = createStudySyncStore(backend);
    await store.getState().initialize();
    const open = async () => {
      await store.getState().openDocument();
      return store.getState().activeDocumentId as string;
    };
    return { backend, store, open };
  };

  it('loads, saves, and restores a PDF layout across a restart', async () => {
    const { backend, store, open } = await setup();
    const pdfId = await open();
    await store.getState().loadPdfLayout(pdfId);
    expect(store.getState().pdfLayouts[pdfId]).toEqual(DEFAULT_PDF_LAYOUT);

    await store.getState().savePdfLayout(pdfId, twoPage);
    expect(store.getState().pdfLayouts[pdfId]).toEqual(twoPage);
    await expect(backend.getPdfLayout(pdfId)).resolves.toEqual(twoPage);

    const restarted = createStudySyncStore(backend);
    await restarted.getState().initialize();
    expect(restarted.getState().pdfLayouts).toEqual({});
    await restarted.getState().loadPdfLayout(pdfId);
    expect(restarted.getState().pdfLayouts[pdfId]).toEqual(twoPage);
  });

  it('opens a new PDF in the last saved display and zoom, but its own rotation and cover', async () => {
    const { store, open } = await setup();
    const firstId = await open();
    await store.getState().savePdfLayout(firstId, twoPage);
    const secondId = await open();
    await store.getState().loadPdfLayout(secondId);
    expect(store.getState().pdfLayouts[secondId]).toEqual({
      ...DEFAULT_PDF_LAYOUT,
      displayMode: 'two-page',
      zoomMode: 'custom',
      scale: 1.5,
    });
    // The first keeps the whole layout it saved.
    expect(store.getState().pdfLayouts[firstId]).toEqual(twoPage);
  });

  it('keeps an inherited layout after the PDF it came from changes', async () => {
    const { backend, store, open } = await setup();
    const firstId = await open();
    await store.getState().savePdfLayout(firstId, twoPage);
    const secondId = await open();
    await store.getState().loadPdfLayout(secondId);
    store.getState().closeDocument(secondId);
    await store.getState().savePdfLayout(firstId, { ...twoPage, displayMode: 'continuous' });

    await store.getState().reopenRecentDocument(secondId);
    await store.getState().loadPdfLayout(secondId);
    expect(store.getState().pdfLayouts[secondId]?.displayMode).toBe('two-page');
    await expect(backend.getPdfLayout(secondId)).resolves.toMatchObject({
      displayMode: 'two-page',
    });
  });

  it('does not cache a layout that finishes loading after its tab closed', async () => {
    const { backend, store, open } = await setup();
    const pdfId = await open();
    let resolve: (layout: PdfLayout) => void = () => {};
    vi.spyOn(backend, 'getPdfLayout').mockReturnValueOnce(
      new Promise<PdfLayout>((done) => {
        resolve = done;
      }),
    );
    const loading = store.getState().loadPdfLayout(pdfId);
    store.getState().closeDocument(pdfId);
    resolve(twoPage);
    await loading;
    expect(store.getState().pdfLayouts[pdfId]).toBeUndefined();
  });

  it('drops a closed tab’s layout so reopening reads the saved one', async () => {
    const { backend, store, open } = await setup();
    const pdfId = await open();
    await store.getState().savePdfLayout(pdfId, twoPage);
    // Another window or a failed save could leave the backend different.
    await backend.savePdfLayout(pdfId, { ...twoPage, rotation: 90 });

    store.getState().closeDocument(pdfId);
    expect(store.getState().pdfLayouts[pdfId]).toBeUndefined();
    await store.getState().reopenRecentDocument(pdfId);
    await store.getState().loadPdfLayout(pdfId);
    expect(store.getState().pdfLayouts[pdfId]?.rotation).toBe(90);
  });

  it('opens in the default layout and reports the error when loading fails', async () => {
    const { backend, store, open } = await setup();
    const pdfId = await open();
    vi.spyOn(backend, 'getPdfLayout').mockRejectedValueOnce({
      code: 'database',
      message: 'disk I/O error',
    });
    await store.getState().loadPdfLayout(pdfId);
    expect(store.getState().pdfLayouts[pdfId]).toEqual(DEFAULT_PDF_LAYOUT);
    expect(store.getState().error).toContain('disk I/O error');
  });

  it('rejects what core rejects', async () => {
    const { backend, store, open } = await setup();
    const pdfId = await open();
    await open(); // second.pdf
    const txtId = await open();
    await expect(backend.savePdfLayout(pdfId, { ...twoPage, scale: 9 })).rejects.toMatchObject({
      code: 'invalid_layout',
    });
    await expect(
      backend.savePdfLayout(pdfId, { ...twoPage, rotation: 45 as PdfLayout['rotation'] }),
    ).rejects.toMatchObject({ code: 'invalid_layout' });
    await expect(backend.getPdfLayout(txtId)).rejects.toMatchObject({ code: 'invalid_layout' });
    await expect(backend.getPdfLayout('missing')).rejects.toMatchObject({ code: 'not_found' });

    // A failed save reaches the error banner.
    await store.getState().savePdfLayout(pdfId, { ...twoPage, scale: 9 });
    expect(store.getState().error).toContain('scale');
  });
});

describe('card deletion, undo, and pane layout persistence (#116, #119)', () => {
  it('deletes a card atomically, re-roots children, preserves highlights, and restores on undo', async () => {
    const backend = createMemoryBackend({
      library: { '/books/test.txt': new TextEncoder().encode('parent child') },
    });
    const store = createStudySyncStore(backend);
    const state = () => store.getState();
    await state().initialize();
    await state().openDocument();
    const docId = state().activeDocumentId as string;

    state().setSelection({
      documentId: docId,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 6, lineIndex: 0 },
      text: 'parent',
      imagePng: null,
    });
    await state().excerptSelection();
    const parentNode = state().nodes[0];
    expect(parentNode).toBeDefined();
    state().selectNode(parentNode?.id as string);

    state().setSelection({
      documentId: docId,
      anchor: { format: 'txt', startByteOffset: 7, endByteOffset: 12, lineIndex: 0 },
      text: 'child',
      imagePng: null,
    });
    await state().excerptSelection();
    const childNode = state().nodes[1];
    expect(childNode?.parentNodeId).toBe(parentNode?.id);

    await state().updateCard(parentNode?.cardId as string, {
      title: 'Parent',
      markdownNotes: 'Key insight',
      tags: ['core'],
    });
    state().selectNode(parentNode?.id as string);

    await state().removeCard(parentNode?.cardId as string);
    expect(state().cards.map((c) => c.id)).toEqual([childNode?.cardId]);
    expect(state().nodes).toHaveLength(1);
    expect(state().nodes[0]?.parentNodeId).toBeNull();
    expect(state().edges).toEqual([]);
    expect(state().annotations).toHaveLength(2);
    expect(state().selectedNodeId).toBeNull();
    expect(state().deletionOrder.at(-1)).toBe('card');

    const restored = await state().undoRemoveCard();
    expect(restored?.card).toMatchObject({
      title: 'Parent',
      markdownNotes: 'Key insight',
      tags: ['core'],
    });
    expect(state().cards).toHaveLength(2);
    expect(state().nodes).toHaveLength(2);
    expect(state().nodes.find((n) => n.id === childNode?.id)?.parentNodeId).toBe(parentNode?.id);
    expect(state().edges).toHaveLength(1);
  });

  it('waits for an in-flight card delete before restoring on quick undo, and rolls back on failure', async () => {
    const backend = createMemoryBackend({
      library: { '/books/test.txt': new TextEncoder().encode('hello') },
    });
    const store = createStudySyncStore(backend);
    const state = () => store.getState();
    await state().initialize();
    await state().openDocument();
    const docId = state().activeDocumentId as string;

    state().setSelection({
      documentId: docId,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
      text: 'hello',
      imagePng: null,
    });
    await state().excerptSelection();
    const cardId = state().cards[0]?.id as string;

    let finishDelete = () => {};
    const realDelete = backend.deleteCard.bind(backend);
    vi.spyOn(backend, 'deleteCard').mockImplementationOnce(
      (id) =>
        new Promise((resolve, reject) => {
          finishDelete = () => void realDelete(id).then(resolve, reject);
        }),
    );
    const restoreSpy = vi.spyOn(backend, 'restoreCard');

    const removing = state().removeCard(cardId);
    const undoing = state().undoRemoveCard();
    await Promise.resolve();
    expect(restoreSpy).not.toHaveBeenCalled();

    finishDelete();
    await Promise.all([removing, undoing]);
    expect(restoreSpy).toHaveBeenCalledWith(cardId);
    expect(state().cards.map((c) => c.id)).toEqual([cardId]);

    // Backend failure rolls back cleanly without leaving undo history behind.
    vi.spyOn(backend, 'deleteCard').mockRejectedValueOnce(new Error('disk full'));
    await state().removeCard(cardId);
    expect(state().cards.map((c) => c.id)).toEqual([cardId]);
    expect(state().deletedCardHistory).toEqual([]);
    expect(state().error).toContain('disk full');
  });

  it('persists paneLayout across store re-initialization', async () => {
    const backend = createMemoryBackend();
    const first = createStudySyncStore(backend);
    await first.getState().initialize();
    first.getState().setPaneLayout({
      mindMapOpen: true,
      inspectorOpen: true,
      mindMapSize: 42,
      inspectorSize: 25,
    });
    // Allow async saveWorkspaceSession to complete.
    await Promise.resolve();

    const second = createStudySyncStore(backend);
    await second.getState().initialize();
    expect(second.getState().paneLayout).toEqual({
      mindMapOpen: true,
      inspectorOpen: true,
      mindMapSize: 42,
      inspectorSize: 25,
    });
  });

  it('picks an unoccupied position after deleting a middle root or sibling card (#116)', async () => {
    const backend = createMemoryBackend({
      library: { '/books/test.txt': new TextEncoder().encode('one two three four five six') },
    });
    const store = createStudySyncStore(backend);
    const state = () => store.getState();
    await state().initialize();
    await state().openDocument();
    const docId = state().activeDocumentId as string;

    const addExcerpt = async (text: string) => {
      state().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 3, lineIndex: 0 },
        text,
        imagePng: null,
      });
      await state().excerptSelection();
      return state().nodes.at(-1)!;
    };

    // Three roots at (40,40), (76,76), (112,112).
    const r1 = await addExcerpt('r1');
    const r2 = await addExcerpt('r2');
    const r3 = await addExcerpt('r3');
    expect({ x: r3.posX, y: r3.posY }).toEqual({ x: 112, y: 112 });

    // Delete middle root r2, then add r4: must not collide with r1 or r3.
    await state().removeCard(r2.cardId);
    const r4 = await addExcerpt('r4');
    const rootPositions = [r1, r3, r4].map((n) => `${n.posX},${n.posY}`);
    expect(new Set(rootPositions).size).toBe(3);

    // Same for three siblings under r1: deleting middle child leaves an unoccupied slot
    // rather than colliding with the surviving third sibling.
    state().selectNode(r1.id);
    const c1 = await addExcerpt('c1');
    state().selectNode(r1.id);
    const c2 = await addExcerpt('c2');
    state().selectNode(r1.id);
    const c3 = await addExcerpt('c3');

    await state().removeCard(c2.cardId);
    state().selectNode(r1.id);
    const c4 = await addExcerpt('c4');
    const siblingPositions = [c1, c3, c4].map((n) => `${n.posX},${n.posY}`);
    expect(new Set(siblingPositions).size).toBe(3);
  });

  it('reports false from updateCard when the backend rejects the write (#117)', async () => {
    const backend = createMemoryBackend({
      library: { '/books/test.txt': new TextEncoder().encode('hello') },
    });
    const store = createStudySyncStore(backend);
    const state = () => store.getState();
    await state().initialize();
    await state().openDocument();
    const docId = state().activeDocumentId as string;
    state().setSelection({
      documentId: docId,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
      text: 'hello',
      imagePng: null,
    });
    await state().excerptSelection();
    const cardId = state().cards[0]?.id as string;

    vi.spyOn(backend, 'updateCard').mockRejectedValueOnce(new Error('disk full'));
    const failed = await state().updateCard(cardId, {
      title: null,
      markdownNotes: 'unsaved',
      tags: null,
    });
    expect(failed).toBe(false);
    expect(state().error).toContain('disk full');
    expect(state().cards[0]?.markdownNotes).toBe('');

    const succeeded = await state().updateCard(cardId, {
      title: null,
      markdownNotes: 'saved',
      tags: null,
    });
    expect(succeeded).toBe(true);
    expect(state().cards[0]?.markdownNotes).toBe('saved');
  });
});

describe('cursor write tracking, close-and-flush, and store refresh (#137)', () => {
  let backend: StudyBackend;
  let store: ReturnType<typeof createStudySyncStore>;

  const state = () => store.getState();

  const openDocument = async () => {
    await state().openDocument();
    return state().activeDocumentId as string;
  };

  beforeEach(async () => {
    backend = createMemoryBackend({
      library: Object.fromEntries(
        ['a.pdf', 'b.epub', 'c.txt', 'd.md'].map((name) => [
          `/test/${name}`,
          new TextEncoder().encode(`content:${name}`),
        ]),
      ),
    });
    store = createStudySyncStore(backend);
    await state().initialize();
  });

  it('flushCursorWrites waits until all in-flight updateDocumentCursor promises for that document settle', async () => {
    const docA = await openDocument();
    const docB = await openDocument();

    let resolveA1!: () => void;
    let resolveA2!: () => void;
    let resolveB!: () => void;
    const a1 = new Promise<void>((resolve) => {
      resolveA1 = resolve;
    });
    const a2 = new Promise<void>((resolve) => {
      resolveA2 = resolve;
    });
    const b1 = new Promise<void>((resolve) => {
      resolveB = resolve;
    });

    const calls: string[] = [];
    vi.spyOn(backend, 'updateDocumentCursor').mockImplementation((id) => {
      calls.push(id);
      if (id === docA && calls.filter((c) => c === docA).length === 1) return a1;
      if (id === docA) return a2;
      return b1;
    });

    state().reportCursor(docA, txtAnchor, 0.2);
    state().reportCursor(docA, { ...txtAnchor, startByteOffset: 1, endByteOffset: 4 }, 0.4);
    state().reportCursor(docB, txtAnchor, 0.5);

    let flushedA = false;
    const flushPromise = state()
      .flushCursorWrites(docA)
      .then(() => {
        flushedA = true;
      });

    await Promise.resolve();
    expect(flushedA).toBe(false);

    resolveA1();
    await Promise.resolve();
    expect(flushedA).toBe(false);

    resolveA2();
    await flushPromise;
    expect(flushedA).toBe(true);

    // Unrelated docB write is still pending and did not block docA.
    resolveB();
    await state().flushCursorWrites(docB);
  });

  it('closeDocumentAndFlush skips unmount wait when headless and awaits delayed cursor writes (T-31)', async () => {
    const docId = await openDocument();

    let resolveWrite!: () => void;
    const delayedWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    vi.spyOn(backend, 'updateDocumentCursor').mockReturnValueOnce(delayedWrite);

    state().reportCursor(docId, txtAnchor, 0.3);

    let finished = false;
    const closing = state()
      .closeDocumentAndFlush(docId)
      .then(() => {
        finished = true;
      });

    // Document is closed synchronously and locked while flushing.
    expect(state().openDocumentIds).not.toContain(docId);
    expect(state().lockedDocumentIds).toContain(docId);

    // Reopen attempts are ignored while locked.
    await state().reopenRecentDocument(docId);
    await state().reopenClosedDocument();
    expect(state().openDocumentIds).not.toContain(docId);

    await Promise.resolve();
    expect(finished).toBe(false);

    resolveWrite();
    await closing;
    expect(finished).toBe(true);
    expect(state().lockedDocumentIds).not.toContain(docId);

    // Reopen works again once the lock is released.
    await state().reopenClosedDocument();
    expect(state().openDocumentIds).toContain(docId);
  });

  it('closeDocumentAndFlush waits for mounted viewer unmount before flushing its cursor write (T-31, R3-06)', async () => {
    const docId = await openDocument();
    const unregister = state().registerMountedViewer(docId);

    let resolveWrite!: () => void;
    const delayedWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const updateSpy = vi.spyOn(backend, 'updateDocumentCursor').mockReturnValueOnce(delayedWrite);

    let finished = false;
    const closing = state()
      .closeDocumentAndFlush(docId)
      .then(() => {
        finished = true;
      });

    expect(state().openDocumentIds).not.toContain(docId);
    await Promise.resolve();
    expect(finished).toBe(false);

    // Simulate React sibling order: <Viewer> cleanup reports cursor, then <UnmountSentinel> unregisters.
    state().reportCursor(docId, txtAnchor, 0.75);
    unregister();

    await Promise.resolve();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);

    resolveWrite();
    await closing;
    expect(finished).toBe(true);
  });

  it('concurrent closeDocumentAndFlush calls both block until viewer unmounts and cursor write settles', async () => {
    const docId = await openDocument();
    const unregister = state().registerMountedViewer(docId);

    let resolveWrite!: () => void;
    const delayedWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const updateSpy = vi.spyOn(backend, 'updateDocumentCursor').mockReturnValueOnce(delayedWrite);

    let firstFinished = false;
    let secondFinished = false;
    const first = state()
      .closeDocumentAndFlush(docId)
      .then(() => {
        firstFinished = true;
      });
    const second = state()
      .closeDocumentAndFlush(docId)
      .then(() => {
        secondFinished = true;
      });

    await Promise.resolve();
    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    expect(state().lockedDocumentIds).toContain(docId);

    // Viewer unmounts, reports cursor, then UnmountSentinel unregisters.
    state().reportCursor(docId, txtAnchor, 0.8);
    unregister();

    await Promise.resolve();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);

    resolveWrite();
    await Promise.all([first, second]);
    expect(firstFinished).toBe(true);
    expect(secondFinished).toBe(true);
    expect(state().lockedDocumentIds).not.toContain(docId);
  });

  it('blocks file-picker open, dropped files, activate, and jump paths while a document lock is held', async () => {
    const docId = await openDocument();
    const lockedDoc = state().documents.find((d) => d.id === docId)!;
    const otherDocId = await openDocument();
    const otherDoc = state().documents.find((d) => d.id === otherDocId)!;

    // Seed an annotation, card/node, and bookmark on the locked document to test jump paths too.
    state().setSelection({
      documentId: docId,
      anchor: pdfAnchor as ReaderSelection['anchor'],
      text: 'Locked excerpt',
      imagePng: null,
    });
    await state().excerptSelection();
    const annotationId = state().annotations.find((a) => a.documentId === docId)!.id;
    const nodeId = state().nodes[0]!.id;
    const bookmark = await state().addBookmark(docId, pdfAnchor as ReaderSelection['anchor'], 'BM');

    state().closeDocument(docId);
    expect(state().openDocumentIds).toEqual([otherDocId]);
    expect(state().activeDocumentId).toBe(otherDocId);

    const pickSpy = vi.spyOn(backend, 'pickDocument').mockResolvedValue(lockedDoc);
    const dropSpy = vi
      .spyOn(backend, 'dropFiles')
      .mockResolvedValue({ documents: [lockedDoc, otherDoc], error: null });

    await state().withDocumentLock(docId, async () => {
      // File picker returning the locked document must not reopen or activate it.
      await state().openDocument();
      expect(state().openDocumentIds).not.toContain(docId);
      expect(state().activeDocumentId).toBe(otherDocId);

      // Dropped files containing the locked document must not reopen or activate it.
      await state().dropFiles([new File(['data'], 'locked.pdf')]);
      expect(state().openDocumentIds).not.toContain(docId);
      expect(state().activeDocumentId).toBe(otherDocId);

      // Direct activate and jump paths must also be blocked while locked.
      state().activateDocument(docId);
      state().jumpToAnnotation(annotationId);
      state().jumpToNode(nodeId);
      if (bookmark) state().jumpToBookmark(bookmark.id);
      expect(state().openDocumentIds).not.toContain(docId);
      expect(state().activeDocumentId).toBe(otherDocId);
    });

    // Once the lock is released, file-picker open reopens and activates the document normally.
    await state().openDocument();
    expect(state().openDocumentIds).toContain(docId);
    expect(state().activeDocumentId).toBe(docId);

    pickSpy.mockRestore();
    dropSpy.mockRestore();
  });

  it('withDocumentLock blocks reopenRecentDocument and reopenClosedDocument across a close-and-apply sequence', async () => {
    const docId = await openDocument();
    state().closeDocument(docId);

    await state().withDocumentLock(docId, async () => {
      expect(state().lockedDocumentIds).toContain(docId);
      await state().reopenRecentDocument(docId);
      await state().reopenClosedDocument();
      expect(state().openDocumentIds).not.toContain(docId);
    });

    expect(state().lockedDocumentIds).not.toContain(docId);
    await state().reopenClosedDocument();
    expect(state().openDocumentIds).toContain(docId);
  });

  it('invalidates an in-flight reopenRecentDocument when a lock is acquired and released before its stale response returns', async () => {
    const docId = await openDocument();
    const oldAnchor = {
      format: 'pdf' as const,
      pageIndex: 1,
      rects: [{ x: 0, y: 0.1, width: 0.5, height: 0.05 }],
    };
    const syncedAnchor = {
      format: 'pdf' as const,
      pageIndex: 9,
      rects: [{ x: 0, y: 0.4, width: 0.5, height: 0.05 }],
    };

    await backend.updateDocumentCursor(docId, oldAnchor, 0.1);
    await state().refreshDocument(docId);
    state().closeDocument(docId);

    // Capture the pre-sync snapshot and delay touchDocumentOpened so sync can
    // acquire the lock, apply new progress, refresh the store, and unlock first.
    const staleSnapshot = {
      ...state().documents.find((d) => d.id === docId)!,
      lastOpenedAt: '2026-11-20T12:00:00Z',
    };
    let resolveStaleTouch!: (doc: StudyDocument) => void;
    const touchSpy = vi.spyOn(backend, 'touchDocumentOpened').mockImplementationOnce(
      () =>
        new Promise<StudyDocument>((resolve) => {
          resolveStaleTouch = resolve;
        }),
    );

    const staleReopen = state().reopenRecentDocument(docId);
    await Promise.resolve();

    // Sync runs end-to-end (lock -> update DB -> refresh store -> unlock) while
    // the old reopenRecentDocument request is still in flight.
    await state().withDocumentLock(docId, async () => {
      await backend.updateDocumentCursor(docId, syncedAnchor, 0.9);
      await state().refreshDocument(docId);
    });
    expect(state().lockedDocumentIds).not.toContain(docId);
    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(syncedAnchor);

    // Now the stale response returns after the lock has already been released.
    resolveStaleTouch(staleSnapshot);
    await staleReopen;

    // The stale snapshot must not overwrite the synced progress or reopen the tab.
    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(syncedAnchor);
    expect(state().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.9);
    expect(state().openDocumentIds).not.toContain(docId);

    touchSpy.mockRestore();

    // A fresh reopen after sync succeeds with the synced progress intact.
    await state().reopenRecentDocument(docId);
    expect(state().openDocumentIds).toContain(docId);
    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(syncedAnchor);
  });

  it('invalidates stale file-picker and browser drop snapshots when a lock is acquired and released in flight', async () => {
    const docId = await openDocument();
    const oldAnchor = {
      format: 'pdf' as const,
      pageIndex: 1,
      rects: [{ x: 0, y: 0.1, width: 0.5, height: 0.05 }],
    };
    const syncedAnchor = {
      format: 'pdf' as const,
      pageIndex: 7,
      rects: [{ x: 0, y: 0.3, width: 0.5, height: 0.05 }],
    };

    await backend.updateDocumentCursor(docId, oldAnchor, 0.15);
    await state().refreshDocument(docId);
    state().closeDocument(docId);
    const staleSnapshot = { ...state().documents.find((d) => d.id === docId)! };

    // 1) File picker starts before sync, returns stale snapshot after sync unlocks.
    let resolvePick!: (doc: StudyDocument | null) => void;
    const pickSpy = vi.spyOn(backend, 'pickDocument').mockImplementationOnce(
      () =>
        new Promise<StudyDocument | null>((resolve) => {
          resolvePick = resolve;
        }),
    );

    const stalePick = state().openDocument();
    await Promise.resolve();

    await state().withDocumentLock(docId, async () => {
      await backend.updateDocumentCursor(docId, syncedAnchor, 0.75);
      await state().refreshDocument(docId);
    });
    expect(state().lockedDocumentIds).not.toContain(docId);

    resolvePick(staleSnapshot);
    await stalePick;

    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(syncedAnchor);
    expect(state().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.75);
    expect(state().openDocumentIds).not.toContain(docId);

    // 2) Browser drop starts before a second sync, returns stale snapshot after sync unlocks.
    const newerAnchor = {
      format: 'pdf' as const,
      pageIndex: 12,
      rects: [{ x: 0, y: 0.6, width: 0.5, height: 0.05 }],
    };
    let resolveDrop!: (result: Awaited<ReturnType<StudyBackend['dropFiles']>>) => void;
    const dropSpy = vi.spyOn(backend, 'dropFiles').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDrop = resolve;
        }),
    );

    const staleDrop = state().dropFiles([new File(['data'], 'a.pdf')]);
    await Promise.resolve();

    await state().withDocumentLock(docId, async () => {
      await backend.updateDocumentCursor(docId, newerAnchor, 0.92);
      await state().refreshDocument(docId);
    });

    resolveDrop({ documents: [staleSnapshot], error: null });
    await staleDrop;

    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(newerAnchor);
    expect(state().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.92);
    expect(state().openDocumentIds).not.toContain(docId);

    // A fresh file-picker open after sync succeeds with the synced document.
    const freshSyncedDoc = { ...state().documents.find((d) => d.id === docId)! };
    pickSpy.mockResolvedValueOnce(freshSyncedDoc);
    await state().openDocument();
    expect(state().openDocumentIds).toContain(docId);
    expect(state().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(newerAnchor);

    pickSpy.mockRestore();
    dropSpy.mockRestore();
  });

  it('prevents stale native onFileDrop snapshots from regressing synced progress', async () => {
    let emitDrop: ((event: FileDropEvent) => void) | undefined;
    const nativeBackend: StudyBackend = {
      ...backend,
      onFileDrop(listener) {
        emitDrop = listener;
        return () => undefined;
      },
    };
    const nativeStore = createStudySyncStore(nativeBackend);
    await nativeStore.getState().initialize();
    await nativeStore.getState().openDocument();
    const docId = nativeStore.getState().activeDocumentId as string;

    const oldAnchor = {
      format: 'pdf' as const,
      pageIndex: 2,
      rects: [{ x: 0, y: 0.2, width: 0.5, height: 0.05 }],
    };
    const syncedAnchor = {
      format: 'pdf' as const,
      pageIndex: 10,
      rects: [{ x: 0, y: 0.5, width: 0.5, height: 0.05 }],
    };

    await nativeBackend.updateDocumentCursor(docId, oldAnchor, 0.2);
    await nativeStore.getState().refreshDocument(docId);
    nativeStore.getState().closeDocument(docId);
    const staleSnapshot = { ...nativeStore.getState().documents.find((d) => d.id === docId)! };

    // Case 1: drag enters before sync, sync locks & unlocks, drop arrives with stale snapshot.
    emitDrop?.({ type: 'enter' });
    await nativeStore.getState().withDocumentLock(docId, async () => {
      await nativeBackend.updateDocumentCursor(docId, syncedAnchor, 0.85);
      await nativeStore.getState().refreshDocument(docId);
    });
    emitDrop?.({ type: 'drop', documents: [staleSnapshot], error: null });

    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      syncedAnchor,
    );
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.85);
    expect(nativeStore.getState().openDocumentIds).not.toContain(docId);

    // Case 2: bare drop without preceding enter carrying a stale snapshot still preserves synced progress.
    emitDrop?.({ type: 'drop', documents: [staleSnapshot], error: null });
    await Promise.resolve();
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      syncedAnchor,
    );
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.85);
  });

  it('refreshDocument upserts updated cursor, inserts newly imported docs, and clears missing status when filePath changes (T-32)', async () => {
    const docA = await openDocument();
    const docB = await openDocument();
    const originalA = state().documents.find((d) => d.id === docA)!;
    const originalB = state().documents.find((d) => d.id === docB)!;

    // Update cursor directly in backend (simulating a synced write).
    const syncedAnchor = {
      format: 'pdf' as const,
      pageIndex: 4,
      rects: [{ x: 0, y: 0.25, width: 0.5, height: 0.05 }],
    };
    await backend.updateDocumentCursor(docA, syncedAnchor, 0.8);

    const updated = await state().refreshDocument(docA);
    expect(updated?.lastCursorAnchor).toEqual(syncedAnchor);
    expect(state().documents.find((d) => d.id === docA)?.lastCursorAnchor).toEqual(syncedAnchor);
    expect(state().documents.find((d) => d.id === docB)).toEqual(originalB);

    // Insert a newly imported document not yet in store state.
    const imported = {
      ...originalA,
      id: 'doc-newly-imported',
      title: 'Synced Book',
      filePath: '/synced/book.pdf',
    };
    vi.spyOn(backend, 'listDocuments').mockResolvedValueOnce([
      ...(await backend.listDocuments()),
      imported,
    ]);
    await state().refreshDocument(imported.id);
    expect(state().documents.find((d) => d.id === imported.id)).toEqual(imported);

    // Missing document with unchanged filePath stays missing.
    store.setState((s) => ({
      documentSourceStatuses: {
        ...s.documentSourceStatuses,
        [docA]: {
          documentId: docA,
          state: 'missing',
          currentFileHash: null,
          fileSizeBytes: null,
        },
      },
    }));
    await state().refreshDocument(docA);
    expect(state().documentSourceStatuses[docA]?.state).toBe('missing');
    expect(state().relinkedNonceByDocumentId[docA] ?? 0).toBe(0);

    // Missing document whose filePath changed transitions to ok and bumps relinkedNonce.
    const restoredA = { ...originalA, filePath: '/restored/a.pdf', lastCursorAnchor: syncedAnchor };
    vi.spyOn(backend, 'listDocuments').mockResolvedValueOnce([restoredA, originalB]);
    await state().refreshDocument(docA);
    expect(state().documentSourceStatuses[docA]).toEqual({
      documentId: docA,
      state: 'ok',
      currentFileHash: restoredA.fileHash,
      fileSizeBytes: null,
    });
    expect(state().relinkedNonceByDocumentId[docA]).toBe(1);
    expect(state().documents.find((d) => d.id === docA)?.filePath).toBe('/restored/a.pdf');
  });

  it('refreshBookmarks replaces only the target document bookmarks without affecting others (T-32)', async () => {
    const docA = await openDocument();
    const docB = await openDocument();

    await state().addBookmark(docA, pdfAnchor as ReaderSelection['anchor'], 'Old A');
    await state().addBookmark(
      docB,
      { format: 'epub', cfiRange: 'epubcfi(/6/2!/4/2)', chapterHref: 'ch1.xhtml' },
      'Keep B',
    );
    const oldAId = state().bookmarks.find((b) => b.documentId === docA)!.id;
    const keepBId = state().bookmarks.find((b) => b.documentId === docB)!.id;

    // Mutate backend directly for docA without going through store actions.
    await backend.deleteBookmark(oldAId);
    const syncedA = await backend.createBookmark({
      documentId: docA,
      anchor: { format: 'pdf', pageIndex: 3, rects: [{ x: 0, y: 0, width: 1, height: 0.1 }] },
      label: 'Synced A',
    });

    await state().refreshBookmarks(docA);

    const aBookmarks = state().bookmarks.filter((b) => b.documentId === docA);
    const bBookmarks = state().bookmarks.filter((b) => b.documentId === docB);
    expect(aBookmarks.map((b) => b.id)).toEqual([syncedA.id]);
    expect(aBookmarks[0]?.label).toBe('Synced A');
    expect(bBookmarks.map((b) => b.id)).toEqual([keepBId]);
  });
});
