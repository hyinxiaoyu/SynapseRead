import { act, render, screen } from '@testing-library/react';
import { type NodeProps, ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { InspectorPane } from '@/features/inspector/InspectorPane';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

import { type CardFlowNode, CardNode } from './CardNode';

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

function renderCard(nodeId: string, cardId: string) {
  // Only what CardNode reads; React Flow supplies the rest on a real canvas.
  const props = { id: nodeId, data: { cardId }, selected: false } as NodeProps<CardFlowNode>;
  render(
    <ReactFlowProvider>
      <CardNode {...props} />
      <InspectorPane />
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
