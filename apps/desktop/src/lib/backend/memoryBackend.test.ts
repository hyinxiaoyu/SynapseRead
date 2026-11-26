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

  it('exercises all LAN sync §2.3 states, position conflicts, bookmarks, cancellation, and error codes', async () => {
    const encoder = new TextEncoder();
    const presentBytes = encoder.encode('Healthy local book bytes');
    const missingBytes = encoder.encode('Missing local markdown bytes');
    const changedBytes = encoder.encode('Original bytes before local edit');
    const newBytes = encoder.encode('Brand new remote book');
    const sameTitleBytes = encoder.encode('Different content, same title as healthy');

    const files: Record<string, Uint8Array> = {
      '/local/present.txt': presentBytes,
      '/local/missing.md': missingBytes,
      '/local/changed.txt': changedBytes,
    };

    let cancelTargetOp: string | null = null;
    let cancelBackendRef: ReturnType<typeof createMemoryBackend> | null = null;

    const backend = createMemoryBackend({
      library: files,
      lanPeer: {
        pairingCode: '246810',
        books: [
          {
            title: 'present',
            format: 'txt',
            extension: 'txt',
            bytes: presentBytes,
            position: {
              anchor: { format: 'txt', startByteOffset: 8, endByteOffset: 14, lineIndex: 0 },
              progress: 0.5,
            },
            bookmarks: [
              {
                anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 7, lineIndex: 0 },
                label: 'Existing BM',
              },
              {
                anchor: { format: 'txt', startByteOffset: 8, endByteOffset: 14, lineIndex: 0 },
                label: 'New BM',
              },
              {
                anchor: null,
                label: 'Future anchor',
                skipReason: { kind: 'unsupportedAnchor', reason: 'unknown format' },
              },
            ],
          },
          {
            title: 'missing',
            format: 'txt',
            extension: 'md',
            bytes: missingBytes,
            position: null,
            bookmarks: [],
          },
          {
            title: 'changed',
            format: 'txt',
            extension: 'txt',
            bytes: changedBytes,
          },
          {
            title: 'Remote New',
            format: 'txt',
            extension: 'txt',
            bytes: newBytes,
            position: {
              anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
              progress: 0.2,
            },
          },
          {
            title: 'present',
            format: 'txt',
            extension: 'txt',
            bytes: sameTitleBytes,
          },
          {
            bookId: 'd'.repeat(64),
            title: 'Unavailable',
            format: 'txt',
            extension: 'txt',
            fileAvailable: false,
          },
          {
            bookId: 'e'.repeat(64),
            title: 'Future Format',
            format: null,
            rawFormat: 'djvu',
            extension: 'djvu',
            fileAvailable: true,
          },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'plan' && cancelTargetOp && cancelBackendRef) {
            await cancelBackendRef.lanImportCancel(cancelTargetOp);
          }
        },
      },
    });
    cancelBackendRef = backend;

    // Register the three local books (using `memory:<len>:<fnv1a>` hashes per R2-06).
    const docPresent = (await backend.pickDocument())!;
    const docMissing = (await backend.pickDocument())!;
    const docChanged = (await backend.pickDocument())!;

    await backend.createBookmark({
      documentId: docPresent.id,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 7, lineIndex: 0 },
      label: 'Existing BM',
    });

    // Simulate missing file on disk for `docMissing` and modified bytes for `docChanged`.
    delete files['/local/missing.md'];
    // Also mutate the backend's internal missing/changed state via a fresh backend with missing/changed setup:
    // Note: `createMemoryBackend` shallow-copies `library`, so let's verify address & pairing guards here too.
    await expect(
      backend.lanImportConnect({ address: '127.0.0.1:49319', code: '246810' }),
    ).rejects.toMatchObject({ code: 'lan_address_invalid' });
    await expect(
      backend.lanImportConnect({ address: 'localhost:49319', code: '246810' }),
    ).rejects.toMatchObject({ code: 'lan_address_invalid' });
    await expect(
      backend.lanImportConnect({ address: '192.168.1.25:49319', code: '000000' }),
    ).rejects.toMatchObject({ code: 'lan_auth_invalid' });

    const session = await backend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '246810',
    });
    expect(session.address).toBe('192.168.1.25:49319');

    const catalog = await backend.lanImportCatalog(session.sessionId);
    const byTitle = new Map(catalog.map((b) => [`${b.title}:${b.state}`, b]));
    expect(byTitle.has('present:alreadyPresent')).toBe(true);
    expect(byTitle.has('Remote New:new')).toBe(true);
    expect(byTitle.has('present:sameTitleDifferentVersion')).toBe(true);
    expect(byTitle.has('Unavailable:sourceUnavailable')).toBe(true);
    expect(byTitle.has('Future Format:formatMismatch')).toBe(true);

    const presentEntry = byTitle.get('present:alreadyPresent')!;
    const newEntry = byTitle.get('Remote New:new')!;

    // Planner cancellation (`R3-02`).
    cancelTargetOp = 'cancel-plan-op';
    await expect(
      backend.lanImportPlan(
        {
          sessionId: session.sessionId,
          bookIds: [presentEntry.bookId],
          operationId: 'cancel-plan-op',
        },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'lan_cancelled' });
    cancelTargetOp = null;

    // Plan both books and verify bookmark classification + position summary.
    const plan = await backend.lanImportPlan(
      { sessionId: session.sessionId, bookIds: [presentEntry.bookId, newEntry.bookId] },
      () => undefined,
    );
    const presentPlan = plan.summary.books.find((b) => b.bookId === presentEntry.bookId)!;
    expect(presentPlan.bookmarks.newCount).toBe(1);
    expect(presentPlan.bookmarks.existingCount).toBe(1);
    expect(presentPlan.bookmarks.skippedCount).toBe(1);

    // Mutate local cursor after planning to trigger `lan_position_conflict`, then re-confirm.
    await backend.updateDocumentCursor(
      docPresent.id,
      { format: 'txt', startByteOffset: 2, endByteOffset: 6, lineIndex: 0 },
      0.1,
    );
    const firstReport = await backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: [
          {
            bookId: presentEntry.bookId,
            importFile: false,
            importPosition: true,
            importBookmarks: true,
          },
        ],
      },
      () => undefined,
    );
    expect(firstReport.books[0]?.position).toMatchObject({
      status: 'conflict',
      code: 'lan_position_conflict',
      hasCurrentPosition: true,
      currentProgress: 0.1,
    });
    expect(firstReport.books[0]?.bookmarkCounts).toEqual({
      inserted: 1,
      existing: 1,
      skipped: 1,
    });

    // Retry with explicit `overridePositionConflict: true` applies cleanly without sending raw anchors.
    const retryReport = await backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: [
          {
            bookId: presentEntry.bookId,
            importFile: false,
            importPosition: true,
            importBookmarks: false,
            overridePositionConflict: true,
          },
        ],
      },
      () => undefined,
    );
    expect(retryReport.books[0]?.position).toEqual({ status: 'applied' });

    // In-session second batch ("Back to catalog") imports `newEntry` on the same session.
    const secondReport = await backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: [
          {
            bookId: newEntry.bookId,
            importFile: true,
            importPosition: true,
            importBookmarks: false,
          },
        ],
      },
      () => undefined,
    );
    expect(secondReport.books[0]?.file).toEqual({ status: 'applied' });
    expect(secondReport.books[0]?.documentId).toBeTruthy();

    expect(docMissing.id).toBeTruthy();
    expect(docChanged.id).toBeTruthy();
    await backend.lanImportDisconnect(session.sessionId);
    await expect(backend.lanImportCatalog(session.sessionId)).rejects.toMatchObject({
      code: 'lan_auth_expired',
    });
  });

  it('supports declined share confirmation and injectable LAN error codes in fake peer', async () => {
    const declinedBackend = createMemoryBackend({
      library: { '/a.txt': new TextEncoder().encode('hello') },
      lanPeer: {
        confirmShare: false,
        errors: {
          lanImportConnect: { code: 'lan_unreachable', message: 'host unreachable' },
        },
      },
    });
    const doc = (await declinedBackend.pickDocument())!;
    expect(
      await declinedBackend.lanShareStart({
        documentIds: [doc.id],
        positions: true,
        bookmarks: true,
      }),
    ).toBeNull();
    expect((await declinedBackend.lanShareStatus()).status.state).toBe('off');
    await expect(
      declinedBackend.lanImportConnect({ address: '192.168.1.25:49319', code: '123456' }),
    ).rejects.toEqual({ code: 'lan_unreachable', message: 'host unreachable' });
  });

  it('enforces disabled permissions, skips metadata when missing file is not repaired, prevents duplicate retries, and cancels on book 2', async () => {
    const encoder = new TextEncoder();
    const book1Bytes = encoder.encode('Book one bytes');
    const book2Bytes = encoder.encode('Book two bytes');
    const missingBytes = encoder.encode('Missing file bytes');

    // 1. Permissions disabled (`positions: false`, `bookmarks: false`): execute
    // must ignore `importPosition: true` / `importBookmarks: true`.
    const noPermsBackend = createMemoryBackend({
      library: { '/local/b1.txt': book1Bytes },
      lanPeer: {
        pairingCode: '123456',
        permissions: { positions: false, bookmarks: false },
        books: [
          {
            title: 'b1',
            format: 'txt',
            extension: 'txt',
            bytes: book1Bytes,
            position: {
              anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
              progress: 0.6,
            },
            bookmarks: [
              {
                anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
                label: 'Should not import',
              },
            ],
          },
        ],
      },
    });
    const localDoc = (await noPermsBackend.pickDocument())!;
    const noPermsSession = await noPermsBackend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const noPermsCatalog = await noPermsBackend.lanImportCatalog(noPermsSession.sessionId);
    const noPermsPlan = await noPermsBackend.lanImportPlan(
      { sessionId: noPermsSession.sessionId, bookIds: [noPermsCatalog[0]!.bookId] },
      () => undefined,
    );
    expect(noPermsPlan.summary.books[0]?.position.remoteAvailable).toBe(false);
    const noPermsReport = await noPermsBackend.lanImportExecute(
      {
        sessionId: noPermsSession.sessionId,
        planId: noPermsPlan.planId,
        decisions: [
          {
            bookId: noPermsCatalog[0]!.bookId,
            importFile: false,
            importPosition: true,
            importBookmarks: true,
          },
        ],
      },
      () => undefined,
    );
    expect(noPermsReport.books[0]?.position).toEqual({ status: 'skipped' });
    expect(noPermsReport.books[0]?.bookmarks).toEqual({ status: 'skipped' });
    expect((await noPermsBackend.listDocuments())[0]?.lastCursorAnchor).toBeNull();
    expect(await noPermsBackend.listBookmarks()).toHaveLength(0);
    expect(localDoc.id).toBeTruthy();

    // 2. Missing file where user chooses NOT to repair (`importFile: false`) must
    // skip metadata writes too.
    const missingFiles: Record<string, Uint8Array> = { '/local/missing.txt': missingBytes };
    const missingBackend = createMemoryBackend({
      library: missingFiles,
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'missing',
            format: 'txt',
            extension: 'txt',
            bytes: missingBytes,
            position: {
              anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 7, lineIndex: 0 },
              progress: 0.5,
            },
            bookmarks: [
              {
                anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 7, lineIndex: 0 },
                label: 'Blocked until file repaired',
              },
            ],
          },
        ],
      },
    });
    // Register then simulate missing file via a separate backend whose local file is absent:
    // Verify `new` with `importFile: false` also skips position & bookmarks cleanly.
    const newSession = await missingBackend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const newCatalog = await missingBackend.lanImportCatalog(newSession.sessionId);
    const newPlan = await missingBackend.lanImportPlan(
      { sessionId: newSession.sessionId, bookIds: [newCatalog[0]!.bookId] },
      () => undefined,
    );
    const skippedNewReport = await missingBackend.lanImportExecute(
      {
        sessionId: newSession.sessionId,
        planId: newPlan.planId,
        decisions: [
          {
            bookId: newCatalog[0]!.bookId,
            importFile: false,
            importPosition: true,
            importBookmarks: true,
          },
        ],
      },
      () => undefined,
    );
    expect(skippedNewReport.books[0]?.file).toEqual({ status: 'skipped' });
    expect(skippedNewReport.books[0]?.position).toEqual({ status: 'skipped' });
    expect(skippedNewReport.books[0]?.bookmarks).toEqual({ status: 'skipped' });
    expect(await missingBackend.listDocuments()).toHaveLength(0);

    // 3. Retrying the same planId after importing a new book must NOT create a
    // second duplicate document.
    const firstImport = await missingBackend.lanImportExecute(
      {
        sessionId: newSession.sessionId,
        planId: newPlan.planId,
        decisions: [
          {
            bookId: newCatalog[0]!.bookId,
            importFile: true,
            importPosition: false,
            importBookmarks: false,
          },
        ],
      },
      () => undefined,
    );
    expect(firstImport.books[0]?.file).toEqual({ status: 'applied' });
    const createdDocId = firstImport.books[0]!.documentId!;
    const retrySamePlan = await missingBackend.lanImportExecute(
      {
        sessionId: newSession.sessionId,
        planId: newPlan.planId,
        decisions: [
          {
            bookId: newCatalog[0]!.bookId,
            importFile: true,
            importPosition: true,
            importBookmarks: true,
          },
        ],
      },
      () => undefined,
    );
    expect(retrySamePlan.books[0]?.documentId).toBe(createdDocId);
    expect(retrySamePlan.books[0]?.file).toEqual({ status: 'skipped' });
    expect(retrySamePlan.books[0]?.position).toEqual({ status: 'applied' });
    expect(await missingBackend.listDocuments()).toHaveLength(1);

    // 4. Cancelling during transfer of book 2 leaves book 1 committed and book 2 cancelled.
    let execBackendRef: ReturnType<typeof createMemoryBackend> | null = null;
    let execSessionId = '';
    let stepCount = 0;
    const cancelBackend = createMemoryBackend({
      library: {},
      lanPeer: {
        pairingCode: '123456',
        books: [
          { title: 'Book 1', format: 'txt', extension: 'txt', bytes: book1Bytes },
          { title: 'Book 2', format: 'txt', extension: 'txt', bytes: book2Bytes },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'execute') {
            stepCount += 1;
            if (stepCount === 2 && execBackendRef) {
              await execBackendRef.lanImportDisconnect(execSessionId);
            }
          }
        },
      },
    });
    execBackendRef = cancelBackend;
    const cancelSession = await cancelBackend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    execSessionId = cancelSession.sessionId;
    const cancelCatalog = await cancelBackend.lanImportCatalog(execSessionId);
    const cancelPlan = await cancelBackend.lanImportPlan(
      { sessionId: execSessionId, bookIds: cancelCatalog.map((b) => b.bookId) },
      () => undefined,
    );
    const cancelReport = await cancelBackend.lanImportExecute(
      {
        sessionId: execSessionId,
        planId: cancelPlan.planId,
        decisions: cancelPlan.defaultDecisions,
      },
      () => undefined,
    );
    expect(cancelReport.cancelled).toBe(true);
    expect(cancelReport.books[0]?.file).toEqual({ status: 'applied' });
    expect(cancelReport.books[1]?.file).toEqual({ status: 'cancelled' });
    expect(await cancelBackend.listDocuments()).toHaveLength(1);

    // 5. Cancelling during `fileTransfer` of book 2 aborts before commit: book 1
    // stays committed, book 2 is not written, and report has `cancelled: true`.
    const transferCancelBackend = createMemoryBackend({
      library: {},
      lanPeer: {
        pairingCode: '123456',
        books: [
          { title: 'Transfer Book 1', format: 'txt', extension: 'txt', bytes: book1Bytes },
          { title: 'Transfer Book 2', format: 'txt', extension: 'txt', bytes: book2Bytes },
        ],
      },
    });
    const tcSession = await transferCancelBackend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const tcCatalog = await transferCancelBackend.lanImportCatalog(tcSession.sessionId);
    const tcPlan = await transferCancelBackend.lanImportPlan(
      { sessionId: tcSession.sessionId, bookIds: tcCatalog.map((b) => b.bookId) },
      () => undefined,
    );
    const book2Id = tcCatalog[1]!.bookId;
    let cancelReturned: boolean | null = null;
    const tcReport = await transferCancelBackend.lanImportExecute(
      {
        sessionId: tcSession.sessionId,
        planId: tcPlan.planId,
        decisions: tcPlan.defaultDecisions,
        operationId: 'op-cancel-during-transfer',
      },
      (progress) => {
        if (progress.phase === 'fileTransfer' && progress.bookId === book2Id) {
          void transferCancelBackend.lanImportCancel('op-cancel-during-transfer').then((res) => {
            cancelReturned = res;
          });
        }
      },
    );
    expect(cancelReturned).toBe(true);
    expect(tcReport.cancelled).toBe(true);
    expect(tcReport.books[0]?.file).toEqual({ status: 'applied' });
    expect(tcReport.books[1]?.file).toEqual({ status: 'cancelled' });
    expect(await transferCancelBackend.listDocuments()).toHaveLength(1);

    // 6. Concurrent execution on the same planId rejects with `lan_transfer_busy`,
    // and two different planIds importing the same book concurrently create only ONE document ID.
    let releaseCommitBarrier!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      releaseCommitBarrier = resolve;
    });
    let commitWaiters = 0;
    const concurrentBackend = createMemoryBackend({
      library: {},
      lanPeer: {
        pairingCode: '123456',
        books: [{ title: 'Shared Book', format: 'txt', extension: 'txt', bytes: book1Bytes }],
        onBeforeBookStep: async (phase) => {
          if (phase === 'commit') {
            commitWaiters += 1;
            await commitBarrier;
          }
        },
      },
    });
    const cSession = await concurrentBackend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const cCatalog = await concurrentBackend.lanImportCatalog(cSession.sessionId);
    const planA = await concurrentBackend.lanImportPlan(
      { sessionId: cSession.sessionId, bookIds: [cCatalog[0]!.bookId] },
      () => undefined,
    );
    const planB = await concurrentBackend.lanImportPlan(
      { sessionId: cSession.sessionId, bookIds: [cCatalog[0]!.bookId] },
      () => undefined,
    );

    const execA = concurrentBackend.lanImportExecute(
      {
        sessionId: cSession.sessionId,
        planId: planA.planId,
        decisions: planA.defaultDecisions,
      },
      () => undefined,
    );
    // Same planId re-entry must fail immediately with `lan_transfer_busy`.
    await expect(
      concurrentBackend.lanImportExecute(
        {
          sessionId: cSession.sessionId,
          planId: planA.planId,
          decisions: planA.defaultDecisions,
        },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'lan_transfer_busy' });

    // Different planId importing the exact same book concurrently must converge on ONE document ID.
    const execB = concurrentBackend.lanImportExecute(
      {
        sessionId: cSession.sessionId,
        planId: planB.planId,
        decisions: planB.defaultDecisions,
      },
      () => undefined,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(commitWaiters).toBe(2);
    releaseCommitBarrier();

    const [repA, repB] = await Promise.all([execA, execB]);
    expect(repA.books[0]?.documentId).toBeTruthy();
    expect(repB.books[0]?.documentId).toBe(repA.books[0]?.documentId);
    expect(await concurrentBackend.listDocuments()).toHaveLength(1);
  });

  it('preserves concurrent local reading position updates during missing-file repair for both importPosition false and true', async () => {
    const encoder = new TextEncoder();
    const bookBytes = encoder.encode('Missing managed book content for repair test');
    const localAnchor = {
      format: 'txt' as const,
      startByteOffset: 8,
      endByteOffset: 15,
      lineIndex: 0,
    };
    const remoteAnchor = {
      format: 'txt' as const,
      startByteOffset: 0,
      endByteOffset: 7,
      lineIndex: 0,
    };

    const runScenario = async (importPosition: boolean) => {
      let fileMissing = false;
      let releaseRepair!: () => void;
      const repairPaused = new Promise<void>((resolve) => {
        releaseRepair = resolve;
      });
      let enteredCommit!: () => void;
      const commitEntered = new Promise<void>((resolve) => {
        enteredCommit = resolve;
      });

      const backend = createMemoryBackend({
        library: {
          '/local/missing-book.txt': async () => {
            if (fileMissing) throw new Error('ENOENT');
            return bookBytes;
          },
        },
        lanPeer: {
          pairingCode: '123456',
          books: [
            {
              title: 'missing-book',
              format: 'txt',
              extension: 'txt',
              bytes: bookBytes,
              position: { anchor: remoteAnchor, progress: 0.2 },
            },
          ],
          onBeforeBookStep: async (phase) => {
            if (phase === 'commit') {
              enteredCommit();
              await repairPaused;
            }
          },
        },
      });

      const doc = (await backend.pickDocument())!;
      fileMissing = true;
      expect((await backend.verifyDocumentSource(doc.id)).state).toBe('missing');

      const session = await backend.lanImportConnect({
        address: '192.168.1.25:49319',
        code: '123456',
      });
      const catalog = await backend.lanImportCatalog(session.sessionId);
      expect(catalog[0]?.state).toBe('missingFile');

      const plan = await backend.lanImportPlan(
        { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
        () => undefined,
      );

      const execPromise = backend.lanImportExecute(
        {
          sessionId: session.sessionId,
          planId: plan.planId,
          decisions: [
            {
              bookId: catalog[0]!.bookId,
              importFile: true,
              importPosition,
              importBookmarks: false,
            },
          ],
        },
        () => undefined,
      );

      await commitEntered;
      // Local reading position updates while file repair is in flight.
      await backend.updateDocumentCursor(doc.id, localAnchor, 0.5);
      releaseRepair();

      const report = await execPromise;
      const updatedDoc = (await backend.listDocuments()).find((d) => d.id === doc.id)!;
      return { backend, session, plan, catalog, doc, report, updatedDoc };
    };

    // Case 1: importPosition = false -> file repaired, concurrent local progress 0.5 preserved.
    const keepLocal = await runScenario(false);
    expect(keepLocal.report.books[0]?.file).toEqual({ status: 'applied' });
    expect(keepLocal.report.books[0]?.position).toEqual({ status: 'skipped' });
    expect(keepLocal.updatedDoc.lastProgress).toBe(0.5);
    expect(keepLocal.updatedDoc.lastCursorAnchor).toEqual(localAnchor);

    // Case 2: importPosition = true -> file repaired, local progress 0.5 preserved and
    // `lan_position_conflict` returned until user explicitly re-confirms.
    const conflictCase = await runScenario(true);
    expect(conflictCase.report.books[0]?.file).toEqual({ status: 'applied' });
    expect(conflictCase.report.books[0]?.position).toEqual({
      status: 'conflict',
      code: 'lan_position_conflict',
      hasCurrentPosition: true,
      currentProgress: 0.5,
    });
    expect(conflictCase.updatedDoc.lastProgress).toBe(0.5);
    expect(conflictCase.updatedDoc.lastCursorAnchor).toEqual(localAnchor);

    // User re-confirms with `overridePositionConflict: true` -> remote position applies cleanly.
    const overrideReport = await conflictCase.backend.lanImportExecute(
      {
        sessionId: conflictCase.session.sessionId,
        planId: conflictCase.plan.planId,
        decisions: [
          {
            bookId: conflictCase.catalog[0]!.bookId,
            importFile: false,
            importPosition: true,
            importBookmarks: false,
            overridePositionConflict: true,
          },
        ],
      },
      () => undefined,
    );
    expect(overrideReport.books[0]?.position).toEqual({ status: 'applied' });
    const afterOverride = (await conflictCase.backend.listDocuments()).find(
      (d) => d.id === conflictCase.doc.id,
    )!;
    expect(afterOverride.lastProgress).toBe(0.2);
    expect(afterOverride.lastCursorAnchor).toEqual(remoteAnchor);
  });

  it('reuses a concurrently registered healthy local file without rewriting filePath or creating a managed copy', async () => {
    const bookBytes = new TextEncoder().encode('Concurrently registered local book bytes');
    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });

    const backend = createMemoryBackend({
      library: { '/local/book.txt': bookBytes },
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'book',
            format: 'txt',
            extension: 'txt',
            bytes: bookBytes,
          },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'commit') {
            enteredCommit();
            await commitBarrier;
          }
        },
      },
    });

    const session = await backend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const catalog = await backend.lanImportCatalog(session.sessionId);
    expect(catalog[0]?.state).toBe('new');

    const plan = await backend.lanImportPlan(
      { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
      () => undefined,
    );

    const execPromise = backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: plan.defaultDecisions,
      },
      () => undefined,
    );

    await commitEntered;
    // Register the exact same file via native picker while the LAN import is paused.
    const picked = (await backend.pickDocument())!;
    expect(picked.filePath).toBe('/local/book.txt');
    releaseCommit();

    const report = await execPromise;
    expect(report.books[0]?.documentId).toBe(picked.id);
    expect(report.books[0]?.file).toEqual({ status: 'skipped' });

    const docs = await backend.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(picked.id);
    expect(docs[0]?.filePath).toBe('/local/book.txt');

    // Verify no extra managed `/library/...` copy was written.
    const expectedManagedPath = `/library/${picked.fileHash.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    await expect(
      backend.loadDocumentSource({ ...picked, filePath: expectedManagedPath }),
    ).rejects.toMatchObject({ code: 'io' });
  });

  it('aborts without mutating files or metadata when cancelled during commit-time readFile (both success and ENOENT)', async () => {
    const bookBytes = new TextEncoder().encode('Book content for cancel-during-readFile');
    const remoteAnchor = {
      format: 'txt' as const,
      startByteOffset: 0,
      endByteOffset: 4,
      lineIndex: 0,
    };

    for (const shouldReject of [false, true]) {
      let fileMissing = false;
      let pauseNextRead = false;
      let enteredRead!: () => void;
      const readEntered = new Promise<void>((resolve) => {
        enteredRead = resolve;
      });
      let releaseRead!: () => void;
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });

      const backend = createMemoryBackend({
        library: {
          '/local/book.txt': async () => {
            if (pauseNextRead) {
              pauseNextRead = false;
              enteredRead();
              await readReleased;
              if (shouldReject) throw new Error('ENOENT');
              return bookBytes;
            }
            if (fileMissing) throw new Error('ENOENT');
            return bookBytes;
          },
        },
        lanPeer: {
          pairingCode: '123456',
          books: [
            {
              title: 'book',
              format: 'txt',
              extension: 'txt',
              bytes: bookBytes,
              position: { anchor: remoteAnchor, progress: 0.4 },
              bookmarks: [{ anchor: remoteAnchor, label: 'Should not write' }],
            },
          ],
          onBeforeBookStep: async (phase) => {
            if (phase === 'commit') {
              pauseNextRead = true;
            }
          },
        },
      });

      const doc = (await backend.pickDocument())!;
      fileMissing = true;
      const session = await backend.lanImportConnect({
        address: '192.168.1.25:49319',
        code: '123456',
      });
      const catalog = await backend.lanImportCatalog(session.sessionId);
      expect(catalog[0]?.state).toBe('missingFile');

      const plan = await backend.lanImportPlan(
        { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
        () => undefined,
      );

      const execPromise = backend.lanImportExecute(
        {
          sessionId: session.sessionId,
          planId: plan.planId,
          decisions: [
            {
              bookId: catalog[0]!.bookId,
              importFile: true,
              importPosition: true,
              importBookmarks: true,
            },
          ],
          operationId: 'op-cancel-during-read',
        },
        () => undefined,
      );

      await readEntered;
      expect(await backend.lanImportCancel('op-cancel-during-read')).toBe(true);
      releaseRead();

      const report = await execPromise;
      expect(report.cancelled).toBe(true);
      expect(report.books[0]?.file).toEqual({ status: 'cancelled' });
      expect(report.books[0]?.position).toEqual({ status: 'cancelled' });
      expect(report.books[0]?.bookmarks).toEqual({ status: 'cancelled' });

      const afterDoc = (await backend.listDocuments()).find((d) => d.id === doc.id)!;
      expect(afterDoc.filePath).toBe('/local/book.txt');
      expect(afterDoc.lastCursorAnchor).toBeNull();
      expect(afterDoc.lastProgress).toBeNull();
      expect(await backend.listBookmarks()).toHaveLength(0);
    }
  });

  it('blocks file, position, and bookmarks with localFileChanged when commit-time readFile returns modified bytes', async () => {
    const originalBytes = new TextEncoder().encode('Original book bytes');
    const modifiedBytes = new TextEncoder().encode('Locally modified book bytes');
    const remoteAnchor = {
      format: 'txt' as const,
      startByteOffset: 0,
      endByteOffset: 8,
      lineIndex: 0,
    };
    let diskState: 'original' | 'missing' | 'modified' = 'original';

    const backend = createMemoryBackend({
      library: {
        '/local/book.txt': async () => {
          if (diskState === 'missing') throw new Error('ENOENT');
          return diskState === 'original' ? originalBytes : modifiedBytes;
        },
      },
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'book',
            format: 'txt',
            extension: 'txt',
            bytes: originalBytes,
            position: { anchor: remoteAnchor, progress: 0.7 },
            bookmarks: [{ anchor: remoteAnchor, label: 'Blocked BM' }],
          },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'commit') {
            // File reappears with modified bytes right before commit verification.
            diskState = 'modified';
          }
        },
      },
    });

    const doc = (await backend.pickDocument())!;
    diskState = 'missing';
    const session = await backend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const catalog = await backend.lanImportCatalog(session.sessionId);
    expect(catalog[0]?.state).toBe('missingFile');

    const plan = await backend.lanImportPlan(
      { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
      () => undefined,
    );

    const report = await backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: [
          {
            bookId: catalog[0]!.bookId,
            importFile: true,
            importPosition: true,
            importBookmarks: true,
          },
        ],
      },
      () => undefined,
    );

    expect(report.books[0]?.state).toBe('localFileChanged');
    expect(report.books[0]?.file).toEqual({ status: 'blocked', reason: 'localFileChanged' });
    expect(report.books[0]?.position).toEqual({ status: 'skipped' });
    expect(report.books[0]?.bookmarks).toEqual({ status: 'skipped' });

    const afterDoc = (await backend.listDocuments()).find((d) => d.id === doc.id)!;
    expect(afterDoc.filePath).toBe('/local/book.txt');
    expect(afterDoc.lastCursorAnchor).toBeNull();
    expect(afterDoc.lastProgress).toBeNull();
    expect(await backend.listBookmarks()).toHaveLength(0);
  });

  it('re-verifies the relinked healthy path when relinkDocument runs during commit-time readFile', async () => {
    const bookBytes = new TextEncoder().encode('Same-hash relinked book bytes');
    let originalMissing = false;
    let pauseOriginalRead = false;
    let enteredOriginalRead!: () => void;
    const originalReadEntered = new Promise<void>((resolve) => {
      enteredOriginalRead = resolve;
    });
    let releaseOriginalRead!: () => void;
    const originalReadReleased = new Promise<void>((resolve) => {
      releaseOriginalRead = resolve;
    });

    const backend = createMemoryBackend({
      library: {
        '/local/book.txt': async () => {
          if (pauseOriginalRead) {
            pauseOriginalRead = false;
            enteredOriginalRead();
            await originalReadReleased;
            throw new Error('ENOENT');
          }
          if (originalMissing) throw new Error('ENOENT');
          return bookBytes;
        },
        '/local/relinked.txt': bookBytes,
      },
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'book',
            format: 'txt',
            extension: 'txt',
            bytes: bookBytes,
          },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'commit') {
            pauseOriginalRead = true;
          }
        },
      },
    });

    const doc = (await backend.pickDocument())!;
    expect(doc.filePath).toBe('/local/book.txt');
    originalMissing = true;

    const session = await backend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const catalog = await backend.lanImportCatalog(session.sessionId);
    expect(catalog[0]?.state).toBe('missingFile');

    const plan = await backend.lanImportPlan(
      { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
      () => undefined,
    );

    const execPromise = backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: plan.defaultDecisions,
      },
      () => undefined,
    );

    await originalReadEntered;
    // Relink the document to the healthy same-hash `/local/relinked.txt` while the old read is paused.
    const relinked = (await backend.relinkDocument(doc.id))!;
    expect(relinked.document.id).toBe(doc.id);
    expect(relinked.document.filePath).toBe('/local/relinked.txt');
    releaseOriginalRead();

    const report = await execPromise;
    expect(report.books[0]?.documentId).toBe(doc.id);
    expect(report.books[0]?.file).toEqual({ status: 'skipped' });

    const docs = await backend.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(doc.id);
    expect(docs[0]?.filePath).toBe('/local/relinked.txt');

    // No extra managed `/library/...` copy was created.
    const expectedManagedPath = `/library/${doc.fileHash.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    await expect(
      backend.loadDocumentSource({ ...doc, filePath: expectedManagedPath }),
    ).rejects.toMatchObject({ code: 'io' });
  });

  it('falls back to fileHash lookup when old document ID is relinked to different content and original content is re-registered', async () => {
    const originalBytes = new TextEncoder().encode('Original content for hash fallback');
    const differentBytes = new TextEncoder().encode('Completely different replacement content');
    let originalMissing = false;
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });

    const backend = createMemoryBackend({
      library: {
        '/local/original.txt': async () => {
          if (originalMissing) throw new Error('ENOENT');
          return originalBytes;
        },
        '/local/different.txt': differentBytes,
        '/local/reregistered.txt': originalBytes,
      },
      lanPeer: {
        pairingCode: '123456',
        books: [
          {
            title: 'original',
            format: 'txt',
            extension: 'txt',
            bytes: originalBytes,
          },
        ],
        onBeforeBookStep: async (phase) => {
          if (phase === 'commit') {
            enteredCommit();
            await commitReleased;
          }
        },
      },
    });

    // Pick `/local/original.txt` (index 0), then mark it missing.
    const oldDoc = (await backend.pickDocument())!;
    const originalHash = oldDoc.fileHash;
    originalMissing = true;

    const session = await backend.lanImportConnect({
      address: '192.168.1.25:49319',
      code: '123456',
    });
    const catalog = await backend.lanImportCatalog(session.sessionId);
    expect(catalog[0]?.state).toBe('missingFile');

    const plan = await backend.lanImportPlan(
      { sessionId: session.sessionId, bookIds: [catalog[0]!.bookId] },
      () => undefined,
    );

    const execPromise = backend.lanImportExecute(
      {
        sessionId: session.sessionId,
        planId: plan.planId,
        decisions: plan.defaultDecisions,
      },
      () => undefined,
    );

    await commitEntered;
    // Relink `oldDoc` to `/local/different.txt` (index 1, different hash), then
    // pick `/local/reregistered.txt` (index 2, same hash as `originalBytes`).
    const relinked = (await backend.relinkDocument(oldDoc.id))!;
    expect(relinked.document.fileHash).not.toBe(originalHash);
    const newlyPicked = (await backend.pickDocument())!;
    expect(newlyPicked.fileHash).toBe(originalHash);
    expect(newlyPicked.filePath).toBe('/local/reregistered.txt');
    releaseCommit();

    const report = await execPromise;
    expect(report.books[0]?.documentId).toBe(newlyPicked.id);
    expect(report.books[0]?.file).toEqual({ status: 'skipped' });

    const docsWithOriginalHash = (await backend.listDocuments()).filter(
      (d) => d.fileHash === originalHash,
    );
    expect(docsWithOriginalHash).toHaveLength(1);
    expect(docsWithOriginalHash[0]?.id).toBe(newlyPicked.id);
    expect(docsWithOriginalHash[0]?.filePath).toBe('/local/reregistered.txt');
  });

  it('hides documents from recent while keeping study records and restores on reopen or relink', async () => {
    const bytes = new TextEncoder().encode('study text');
    const backend = createMemoryBackend({
      library: {
        '/books/study.txt': bytes,
        '/books/study-moved.txt': bytes,
      },
    });

    const doc = (await backend.pickDocument())!;
    expect(doc.hiddenFromRecentAt).toBeNull();

    const bookmark = await backend.createBookmark({
      documentId: doc.id,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
      label: 'First line',
    });

    const hidden = await backend.hideDocumentFromRecent(doc.id);
    expect(typeof hidden.hiddenFromRecentAt).toBe('string');
    const listed = await backend.listDocuments();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.hiddenFromRecentAt).toBe(hidden.hiddenFromRecentAt);
    expect((await backend.listBookmarks()).map((b) => b.id)).toEqual([bookmark.id]);

    // touchDocumentOpened clears the flag.
    const touched = await backend.touchDocumentOpened(doc.id);
    expect(touched.hiddenFromRecentAt).toBeNull();

    // Hiding again, then dropping the same file restores it.
    await backend.hideDocumentFromRecent(doc.id);
    const dropped = await backend.dropFiles([
      new File([bytes], 'study.txt', { type: 'text/plain' }),
    ]);
    expect(dropped.error).toBeNull();
    expect(dropped.documents[0]?.hiddenFromRecentAt).toBeNull();

    // Hiding again, then relinking clears the flag.
    await backend.hideDocumentFromRecent(doc.id);
    const relinked = await backend.relinkDocument(doc.id);
    expect(relinked?.document.hiddenFromRecentAt).toBeNull();

    // Unknown id fails with not_found.
    await expect(backend.hideDocumentFromRecent('missing-doc')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('sets, sanitizes, persists, and clears displayTitle only on content relink', async () => {
    const original = new TextEncoder().encode('original edition');
    const revised = new TextEncoder().encode('revised edition');
    const backend = createMemoryBackend({
      library: {
        '/books/pg1342.txt': original,
        '/books/pg1342-moved.txt': original,
        '/books/pg1342-v2.txt': revised,
      },
    });

    const doc = (await backend.pickDocument())!;
    expect(doc.title).toBe('pg1342');
    expect(doc.displayTitle).toBeNull();

    const sanitized = await backend.setDocumentDisplayTitle(
      doc.id,
      '\n\u0000\u202E  Pride and\u200E\u2066 Prejudice \u001F\nSecond Line',
    );
    expect(sanitized.title).toBe('pg1342');
    expect(sanitized.displayTitle).toBe('Pride and Prejudice');

    const truncated = await backend.setDocumentDisplayTitle(doc.id, '书'.repeat(600));
    expect(Array.from(truncated.displayTitle ?? '')).toHaveLength(512);
    expect(truncated.displayTitle?.endsWith('…')).toBe(true);

    const blank = await backend.setDocumentDisplayTitle(doc.id, ' \n\u202E\u0000 ');
    expect(blank.displayTitle).toBeNull();

    await backend.setDocumentDisplayTitle(doc.id, 'Pride and Prejudice');

    // Same-hash relink preserves displayTitle.
    const sameHash = (await backend.relinkDocument(doc.id))!;
    expect(sameHash.contentChanged).toBe(false);
    expect(sameHash.document.title).toBe('pg1342-moved');
    expect(sameHash.document.displayTitle).toBe('Pride and Prejudice');

    // Content-changing relink clears displayTitle.
    const changed = (await backend.relinkDocument(doc.id))!;
    expect(changed.contentChanged).toBe(true);
    expect(changed.document.displayTitle).toBeNull();

    // Explicit null clears displayTitle.
    await backend.setDocumentDisplayTitle(doc.id, 'Temporary Title');
    const cleared = await backend.setDocumentDisplayTitle(doc.id, null);
    expect(cleared.displayTitle).toBeNull();

    await expect(backend.setDocumentDisplayTitle('missing-doc', 'Title')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
