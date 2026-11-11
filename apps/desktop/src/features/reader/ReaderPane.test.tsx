import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandState } from '@/features/commands/registry';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { DocumentViewerProps } from '@/types/domain';

import { ReaderPane } from './ReaderPane';

/**
 * These tests are about the tab commands, so a small stand-in fulfils the viewer
 * contract; each real engine has its own tests.
 */
function FakeViewer({ document }: DocumentViewerProps) {
  return <div data-testid={`fake-viewer-${document.id}`} tabIndex={-1} />;
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
