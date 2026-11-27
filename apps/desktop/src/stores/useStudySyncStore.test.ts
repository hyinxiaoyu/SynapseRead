import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { FileDropEvent, StudyBackend } from '@/lib/backend/types';
import { documentDisplayName } from '@/lib/documentTitles';
import {
  type Annotation,
  DEFAULT_PDF_LAYOUT,
  type PdfLayout,
  type ReaderSelection,
  type StudyDocument,
  type TxtAnchor,
} from '@/types/domain';

import {
  DEFAULT_CARD_SIZE,
  ROOT_CARD_GAP,
  ROOT_COLUMN_MAX_BOTTOM,
} from '@/features/mindmap/placement';
import {
  createStudySyncStore,
  DEFAULT_NOTEBOOK_TITLE,
  nextNodePosition,
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
  selectNestingTargetTitle,
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

    it('tracks parent title for nested excerpts and clears target independently of selection (#127)', async () => {
      const documentId = await openDocument();
      select(documentId, 'Topic card');
      await state().excerptSelection();
      const parentNode = state().nodes[0];
      expect(parentNode).toBeDefined();
      expect(state().lastExcerptParentTitle).toBeNull();
      expect(state().revealRequest?.parentTitle).toBeUndefined();
      expect(
        selectNestingTargetTitle(state().nodes, state().cards, state().nestingTargetNodeId),
      ).toBeNull();

      // Jumping to source does not set the nesting target.
      state().jumpToNode(parentNode!.id);
      expect(state().nestingTargetNodeId).toBeNull();

      // setSelectedNode highlights visually without changing the nesting target.
      state().setSelectedNode(parentNode!.id);
      expect(state().selectedNodeId).toBe(parentNode!.id);
      expect(state().nestingTargetNodeId).toBeNull();

      // Deliberately selecting the card sets the nesting target and resolves its title.
      state().selectNode(parentNode!.id);
      expect(
        selectNestingTargetTitle(state().nodes, state().cards, state().nestingTargetNodeId),
      ).toBe('Topic card');

      select(documentId, 'Nested detail');
      await state().excerptSelection();
      expect(state().lastExcerptParentTitle).toBe('Topic card');
      expect(state().revealRequest?.parentTitle).toBe('Topic card');
      expect(state().nodes[1]?.parentNodeId).toBe(parentNode!.id);

      // Clearing the nesting target leaves selectedNodeId intact and makes the next excerpt a root.
      const childId = state().nodes[1]!.id;
      expect(state().selectedNodeId).toBe(childId);
      state().setNestingTarget(null);
      expect(state().nestingTargetNodeId).toBeNull();
      expect(state().selectedNodeId).toBe(childId);
      // Earlier revealRequest retains the parent title captured when that excerpt was created.
      expect(state().revealRequest?.parentTitle).toBe('Topic card');

      select(documentId, 'Independent root');
      await state().excerptSelection();
      expect(state().nodes[2]?.parentNodeId).toBeNull();
      expect(state().lastExcerptParentTitle).toBeNull();
      expect(state().revealRequest?.parentTitle).toBeUndefined();
    });

    it('uses reported DOM sizes and capture estimates so consecutive root excerpts never overlap (#128)', async () => {
      const documentId = await openDocument();
      const heights = [56, 180, 92, 220, 64, 140, 78, 160, 60, 110];
      for (let i = 0; i < heights.length; i += 1) {
        select(documentId, `Excerpt ${i + 1}`);
        await state().excerptSelection();
        const created = state().nodes.at(-1)!;
        state().reportNodeSizes({ [created.id]: { width: 240, height: heights[i]! } });
      }

      const placed = state().nodes.map((n, index) => ({
        x: n.posX,
        y: n.posY,
        width: 240,
        height: heights[index]!,
      }));
      expect(placed).toHaveLength(10);
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = placed[i]!;
          const b = placed[j]!;
          const overlaps =
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y;
          expect(overlaps, `cards ${i} and ${j} must not overlap`).toBe(false);
        }
      }
    });

    it('reserves at least thumbnail-inclusive height for capture cards even after an early shorter measurement (#128)', async () => {
      const documentId = await openDocument();
      // Create a PDF capture card with a real 1x1 PNG.
      state().setSelection({
        documentId,
        anchor: pdfAnchor as ReaderSelection['anchor'],
        text: null,
        imagePng:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      });
      await state().excerptSelection();
      const captureNode = state().nodes[0]!;
      const savedPos = { x: captureNode.posX, y: captureNode.posY };

      // Simulate an early pre-thumbnail DOM measurement (78 px) before the capture expands to ~148 px.
      state().reportNodeSizes({ [captureNode.id]: { width: 240, height: 78 } });

      select(documentId, 'Follow-up text root');
      await state().excerptSelection();
      const textNode = state().nodes[1]!;

      // Original capture card position stays untouched.
      expect({ x: state().nodes[0]!.posX, y: state().nodes[0]!.posY }).toEqual(savedPos);
      // Even when the capture card renders at 148 px (or full 220 px estimate), the text card clears it.
      const captureBottom = captureNode.posY + 148;
      const separated =
        textNode.posX >= captureNode.posX + 240 + ROOT_CARD_GAP ||
        textNode.posY >= captureBottom + ROOT_CARD_GAP;
      expect(separated).toBe(true);
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

    it('hides documents from selectRecentDocuments while preserving records and restores on reopen', async () => {
      const firstId = await openDocument();
      const secondId = await openDocument();
      await state().addBookmark(firstId, pdfAnchor as ReaderSelection['anchor'], 'Keep me');
      state().closeDocument(firstId);

      await state().hideRecentDocument(firstId);
      // Hidden document remains in `documents` and keeps its bookmarks, but disappears from Recent.
      expect(state().documents.some((doc) => doc.id === firstId)).toBe(true);
      expect(state().bookmarks.some((bm) => bm.documentId === firstId)).toBe(true);
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).toEqual([secondId]);

      // Reopening restores it to Recent.
      await state().reopenRecentDocument(firstId);
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).toEqual([
        firstId,
        secondId,
      ]);
    });

    it('reports metadata displayTitle, skips redundant writes, and ignores backend errors (#129)', async () => {
      const docId = await openDocument();
      const fileHash = state().documents.find((d) => d.id === docId)!.fileHash;
      const spy = vi.spyOn(backend, 'setDocumentDisplayTitle');

      await state().reportDocumentTitle(docId, 'Pride and Prejudice', fileHash);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(state().documents.find((d) => d.id === docId)?.displayTitle).toBe(
        'Pride and Prejudice',
      );

      // Identical displayTitle is a no-op.
      await state().reportDocumentTitle(docId, 'Pride and Prejudice', fileHash);
      expect(spy).toHaveBeenCalledTimes(1);

      // Mismatched expectedFileHash is a no-op.
      await state().reportDocumentTitle(docId, 'Stale Hash Title', 'wrong-hash');
      expect(spy).toHaveBeenCalledTimes(1);

      // Unknown document id is a no-op.
      await state().reportDocumentTitle('missing-doc', 'Ignored', 'any-hash');
      expect(spy).toHaveBeenCalledTimes(1);

      // Persistence errors do not populate `state.error`.
      spy.mockRejectedValueOnce(new Error('disk full'));
      await state().reportDocumentTitle(docId, 'New Title', fileHash);
      expect(state().error).toBeNull();
      expect(state().documents.find((d) => d.id === docId)?.displayTitle).toBe(
        'Pride and Prejudice',
      );
      spy.mockRestore();
    });

    it('ignores a stale reportDocumentTitle response that committed before relinkDocument changed the source (#129)', async () => {
      const customBackend = createMemoryBackend({
        library: {
          '/t/old-name.txt': new TextEncoder().encode('old content'),
          '/t/new-name.txt': new TextEncoder().encode('new content'),
        },
      });
      const customStore = createStudySyncStore(customBackend);
      await customStore.getState().initialize();
      await customStore.getState().openDocument();
      const docId = customStore.getState().activeDocumentId as string;
      const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

      const originalSetTitle = customBackend.setDocumentDisplayTitle.bind(customBackend);
      let releaseTitle!: () => void;
      const titleGate = new Promise<void>((resolve) => {
        releaseTitle = resolve;
      });
      let committed = false;
      const titleSpy = vi
        .spyOn(customBackend, 'setDocumentDisplayTitle')
        .mockImplementationOnce(async (id, title, expectedHash) => {
          const updated = await originalSetTitle(id, title, expectedHash);
          committed = true;
          await titleGate;
          return updated;
        });

      const reportPromise = customStore
        .getState()
        .reportDocumentTitle(docId, 'Old Embedded Title', oldHash);
      await vi.waitFor(() => expect(committed).toBe(true));

      const relinked = await customStore.getState().relinkDocument(docId, false);
      expect(relinked?.contentChanged).toBe(true);
      expect(relinked?.document.fileHash).not.toBe(oldHash);

      releaseTitle();
      await reportPromise;

      const afterStoreDoc = customStore.getState().documents.find((d) => d.id === docId)!;
      expect(afterStoreDoc.displayTitle).toBeNull();
      expect(documentDisplayName(afterStoreDoc)).toBe('new-name');
      expect(
        (await customBackend.listDocuments()).find((d) => d.id === docId)?.displayTitle,
      ).toBeNull();

      const restarted = createStudySyncStore(customBackend);
      await restarted.getState().initialize();
      const restartedDoc = restarted.getState().documents.find((d) => d.id === docId)!;
      expect(restartedDoc.displayTitle).toBeNull();
      expect(documentDisplayName(restartedDoc)).toBe('new-name');
      titleSpy.mockRestore();
    });

    it('rejects a delayed reportDocumentTitle request that executes after relinkDocument changed the source (#129)', async () => {
      const customBackend = createMemoryBackend({
        library: {
          '/t/old-name.txt': new TextEncoder().encode('old content'),
          '/t/new-name.txt': new TextEncoder().encode('new content'),
        },
      });
      const customStore = createStudySyncStore(customBackend);
      await customStore.getState().initialize();
      await customStore.getState().openDocument();
      const docId = customStore.getState().activeDocumentId as string;
      const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

      const originalSetTitle = customBackend.setDocumentDisplayTitle.bind(customBackend);
      let releaseTitle!: () => void;
      const titleGate = new Promise<void>((resolve) => {
        releaseTitle = resolve;
      });
      const titleSpy = vi
        .spyOn(customBackend, 'setDocumentDisplayTitle')
        .mockImplementationOnce(async (id, title, expectedHash) => {
          await titleGate;
          return originalSetTitle(id, title, expectedHash);
        });

      const reportPromise = customStore
        .getState()
        .reportDocumentTitle(docId, 'Old Embedded Title', oldHash);
      await vi.waitFor(() => expect(titleSpy).toHaveBeenCalledTimes(1));

      const relinked = await customStore.getState().relinkDocument(docId, false);
      expect(relinked?.contentChanged).toBe(true);
      expect(relinked?.document.fileHash).not.toBe(oldHash);

      releaseTitle();
      await reportPromise;

      const rejectedResult = await titleSpy.mock.results[0]!.value;
      expect(rejectedResult).toBeNull();

      const afterStoreDoc = customStore.getState().documents.find((d) => d.id === docId)!;
      expect(afterStoreDoc.displayTitle).toBeNull();
      expect(documentDisplayName(afterStoreDoc)).toBe('new-name');
      expect(
        (await customBackend.listDocuments()).find((d) => d.id === docId)?.displayTitle,
      ).toBeNull();

      const restarted = createStudySyncStore(customBackend);
      await restarted.getState().initialize();
      const restartedDoc = restarted.getState().documents.find((d) => d.id === docId)!;
      expect(restartedDoc.displayTitle).toBeNull();
      expect(documentDisplayName(restartedDoc)).toBe('new-name');
      titleSpy.mockRestore();
    });

    it('keeps locationLabel on same-hash rename and clears active + undoable labels immediately on content-changing relink (#125)', async () => {
      const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
      const revisedBytes = new TextEncoder().encode('Revised content without old chapter.\n');
      const customBackend = createMemoryBackend({
        library: {
          '/t/original.txt': originalBytes,
          '/t/renamed.txt': originalBytes,
          '/t/revised.txt': revisedBytes,
        },
      });
      const customStore = createStudySyncStore(customBackend);
      await customStore.getState().initialize();
      await customStore.getState().openDocument();
      const docId = customStore.getState().activeDocumentId as string;

      customStore.getState().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
        text: 'Old chapter',
        imagePng: null,
        locationLabel: 'Old chapter · Line 1',
      });
      await customStore.getState().excerptSelection();
      const activeAnnId = customStore.getState().annotations[0]!.id;

      customStore.getState().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 12, endByteOffset: 20, lineIndex: 1 },
        text: 'Line one',
        imagePng: null,
        locationLabel: 'Old chapter · Line 2',
      });
      await customStore.getState().excerptSelection();
      const deletedAnnId = customStore.getState().annotations[1]!.id;
      await customStore.getState().removeAnnotation(deletedAnnId);

      // Same-hash relink (rename) keeps locationLabel intact.
      const renamed = await customStore.getState().relinkDocument(docId, false);
      expect(renamed?.contentChanged).toBe(false);
      expect(
        customStore.getState().annotations.find((a) => a.id === activeAnnId)?.locationLabel,
      ).toBe('Old chapter · Line 1');

      // Content-changing relink clears locationLabel immediately in live state and undo history.
      const revised = await customStore.getState().relinkDocument(docId, false);
      expect(revised?.contentChanged).toBe(true);
      expect(
        customStore.getState().annotations.find((a) => a.id === activeAnnId)?.locationLabel,
      ).toBeNull();
      expect(
        customStore.getState().deletedAnnotationHistory[0]?.annotation.locationLabel,
      ).toBeNull();

      // Undoing the deleted annotation restores it with locationLabel cleared.
      await customStore.getState().undoRemoveAnnotation();
      expect(
        customStore.getState().annotations.find((a) => a.id === deletedAnnId)?.locationLabel,
      ).toBeNull();

      // Reopening the workspace keeps both annotations cleared to document-title-only attribution.
      const reopened = createStudySyncStore(customBackend);
      await reopened.getState().initialize();
      expect(
        reopened.getState().annotations.find((a) => a.id === activeAnnId)?.locationLabel,
      ).toBeNull();
      expect(
        reopened.getState().annotations.find((a) => a.id === deletedAnnId)?.locationLabel,
      ).toBeNull();
    });

    it('reconciles late excerpt response arriving after content-changing relink, and rejects stale excerpt submitted after relink (#125)', async () => {
      const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
      const revisedBytes = new TextEncoder().encode('Completely rewritten document.\n');

      // Order 1: old excerpt commits in backend BEFORE relink, but its response arrives AFTER relink.
      {
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        let releaseExcerptResponse!: () => void;
        let excerptCommitted!: () => void;
        const excerptCommittedPromise = new Promise<void>((resolve) => {
          excerptCommitted = resolve;
        });
        const responseGate = new Promise<void>((resolve) => {
          releaseExcerptResponse = resolve;
        });
        const excerptSpy = vi
          .spyOn(customBackend, 'createExcerpt')
          .mockImplementationOnce(async (input) => {
            const result = await origCreateExcerpt(input);
            excerptCommitted();
            await responseGate;
            return result;
          });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const excerptPromise = customStore.getState().excerptSelection();
        await excerptCommittedPromise;

        // Relink commits and completes in UI before the excerpt response returns.
        const relinked = await customStore.getState().relinkDocument(docId, false);
        expect(relinked?.contentChanged).toBe(true);

        // Now deliver the late excerpt response (whose snapshot still carried the old locationLabel).
        releaseExcerptResponse();
        await excerptPromise;
        excerptSpy.mockRestore();

        // Live store state and reloaded workspace must both have locationLabel === null.
        expect(customStore.getState().annotations).toHaveLength(1);
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();
        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations).toHaveLength(1);
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // Order 2: relink commits in backend BEFORE the old excerpt reaches backend -> backend rejects it.
      {
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        let allowExcerptWrite!: () => void;
        let excerptStarted!: () => void;
        const excerptStartedPromise = new Promise<void>((resolve) => {
          excerptStarted = resolve;
        });
        const writeGate = new Promise<void>((resolve) => {
          allowExcerptWrite = resolve;
        });
        const excerptSpy = vi
          .spyOn(customBackend, 'createExcerpt')
          .mockImplementationOnce(async (input) => {
            excerptStarted();
            await writeGate;
            return origCreateExcerpt(input);
          });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const excerptPromise = customStore.getState().excerptSelection();
        await excerptStartedPromise;

        // Relink commits first, changing the document hash in backend.
        const relinked = await customStore.getState().relinkDocument(docId, false);
        expect(relinked?.contentChanged).toBe(true);

        // Now let the stale excerpt reach backend; expectedFileHash mismatch rejects it.
        allowExcerptWrite();
        await excerptPromise;
        excerptSpy.mockRestore();

        expect(customStore.getState().annotations).toHaveLength(0);
        expect(customStore.getState().cards).toHaveLength(0);
        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations).toHaveLength(0);
      }

      // Order 3: same-hash relink (rename) overlapping with excerpt still succeeds and preserves locationLabel.
      {
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/renamed.txt': originalBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const hash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        let releaseExcerptResponse!: () => void;
        let excerptCommitted!: () => void;
        const excerptCommittedPromise = new Promise<void>((resolve) => {
          excerptCommitted = resolve;
        });
        const responseGate = new Promise<void>((resolve) => {
          releaseExcerptResponse = resolve;
        });
        vi.spyOn(customBackend, 'createExcerpt').mockImplementationOnce(async (input) => {
          const result = await origCreateExcerpt(input);
          excerptCommitted();
          await responseGate;
          return result;
        });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: hash,
        });
        const excerptPromise = customStore.getState().excerptSelection();
        await excerptCommittedPromise;

        const renamed = await customStore.getState().relinkDocument(docId, false);
        expect(renamed?.contentChanged).toBe(false);
        releaseExcerptResponse();
        await excerptPromise;

        expect(customStore.getState().annotations[0]?.locationLabel).toBe('Old chapter · Line 1');
        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.locationLabel).toBe('Old chapter · Line 1');
      }
    });

    it('reconciles late updateAnnotation, createAnnotation, and undoRemoveAnnotation responses after content-changing relink (#125)', async () => {
      const originalBytes = new TextEncoder().encode('Old chapter\nLine one\nLine two\n');
      const revisedBytes = new TextEncoder().encode('Revised file.\n');
      const customBackend = createMemoryBackend({
        library: {
          '/t/original.txt': originalBytes,
          '/t/revised.txt': revisedBytes,
        },
      });
      const customStore = createStudySyncStore(customBackend);
      await customStore.getState().initialize();
      await customStore.getState().openDocument();
      const docId = customStore.getState().activeDocumentId as string;
      const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

      // Seed two annotations: one to update, one to delete+undo.
      customStore.getState().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
        text: 'Old chapter',
        imagePng: null,
        locationLabel: 'Old chapter · Line 1',
        sourceFileHash: oldHash,
      });
      const toUpdate = (await customStore.getState().createAnnotationFromSelection())!;

      customStore.getState().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 12, endByteOffset: 20, lineIndex: 1 },
        text: 'Line one',
        imagePng: null,
        locationLabel: 'Old chapter · Line 2',
        sourceFileHash: oldHash,
      });
      const toUndo = (await customStore.getState().createAnnotationFromSelection())!;
      await customStore.getState().removeAnnotation(toUndo.id);

      // Hold responses for updateAnnotation, restoreAnnotation, and a new createAnnotation until after relink.
      const origUpdate = customBackend.updateAnnotation.bind(customBackend);
      const origRestore = customBackend.restoreAnnotation.bind(customBackend);
      const origCreate = customBackend.createAnnotation.bind(customBackend);
      let releaseAll!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseAll = resolve;
      });
      let updateCommitted!: () => void;
      let restoreCommitted!: () => void;
      let createCommitted!: () => void;
      const allCommitted = Promise.all([
        new Promise<void>((r) => {
          updateCommitted = r;
        }),
        new Promise<void>((r) => {
          restoreCommitted = r;
        }),
        new Promise<void>((r) => {
          createCommitted = r;
        }),
      ]);

      vi.spyOn(customBackend, 'updateAnnotation').mockImplementationOnce(async (id, patch) => {
        const res = await origUpdate(id, patch);
        updateCommitted();
        await gate;
        return res;
      });
      vi.spyOn(customBackend, 'restoreAnnotation').mockImplementationOnce(async (id) => {
        const res = await origRestore(id);
        restoreCommitted();
        await gate;
        return res;
      });
      vi.spyOn(customBackend, 'createAnnotation').mockImplementationOnce(async (input) => {
        const res = await origCreate(input);
        createCommitted();
        await gate;
        return res;
      });

      customStore.getState().setSelection({
        documentId: docId,
        anchor: { format: 'txt', startByteOffset: 21, endByteOffset: 29, lineIndex: 2 },
        text: 'Line two',
        imagePng: null,
        locationLabel: 'Old chapter · Line 3',
        sourceFileHash: oldHash,
      });

      const updatePromise = customStore
        .getState()
        .updateAnnotation(toUpdate.id, { note: 'kept note', color: null });
      const undoPromise = customStore.getState().undoRemoveAnnotation();
      const createPromise = customStore.getState().createAnnotationFromSelection();
      await allCommitted;

      // Content-changing relink commits in backend and clears all location labels.
      const relinked = await customStore.getState().relinkDocument(docId, false);
      expect(relinked?.contentChanged).toBe(true);

      // Deliver all three late responses.
      releaseAll();
      const [, , createdLate] = await Promise.all([updatePromise, undoPromise, createPromise]);
      expect(createdLate?.locationLabel).toBeNull();

      // Every annotation in live state has locationLabel: null while preserving the note edit.
      const liveAnnotations = customStore.getState().annotations;
      expect(liveAnnotations).toHaveLength(3);
      expect(liveAnnotations.find((a) => a.id === toUpdate.id)?.note).toBe('kept note');
      for (const ann of liveAnnotations) {
        expect(ann.locationLabel).toBeNull();
      }

      // Reloaded workspace agrees.
      const reopened = createStudySyncStore(customBackend);
      await reopened.getState().initialize();
      expect(reopened.getState().annotations).toHaveLength(3);
      for (const ann of reopened.getState().annotations) {
        expect(ann.locationLabel).toBeNull();
      }
    });

    it('never writes stale locationLabel when excerpt/annotation/update/undo and content-changing relink resolve in the same turn (#125)', async () => {
      // 1) Excerpt + content-changing relink delivered synchronously in the same turn.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Completely revised content.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        const origRelink = customBackend.relinkDocument.bind(customBackend);
        let releaseExcerpt!: () => void;
        let releaseRelink!: () => void;
        let excerptCommitted!: () => void;
        let relinkCommitted!: () => void;
        const excerptGate = new Promise<void>((r) => {
          releaseExcerpt = r;
        });
        const relinkGate = new Promise<void>((r) => {
          releaseRelink = r;
        });
        const waitExcerptCommitted = new Promise<void>((r) => {
          excerptCommitted = r;
        });
        const waitRelinkCommitted = new Promise<void>((r) => {
          relinkCommitted = r;
        });

        vi.spyOn(customBackend, 'createExcerpt').mockImplementationOnce(async (input) => {
          const result = await origCreateExcerpt(input);
          excerptCommitted();
          await excerptGate;
          return result;
        });
        vi.spyOn(customBackend, 'relinkDocument').mockImplementationOnce(
          async (id, confirmInPlace) => {
            const result = await origRelink(id, confirmInPlace);
            relinkCommitted();
            await relinkGate;
            return result;
          },
        );

        // Track every store transition after the document hash changes: stale label must never appear.
        let sawStaleLabelAfterHashChange = false;
        const unsubscribe = customStore.subscribe((next) => {
          const doc = next.documents.find((d) => d.id === docId);
          if (doc && doc.fileHash !== oldHash) {
            if (next.annotations.some((ann) => ann.locationLabel !== null)) {
              sawStaleLabelAfterHashChange = true;
            }
          }
        });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });

        // Commit excerpt in backend first, then commit content-changing relink in backend.
        const excerptPromise = customStore.getState().excerptSelection();
        await waitExcerptCommitted;
        const relinkPromise = customStore.getState().relinkDocument(docId, false);
        await waitRelinkCommitted;

        // Deliver excerpt response THEN relink response in the exact same turn.
        releaseExcerpt();
        releaseRelink();
        const [, relinked] = await Promise.all([excerptPromise, relinkPromise]);
        unsubscribe();

        expect(relinked?.contentChanged).toBe(true);
        expect(sawStaleLabelAfterHashChange).toBe(false);
        expect(customStore.getState().annotations).toHaveLength(1);
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations).toHaveLength(1);
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // 2) Standalone createAnnotation, updateAnnotation, and undoRemoveAnnotation delivered
      // in the same turn right ahead of content-changing relink.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\nLine two\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const toUpdate = (await customStore.getState().createAnnotationFromSelection())!;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 12, endByteOffset: 20, lineIndex: 1 },
          text: 'Line one',
          imagePng: null,
          locationLabel: 'Old chapter · Line 2',
          sourceFileHash: oldHash,
        });
        const toUndo = (await customStore.getState().createAnnotationFromSelection())!;
        await customStore.getState().removeAnnotation(toUndo.id);

        const origCreate = customBackend.createAnnotation.bind(customBackend);
        const origUpdate = customBackend.updateAnnotation.bind(customBackend);
        const origRestore = customBackend.restoreAnnotation.bind(customBackend);
        const origRelink = customBackend.relinkDocument.bind(customBackend);
        let releaseWrites!: () => void;
        let releaseRelink!: () => void;
        const writesGate = new Promise<void>((r) => {
          releaseWrites = r;
        });
        const relinkGate = new Promise<void>((r) => {
          releaseRelink = r;
        });
        let createCommitted!: () => void;
        let updateCommitted!: () => void;
        let restoreCommitted!: () => void;
        let relinkCommitted!: () => void;
        const waitAllWritesCommitted = Promise.all([
          new Promise<void>((r) => {
            createCommitted = r;
          }),
          new Promise<void>((r) => {
            updateCommitted = r;
          }),
          new Promise<void>((r) => {
            restoreCommitted = r;
          }),
        ]);
        const waitRelinkCommitted = new Promise<void>((r) => {
          relinkCommitted = r;
        });

        vi.spyOn(customBackend, 'createAnnotation').mockImplementationOnce(async (input) => {
          const res = await origCreate(input);
          createCommitted();
          await writesGate;
          return res;
        });
        vi.spyOn(customBackend, 'updateAnnotation').mockImplementationOnce(async (id, patch) => {
          const res = await origUpdate(id, patch);
          updateCommitted();
          await writesGate;
          return res;
        });
        vi.spyOn(customBackend, 'restoreAnnotation').mockImplementationOnce(async (id) => {
          const res = await origRestore(id);
          restoreCommitted();
          await writesGate;
          return res;
        });
        vi.spyOn(customBackend, 'relinkDocument').mockImplementationOnce(
          async (id, confirmInPlace) => {
            const res = await origRelink(id, confirmInPlace);
            relinkCommitted();
            await relinkGate;
            return res;
          },
        );

        let sawStaleLabelAfterHashChange = false;
        const unsubscribe = customStore.subscribe((next) => {
          const doc = next.documents.find((d) => d.id === docId);
          if (doc && doc.fileHash !== oldHash) {
            if (next.annotations.some((ann) => ann.locationLabel !== null)) {
              sawStaleLabelAfterHashChange = true;
            }
          }
        });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 21, endByteOffset: 29, lineIndex: 2 },
          text: 'Line two',
          imagePng: null,
          locationLabel: 'Old chapter · Line 3',
          sourceFileHash: oldHash,
        });

        const createPromise = customStore.getState().createAnnotationFromSelection();
        const updatePromise = customStore
          .getState()
          .updateAnnotation(toUpdate.id, { note: 'same-turn note', color: null });
        const undoPromise = customStore.getState().undoRemoveAnnotation();
        await waitAllWritesCommitted;

        const relinkPromise = customStore.getState().relinkDocument(docId, false);
        await waitRelinkCommitted;

        // Deliver all three annotation write responses THEN relink in the same turn.
        releaseWrites();
        releaseRelink();
        const [created, , restored, relinked] = await Promise.all([
          createPromise,
          updatePromise,
          undoPromise,
          relinkPromise,
        ]);
        unsubscribe();

        expect(relinked?.contentChanged).toBe(true);
        expect(sawStaleLabelAfterHashChange).toBe(false);
        expect(created?.locationLabel).toBeNull();
        expect(restored?.locationLabel).toBeNull();

        const live = customStore.getState().annotations;
        expect(live).toHaveLength(3);
        expect(live.find((a) => a.id === toUpdate.id)?.note).toBe('same-turn note');
        for (const ann of live) {
          expect(ann.locationLabel).toBeNull();
        }

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations).toHaveLength(3);
        expect(reopened.getState().annotations.find((a) => a.id === toUpdate.id)?.note).toBe(
          'same-turn note',
        );
        for (const ann of reopened.getState().annotations) {
          expect(ann.locationLabel).toBeNull();
        }
      }

      // 3) Same-turn same-hash relink (rename) preserves locationLabel in live state and reload.
      {
        const bytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': bytes,
            '/t/renamed.txt': bytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const hash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        const origRelink = customBackend.relinkDocument.bind(customBackend);
        let releaseExcerpt!: () => void;
        let releaseRelink!: () => void;
        let excerptCommitted!: () => void;
        let relinkCommitted!: () => void;
        const excerptGate = new Promise<void>((r) => {
          releaseExcerpt = r;
        });
        const relinkGate = new Promise<void>((r) => {
          releaseRelink = r;
        });
        const waitExcerptCommitted = new Promise<void>((r) => {
          excerptCommitted = r;
        });
        const waitRelinkCommitted = new Promise<void>((r) => {
          relinkCommitted = r;
        });

        vi.spyOn(customBackend, 'createExcerpt').mockImplementationOnce(async (input) => {
          const res = await origCreateExcerpt(input);
          excerptCommitted();
          await excerptGate;
          return res;
        });
        vi.spyOn(customBackend, 'relinkDocument').mockImplementationOnce(
          async (id, confirmInPlace) => {
            const res = await origRelink(id, confirmInPlace);
            relinkCommitted();
            await relinkGate;
            return res;
          },
        );

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: hash,
        });

        const excerptPromise = customStore.getState().excerptSelection();
        await waitExcerptCommitted;
        const relinkPromise = customStore.getState().relinkDocument(docId, false);
        await waitRelinkCommitted;

        releaseExcerpt();
        releaseRelink();
        const [, relinked] = await Promise.all([excerptPromise, relinkPromise]);

        expect(relinked?.contentChanged).toBe(false);
        expect(customStore.getState().annotations[0]?.locationLabel).toBe('Old chapter · Line 1');

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.locationLabel).toBe('Old chapter · Line 1');
      }
    });

    it('preserves newer annotation edits when a relink locationLabel refresh delivers an older snapshot (#125)', async () => {
      // 1) Excerpt + same-turn relink -> refresh reads old snapshot (note: null) -> user saves
      // "Newest note" -> delayed refresh snapshot arrives -> live state and reload both keep
      // "Newest note" while locationLabel stays null.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreateExcerpt = customBackend.createExcerpt.bind(customBackend);
        const origRelink = customBackend.relinkDocument.bind(customBackend);
        const origLoadGraph = customBackend.loadNotebookGraph.bind(customBackend);

        let releaseExcerpt!: () => void;
        let releaseRelink!: () => void;
        let releaseRefresh!: () => void;
        let excerptCommitted!: () => void;
        let relinkCommitted!: () => void;
        let refreshReadOldSnapshot!: () => void;

        const excerptGate = new Promise<void>((r) => {
          releaseExcerpt = r;
        });
        const relinkGate = new Promise<void>((r) => {
          releaseRelink = r;
        });
        const refreshGate = new Promise<void>((r) => {
          releaseRefresh = r;
        });
        const waitExcerptCommitted = new Promise<void>((r) => {
          excerptCommitted = r;
        });
        const waitRelinkCommitted = new Promise<void>((r) => {
          relinkCommitted = r;
        });
        const waitRefreshReadOldSnapshot = new Promise<void>((r) => {
          refreshReadOldSnapshot = r;
        });

        vi.spyOn(customBackend, 'createExcerpt').mockImplementationOnce(async (input) => {
          const result = await origCreateExcerpt(input);
          excerptCommitted();
          await excerptGate;
          return result;
        });
        vi.spyOn(customBackend, 'relinkDocument').mockImplementationOnce(
          async (id, confirmInPlace) => {
            const result = await origRelink(id, confirmInPlace);
            relinkCommitted();
            await relinkGate;
            return result;
          },
        );
        vi.spyOn(customBackend, 'loadNotebookGraph').mockImplementationOnce(async (notebookId) => {
          const snapshot = await origLoadGraph(notebookId);
          expect(snapshot.annotations[0]?.note).toBeNull();
          expect(snapshot.annotations[0]?.locationLabel).toBeNull();
          refreshReadOldSnapshot();
          await refreshGate;
          return snapshot;
        });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });

        const excerptPromise = customStore.getState().excerptSelection();
        await waitExcerptCommitted;
        const relinkPromise = customStore.getState().relinkDocument(docId, false);
        await waitRelinkCommitted;

        // Deliver excerpt then relink in the same turn so refresh starts after synchronous commit.
        releaseExcerpt();
        releaseRelink();
        await relinkPromise;
        await waitRefreshReadOldSnapshot;

        // While the refresh holds the older snapshot (note: null), save "Newest note".
        const annotationId = customStore.getState().annotations[0]!.id;
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();
        await customStore
          .getState()
          .updateAnnotation(annotationId, { note: 'Newest note', color: null });
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        // Deliver the delayed refresh snapshot: must NOT roll back "Newest note".
        releaseRefresh();
        await excerptPromise;

        expect(customStore.getState().annotations).toHaveLength(1);
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        // Reloading from backend agrees.
        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations).toHaveLength(1);
        expect(reopened.getState().annotations[0]?.note).toBe('Newest note');
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // 2) Same delayed refresh on createAnnotationFromSelection returns the merged record
      // with the newer note, and a deleted annotation is never resurrected by a late refresh.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        const origCreate = customBackend.createAnnotation.bind(customBackend);
        const origRelink = customBackend.relinkDocument.bind(customBackend);
        const origLoadGraph = customBackend.loadNotebookGraph.bind(customBackend);

        let releaseCreate!: () => void;
        let releaseRelink!: () => void;
        let releaseRefresh!: () => void;
        let createCommitted!: () => void;
        let relinkCommitted!: () => void;
        let refreshReadOldSnapshot!: () => void;

        const createGate = new Promise<void>((r) => {
          releaseCreate = r;
        });
        const relinkGate = new Promise<void>((r) => {
          releaseRelink = r;
        });
        const refreshGate = new Promise<void>((r) => {
          releaseRefresh = r;
        });
        const waitCreateCommitted = new Promise<void>((r) => {
          createCommitted = r;
        });
        const waitRelinkCommitted = new Promise<void>((r) => {
          relinkCommitted = r;
        });
        const waitRefreshReadOldSnapshot = new Promise<void>((r) => {
          refreshReadOldSnapshot = r;
        });

        vi.spyOn(customBackend, 'createAnnotation').mockImplementationOnce(async (input) => {
          const result = await origCreate(input);
          createCommitted();
          await createGate;
          return result;
        });
        vi.spyOn(customBackend, 'relinkDocument').mockImplementationOnce(
          async (id, confirmInPlace) => {
            const result = await origRelink(id, confirmInPlace);
            relinkCommitted();
            await relinkGate;
            return result;
          },
        );
        vi.spyOn(customBackend, 'loadNotebookGraph').mockImplementationOnce(async (notebookId) => {
          const snapshot = await origLoadGraph(notebookId);
          refreshReadOldSnapshot();
          await refreshGate;
          return snapshot;
        });

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });

        const createPromise = customStore.getState().createAnnotationFromSelection();
        await waitCreateCommitted;
        const relinkPromise = customStore.getState().relinkDocument(docId, false);
        await waitRelinkCommitted;

        releaseCreate();
        releaseRelink();
        await relinkPromise;
        await waitRefreshReadOldSnapshot;

        const annotationId = customStore.getState().annotations[0]!.id;
        await customStore
          .getState()
          .updateAnnotation(annotationId, { note: 'Newest note', color: null });

        releaseRefresh();
        const created = await createPromise;
        expect(created?.note).toBe('Newest note');
        expect(created?.locationLabel).toBeNull();
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();
      }
    });

    it('guards overlapping pre-relink updateAnnotation responses against both succeeding and failing newer saves (#125)', async () => {
      // 1) Pre-relink save ("Older note") commits first with delayed response -> content-changing
      // relink -> newer save ("Newest note", new color & style) succeeds -> delayed older response
      // arrives and must NOT roll back the newer note, color, or style while keeping locationLabel null.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const created = (await customStore.getState().createAnnotationFromSelection())!;

        const origUpdate = customBackend.updateAnnotation.bind(customBackend);
        let releaseFirstSave!: () => void;
        let firstSaveCommitted!: () => void;
        const firstSaveGate = new Promise<void>((r) => {
          releaseFirstSave = r;
        });
        const waitFirstSaveCommitted = new Promise<void>((r) => {
          firstSaveCommitted = r;
        });

        vi.spyOn(customBackend, 'updateAnnotation').mockImplementationOnce(async (id, patch) => {
          const result = await origUpdate(id, patch);
          firstSaveCommitted();
          await firstSaveGate;
          return result;
        });

        // Start pre-relink save ("Older note") and pause its response after backend commit.
        const firstSavePromise = customStore.getState().updateAnnotation(created.id, {
          note: 'Older note',
          color: '#f59e0b',
          style: 'highlight',
        });
        await waitFirstSaveCommitted;

        // Complete content-changing relink, then save "Newest note" with updated color & style.
        const relinked = await customStore.getState().relinkDocument(docId, false);
        expect(relinked?.contentChanged).toBe(true);

        await customStore.getState().updateAnnotation(created.id, {
          note: 'Newest note',
          color: '#22c55e',
          style: 'underline',
        });
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.color).toBe('#22c55e');
        expect(customStore.getState().annotations[0]?.style).toBe('underline');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        // Deliver the older pre-relink save response: newer note/color/style must remain intact.
        releaseFirstSave();
        await firstSavePromise;

        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.color).toBe('#22c55e');
        expect(customStore.getState().annotations[0]?.style).toBe('underline');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.note).toBe('Newest note');
        expect(reopened.getState().annotations[0]?.color).toBe('#22c55e');
        expect(reopened.getState().annotations[0]?.style).toBe('underline');
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // 2) Pre-relink save ("Older note") commits first with delayed response -> content-changing
      // relink -> newer save FAILS -> delayed first response arrives and MUST still apply
      // "Older note" with locationLabel: null, matching the backend.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const created = (await customStore.getState().createAnnotationFromSelection())!;

        const origUpdate = customBackend.updateAnnotation.bind(customBackend);
        let releaseFirstSave!: () => void;
        let firstSaveCommitted!: () => void;
        const firstSaveGate = new Promise<void>((r) => {
          releaseFirstSave = r;
        });
        const waitFirstSaveCommitted = new Promise<void>((r) => {
          firstSaveCommitted = r;
        });

        vi.spyOn(customBackend, 'updateAnnotation')
          .mockImplementationOnce(async (id, patch) => {
            const result = await origUpdate(id, patch);
            firstSaveCommitted();
            await firstSaveGate;
            return result;
          })
          .mockRejectedValueOnce({ code: 'io', message: 'disk full' });

        const firstSavePromise = customStore.getState().updateAnnotation(created.id, {
          note: 'Older note',
          color: null,
        });
        await waitFirstSaveCommitted;

        const relinked = await customStore.getState().relinkDocument(docId, false);
        expect(relinked?.contentChanged).toBe(true);

        // Newer save fails in backend and must not advance the applied save sequence.
        await customStore.getState().updateAnnotation(created.id, {
          note: 'Failed note',
          color: null,
        });
        expect(customStore.getState().annotations[0]?.note).toBeNull();

        // Deliver the earlier succeeded save response: "Older note" applies with cleared locationLabel.
        releaseFirstSave();
        await firstSavePromise;

        expect(customStore.getState().annotations[0]?.note).toBe('Older note');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.note).toBe('Older note');
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // 3) Pre-relink save ("Older note") paused BEFORE writing to backend -> content-changing
      // relink -> newer save ("Newest note") commits to backend & UI -> older request unpauses
      // and commits to backend LAST -> backend is reconciled back to "Newest note" so live state
      // and reloaded workspace stay consistent with locationLabel: null.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const created = (await customStore.getState().createAnnotationFromSelection())!;

        const origUpdate = customBackend.updateAnnotation.bind(customBackend);
        let releaseFirstWrite!: () => void;
        let firstWritePaused!: () => void;
        const firstWriteGate = new Promise<void>((r) => {
          releaseFirstWrite = r;
        });
        const waitFirstWritePaused = new Promise<void>((r) => {
          firstWritePaused = r;
        });

        vi.spyOn(customBackend, 'updateAnnotation').mockImplementationOnce(async (id, patch) => {
          firstWritePaused();
          await firstWriteGate;
          return origUpdate(id, patch);
        });

        // Start pre-relink save ("Older note") and pause it BEFORE backend write executes.
        const firstSavePromise = customStore.getState().updateAnnotation(created.id, {
          note: 'Older note',
          color: '#f59e0b',
          style: 'highlight',
        });
        await waitFirstWritePaused;

        // Complete content-changing relink, then save "Newest note" to backend and UI.
        const relinked = await customStore.getState().relinkDocument(docId, false);
        expect(relinked?.contentChanged).toBe(true);

        await customStore.getState().updateAnnotation(created.id, {
          note: 'Newest note',
          color: '#22c55e',
          style: 'underline',
        });
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.color).toBe('#22c55e');
        expect(customStore.getState().annotations[0]?.style).toBe('underline');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        // Release the older request so it writes to the backend LAST.
        releaseFirstWrite();
        await firstSavePromise;

        // Both live state and reloaded backend state must agree on "Newest note" and locationLabel: null.
        expect(customStore.getState().annotations[0]?.note).toBe('Newest note');
        expect(customStore.getState().annotations[0]?.color).toBe('#22c55e');
        expect(customStore.getState().annotations[0]?.style).toBe('underline');
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.note).toBe('Newest note');
        expect(reopened.getState().annotations[0]?.color).toBe('#22c55e');
        expect(reopened.getState().annotations[0]?.style).toBe('underline');
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }

      // 4) Same late-commit order when the newer save explicitly cleared the note (`note: ''`):
      // backend must be reconciled back to `note: null` rather than keeping the older note.
      {
        const originalBytes = new TextEncoder().encode('Old chapter\nLine one\n');
        const revisedBytes = new TextEncoder().encode('Revised file.\n');
        const customBackend = createMemoryBackend({
          library: {
            '/t/original.txt': originalBytes,
            '/t/revised.txt': revisedBytes,
          },
        });
        const customStore = createStudySyncStore(customBackend);
        await customStore.getState().initialize();
        await customStore.getState().openDocument();
        const docId = customStore.getState().activeDocumentId as string;
        const oldHash = customStore.getState().documents.find((d) => d.id === docId)!.fileHash;

        customStore.getState().setSelection({
          documentId: docId,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
          text: 'Old chapter',
          imagePng: null,
          locationLabel: 'Old chapter · Line 1',
          sourceFileHash: oldHash,
        });
        const created = (await customStore
          .getState()
          .createAnnotationFromSelection({ note: 'Initial note' }))!;

        const origUpdate = customBackend.updateAnnotation.bind(customBackend);
        let releaseFirstWrite!: () => void;
        let firstWritePaused!: () => void;
        const firstWriteGate = new Promise<void>((r) => {
          releaseFirstWrite = r;
        });
        const waitFirstWritePaused = new Promise<void>((r) => {
          firstWritePaused = r;
        });

        vi.spyOn(customBackend, 'updateAnnotation').mockImplementationOnce(async (id, patch) => {
          firstWritePaused();
          await firstWriteGate;
          return origUpdate(id, patch);
        });

        const firstSavePromise = customStore.getState().updateAnnotation(created.id, {
          note: 'Older note',
          color: null,
        });
        await waitFirstWritePaused;

        await customStore.getState().relinkDocument(docId, false);
        await customStore.getState().updateAnnotation(created.id, {
          note: '',
          color: null,
        });
        expect(customStore.getState().annotations[0]?.note).toBeNull();

        releaseFirstWrite();
        await firstSavePromise;

        expect(customStore.getState().annotations[0]?.note).toBeNull();
        expect(customStore.getState().annotations[0]?.locationLabel).toBeNull();

        const reopened = createStudySyncStore(customBackend);
        await reopened.getState().initialize();
        expect(reopened.getState().annotations[0]?.note).toBeNull();
        expect(reopened.getState().annotations[0]?.locationLabel).toBeNull();
      }
    });

    it('keeps a document hidden when an older dropFiles response resolves after hideRecentDocument', async () => {
      const bytes = new TextEncoder().encode('drop-hide race');
      const file = new File([bytes], 'drop-race.txt', { type: 'text/plain' });
      await state().dropFiles([file]);
      const docId = state().activeDocumentId as string;
      state().closeDocument(docId);

      const originalDrop = backend.dropFiles.bind(backend);
      let releaseDrop!: () => void;
      const dropGate = new Promise<void>((resolve) => {
        releaseDrop = resolve;
      });
      let dropCommitted = false;
      const dropSpy = vi.spyOn(backend, 'dropFiles').mockImplementationOnce(async (files) => {
        const result = await originalDrop(files);
        dropCommitted = true;
        await dropGate;
        return result;
      });

      const dropPromise = state().dropFiles([file]);
      await vi.waitFor(() => expect(dropCommitted).toBe(true));

      await state().hideRecentDocument(docId);
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).not.toContain(docId);

      releaseDrop();
      await dropPromise;

      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).not.toContain(docId);
      const stored = state().documents.find((doc) => doc.id === docId)!;
      expect(stored.hiddenFromRecentAt).toBeTruthy();
      dropSpy.mockRestore();
    });

    it('guards Recent reconciliation reads against newer mutations and converges after delayed cancelled relinks', async () => {
      const firstId = await openDocument();
      state().closeDocument(firstId);

      // 1. Overlapped hide finishes before delayed cancelled relink -> cancelled relink converges to DB.
      const origHide = backend.hideDocumentFromRecent.bind(backend);
      let releaseHide!: () => void;
      const hideGate = new Promise<void>((resolve) => {
        releaseHide = resolve;
      });
      const hideSpy = vi
        .spyOn(backend, 'hideDocumentFromRecent')
        .mockImplementationOnce(async (id) => {
          const updated = await origHide(id);
          await hideGate;
          return updated;
        });

      let resolveRelink!: (value: null) => void;
      const relinkSpy = vi.spyOn(backend, 'relinkDocument').mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveRelink = resolve;
          }),
      );

      const hidePromise = state().hideRecentDocument(firstId);
      await vi.waitFor(() => expect(hideSpy).toHaveBeenCalledWith(firstId));

      const cancelledRelink = state().relinkDocument(firstId);
      await vi.waitFor(() => expect(relinkSpy).toHaveBeenCalledWith(firstId, false));

      releaseHide();
      await hidePromise;
      // Still hidden = false in store because cancelled relink has not finished yet.
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).toContain(firstId);

      // Cancelling relink drains active Recent ops and triggers authoritative DB convergence.
      resolveRelink(null);
      await cancelledRelink;
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).not.toContain(firstId);
      hideSpy.mockRestore();
      relinkSpy.mockRestore();

      // 2. A stale reconcile listDocuments read returning after a newer hide cannot restore visibility.
      const secondId = await openDocument();
      state().closeDocument(secondId);

      const origTouch = backend.touchDocumentOpened.bind(backend);
      let releaseTouch!: () => void;
      const touchGate = new Promise<void>((resolve) => {
        releaseTouch = resolve;
      });
      const touchSpy = vi
        .spyOn(backend, 'touchDocumentOpened')
        .mockImplementationOnce(async (id) => {
          const updated = await origTouch(id);
          await touchGate;
          return updated;
        });
      const relinkOverlapSpy = vi.spyOn(backend, 'relinkDocument').mockResolvedValueOnce(null);

      const reopenPromise = state().reopenRecentDocument(secondId);
      await vi.waitFor(() => expect(touchSpy).toHaveBeenCalledWith(secondId));
      await state().relinkDocument(secondId);

      // Delay the first reconcile read with the pre-hide unhidden snapshot.
      const staleSnapshot = (await backend.listDocuments()).map((doc) => ({ ...doc }));
      let resolveStaleRead!: (docs: StudyDocument[]) => void;
      const realListDocuments = backend.listDocuments.bind(backend);
      const listSpy = vi.spyOn(backend, 'listDocuments').mockImplementationOnce(
        () =>
          new Promise<StudyDocument[]>((resolve) => {
            resolveStaleRead = resolve;
          }),
      );

      releaseTouch();
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

      // While the first reconcile listDocuments is in flight, hide the document cleanly.
      const hideAfterPromise = state().hideRecentDocument(secondId);
      await hideAfterPromise;
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).not.toContain(secondId);

      // Now the stale unhidden read returns late -> must not overwrite the newer hidden state.
      resolveStaleRead(staleSnapshot);
      await reopenPromise;
      state().closeDocument(secondId);

      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).not.toContain(secondId);
      expect(
        (await realListDocuments()).find((doc) => doc.id === secondId)?.hiddenFromRecentAt,
      ).toBeTruthy();

      touchSpy.mockRestore();
      relinkOverlapSpy.mockRestore();
      listSpy.mockRestore();

      // 3. A stale post-unlock reconcile read returning after a newer reopen cannot re-hide the book.
      const thirdId = await openDocument();
      state().closeDocument(thirdId);

      const origTouch3 = backend.touchDocumentOpened.bind(backend);
      let touch3Committed = false;
      const touchSpy3 = vi
        .spyOn(backend, 'touchDocumentOpened')
        .mockImplementationOnce(async (id) => {
          const updated = await origTouch3(id);
          touch3Committed = true;
          return updated;
        });
      const origVerify3 = backend.verifyDocumentSource.bind(backend);
      let releaseVerify3!: () => void;
      const verifyGate3 = new Promise<void>((resolve) => {
        releaseVerify3 = resolve;
      });
      const verifySpy3 = vi
        .spyOn(backend, 'verifyDocumentSource')
        .mockImplementationOnce(async (id) => {
          await verifyGate3;
          return origVerify3(id);
        });

      const pendingReopen3 = state().reopenRecentDocument(thirdId);
      await vi.waitFor(() => expect(touch3Committed).toBe(true));
      await state().hideRecentDocument(thirdId);

      const releaseLock3 = state().lockDocument(thirdId);
      releaseVerify3();
      await pendingReopen3;

      const staleHiddenSnapshot = (await backend.listDocuments()).map((doc) => ({ ...doc }));
      let resolvePostUnlockRead!: (docs: StudyDocument[]) => void;
      const postUnlockListSpy = vi.spyOn(backend, 'listDocuments').mockImplementationOnce(
        () =>
          new Promise<StudyDocument[]>((resolve) => {
            resolvePostUnlockRead = resolve;
          }),
      );

      releaseLock3();
      await vi.waitFor(() => expect(postUnlockListSpy).toHaveBeenCalledTimes(1));

      // A newer reopen completes before the post-unlock reconcile read returns.
      await state().reopenRecentDocument(thirdId);
      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).toContain(thirdId);

      resolvePostUnlockRead(staleHiddenSnapshot);
      await Promise.resolve();
      await Promise.resolve();

      expect(selectRecentDocuments(state().documents).map((doc) => doc.id)).toContain(thirdId);
      expect(
        (await realListDocuments()).find((doc) => doc.id === thirdId)?.hiddenFromRecentAt,
      ).toBeNull();

      touchSpy3.mockRestore();
      verifySpy3.mockRestore();
      postUnlockListSpy.mockRestore();
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

  const rectsOverlap = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  it('places ten consecutive roots without any overlapping rectangles (#128)', () => {
    const nodes: ReturnType<typeof node>[] = [];
    for (let i = 0; i < 10; i += 1) {
      const pos = nextNodePosition(nodes, null);
      nodes.push(node(`r${i}`, null, pos.x, pos.y));
    }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        expect(
          rectsOverlap(
            { x: a.posX, y: a.posY, ...DEFAULT_CARD_SIZE },
            { x: b.posX, y: b.posY, ...DEFAULT_CARD_SIZE },
          ),
        ).toBe(false);
      }
    }
    // Wraps to a second column once the first column reaches the height cap.
    expect(new Set(nodes.map((n) => n.posX)).size).toBeGreaterThanOrEqual(2);
  });

  it('respects mixed measured card heights and wraps cleanly into columns (#128)', () => {
    const measuredHeights = [52, 240, 120, 190, 60, 260, 88, 150, 72, 130];
    const nodes: ReturnType<typeof node>[] = [];
    const nodeSizes: Record<string, { width: number; height: number }> = {};

    for (let i = 0; i < measuredHeights.length; i += 1) {
      const pos = nextNodePosition(nodes, null, { nodeSizes });
      const id = `mixed-${i}`;
      nodes.push(node(id, null, pos.x, pos.y));
      nodeSizes[id] = { width: 240, height: measuredHeights[i]! };
    }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const sizeA = nodeSizes[a.id]!;
        const sizeB = nodeSizes[b.id]!;
        expect(
          rectsOverlap(
            { x: a.posX, y: a.posY, width: sizeA.width, height: sizeA.height },
            { x: b.posX, y: b.posY, width: sizeB.width, height: sizeB.height },
          ),
        ).toBe(false);
      }
    }
    // Second card clears the first card's actual measured height + gap.
    expect(nodes[1]!.posY).toBe(nodes[0]!.posY + measuredHeights[0]! + ROOT_CARD_GAP);
    // Third card clears the tall 240px second card without overlapping it.
    expect(nodes[2]!.posY).toBe(nodes[1]!.posY + measuredHeights[1]! + ROOT_CARD_GAP);
    expect(nodes[2]!.posY + DEFAULT_CARD_SIZE.height).toBeLessThanOrEqual(ROOT_COLUMN_MAX_BOTTOM);
  });

  it('never lands on a surviving card after deleting one, and leaves existing positions untouched (#116, #128)', () => {
    const first = nextNodePosition([], null);
    const n1 = node('a', null, first.x, first.y);
    const second = nextNodePosition([n1], null);
    const n2 = node('b', null, second.x, second.y);
    const third = nextNodePosition([n1, n2], null);
    const n3 = node('c', null, third.x, third.y);

    // Delete middle card `n2`; next root fits cleanly without touching `n1` or `n3`.
    const replacement = nextNodePosition([n1, n3], null);
    const candidate = { x: replacement.x, y: replacement.y, ...DEFAULT_CARD_SIZE };
    expect(rectsOverlap(candidate, { x: n1.posX, y: n1.posY, ...DEFAULT_CARD_SIZE })).toBe(false);
    expect(rectsOverlap(candidate, { x: n3.posX, y: n3.posY, ...DEFAULT_CARD_SIZE })).toBe(false);

    // Even if `n1` grew tall enough to encroach on the vacated slot, placement skips past `n3`.
    const tallPlacement = nextNodePosition([n1, n3], null, {
      nodeSizes: { a: { width: 240, height: 220 }, c: { width: 240, height: 100 } },
    });
    const tallCandidate = { x: tallPlacement.x, y: tallPlacement.y, ...DEFAULT_CARD_SIZE };
    expect(rectsOverlap(tallCandidate, { x: n1.posX, y: n1.posY, width: 240, height: 220 })).toBe(
      false,
    );
    expect(rectsOverlap(tallCandidate, { x: n3.posX, y: n3.posY, width: 240, height: 100 })).toBe(
      false,
    );
  });

  it('avoids existing child subtrees when placing new root cards (#128)', () => {
    const root = node('r', null, 40, 40);
    const child = node('c', 'r', 360, 40);
    // Fill column 0 so root placement moves to column 1 (x = 300), which horizontally overlaps child (x = 360).
    const filler1 = node('f1', null, 40, 172);
    const filler2 = node('f2', null, 40, 304);
    const filler3 = node('f3', null, 40, 436);
    const placed = nextNodePosition([root, child, filler1, filler2, filler3], null);
    expect(
      rectsOverlap(
        { x: placed.x, y: placed.y, ...DEFAULT_CARD_SIZE },
        { x: child.posX, y: child.posY, ...DEFAULT_CARD_SIZE },
      ),
    ).toBe(false);
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

    // Three consecutive roots occupy distinct, non-overlapping positions (#128).
    const r1 = await addExcerpt('r1');
    const r2 = await addExcerpt('r2');
    const r3 = await addExcerpt('r3');
    expect(new Set([r1, r2, r3].map((n) => `${n.posX},${n.posY}`)).size).toBe(3);

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

    // Case 1: overlapping native drags (enter1 -> leave1 -> sync -> enter2 -> delayed drop1)
    // must never overwrite the synced progress with drop1's stale snapshot.
    emitDrop?.({ type: 'enter' });
    emitDrop?.({ type: 'leave' });
    await nativeStore.getState().withDocumentLock(docId, async () => {
      await nativeBackend.updateDocumentCursor(docId, syncedAnchor, 0.85);
      await nativeStore.getState().refreshDocument(docId);
    });
    // A second drag enters after sync unlocked, before the first drop payload arrives.
    emitDrop?.({ type: 'enter' });
    emitDrop?.({ type: 'drop', documents: [staleSnapshot], error: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      syncedAnchor,
    );
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.85);

    // Case 2: bare drop without preceding enter triggers a background refreshDocument that
    // reads old progress before a subsequent sync writes newer progress and unlocks.
    const newerAnchor = {
      format: 'pdf' as const,
      pageIndex: 14,
      rects: [{ x: 0, y: 0.7, width: 0.5, height: 0.05 }],
    };
    const beforeSecondSync = await nativeBackend.listDocuments();
    let resolveStaleRefresh!: (docs: StudyDocument[]) => void;
    const listSpy = vi.spyOn(nativeBackend, 'listDocuments').mockImplementationOnce(
      () =>
        new Promise<StudyDocument[]>((resolve) => {
          resolveStaleRefresh = resolve;
        }),
    );

    emitDrop?.({ type: 'drop', documents: [staleSnapshot], error: null });
    await Promise.resolve();

    // Next sync runs to completion while the drop-triggered refreshDocument is still in flight.
    await nativeStore.getState().withDocumentLock(docId, async () => {
      await nativeBackend.updateDocumentCursor(docId, newerAnchor, 0.95);
      await nativeStore.getState().refreshDocument(docId);
    });
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      newerAnchor,
    );

    // Stale background refreshDocument returns with the pre-sync list; it must not regress state.
    resolveStaleRefresh(beforeSecondSync);
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      newerAnchor,
    );
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.95);
    listSpy.mockRestore();
  });

  it('loads the authoritative moved filePath before opening a tab on native onFileDrop', async () => {
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
    await nativeStore.getState().openDocument(); // a.pdf
    await nativeStore.getState().openDocument(); // b.epub
    const epubId = nativeStore.getState().activeDocumentId as string;
    const originalEpub = nativeStore.getState().documents.find((d) => d.id === epubId)!;
    expect(originalEpub.format).toBe('epub');
    expect(originalEpub.filePath).toBe('/test/b.epub');

    nativeStore.getState().closeDocument(epubId);
    expect(nativeStore.getState().openDocumentIds).not.toContain(epubId);

    // Simulate the backend registering the moved EPUB at its new path.
    const movedEpub: StudyDocument = {
      ...originalEpub,
      filePath: '/moved/b.epub',
    };
    const existingDocs = await nativeBackend.listDocuments();
    let resolveList!: (docs: StudyDocument[]) => void;
    const listSpy = vi.spyOn(nativeBackend, 'listDocuments').mockImplementationOnce(
      () =>
        new Promise<StudyDocument[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    emitDrop?.({ type: 'enter' });
    emitDrop?.({ type: 'leave' });
    emitDrop?.({ type: 'drop', documents: [movedEpub], error: null });

    // Must NOT open the tab synchronously while the store still holds the old path.
    expect(nativeStore.getState().openDocumentIds).not.toContain(epubId);
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/test/b.epub',
    );

    // Once the authoritative DB record resolves, the tab opens directly on the new path.
    resolveList(existingDocs.map((d) => (d.id === epubId ? movedEpub : d)));
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().openDocumentIds).toContain(epubId);
    expect(nativeStore.getState().activeDocumentId).toBe(epubId);
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/moved/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(1);

    listSpy.mockRestore();
  });

  it('ignores an out-of-order earlier native drop listDocuments response so filePath does not regress', async () => {
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
    await nativeStore.getState().openDocument(); // a.pdf
    await nativeStore.getState().openDocument(); // b.epub
    const epubId = nativeStore.getState().activeDocumentId as string;
    const originalEpub = nativeStore.getState().documents.find((d) => d.id === epubId)!;
    nativeStore.getState().closeDocument(epubId);

    const existingDocs = await nativeBackend.listDocuments();
    const firstMoved: StudyDocument = { ...originalEpub, filePath: '/moved-first/b.epub' };
    const secondMoved: StudyDocument = { ...originalEpub, filePath: '/moved-second/b.epub' };

    let resolveFirst!: (docs: StudyDocument[]) => void;
    let resolveSecond!: (docs: StudyDocument[]) => void;
    const listSpy = vi
      .spyOn(nativeBackend, 'listDocuments')
      .mockImplementationOnce(
        () =>
          new Promise<StudyDocument[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<StudyDocument[]>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    // Drop 1 starts, then Drop 2 starts before Drop 1's listDocuments() returns.
    emitDrop?.({ type: 'drop', documents: [firstMoved], error: null });
    emitDrop?.({ type: 'drop', documents: [secondMoved], error: null });

    // Second response arrives first -> opens directly on the latest path.
    resolveSecond(existingDocs.map((d) => (d.id === epubId ? secondMoved : d)));
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().openDocumentIds).toContain(epubId);
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/moved-second/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(1);

    // Earlier response arrives late -> must be discarded without regressing filePath.
    resolveFirst(existingDocs.map((d) => (d.id === epubId ? firstMoved : d)));
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/moved-second/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(1);

    listSpy.mockRestore();
  });

  it('does not let a native drop arriving during a document lock invalidate the sync refreshDocument', async () => {
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
    await nativeStore.getState().openDocument(); // a.pdf
    const docId = nativeStore.getState().activeDocumentId as string;
    const staleSnapshot = { ...nativeStore.getState().documents.find((d) => d.id === docId)! };
    nativeStore.getState().closeDocument(docId);

    const syncedAnchor = {
      format: 'pdf' as const,
      pageIndex: 11,
      rects: [{ x: 0, y: 0.45, width: 0.5, height: 0.05 }],
    };

    let resolveSyncRefresh!: (docs: StudyDocument[]) => void;
    const realListDocuments = nativeBackend.listDocuments.bind(nativeBackend);
    const listSpy = vi.spyOn(nativeBackend, 'listDocuments').mockImplementationOnce(
      () =>
        new Promise<StudyDocument[]>((resolve) => {
          resolveSyncRefresh = resolve;
        }),
    );

    const syncTask = nativeStore.getState().withDocumentLock(docId, async () => {
      await nativeBackend.updateDocumentCursor(docId, syncedAnchor, 0.88);
      await nativeStore.getState().refreshDocument(docId);
    });
    await Promise.resolve();

    // A native drop for the locked document arrives while refreshDocument is in flight.
    emitDrop?.({ type: 'drop', documents: [staleSnapshot], error: null });
    expect(nativeStore.getState().openDocumentIds).not.toContain(docId);

    // Sync's own refreshDocument resolves and must still apply the synced progress.
    resolveSyncRefresh(await realListDocuments());
    await syncTask;

    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastCursorAnchor).toEqual(
      syncedAnchor,
    );
    expect(nativeStore.getState().documents.find((d) => d.id === docId)?.lastProgress).toBe(0.88);
    expect(nativeStore.getState().openDocumentIds).not.toContain(docId);

    listSpy.mockRestore();
  });

  it('prevents an in-flight native drop response from overwriting a newer file-picker open path', async () => {
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
    await nativeStore.getState().openDocument(); // a.pdf
    await nativeStore.getState().openDocument(); // b.epub
    const epubId = nativeStore.getState().activeDocumentId as string;
    const originalEpub = nativeStore.getState().documents.find((d) => d.id === epubId)!;
    nativeStore.getState().closeDocument(epubId);

    const existingDocs = await nativeBackend.listDocuments();
    const dropOldPath: StudyDocument = { ...originalEpub, filePath: '/drop-old/b.epub' };
    const pickerNewPath: StudyDocument = { ...originalEpub, filePath: '/picker-new/b.epub' };

    let resolveDropList!: (docs: StudyDocument[]) => void;
    const listSpy = vi.spyOn(nativeBackend, 'listDocuments').mockImplementationOnce(
      () =>
        new Promise<StudyDocument[]>((resolve) => {
          resolveDropList = resolve;
        }),
    );
    const pickSpy = vi.spyOn(nativeBackend, 'pickDocument').mockResolvedValueOnce(pickerNewPath);

    // 1) Native drop starts and awaits listDocuments().
    emitDrop?.({ type: 'drop', documents: [dropOldPath], error: null });

    // 2) File picker opens the same book from its new path and finishes first.
    await nativeStore.getState().openDocument();
    expect(nativeStore.getState().openDocumentIds).toContain(epubId);
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/picker-new/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(1);

    // 3) Earlier native drop listDocuments() returns late with the old path -> must be discarded.
    resolveDropList(existingDocs.map((d) => (d.id === epubId ? dropOldPath : d)));
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/picker-new/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(1);

    listSpy.mockRestore();
    pickSpy.mockRestore();
  });

  it('reconciles a valid file-picker selection when a prior native drop completes while the picker is open', async () => {
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
    await nativeStore.getState().openDocument(); // a.pdf
    await nativeStore.getState().openDocument(); // b.epub
    const epubId = nativeStore.getState().activeDocumentId as string;
    const originalEpub = nativeStore.getState().documents.find((d) => d.id === epubId)!;
    nativeStore.getState().closeDocument(epubId);

    const existingDocs = await nativeBackend.listDocuments();
    const dropOldPath: StudyDocument = { ...originalEpub, filePath: '/drop-old/b.epub' };
    const pickerNewPath: StudyDocument = { ...originalEpub, filePath: '/picker-new/b.epub' };

    let resolveDropList!: (docs: StudyDocument[]) => void;
    let resolvePick!: (doc: StudyDocument | null) => void;
    const listSpy = vi
      .spyOn(nativeBackend, 'listDocuments')
      .mockImplementationOnce(
        () =>
          new Promise<StudyDocument[]>((resolve) => {
            resolveDropList = resolve;
          }),
      )
      .mockImplementationOnce(async () =>
        existingDocs.map((d) => (d.id === epubId ? pickerNewPath : d)),
      );
    const pickSpy = vi.spyOn(nativeBackend, 'pickDocument').mockImplementationOnce(
      () =>
        new Promise<StudyDocument | null>((resolve) => {
          resolvePick = resolve;
        }),
    );

    // 1) Prior native drop starts, then user opens the file picker.
    emitDrop?.({ type: 'drop', documents: [dropOldPath], error: null });
    const picking = nativeStore.getState().openDocument();

    // 2) Prior native drop finishes while the file picker dialog is still open,
    // advancing the document's refresh sequence.
    resolveDropList(existingDocs.map((d) => (d.id === epubId ? dropOldPath : d)));
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/drop-old/b.epub',
    );

    // 3) User selects the new path in the file picker; reconciliation re-reads
    // the authoritative DB row and applies /picker-new/b.epub.
    resolvePick(pickerNewPath);
    await picking;

    expect(nativeStore.getState().openDocumentIds).toContain(epubId);
    expect(nativeStore.getState().documents.find((d) => d.id === epubId)?.filePath).toBe(
      '/picker-new/b.epub',
    );
    expect(nativeStore.getState().relinkedNonceByDocumentId[epubId]).toBe(2);

    listSpy.mockRestore();
    pickSpy.mockRestore();
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

  it('manages LAN sharing lifecycle and applies live share events', async () => {
    const docId = await openDocument();
    const interfaces = await state().loadLanInterfaces();
    expect(interfaces.length).toBeGreaterThan(0);

    const started = await state().startLanShare({
      documentIds: [docId],
      positions: true,
      bookmarks: true,
    });
    expect(started?.status.state).toBe('listening');
    expect(started?.pairingCode).toMatch(/^\d{6}$/);
    const firstCode = started?.pairingCode;

    const regenerated = await state().regenerateLanShareCode();
    expect(regenerated?.pairingCode).toMatch(/^\d{6}$/);
    expect(regenerated?.pairingCode).not.toBe(firstCode);

    await state().stopLanShare();
    expect(state().lanShare.snapshot.status.state).toBe('off');
    expect(state().lanShare.snapshot.lastStopReason).toBe('stoppedByUser');
  });

  it('refreshes documents, source statuses, and bookmarks per completed book during LAN import (T-32)', async () => {
    const remoteBytes = new TextEncoder().encode('Imported remote chapter text');
    const customBackend = createMemoryBackend({
      library: { '/local.txt': new TextEncoder().encode('Local book') },
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'Remote Synced Book',
            format: 'txt',
            extension: 'txt',
            bytes: remoteBytes,
            position: {
              anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 8, lineIndex: 0 },
              progress: 0.4,
            },
            bookmarks: [
              {
                anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 8, lineIndex: 0 },
                label: 'Opening',
              },
            ],
          },
        ],
      },
    });
    const customStore = createStudySyncStore(customBackend);
    await customStore.getState().initialize();

    const session = await customStore.getState().connectLanImport('192.168.1.25:49319', '123456');
    expect(session).not.toBeNull();
    expect(customStore.getState().lanImport.phase).toBe('catalog');
    expect(customStore.getState().lanImport.catalog).toHaveLength(1);

    const remoteBookId = customStore.getState().lanImport.catalog[0]!.bookId;
    const plan = await customStore.getState().planLanImport([remoteBookId]);
    expect(plan).not.toBeNull();
    expect(customStore.getState().lanImport.phase).toBe('preview');

    const report = await customStore.getState().executeLanImport(plan!.defaultDecisions);
    expect(report?.books[0]?.file).toEqual({ status: 'applied' });
    expect(customStore.getState().lanImport.phase).toBe('results');

    const importedDocId = report!.books[0]!.documentId!;
    // Store refreshed documents and bookmarks live without app restart (`T-32`).
    expect(customStore.getState().documents.some((d) => d.id === importedDocId)).toBe(true);
    expect(
      customStore
        .getState()
        .bookmarks.some((b) => b.documentId === importedDocId && b.label === 'Opening'),
    ).toBe(true);

    // Back to catalog keeps paired session alive (`R3-09`); disconnect ends it.
    await customStore.getState().backToLanImportCatalog();
    expect(customStore.getState().lanImport.phase).toBe('catalog');
    expect(customStore.getState().lanImport.session).not.toBeNull();

    await customStore.getState().disconnectLanImport();
    expect(customStore.getState().lanImport.phase).toBe('idle');
    expect(customStore.getState().lanImport.session).toBeNull();
  });

  it('preserves strict IpcError { code, message } on LAN import errors (R3-07)', async () => {
    const failingBackend = createMemoryBackend({
      lanPeer: {
        errors: {
          lanImportConnect: { code: 'lan_unreachable', message: 'connection refused' },
        },
      },
    });
    const failingStore = createStudySyncStore(failingBackend);
    await failingStore.getState().initialize();

    const session = await failingStore.getState().connectLanImport('192.168.1.25:49319', '123456');
    expect(session).toBeNull();
    expect(failingStore.getState().lanImport.error).toEqual({
      code: 'lan_unreachable',
      message: 'connection refused',
    });
  });

  it('prevents stale catalog/plan/execute responses from resurrecting a disconnected or replaced session while still refreshing committed books', async () => {
    const base = createMemoryBackend({ library: {} });
    let resolveSlowCatalog!: (books: Awaited<ReturnType<StudyBackend['lanImportCatalog']>>) => void;
    const disconnectedSessions: string[] = [];

    const slowCatalogBackend: StudyBackend = {
      ...base,
      lanImportConnect: vi
        .fn<StudyBackend['lanImportConnect']>()
        .mockResolvedValueOnce({
          sessionId: 'session-old',
          address: '192.168.1.25:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        })
        .mockResolvedValueOnce({
          sessionId: 'session-new',
          address: '192.168.1.30:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        }),
      lanImportCatalog: vi
        .fn<StudyBackend['lanImportCatalog']>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSlowCatalog = resolve;
            }),
        )
        .mockResolvedValueOnce([]),
      lanImportDisconnect: vi.fn<StudyBackend['lanImportDisconnect']>(async (sessionId) => {
        disconnectedSessions.push(sessionId);
      }),
    };

    const s = createStudySyncStore(slowCatalogBackend);
    await s.getState().initialize();

    const oldConnectPromise = s.getState().connectLanImport('192.168.1.25:49319', '123456');
    // Wait a microtask for `lanImportConnect` to resolve and `lanImportCatalog` to start.
    await Promise.resolve();
    await Promise.resolve();

    // Disconnect while catalog is still in flight: must disconnect `session-old` and return to `idle`.
    await s.getState().disconnectLanImport();
    expect(disconnectedSessions).toEqual(['session-old']);
    expect(s.getState().lanImport.phase).toBe('idle');
    expect(s.getState().lanImport.session).toBeNull();

    // Immediately reconnect to a new session before the old catalog resolves.
    const newSession = await s.getState().connectLanImport('192.168.1.30:49319', '654321');
    expect(newSession?.sessionId).toBe('session-new');
    expect(s.getState().lanImport.session?.sessionId).toBe('session-new');

    // Now the stale catalog from `session-old` resolves — it must NOT overwrite `session-new`.
    resolveSlowCatalog([
      {
        bookId: 'a'.repeat(64),
        title: 'Stale Book',
        format: 'txt',
        rawFormat: 'txt',
        extension: 'txt',
        sizeBytes: 10,
        fileAvailable: true,
        hasPosition: false,
        bookmarkCount: 0,
        state: 'new',
        eligible: true,
        needsFileDownload: true,
        localDocumentId: null,
        localTitle: null,
      },
    ]);
    expect(await oldConnectPromise).toBeNull();
    expect(s.getState().lanImport.session?.sessionId).toBe('session-new');
    expect(s.getState().lanImport.catalog).toEqual([]);
  });

  it('recovers a missing managed document restored to the exact same filePath before book 2 finishes (T-32)', async () => {
    const book1Bytes = new TextEncoder().encode('Managed book restored to same path');
    const base = createMemoryBackend({
      library: { '/library/same-path.txt': book1Bytes },
    });
    const doc1 = (await base.pickDocument())!;
    let releaseBook2!: () => void;

    const customBackend: StudyBackend = {
      ...base,
      lanImportConnect: async () => ({
        sessionId: 'sess-1',
        address: '192.168.1.25:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      }),
      lanImportCatalog: async () => [],
      lanImportPlan: async () => ({
        planId: 'plan-1',
        summary: { books: [] },
        defaultDecisions: [],
      }),
      lanImportExecute: async (_input, onProgress) => {
        // Book 1 completes with the exact same `documentId` and `filePath`, and
        // even with `file.status === 'skipped'` (Rust `AlreadyPresent` branch).
        onProgress({
          phase: 'bookCompleted',
          bookId: doc1.fileHash,
          bookIndex: 0,
          totalBooks: 2,
          result: {
            bookId: doc1.fileHash,
            documentId: doc1.id,
            state: 'missingFile',
            file: { status: 'skipped' },
            position: { status: 'skipped' },
            bookmarks: { status: 'skipped' },
            bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
          },
        });
        // Book 2 stays in flight while we assert Book 1 already recovered.
        await new Promise<void>((resolve) => {
          releaseBook2 = resolve;
        });
        return { books: [], cancelled: false };
      },
    };

    const s = createStudySyncStore(customBackend);
    await s.getState().initialize();
    // Simulate `doc1` currently showing SourceRecoveryDialog (`missing`) at `/library/same-path.txt`.
    s.setState((prev) => ({
      documentSourceStatuses: {
        ...prev.documentSourceStatuses,
        [doc1.id]: {
          documentId: doc1.id,
          state: 'missing',
          currentFileHash: null,
          fileSizeBytes: null,
        },
      },
    }));

    await s.getState().connectLanImport('192.168.1.25:49319', '123456');
    await s.getState().planLanImport([]);

    const execPromise = s.getState().executeLanImport([]);
    // Wait for Book 1's per-book refresh + verifyDocumentSource while Book 2 is still running.
    await vi.waitFor(() => {
      expect(s.getState().documentSourceStatuses[doc1.id]?.state).toBe('ok');
    });
    expect(s.getState().relinkedNonceByDocumentId[doc1.id]).toBe(1);
    expect(s.getState().lanImport.phase).toBe('importing');

    releaseBook2();
    await execPromise;
    expect(s.getState().lanImport.phase).toBe('results');
  });

  it('keeps planLanImport and executeLanImport alive when refreshLanImportCatalog runs concurrently', async () => {
    const base = createMemoryBackend({ library: {} });
    let resolvePlan!: (plan: Awaited<ReturnType<StudyBackend['lanImportPlan']>>) => void;
    let resolveExecute!: (report: Awaited<ReturnType<StudyBackend['lanImportExecute']>>) => void;

    const customBackend: StudyBackend = {
      ...base,
      lanImportConnect: async () => ({
        sessionId: 'sess-1',
        address: '192.168.1.25:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      }),
      lanImportCatalog: async () => [],
      lanImportPlan: () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
      lanImportExecute: () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        }),
    };

    const s = createStudySyncStore(customBackend);
    await s.getState().initialize();
    await s.getState().connectLanImport('192.168.1.25:49319', '123456');

    // Refresh catalog while planning is in flight.
    const planPromise = s.getState().planLanImport(['a'.repeat(64)]);
    await s.getState().refreshLanImportCatalog();
    resolvePlan({
      planId: 'plan-1',
      summary: { books: [] },
      defaultDecisions: [],
    });
    const plan = await planPromise;
    expect(plan?.planId).toBe('plan-1');
    expect(s.getState().lanImport.phase).toBe('preview');
    expect(s.getState().lanImport.activeOperationId).toBeNull();

    // Refresh catalog while executing is in flight.
    const execPromise = s.getState().executeLanImport([]);
    await s.getState().refreshLanImportCatalog();
    resolveExecute({ books: [], cancelled: false });
    const report = await execPromise;
    expect(report?.cancelled).toBe(false);
    expect(s.getState().lanImport.phase).toBe('results');
    expect(s.getState().lanImport.activeOperationId).toBeNull();
  });

  it('refreshes newly imported books from report.books before publishing results when bookCompleted is late or absent', async () => {
    const importedBytes = new TextEncoder().encode('Report-first synced book');
    const base = createMemoryBackend({
      library: { '/library/report-first.txt': importedBytes },
    });
    const importedDoc = (await base.pickDocument())!;
    const progressSink: {
      cb: ((p: Parameters<Parameters<StudyBackend['lanImportExecute']>[1]>[0]) => void) | null;
    } = { cb: null };
    const listDocsSpy = vi.spyOn(base, 'listDocuments');

    const customBackend: StudyBackend = {
      ...base,
      lanImportConnect: async () => ({
        sessionId: 'sess-1',
        address: '192.168.1.25:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      }),
      lanImportCatalog: async () => [],
      lanImportPlan: async () => ({
        planId: 'plan-1',
        summary: { books: [] },
        defaultDecisions: [],
      }),
      lanImportExecute: async (_input, onProgress) => {
        progressSink.cb = onProgress;
        // Return report WITHOUT emitting `bookCompleted` first.
        return {
          books: [
            {
              bookId: importedDoc.fileHash,
              documentId: importedDoc.id,
              state: 'new',
              file: { status: 'applied' },
              position: { status: 'skipped' },
              bookmarks: { status: 'skipped' },
              bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
            },
          ],
          cancelled: false,
        };
      },
    };

    const s = createStudySyncStore(customBackend);
    await s.getState().initialize();
    // Clear store's documents so `importedDoc` must be refreshed by `executeLanImport`.
    s.setState({ documents: [] });
    listDocsSpy.mockClear();

    await s.getState().connectLanImport('192.168.1.25:49319', '123456');
    await s.getState().planLanImport([]);
    await s.getState().executeLanImport([]);

    expect(s.getState().lanImport.phase).toBe('results');
    expect(s.getState().documents.some((d) => d.id === importedDoc.id)).toBe(true);
    expect(listDocsSpy).toHaveBeenCalledTimes(1);

    // Late `bookCompleted` for the same documentId is deduplicated and does not re-fetch.
    progressSink.cb?.({
      phase: 'bookCompleted',
      bookId: importedDoc.fileHash,
      bookIndex: 0,
      totalBooks: 1,
      result: {
        bookId: importedDoc.fileHash,
        documentId: importedDoc.id,
        state: 'new',
        file: { status: 'applied' },
        position: { status: 'skipped' },
        bookmarks: { status: 'skipped' },
        bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
      },
    });
    expect(listDocsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale LAN recovery verification overwrite a newer changed status', async () => {
    const bookBytes = new TextEncoder().encode('Original managed book');
    const base = createMemoryBackend({
      library: { '/library/managed.txt': bookBytes },
    });
    const doc = (await base.pickDocument())!;
    let resolveSlowLanVerify!: (
      status: Awaited<ReturnType<StudyBackend['verifyDocumentSource']>>,
    ) => void;
    let verifyCalls = 0;

    const customBackend: StudyBackend = {
      ...base,
      verifyDocumentSource: async (documentId) => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          // Slow LAN recovery verify returning stale `ok`.
          return new Promise((resolve) => {
            resolveSlowLanVerify = resolve;
          });
        }
        // Newer normal verification reporting `changed`.
        return {
          documentId,
          state: 'changed',
          currentFileHash: 'different-hash',
          fileSizeBytes: 99,
        };
      },
      lanImportConnect: async () => ({
        sessionId: 'sess-1',
        address: '192.168.1.25:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      }),
      lanImportCatalog: async () => [],
      lanImportPlan: async () => ({
        planId: 'plan-1',
        summary: { books: [] },
        defaultDecisions: [],
      }),
      lanImportExecute: async (_input, onProgress) => {
        onProgress({
          phase: 'bookCompleted',
          bookId: doc.fileHash,
          bookIndex: 0,
          totalBooks: 1,
          result: {
            bookId: doc.fileHash,
            documentId: doc.id,
            state: 'missingFile',
            file: { status: 'applied' },
            position: { status: 'skipped' },
            bookmarks: { status: 'skipped' },
            bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
          },
        });
        return { books: [], cancelled: false };
      },
    };

    const s = createStudySyncStore(customBackend);
    await s.getState().initialize();
    s.setState((prev) => ({
      documentSourceStatuses: {
        ...prev.documentSourceStatuses,
        [doc.id]: {
          documentId: doc.id,
          state: 'missing',
          currentFileHash: null,
          fileSizeBytes: null,
        },
      },
    }));

    await s.getState().connectLanImport('192.168.1.25:49319', '123456');
    await s.getState().planLanImport([]);

    const execPromise = s.getState().executeLanImport([]);
    await vi.waitFor(() => {
      expect(verifyCalls).toBe(1);
    });

    // Normal verification runs and updates state to `changed` while LAN verify is pending.
    await s.getState().verifyDocumentSource(doc.id);
    expect(s.getState().documentSourceStatuses[doc.id]?.state).toBe('changed');

    // Now the stale LAN recovery verify resolves with `ok` — must NOT overwrite `changed`.
    resolveSlowLanVerify({
      documentId: doc.id,
      state: 'ok',
      currentFileHash: doc.fileHash,
      fileSizeBytes: bookBytes.byteLength,
    });
    await execPromise;
    expect(s.getState().documentSourceStatuses[doc.id]?.state).toBe('changed');
    expect(s.getState().relinkedNonceByDocumentId[doc.id] ?? 0).toBe(0);
  });

  it('ignores overlapping executeLanImport/planLanImport/backToLanImportCatalog calls while an import is active so cancel and final results stay intact', async () => {
    const base = createMemoryBackend({ library: {} });
    let resolveExecute!: (report: Awaited<ReturnType<StudyBackend['lanImportExecute']>>) => void;
    const executeSpy = vi.fn<StudyBackend['lanImportExecute']>(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        }),
    );
    const planSpy = vi.fn<StudyBackend['lanImportPlan']>(async () => ({
      planId: 'plan-1',
      summary: { books: [] },
      defaultDecisions: [],
    }));
    const cancelledOpIds: string[] = [];

    const customBackend: StudyBackend = {
      ...base,
      lanImportConnect: async () => ({
        sessionId: 'sess-1',
        address: '192.168.1.25:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      }),
      lanImportCatalog: async () => [],
      lanImportPlan: planSpy,
      lanImportExecute: executeSpy,
      lanImportCancel: async (opId) => {
        cancelledOpIds.push(opId);
        return true;
      },
    };

    const s = createStudySyncStore(customBackend);
    await s.getState().initialize();
    await s.getState().connectLanImport('192.168.1.25:49319', '123456');
    await s.getState().planLanImport([]);
    planSpy.mockClear();

    const firstExec = s.getState().executeLanImport([]);
    const firstOpId = s.getState().lanImport.activeOperationId;
    expect(firstOpId).toBeTruthy();
    expect(s.getState().lanImport.phase).toBe('importing');

    // Duplicate execute, plan, and back-to-catalog while importing are all ignored synchronously.
    expect(await s.getState().executeLanImport([])).toBeNull();
    expect(await s.getState().planLanImport([])).toBeNull();
    await s.getState().backToLanImportCatalog();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(planSpy).toHaveBeenCalledTimes(0);
    expect(s.getState().lanImport.phase).toBe('importing');
    expect(s.getState().lanImport.activeOperationId).toBe(firstOpId);

    // Cancel still targets the first active operation, and releasing it finishes cleanly in `results`.
    expect(await s.getState().cancelLanImportOperation()).toBe(true);
    expect(cancelledOpIds).toEqual([firstOpId]);

    resolveExecute({ books: [], cancelled: true });
    const report = await firstExec;
    expect(report).toEqual({ books: [], cancelled: true });
    expect(s.getState().lanImport.phase).toBe('results');
    expect(s.getState().lanImport.activeOperationId).toBeNull();
  });

  it('coalesces concurrent disconnectLanImport calls, blocks connectLanImport during disconnecting, and drops late connects (#169)', async () => {
    const base = createMemoryBackend({ library: {} });
    let releaseDisconnect!: () => void;
    let resolveLateConnect!: (
      session: Awaited<ReturnType<StudyBackend['lanImportConnect']>>,
    ) => void;
    const disconnectedSessions: string[] = [];

    const backend: StudyBackend = {
      ...base,
      lanImportConnect: vi
        .fn<StudyBackend['lanImportConnect']>()
        .mockResolvedValueOnce({
          sessionId: 'sess-active',
          address: '192.168.1.25:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveLateConnect = resolve;
            }),
        ),
      lanImportCatalog: vi.fn<StudyBackend['lanImportCatalog']>().mockResolvedValue([]),
      lanImportDisconnect: vi.fn<StudyBackend['lanImportDisconnect']>(async (sessionId) => {
        disconnectedSessions.push(sessionId);
        if (sessionId === 'sess-active') {
          await new Promise<void>((resolve) => {
            releaseDisconnect = resolve;
          });
        }
      }),
    };

    const s = createStudySyncStore(backend);
    await s.getState().initialize();
    await s.getState().connectLanImport('192.168.1.25:49319', '123456');

    const d1 = s.getState().disconnectLanImport();
    const d2 = s.getState().disconnectLanImport();
    expect(s.getState().lanImport.phase).toBe('disconnecting');
    expect(s.getState().lanImport.session).toBeNull();
    expect(disconnectedSessions).toEqual(['sess-active']);

    // Connect attempts during `disconnecting` are rejected synchronously.
    expect(await s.getState().connectLanImport('192.168.1.99:49319', '654321')).toBeNull();
    expect(backend.lanImportConnect).toHaveBeenCalledTimes(1);

    releaseDisconnect();
    await Promise.all([d1, d2]);
    expect(s.getState().lanImport.phase).toBe('idle');
    expect(disconnectedSessions).toEqual(['sess-active']);

    // Now start a new connect, cancel/disconnect before it resolves, then let it resolve late.
    const inflightConnect = s.getState().connectLanImport('192.168.1.25:49319', '123456');
    const teardown = s.getState().disconnectLanImport();
    resolveLateConnect({
      sessionId: 'sess-late',
      address: '192.168.1.25:49319',
      idleTimeoutSeconds: 600,
      permissions: { positions: true, bookmarks: true },
    });
    expect(await inflightConnect).toBeNull();
    await teardown;

    expect(disconnectedSessions).toEqual(['sess-active', 'sess-late']);
    expect(s.getState().lanImport.session).toBeNull();
    expect(s.getState().lanImport.phase).toBe('idle');
  });
});
