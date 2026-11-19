import { describe, expect, it } from 'vitest';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';

const PNG = 'iVBORw0KGgo=';

/** Mirrors core's soft-delete tests (#97) so the preview behaves like the app. */
describe('memory backend annotation delete and restore', () => {
  const setup = async () => {
    const backend = createMemoryBackend({
      library: { '/test/a.pdf': new TextEncoder().encode('pdf') },
    });
    const document = await backend.pickDocument();
    const notebook = await backend.createNotebook('Study');
    const created = await backend.createExcerpt({
      documentId: document?.id as string,
      notebookId: notebook.id,
      anchor: { format: 'pdf', pageIndex: 0, rects: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] },
      excerptText: null,
      excerptImagePng: PNG,
      color: '#fde047',
      parentNodeId: null,
      posX: 0,
      posY: 0,
    });
    return { backend, notebookId: notebook.id, created };
  };

  it('restores the same annotation, its card link, and its capture', async () => {
    const { backend, notebookId, created } = await setup();
    const id = created.annotation.id;

    await backend.deleteAnnotation(id);
    const graph = await backend.loadNotebookGraph(notebookId);
    expect(graph.annotations).toEqual([]);
    expect(graph.cards[0]?.annotationIds).toEqual([]);

    const restored = await backend.restoreAnnotation(id);
    expect(restored).toEqual({ annotation: created.annotation, cards: [created.card] });
    expect(await backend.captureUrl(id)).toBe(`data:image/png;base64,${PNG}`);
    expect((await backend.loadNotebookGraph(notebookId)).cards).toEqual([created.card]);
  });

  it('reports not_found as core does', async () => {
    const { backend, created } = await setup();
    const id = created.annotation.id;
    const notFound = { code: 'not_found' };

    await expect(backend.restoreAnnotation(id)).rejects.toMatchObject(notFound);
    await backend.deleteAnnotation(id);
    await expect(backend.deleteAnnotation(id)).rejects.toMatchObject(notFound);
    await expect(backend.captureUrl(id)).rejects.toMatchObject(notFound);
    await expect(
      backend.updateAnnotation(id, { note: 'late', color: null, style: null }),
    ).rejects.toMatchObject(notFound);
    await backend.restoreAnnotation(id);
    await expect(backend.restoreAnnotation(id)).rejects.toMatchObject(notFound);
  });
});

/** Mirrors core's registration tests for #99, so the preview matches the app. */
describe('memory backend Markdown registration', () => {
  it('registers Markdown as readable text that takes TXT excerpts', async () => {
    const backend = createMemoryBackend();
    const { documents, error } = await backend.dropFiles([
      new File(['# Notes\n\nSome text.\n'], 'README.md', { type: 'text/markdown' }),
      new File(['# Plan\n'], 'plan.markdown', { type: 'text/markdown' }),
    ]);
    expect(error).toBeNull();
    expect(documents.map((document) => document.format)).toEqual(['txt', 'txt']);

    const notebook = await backend.createNotebook('Study');
    const created = await backend.createExcerpt({
      documentId: documents[0]?.id as string,
      notebookId: notebook.id,
      anchor: { format: 'txt', startByteOffset: 2, endByteOffset: 7, lineIndex: 0 },
      excerptText: 'Notes',
      excerptImagePng: null,
      color: '#fde047',
      parentNodeId: null,
      posX: 0,
      posY: 0,
    });
    expect(created.annotation.anchor.format).toBe('txt');
  });

  it('declines an unsupported file without registering it', async () => {
    const backend = createMemoryBackend();
    const { documents, error } = await backend.dropFiles([
      new File(['x'], 'sheet.docx', { type: 'application/octet-stream' }),
    ]);
    expect(documents).toEqual([]);
    expect(error?.code).toBe('unsupported_format');
    expect(await backend.listDocuments()).toEqual([]);
  });
});

/** Mirrors core's atomic card deletion, child re-rooting, and Undo (#116). */
describe('memory backend card delete and restore', () => {
  it('deletes card, node, and edges while re-rooting children and keeping highlights, then restores on undo', async () => {
    const backend = createMemoryBackend({
      library: { '/test/a.txt': new TextEncoder().encode('parent child') },
    });
    const document = await backend.pickDocument();
    const notebook = await backend.createNotebook('Study');
    const parent = await backend.createExcerpt({
      documentId: document?.id as string,
      notebookId: notebook.id,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 6, lineIndex: 0 },
      excerptText: 'parent',
      excerptImagePng: null,
      color: '#fde047',
      parentNodeId: null,
      posX: 40,
      posY: 40,
    });
    const child = await backend.createExcerpt({
      documentId: document?.id as string,
      notebookId: notebook.id,
      anchor: { format: 'txt', startByteOffset: 7, endByteOffset: 12, lineIndex: 0 },
      excerptText: 'child',
      excerptImagePng: null,
      color: '#fde047',
      parentNodeId: parent.node.id,
      posX: 360,
      posY: 40,
    });
    await backend.updateCard(parent.card.id, {
      title: 'Parent card',
      markdownNotes: 'Notes',
      tags: ['tag1'],
    });

    const deleted = await backend.deleteCard(parent.card.id);
    expect(deleted.cardId).toBe(parent.card.id);
    expect(deleted.nodeIds).toEqual([parent.node.id]);
    expect(deleted.rerootedChildNodeIds).toEqual([child.node.id]);
    expect(deleted.edgeIds).toHaveLength(1);

    const afterDelete = await backend.loadNotebookGraph(notebook.id);
    expect(afterDelete.annotations).toHaveLength(2);
    expect(afterDelete.cards.map((c) => c.id)).toEqual([child.card.id]);
    expect(afterDelete.nodes[0]?.parentNodeId).toBeNull();
    expect(afterDelete.edges).toEqual([]);

    await expect(backend.deleteCard(parent.card.id)).rejects.toMatchObject({ code: 'not_found' });

    const restored = await backend.restoreCard(parent.card.id);
    expect(restored.card).toMatchObject({
      id: parent.card.id,
      title: 'Parent card',
      markdownNotes: 'Notes',
      tags: ['tag1'],
    });
    expect(restored.nodes[0]?.id).toBe(parent.node.id);
    expect(restored.edges).toHaveLength(1);
    expect(restored.reparentedChildren[0]?.parentNodeId).toBe(parent.node.id);

    await expect(backend.restoreCard(parent.card.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
