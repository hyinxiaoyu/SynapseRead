import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type NodeProps, ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectorPane } from '@/features/inspector/InspectorPane';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import { createStudySyncStore, useStudySyncStore } from '@/stores/useStudySyncStore';

import { type CardFlowNode, CardNode, summarizeMarkdownNotes } from './CardNode';

const initialState = useStudySyncStore.getState();
const state = () => useStudySyncStore.getState();

/** Excerpts a TXT selection and returns the new card's node and card ids. */
async function excerpt() {
  await state().initialize();
  await state().openDocument();
  const document = state().documents.find(({ id }) => id === state().activeDocumentId);
  if (document?.format !== 'txt')
    throw new Error(`expected a TXT preview, got ${document?.format}`);
  state().setSelection({
    documentId: document.id,
    anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
    text: 'The card source',
    imagePng: null,
    locationLabel: 'Line 1',
  });
  await state().excerptSelection();
  const node = state().nodes.at(-1);
  if (!node) throw new Error('no card was made');
  state().selectNode(node.id);
  return { nodeId: node.id, cardId: node.cardId };
}

function renderCard(nodeId: string, cardId: string, withInspector = true) {
  // Only what CardNode reads; React Flow supplies the rest on a real canvas.
  const props = { id: nodeId, data: { cardId }, selected: false } as NodeProps<CardFlowNode>;
  render(
    <ReactFlowProvider>
      <CardNode {...props} />
      {withInspector && <InspectorPane />}
    </ReactFlowProvider>,
  );
}

// #97: a card whose highlight was deleted says so, and Undo gives its link back.
describe('CardNode source', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
  });

  it('shows Source removed after its highlight is deleted, and relinks on Undo', async () => {
    const { nodeId, cardId } = await excerpt();
    renderCard(nodeId, cardId);
    const card = state().cards.find((candidate) => candidate.id === cardId);
    const expectedSource = 'sample · Line 1';
    const jump = () =>
      screen.queryByRole('button', {
        name: `Jump to source of ${card?.title} (${expectedSource})`,
      });
    expect(jump()).not.toBeNull();
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent(expectedSource);
    expect(screen.queryByTestId('card-source-removed')).toBeNull();
    expect(screen.queryByTestId('inspector-source-removed')).toBeNull();

    await act(() => state().removeAnnotation(card?.annotationIds[0] as string));
    expect(jump()).toBeNull();
    expect(screen.queryByTestId('card-source-attribution')).toBeNull();
    expect(screen.getByTestId('card-source-removed')).toHaveTextContent('Source removed');
    expect(screen.getByTestId('inspector-source-removed')).toBeVisible();

    await act(() => state().undoRemoveAnnotation());
    expect(jump()).not.toBeNull();
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent(expectedSource);
    expect(screen.queryByTestId('card-source-removed')).toBeNull();
    // The inspector lists the excerpt again, beside the card's own title.
    expect(
      screen.getByRole('button', { name: `Jump to this excerpt (${expectedSource})` }),
    ).toBeVisible();
    expect(screen.getAllByText('The card source')).toHaveLength(2);
  });

  it('shows truncated document title and location on the card face, and stays current after displayTitle or relink updates (#125)', () => {
    useStudySyncStore.setState({
      documents: [
        {
          id: 'doc-1',
          title: 'kahneman-2011',
          displayTitle: 'Thinking, Fast and Slow',
          filePath: '/books/kahneman-2011.pdf',
          fileHash: 'hash-1',
          format: 'pdf',
          encoding: 'utf-8',
          lastCursorAnchor: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      annotations: [
        {
          id: 'ann-1',
          documentId: 'doc-1',
          notebookId: 'nb-1',
          anchor: {
            format: 'pdf',
            pageIndex: 40,
            rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.1 }],
          },
          excerptText: 'System 1 operates automatically',
          excerptImagePath: null,
          note: null,
          color: '#fde047',
          style: 'highlight',
          locationLabel: 'Ch. 3 · p. 41',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cards: [
        {
          id: 'card-1',
          notebookId: 'nb-1',
          title: 'System 1 operates automatically',
          markdownNotes: '',
          tags: [],
          annotationIds: ['ann-1'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      nodes: [
        {
          id: 'node-1',
          notebookId: 'nb-1',
          cardId: 'card-1',
          parentNodeId: null,
          posX: 0,
          posY: 0,
          isCollapsed: false,
          style: null,
        },
      ],
    });
    renderCard('node-1', 'card-1', false);

    const source = screen.getByTestId('card-source-attribution');
    expect(source).toHaveTextContent('Thinking, Fast and Slow · Ch. 3 · p. 41');
    expect(source).toHaveAttribute('title', 'Thinking, Fast and Slow · Ch. 3 · p. 41');
    expect(source.className).toContain('truncate');
    expect(source.className).toContain('text-muted-foreground');
    expect(
      screen.getByRole('button', {
        name: 'Jump to source of System 1 operates automatically (Thinking, Fast and Slow · Ch. 3 · p. 41)',
      }),
    ).toBeVisible();

    // Relinking/renaming the document updates the card attribution live.
    act(() => {
      useStudySyncStore.setState((current) => ({
        documents: current.documents.map((doc) =>
          doc.id === 'doc-1' ? { ...doc, title: 'relinked-edition', displayTitle: null } : doc,
        ),
      }));
    });
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent(
      'relinked-edition · Ch. 3 · p. 41',
    );
  });

  it('renders older annotations without locationLabel showing at least the document title (#125)', () => {
    useStudySyncStore.setState({
      documents: [
        {
          id: 'doc-legacy',
          title: 'legacy-notes',
          displayTitle: null,
          filePath: '/books/legacy-notes.txt',
          fileHash: 'hash-legacy',
          format: 'txt',
          encoding: 'utf-8',
          lastCursorAnchor: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      annotations: [
        {
          id: 'ann-legacy',
          documentId: 'doc-legacy',
          notebookId: 'nb-1',
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 10, lineIndex: 5 },
          excerptText: 'Older excerpt',
          excerptImagePath: null,
          note: null,
          color: '#fde047',
          style: 'highlight',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cards: [
        {
          id: 'card-legacy',
          notebookId: 'nb-1',
          title: 'Older excerpt',
          markdownNotes: '',
          tags: [],
          annotationIds: ['ann-legacy'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderCard('node-legacy', 'card-legacy', false);

    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent('legacy-notes');
    expect(
      screen.getByRole('button', { name: 'Jump to source of Older excerpt (legacy-notes)' }),
    ).toBeVisible();
  });

  it('immediately clears stale location on content-changing relink across CardNode, Inspector, reopen, and Undo (#125)', async () => {
    const originalBytes = new TextEncoder().encode('Old chapter\nFirst claim\nSecond claim\n');
    const revisedBytes = new TextEncoder().encode('Revised document without the old chapter.\n');
    const customBackend = createMemoryBackend({
      library: {
        '/books/original.txt': originalBytes,
        '/books/renamed.txt': originalBytes,
        '/books/revised.txt': revisedBytes,
      },
    });
    const customStore = createStudySyncStore(customBackend);
    await customStore.getState().initialize();
    await customStore.getState().openDocument();
    const docId = customStore.getState().activeDocumentId as string;

    customStore.getState().setSelection({
      documentId: docId,
      anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 11, lineIndex: 0 },
      text: 'Old chapter',
      imagePng: null,
      locationLabel: 'Old chapter · Line 1',
    });
    await customStore.getState().excerptSelection();
    const firstNode = customStore.getState().nodes[0]!;
    customStore.getState().selectNode(firstNode.id);

    const syncGlobal = (source = customStore) => {
      const s = source.getState();
      useStudySyncStore.setState({
        documents: s.documents,
        annotations: s.annotations,
        cards: s.cards,
        nodes: s.nodes,
        selectedNodeId: s.selectedNodeId,
      });
    };
    syncGlobal();

    renderCard(firstNode.id, firstNode.cardId, true);
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent(
      'original · Old chapter · Line 1',
    );
    expect(screen.getByTestId('inspector-excerpt-source')).toHaveTextContent(
      'original · Old chapter · Line 1',
    );

    // Same-hash relink (rename) keeps location intact with the new title.
    await act(async () => {
      await customStore.getState().relinkDocument(docId, false);
      syncGlobal();
    });
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent(
      'renamed · Old chapter · Line 1',
    );
    expect(screen.getByTestId('inspector-excerpt-source')).toHaveTextContent(
      'renamed · Old chapter · Line 1',
    );

    // Content-changing relink immediately drops the stale location everywhere.
    await act(async () => {
      await customStore.getState().relinkDocument(docId, false);
      syncGlobal();
    });
    expect(screen.getByTestId('card-source-attribution')).toHaveTextContent('revised');
    expect(screen.getByTestId('card-source-attribution').textContent).not.toContain('Old chapter');
    expect(screen.getByTestId('inspector-excerpt-source')).toHaveTextContent('revised');
    expect(
      screen.getByRole('button', { name: 'Jump to source of Old chapter (revised)' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Jump to this excerpt (revised)' })).toBeVisible();
  });
});

// #118: card faces show notes previews, tags with +N overflow, and capture thumbnails.
describe('CardNode face content (#118)', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
  });

  it('shows a clamped plain-text preview of Markdown notes and tag chips with +N overflow', () => {
    useStudySyncStore.setState({
      cards: [
        {
          id: 'card-1',
          notebookId: 'nb-1',
          title: 'Quick brown fox',
          markdownNotes: '## Key idea\n\n**Foxes** are [very quick](https://example.com) animals.',
          tags: ['animals', 'speed', 'biology', 'mammals', 'extra'],
          annotationIds: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      nodes: [
        {
          id: 'node-1',
          notebookId: 'nb-1',
          cardId: 'card-1',
          parentNodeId: null,
          posX: 0,
          posY: 0,
          isCollapsed: false,
          style: null,
        },
      ],
    });
    renderCard('node-1', 'card-1', false);

    const preview = screen.getByTestId('card-notes-preview');
    expect(preview).toHaveTextContent('Key idea Foxes are very quick animals.');
    expect(preview.className).toContain('line-clamp-2');

    const tags = screen.getByTestId('card-tags');
    expect(tags).toHaveTextContent('animals');
    expect(tags).toHaveTextContent('speed');
    expect(tags).toHaveTextContent('biology');
    expect(tags).not.toHaveTextContent('mammals');
    expect(screen.getByTestId('card-tags-overflow')).toHaveTextContent('+2');
  });

  it('omits notes preview and tags when empty', () => {
    useStudySyncStore.setState({
      cards: [
        {
          id: 'card-empty',
          notebookId: 'nb-1',
          title: 'Plain excerpt',
          markdownNotes: '   \n  ',
          tags: [],
          annotationIds: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderCard('node-empty', 'card-empty', false);

    expect(screen.queryByTestId('card-notes-preview')).toBeNull();
    expect(screen.queryByTestId('card-tags')).toBeNull();
  });

  it('renders a capture thumbnail lazily inside a fixed-height slot across loading, loaded, and fallback states', async () => {
    let resolveCapture: (url: string | null) => void = () => {};
    const captureUrl = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    useStudySyncStore.setState({
      captureUrl,
      annotations: [
        {
          id: 'ann-img',
          documentId: 'doc-1',
          notebookId: 'nb-1',
          anchor: {
            format: 'pdf',
            pageIndex: 0,
            rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.3 }],
          },
          excerptText: null,
          excerptImagePath: 'captures/ann-img.png',
          note: null,
          color: '#fde047',
          style: 'highlight',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cards: [
        {
          id: 'card-img',
          notebookId: 'nb-1',
          title: 'Image excerpt',
          markdownNotes: '',
          tags: [],
          annotationIds: ['ann-img'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderCard('node-img', 'card-img', false);

    // Loading state already reserves the fixed h-24 thumbnail slot (#128).
    const loadingSlot = screen.getByTestId('card-capture-slot');
    expect(loadingSlot).toHaveAttribute('aria-busy', 'true');
    expect(loadingSlot.className).toContain('h-24');

    act(() => resolveCapture('data:image/png;base64,iVBORw0KGgo='));
    const img = await screen.findByTestId('card-capture-thumbnail');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img.className).toContain('object-contain');
    expect(screen.getByTestId('card-capture-slot').className).toContain('h-24');

    // A broken image URL falls back gracefully inside the same fixed-height slot.
    fireEvent.error(img);
    expect(screen.getByTestId('card-capture-fallback')).toHaveTextContent('Capture unavailable');
    expect(screen.getByTestId('card-capture-slot').className).toContain('h-24');
  });

  it('falls back gracefully when captureUrl rejects or returns null', async () => {
    useStudySyncStore.setState({
      captureUrl: vi.fn(async () => null),
      annotations: [
        {
          id: 'ann-missing',
          documentId: 'doc-1',
          notebookId: 'nb-1',
          anchor: {
            format: 'pdf',
            pageIndex: 0,
            rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.3 }],
          },
          excerptText: null,
          excerptImagePath: 'captures/ann-missing.png',
          note: null,
          color: '#fde047',
          style: 'highlight',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cards: [
        {
          id: 'card-missing',
          notebookId: 'nb-1',
          title: 'Image excerpt',
          markdownNotes: '',
          tags: [],
          annotationIds: ['ann-missing'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderCard('node-missing', 'card-missing', false);

    await waitFor(() =>
      expect(screen.getByTestId('card-capture-fallback')).toHaveTextContent('Capture unavailable'),
    );
  });

  it('flattens Markdown formatting cleanly', () => {
    expect(summarizeMarkdownNotes('> - **Bold** and `code`')).toBe('Bold and code');
  });
});
