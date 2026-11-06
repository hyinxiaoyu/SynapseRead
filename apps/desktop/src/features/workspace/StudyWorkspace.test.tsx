import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { AnchorLocation, DocumentFormat, DocumentViewerProps } from '@/types/domain';

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
}: DocumentViewerProps) {
  const [localState, setLocalState] = useState(0);
  const pulsing = jumpRequest?.annotationId;
  useEffect(() => {
    if (!jumpRequest) return;
    const timer = window.setTimeout(() => onJumpHandled(jumpRequest.nonce), 1000);
    return () => window.clearTimeout(timer);
  }, [jumpRequest, onJumpHandled]);
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
          />
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
    useStudySyncStore.setState(initialState, true);
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

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    expect(excerpt).toBeEnabled();
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

  it('pulses the source highlight on a jump, then completes it', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    const highlights = await screen.findByRole('region', { name: 'Highlights' });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Jump to this excerpt' }));
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
    expect(screen.getByRole('status', { name: 'Drop files to open' })).toBeInTheDocument();

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
});
