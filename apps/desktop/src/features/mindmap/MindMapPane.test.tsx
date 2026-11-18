import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { MindMapNode, NoteCard, StudyNotebook } from '@/types/domain';

import { MindMapPane } from './MindMapPane';

const initialState = useStudySyncStore.getState();
const PANE = { width: 800, height: 600 };

const notebook: StudyNotebook = {
  id: 'notebook',
  title: 'Notebook',
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: '2026-01-01T00:00:00Z',
};

const card = (id: string): NoteCard => ({
  id: `card-${id}`,
  notebookId: notebook.id,
  title: `Card ${id}`,
  markdownNotes: '',
  tags: [],
  annotationIds: [],
  createdAt: '2026-01-01T00:00:00Z',
});

const node = (id: string, posX: number, posY: number): MindMapNode => ({
  id,
  notebookId: notebook.id,
  cardId: `card-${id}`,
  parentNodeId: null,
  posX,
  posY,
  isCollapsed: false,
  style: null,
});

/** The viewport transform React Flow applies to its content. */
const viewportTransform = () =>
  (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform;
const panned = (x: number, y: number) => `translate(${x}px,${y}px) scale(1)`;
const UNMOVED = panned(0, 0);
/** A 240 x 96 card at (2000, 1500), centered in the 800 x 600 pane at zoom 1. */
const CENTERED_FAR = panned(400 - (2000 + 120), 300 - (1500 + 48));

const cardElement = (id: string) =>
  document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

function seed(nodes: MindMapNode[], extra: Partial<ReturnType<typeof useStudySyncStore.getState>>) {
  useStudySyncStore.setState({
    notebook,
    nodes,
    cards: nodes.map((candidate) => card(candidate.id)),
    edges: [],
    ...extra,
  });
}

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: reduce && query.includes('reduce'), media: query })),
  );
}

describe('MindMapPane', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
    useStudySyncStore.setState({ saveViewport: vi.fn(async () => {}) });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const size = this.classList.contains('react-flow') ? PANE : { width: 0, height: 0 };
      return DOMRect.fromRect({ x: 0, y: 0, ...size });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('nesting target (#96)', () => {
    it('clears the nesting target on a click on empty canvas', () => {
      seed([node('a', 40, 40)], { selectedNodeId: 'a', nestingTargetNodeId: 'a' });
      render(<MindMapPane open />);

      fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement);

      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      expect(useStudySyncStore.getState().selectedNodeId).toBeNull();
    });

    it('clears the nesting target on Esc on the canvas, but not on Esc elsewhere', () => {
      // An excerpt selected `b`; the reader chose `a` earlier.
      seed([node('a', 40, 40), node('b', 400, 40)], {
        selectedNodeId: 'b',
        nestingTargetNodeId: 'a',
      });
      render(
        <>
          <MindMapPane open />
          <button type="button">Elsewhere</button>
        </>,
      );

      fireEvent.keyDown(screen.getByRole('button', { name: 'Elsewhere' }), { key: 'Escape' });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');

      fireEvent.keyDown(document.querySelector('.react-flow__pane') as HTMLElement, {
        key: 'Escape',
      });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      expect(useStudySyncStore.getState().selectedNodeId).toBeNull();
    });

    it('clears the nesting target on Esc on a card React Flow would select instead', () => {
      seed([node('a', 40, 40), node('b', 400, 40)], {
        selectedNodeId: 'b',
        nestingTargetNodeId: 'b',
      });
      render(<MindMapPane open />);

      // React Flow's own Esc selects a focused card that is not selected.
      fireEvent.keyDown(cardElement('a'), { key: 'Escape' });

      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      expect(useStudySyncStore.getState().selectedNodeId).toBeNull();
    });

    it('makes a click on the card an excerpt selected the nesting target', () => {
      seed([node('a', 40, 40)], { selectedNodeId: 'a', nestingTargetNodeId: null });
      render(<MindMapPane open />);

      fireEvent.click(cardElement('a'));

      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
      expect(useStudySyncStore.getState().selectedNodeId).toBe('a');
    });
  });

  describe('revealing a new card (#98)', () => {
    it('brings an off-screen card into view, at once under reduced motion', () => {
      mockReducedMotion(true);
      seed([node('far', 2000, 1500)], {
        selectedNodeId: 'far',
        revealRequest: { nonce: 1, nodeId: 'far' },
      });
      render(<MindMapPane open />);

      expect(viewportTransform()).toBe(CENTERED_FAR);
      expect(useStudySyncStore.getState().revealRequest).toBeNull();
    });

    it('animates the pan when motion is allowed', async () => {
      mockReducedMotion(false);
      seed([node('far', 2000, 1500)], { revealRequest: { nonce: 1, nodeId: 'far' } });
      render(<MindMapPane open />);

      expect(viewportTransform()).toBe(UNMOVED);
      await vi.waitFor(() => expect(viewportTransform()).toBe(CENTERED_FAR));
    });

    it('leaves the canvas alone when the new card is already in view', () => {
      mockReducedMotion(true);
      seed([node('near', 100, 100)], { revealRequest: { nonce: 1, nodeId: 'near' } });
      render(<MindMapPane open />);

      expect(viewportTransform()).toBe(UNMOVED);
      expect(useStudySyncStore.getState().revealRequest).toBeNull();
    });

    it('waits while the pane is collapsed, and reveals once it opens', () => {
      mockReducedMotion(true);
      seed([node('far', 2000, 1500)], { revealRequest: { nonce: 1, nodeId: 'far' } });
      const { rerender } = render(<MindMapPane open={false} />);

      expect(viewportTransform()).toBe(UNMOVED);
      expect(useStudySyncStore.getState().revealRequest).not.toBeNull();

      act(() => rerender(<MindMapPane open />));
      expect(viewportTransform()).toBe(CENTERED_FAR);
      expect(useStudySyncStore.getState().revealRequest).toBeNull();
    });
  });
});
