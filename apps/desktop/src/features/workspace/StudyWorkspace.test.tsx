import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetRecentCommandRuns } from '@/features/commands/registry';
import type { MenuItemState } from '@/lib/backend/types';
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
    for (const id of [...useStudySyncStore.getState().openDocumentIds]) {
      useStudySyncStore.getState().closeDocument(id);
    }
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
});
