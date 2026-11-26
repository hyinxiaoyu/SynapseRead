import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type NodeProps, ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectorPane } from '@/features/inspector/InspectorPane';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

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
    const jump = () => screen.queryByRole('button', { name: `Jump to source of ${card?.title}` });
    expect(jump()).not.toBeNull();
    expect(screen.queryByTestId('card-source-removed')).toBeNull();
    expect(screen.queryByTestId('inspector-source-removed')).toBeNull();

    await act(() => state().removeAnnotation(card?.annotationIds[0] as string));
    expect(jump()).toBeNull();
    expect(screen.getByTestId('card-source-removed')).toHaveTextContent('Source removed');
    expect(screen.getByTestId('inspector-source-removed')).toBeVisible();

    await act(() => state().undoRemoveAnnotation());
    expect(jump()).not.toBeNull();
    expect(screen.queryByTestId('card-source-removed')).toBeNull();
    // The inspector lists the excerpt again, beside the card's own title.
    expect(screen.getByRole('button', { name: 'Jump to this excerpt' })).toBeVisible();
    expect(screen.getAllByText('The card source')).toHaveLength(2);
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
