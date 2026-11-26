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

  it('bounds Continue reading in a safe scroll container and expands all 50 recent entries (#126)', async () => {
    const names = Array.from(
      { length: 50 },
      (_, index) => `overflow-book-${String(index + 1).padStart(2, '0')}.txt`,
    );
    await openDocuments(names);
    const store = useStudySyncStore.getState;
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    render(<ReaderPane />);

    const emptyWrapper = screen.getByTestId('reader-empty-state');
    expect(emptyWrapper).toHaveClass('h-full', 'overflow-y-auto');
    expect(
      screen.getByText('Open a PDF, EPUB, TXT, or Markdown file to start reading.'),
    ).toBeInTheDocument();

    const recentRegion = screen.getByTestId('empty-state-recent-documents');
    const list = recentRegion.querySelector('[data-testid="recent-documents-list"]');
    expect(list).toHaveClass('max-h-[min(28rem,60vh)]', 'overflow-y-auto');

    const initialTitles = [
      ...recentRegion.querySelectorAll('[data-testid="recent-document-item"] p.font-medium'),
    ].map((node) => node.textContent);
    expect(initialTitles).toEqual([
      'overflow-book-50',
      'overflow-book-49',
      'overflow-book-48',
      'overflow-book-47',
      'overflow-book-46',
      'overflow-book-45',
      'overflow-book-44',
      'overflow-book-43',
    ]);

    const showAll = screen.getByTestId('recent-documents-show-all');
    expect(showAll).toHaveTextContent('Show all (50)');
    fireEvent.click(showAll);

    expect(screen.queryByTestId('recent-documents-show-all')).not.toBeInTheDocument();
    const expandedTitles = [
      ...recentRegion.querySelectorAll('[data-testid="recent-document-item"] p.font-medium'),
    ].map((node) => node.textContent);
    expect(expandedTitles).toHaveLength(50);
    expect(expandedTitles[0]).toBe('overflow-book-50');
    expect(expandedTitles[49]).toBe('overflow-book-01');
  });

  it('removes entries from empty state and popover while preserving study records and moving focus (#126)', async () => {
    await openDocuments(['recent-one.txt', 'recent-two.txt', 'recent-three.txt']);
    const store = useStudySyncStore.getState;
    const [firstId, secondId, thirdId] = store().openDocumentIds as [string, string, string];
    await store().addBookmark(
      secondId,
      { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
      'Keep bookmark',
    );
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const backend = backendHolder.current!;
    const hideSpy = vi.spyOn(backend, 'hideDocumentFromRecent');

    render(<ReaderPane />);

    // Recency order: three (idx 0), two (idx 1), one (idx 2).
    const removeButtons = screen.getAllByTestId('recent-document-remove');
    expect(removeButtons).toHaveLength(3);
    removeButtons[1]!.focus();
    fireEvent.click(removeButtons[1]!);

    await waitFor(() => expect(hideSpy).toHaveBeenCalledWith(secondId));
    await waitFor(() => expect(screen.getAllByTestId('recent-document-item')).toHaveLength(2));
    // Focus moves to the row that slid into index 1 (`recent-one`).
    expect(
      screen
        .getAllByTestId('recent-document-item')
        .find((el) => el.getAttribute('data-document-id') === firstId),
    ).toHaveFocus();
    // Study records (bookmarks) stay untouched.
    expect(store().bookmarks.some((bm) => bm.documentId === secondId)).toBe(true);

    // Removing the last visible row moves focus to the previous row (`recent-three`).
    const remainingRemove = screen.getAllByTestId('recent-document-remove');
    remainingRemove[1]!.focus();
    fireEvent.click(remainingRemove[1]!);
    await waitFor(() => expect(screen.getAllByTestId('recent-document-item')).toHaveLength(1));
    expect(
      screen
        .getAllByTestId('recent-document-item')
        .find((el) => el.getAttribute('data-document-id') === thirdId),
    ).toHaveFocus();

    // Reopening restores the hidden document back to Recent.
    await act(async () => {
      await store().reopenRecentDocument(secondId);
    });
    expect(store().openDocumentIds).toEqual([secondId]);

    // While a tab is open, the Recent popover shows both restored docs and keeps open on removal.
    fireEvent.click(screen.getByTestId('recent-documents-toggle'));
    const popover = screen.getByTestId('recent-documents-menu');
    expect(popover.querySelectorAll('[data-testid="recent-document-item"]')).toHaveLength(2);
    const popoverRemoves = popover.querySelectorAll('[data-testid="recent-document-remove"]');
    fireEvent.click(popoverRemoves[0]!);
    await waitFor(() =>
      expect(popover.querySelectorAll('[data-testid="recent-document-item"]')).toHaveLength(1),
    );
    expect(screen.getByTestId('recent-documents-menu')).toBeInTheDocument();

    hideSpy.mockRestore();
  });

  it('hands focus to the ninth entry when Show all is activated with the keyboard (#126)', async () => {
    const names = Array.from(
      { length: 12 },
      (_, index) => `expand-focus-${String(index + 1).padStart(2, '0')}.txt`,
    );
    await openDocuments(names);
    const store = useStudySyncStore.getState;
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    render(<ReaderPane />);

    const showAll = screen.getByTestId('recent-documents-show-all');
    showAll.focus();
    expect(showAll).toHaveFocus();
    act(() => {
      showAll.click();
    });

    expect(screen.queryByTestId('recent-documents-show-all')).not.toBeInTheDocument();
    const list = screen
      .getByTestId('empty-state-recent-documents')
      .querySelector('[data-testid="recent-documents-list"]')!;
    const items = list.querySelectorAll<HTMLButtonElement>('[data-testid="recent-document-item"]');
    expect(items).toHaveLength(12);
    // 12..05 are indices 0..7; the 9th entry (index 8) is expand-focus-04.
    const ninthItem = items[8]!;
    expect(ninthItem).toHaveTextContent('expand-focus-04');
    expect(document.activeElement).toBe(ninthItem);

    // Tab order after the 9th item reaches its Remove button, then the 10th item.
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const ninthPos = buttons.indexOf(ninthItem);
    expect(buttons[ninthPos + 1]).toHaveAttribute('data-testid', 'recent-document-remove');
    expect(buttons[ninthPos + 1]).toHaveAttribute(
      'aria-label',
      'Remove expand-focus-04 from Recent',
    );
    expect(buttons[ninthPos + 2]).toBe(items[9]);
  });

  it('keeps Recent lists, backend state, and progress consistent when Remove and Reopen race (#126)', async () => {
    const progressAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 0,
      endByteOffset: 4,
      lineIndex: 0,
    };

    const assertListsAndBackend = async (
      docId: string,
      expectedVisible: boolean,
      expectedProgress: number | null,
    ) => {
      const emptyIds = [
        ...screen
          .getByTestId('empty-state-recent-documents')
          .querySelectorAll('[data-testid="recent-document-item"]'),
      ].map((el) => el.getAttribute('data-document-id'));
      expect(emptyIds.includes(docId)).toBe(expectedVisible);

      fireEvent.click(screen.getByTestId('recent-documents-toggle'));
      const menu = screen.getByTestId('recent-documents-menu');
      const popoverIds = [...menu.querySelectorAll('[data-testid="recent-document-item"]')].map(
        (el) => el.getAttribute('data-document-id'),
      );
      expect(popoverIds.includes(docId)).toBe(expectedVisible);
      fireEvent.click(screen.getByTestId('recent-documents-toggle'));

      const storeDoc = useStudySyncStore.getState().documents.find((d) => d.id === docId)!;
      expect(storeDoc.lastProgress ?? null).toBe(expectedProgress);
      const backendDoc = (await backendHolder.current!.listDocuments()).find(
        (d) => d.id === docId,
      )!;
      expect(backendDoc.lastProgress ?? null).toBe(expectedProgress);
      expect(
        backendDoc.hiddenFromRecentAt !== null && backendDoc.hiddenFromRecentAt !== undefined,
      ).toBe(!expectedVisible);
    };

    // 1. Late Remove response after Reopen must not re-hide the reopened document.
    await openDocuments(['race1-keep.txt', 'race1-target.txt']);
    const store = useStudySyncStore.getState;
    const [, target1] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const backend = backendHolder.current!;
    const origHide1 = backend.hideDocumentFromRecent.bind(backend);
    let releaseHide1!: () => void;
    const hideGate1 = new Promise<void>((resolve) => {
      releaseHide1 = resolve;
    });
    const hideSpy1 = vi
      .spyOn(backend, 'hideDocumentFromRecent')
      .mockImplementationOnce(async (id) => {
        const row = await origHide1(id);
        await hideGate1;
        return row;
      });

    const view = render(<ReaderPane />);
    const targetRowRemove = screen
      .getByTestId('empty-state-recent-documents')
      .querySelectorAll<HTMLButtonElement>('[data-testid="recent-document-remove"]')[0]!;
    fireEvent.click(targetRowRemove);
    await waitFor(() => expect(hideSpy1).toHaveBeenCalledWith(target1));

    await act(async () => {
      await store().reopenRecentDocument(target1);
    });
    act(() => store().closeDocument(target1));
    releaseHide1();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await assertListsAndBackend(target1, true, null);
    hideSpy1.mockRestore();
    view.unmount();

    // 2. Late Reopen response after Remove must not make the removed document reappear.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['race2-keep.txt', 'race2-target.txt']);
    const [, target2] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const origTouch2 = backend.touchDocumentOpened.bind(backend);
    let releaseTouch2!: () => void;
    const touchGate2 = new Promise<void>((resolve) => {
      releaseTouch2 = resolve;
    });
    const touchSpy2 = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const row = await origTouch2(id);
        await touchGate2;
        return row;
      });

    const view2 = render(<ReaderPane />);
    let reopenPromise!: Promise<void>;
    act(() => {
      reopenPromise = store().reopenRecentDocument(target2);
    });
    await waitFor(() => expect(touchSpy2).toHaveBeenCalledWith(target2));
    await act(async () => {
      await store().hideRecentDocument(target2);
    });
    releaseTouch2();
    await act(async () => {
      await reopenPromise;
    });
    act(() => store().closeDocument(target2));

    await assertListsAndBackend(target2, false, null);
    touchSpy2.mockRestore();
    view2.unmount();

    // 3. Delayed Remove response must not overwrite reading progress (0.5) updated meanwhile.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['race3-keep.txt', 'race3-target.txt']);
    const [, target3] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const origHide3 = backend.hideDocumentFromRecent.bind(backend);
    let releaseHide3!: () => void;
    const hideGate3 = new Promise<void>((resolve) => {
      releaseHide3 = resolve;
    });
    const hideSpy3 = vi
      .spyOn(backend, 'hideDocumentFromRecent')
      .mockImplementationOnce(async (id) => {
        const row = await origHide3(id);
        await hideGate3;
        return row;
      });

    render(<ReaderPane />);
    let hidePromise3!: Promise<void>;
    act(() => {
      hidePromise3 = store().hideRecentDocument(target3);
    });
    await waitFor(() => expect(hideSpy3).toHaveBeenCalledWith(target3));

    act(() => {
      store().reportCursor(target3, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target3);
    });

    releaseHide3();
    await act(async () => {
      await hidePromise3;
    });

    await assertListsAndBackend(target3, false, 0.5);
    hideSpy3.mockRestore();
  });

  it('converges Recent lists, backend state, and progress across overlapping picker, cancelled relink, and failed hide (#126)', async () => {
    const progressAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 0,
      endByteOffset: 4,
      lineIndex: 0,
    };

    const assertListsAndBackend = async (
      docId: string,
      expectedVisible: boolean,
      expectedProgress: number | null,
    ) => {
      const emptyIds = [
        ...screen
          .getByTestId('empty-state-recent-documents')
          .querySelectorAll('[data-testid="recent-document-item"]'),
      ].map((el) => el.getAttribute('data-document-id'));
      expect(emptyIds.includes(docId)).toBe(expectedVisible);

      fireEvent.click(screen.getByTestId('recent-documents-toggle'));
      const menu = screen.getByTestId('recent-documents-menu');
      const popoverIds = [...menu.querySelectorAll('[data-testid="recent-document-item"]')].map(
        (el) => el.getAttribute('data-document-id'),
      );
      expect(popoverIds.includes(docId)).toBe(expectedVisible);
      fireEvent.click(screen.getByTestId('recent-documents-toggle'));

      const storeDoc = useStudySyncStore.getState().documents.find((d) => d.id === docId)!;
      expect(storeDoc.lastProgress ?? null).toBe(expectedProgress);
      const backendDoc = (await backendHolder.current!.listDocuments()).find(
        (d) => d.id === docId,
      )!;
      expect(backendDoc.lastProgress ?? null).toBe(expectedProgress);
      expect(
        backendDoc.hiddenFromRecentAt !== null && backendDoc.hiddenFromRecentAt !== undefined,
      ).toBe(!expectedVisible);
    };

    // 1. Open file picker -> Remove book -> Pick that file & finish registration.
    await openDocuments(['overlap1-keep.txt', 'overlap1-target.txt']);
    const store = useStudySyncStore.getState;
    const [, target1] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const backend = backendHolder.current!;
    let releasePicker!: () => void;
    const pickerGate = new Promise<void>((resolve) => {
      releasePicker = resolve;
    });
    const pickSpy = vi.spyOn(backend, 'pickDocument').mockImplementationOnce(async () => {
      await pickerGate;
      const pickedFile = new File(['text:overlap1-target.txt'], 'overlap1-target.txt', {
        type: 'text/plain',
      });
      const { documents } = await backend.dropFiles([pickedFile]);
      return documents[0] ?? null;
    });

    const view1 = render(<ReaderPane />);
    let openPromise!: Promise<void>;
    act(() => {
      openPromise = store().openDocument();
    });
    await waitFor(() => expect(pickSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      await store().hideRecentDocument(target1);
    });
    act(() => {
      store().reportCursor(target1, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target1);
    });

    releasePicker();
    await act(async () => {
      await openPromise;
    });
    act(() => store().closeDocument(target1));

    await assertListsAndBackend(target1, true, 0.5);
    pickSpy.mockRestore();
    view1.unmount();

    // 2. Remove committed (response delayed) -> Initiate & cancel relink -> Remove response returns.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['overlap2-keep.txt', 'overlap2-target.txt']);
    const [, target2] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const origHide2 = backend.hideDocumentFromRecent.bind(backend);
    let releaseHide2!: () => void;
    const hideGate2 = new Promise<void>((resolve) => {
      releaseHide2 = resolve;
    });
    const hideSpy2 = vi
      .spyOn(backend, 'hideDocumentFromRecent')
      .mockImplementationOnce(async (id) => {
        const row = await origHide2(id);
        await hideGate2;
        return row;
      });
    const relinkSpy2 = vi.spyOn(backend, 'relinkDocument').mockResolvedValueOnce(null);

    const view2 = render(<ReaderPane />);
    let hidePromise2!: Promise<void>;
    act(() => {
      hidePromise2 = store().hideRecentDocument(target2);
    });
    await waitFor(() => expect(hideSpy2).toHaveBeenCalledWith(target2));

    await act(async () => {
      const relinked = await store().relinkDocument(target2);
      expect(relinked).toBeNull();
    });
    act(() => {
      store().reportCursor(target2, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target2);
    });

    releaseHide2();
    await act(async () => {
      await hidePromise2;
    });

    await assertListsAndBackend(target2, false, 0.5);
    hideSpy2.mockRestore();
    relinkSpy2.mockRestore();
    view2.unmount();

    // 3. Reopen committed (response delayed) -> Subsequent hide fails -> Reopen response returns.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['overlap3-keep.txt', 'overlap3-target.txt']);
    const [, target3] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    await act(async () => {
      await store().hideRecentDocument(target3);
    });

    const origTouch3 = backend.touchDocumentOpened.bind(backend);
    let releaseTouch3!: () => void;
    const touchGate3 = new Promise<void>((resolve) => {
      releaseTouch3 = resolve;
    });
    const touchSpy3 = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const row = await origTouch3(id);
        await touchGate3;
        return row;
      });
    const hideFailSpy3 = vi
      .spyOn(backend, 'hideDocumentFromRecent')
      .mockRejectedValueOnce(new Error('database locked'));

    render(<ReaderPane />);
    let reopenPromise3!: Promise<void>;
    act(() => {
      reopenPromise3 = store().reopenRecentDocument(target3);
    });
    await waitFor(() => expect(touchSpy3).toHaveBeenCalledWith(target3));

    await act(async () => {
      await store().hideRecentDocument(target3);
    });
    expect(store().error).toContain('database locked');

    act(() => {
      store().reportCursor(target3, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target3);
    });

    releaseTouch3();
    await act(async () => {
      await reopenPromise3;
    });
    act(() => store().closeDocument(target3));

    await assertListsAndBackend(target3, true, 0.5);
    touchSpy3.mockRestore();
    hideFailSpy3.mockRestore();
  });

  it('syncs Recent state when reopenRecentDocument fails source verification in either completion order (#126)', async () => {
    const progressAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 0,
      endByteOffset: 4,
      lineIndex: 0,
    };

    const assertListsAndBackend = async (
      docId: string,
      expectedVisible: boolean,
      expectedProgress: number | null,
    ) => {
      const emptyIds = [
        ...screen
          .getByTestId('empty-state-recent-documents')
          .querySelectorAll('[data-testid="recent-document-item"]'),
      ].map((el) => el.getAttribute('data-document-id'));
      expect(emptyIds.includes(docId)).toBe(expectedVisible);

      fireEvent.click(screen.getByTestId('recent-documents-toggle'));
      const menu = screen.getByTestId('recent-documents-menu');
      const popoverIds = [...menu.querySelectorAll('[data-testid="recent-document-item"]')].map(
        (el) => el.getAttribute('data-document-id'),
      );
      expect(popoverIds.includes(docId)).toBe(expectedVisible);
      fireEvent.click(screen.getByTestId('recent-documents-toggle'));

      const storeDoc = useStudySyncStore.getState().documents.find((d) => d.id === docId)!;
      expect(storeDoc.lastProgress ?? null).toBe(expectedProgress);
      const backendDoc = (await backendHolder.current!.listDocuments()).find(
        (d) => d.id === docId,
      )!;
      expect(backendDoc.lastProgress ?? null).toBe(expectedProgress);
      expect(
        backendDoc.hiddenFromRecentAt !== null && backendDoc.hiddenFromRecentAt !== undefined,
      ).toBe(!expectedVisible);
    };

    // 1. Verify fails before pending touchDocumentOpened commits, with concurrent hide in between.
    await openDocuments(['verify-order1-keep.txt', 'verify-order1-target.txt']);
    const store = useStudySyncStore.getState;
    const [, target1] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const backend = backendHolder.current!;
    const origTouch1 = backend.touchDocumentOpened.bind(backend);
    let releaseTouch1!: () => void;
    const touchGate1 = new Promise<void>((resolve) => {
      releaseTouch1 = resolve;
    });
    const touchSpy1 = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        await touchGate1;
        return origTouch1(id);
      });
    let releaseVerify1!: () => void;
    const verifyGate1 = new Promise<void>((resolve) => {
      releaseVerify1 = resolve;
    });
    const verifySpy1 = vi
      .spyOn(backend, 'verifyDocumentSource')
      .mockImplementationOnce(async () => {
        await verifyGate1;
        throw new Error('source unreadable');
      });

    const view1 = render(<ReaderPane />);
    let reopenPromise1!: Promise<void>;
    act(() => {
      reopenPromise1 = store().reopenRecentDocument(target1);
    });
    await waitFor(() => {
      expect(touchSpy1).toHaveBeenCalledWith(target1);
      expect(verifySpy1).toHaveBeenCalledWith(target1);
    });

    await act(async () => {
      await store().hideRecentDocument(target1);
    });
    act(() => {
      store().reportCursor(target1, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target1);
    });

    // Reject verification while touchDocumentOpened is still pending, then let touch commit.
    releaseVerify1();
    await act(async () => {
      await Promise.resolve();
    });
    releaseTouch1();
    await act(async () => {
      await reopenPromise1;
    });

    expect(store().error).toContain('source unreadable');
    expect(store().openDocumentIds).not.toContain(target1);
    await assertListsAndBackend(target1, true, 0.5);
    touchSpy1.mockRestore();
    verifySpy1.mockRestore();
    view1.unmount();

    // 2a. touchDocumentOpened commits first on a hidden doc (no overlap), then verification fails.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['verify-order2a-keep.txt', 'verify-order2a-target.txt']);
    const [, target2a] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    await act(async () => {
      await store().hideRecentDocument(target2a);
    });
    act(() => {
      store().reportCursor(target2a, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target2a);
    });

    const origTouch2a = backend.touchDocumentOpened.bind(backend);
    let touchCommitted2a = false;
    const touchSpy2a = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const updated = await origTouch2a(id);
        touchCommitted2a = true;
        return updated;
      });
    let releaseVerify2a!: () => void;
    const verifyGate2a = new Promise<void>((resolve) => {
      releaseVerify2a = resolve;
    });
    const verifySpy2a = vi
      .spyOn(backend, 'verifyDocumentSource')
      .mockImplementationOnce(async () => {
        await verifyGate2a;
        throw new Error('verify failed after touch');
      });

    const view2a = render(<ReaderPane />);
    let reopenPromise2a!: Promise<void>;
    act(() => {
      reopenPromise2a = store().reopenRecentDocument(target2a);
    });
    await waitFor(() => expect(touchCommitted2a).toBe(true));

    releaseVerify2a();
    await act(async () => {
      await reopenPromise2a;
    });

    expect(store().error).toContain('verify failed after touch');
    expect(store().openDocumentIds).not.toContain(target2a);
    await assertListsAndBackend(target2a, true, 0.5);
    touchSpy2a.mockRestore();
    verifySpy2a.mockRestore();
    view2a.unmount();

    // 2b. touchDocumentOpened commits first, concurrent hide commits second, then verification fails.
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['verify-order2b-keep.txt', 'verify-order2b-target.txt']);
    const [, target2b] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const origTouch2b = backend.touchDocumentOpened.bind(backend);
    let touchCommitted2b = false;
    const touchSpy2b = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const updated = await origTouch2b(id);
        touchCommitted2b = true;
        return updated;
      });
    let releaseVerify2b!: () => void;
    const verifyGate2b = new Promise<void>((resolve) => {
      releaseVerify2b = resolve;
    });
    const verifySpy2b = vi
      .spyOn(backend, 'verifyDocumentSource')
      .mockImplementationOnce(async () => {
        await verifyGate2b;
        throw new Error('verify failed after overlap');
      });

    render(<ReaderPane />);
    let reopenPromise2b!: Promise<void>;
    act(() => {
      reopenPromise2b = store().reopenRecentDocument(target2b);
    });
    await waitFor(() => expect(touchCommitted2b).toBe(true));

    await act(async () => {
      await store().hideRecentDocument(target2b);
    });
    act(() => {
      store().reportCursor(target2b, progressAnchor, 0.5);
    });
    await act(async () => {
      await store().flushCursorWrites(target2b);
    });

    releaseVerify2b();
    await act(async () => {
      await reopenPromise2b;
    });

    expect(store().error).toContain('verify failed after overlap');
    expect(store().openDocumentIds).not.toContain(target2b);
    await assertListsAndBackend(target2b, false, 0.5);
    touchSpy2b.mockRestore();
    verifySpy2b.mockRestore();
  });

  it('reconciles deferred Recent state after document lock release in either completion order (#126)', async () => {
    const importedAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 4,
      endByteOffset: 10,
      lineIndex: 0,
    };

    const assertListsAndBackend = async (
      docId: string,
      expectedVisible: boolean,
      expectedProgress: number | null,
      expectedAnchor: AnchorLocation,
    ) => {
      const emptyIds = [
        ...screen
          .getByTestId('empty-state-recent-documents')
          .querySelectorAll('[data-testid="recent-document-item"]'),
      ].map((el) => el.getAttribute('data-document-id'));
      expect(emptyIds.includes(docId)).toBe(expectedVisible);

      fireEvent.click(screen.getByTestId('recent-documents-toggle'));
      const menu = screen.getByTestId('recent-documents-menu');
      const popoverIds = [...menu.querySelectorAll('[data-testid="recent-document-item"]')].map(
        (el) => el.getAttribute('data-document-id'),
      );
      expect(popoverIds.includes(docId)).toBe(expectedVisible);
      fireEvent.click(screen.getByTestId('recent-documents-toggle'));

      const storeDoc = useStudySyncStore.getState().documents.find((d) => d.id === docId)!;
      expect(storeDoc.lastProgress ?? null).toBe(expectedProgress);
      expect(storeDoc.lastCursorAnchor).toEqual(expectedAnchor);
      const backendDoc = (await backendHolder.current!.listDocuments()).find(
        (d) => d.id === docId,
      )!;
      expect(backendDoc.lastProgress ?? null).toBe(expectedProgress);
      expect(backendDoc.lastCursorAnchor).toEqual(expectedAnchor);
      expect(
        backendDoc.hiddenFromRecentAt !== null && backendDoc.hiddenFromRecentAt !== undefined,
      ).toBe(!expectedVisible);
    };

    // 1. Recent op finishes while locked (outer lock + nested closeDocumentAndFlush + refreshDocument),
    //    then final lock release triggers deferred reconciliation without reopening the tab or clobbering progress.
    await openDocuments(['lock-order1-keep.txt', 'lock-order1-target.txt']);
    const store = useStudySyncStore.getState;
    const [, target1] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const backend = backendHolder.current!;
    const origTouch1 = backend.touchDocumentOpened.bind(backend);
    let touchCommitted1 = false;
    const touchSpy1 = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const updated = await origTouch1(id);
        touchCommitted1 = true;
        return updated;
      });
    const origVerify1 = backend.verifyDocumentSource.bind(backend);
    let releaseVerify1!: () => void;
    const verifyGate1 = new Promise<void>((resolve) => {
      releaseVerify1 = resolve;
    });
    const verifySpy1 = vi
      .spyOn(backend, 'verifyDocumentSource')
      .mockImplementationOnce(async (id) => {
        await verifyGate1;
        return origVerify1(id);
      });

    const view1 = render(<ReaderPane />);
    let reopenPromise1!: Promise<void>;
    act(() => {
      reopenPromise1 = store().reopenRecentDocument(target1);
    });
    await waitFor(() => expect(touchCommitted1).toBe(true));

    await act(async () => {
      await store().hideRecentDocument(target1);
    });

    let releaseLock1!: () => void;
    act(() => {
      releaseLock1 = store().lockDocument(target1);
    });
    await act(async () => {
      await store().closeDocumentAndFlush(target1);
    });
    expect(store().lockedDocumentIds).toContain(target1);
    expect(store().openDocumentIds).not.toContain(target1);

    releaseVerify1();
    await act(async () => {
      await reopenPromise1;
    });
    expect(store().openDocumentIds).not.toContain(target1);

    await backend.updateDocumentCursor(target1, importedAnchor, 0.85);
    await act(async () => {
      await store().refreshDocument(target1);
    });
    expect(store().documents.find((d) => d.id === target1)?.lastProgress).toBe(0.85);

    act(() => {
      releaseLock1();
    });
    await waitFor(() => {
      const doc = store().documents.find((d) => d.id === target1);
      expect(doc?.hiddenFromRecentAt).toBeTruthy();
    });

    expect(store().lockedDocumentIds).not.toContain(target1);
    expect(store().openDocumentIds).not.toContain(target1);
    await assertListsAndBackend(target1, false, 0.85, importedAnchor);
    touchSpy1.mockRestore();
    verifySpy1.mockRestore();
    view1.unmount();

    // 2. Final lock releases while reopenRecentDocument is still active, then reopenRecentDocument drains and reconciles.
    useStudySyncStore.setState(initialState, true);
    await openDocuments(['lock-order2-keep.txt', 'lock-order2-target.txt']);
    const [, target2] = store().openDocumentIds as [string, string];
    for (const id of [...store().openDocumentIds]) act(() => store().closeDocument(id));

    const origTouch2 = backend.touchDocumentOpened.bind(backend);
    let touchCommitted2 = false;
    const touchSpy2 = vi
      .spyOn(backend, 'touchDocumentOpened')
      .mockImplementationOnce(async (id) => {
        const updated = await origTouch2(id);
        touchCommitted2 = true;
        return updated;
      });
    const origVerify2 = backend.verifyDocumentSource.bind(backend);
    let releaseVerify2!: () => void;
    const verifyGate2 = new Promise<void>((resolve) => {
      releaseVerify2 = resolve;
    });
    const verifySpy2 = vi
      .spyOn(backend, 'verifyDocumentSource')
      .mockImplementationOnce(async (id) => {
        await verifyGate2;
        return origVerify2(id);
      });

    render(<ReaderPane />);
    let reopenPromise2!: Promise<void>;
    act(() => {
      reopenPromise2 = store().reopenRecentDocument(target2);
    });
    await waitFor(() => expect(touchCommitted2).toBe(true));

    await act(async () => {
      await store().hideRecentDocument(target2);
    });

    let releaseLock2!: () => void;
    act(() => {
      releaseLock2 = store().lockDocument(target2);
    });
    await act(async () => {
      await store().closeDocumentAndFlush(target2);
    });
    await backend.updateDocumentCursor(target2, importedAnchor, 0.85);
    await act(async () => {
      await store().refreshDocument(target2);
    });

    act(() => {
      releaseLock2();
    });
    expect(store().lockedDocumentIds).not.toContain(target2);

    releaseVerify2();
    await act(async () => {
      await reopenPromise2;
    });

    expect(store().openDocumentIds).not.toContain(target2);
    await assertListsAndBackend(target2, false, 0.85, importedAnchor);
    touchSpy2.mockRestore();
    verifySpy2.mockRestore();
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

  it('concurrent closeDocumentAndFlush calls both wait for viewer unmount and delayed cursor write', async () => {
    await openDocuments(['concurrent-flush.txt']);
    const store = useStudySyncStore.getState;
    const docId = store().activeDocumentId as string;
    const finalAnchor: AnchorLocation = {
      format: 'txt',
      startByteOffset: 4,
      endByteOffset: 10,
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

    let firstSettled = false;
    let secondSettled = false;
    let firstFlush!: Promise<void>;
    let secondFlush!: Promise<void>;
    act(() => {
      firstFlush = store()
        .closeDocumentAndFlush(docId)
        .then(() => {
          firstSettled = true;
        });
      // Second call runs while openDocumentIds already dropped docId, before React unmounts <Viewer>.
      secondFlush = store()
        .closeDocumentAndFlush(docId)
        .then(() => {
          secondSettled = true;
        });
    });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(docId, finalAnchor, 0.9));
    expect(screen.queryByTestId(`fake-viewer-${docId}`)).not.toBeInTheDocument();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(store().lockedDocumentIds).toContain(docId);

    resolveCursorWrite();
    await act(async () => {
      await Promise.all([firstFlush, secondFlush]);
    });
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(store().lockedDocumentIds).not.toContain(docId);
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
