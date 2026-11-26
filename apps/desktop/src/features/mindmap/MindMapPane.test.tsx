import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandDefinition, formatShortcut } from '@/features/commands/commands';
import { ESCAPE_LAYER, registerEscapeLayer } from '@/features/commands/escape';
import {
  dispatchCommandKeydown,
  forgetRecentCommandRuns,
  onCommandRun,
  runCommand,
} from '@/features/commands/registry';
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
    forgetRecentCommandRuns();
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

    it('does not consume Esc while the pane is collapsed', () => {
      seed([node('a', 40, 40)], { selectedNodeId: 'a', nestingTargetNodeId: 'a' });
      const below = vi.fn(() => true);
      const stop = registerEscapeLayer(ESCAPE_LAYER.focusMode, () => below);
      try {
        render(<MindMapPane open={false} />);

        fireEvent.keyDown(document.querySelector('.react-flow__pane') as HTMLElement, {
          key: 'Escape',
        });

        expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
        expect(useStudySyncStore.getState().selectedNodeId).toBe('a');
        expect(below).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    });

    it('does not set the nesting target on Jump to source link, right-click menu, or double-click (#127)', () => {
      const linkedCard: NoteCard = {
        ...card('a'),
        annotationIds: ['ann-a'],
      };
      const jumpToNode = vi.fn();
      const inspectNode = vi.fn();
      useStudySyncStore.setState({
        notebook,
        nodes: [node('a', 40, 40), node('b', 400, 40)],
        cards: [linkedCard, card('b')],
        edges: [],
        selectedNodeId: 'a',
        nestingTargetNodeId: null,
        jumpToNode,
        inspectNode,
      });
      render(<MindMapPane open />);

      // 1. Clicking the Jump to source link on the card jumps without setting nestingTargetNodeId.
      // React Flow hides unmeasured nodes with `visibility: hidden` in jsdom, so query by aria-label.
      const jumpButton = document.querySelector(
        'button[aria-label="Jump to source of Card a"]',
      ) as HTMLButtonElement;
      expect(jumpButton).not.toBeNull();
      fireEvent.mouseDown(jumpButton);
      fireEvent.click(jumpButton);
      expect(jumpToNode).toHaveBeenCalledWith('a');
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      // 2. Right-clicking opens the context menu and Jump to Source does not set nestingTargetNodeId.
      fireEvent.contextMenu(cardElement('a'));
      const menu = screen.getByRole('menu', { name: 'Card actions' });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Jump to Source/i }));
      expect(jumpToNode).toHaveBeenCalledTimes(2);
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      // 3. Double-clicking (including the browser's preceding click sequence) opens Inspector
      // without leaving the card as the nesting target.
      fireEvent.click(cardElement('b'), { detail: 1 });
      fireEvent.click(cardElement('b'), { detail: 2 });
      fireEvent.doubleClick(cardElement('b'));
      expect(inspectNode).toHaveBeenCalledWith('b');
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      // 4. Right-clicking another card preserves an existing deliberately chosen target.
      fireEvent.click(cardElement('a'), { detail: 1 });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
      fireEvent.contextMenu(cardElement('b'));
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
      expect(useStudySyncStore.getState().selectedNodeId).toBe('b');
    });

    it('lets Space select a focused card as nesting target while Enter edits without nesting (#127)', () => {
      seed([node('a', 40, 40), node('b', 400, 40)], {
        selectedNodeId: 'a',
        nestingTargetNodeId: null,
      });
      const inspectNode = vi.fn();
      useStudySyncStore.setState({ inspectNode });
      render(<MindMapPane open />);

      const cardB = cardElement('b');
      cardB.focus();
      fireEvent.keyDown(cardB, { key: 'Enter', code: 'Enter' });
      expect(inspectNode).toHaveBeenCalledWith('b');
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      fireEvent.keyDown(cardB, { key: ' ', code: 'Space' });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('b');
    });

    it('keeps independent and slow double-clicks from undoing valid targets, and respects intervening explicit changes (#127)', () => {
      seed([node('a', 40, 40), node('b', 400, 40)], {
        selectedNodeId: null,
        nestingTargetNodeId: null,
      });
      const inspectNode = vi.fn();
      useStudySyncStore.setState({ inspectNode });
      render(<MindMapPane open />);

      // 1. Click A once -> A becomes target. Then immediately perform a separate double-click
      // on A (starts a new `detail: 1` click sequence): Inspector opens for A and A stays target.
      fireEvent.click(cardElement('a'), { detail: 1 });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');

      fireEvent.click(cardElement('a'), { detail: 1 });
      fireEvent.click(cardElement('a'), { detail: 2 });
      fireEvent.doubleClick(cardElement('a'));
      expect(inspectNode).toHaveBeenLastCalledWith('a');
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');

      // 2. With A as target, a slow double-click on B (> 760 ms between clicks) edits B and
      // still restores A as the nesting target without relying on a wall-clock timeout.
      vi.useFakeTimers();
      try {
        fireEvent.click(cardElement('b'), { detail: 1 });
        vi.advanceTimersByTime(760);
        fireEvent.click(cardElement('b'), { detail: 2 });
        fireEvent.doubleClick(cardElement('b'));
        expect(inspectNode).toHaveBeenLastCalledWith('b');
        expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
      } finally {
        vi.useRealTimers();
      }

      // 3. With no target, double-clicking B edits B and keeps target null.
      act(() => useStudySyncStore.getState().setNestingTarget(null));
      fireEvent.click(cardElement('b'), { detail: 1 });
      fireEvent.click(cardElement('b'), { detail: 2 });
      fireEvent.doubleClick(cardElement('b'));
      expect(inspectNode).toHaveBeenLastCalledWith('b');
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      // 4. An explicit change (e.g. reader clear or Space) between click 1 and dblclick
      // invalidates the pending click sequence so dblclick does not overwrite newer intent.
      act(() => useStudySyncStore.getState().selectNode('a'));
      fireEvent.click(cardElement('b'), { detail: 1 });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('b');
      act(() => useStudySyncStore.getState().setNestingTarget(null));
      fireEvent.click(cardElement('b'), { detail: 2 });
      fireEvent.doubleClick(cardElement('b'));
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBeNull();

      // Same when Space picks A between click 1 on B and dblclick on B.
      fireEvent.click(cardElement('b'), { detail: 1 });
      cardElement('a').focus();
      fireEvent.keyDown(cardElement('a'), { key: ' ', code: 'Space' });
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
      fireEvent.click(cardElement('b'), { detail: 2 });
      fireEvent.doubleClick(cardElement('b'));
      expect(useStudySyncStore.getState().nestingTargetNodeId).toBe('a');
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

  describe('empty canvas onboarding hint (#120)', () => {
    it('shows the non-interactive hint with registry shortcut and hides MiniMap while empty, then hides hint once a card exists', () => {
      seed([], {});
      const { rerender } = render(<MindMapPane open />);

      const hint = screen.getByTestId('mindmap-empty-hint');
      const excerpt = commandDefinition('edit.excerpt');
      const shortcut = excerpt.shortcut ? formatShortcut(excerpt.shortcut) : '';
      expect(hint).toHaveTextContent(excerpt.title);
      if (shortcut) expect(hint).toHaveTextContent(shortcut);
      expect(hint.className).toContain('pointer-events-none');
      expect(document.querySelector('.react-flow__minimap')).toBeNull();

      act(() => seed([node('a', 40, 40)], {}));
      rerender(<MindMapPane open />);
      expect(screen.queryByTestId('mindmap-empty-hint')).toBeNull();
      expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
    });
  });

  describe('editing and deleting cards (#116, #119)', () => {
    it('opens Inspector on double-click and on Enter (`edit.editCard`)', () => {
      seed([node('a', 40, 40)], { selectedNodeId: 'a' });
      const inspectNode = vi.fn();
      useStudySyncStore.setState({ inspectNode });
      render(<MindMapPane open />);

      fireEvent.doubleClick(cardElement('a'));
      expect(inspectNode).toHaveBeenCalledWith('a');

      const ran = vi.fn();
      const stop = onCommandRun(ran);
      try {
        fireEvent.keyDown(cardElement('a'), { key: 'Enter', code: 'Enter' });
        expect(inspectNode).toHaveBeenCalledTimes(2);
        expect(ran).toHaveBeenCalledWith('edit.editCard', 'keyboard');
      } finally {
        stop();
      }
    });

    it('deletes a selected card via Backspace, Delete, and right-click context menu, and undoes via Cmd+Z', () => {
      seed([node('a', 40, 40), node('b', 400, 40)], { selectedNodeId: 'a' });
      const removeCard = vi.fn(async (cardId: string) => {
        useStudySyncStore.setState((state) => ({
          cards: state.cards.filter((c) => c.id !== cardId),
          nodes: state.nodes.filter((n) => n.cardId !== cardId),
          selectedNodeId: null,
          deletedCardHistory: [
            ...state.deletedCardHistory,
            {
              card: state.cards.find((c) => c.id === cardId) as NoteCard,
              nodes: state.nodes.filter((n) => n.cardId === cardId),
              edges: [],
              childParentLinks: [],
            },
          ],
          deletionOrder: [...state.deletionOrder, 'card'],
        }));
      });
      const undoRemoveCard = vi.fn(async () => null);
      useStudySyncStore.setState({ removeCard, undoRemoveCard });
      render(<MindMapPane open />);

      // Backspace routes through `edit.deleteCard` and deletes the "Source removed" card.
      const ran = vi.fn();
      const stop = onCommandRun(ran);
      try {
        fireEvent.keyDown(cardElement('a'), { key: 'Backspace', code: 'Backspace' });
        expect(removeCard).toHaveBeenCalledWith('card-a');
        expect(ran).toHaveBeenCalledWith('edit.deleteCard', 'keyboard');

        // Cmd+Z triggers `edit.undoDelete` for the deleted card.
        fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', metaKey: true });
        expect(undoRemoveCard).toHaveBeenCalledTimes(1);

        // Right-click opens context menu (`role="menu"`) and Delete Card routes through the command registry.
        fireEvent.contextMenu(cardElement('b'));
        const menu = screen.getByRole('menu', { name: 'Card actions' });
        fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete Card/i }));
        expect(removeCard).toHaveBeenCalledWith('card-b');
        expect(ran).toHaveBeenCalledWith('edit.deleteCard', 'toolbar');
        expect(screen.queryByRole('menu', { name: 'Card actions' })).toBeNull();
      } finally {
        stop();
      }
    });

    it('deletes and edits the keyboard-focused card rather than a stale selected card (#116)', () => {
      seed([node('a', 40, 40), node('b', 400, 40)], { selectedNodeId: 'a' });
      const removeCard = vi.fn(async () => {});
      const inspectNode = vi.fn();
      useStudySyncStore.setState({ removeCard, inspectNode });
      render(
        <>
          <MindMapPane open inspectorOpen />
          <button type="button">Outside canvas</button>
        </>,
      );

      // Select A, then move keyboard focus to B without selecting B.
      const cardB = cardElement('b');
      cardB.focus();
      expect(document.activeElement).toBe(cardB);
      expect(useStudySyncStore.getState().selectedNodeId).toBe('a');

      // Pressing Enter targets focused card B, not selected card A.
      fireEvent.keyDown(cardB, { key: 'Enter', code: 'Enter' });
      expect(inspectNode).toHaveBeenCalledWith('b');

      // Pressing Backspace deletes focused card B, leaving A untouched.
      fireEvent.keyDown(cardB, { key: 'Backspace', code: 'Backspace' });
      expect(removeCard).toHaveBeenCalledWith('card-b');
      expect(removeCard).not.toHaveBeenCalledWith('card-a');

      // Once focus leaves the canvas (e.g., clicking Inspector Delete Card), explicit
      // actions still target the selected card A.
      const outside = screen.getByRole('button', { name: 'Outside canvas' });
      outside.focus();
      fireEvent.contextMenu(cardElement('a'));
      const menu = screen.getByRole('menu', { name: 'Card actions' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete Card/i }));
      expect(removeCard).toHaveBeenLastCalledWith('card-a');
    });
  });
  describe('card keys outside the canvas (#123)', () => {
    const CARD_KEYS = [
      { key: 'Backspace', code: 'Backspace' },
      { key: 'Delete', code: 'Delete' },
      { key: 'Enter', code: 'Enter' },
    ];

    /** Stand-ins for the reading surfaces and chrome around the canvas. */
    function ReadingSurfaces() {
      return (
        <>
          <div role="document" tabIndex={0} data-testid="txt-page">
            The quick brown fox
          </div>
          <div tabIndex={0} data-testid="pdf-scroller">
            <div data-testid="pdf-text-layer">jumps over</div>
          </div>
          <div role="dialog" aria-label="Highlight" data-testid="highlight-popover">
            <span>green highlight</span>
          </div>
          <aside data-testid="reader-sidebar">
            <button type="button">Contents entry</button>
          </aside>
          <div role="toolbar" aria-label="Reader toolbar">
            <button type="button">Show MindMap</button>
          </div>
          <iframe title="EPUB chapter" data-testid="epub-frame" />
        </>
      );
    }

    function renderBeside(pane: { open: boolean; inspectorOpen?: boolean }) {
      seed([node('a', 40, 40)], { selectedNodeId: 'a' });
      const removeCard = vi.fn(async () => {});
      const inspectNode = vi.fn();
      useStudySyncStore.setState({ removeCard, inspectNode });
      render(
        <>
          <MindMapPane open={pane.open} inspectorOpen={pane.inspectorOpen ?? false} />
          <ReadingSurfaces />
        </>,
      );
      return { removeCard, inspectNode };
    }

    function readerTargets(): HTMLElement[] {
      const frameDocument = (screen.getByTestId('epub-frame') as HTMLIFrameElement)
        .contentDocument as Document;
      const chapterParagraph = frameDocument.createElement('p');
      frameDocument.body.append(chapterParagraph);
      return [
        screen.getByTestId('txt-page'),
        screen.getByTestId('pdf-text-layer'),
        screen.getByText('green highlight'),
        screen.getByRole('button', { name: 'Contents entry' }),
        screen.getByRole('button', { name: 'Show MindMap' }),
        document.body,
        chapterParagraph,
      ];
    }

    function pressEverywhere(targets: HTMLElement[]) {
      for (const target of targets) {
        for (const init of CARD_KEYS) {
          const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
          if (target.ownerDocument === document) {
            target.focus();
            target.dispatchEvent(event);
          } else {
            // An EPUB chapter forwards its keydowns to the registry.
            target.dispatchEvent(event);
            dispatchCommandKeydown(event);
          }
        }
      }
    }

    it('leaves the selected card alone for Backspace, Delete, and Return pressed while reading', () => {
      const { removeCard, inspectNode } = renderBeside({ open: true, inspectorOpen: true });
      pressEverywhere(readerTargets());
      expect(removeCard).not.toHaveBeenCalled();
      expect(inspectNode).not.toHaveBeenCalled();
      expect(useStudySyncStore.getState().selectedNodeId).toBe('a');
    });

    it('leaves the selected card alone when only the Inspector shows it', () => {
      const { removeCard, inspectNode } = renderBeside({ open: false, inspectorOpen: true });
      pressEverywhere(readerTargets());
      expect(removeCard).not.toHaveBeenCalled();
      expect(inspectNode).not.toHaveBeenCalled();
    });

    it('still deletes and edits from the canvas pane, the Edit menu, and the context menu', () => {
      const { removeCard, inspectNode } = renderBeside({ open: true, inspectorOpen: true });

      const canvasPane = document.querySelector('.react-flow__pane') as HTMLElement;
      fireEvent.keyDown(canvasPane, { key: 'Enter', code: 'Enter' });
      expect(inspectNode).toHaveBeenCalledWith('a');
      fireEvent.keyDown(canvasPane, { key: 'Delete', code: 'Delete' });
      expect(removeCard).toHaveBeenCalledWith('card-a');

      forgetRecentCommandRuns();
      screen.getByTestId('txt-page').focus();
      expect(runCommand('edit.deleteCard', 'menu')).toBe(true);
      expect(runCommand('edit.editCard', 'menu')).toBe(true);
      expect(removeCard).toHaveBeenCalledTimes(2);
      expect(inspectNode).toHaveBeenCalledTimes(2);

      fireEvent.contextMenu(cardElement('a'));
      const menu = screen.getByRole('menu', { name: 'Card actions' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete Card/i }));
      expect(removeCard).toHaveBeenCalledTimes(3);
    });

    it('keeps the Inspector Delete Card route when the map is hidden', () => {
      const { removeCard } = renderBeside({ open: false, inspectorOpen: true });
      expect(runCommand('edit.deleteCard', 'toolbar')).toBe(true);
      expect(removeCard).toHaveBeenCalledWith('card-a');
    });
  });
});
