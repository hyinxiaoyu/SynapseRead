import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandState } from '@/features/commands/registry';
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
    const downPrevented = !fireEvent.mouseDown(firstTab);
    expect(downPrevented).toBe(true);
    fireEvent.click(firstTab);

    expect(store().activeDocumentId).toBe(first);
    await waitFor(() => expect(screen.getByTestId(`fake-viewer-${first}`)).toHaveFocus());
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
