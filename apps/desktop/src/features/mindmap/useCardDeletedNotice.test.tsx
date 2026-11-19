import { act, fireEvent, render, screen } from '@testing-library/react';
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
  return <>{useCardDeletedNotice()}</>;
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

  it('announces every card deletion politely and offers Undo', () => {
    const undoRemoveCard = vi.fn(async () => null);
    useStudySyncStore.setState({ undoRemoveCard });
    render(<Notices />);
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();

    deleted(snapshot('a'));
    const notice = screen.getByTestId('card-deleted-notice');
    expect(screen.getByRole('status')).toHaveTextContent('Card deleted');

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

  it('closes on its close button', () => {
    render(<Notices />);
    deleted(snapshot('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByTestId('card-deleted-notice')).toBeNull();
  });
});
