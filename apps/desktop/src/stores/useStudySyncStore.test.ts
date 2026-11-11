import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { FileDropEvent, StudyBackend } from '@/lib/backend/types';
import {
  DEFAULT_PDF_LAYOUT,
  type PdfLayout,
  type ReaderSelection,
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

    it('nests under the selected node with a connecting edge', async () => {
      const documentId = await openDocument();
      select(documentId);
      await state().excerptSelection();
      const parentId = state().selectedNodeId;

      select(documentId, 'second');
      await state().excerptSelection();

      const child = state().nodes[1];
      expect(child?.parentNodeId).toBe(parentId);
      expect(state().edges).toEqual([
        expect.objectContaining({ sourceNodeId: parentId, targetNodeId: child?.id }),
      ]);
    });

    it('creates a floating root when nothing is selected', async () => {
      const documentId = await openDocument();
      state().selectNode(null);
      select(documentId);
      await state().excerptSelection();
      expect(state().nodes[0]?.parentNodeId).toBeNull();
      expect(state().edges).toEqual([]);
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
      });

      await state().updateReadingPreferences({ pageWidth: 'invalid' as 'full' });
      expect(state().readingPreferences.pageWidth).toBe('full');
      expect(state().error).toMatch(/pageWidth/);

      await state().updateReadingPreferences({ fontSize: 300 });
      expect(state().readingPreferences.fontSize).toBe(120);
      expect(state().error).toMatch(/fontSize/);

      // The newer modes are accepted by the backend's validation list too.
      for (const pageTransition of ['flip', 'stack'] as const) {
        await state().updateReadingPreferences({ pageTransition });
        expect(state().readingPreferences.pageTransition).toBe(pageTransition);
        expect((await backend.getReadingPreferences()).pageTransition).toBe(pageTransition);
      }
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
