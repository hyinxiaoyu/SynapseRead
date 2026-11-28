import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MENUS } from '@/features/commands/commands';
import { dispatchEscape } from '@/features/commands/escape';
import { commandState, forgetRecentCommandRuns, runCommand } from '@/features/commands/registry';
import { INFO_NOTICE_MS, NOTICE_FADE_MS } from '@/features/reader/ReaderNotice';
import { TOOLBAR_HEIGHT_PX } from '@/features/reader/ReaderToolbar';
import { AUTO_HIDE_DELAY_MS } from '@/features/workspace/UnifiedToolbar';
import { createMemoryBackendWithPreview } from '@/lib/backend/memoryBackend';
import type { MenuItemState, StudyBackend } from '@/lib/backend/types';
import { createStudySyncStore, useStudySyncStore } from '@/stores/useStudySyncStore';
import {
  type AnchorLocation,
  DEFAULT_WORKSPACE_PANE_LAYOUT,
  type DocumentFormat,
  type DocumentViewerProps,
  INITIAL_LAN_SHARE_SNAPSHOT,
} from '@/types/domain';

import { StudyWorkspace } from './StudyWorkspace';

const SAMPLE_ANCHOR: Record<DocumentFormat, AnchorLocation> = {
  pdf: { format: 'pdf', pageIndex: 0, rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.04 }] },
  epub: { format: 'epub', cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:24)', chapterHref: 'a.xhtml' },
  txt: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
  md: { format: 'md', astNodeId: 'paragraph-1', offset: 0 },
};

/**
 * These tests are about the Reader <-> MindMap loop, so a small stand-in fulfils
 * the viewer contract. Each real engine is driven by its own tests.
 */
function FakeViewer({
  document,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
  onExcerptAnnotation,
  onShowAnnotationCard,
}: DocumentViewerProps) {
  const [localState, setLocalState] = useState(0);
  const pulsing = jumpRequest?.annotationId;
  useEffect(() => {
    if (!jumpRequest) return;
    const timer = window.setTimeout(() => onJumpHandled(jumpRequest.nonce), 1000);
    return () => window.clearTimeout(timer);
  }, [jumpRequest, onJumpHandled]);
  if (document.title.includes('corrupted-crash')) {
    throw new Error('corrupted document stream');
  }
  return (
    <div>
      <h2>{document.title}</h2>
      <button type="button" onClick={() => setLocalState((value) => value + 1)}>
        Local state of {document.title}: {localState}
      </button>
      <button
        type="button"
        onClick={() =>
          onSelectionChange({
            documentId: document.id,
            anchor: SAMPLE_ANCHOR[document.format],
            text: `Excerpt from ${document.title}`,
            imagePng: null,
          })
        }
      >
        Simulate selection
      </button>
      <section aria-label="Highlights">
        {highlights.map(({ annotationId }) => (
          <p
            key={annotationId}
            data-annotation-id={annotationId}
            className={pulsing === annotationId ? 'anchor-pulse' : undefined}
          >
            {onExcerptAnnotation && (
              <button type="button" onClick={() => onExcerptAnnotation(annotationId)}>
                Promote {annotationId}
              </button>
            )}
            {onShowAnnotationCard && (
              <button type="button" onClick={() => onShowAnnotationCard(annotationId)}>
                Show card {annotationId}
              </button>
            )}
          </p>
        ))}
      </section>
    </div>
  );
}

vi.mock('@/features/reader/viewerRegistry', () => ({
  viewerRegistry: new Proxy({}, { get: () => FakeViewer }),
}));

// The memory backend behind the singleton store outlives each reset, so a test
// may reload cards from earlier tests: assert on the newest one.
const initialState = useStudySyncStore.getState();

describe('StudyWorkspace', () => {
  beforeEach(() => {
    for (const id of [...useStudySyncStore.getState().openDocumentIds]) {
      useStudySyncStore.getState().closeDocument(id);
    }
    useStudySyncStore.getState().setImmersive(false);
    useStudySyncStore.getState().setPaneLayout(DEFAULT_WORKSPACE_PANE_LAYOUT);
    useStudySyncStore.setState(initialState, true);
    forgetRecentCommandRuns();
  });

  const renderReady = async () => {
    render(<StudyWorkspace />);
    return screen.findByRole('region', { name: 'Document reader' });
  };

  it('starts with MindMap and inspector hidden for full-screen reading, and toggles them', async () => {
    await renderReady();
    expect(screen.getByRole('region', { name: 'MindMap canvas' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Card inspector' })).toBeInTheDocument();

    const showMindMap = screen.getByRole('button', { name: 'Show MindMap' });
    const showInspector = screen.getByRole('button', { name: 'Show inspector' });
    expect(showMindMap).toHaveAttribute('aria-pressed', 'false');
    expect(showInspector).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(showMindMap);
    expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(showInspector);
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('labels a session that will not be saved', async () => {
    await renderReady();
    expect(screen.getByText(/nothing is saved/i)).toBeInTheDocument();
  });

  it('only enables excerpting while something is selected', async () => {
    await renderReady();
    const excerpt = screen.getByRole('button', { name: 'Excerpt to MindMap' });
    expect(excerpt).toBeDisabled();
    // Inactive, it is a ghost button whose tooltip says why, not a dark primary one.
    expect(excerpt).toHaveAttribute('aria-description', expect.stringMatching(/select text/i));
    expect(screen.getByTestId('excerpt-button-wrapper')).toHaveAttribute(
      'title',
      expect.stringMatching(/select text/i),
    );
    expect(excerpt.className).not.toMatch(/\bbg-primary\b/);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    expect(excerpt).toBeEnabled();
    expect(excerpt).not.toHaveAttribute('aria-description');
    expect(excerpt.className).toMatch(/\bbg-primary\b/);
  });

  it('runs selection -> excerpt -> highlight -> inspector', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

    const highlights = await screen.findByRole('region', { name: 'Highlights' });
    expect(highlights.querySelector('[data-annotation-id]')).not.toBeNull();
    expect(screen.getByLabelText('Title')).toHaveValue(
      useStudySyncStore.getState().cards.at(-1)?.title,
    );
    expect(screen.getByRole('button', { name: 'Excerpt to MindMap' })).toBeDisabled();
  });

  describe('excerpt confirmation (#98)', () => {
    const excerpt = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
      fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    };

    it('announces an excerpt while the MindMap is collapsed, and Show opens it at the card', async () => {
      await renderReady();
      // The live region is mounted empty before any excerpt so AT sees updates.
      const status = screen.getByTestId('excerpt-status');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent('');

      await excerpt();

      const notice = await screen.findByTestId('excerpt-added-notice');
      expect(notice).toHaveAttribute('data-tone', 'info');
      expect(notice).toHaveTextContent('Added to MindMap');
      expect(within(notice).queryByRole('status')).toBeNull();
      expect(screen.getByTestId('excerpt-status')).toBe(status);
      expect(status).toHaveTextContent('Added to MindMap');
      const reader = screen.getByRole('region', { name: 'Document reader' });
      expect(reader).toContainElement(notice);
      expect(reader.querySelector('header')).not.toContainElement(notice);
      expect(screen.getByRole('region', { name: 'Card inspector' })).not.toContainElement(notice);
      expect(screen.getByRole('region', { name: 'MindMap canvas' })).not.toContainElement(notice);

      const newest = useStudySyncStore.getState().nodes.at(-1)?.id;
      // Something else selected meanwhile; Show still lands on the new card.
      act(() => useStudySyncStore.setState({ selectedNodeId: null }));
      fireEvent.click(within(notice).getByRole('button', { name: 'Show' }));

      expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();
      expect(useStudySyncStore.getState().selectedNodeId).toBe(newest);
      // Showing it is not choosing it as the parent for the next excerpt.
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      expect(document.querySelector(`.react-flow__node[data-id="${newest}"]`)).toHaveClass(
        'selected',
      );
    });

    it('clears and repopulates the same status node on consecutive excerpts', async () => {
      await renderReady();
      const status = screen.getByTestId('excerpt-status');
      const seenTexts: string[] = [];
      const observer = new MutationObserver(() => {
        seenTexts.push(status.textContent ?? '');
      });
      observer.observe(status, { childList: true, characterData: true, subtree: true });
      try {
        await excerpt();
        await waitFor(() => expect(status).toHaveTextContent('Added to MindMap'));

        fireEvent.click(screen.getByRole('button', { name: 'Simulate selection' }));
        fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
        await waitFor(() =>
          expect(seenTexts).toEqual(['Added to MindMap', '', 'Added to MindMap']),
        );
        expect(screen.getByTestId('excerpt-status')).toBe(status);
      } finally {
        observer.disconnect();
      }
    });

    it('drops the pending reveal when the notice is closed', async () => {
      await renderReady();
      await excerpt();

      fireEvent.click(
        within(await screen.findByTestId('excerpt-added-notice')).getByRole('button', {
          name: 'Close notice',
        }),
      );

      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();
      expect(useStudySyncStore.getState().revealRequest).toBeNull();
    });

    it('shows no notice while the MindMap is open', async () => {
      // The canvas has a size, so it can reveal the card itself.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const size = this.classList.contains('react-flow')
          ? { width: 800, height: 600 }
          : { width: 0, height: 0 };
        return DOMRect.fromRect({ x: 0, y: 0, ...size });
      });
      await renderReady();
      fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
      await excerpt();

      await vi.waitFor(() => expect(useStudySyncStore.getState().revealRequest).toBeNull());
      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();
    });

    it('reports a failed excerpt through the error banner, not the notice', async () => {
      await renderReady();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
      // As the store does when the write fails: an error, and nothing to reveal.
      act(() =>
        useStudySyncStore.setState({
          excerptSelection: async () => {
            useStudySyncStore.setState({ error: 'disk full' });
          },
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();
    });

    it('announces an excerpt politely during focus mode without a visible banner until focus mode ends', async () => {
      await renderReady();
      const status = screen.getByTestId('excerpt-status');
      expect(status).toHaveTextContent('');
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      await screen.findByRole('tab');
      fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
      expect(useStudySyncStore.getState().immersive).toBe(true);

      fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
      fireEvent.keyDown(window, { key: 'E', code: 'KeyE', metaKey: true, shiftKey: true });

      await waitFor(() => expect(status).toHaveTextContent('Added to MindMap'));
      expect(screen.getByTestId('excerpt-status')).toBe(status);
      expect(status).toHaveClass('sr-only');
      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(useStudySyncStore.getState().immersive).toBe(false);
      const notice = await screen.findByTestId('excerpt-added-notice');
      expect(notice).toBeVisible();
      expect(within(notice).queryByRole('status')).toBeNull();
    });

    it('shows the active nesting target in the reader toolbar and notice, and lets the reader clear it while MindMap is hidden (#127)', async () => {
      await renderReady();
      const initialNodeCount = useStudySyncStore.getState().nodes.length;
      const initialEdgeCount = useStudySyncStore.getState().edges.length;
      await excerpt();
      await waitFor(() =>
        expect(useStudySyncStore.getState().nodes).toHaveLength(initialNodeCount + 1),
      );
      const parentNode = useStudySyncStore.getState().nodes.at(-1)!;
      const parentCard = useStudySyncStore
        .getState()
        .cards.find((candidate) => candidate.id === parentNode.cardId)!;

      // Deliberately selecting the card makes it the nesting target even with MindMap collapsed.
      act(() => useStudySyncStore.getState().selectNode(parentNode.id));

      const excerptBtn = screen.getByTestId('excerpt-button');
      expect(excerptBtn).toHaveAccessibleName(`Excerpt under ‘${parentCard.title}’`);
      expect(screen.getByTestId('excerpt-button-wrapper')).toHaveAttribute(
        'title',
        expect.stringContaining(`Excerpt under ‘${parentCard.title}’`),
      );

      // Excerpting while MindMap is hidden announces and shows "Added under ‘<title>’".
      fireEvent.click(screen.getByRole('button', { name: 'Simulate selection' }));
      fireEvent.click(excerptBtn);

      await waitFor(() =>
        expect(screen.getByTestId('excerpt-added-notice')).toHaveTextContent(
          `Added under ‘${parentCard.title}’`,
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId('excerpt-status')).toHaveTextContent(
          `Added under ‘${parentCard.title}’`,
        ),
      );
      expect(useStudySyncStore.getState().nodes).toHaveLength(initialNodeCount + 2);
      expect(useStudySyncStore.getState().nodes.at(-1)?.parentNodeId).toBe(parentNode.id);
      expect(useStudySyncStore.getState().edges).toHaveLength(initialEdgeCount + 1);

      // Reader clears the nesting target directly from the toolbar without opening MindMap.
      fireEvent.click(screen.getByRole('button', { name: 'Simulate selection' }));
      const clearBtn = screen.getByTestId('clear-nesting-target-button');
      expect(clearBtn).toHaveAccessibleName(`Clear nesting target ‘${parentCard.title}’`);
      fireEvent.click(clearBtn);

      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      // Selection stays alive so the reader can immediately excerpt as a new root.
      expect(useStudySyncStore.getState().selection).not.toBeNull();
      expect(screen.getByTestId('excerpt-button')).toHaveAccessibleName('Excerpt to MindMap');
      expect(screen.queryByTestId('clear-nesting-target-button')).toBeNull();

      fireEvent.click(screen.getByTestId('excerpt-button'));
      await waitFor(() =>
        expect(useStudySyncStore.getState().nodes).toHaveLength(initialNodeCount + 3),
      );
      expect(useStudySyncStore.getState().nodes.at(-1)?.parentNodeId).toBeNull();
      expect(useStudySyncStore.getState().edges).toHaveLength(initialEdgeCount + 1);
      await waitFor(() =>
        expect(screen.getByTestId('excerpt-added-notice')).toHaveTextContent('Added to MindMap'),
      );
    });
  });

  describe('card deleted notice (#123)', () => {
    const excerpt = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
      fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
      await waitFor(() => expect(useStudySyncStore.getState().selectedNodeId).not.toBeNull());
    };

    it('gets its own node and timer when it replaces a fading excerpt notice, and Undo restores the card', async () => {
      // Advancing with the clock keeps the memory backend's promises moving.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await renderReady();
        const status = screen.getByTestId('card-deleted-status');
        expect(status).toHaveTextContent('');
        // MindMap hidden, Inspector open.
        fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }));
        await excerpt();
        const cardId = useStudySyncStore.getState().cards.at(-1)?.id;
        const cardCount = useStudySyncStore.getState().cards.length;

        const excerptNotice = await screen.findByTestId('excerpt-added-notice');
        act(() => void vi.advanceTimersByTime(INFO_NOTICE_MS));
        expect(excerptNotice).toHaveAttribute('data-fading', 'true');

        fireEvent.click(screen.getByRole('button', { name: /Delete Card/ }));
        const deletedNotice = await screen.findByTestId('card-deleted-notice');
        expect(useStudySyncStore.getState().cards).toHaveLength(cardCount - 1);
        expect(deletedNotice).not.toBe(excerptNotice);
        expect(deletedNotice).not.toHaveAttribute('data-fading');
        expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();
        expect(screen.getByTestId('card-deleted-status')).toBe(status);
        await waitFor(() => expect(status).toHaveTextContent('Card deleted'));

        // Well past the excerpt notice's fade, Undo is still there.
        act(() => void vi.advanceTimersByTime(NOTICE_FADE_MS * 2));
        expect(screen.getByTestId('card-deleted-notice')).toBe(deletedNotice);
        expect(deletedNotice).not.toHaveAttribute('data-fading');

        fireEvent.click(within(deletedNotice).getByRole('button', { name: 'Undo' }));
        await waitFor(() =>
          expect(useStudySyncStore.getState().cards.map((card) => card.id)).toContain(cardId),
        );
        expect(useStudySyncStore.getState().cards).toHaveLength(cardCount);

        // Its own timer: a full info interval, not what was left of the excerpt's.
        fireEvent.click(screen.getByRole('button', { name: /Delete Card/ }));
        const again = await screen.findByTestId('card-deleted-notice');
        act(() => void vi.advanceTimersByTime(INFO_NOTICE_MS - 100));
        expect(again).not.toHaveAttribute('data-fading');
        act(() => void vi.advanceTimersByTime(200));
        expect(again).toHaveAttribute('data-fading', 'true');
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows Undo at once in focus mode, after a canvas Backspace on a map reopened from the toolbar', async () => {
      // The canvas has a size, so React Flow lays out and the card can be focused.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const size = this.classList.contains('react-flow')
          ? { width: 800, height: 600 }
          : { width: 0, height: 0 };
        return DOMRect.fromRect({ x: 0, y: 0, ...size });
      });
      await renderReady();
      await excerpt();
      const cardId = useStudySyncStore.getState().cards.at(-1)?.id;
      const nodeId = useStudySyncStore.getState().selectedNodeId;
      const cardCount = useStudySyncStore.getState().cards.length;

      fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
      expect(useStudySyncStore.getState().immersive).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
      await screen.findByRole('button', { name: 'Hide MindMap' });

      const card = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${nodeId}"]`,
        );
        expect(element).not.toBeNull();
        return element as HTMLElement;
      });
      card.focus();
      fireEvent.keyDown(card, { key: 'Backspace', code: 'Backspace' });

      const notice = await screen.findByTestId('card-deleted-notice');
      expect(useStudySyncStore.getState().immersive).toBe(true);
      expect(useStudySyncStore.getState().cards).toHaveLength(cardCount - 1);
      expect(notice).toBeVisible();
      expect(notice.parentElement).toHaveStyle({ top: `${8 + TOOLBAR_HEIGHT_PX}px` });
      expect(screen.getByRole('region', { name: 'Document reader' })).toContainElement(notice);
      expect(screen.getByTestId('card-deleted-status')).toHaveTextContent('Card deleted');
      // Focus mode still defers the excerpt notice; only the deletion shows.
      expect(screen.queryByTestId('excerpt-added-notice')).not.toBeInTheDocument();

      fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(useStudySyncStore.getState().cards.map((entry) => entry.id)).toContain(cardId),
      );
      expect(useStudySyncStore.getState().immersive).toBe(true);
      expect(screen.queryByTestId('card-deleted-notice')).not.toBeInTheDocument();
    });
  });

  it('pulses the source highlight on a jump, then completes it', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    const highlights = await screen.findByRole('region', { name: 'Highlights' });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: /^Jump to this excerpt/ }));
      expect(useStudySyncStore.getState().jumpRequest).not.toBeNull();
      expect(highlights.querySelector('.anchor-pulse')).not.toBeNull();

      act(() => void vi.advanceTimersByTime(2000));
      expect(highlights.querySelector('.anchor-pulse')).toBeNull();
      expect(useStudySyncStore.getState().jumpRequest).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps each tab mounted, with its state, across a tab switch', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const firstState = await screen.findByRole('button', { name: /Local state of/ });
    fireEvent.click(firstState);
    expect(firstState).toHaveTextContent(': 1');

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    // Hidden, so it leaves the accessibility tree, but not unmounted.
    expect(firstState).toBeInTheDocument();
    expect(firstState).not.toBeVisible();

    fireEvent.click(screen.getAllByRole('tab')[0] as HTMLElement);
    expect(firstState).toBeVisible();
    expect(firstState).toHaveTextContent(': 1');
  });

  it('saves card edits when the selection moves on without a blur', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

    const notes = await screen.findByLabelText('Notes');
    fireEvent.change(notes, { target: { value: 'unsaved thought' } });
    act(() => useStudySyncStore.getState().selectNode(null));

    await vi.waitFor(() =>
      expect(useStudySyncStore.getState().cards.at(-1)?.markdownNotes).toBe('unsaved thought'),
    );
  });

  it('shows store errors until dismissed', async () => {
    await renderReady();
    act(() => useStudySyncStore.setState({ error: 'disk full' }));
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a drop indicator on file drag and opens dropped files automatically', async () => {
    await renderReady();
    const main = screen.getByRole('main');
    const file = new File(['dropped text content'], 'dropped-note.txt', { type: 'text/plain' });

    fireEvent.dragEnter(main, {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    expect(screen.getByRole('status', { name: 'Drop files to open' })).toHaveTextContent(
      'Drop PDF, EPUB, TXT, or Markdown files to open',
    );

    fireEvent.drop(main, {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    expect(screen.queryByRole('status', { name: 'Drop files to open' })).not.toBeInTheDocument();

    expect(await screen.findByRole('tab', { name: 'dropped-note' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'dropped-note' })).toBeInTheDocument();
  });

  it('opens a dropped Markdown file as a readable text document (#99)', async () => {
    await renderReady();
    const main = screen.getByRole('main');
    const file = new File(['# Notes\n\nRead me.\n'], 'README.md', { type: 'text/markdown' });

    fireEvent.drop(main, { dataTransfer: { files: [file], types: ['Files'] } });

    expect(await screen.findByRole('tab', { name: 'README' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const opened = useStudySyncStore.getState().documents.find((d) => d.title === 'README');
    expect(opened?.format).toBe('txt');
    expect(screen.queryByText(/Markdown support arrives/)).not.toBeInTheDocument();
  });

  it('lists recent documents with continue-reading progress and reopens them on click', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const firstTab = await screen.findByRole('tab');
    const firstTitle = firstTab.textContent ?? '';
    const firstDocId = useStudySyncStore.getState().activeDocumentId as string;

    act(() => {
      useStudySyncStore.getState().reportCursor(firstDocId, {
        format: 'txt',
        startByteOffset: 120,
        endByteOffset: 160,
        lineIndex: 14,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: `Close ${firstTitle}` }));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    const emptyRecent = screen.getByTestId('empty-state-recent-documents');
    expect(emptyRecent).toHaveTextContent(firstTitle);
    expect(emptyRecent).toHaveTextContent('Continue reading · Line 15');

    // An EPUB position names a chapter file; Recent leaves it out rather than show it.
    act(() => {
      useStudySyncStore.getState().reportCursor(firstDocId, {
        format: 'epub',
        cfiRange: 'epubcfi(/6/4!/4/2/1:0)',
        chapterHref: 'OEBPS/chapter1.xhtml',
      });
    });
    expect(emptyRecent).toHaveTextContent('Continue reading');
    expect(emptyRecent).not.toHaveTextContent('chapter1.xhtml');

    const recentButtons = screen.getAllByTestId('recent-document-item');
    const targetButton = recentButtons.find((btn) => btn.textContent?.includes(firstTitle));
    expect(targetButton).toBeDefined();
    fireEvent.click(targetButton as HTMLElement);

    expect(await screen.findByRole('tab', { name: firstTitle })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('isolates a broken document tab behind an error boundary without blocking other open tabs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await renderReady();
      const main = screen.getByRole('main');
      const healthy = new File(['healthy content'], 'healthy-doc.txt', { type: 'text/plain' });
      const broken = new File(['corrupt'], 'corrupted-crash.txt', { type: 'text/plain' });

      fireEvent.drop(main, {
        dataTransfer: { files: [healthy, broken], types: ['Files'] },
      });

      const fallback = await screen.findByTestId('broken-document-fallback');
      expect(fallback).toHaveTextContent('Could not render corrupted-crash');
      expect(fallback).toHaveTextContent('corrupted document stream');

      // Switching to the healthy tab works normally despite the broken sibling tab.
      fireEvent.click(screen.getByRole('tab', { name: 'healthy-doc' }));
      expect(screen.getByRole('heading', { name: 'healthy-doc' })).toBeVisible();

      // Switch back to the broken tab and close it via the fallback button.
      fireEvent.click(screen.getByRole('tab', { name: 'corrupted-crash' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close tab' }));
      await waitFor(() =>
        expect(screen.queryByRole('tab', { name: 'corrupted-crash' })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('heading', { name: 'healthy-doc' })).toBeVisible();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('supports Cmd/Ctrl+O and Cmd/Ctrl+W shortcuts and ignores them inside editable fields', async () => {
    await renderReady();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    // Cmd+O opens a document.
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    const tab = await screen.findByRole('tab');
    expect(tab).toBeInTheDocument();

    // Open a selection and excerpt so the card inspector shows editable inputs.
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    const titleInput = await screen.findByLabelText('Title');

    // Pressing Cmd+W or Ctrl+O inside an input must be ignored by workspace shortcuts.
    const tabCountBefore = screen.getAllByRole('tab').length;
    fireEvent.keyDown(titleInput, { key: 'w', metaKey: true });
    fireEvent.keyDown(titleInput, { key: 'o', ctrlKey: true });
    expect(screen.getAllByRole('tab')).toHaveLength(tabCountBefore);

    // Pressing Cmd+W outside editable fields closes the active document tab.
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument());
  });

  it('shows source recovery dialog for missing and changed files, preserves notes, and recovers on relink', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const tab = await screen.findByRole('tab');
    const docTitle = tab.textContent ?? '';
    const docId = useStudySyncStore.getState().activeDocumentId as string;

    // Create an excerpt so there is a preserved annotation to display in the recovery view.
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    await screen.findByRole('region', { name: 'Highlights' });

    // Simulate the source file becoming missing on disk: viewer is replaced by SourceRecoveryDialog,
    // and preserved notes are shown.
    act(() => {
      useStudySyncStore.setState((prev) => ({
        documentSourceStatuses: {
          ...prev.documentSourceStatuses,
          [docId]: {
            documentId: docId,
            state: 'missing',
            currentFileHash: null,
            fileSizeBytes: null,
          },
        },
      }));
    });

    const missingDialog = await screen.findByTestId('source-recovery-dialog');
    expect(missingDialog).toHaveAttribute('data-source-state', 'missing');
    expect(missingDialog).toHaveTextContent(
      `${docTitle} could not be found at its original location`,
    );
    expect(screen.getByTestId('preserved-notes-summary')).toHaveTextContent(
      `Excerpt from ${docTitle}`,
    );
    expect(screen.queryByTestId('confirm-changed-file-button')).not.toBeInTheDocument();

    // Simulate the source file being modified in-place on disk (`changed` state):
    // both `Relink file…` and `Use updated file` are offered, and stale anchors are not silently applied.
    act(() => {
      useStudySyncStore.setState((prev) => ({
        documentSourceStatuses: {
          ...prev.documentSourceStatuses,
          [docId]: {
            documentId: docId,
            state: 'changed',
            currentFileHash: 'modified-hash',
            fileSizeBytes: 512,
          },
        },
      }));
    });

    const changedDialog = await screen.findByTestId('source-recovery-dialog');
    expect(changedDialog).toHaveAttribute('data-source-state', 'changed');
    expect(changedDialog).toHaveTextContent(`${docTitle} has changed on disk`);
    const confirmBtn = screen.getByTestId('confirm-changed-file-button');
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(screen.queryByTestId('source-recovery-dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: docTitle })).toBeVisible();
  });

  it('supports keyboard-only tab navigation, roving tabIndex, tabpanel ARIA linkage, and Escape menu dismissal', async () => {
    await renderReady();
    // Open three tabs.
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));

    const tabs = screen.getAllByRole('tab');
    const [tab0, tab1, tab2] = tabs as [HTMLElement, HTMLElement, HTMLElement];

    // Active tab (tab2) has tabIndex=0 and aria-selected=true; inactive tabs have tabIndex=-1.
    expect(tab2).toHaveAttribute('aria-selected', 'true');
    expect(tab2).toHaveAttribute('tabIndex', '0');
    expect(tab0).toHaveAttribute('tabIndex', '-1');
    expect(tab1).toHaveAttribute('tabIndex', '-1');

    // Verify tab <-> tabpanel ARIA linkage.
    const controlledPanelId = tab2.getAttribute('aria-controls') as string;
    const controlledPanel = document.getElementById(controlledPanelId);
    expect(controlledPanel).not.toBeNull();
    expect(controlledPanel).toHaveAttribute('role', 'tabpanel');
    expect(controlledPanel).toHaveAttribute('aria-labelledby', tab2.id);

    // ArrowRight wraps from tab2 -> tab0 and focuses tab0.
    tab2.focus();
    fireEvent.keyDown(tab2, { key: 'ArrowRight' });
    expect(tab0).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tab0);

    // ArrowLeft wraps from tab0 -> tab2.
    fireEvent.keyDown(tab0, { key: 'ArrowLeft' });
    expect(tab2).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tab2);

    // Home jumps to tab0; End jumps to tab2.
    fireEvent.keyDown(tab2, { key: 'Home' });
    expect(tab0).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab0, { key: 'End' });
    expect(tab2).toHaveAttribute('aria-selected', 'true');

    // Recent documents menu closes on Escape.
    fireEvent.click(screen.getByTestId('recent-documents-toggle'));
    expect(await screen.findByTestId('recent-documents-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('recent-documents-menu')).not.toBeInTheDocument();
  });

  it('puts the reader controls in one unified toolbar above the tab bar', async () => {
    await renderReady();
    const toolbar = screen.getByTestId('unified-toolbar');
    // The toolbar is the first band, the tabs the second; the product name is
    // left to the window title.
    expect(screen.queryByText('SynapseRead')).not.toBeInTheDocument();
    expect(toolbar).toHaveTextContent('My Notebook');
    const mindMap = screen.getByRole('button', { name: 'Show MindMap' });
    expect(toolbar).toContainElement(mindMap);
    expect(mindMap.getAttribute('title')).toMatch(/^Show MindMap \((⇧⌘M|Ctrl\+Shift\+M)\)$/);

    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByRole('tab');
    expect(screen.getByRole('tablist').closest('header')).not.toBe(toolbar);
    expect(toolbar).not.toHaveTextContent('My Notebook');
  });

  it('runs native menu choices as commands and keeps menu items in step with what applies', async () => {
    let chooseMenuItem: (commandId: string) => void = () => undefined;
    const setMenuItemStates = vi.fn<(states: readonly MenuItemState[]) => Promise<void>>(
      async () => undefined,
    );
    useStudySyncStore.setState({
      onMenuCommand: (listener) => {
        chooseMenuItem = listener;
        return () => undefined;
      },
      setMenuItemStates,
    });
    await renderReady();

    const latestState = (id: string) =>
      setMenuItemStates.mock.calls
        .flatMap(([states]) => states)
        .filter((state) => state?.id === id)
        .at(-1);
    await waitFor(() =>
      expect(latestState('file.open')).toEqual({ id: 'file.open', enabled: true }),
    );
    expect(latestState('file.closeTab')).toEqual({ id: 'file.closeTab', enabled: false });
    expect(latestState('view.rotateLeft')).toEqual({ id: 'view.rotateLeft', enabled: false });

    act(() => chooseMenuItem('file.open'));
    expect(await screen.findByRole('tab')).toBeInTheDocument();
    await waitFor(() =>
      expect(latestState('file.closeTab')).toEqual({ id: 'file.closeTab', enabled: true }),
    );

    act(() => chooseMenuItem('window.mindMap'));
    expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(latestState('window.mindMap')).toEqual({
        id: 'window.mindMap',
        enabled: true,
        title: 'Hide MindMap',
      }),
    );

    // Ids that are not app commands (predefined items) are ignored.
    act(() => chooseMenuItem('copy'));
    act(() => chooseMenuItem('file.closeTab'));
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument());
  });

  it('enters focus mode, collapsing panes and tabs, and Esc restores them', async () => {
    await renderReady();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByRole('tab');
    fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
    expect(screen.getByRole('button', { name: 'Hide MindMap' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
    expect(useStudySyncStore.getState().immersive).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show MindMap' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('tablist').closest('header')).toHaveClass('hidden');
    expect(screen.getByTestId('unified-toolbar')).toHaveAttribute('data-immersive', 'true');
    expect(screen.getByRole('button', { name: 'Exit focus mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Esc first closes what is open (here, Help ▸ Keyboard Shortcuts) and stays in focus mode.
    fireEvent.keyDown(window, { key: '/', code: 'Slash', metaKey: true });
    expect(screen.getByTestId('keyboard-shortcuts-dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).not.toBeInTheDocument();
    expect(useStudySyncStore.getState().immersive).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useStudySyncStore.getState().immersive).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Hide MindMap' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('tablist').closest('header')).not.toHaveClass('hidden');
  });

  it('lets Esc leave focus mode even when focus stayed inside the collapsed MindMap', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
    expect(screen.getByRole('button', { name: 'Hide MindMap' })).toBeInTheDocument();

    const mindMapPane = document.querySelector('.react-flow__pane') as HTMLElement;
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
    expect(useStudySyncStore.getState().immersive).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show MindMap' })).toBeInTheDocument(),
    );

    // Even if focus remained inside the collapsed MindMap panel with a selected card,
    // Esc reaches focusMode instead of being swallowed by the hidden MindMap layer.
    const selectedBefore = useStudySyncStore.getState().selectedNodeId;
    expect(selectedBefore).not.toBeNull();
    fireEvent.keyDown(mindMapPane, { key: 'Escape' });
    expect(useStudySyncStore.getState().immersive).toBe(false);
    expect(useStudySyncStore.getState().selectedNodeId).toBe(selectedBefore);
  });

  it('leaves focus mode on Esc forwarded from a chapter frame, but not on Esc in a text field', async () => {
    await renderReady();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByRole('tab');
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
    expect(useStudySyncStore.getState().immersive).toBe(true);

    // Text entry keeps its own Esc.
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(useStudySyncStore.getState().immersive).toBe(true);
    field.remove();

    // An EPUB chapter is another document: its keys reach the app only as the
    // reader forwards them.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const chapter = frame.contentDocument as Document;
    chapter.addEventListener('keydown', (event) => dispatchEscape(event));
    act(() => {
      chapter.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(useStudySyncStore.getState().immersive).toBe(false);
    frame.remove();
  });

  it('closes a toolbar menu when focus moves into a chapter frame, so a forwarded Esc still leaves focus mode', async () => {
    await renderReady();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByRole('tab');
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
    expect(useStudySyncStore.getState().immersive).toBe(true);
    fireEvent.click(screen.getByTestId('recent-documents-toggle'));
    expect(await screen.findByTestId('recent-documents-menu')).toBeInTheDocument();

    // A click into the chapter moves focus to its iframe and blurs this window,
    // without any pointerdown reaching it.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const chapter = frame.contentDocument as Document;
    chapter.addEventListener('keydown', (event) => dispatchEscape(event));
    frame.focus();
    expect(document.activeElement).toBe(frame);
    act(() => {
      window.dispatchEvent(new FocusEvent('blur'));
    });
    expect(screen.queryByTestId('recent-documents-menu')).not.toBeInTheDocument();

    act(() => {
      chapter.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(useStudySyncStore.getState().immersive).toBe(false);
    frame.remove();
  });

  it('toggles full screen from its shortcut and retitles the command', async () => {
    const setFullscreen = vi.fn(async (fullscreen: boolean) => {
      useStudySyncStore.setState({ fullscreen });
    });
    useStudySyncStore.setState({ setFullscreen });
    await renderReady();

    // ⌃⌘F on macOS; F11 here, as on Windows and Linux.
    fireEvent.keyDown(window, { key: 'F11', code: 'F11' });
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });

  describe('opening Inspector from a card and persisting pane layout (#119)', () => {
    it('does not open Inspector on excerpt, opens it on double-click or Edit Card, and focuses Notes', async () => {
      await renderReady();
      fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
      fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

      await waitFor(() => expect(useStudySyncStore.getState().nodes.length).toBeGreaterThan(0));
      const newestNode = useStudySyncStore.getState().nodes.at(-1);
      expect(newestNode).toBeDefined();

      // Excerpting never auto-opens the Inspector.
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      // Double-clicking the card opens Inspector and focuses Notes.
      const cardEl = document.querySelector(
        `.react-flow__node[data-id="${newestNode?.id}"]`,
      ) as HTMLElement;
      fireEvent.doubleClick(cardEl);

      expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Notes')));

      // Collapse Inspector again and verify Enter (`edit.editCard`) reopens and focuses Notes.
      fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }));
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      cardEl.focus();
      fireEvent.keyDown(cardEl, { key: 'Enter', code: 'Enter' });

      expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Notes')));
    });

    it('persists MindMap and Inspector open state across relaunch while keeping focus mode restore', async () => {
      const first = render(<StudyWorkspace />);
      await screen.findByRole('region', { name: 'Document reader' });

      fireEvent.click(screen.getByRole('button', { name: 'Show MindMap' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }));
      expect(useStudySyncStore.getState().paneLayout).toMatchObject({
        mindMapOpen: true,
        inspectorOpen: true,
      });

      // Focus mode collapses both visually without overwriting persisted pane layout, and restores them.
      fireEvent.click(screen.getByRole('button', { name: 'Enter focus mode' }));
      expect(screen.getByRole('button', { name: 'Show MindMap' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(useStudySyncStore.getState().paneLayout).toMatchObject({
        mindMapOpen: true,
        inspectorOpen: true,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Exit focus mode' }));
      expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Simulate relaunch: unmount, reset in-memory store state to idle, remount against same backend.
      first.unmount();
      useStudySyncStore.setState(initialState, true);

      render(<StudyWorkspace />);
      await screen.findByRole('region', { name: 'Document reader' });
      expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  describe('LAN sharing indicator (R2-06, R3-04)', () => {
    it('stays visible on empty state, open books, and after the toolbar auto-hides in Focus Mode', async () => {
      await renderReady();
      expect(screen.queryByTestId('lan-share-indicator')).not.toBeInTheDocument();

      const listeningSnapshot = {
        ...INITIAL_LAN_SHARE_SNAPSHOT,
        status: { state: 'listening' as const, failedAttempts: 0, maxFailedAttempts: 5 },
        address: '192.168.1.42:49319',
        interfaceName: 'en0',
        pairingCode: '482913',
        codeExpiresAtMs: Date.now() + 600_000,
        permissions: { positions: true, bookmarks: true },
        sharedBookCount: 1,
      };
      act(() => {
        useStudySyncStore.setState((state) => ({
          lanShare: {
            ...state.lanShare,
            snapshot: listeningSnapshot,
          },
          refreshLanShareStatus: vi.fn(async () => listeningSnapshot),
        }));
      });

      // Visible on empty state inside UnifiedToolbar workspaceControls.
      const toolbarIndicator = screen.getByTestId('lan-share-indicator');
      expect(screen.getByTestId('unified-toolbar')).toContainElement(toolbarIndicator);
      expect(toolbarIndicator).toHaveTextContent('Sharing');

      // Also stays visible when a book is open (`R2-06`).
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByRole('tab')).toBeInTheDocument();
      expect(screen.getByTestId('lan-share-indicator')).toBeInTheDocument();

      vi.useFakeTimers();
      try {
        // Enter Focus Mode via keyboard shortcut (so the pointer is not hovering over the toolbar)
        // and let UnifiedToolbar auto-hide (`inert`, `data-hidden="true"`).
        fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
        expect(useStudySyncStore.getState().immersive).toBe(true);
        expect(screen.getByTestId('unified-toolbar')).toHaveAttribute('data-immersive', 'true');
        act(() => {
          vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS + 100);
        });
        expect(screen.getByTestId('unified-toolbar')).toHaveAttribute('data-hidden', 'true');

        // Floating indicator stays visible & clickable outside the hidden toolbar.
        const floatingIndicator = screen.getByTestId('lan-share-floating-indicator');
        expect(floatingIndicator).toBeVisible();
        fireEvent.click(floatingIndicator);
        expect(screen.getByTestId('lan-share-dialog')).toBeInTheDocument();

        // Closing the Share dialog keeps sharing active and the indicator visible.
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('lan-share-dialog')).not.toBeInTheDocument();
        expect(screen.getByTestId('lan-share-floating-indicator')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('isolates both DOM shortcuts and native menu commands while Share modal is open, keeping modal inputs editable (#168)', async () => {
      let emitMenuCommand: ((id: string) => void) | null = null;
      const setMenuItemStates = vi.fn<(states: readonly MenuItemState[]) => Promise<void>>(
        async () => undefined,
      );
      const originalOpenDocument = useStudySyncStore.getState().openDocument;
      const openDocSpy = vi.fn(async () => originalOpenDocument());
      const toggleBookmarkSpy = vi.fn(async () => undefined);

      act(() => {
        useStudySyncStore.setState({
          onMenuCommand: (listener) => {
            emitMenuCommand = listener;
            return () => {
              if (emitMenuCommand === listener) emitMenuCommand = null;
            };
          },
          setMenuItemStates,
        });
      });

      await renderReady();

      // Open one document tab so closeTab, bookmarks, and Focus Mode are all active.
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByRole('tab')).toBeInTheDocument();

      const activeDocId = useStudySyncStore.getState().activeDocumentId;
      expect(activeDocId).not.toBeNull();
      act(() => {
        useStudySyncStore.setState({
          openDocument: openDocSpy,
          toggleBookmark: toggleBookmarkSpy,
        });
      });

      const offSnapshotWithBook = { ...INITIAL_LAN_SHARE_SNAPSHOT };
      act(() => {
        useStudySyncStore.setState((state) => ({
          lanShare: {
            ...state.lanShare,
            snapshot: {
              ...offSnapshotWithBook,
              status: { state: 'listening', failedAttempts: 0, maxFailedAttempts: 5 },
              address: '192.168.1.42:49319',
            },
          },
          refreshLanShareStatus: vi.fn(async () => ({
            ...offSnapshotWithBook,
            status: { state: 'listening' as const, failedAttempts: 0, maxFailedAttempts: 5 },
            address: '192.168.1.42:49319',
          })),
        }));
      });

      fireEvent.click(screen.getByTestId('lan-share-indicator'));
      expect(await screen.findByTestId('lan-share-dialog')).toBeInTheDocument();

      // Wait past useNativeMenu's 16ms debounce and confirm menu items were disabled.
      await waitFor(() => {
        const disabledCalls = setMenuItemStates.mock.calls.flatMap((args) => args[0]);
        expect(disabledCalls).toContainEqual({ id: 'file.closeTab', enabled: false });
        expect(disabledCalls).toContainEqual({ id: 'file.open', enabled: false });
        expect(disabledCalls).toContainEqual({ id: 'bookmarks.toggle', enabled: false });
        expect(disabledCalls).toContainEqual({ id: 'view.immersive', enabled: false });
      });

      // Fire BOTH DOM shortcuts and native menu `onMenuCommand` events while modal is open.
      for (const init of [
        { key: 'w', code: 'KeyW', metaKey: true },
        { key: 'o', code: 'KeyO', metaKey: true },
        { key: 'd', code: 'KeyD', metaKey: true },
        { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true },
      ]) {
        fireEvent.keyDown(window, init);
      }
      act(() => {
        emitMenuCommand?.('file.closeTab');
        emitMenuCommand?.('file.open');
        emitMenuCommand?.('bookmarks.toggle');
        emitMenuCommand?.('view.immersive');
      });

      // Background state stayed completely untouched.
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(useStudySyncStore.getState().openDocumentIds).toEqual([activeDocId]);
      expect(openDocSpy).not.toHaveBeenCalled();
      expect(toggleBookmarkSpy).not.toHaveBeenCalled();
      expect(useStudySyncStore.getState().immersive).toBe(false);

      // Modal inputs still allow typing and clipboard shortcuts when not active-listening.
      await act(async () => {
        useStudySyncStore.setState((state) => ({
          lanShare: { ...state.lanShare, snapshot: { ...INITIAL_LAN_SHARE_SNAPSHOT } },
          refreshLanShareStatus: vi.fn(async () => ({ ...INITIAL_LAN_SHARE_SNAPSHOT })),
        }));
      });
      fireEvent.click(screen.getByTestId('lan-share-scope-selected'));
      const searchInput = await screen.findByTestId('lan-share-book-search');
      searchInput.focus();
      const copyEvent = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      searchInput.dispatchEvent(copyEvent);
      expect(copyEvent.defaultPrevented).toBe(false);

      // Close modal -> native menu re-enables and commands work again.
      setMenuItemStates.mockClear();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('lan-share-dialog')).not.toBeInTheDocument();

      await waitFor(() => {
        const reenabled = setMenuItemStates.mock.calls.flatMap((args) => args[0]);
        expect(reenabled).toContainEqual({ id: 'file.closeTab', enabled: true });
        expect(reenabled).toContainEqual({ id: 'file.open', enabled: true });
      });

      act(() => {
        emitMenuCommand?.('file.closeTab');
      });
      await waitFor(() => {
        expect(useStudySyncStore.getState().openDocumentIds).toHaveLength(0);
      });
    });

    it('exposes both File menu LAN sync commands atomically and opens both dialogs (#149)', async () => {
      const fileMenu = MENUS.find((menu) => menu.id === 'file');
      expect(fileMenu?.items).toContain('file.shareOnNetwork');
      expect(fileMenu?.items).toContain('file.importFromDevice');

      await renderReady();

      expect(commandState('file.shareOnNetwork').enabled).toBe(true);
      expect(commandState('file.importFromDevice').enabled).toBe(true);

      act(() => {
        expect(runCommand('file.shareOnNetwork', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-share-dialog')).toBeInTheDocument();

      // Modal dialog lock prevents menu commands while Share modal is open (#168).
      expect(commandState('file.importFromDevice').enabled).toBe(false);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('lan-share-dialog')).not.toBeInTheDocument();

      act(() => {
        expect(runCommand('file.importFromDevice', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-import-dialog')).toBeInTheDocument();
    });
  });

  describe('Import-to-Share switch guard across async phases (#170)', () => {
    let unbindStore: (() => void) | null = null;

    afterEach(() => {
      unbindStore?.();
      unbindStore = null;
      vi.useRealTimers();
      vi.restoreAllMocks();
      useStudySyncStore.setState(initialState, true);
      document.body.innerHTML = '';
    });

    function createDeferred<T = void>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function bindWorkspaceStore(backend: StudyBackend) {
      unbindStore?.();
      const temp = createStudySyncStore(backend);
      useStudySyncStore.setState(temp.getState(), true);
      unbindStore = temp.subscribe((next) => {
        useStudySyncStore.setState(next);
      });
      return temp;
    }

    function assertShareBlocked(
      emitMenuCommand: (id: 'file.shareOnNetwork') => void,
      disconnectSpy: { mock: { calls: unknown[] } },
    ) {
      const disconnectsBefore = disconnectSpy.mock.calls.length;
      expect(commandState('file.shareOnNetwork').enabled).toBe(false);
      expect(runCommand('file.shareOnNetwork', 'menu')).toBe(false);
      act(() => {
        emitMenuCommand('file.shareOnNetwork');
      });
      const toolbarIndicator = screen.getByTestId('lan-share-indicator');
      expect(toolbarIndicator).toBeDisabled();
      fireEvent.click(toolbarIndicator);
      expect(screen.queryByTestId('lan-share-dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('lan-import-dialog')).toBeInTheDocument();
      expect(disconnectSpy).toHaveBeenCalledTimes(disconnectsBefore);
    }

    it('rejects switching to Share via native menu or indicator across connect, catalog, plan, cursor flush, and execute', async () => {
      const preview = createMemoryBackendWithPreview();
      const store = bindWorkspaceStore(preview.backend);

      const disconnectSpy = vi.spyOn(preview.backend, 'lanImportDisconnect');

      const connectGate = createDeferred();
      const origConnect = preview.backend.lanImportConnect.bind(preview.backend);
      vi.spyOn(preview.backend, 'lanImportConnect').mockImplementationOnce(async (input) => {
        await connectGate.promise;
        return origConnect(input);
      });

      await renderReady();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByRole('tab')).toBeInTheDocument();
      const activeId = useStudySyncStore.getState().activeDocumentId;
      const sampleDoc = useStudySyncStore.getState().documents.find((doc) => doc.id === activeId);
      if (!sampleDoc) {
        throw new Error('Expected open document after clicking Open');
      }
      await preview.backend.lanShareStart({
        documentIds: [sampleDoc.id],
        positions: true,
        bookmarks: true,
      });
      const sharedBytes = new TextEncoder().encode('LAN switch guard sample text');
      preview.lan.setBooks([
        {
          bookId: sampleDoc.fileHash,
          title: sampleDoc.title,
          format: sampleDoc.format,
          extension: 'txt',
          bytes: sharedBytes,
          fileAvailable: true,
          position: { anchor: SAMPLE_ANCHOR[sampleDoc.format], progress: 0.72 },
          bookmarks: [{ anchor: SAMPLE_ANCHOR[sampleDoc.format], label: 'Peer note' }],
        },
      ]);
      await store.getState().refreshLanShareStatus();
      expect(screen.getByTestId('lan-share-indicator')).toBeEnabled();

      // 1. Connecting stage blocked while `lanImportConnect` is pending.
      act(() => {
        expect(runCommand('file.importFromDevice', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-import-dialog')).toBeInTheDocument();
      fireEvent.change(screen.getByTestId('lan-import-address-input'), {
        target: { value: '192.168.1.42' },
      });
      fireEvent.change(screen.getByTestId('lan-import-code-input'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
      await waitFor(() => {
        expect(useStudySyncStore.getState().lanImport.phase).toBe('connecting');
      });
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);

      // 2. Paired Catalog stage (both idle and while a slow refresh is pending).
      await act(async () => {
        connectGate.resolve();
      });
      await screen.findByTestId('lan-import-catalog-list');
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);

      const catalogGate = createDeferred();
      const origCatalog = preview.backend.lanImportCatalog.bind(preview.backend);
      vi.spyOn(preview.backend, 'lanImportCatalog').mockImplementationOnce(async (sessionId) => {
        await catalogGate.promise;
        return origCatalog(sessionId);
      });
      fireEvent.click(screen.getByTestId('lan-import-catalog-refresh'));
      await waitFor(() => {
        expect(screen.getByTestId('lan-import-catalog-refresh')).toBeDisabled();
      });
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);
      await act(async () => {
        catalogGate.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('lan-import-catalog-refresh')).toBeEnabled();
      });

      // 3. Planning stage blocked while `lanImportPlan` is pending.
      const planGate = createDeferred();
      const origPlan = preview.backend.lanImportPlan.bind(preview.backend);
      vi.spyOn(preview.backend, 'lanImportPlan').mockImplementationOnce(
        async (input, onProgress) => {
          await planGate.promise;
          return origPlan(input, onProgress);
        },
      );
      const catalogCheckbox = screen.getByTestId(
        `lan-import-catalog-checkbox-${sampleDoc.fileHash}`,
      );
      expect(catalogCheckbox).toBeEnabled();
      fireEvent.click(catalogCheckbox);
      expect(catalogCheckbox).toBeChecked();
      const reviewButton = screen.getByTestId('lan-import-review');
      expect(reviewButton).toBeEnabled();
      fireEvent.click(reviewButton);
      await waitFor(() => {
        expect(useStudySyncStore.getState().lanImport.phase).toBe('planning');
      });
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);
      await act(async () => {
        planGate.resolve();
      });
      await screen.findByTestId('lan-import-start-execute');

      // 4. Closing open tab + flushing pending `updateDocumentCursor` write before `execute`.
      const posCheckbox = screen.getByTestId(
        `lan-import-position-checkbox-${sampleDoc.fileHash}`,
      ) as HTMLInputElement;
      expect(posCheckbox.closest('label')).toHaveTextContent('Close and use source position');
      if (!posCheckbox.checked) {
        fireEvent.click(posCheckbox);
      }
      expect(posCheckbox).toBeChecked();

      const cursorGate = createDeferred();
      const origUpdateCursor = preview.backend.updateDocumentCursor.bind(preview.backend);
      vi.spyOn(preview.backend, 'updateDocumentCursor').mockImplementationOnce(
        async (docId, anchor, progress) => {
          await cursorGate.promise;
          return origUpdateCursor(docId, anchor, progress);
        },
      );
      const executeGate = createDeferred();
      const origExecute = preview.backend.lanImportExecute.bind(preview.backend);
      const executeSpy = vi
        .spyOn(preview.backend, 'lanImportExecute')
        .mockImplementationOnce(async (input, onProgress) => {
          await executeGate.promise;
          return origExecute(input, onProgress);
        });

      act(() => {
        useStudySyncStore
          .getState()
          .reportCursor(sampleDoc.id, SAMPLE_ANCHOR[sampleDoc.format], 0.12);
      });
      fireEvent.click(screen.getByTestId('lan-import-start-execute'));
      await waitFor(() => {
        expect(useStudySyncStore.getState().openDocumentIds).not.toContain(sampleDoc.id);
      });
      expect(executeSpy).not.toHaveBeenCalled();
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);

      // 5. Importing stage blocked while `lanImportExecute` is pending.
      await act(async () => {
        cursorGate.resolve();
      });
      await waitFor(() => {
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(useStudySyncStore.getState().lanImport.phase).toBe('importing');
      });
      assertShareBlocked(preview.emitMenuCommand, disconnectSpy);

      await act(async () => {
        executeGate.resolve();
      });
      await screen.findByTestId('lan-import-results');

      // Clean exit disconnects once and restores Share access.
      fireEvent.click(screen.getByTestId('lan-import-done'));
      await waitFor(() => {
        expect(screen.queryByTestId('lan-import-dialog')).not.toBeInTheDocument();
      });
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(commandState('file.shareOnNetwork').enabled).toBe(true);
      expect(screen.getByTestId('lan-share-indicator')).toBeEnabled();

      act(() => {
        expect(runCommand('file.shareOnNetwork', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-share-dialog')).toBeInTheDocument();
    });

    it('calls disconnect once and prevents late connect/catalog responses from reviving an exited session', async () => {
      const preview = createMemoryBackendWithPreview();
      bindWorkspaceStore(preview.backend);

      const disconnectSpy = vi.spyOn(preview.backend, 'lanImportDisconnect');
      const connectResultGate =
        createDeferred<Awaited<ReturnType<StudyBackend['lanImportConnect']>>>();
      const catalogResultGate =
        createDeferred<Awaited<ReturnType<StudyBackend['lanImportCatalog']>>>();

      const origConnect = preview.backend.lanImportConnect.bind(preview.backend);
      const origCatalog = preview.backend.lanImportCatalog.bind(preview.backend);

      await renderReady();

      // Case A: Slow `lanImportConnect` finishes after user cancels and closes Import to open Share.
      vi.spyOn(preview.backend, 'lanImportConnect').mockImplementationOnce(async (input) => {
        const realSession = await origConnect(input);
        return await connectResultGate.promise.then(() => realSession);
      });
      act(() => {
        expect(runCommand('file.importFromDevice', 'menu')).toBe(true);
      });
      fireEvent.change(await screen.findByTestId('lan-import-address-input'), {
        target: { value: '192.168.1.42' },
      });
      fireEvent.change(screen.getByTestId('lan-import-code-input'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
      await waitFor(() => {
        expect(useStudySyncStore.getState().lanImport.phase).toBe('connecting');
      });

      fireEvent.click(screen.getByTestId('lan-import-connect-cancel'));
      fireEvent.click(screen.getByRole('button', { name: 'Close Import from Another Device' }));
      await waitFor(() => {
        expect(screen.queryByTestId('lan-import-dialog')).not.toBeInTheDocument();
      });

      act(() => {
        expect(runCommand('file.shareOnNetwork', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-share-dialog')).toBeInTheDocument();

      await act(async () => {
        connectResultGate.resolve({
          sessionId: 'stale-session',
          address: '192.168.1.42:49319',
          idleTimeoutSeconds: 600,
          permissions: { positions: true, bookmarks: true },
        });
      });
      // Late connect resolution must neither revive UI state nor leak an orphaned source session.
      expect(useStudySyncStore.getState().lanImport.session).toBeNull();
      expect(useStudySyncStore.getState().lanImport.phase).toBe('idle');
      await waitFor(() => {
        expect(disconnectSpy).toHaveBeenCalledTimes(1);
      });

      const shareDialog = screen.getByTestId('lan-share-dialog');
      fireEvent.click(within(shareDialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByTestId('lan-share-dialog')).not.toBeInTheDocument();
      });

      // Case B: Paired catalog refresh in flight when user closes Import; late catalog cannot revive session.
      disconnectSpy.mockClear();
      act(() => {
        expect(runCommand('file.importFromDevice', 'menu')).toBe(true);
      });
      fireEvent.change(await screen.findByTestId('lan-import-address-input'), {
        target: { value: '192.168.1.42' },
      });
      fireEvent.change(screen.getByTestId('lan-import-code-input'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByTestId('lan-import-connect-submit'));
      await screen.findByTestId('lan-import-catalog-list');

      let slowCatalogSessionId = '';
      vi.spyOn(preview.backend, 'lanImportCatalog').mockImplementationOnce(async (sessionId) => {
        slowCatalogSessionId = sessionId;
        const realBooks = await origCatalog(sessionId);
        return await catalogResultGate.promise.then(() => realBooks);
      });
      fireEvent.click(screen.getByTestId('lan-import-catalog-refresh'));
      await waitFor(() => {
        expect(slowCatalogSessionId).not.toBe('');
      });

      const dialog = screen.getByTestId('lan-import-dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByTestId('lan-import-dialog')).not.toBeInTheDocument();
      });
      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      act(() => {
        expect(runCommand('file.shareOnNetwork', 'menu')).toBe(true);
      });
      expect(await screen.findByTestId('lan-share-dialog')).toBeInTheDocument();

      await act(async () => {
        catalogResultGate.resolve([]);
      });
      expect(useStudySyncStore.getState().lanImport.session).toBeNull();
      expect(useStudySyncStore.getState().lanImport.catalog).toEqual([]);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('promotes an existing highlight via viewer callback and opens a collapsed MindMap on Show in MindMap (#124)', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));

    const annotation = await act(async () =>
      useStudySyncStore.getState().createAnnotationFromSelection({ note: 'Highlight note' }),
    );
    expect(annotation).not.toBeNull();
    const countBefore = useStudySyncStore.getState().annotations.length;

    // MindMap starts collapsed; promoting shows the post-excerpt notice and creates one card.
    fireEvent.click(await screen.findByRole('button', { name: `Promote ${annotation!.id}` }));
    await waitFor(() => {
      expect(
        useStudySyncStore.getState().cards.some((c) => c.annotationIds.includes(annotation!.id)),
      ).toBe(true);
    });
    expect(useStudySyncStore.getState().annotations).toHaveLength(countBefore);
    const card = useStudySyncStore
      .getState()
      .cards.find((c) => c.annotationIds.includes(annotation!.id))!;
    expect(card.markdownNotes).toBe('Highlight note');
    expect(screen.getByTestId('excerpt-added-notice')).toBeInTheDocument();

    // Dismiss the notice; MindMap is still collapsed.
    fireEvent.click(
      within(screen.getByTestId('excerpt-added-notice')).getByRole('button', {
        name: 'Close notice',
      }),
    );
    expect(screen.getByRole('button', { name: 'Show MindMap' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Clicking Show in MindMap opens the collapsed MindMap and selects the card without flashing the added notice.
    fireEvent.click(screen.getByRole('button', { name: `Show card ${annotation!.id}` }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide MindMap' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(screen.queryByTestId('excerpt-added-notice')).toBeNull();
    const expectedNode = useStudySyncStore.getState().nodes.find((n) => n.cardId === card.id)!;
    expect(useStudySyncStore.getState().selectedNodeId).toBe(expectedNode.id);
  });
});
