import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanImportDialog } from '@/features/lanSync/LanImportDialog';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { MemoryLanPeerBook } from '@/lib/backend/memoryLanPeer';
import type { StudyBackend } from '@/lib/backend/types';
import * as platformModule from '@/lib/platform';
import { createStudySyncStore, useStudySyncStore } from '@/stores/useStudySyncStore';
import type { Bookmark, LanImportPlanResult, StudyDocument } from '@/types/domain';

const initialStoreState = useStudySyncStore.getState();
const encode = (text: string) => new TextEncoder().encode(text);

function makeDoc(overrides: Partial<StudyDocument> & { id: string; title: string }): StudyDocument {
  return {
    filePath: `/docs/${overrides.id}.txt`,
    fileHash: `hash-${overrides.id}`,
    format: 'txt',
    encoding: 'utf-8',
    lastCursorAnchor: null,
    lastOpenedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    lastProgress: null,
    ...overrides,
  };
}

let unbindStore: (() => void) | null = null;

function bindTestStore(
  backend: StudyBackend = createMemoryBackend(),
  initialDocs: StudyDocument[] = [],
) {
  unbindStore?.();
  const temp = createStudySyncStore(backend);
  if (initialDocs.length > 0) {
    temp.setState({ documents: initialDocs });
  }
  useStudySyncStore.setState(temp.getState(), true);
  unbindStore = temp.subscribe((next) => {
    useStudySyncStore.setState(next);
  });
  return temp;
}

describe('LanImportDialog', () => {
  beforeEach(() => {
    bindTestStore();
  });

  afterEach(() => {
    unbindStore?.();
    unbindStore = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    useStudySyncStore.setState(initialStoreState, true);
    document.body.innerHTML = '';
  });

  it('validates connect form, strips spaces in code, single auto-retries lan_unreachable, and renders macOS vs non-macOS hints', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(platformModule, 'detectPlatform').mockReturnValue('mac');

    const backend = createMemoryBackend();
    const connectSpy = vi
      .spyOn(backend, 'lanImportConnect')
      .mockRejectedValueOnce({ code: 'lan_unreachable', message: 'connect timed out' })
      .mockRejectedValueOnce({ code: 'lan_unreachable', message: 'connect timed out' })
      .mockRejectedValueOnce({ code: 'lan_unreachable', message: 'connect timed out' })
      .mockResolvedValueOnce({
        sessionId: 'sess-1',
        address: '192.168.1.42:49319',
        idleTimeoutSeconds: 600,
        permissions: { positions: true, bookmarks: true },
      });
    vi.spyOn(backend, 'lanImportCatalog').mockResolvedValue([]);
    bindTestStore(backend);

    render(<LanImportDialog open onClose={() => undefined} />);

    // Initial focus goes to the IPv4 address field.
    expect(screen.getByTestId('lan-import-address-input')).toHaveFocus();

    // Empty validation.
    fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
    expect(screen.getByTestId('lan-import-validation-error')).toHaveTextContent(
      'Enter the source device IPv4 address',
    );
    expect(connectSpy).not.toHaveBeenCalled();

    // Fill address + spaced code; whitespace is stripped automatically.
    fireEvent.change(screen.getByTestId('lan-import-address-input'), {
      target: { value: '192.168.1.42' },
    });
    fireEvent.change(screen.getByTestId('lan-import-code-input'), {
      target: { value: '123 456' },
    });
    expect(screen.getByTestId('lan-import-code-input')).toHaveValue('123456');

    fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
    await act(async () => {
      await Promise.resolve();
    });

    // First failure with `lan_unreachable` schedules a single auto-retry after 250ms.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lan-import-auto-retrying')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // Exactly 1 auto-retry occurs, then settles on the error card with macOS guidance.
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('lan-import-connect-error')).toHaveAttribute(
      'data-error-code',
      'lan_unreachable',
    );
    expect(screen.getByTestId('lan-import-connect-error')).toHaveTextContent(
      'Local Network access',
    );

    // Verify non-macOS hides Local Network prompt.
    platformSpy.mockReturnValue('other');
    fireEvent.change(screen.getByTestId('lan-import-address-input'), {
      target: { value: '192.168.1.43' },
    });
    fireEvent.change(screen.getByTestId('lan-import-address-input'), {
      target: { value: '192.168.1.42' },
    });

    // Re-trigger via Retry after settling -> succeeds on its single auto-retry.
    fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('lan-import-auto-retrying')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(connectSpy).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('lan-import-session-address')).toHaveTextContent(
      '192.168.1.42:49319',
    );
  });

  it('never auto-retries auth or incompatible version errors and cleans up cancelled retry timer', async () => {
    vi.useFakeTimers();
    const backend = createMemoryBackend();
    const connectSpy = vi
      .spyOn(backend, 'lanImportConnect')
      .mockRejectedValueOnce({ code: 'lan_auth_invalid', message: 'Wrong pairing code' })
      .mockRejectedValueOnce({ code: 'lan_protocol_incompatible', message: 'Update app' })
      .mockRejectedValueOnce({ code: 'lan_unreachable', message: 'Unreachable' });
    bindTestStore(backend);

    render(<LanImportDialog open onClose={() => undefined} />);

    fireEvent.change(screen.getByTestId('lan-import-address-input'), {
      target: { value: '192.168.1.42' },
    });
    fireEvent.change(screen.getByTestId('lan-import-code-input'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByTestId('lan-import-connect-submit'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lan-import-connect-error')).toHaveAttribute(
      'data-error-code',
      'lan_auth_invalid',
    );
    expect(screen.getByTestId('lan-import-connect-retry')).toBeInTheDocument();

    // Protocol mismatch fails fast with no Retry button.
    fireEvent.click(screen.getByTestId('lan-import-connect-retry'));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('lan-import-connect-error')).toHaveAttribute(
      'data-error-code',
      'lan_protocol_incompatible',
    );
    expect(screen.queryByTestId('lan-import-connect-retry')).not.toBeInTheDocument();

    // Re-submit hits lan_unreachable and is cancelled during the 250ms auto-retry wait.
    fireEvent.change(screen.getByTestId('lan-import-code-input'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('lan-import-connect-cancel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lan-import-connect-cancel'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Auto-retry never fired after Cancel.
    expect(connectSpy).toHaveBeenCalledTimes(3);
  });

  it('filters catalog, renders ineligible changed book without relink buttons, and blocks Escape while planning', async () => {
    const newBytes = encode('Fresh LAN Book content');
    const changedRemoteBytes = encode('Updated book v2 on peer');

    const peerBooks: MemoryLanPeerBook[] = [
      {
        bookId: 'book-fresh-new',
        title: 'Fresh Novel',
        format: 'txt',
        extension: 'txt',
        bytes: newBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 10, endByteOffset: 10, lineIndex: 1 },
          progress: 0.25,
        },
        bookmarks: [
          {
            anchor: { format: 'txt', startByteOffset: 10, endByteOffset: 10, lineIndex: 1 },
            label: 'Chapter 1',
          },
        ],
      },
    ];

    const backend = createMemoryBackend({
      lanPeer: { books: peerBooks },
    });
    const dropped = await backend.dropFiles([
      new File([changedRemoteBytes], 'changed.txt', { type: 'text/plain' }),
    ]);
    const localChangedDoc = dropped.documents[0]!;
    peerBooks.push({
      bookId: localChangedDoc.fileHash,
      title: localChangedDoc.title,
      format: 'txt',
      extension: 'txt',
      bytes: changedRemoteBytes,
      fileAvailable: true,
    });

    // Inject `localFileChanged` on catalog classification as well to verify catalog UI handling.
    const originalCatalog = backend.lanImportCatalog.bind(backend);
    vi.spyOn(backend, 'lanImportCatalog').mockImplementation(async (sessionId) => {
      const items = await originalCatalog(sessionId);
      return items.map((item) =>
        item.bookId === localChangedDoc.fileHash
          ? { ...item, state: 'localFileChanged', eligible: false }
          : item,
      );
    });

    let resolvePlanGate!: () => void;
    const planGate = new Promise<void>((resolve) => {
      resolvePlanGate = resolve;
    });
    vi.spyOn(backend, 'lanImportPlan').mockImplementationOnce(async (_input, onProgress) => {
      onProgress({ completedBooks: 0, totalBooks: 1, bookId: 'book-fresh-new' });
      await planGate;
      return {
        planId: 'plan-1',
        summary: { books: [] },
        defaultDecisions: [],
      };
    });
    const cancelSpy = vi.spyOn(backend, 'lanImportCancel');
    const store = bindTestStore(backend, [localChangedDoc]);
    const onClose = vi.fn();

    render(<LanImportDialog open onClose={onClose} />);
    await act(async () => {
      await store.getState().connectLanImport('192.168.1.42', '123456');
    });

    const newBookId = 'book-fresh-new';
    expect(
      screen.getByTestId(`lan-import-catalog-row-${localChangedDoc.fileHash}`),
    ).toHaveAttribute('data-sync-state', 'localFileChanged');
    expect(
      screen.getByTestId(`lan-import-catalog-ineligible-${localChangedDoc.fileHash}`),
    ).toHaveTextContent('Local file changed. Open this book to resolve the change first.');
    expect(
      screen.getByTestId(`lan-import-catalog-checkbox-${localChangedDoc.fileHash}`),
    ).toBeDisabled();
    expect(screen.queryByRole('button', { name: /relink/i })).not.toBeInTheDocument();

    // Filter search narrows catalog cleanly.
    fireEvent.change(screen.getByTestId('lan-import-catalog-search'), {
      target: { value: 'Fresh' },
    });
    expect(
      screen.queryByTestId(`lan-import-catalog-row-${localChangedDoc.fileHash}`),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId(`lan-import-catalog-row-${newBookId}`)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('lan-import-catalog-search'), {
      target: { value: '' },
    });

    // Select all eligible -> Review import enters planning state.
    fireEvent.click(screen.getByTestId('lan-import-catalog-select-all'));
    expect(screen.getByTestId(`lan-import-catalog-checkbox-${newBookId}`)).toBeChecked();

    fireEvent.click(screen.getByTestId('lan-import-review'));
    expect(await screen.findByTestId('lan-import-plan-progress')).toBeInTheDocument();

    // Escape and backdrop clicks are blocked during active planning (`R3-04`).
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('lan-import-dialog-backdrop'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('lan-import-plan-cancel'));
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    resolvePlanGate();
    await waitFor(() => {
      expect(screen.queryByTestId('lan-import-plan-progress')).not.toBeInTheDocument();
    });
  });

  it('enforces §2.3 preview dependencies, separate-version opt-in, bookmark pruning, and unmeasured EPUB label', () => {
    const epubDoc = makeDoc({
      id: 'doc-epub',
      title: 'Existing EPUB',
      format: 'epub',
      filePath: '/docs/existing.epub',
      fileHash: 'book-present',
      lastCursorAnchor: {
        format: 'epub',
        cfiRange: 'epubcfi(/6/4!/4/2)',
        chapterHref: 'ch1.xhtml',
      },
      lastProgress: null,
    });
    const missingDoc = makeDoc({
      id: 'doc-missing',
      title: 'Missing Book',
      filePath: '/docs/missing.txt',
      fileHash: 'book-missing',
    });

    const plan: LanImportPlanResult = {
      planId: 'plan-matrix',
      summary: {
        books: [
          {
            bookId: 'book-new',
            title: 'Brand New Book',
            format: 'txt',
            extension: 'txt',
            sizeBytes: 2048,
            state: 'new',
            eligible: true,
            needsFileDownload: true,
            localDocumentId: null,
            localTitle: null,
            position: {
              remoteAvailable: true,
              remoteProgress: 0.4,
              localHasPosition: false,
              localProgress: null,
              differs: true,
              defaultAdopt: true,
            },
            bookmarks: {
              newCount: 1,
              existingCount: 0,
              skippedCount: 0,
              entries: [
                {
                  index: 0,
                  label: 'Start Note',
                  createdAt: '2026-11-20T00:00:00.000Z',
                  status: { status: 'new' },
                },
              ],
              defaultImport: true,
            },
          },
          {
            bookId: 'book-present',
            title: 'Existing EPUB',
            format: 'epub',
            extension: 'epub',
            sizeBytes: 4096,
            state: 'alreadyPresent',
            eligible: true,
            needsFileDownload: false,
            localDocumentId: epubDoc.id,
            localTitle: epubDoc.title,
            position: {
              remoteAvailable: true,
              remoteProgress: null,
              localHasPosition: true,
              localProgress: null,
              differs: true,
              defaultAdopt: false,
            },
            bookmarks: {
              newCount: 2,
              existingCount: 1,
              skippedCount: 1,
              entries: [
                { index: 0, label: 'Ch 2', createdAt: null, status: { status: 'new' } },
                { index: 1, label: 'Ch 4', createdAt: null, status: { status: 'new' } },
                { index: 2, label: 'Intro', createdAt: null, status: { status: 'existing' } },
                {
                  index: 3,
                  label: 'Old Note',
                  createdAt: null,
                  status: { status: 'skipped', reason: { kind: 'formatMismatch' } },
                },
              ],
              defaultImport: true,
            },
          },
          {
            bookId: 'book-missing',
            title: 'Missing Book',
            format: 'txt',
            extension: 'txt',
            sizeBytes: 1024,
            state: 'missingFile',
            eligible: true,
            needsFileDownload: true,
            localDocumentId: missingDoc.id,
            localTitle: missingDoc.title,
            position: {
              remoteAvailable: false,
              remoteProgress: null,
              localHasPosition: false,
              localProgress: null,
              differs: false,
              defaultAdopt: false,
            },
            bookmarks: {
              newCount: 0,
              existingCount: 0,
              skippedCount: 0,
              entries: [],
              defaultImport: false,
            },
          },
          {
            bookId: 'book-alt',
            title: 'sample',
            format: 'txt',
            extension: 'txt',
            sizeBytes: 512,
            state: 'sameTitleDifferentVersion',
            eligible: true,
            needsFileDownload: true,
            localDocumentId: null,
            localTitle: null,
            position: {
              remoteAvailable: true,
              remoteProgress: 0.5,
              localHasPosition: false,
              localProgress: null,
              differs: true,
              defaultAdopt: true,
            },
            bookmarks: {
              newCount: 0,
              existingCount: 0,
              skippedCount: 0,
              entries: [],
              defaultImport: false,
            },
          },
        ],
      },
      defaultDecisions: [
        {
          bookId: 'book-new',
          importFile: true,
          importPosition: true,
          importBookmarks: true,
        },
        {
          bookId: 'book-present',
          importFile: false,
          importPosition: false,
          importBookmarks: true,
        },
        {
          bookId: 'book-missing',
          importFile: true,
          importPosition: false,
          importBookmarks: false,
        },
        {
          bookId: 'book-alt',
          importFile: false,
          importPosition: false,
          importBookmarks: false,
        },
      ],
    };

    const temp = bindTestStore(createMemoryBackend(), [epubDoc, missingDoc]);
    temp.setState({
      openDocumentIds: [epubDoc.id],
      lanImport: {
        phase: 'preview',
        session: {
          sessionId: 'sess-matrix',
          address: '192.168.1.42:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        },
        catalog: [],
        plan,
        planProgress: null,
        executionProgress: null,
        executionReport: null,
        activeOperationId: null,
        error: null,
      },
    });

    render(<LanImportDialog open onClose={() => undefined} />);

    // `new`: unchecking "Download book" clears and disables position + bookmarks.
    const newFileCb = screen.getByTestId('lan-import-file-checkbox-book-new');
    expect(newFileCb).toBeChecked();
    expect(screen.getByTestId('lan-import-position-checkbox-book-new')).toBeChecked();
    fireEvent.click(newFileCb);
    expect(screen.getByTestId('lan-import-position-checkbox-book-new')).not.toBeChecked();
    expect(screen.getByTestId('lan-import-position-checkbox-book-new')).toBeDisabled();
    expect(screen.getByTestId('lan-import-bookmarks-checkbox-book-new')).toBeDisabled();

    // `sameTitleDifferentVersion` starts unchecked and disables position until checked.
    const altFileCb = screen.getByTestId('lan-import-file-checkbox-book-alt');
    expect(altFileCb).not.toBeChecked();
    expect(screen.getByTestId('lan-import-position-checkbox-book-alt')).toBeDisabled();
    fireEvent.click(altFileCb);
    expect(screen.getByTestId('lan-import-position-checkbox-book-alt')).toBeEnabled();

    // `alreadyPresent` EPUB with unmeasured progress still displays `differs: true` summary and Keep yours.
    expect(screen.getByTestId('lan-import-file-status-book-present')).toHaveTextContent(
      'On this device — no file transfer needed',
    );
    expect(screen.getByTestId('lan-import-position-hint-book-present')).toHaveTextContent(
      'Keep yours',
    );
    expect(screen.getByTestId('lan-import-position-note-book-present')).toHaveTextContent(
      'Different reading position on source device',
    );
    // Open local document relabels checkbox & displays open-book flush warning once checked.
    const presentPosCb = screen.getByTestId('lan-import-position-checkbox-book-present');
    expect(presentPosCb.closest('label')).toHaveTextContent('Close and use source position');
    fireEvent.click(presentPosCb);
    expect(screen.getByTestId('lan-import-open-book-warning')).toHaveTextContent(
      '1 open book will close cleanly',
    );

    // Bookmark expander & individual bookmark deselection.
    const toggleBtn = screen.getByTestId('lan-import-bookmarks-toggle-book-present');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('lan-import-bookmarks-list-book-present')).toHaveTextContent(
      'Already on device',
    );
    fireEvent.click(screen.getByTestId('lan-import-bookmark-checkbox-book-present-0'));
    expect(
      screen.getByTestId('lan-import-bookmarks-checkbox-book-present').closest('label'),
    ).toHaveTextContent('1 of 2 new selected');
  });

  it('closes open book before import, surfaces position conflict with 1-click override, handles mid-transfer cancel & retry, keeps session on Back to catalog, and supports Continue reading', async () => {
    const newBytes = encode('Brand New Chapter Book');
    const newBookId = 'book-brand-new-chapter';
    const sharedPresentBytes = encode('Shared Existing Book');

    const peerBooks: MemoryLanPeerBook[] = [];
    const backend = createMemoryBackend({
      lanPeer: { books: peerBooks },
    });
    const dropped = await backend.dropFiles([
      new File([sharedPresentBytes], 'existing-open.txt', { type: 'text/plain' }),
    ]);
    const rawDoc = dropped.documents[0]!;
    // Save a local cursor so §2.3 defaults to "Keep yours" (unchecked) until clicked.
    await backend.updateDocumentCursor(
      rawDoc.id,
      { format: 'txt', startByteOffset: 4, endByteOffset: 4, lineIndex: 0 },
      0.25,
    );
    const presentDoc: StudyDocument = {
      ...rawDoc,
      lastCursorAnchor: { format: 'txt', startByteOffset: 4, endByteOffset: 4, lineIndex: 0 },
      lastProgress: 0.25,
    };
    peerBooks.push(
      {
        bookId: newBookId,
        title: 'Brand New Chapter Book',
        format: 'txt',
        extension: 'txt',
        bytes: newBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 8, endByteOffset: 8, lineIndex: 0 },
          progress: 0.5,
        },
        bookmarks: [
          {
            anchor: { format: 'txt', startByteOffset: 5, endByteOffset: 5, lineIndex: 0 },
            label: 'Remote Mark',
          },
        ],
      },
      {
        bookId: presentDoc.fileHash,
        title: 'Existing Open Book',
        format: 'txt',
        extension: 'txt',
        bytes: sharedPresentBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 18, endByteOffset: 18, lineIndex: 0 },
          progress: 0.9,
        },
        bookmarks: [],
      },
    );

    const disconnectSpy = vi.spyOn(backend, 'lanImportDisconnect');
    const cancelSpy = vi.spyOn(backend, 'lanImportCancel');
    const executeSpy = vi.spyOn(backend, 'lanImportExecute');
    const origListDocs = backend.listDocuments.bind(backend);
    const origListBookmarks = backend.listBookmarks.bind(backend);
    let backendImportedDoc: StudyDocument | null = null;
    let backendImportedBookmark: Bookmark | null = null;
    vi.spyOn(backend, 'listDocuments').mockImplementation(async () => {
      const base = await origListDocs();
      return backendImportedDoc ? [...base, backendImportedDoc] : base;
    });
    vi.spyOn(backend, 'listBookmarks').mockImplementation(async () => {
      const base = await origListBookmarks();
      return backendImportedBookmark ? [...base, backendImportedBookmark] : base;
    });

    let gateTransfer!: () => void;
    let triggerConflictNext = true;

    const callOrder: string[] = [];
    const store = bindTestStore(backend, [presentDoc]);
    store.setState({ openDocumentIds: [presentDoc.id] });

    const originalCloseFlush = store.getState().closeDocumentAndFlush;
    const closeFlushSpy = vi.fn(async (docId: string) => {
      callOrder.push(`closeDocumentAndFlush:${docId}`);
      await originalCloseFlush(docId);
    });
    const reopenSpy = vi.fn(async () => undefined);
    store.setState({
      closeDocumentAndFlush: closeFlushSpy,
      reopenRecentDocument: reopenSpy,
    });

    executeSpy.mockImplementation(async (input, onProgress) => {
      callOrder.push(`lanImportExecute:${input.decisions.map((d) => d.bookId).join(',')}`);
      const hasOverride = input.decisions.some((d) => d.overridePositionConflict === true);

      if (triggerConflictNext && !hasOverride && input.decisions.length === 2) {
        triggerConflictNext = false;
        const pausePromise = new Promise<void>((resolve) => {
          gateTransfer = resolve;
        });
        onProgress({ phase: 'bookStarted', bookId: newBookId, bookIndex: 0, totalBooks: 2 });
        onProgress({
          phase: 'fileTransfer',
          bookId: newBookId,
          downloadedBytes: 11,
          totalBytes: newBytes.byteLength,
        });
        await pausePromise;

        return {
          books: [
            {
              bookId: newBookId,
              documentId: 'doc-new-imported',
              state: 'new',
              file: { status: 'applied' },
              position: { status: 'applied' },
              bookmarks: { status: 'applied' },
              bookmarkCounts: { inserted: 1, existing: 0, skipped: 0 },
            },
            {
              bookId: presentDoc.fileHash,
              documentId: presentDoc.id,
              state: 'alreadyPresent',
              file: { status: 'skipped', reason: 'alreadyPresent' },
              position: {
                status: 'conflict',
                code: 'lan_position_conflict',
                hasCurrentPosition: true,
                currentProgress: 0.72,
              },
              bookmarks: { status: 'skipped' },
              bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
            },
          ],
          cancelled: false,
        };
      }

      if (hasOverride) {
        return {
          books: [
            {
              bookId: presentDoc.fileHash,
              documentId: presentDoc.id,
              state: 'alreadyPresent',
              file: { status: 'skipped' },
              position: { status: 'applied' },
              bookmarks: { status: 'skipped' },
              bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
            },
          ],
          cancelled: false,
        };
      }

      // Subsequent batch for Cancel -> Retry test
      if (input.decisions.length === 1 && input.decisions[0]?.bookId === newBookId) {
        const secondCallIndex = executeSpy.mock.calls.length;
        if (secondCallIndex === 3) {
          onProgress({ phase: 'bookStarted', bookId: newBookId, bookIndex: 0, totalBooks: 1 });
          onProgress({
            phase: 'fileTransfer',
            bookId: newBookId,
            downloadedBytes: 5,
            totalBytes: newBytes.byteLength,
          });
          await new Promise<void>((resolve) => {
            gateTransfer = resolve;
          });
          return {
            books: [
              {
                bookId: newBookId,
                documentId: null,
                state: 'new',
                file: { status: 'cancelled' },
                position: { status: 'cancelled' },
                bookmarks: { status: 'cancelled' },
                bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
              },
            ],
            cancelled: true,
          };
        }

        // Populate backend docs & bookmarks on retry so store live-refresh updates Recent & Bookmarks.
        backendImportedDoc = makeDoc({
          id: 'doc-new-imported',
          title: 'Brand New Chapter Book',
          filePath: '/managed/new.txt',
          fileHash: newBookId,
        });
        backendImportedBookmark = {
          id: 'bm-1',
          documentId: backendImportedDoc.id,
          anchor: { format: 'txt', startByteOffset: 5, endByteOffset: 5, lineIndex: 0 },
          label: 'Remote Mark',
          createdAt: '2026-11-23T00:00:00.000Z',
        };
        return {
          books: [
            {
              bookId: newBookId,
              documentId: backendImportedDoc.id,
              state: 'new',
              file: { status: 'applied' },
              position: { status: 'applied' },
              bookmarks: { status: 'applied' },
              bookmarkCounts: { inserted: 1, existing: 0, skipped: 0 },
            },
          ],
          cancelled: false,
        };
      }

      return { books: [], cancelled: false };
    });

    const onClose = vi.fn();
    render(<LanImportDialog open onClose={onClose} />);

    // Connect -> Catalog -> Plan both books -> Preview
    await act(async () => {
      await store.getState().connectLanImport('192.168.1.42', '123456');
    });
    fireEvent.click(screen.getByTestId('lan-import-catalog-select-all'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-import-review'));
    });

    // Enable position import for open book -> shows "Close and use source position"
    await waitFor(() => {
      expect(
        screen.getByTestId(`lan-import-position-checkbox-${presentDoc.fileHash}`),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`lan-import-position-checkbox-${presentDoc.fileHash}`));

    // Start Batch 1 -> mid-transfer blocks Escape, backdrop click, and X close button
    fireEvent.click(screen.getByTestId('lan-import-start-execute'));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('lan-import-dialog-backdrop'));
    expect(onClose).not.toHaveBeenCalled();

    // Release transfer gate -> shows conflict + imported new book
    gateTransfer();
    expect(await screen.findByTestId('lan-import-results')).toBeInTheDocument();

    expect(callOrder[0]).toBe(`closeDocumentAndFlush:${presentDoc.id}`);
    expect(callOrder[1]).toContain('lanImportExecute:');

    const conflictBox = screen.getByTestId(`lan-import-conflict-${presentDoc.fileHash}`);
    expect(conflictBox).toHaveTextContent('72%');

    // Click 1-click "Replace with source position anyway"
    fireEvent.click(screen.getByTestId(`lan-import-conflict-override-${presentDoc.fileHash}`));
    await waitFor(() => {
      expect(
        screen.queryByTestId(`lan-import-conflict-${presentDoc.fileHash}`),
      ).not.toBeInTheDocument();
    });
    // First imported book stayed visible in merged report!
    expect(screen.getByTestId(`lan-import-continue-${newBookId}`)).toBeInTheDocument();

    // Back to catalog MUST NOT call lanImportDisconnect (`R3-09`)
    fireEvent.click(screen.getByTestId('lan-import-back-to-catalog'));
    await waitFor(() => {
      expect(screen.getByTestId('lan-import-catalog-list')).toBeInTheDocument();
    });
    expect(disconnectSpy).not.toHaveBeenCalled();

    // Plan only the new book -> start -> cancel mid-transfer -> Retry failed items
    fireEvent.click(screen.getByTestId('lan-import-catalog-clear'));
    fireEvent.click(screen.getByTestId(`lan-import-catalog-checkbox-${newBookId}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-import-review'));
    });
    fireEvent.click(await screen.findByTestId('lan-import-start-execute'));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lan-import-cancel-transfer'));
    expect(cancelSpy).toHaveBeenCalled();
    gateTransfer();

    expect(await screen.findByTestId('lan-import-results-banner')).toHaveAttribute(
      'data-report-status',
      'cancelled',
    );
    fireEvent.click(screen.getByTestId('lan-import-retry-failed'));

    await waitFor(() => {
      expect(screen.getByTestId('lan-import-results-banner')).toHaveAttribute(
        'data-report-status',
        'completed',
      );
    });
    expect(
      store.getState().bookmarks.filter((b) => b.documentId === 'doc-new-imported'),
    ).toHaveLength(1);

    // Continue reading disconnects, closes dialog, and opens document cleanly
    fireEvent.click(screen.getByTestId(`lan-import-continue-${newBookId}`));
    await waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(reopenSpy).toHaveBeenCalledWith('doc-new-imported');
    });
  });

  it('Done disconnects and closes cleanly', async () => {
    const backend = createMemoryBackend({
      lanPeer: { books: [] },
    });
    const disconnectSpy = vi.spyOn(backend, 'lanImportDisconnect');
    const store = bindTestStore(backend);
    store.setState({
      lanImport: {
        phase: 'results',
        session: {
          sessionId: 'sess-done',
          address: '192.168.1.42:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        },
        catalog: [],
        plan: null,
        planProgress: null,
        executionProgress: null,
        executionReport: { books: [], cancelled: false },
        activeOperationId: null,
        error: null,
      },
    });
    const onClose = vi.fn();

    render(<LanImportDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('lan-import-done'));

    await waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalledWith('sess-done');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
