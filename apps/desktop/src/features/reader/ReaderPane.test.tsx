import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandState, forgetRecentCommandRuns, runCommand } from '@/features/commands/registry';
import { useFocusPageOnActivate } from '@/features/reader/focusPage';
import { ReaderNotice, ReaderPopoverLayer } from '@/features/reader/ReaderNotice';
import type * as BackendModule from '@/lib/backend';
import type { StudyBackend } from '@/lib/backend';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { AnchorLocation, DocumentViewerProps } from '@/types/domain';

import { describeResumeLocation, ReaderPane } from './ReaderPane';

const backendHolder = vi.hoisted(() => ({ current: null as StudyBackend | null }));
const unmountCursorByDoc = new Map<string, AnchorLocation>();

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendModule>();
  return {
    ...actual,
    createDefaultBackend: () => {
      const backend = actual.createDefaultBackend();
      backendHolder.current = backend;
      return backend;
    },
  };
});

/**
 * These tests are about the tab commands, so a small stand-in fulfils the viewer
 * contract; each real engine has its own tests.
 */
function FakeViewer({ document, isActive, chromeHidden, onCursorChange }: DocumentViewerProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const onCursorChangeRef = useRef(onCursorChange);
  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);
  useEffect(
    () => () => {
      const anchor = unmountCursorByDoc.get(document.id);
      if (anchor) onCursorChangeRef.current(anchor, 0.9);
    },
    [document.id],
  );
  useFocusPageOnActivate(pageRef, isActive);
  return (
    <div ref={pageRef} data-testid={`fake-viewer-${document.id}`} tabIndex={-1}>
      <ReaderPopoverLayer hidden={Boolean(chromeHidden)}>
        <ReaderNotice
          tone="warning"
          testId={`viewer-warning-${document.id}`}
          onDismiss={() => undefined}
        >
          Warning for {document.title}
        </ReaderNotice>
      </ReaderPopoverLayer>
    </div>
  );
}

vi.mock('@/features/reader/viewerRegistry', () => ({
  viewerRegistry: new Proxy({}, { get: () => FakeViewer }),
}));

const initialState = useStudySyncStore.getState();

const press = (key: string, code: string, modifiers: KeyboardEventInit = {}) => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, cancelable: true, bubbles: true, ...modifiers }),
    );
  });
};

/** Drops plain-text files, which the memory backend takes without reading fixtures. */
const openDocuments = (names: readonly string[]) => {
  // Distinct bytes: the memory backend dedupes files by hash.
  const files = names.map((name) => new File([`text:${name}`], name, { type: 'text/plain' }));
  act(() => {
    useStudySyncStore.setState({ error: null });
  });
  return useStudySyncStore.getState().dropFiles(files);
};

describe('ReaderPane tab commands', () => {
  beforeEach(() => {
    unmountCursorByDoc.clear();
    const store = useStudySyncStore.getState();
    for (const id of [...store.openDocumentIds]) store.closeDocument(id);
    useStudySyncStore.setState(initialState, true);
  });

  it('turns to the next and previous tab, wrapping around the ends', async () => {
    await openDocuments(['a.txt', 'b.txt', 'c.txt']);
    const store = useStudySyncStore.getState;
    const ids = store().openDocumentIds;
    const [first, second, third] = ids;
    render(<ReaderPane />);
    expect(store().activeDocumentId).toBe(third);
    expect(screen.getByRole('tab', { name: 'c' })).toHaveAttribute('aria-selected', 'true');

    press(']', 'BracketRight', { metaKey: true, shiftKey: true });
    expect(store().activeDocumentId).toBe(first);

    press('[', 'BracketLeft', { metaKey: true, shiftKey: true });
    expect(store().activeDocumentId).toBe(third);

    press('[', 'BracketLeft', { metaKey: true, shiftKey: true });
    expect(store().activeDocumentId).toBe(second);
  });

  it('gives the page the keyboard when a document opens', async () => {
    await openDocuments(['a.txt']);
    const documentId = useStudySyncStore.getState().activeDocumentId;
    render(<ReaderPane />);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${documentId}`)).toHaveFocus());
  });

  it('keeps the arrow keys in the tablist while tabs are stepped through', async () => {
    await openDocuments(['a.txt', 'b.txt', 'c.txt']);
    const store = useStudySyncStore.getState;
    const [first, second, third] = store().openDocumentIds;
    render(<ReaderPane />);
    expect(store().activeDocumentId).toBe(third);

    const activeTab = screen.getByRole('tab', { name: 'c' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });
    // Wrapping to the first tab keeps the keyboard in the tablist, not the page.
    expect(store().activeDocumentId).toBe(first);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'a' })).toHaveFocus());
    expect(screen.getByTestId(`fake-viewer-${first}`)).not.toHaveFocus();

    // A second arrow moves to the next tab, as the WAI-ARIA tabs pattern expects.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'a' }), { key: 'ArrowRight' });
    expect(store().activeDocumentId).toBe(second);
    expect(screen.getByRole('tab', { name: 'b' })).toHaveFocus();
  });

  it('hands the keyboard to the page when a tab is clicked with the pointer (#50)', async () => {
    await openDocuments(['a.txt', 'b.txt']);
    const store = useStudySyncStore.getState;
    const [first, second] = store().openDocumentIds;
    render(<ReaderPane />);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${second}`)).toHaveFocus());

    // Even if keyboard focus was previously inside the tablist, clicking an inactive tab
    // prevents pointer focus on `[role="tab"]` so the newly shown page receives focus.
    screen.getByRole('tab', { name: 'b' }).focus();
    const firstTab = screen.getByRole('tab', { name: 'a' });
    const downPrevented = !fireEvent.mouseDown(firstTab, { button: 0 });
    expect(downPrevented).toBe(true);
    fireEvent.click(firstTab);

    expect(store().activeDocumentId).toBe(first);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${first}`)).toHaveFocus());
  });

  it('hands the keyboard back to the page when the already-active tab is clicked (#64)', async () => {
    await openDocuments(['a.txt', 'b.txt']);
    const store = useStudySyncStore.getState;
    const [, second] = store().openDocumentIds;
    render(<ReaderPane />);
    const activePage = screen.getByTestId(`fake-viewer-${second}`);
    await waitFor(() => expect(activePage).toHaveFocus());

    // Non-primary mouse buttons do not cancel mousedown or blur active controls.
    const activeTab = screen.getByRole('tab', { name: 'b' });
    activeTab.focus();
    expect(fireEvent.mouseDown(activeTab, { button: 2 })).toBe(true);
    expect(activeTab).toHaveFocus();

    // Keyboard activation (click without primary mousedown) keeps focus in the tablist.
    fireEvent.click(activeTab);
    expect(activeTab).toHaveFocus();

    // Primary pointer click on the already-active tab blurs `[role="tab"]` and focuses the page.
    expect(fireEvent.mouseDown(activeTab, { button: 0 })).toBe(false);
    fireEvent.click(activeTab);
    await waitFor(() => expect(activePage).toHaveFocus());

    // Clicking the already-active tab from toolbar/MindMap focus also returns focus to the page.
    screen.getByRole('button', { name: 'Open' }).focus();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    fireEvent.mouseDown(activeTab, { button: 0 });
    fireEvent.click(activeTab);
    await waitFor(() => expect(activePage).toHaveFocus());
  });

  it('flushes editable onBlur handlers and focuses the active page on pointer tab switch or close', async () => {
    await openDocuments(['a.txt', 'b.txt', 'c.txt']);
    const store = useStudySyncStore.getState;
    const [first, , third] = store().openDocumentIds;
    const commits: string[] = [];

    render(
      <div>
        <input
          aria-label="Inspector title"
          onBlur={() => {
            commits.push(`input:${store().activeDocumentId ?? 'none'}`);
          }}
        />
        <textarea
          aria-label="Annotation note"
          onBlur={() => {
            commits.push(`textarea:${store().activeDocumentId ?? 'none'}`);
          }}
        />
        <ReaderPane />
      </div>,
    );
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${third}`)).toHaveFocus());

    // Clicking an inactive tab while an `<input>` is focused commits `onBlur` before switching
    // `activeDocumentId`, then focuses the newly active reading page.
    const input = screen.getByRole('textbox', { name: 'Inspector title' });
    input.focus();
    expect(input).toHaveFocus();
    const firstTab = screen.getByRole('tab', { name: 'a' });
    fireEvent.mouseDown(firstTab, { button: 0 });
    expect(commits).toEqual([`input:${third}`]);
    fireEvent.click(firstTab);
    expect(store().activeDocumentId).toBe(first);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${first}`)).toHaveFocus());

    // Clicking Close on an inactive tab while a `<textarea>` is focused commits `onBlur`
    // and returns focus to the active reading page instead of stranding on `document.body`.
    const textarea = screen.getByRole('textbox', { name: 'Annotation note' });
    textarea.focus();
    expect(textarea).toHaveFocus();
    const closeSecond = screen.getByRole('button', { name: 'Close b' });
    fireEvent.mouseDown(closeSecond, { button: 0 });
    expect(commits).toEqual([`input:${third}`, `textarea:${first}`]);
    fireEvent.click(closeSecond);
    expect(store().openDocumentIds).toEqual([first, third]);
    expect(store().activeDocumentId).toBe(first);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${first}`)).toHaveFocus());

    // Closing an inactive tab after keyboard focus was in the tablist also hands focus to the page.
    screen.getByRole('tab', { name: 'a' }).focus();
    const closeThird = screen.getByRole('button', { name: 'Close c' });
    fireEvent.mouseDown(closeThird, { button: 0 });
    fireEvent.click(closeThird);
    expect(store().openDocumentIds).toEqual([first]);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${first}`)).toHaveFocus());
  });

  it('switches tabs via keyboard ⇧⌘] without blurring or stealing focus from an input', async () => {
    await openDocuments(['a.txt', 'b.txt']);
    const store = useStudySyncStore.getState;
    const [first, second] = store().openDocumentIds;
    const onBlur = vi.fn();

    render(
      <div>
        <input aria-label="Note draft" onBlur={onBlur} />
        <ReaderPane />
      </div>,
    );
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${second}`)).toHaveFocus());

    const input = screen.getByRole('textbox', { name: 'Note draft' });
    input.focus();
    expect(input).toHaveFocus();

    press(']', 'BracketRight', { metaKey: true, shiftKey: true });
    expect(store().activeDocumentId).toBe(first);
    expect(onBlur).not.toHaveBeenCalled();
    expect(input).toHaveFocus();

    forgetRecentCommandRuns();
    act(() => {
      runCommand('window.nextTab', 'menu');
    });
    expect(store().activeDocumentId).toBe(second);
    expect(onBlur).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it('reopens the closed tab with Reopen Closed Tab, once', async () => {
    await openDocuments(['a.txt', 'b.txt']);
    const store = useStudySyncStore.getState;
    const [first, second] = store().openDocumentIds;
    render(<ReaderPane />);

    press('w', 'KeyW', { metaKey: true });
    expect(store().openDocumentIds).toEqual([first]);
    expect(store().closedDocumentIds).toEqual([second]);
    expect(commandState('file.reopenClosedTab').enabled).toBe(true);

    press('t', 'KeyT', { metaKey: true, shiftKey: true });
    await waitFor(() => expect(store().openDocumentIds).toEqual([first, second]));
    expect(store().activeDocumentId).toBe(second);
    expect(store().closedDocumentIds).toEqual([]);
    expect(commandState('file.reopenClosedTab').enabled).toBe(false);

    press('t', 'KeyT', { metaKey: true, shiftKey: true });
    await waitFor(() => expect(store().openDocumentIds).toEqual([first, second]));
  });

  it('names the picker formats in the empty state and labels Markdown in Recent (#99)', async () => {
    await openDocuments(['README.md', 'notes.txt']);
    const store = useStudySyncStore.getState;
    expect(store().documents.map((document) => document.format)).toEqual(['txt', 'txt']);
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    render(<ReaderPane />);

    expect(
      screen.getByText('Open a PDF, EPUB, TXT, or Markdown file to start reading.'),
    ).toBeInTheDocument();
    const recent = screen.getByTestId('empty-state-recent-documents');
    const labels = [...recent.querySelectorAll('[data-testid="recent-document-item"] > span')].map(
      (badge) => badge.textContent,
    );
    expect(labels.toSorted()).toEqual(['Markdown', 'TXT']);
  });

  it('stacks workspace notices into the active viewer popover layer and follows tab switches', async () => {
    await openDocuments(['a.txt', 'b.txt']);
    const store = useStudySyncStore.getState;
    const [first, second] = store().openDocumentIds;
    render(
      <ReaderPane
        notice={
          <ReaderNotice tone="info" testId="excerpt-added-notice" onDismiss={() => undefined}>
            Added to MindMap
          </ReaderNotice>
        }
      />,
    );

    const excerptNotice = screen.getByTestId('excerpt-added-notice');
    const secondWarning = screen.getByTestId(`viewer-warning-${second}`);
    expect(excerptNotice.parentElement).toBe(secondWarning.parentElement);

    fireEvent.click(screen.getByRole('tab', { name: 'a' }));
    const firstWarning = screen.getByTestId(`viewer-warning-${first}`);
    expect(screen.getByTestId('excerpt-added-notice').parentElement).toBe(
      firstWarning.parentElement,
    );
  });

  it('closeDocumentAndFlush waits for mounted viewer unmount cursor write via sibling UnmountSentinel (T-31, R3-06)', async () => {
    await openDocuments(['flush-target.txt']);
    const store = useStudySyncStore.getState;
    const docId = store().activeDocumentId as string;
    const finalAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 2,
      endByteOffset: 6,
      lineIndex: 0,
    };
    unmountCursorByDoc.set(docId, finalAnchor);

    render(<ReaderPane />);
    expect(screen.getByTestId(`fake-viewer-${docId}`)).toBeInTheDocument();

    const backend = backendHolder.current!;
    let resolveCursorWrite!: () => void;
    const delayedWrite = new Promise<void>((resolve) => {
      resolveCursorWrite = resolve;
    });
    const updateSpy = vi.spyOn(backend, 'updateDocumentCursor').mockReturnValueOnce(delayedWrite);

    let settled = false;
    let flushPromise!: Promise<void>;
    act(() => {
      flushPromise = store()
        .closeDocumentAndFlush(docId)
        .then(() => {
          settled = true;
        });
    });

    // React has committed the unmount: <Viewer> cleanup fired onCursorChange before <UnmountSentinel>.
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(docId, finalAnchor, 0.9));
    expect(screen.queryByTestId(`fake-viewer-${docId}`)).not.toBeInTheDocument();
    expect(settled).toBe(false);

    // Resolving the delayed IPC write unblocks closeDocumentAndFlush.
    resolveCursorWrite();
    await act(async () => {
      await flushPromise;
    });
    expect(settled).toBe(true);
    updateSpy.mockRestore();
  });

  it('skips unmount wait when SourceRecoveryDialog is showing and restores Viewer on refreshDocument (T-31, T-32)', async () => {
    await openDocuments(['missing-file.txt']);
    const store = useStudySyncStore.getState;
    const docId = store().activeDocumentId as string;
    const originalDoc = store().documents.find((d) => d.id === docId)!;

    act(() => {
      useStudySyncStore.setState((state) => ({
        documentSourceStatuses: {
          ...state.documentSourceStatuses,
          [docId]: {
            documentId: docId,
            state: 'missing',
            currentFileHash: null,
            fileSizeBytes: null,
          },
        },
      }));
    });

    render(<ReaderPane />);
    expect(screen.getByTestId('source-recovery-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId(`fake-viewer-${docId}`)).not.toBeInTheDocument();

    // Refreshing with a restored filePath transitions cleanly from SourceRecoveryDialog back to <Viewer>.
    const backend = backendHolder.current!;
    const listSpy = vi
      .spyOn(backend, 'listDocuments')
      .mockResolvedValueOnce([{ ...originalDoc, filePath: '/restored/missing-file.txt' }]);
    await act(async () => {
      await store().refreshDocument(docId);
    });
    listSpy.mockRestore();

    expect(screen.queryByTestId('source-recovery-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId(`fake-viewer-${docId}`)).toBeInTheDocument();
    expect(store().relinkedNonceByDocumentId[docId]).toBe(1);

    // Put back into missing state and verify closeDocumentAndFlush resolves without hanging.
    act(() => {
      useStudySyncStore.setState((state) => ({
        documentSourceStatuses: {
          ...state.documentSourceStatuses,
          [docId]: {
            documentId: docId,
            state: 'missing',
            currentFileHash: null,
            fileSizeBytes: null,
          },
        },
      }));
    });
    expect(screen.getByTestId('source-recovery-dialog')).toBeInTheDocument();

    await act(async () => {
      await store().closeDocumentAndFlush(docId);
    });
    expect(store().openDocumentIds).not.toContain(docId);
  });
});

describe('describeResumeLocation', () => {
  const base = {
    id: 'doc',
    title: 'Book',
    filePath: '/books/book.epub',
    fileHash: 'hash',
    format: 'epub',
    encoding: 'utf-8',
    createdAt: '2026-01-01T00:00:00Z',
  } as const;
  const epub = {
    format: 'epub',
    cfiRange: 'epubcfi(/6/4!/4/2)',
    chapterHref: 'OEBPS/one.xhtml',
  } as const;

  it('says how far into an EPUB the reader is once the book was measured (#52)', () => {
    expect(describeResumeLocation({ ...base, lastCursorAnchor: null })).toBe('Start reading');
    expect(describeResumeLocation({ ...base, lastCursorAnchor: epub })).toBe('Continue reading');
    expect(describeResumeLocation({ ...base, lastCursorAnchor: epub, lastProgress: null })).toBe(
      'Continue reading',
    );
    expect(describeResumeLocation({ ...base, lastCursorAnchor: epub, lastProgress: 0.226 })).toBe(
      'Continue reading · 23%',
    );
  });

  it('adds the percentage after a place a reader can name', () => {
    const txt = {
      ...base,
      format: 'txt',
      lastCursorAnchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 29 },
    } as const;
    expect(describeResumeLocation(txt)).toBe('Continue reading · Line 30');
    expect(describeResumeLocation({ ...txt, lastProgress: 0.5 })).toBe(
      'Continue reading · Line 30 · 50%',
    );
  });
});
