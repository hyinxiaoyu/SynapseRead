import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DeletedCardSnapshot, useStudySyncStore } from '@/stores/useStudySyncStore';

import { useCardDeletedNotice } from './useCardDeletedNotice';

const initialState = useStudySyncStore.getState();

const snapshot = (id: string): DeletedCardSnapshot => ({
  card: {
    id: `card-${id}`,
    notebookId: 'notebook',
    title: `Card ${id}`,
    markdownNotes: '',
    tags: [],
    annotationIds: [],
    createdAt: '2026-01-01T00:00:00Z',
  },
  nodes: [],
  edges: [],
  childParentLinks: [],
});

function Notices() {
  const { notice, liveRegion } = useCardDeletedNotice();
  return (
    <>
      {notice}
      {liveRegion}
    </>
  );
}

const deleted = (entry: DeletedCardSnapshot) =>
  act(() =>
    useStudySyncStore.setState((state) => ({
      deletedCardHistory: [...state.deletedCardHistory, entry],
    })),
  );

describe('useCardDeletedNotice (#123)', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
  });

  it('announces a deletion through a live region that was mounted empty, and offers Undo', () => {
    const undoRemoveCard = vi.fn(async () => null);
    useStudySyncStore.setState({ undoRemoveCard });
    render(<Notices />);
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();
    // A region that appears with its text is not announced, so it waits empty.
    const status = screen.getByTestId('card-deleted-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('');

    deleted(snapshot('a'));
    const notice = screen.getByTestId('card-deleted-notice');
    expect(notice).toHaveTextContent('Card deleted');
    expect(screen.getByTestId('card-deleted-status')).toBe(status);
    expect(status).toHaveTextContent('Card deleted');
    // Only the persistent region speaks; the notice would announce it twice.
    expect(within(notice).queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('status')).toEqual([status]);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undoRemoveCard).toHaveBeenCalledTimes(1);
    expect(notice).not.toBeInTheDocument();
  });

  it('withdraws Undo once the card is no longer the one Undo restores, and never re-announces it', () => {
    render(<Notices />);
    const entry = snapshot('a');
    deleted(entry);
    expect(screen.getByTestId('card-deleted-notice')).toBeInTheDocument();

    // ⌘Z (or a failed delete rolling back) took the card out of the Undo history.
    act(() => useStudySyncStore.setState({ deletedCardHistory: [] }));
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();

    // A failed Undo puts the same snapshot back; that is not a new deletion.
    deleted(entry);
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();

    deleted(snapshot('b'));
    expect(screen.getByTestId('card-deleted-notice')).toBeInTheDocument();
  });

  it('clears and repopulates the same live region for consecutive identical deletions', async () => {
    useStudySyncStore.setState({ undoRemoveCard: vi.fn(async () => null) });
    render(<Notices />);
    const status = screen.getByTestId('card-deleted-status');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(status.textContent ?? ''));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    try {
      deleted(snapshot('a'));
      await waitFor(() => expect(seen).toEqual(['Card deleted']));
      const first = screen.getByTestId('card-deleted-notice');

      deleted(snapshot('b'));
      await waitFor(() => expect(seen).toEqual(['Card deleted', '', 'Card deleted']));
      // A new deletion is a new notice, with its own timer.
      expect(first).not.toBeInTheDocument();

      // After Undo removed the notice, the next deletion is still announced.
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.queryByTestId('card-deleted-notice')).toBeNull();
      deleted(snapshot('c'));
      await waitFor(() =>
        expect(seen).toEqual(['Card deleted', '', 'Card deleted', '', 'Card deleted']),
      );
      expect(screen.getByTestId('card-deleted-status')).toBe(status);
    } finally {
      observer.disconnect();
    }
  });

  it('closes on its close button', () => {
    render(<Notices />);
    deleted(snapshot('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();
  });
});
