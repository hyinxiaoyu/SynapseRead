import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onCommandRun, registerCommands } from '@/features/commands/registry';
import { flushBeforeClose } from '@/lib/flushBeforeClose';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { Annotation, MindMapNode, NoteCard } from '@/types/domain';

import { CARD_SAVE_DEBOUNCE_MS, InspectorPane } from './InspectorPane';

const initialState = useStudySyncStore.getState();

function seedCard(overrides: Partial<NoteCard> = {}) {
  const annotation: Annotation = {
    id: 'ann-1',
    documentId: 'doc-1',
    notebookId: 'nb-1',
    anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
    excerptText: 'hello',
    excerptImagePath: null,
    note: null,
    color: '#fde047',
    style: 'highlight',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const card: NoteCard = {
    id: 'card-1',
    notebookId: 'nb-1',
    title: 'Initial Title',
    markdownNotes: '',
    tags: [],
    annotationIds: [annotation.id],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  const node: MindMapNode = {
    id: 'node-1',
    notebookId: 'nb-1',
    cardId: card.id,
    parentNodeId: null,
    posX: 40,
    posY: 40,
    isCollapsed: false,
    style: null,
  };
  const updateCard = vi.fn(async (cardId: string, patch) => {
    useStudySyncStore.setState((state) => ({
      cards: state.cards.map((candidate) =>
        candidate.id === cardId
          ? {
              ...candidate,
              title: patch.title ?? candidate.title,
              markdownNotes: patch.markdownNotes ?? candidate.markdownNotes,
              tags: patch.tags ?? candidate.tags,
            }
          : candidate,
      ),
    }));
    return true;
  });
  useStudySyncStore.setState({
    annotations: [annotation],
    cards: [card],
    nodes: [node],
    selectedNodeId: node.id,
    updateCard,
  });
  return { annotation, card, node, updateCard };
}

describe('InspectorPane', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('auto-save and quit flush (#117)', () => {
    it('debounces saves for Title, Notes, and Tags without needing blur, keeping annotationIds and draft intact', async () => {
      vi.useFakeTimers();
      const { updateCard } = seedCard();
      render(<InspectorPane open />);

      const title = screen.getByLabelText('Title') as HTMLInputElement;
      const notes = screen.getByLabelText('Notes') as HTMLTextAreaElement;
      const tags = screen.getByLabelText('Tags') as HTMLInputElement;

      fireEvent.change(title, { target: { value: 'Updated Title' } });
      fireEvent.change(notes, { target: { value: 'First sentence.' } });
      fireEvent.change(tags, { target: { value: 'alpha, beta' } });

      expect(updateCard).not.toHaveBeenCalled();
      expect(screen.getByTestId('inspector-save-status')).toHaveTextContent('Saving…');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CARD_SAVE_DEBOUNCE_MS);
      });

      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(updateCard).toHaveBeenCalledWith('card-1', {
        title: 'Updated Title',
        markdownNotes: 'First sentence.',
        tags: ['alpha', 'beta'],
      });
      // Linked annotations are never dropped by card edits (#97).
      expect(useStudySyncStore.getState().cards[0]?.annotationIds).toEqual(['ann-1']);
      expect(screen.getByTestId('inspector-save-status')).toHaveTextContent('Saved');

      // Typing more right after the debounced save keeps the user's draft untouched.
      fireEvent.change(notes, { target: { value: 'First sentence. Second.' } });
      expect(notes.value).toBe('First sentence. Second.');
    });

    it('flushes unsaved edits immediately on pagehide and visibilitychange: hidden', async () => {
      vi.useFakeTimers();
      const { updateCard } = seedCard();
      render(<InspectorPane open />);

      const notes = screen.getByLabelText('Notes');
      fireEvent.change(notes, { target: { value: 'Typed right before quit' } });
      expect(updateCard).not.toHaveBeenCalled();

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });

      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(updateCard).toHaveBeenCalledWith('card-1', {
        title: 'Initial Title',
        markdownNotes: 'Typed right before quit',
        tags: [],
      });

      // Another edit flushed via visibilitychange: hidden.
      fireEvent.change(notes, { target: { value: 'Typed before hide' } });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard).toHaveBeenLastCalledWith('card-1', {
        title: 'Initial Title',
        markdownNotes: 'Typed before hide',
        tags: [],
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
    });

    it('flushes unsaved edits via flushBeforeClose before native window close/quit', async () => {
      vi.useFakeTimers();
      const { updateCard } = seedCard();
      render(<InspectorPane open />);

      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Before Cmd+Q' } });
      expect(updateCard).not.toHaveBeenCalled();

      await act(async () => {
        await flushBeforeClose();
      });

      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(updateCard).toHaveBeenCalledWith('card-1', {
        title: 'Initial Title',
        markdownNotes: 'Before Cmd+Q',
        tags: [],
      });
    });

    it('keeps a failed debounced write pending instead of showing Saved, and retries on close flush', async () => {
      vi.useFakeTimers();
      const { updateCard } = seedCard();
      updateCard.mockResolvedValueOnce(false);
      render(<InspectorPane open />);

      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Must not be lost' } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CARD_SAVE_DEBOUNCE_MS);
      });

      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('inspector-save-status')).toHaveTextContent('Unsaved');
      expect(useStudySyncStore.getState().cards[0]?.markdownNotes).toBe('');

      // Subsequent close flush retries the retained draft and persists it.
      await act(async () => {
        await flushBeforeClose();
      });

      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard).toHaveBeenLastCalledWith('card-1', {
        title: 'Initial Title',
        markdownNotes: 'Must not be lost',
        tags: [],
      });
      expect(useStudySyncStore.getState().cards[0]?.markdownNotes).toBe('Must not be lost');
      expect(screen.getByTestId('inspector-save-status')).toHaveTextContent('Saved');
    });

    it('does not let a failed in-flight write overwrite newer keystrokes', async () => {
      vi.useFakeTimers();
      const { updateCard } = seedCard();
      let resolveFirst: (ok: boolean) => void = () => {};
      updateCard.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      render(<InspectorPane open />);

      const notes = screen.getByLabelText('Notes');
      fireEvent.change(notes, { target: { value: 'v1' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CARD_SAVE_DEBOUNCE_MS);
      });
      expect(updateCard).toHaveBeenCalledTimes(1);

      // User keeps typing while v1 is still in flight; then v1 fails.
      fireEvent.change(notes, { target: { value: 'v1 + v2' } });
      await act(async () => {
        resolveFirst(false);
        await Promise.resolve();
      });

      // Next flush persists the newer draft ("v1 + v2"), never rolling back to "v1".
      await act(async () => {
        await flushBeforeClose();
      });
      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard).toHaveBeenLastCalledWith('card-1', {
        title: 'Initial Title',
        markdownNotes: 'v1 + v2',
        tags: [],
      });
      expect(useStudySyncStore.getState().cards[0]?.markdownNotes).toBe('v1 + v2');
      expect(screen.getByTestId('inspector-save-status')).toHaveTextContent('Saved');
    });
  });

  describe('focus management (#119) and card deletion (#116)', () => {
    it('focuses Notes on an inspectRequest and returns focus to the card on Esc', () => {
      seedCard({ markdownNotes: 'Existing note' });
      render(
        <>
          <div className="react-flow__node" data-id="node-1" tabIndex={0}>
            Card 1
          </div>
          <InspectorPane open />
        </>,
      );

      act(() => useStudySyncStore.getState().inspectNode('node-1'));

      const notes = screen.getByLabelText('Notes') as HTMLTextAreaElement;
      expect(document.activeElement).toBe(notes);
      expect(notes.selectionStart).toBe('Existing note'.length);
      expect(useStudySyncStore.getState().inspectRequest).toBeNull();

      fireEvent.keyDown(notes, { key: 'Escape' });
      const cardElement = document.querySelector('.react-flow__node[data-id="node-1"]');
      expect(document.activeElement).toBe(cardElement);
    });

    it('routes Delete Card button through the command registry', () => {
      seedCard();
      const deleteHandler = vi.fn();
      const ran = vi.fn();
      const unregister = registerCommands(() => ({
        'edit.deleteCard': { run: deleteHandler, enabled: true },
      }));
      const stopObserving = onCommandRun(ran);
      try {
        render(<InspectorPane open />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete Card' }));
        expect(deleteHandler).toHaveBeenCalledTimes(1);
        expect(ran).toHaveBeenCalledWith('edit.deleteCard', 'toolbar');
      } finally {
        stopObserving();
        unregister();
      }
    });
  });
});
