import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { FileDropEvent, StudyBackend } from '@/lib/backend/types';
import type { ReaderSelection, TxtAnchor } from '@/types/domain';

import {
  createStudySyncStore,
  DEFAULT_NOTEBOOK_TITLE,
  nextNodePosition,
  selectHighlights,
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
        ['a.pdf', 'b.epub', 'c.txt', 'd.md'].map((name) => [`/test/${name}`, new Uint8Array()]),
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
        },
      ]);
      expect(selectHighlights(state().annotations, otherId)).toEqual([]);
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
        fontFamily: 'sans',
        fontSize: 120,
        epubReadingMode: 'paged',
      });
      expect(state().readingPreferences).toMatchObject({
        theme: 'sepia',
        fontFamily: 'sans',
        fontSize: 120,
        epubReadingMode: 'paged',
      });

      const reopened = createStudySyncStore(backend);
      await reopened.getState().initialize();
      expect(reopened.getState().readingPreferences).toMatchObject({
        theme: 'sepia',
        fontFamily: 'sans',
        fontSize: 120,
        epubReadingMode: 'paged',
      });

      await state().updateReadingPreferences({ fontSize: 300 });
      expect(state().readingPreferences.fontSize).toBe(120);
      expect(state().error).toMatch(/fontSize/);
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
