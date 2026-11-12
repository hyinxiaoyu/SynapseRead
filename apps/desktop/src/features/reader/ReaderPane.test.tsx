import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandState, forgetRecentCommandRuns, runCommand } from '@/features/commands/registry';
import { useFocusPageOnActivate } from '@/features/reader/focusPage';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { DocumentViewerProps } from '@/types/domain';

import { describeResumeLocation, ReaderPane } from './ReaderPane';

/**
 * These tests are about the tab commands, so a small stand-in fulfils the viewer
 * contract; each real engine has its own tests.
 */
function FakeViewer({ document, isActive }: DocumentViewerProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  useFocusPageOnActivate(pageRef, isActive);
  return <div ref={pageRef} data-testid={`fake-viewer-${document.id}`} tabIndex={-1} />;
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
