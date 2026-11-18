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
