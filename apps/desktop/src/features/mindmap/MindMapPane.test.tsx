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
import { flushBeforeClose } from '@/lib/flushBeforeClose';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type {
  Annotation,
  MindMapEdge,
  MindMapNode,
  NoteCard,
  StudyDocument,
  StudyNotebook,
} from '@/types/domain';

import { KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS, MindMapPane } from './MindMapPane';

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

function mockMediaQueries({
  reduceMotion = false,
  dark = false,
}: {
  reduceMotion?: boolean;
  dark?: boolean;
}) {
  const listeners = new Map<string, Set<() => void>>();
  let currentDark = dark;
  let currentReduce = reduceMotion;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        if (query.includes('prefers-color-scheme: dark')) return currentDark;
        if (query.includes('reduce')) return currentReduce;
        return false;
      },
      media: query,
      addEventListener: (_event: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(listener);
        listeners.set(query, set);
      },
      removeEventListener: (_event: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
    })),
  );
  return {
    setDark(next: boolean) {
      currentDark = next;
      for (const [query, set] of listeners) {
        if (query.includes('prefers-color-scheme: dark')) {
          for (const listener of set) listener();
        }
      }
    },
    setReduceMotion(next: boolean) {
      currentReduce = next;
    },
  };
}

function mockReducedMotion(reduce: boolean) {
  mockMediaQueries({ reduceMotion: reduce });
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

  describe('system Dark Mode (#184)', () => {
    it('follows prefers-color-scheme and reacts live when system appearance changes', () => {
      const media = mockMediaQueries({ dark: true });
      seed([node('a', 40, 40)], {});
      render(<MindMapPane open />);

      const flow = document.querySelector('.react-flow') as HTMLElement;
      expect(flow.classList.contains('dark')).toBe(true);
      expect(flow.classList.contains('light')).toBe(false);

      act(() => media.setDark(false));
      expect(flow.classList.contains('light')).toBe(true);
      expect(flow.classList.contains('dark')).toBe(false);

      act(() => media.setDark(true));
      expect(flow.classList.contains('dark')).toBe(true);
    });
  });

  describe('keyboard arrow movement persistence (#182)', () => {
    it('coalesces a burst of arrow-key and Shift+arrow-key moves into one updateNodeLayout write', async () => {
      vi.useFakeTimers();
      try {
        // Exercise the real store -> memoryBackend.updateNodeLayout path.
        await useStudySyncStore.getState().initialize();
        await useStudySyncStore.getState().openDocument();
        const activeDoc = useStudySyncStore.getState().documents[0];
        expect(activeDoc).toBeDefined();
        useStudySyncStore.getState().setSelection({
          documentId: activeDoc!.id,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 15, lineIndex: 0 },
          text: 'The quick brown',
          imagePng: null,
          locationLabel: 'Line 1',
        });
        await useStudySyncStore.getState().excerptSelection();
        const createdNode = useStudySyncStore.getState().nodes[0];
        expect(createdNode).toBeDefined();
        const startX = createdNode!.posX;
        const startY = createdNode!.posY;
        const writesBefore = window.__synapsePreview?.getNodeLayoutWrites().length ?? 0;

        render(<MindMapPane open />);

        const cardEl = cardElement(createdNode!.id);
        cardEl.focus();

        // Three regular presses (+15y) and one Shift press (+20x) within the debounce window.
        fireEvent.keyDown(cardEl, { key: 'ArrowDown' });
        fireEvent.keyDown(cardEl, { key: 'ArrowDown' });
        fireEvent.keyDown(cardEl, { key: 'ArrowDown' });
        fireEvent.keyDown(cardEl, { key: 'ArrowRight', shiftKey: true });

        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({
          posX: startX + 20,
          posY: startY + 15,
        });
        expect((window.__synapsePreview?.getNodeLayoutWrites().length ?? 0) - writesBefore).toBe(0);

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
        });

        const writes = (window.__synapsePreview?.getNodeLayoutWrites() ?? []).slice(writesBefore);
        expect(writes).toEqual([
          {
            nodeId: createdNode!.id,
            posX: startX + 20,
            posY: startY + 15,
            isCollapsed: false,
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes a pending keyboard move immediately via flushBeforeClose before quitting', async () => {
      vi.useFakeTimers();
      try {
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(async (nodeId: string) => {
          const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
          if (target) commits.push({ id: nodeId, posX: target.posX, posY: target.posY });
        });
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        expect(commitNodeLayout).not.toHaveBeenCalled();

        await act(async () => {
          await flushBeforeClose();
        });

        expect(commits).toEqual([{ id: 'a', posX: 40, posY: 45 }]);

        // Advancing past the original debounce must not write a second time.
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commitNodeLayout).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes pending keyboard moves on pagehide, visibilitychange: hidden, and unmount', async () => {
      vi.useFakeTimers();
      try {
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(async (nodeId: string) => {
          const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
          if (target) commits.push({ id: nodeId, posX: target.posX, posY: target.posY });
        });
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        const { unmount } = render(<MindMapPane open />);

        const cardA = cardElement('a');
        cardA.focus();

        // 1. Flush via pagehide.
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        await act(async () => {
          window.dispatchEvent(new Event('pagehide'));
        });
        expect(commits).toEqual([{ id: 'a', posX: 45, posY: 40 }]);

        // 2. Flush via visibilitychange -> hidden.
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'hidden',
        });
        try {
          await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
          });
        } finally {
          if (originalVisibility) {
            Object.defineProperty(document, 'visibilityState', originalVisibility);
          } else {
            delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
          }
        }
        expect(commits).toEqual([
          { id: 'a', posX: 45, posY: 40 },
          { id: 'a', posX: 45, posY: 45 },
        ]);

        // 3. Flush via unmount.
        fireEvent.keyDown(cardA, { key: 'ArrowUp', shiftKey: true });
        await act(async () => {
          unmount();
        });
        expect(commits).toEqual([
          { id: 'a', posX: 45, posY: 40 },
          { id: 'a', posX: 45, posY: 45 },
          { id: 'a', posX: 45, posY: 25 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips flushing a deleted node and never throws', async () => {
      vi.useFakeTimers();
      try {
        const commitNodeLayout = vi.fn(async () => {});
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });

        // Remove the node from state before the debounce timer fires.
        act(() => {
          useStudySyncStore.setState({ nodes: [], cards: [], selectedNodeId: null });
        });

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
        });
        expect(commitNodeLayout).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves an unsaved keyboard move if close fires mid-drag, and writes final position once on normal release (#182)', async () => {
      vi.useFakeTimers();
      try {
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(
          async (nodeId: string, position?: { posX: number; posY: number }) => {
            const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
            const posX = position?.posX ?? target?.posX ?? 0;
            const posY = position?.posY ?? target?.posY ?? 0;
            commits.push({ id: nodeId, posX, posY });
          },
        );
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        const dispatchMouse = (
          target: EventTarget,
          type: 'mousedown' | 'mousemove' | 'mouseup',
          init: MouseEventInit,
        ) => {
          const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            ...init,
          });
          Object.defineProperty(event, 'view', { value: window });
          act(() => {
            target.dispatchEvent(event);
          });
        };
        cardA.focus();

        // 1. Keyboard move (40, 40) -> (45, 40), then start mouse drag to (69, 52) without releasing.
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 45, posY: 40 });
        dispatchMouse(cardA, 'mousedown', { clientX: 50, clientY: 50 });
        // First move crosses React Flow's default `nodeDragThreshold` (1 px) to start dragging.
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 52, clientY: 50 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 76, clientY: 62 });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 69, posY: 52 });
        expect(commits).toEqual([]);

        // Close fires before mouseUp: must flush the last completed keyboard move (45, 40), not (69, 52).
        await act(async () => {
          await flushBeforeClose();
        });
        expect(commits).toEqual([{ id: 'a', posX: 45, posY: 40 }]);

        // Finish the drag cleanly.
        dispatchMouse(window, 'mouseup', { clientX: 76, clientY: 62 });
        await act(async () => {
          await Promise.resolve();
        });
        expect(commits).toEqual([
          { id: 'a', posX: 45, posY: 40 },
          { id: 'a', posX: 69, posY: 52 },
        ]);

        // 2. Keyboard move (69, 52) -> (74, 52), then drag and release at (94, 62): writes ONCE with (94, 62).
        commits.length = 0;
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 74, posY: 52 });
        dispatchMouse(cardA, 'mousedown', { clientX: 80, clientY: 60 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 82, clientY: 60 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 102, clientY: 70 });
        // Even if the drag lasts past the 300 ms debounce, it must not flush mid-drag.
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        dispatchMouse(window, 'mouseup', { clientX: 102, clientY: 70 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([{ id: 'a', posX: 94, posY: 62 }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores arrow keys pressed mid-drag so no intermediate coordinates are written or announced (#182)', async () => {
      vi.useFakeTimers();
      try {
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(
          async (nodeId: string, position?: { posX: number; posY: number }) => {
            const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
            commits.push({
              id: nodeId,
              posX: position?.posX ?? target?.posX ?? 0,
              posY: position?.posY ?? target?.posY ?? 0,
            });
          },
        );
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        const dispatchMouse = (
          target: EventTarget,
          type: 'mousedown' | 'mousemove' | 'mouseup',
          init: MouseEventInit,
        ) => {
          const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            ...init,
          });
          Object.defineProperty(event, 'view', { value: window });
          act(() => {
            target.dispatchEvent(event);
          });
        };
        cardA.focus();

        // 1. Drag from (40, 40) to (64, 52), hold mouse pressed, press ArrowDown, wait > 300 ms:
        //    must stay at (64, 52), keep live region empty, write 0 times before release, then 1 time on release.
        dispatchMouse(cardA, 'mousedown', { clientX: 50, clientY: 50 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 52, clientY: 50 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 76, clientY: 62 });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 64, posY: 52 });

        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 64, posY: 52 });
        const liveRegion = document.querySelector('[id^="react-flow__aria-live-"]');
        expect(liveRegion?.textContent ?? '').toBe('');

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        dispatchMouse(window, 'mouseup', { clientX: 76, clientY: 62 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([{ id: 'a', posX: 64, posY: 52 }]);

        // 2. Keyboard move (64, 52) -> (69, 52), start dragging to (93, 64), press ArrowDown mid-drag,
        //    wait > 300 ms (still 0 writes), then close before release -> writes ONLY pre-drag (69, 52).
        commits.length = 0;
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 69, posY: 52 });

        dispatchMouse(cardA, 'mousedown', { clientX: 80, clientY: 60 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 82, clientY: 60 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 106, clientY: 72 });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 93, posY: 64 });

        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 93, posY: 64 });

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        await act(async () => {
          await flushBeforeClose();
        });
        expect(commits).toEqual([{ id: 'a', posX: 69, posY: 52 }]);

        dispatchMouse(window, 'mouseup', { clientX: 106, clientY: 72 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores pre-drag coordinates and preserves pending keyboard moves on touchcancel, ignores unrelated cancels, and commits once on touchend (#182)', async () => {
      vi.useFakeTimers();
      const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
        Navigator.prototype,
        'maxTouchPoints',
      );
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
        configurable: true,
        get: () => 5,
      });
      try {
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(
          async (nodeId: string, position?: { posX: number; posY: number }) => {
            const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
            commits.push({
              id: nodeId,
              posX: position?.posX ?? target?.posX ?? 0,
              posY: position?.posY ?? target?.posY ?? 0,
            });
          },
        );
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        const dispatchTouch = (
          target: EventTarget,
          type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
          identifier: number,
          clientX: number,
          clientY: number,
        ) => {
          const touch = { identifier, clientX, clientY, pageX: clientX, pageY: clientY, target };
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            changedTouches: { value: [touch] },
            touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [touch] },
            targetTouches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [touch] },
            view: { value: window },
          });
          act(() => {
            target.dispatchEvent(event);
          });
        };
        const dispatchMouse = (
          target: EventTarget,
          type: 'mousedown' | 'mousemove' | 'mouseup',
          init: MouseEventInit,
        ) => {
          const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            ...init,
          });
          Object.defineProperty(event, 'view', { value: window });
          act(() => {
            target.dispatchEvent(event);
          });
        };

        // 1. Pending keyboard move (40, 40) -> (45, 40), touch drag to (63, 50), then touchcancel:
        //    must snap UI back to (45, 40) and persist ONLY (45, 40) once after debounce.
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 45, posY: 40 });

        dispatchTouch(cardA, 'touchstart', 1, 50, 50);
        dispatchTouch(cardA, 'touchmove', 1, 52, 50);
        dispatchTouch(cardA, 'touchmove', 1, 70, 60);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 63, posY: 50 });
        expect(commits).toEqual([]);

        dispatchTouch(cardA, 'touchcancel', 1, 70, 60);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 45, posY: 40 });
        expect(commits).toEqual([]);

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
        });
        expect(commits).toEqual([{ id: 'a', posX: 45, posY: 40 }]);

        // 2. Touch drag with NO pending keyboard move, then touchcancel:
        //    must snap UI back to (45, 40), write 0 times, and allow subsequent arrow keys.
        commits.length = 0;
        dispatchTouch(cardA, 'touchstart', 2, 50, 50);
        dispatchTouch(cardA, 'touchmove', 2, 52, 50);
        dispatchTouch(cardA, 'touchmove', 2, 70, 60);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 63, posY: 50 });

        dispatchTouch(cardA, 'touchcancel', 2, 70, 60);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 45, posY: 40 });

        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 45, posY: 45 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
        });
        expect(commits).toEqual([{ id: 'a', posX: 45, posY: 45 }]);

        // 3. Normal touch drag ending with touchend: writes final position once, no duplicates.
        commits.length = 0;
        dispatchTouch(cardA, 'touchstart', 3, 50, 50);
        dispatchTouch(cardA, 'touchmove', 3, 52, 50);
        dispatchTouch(cardA, 'touchmove', 3, 72, 65);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 65, posY: 60 });
        dispatchTouch(cardA, 'touchend', 3, 72, 65);
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([{ id: 'a', posX: 65, posY: 60 }]);

        // 4. An unrelated pointercancel or unrelated touchcancel during an active mouse drag
        //    must not clear the active mouse drag state.
        //    Advance past d3-drag's 500 ms ghost-click suppression window after touchend.
        await act(async () => {
          vi.advanceTimersByTime(600);
        });
        commits.length = 0;
        dispatchMouse(cardA, 'mousedown', { clientX: 80, clientY: 70 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 82, clientY: 70 });
        dispatchMouse(window, 'mousemove', { buttons: 1, clientX: 100, clientY: 80 });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 83, posY: 70 });

        act(() => {
          window.dispatchEvent(new Event('pointercancel'));
        });
        dispatchTouch(window, 'touchcancel', 99, 0, 0);

        // Arrow key must STILL be suppressed because the mouse drag is still active.
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 83, posY: 70 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        dispatchMouse(window, 'mouseup', { clientX: 100, clientY: 80 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([{ id: 'a', posX: 83, posY: 70 }]);

        // 5. Dual-touch: touch 1 drags card to (101, 80) and stays pressed while touch 2 taps
        //    and releases outside (`changedTouches: [touch2], touches: [touch1]`). Must NOT
        //    snap back, must keep arrow keys blocked, must write 0 times before touch 1 ends,
        //    and must write once at (101, 80) when touch 1 releases.
        commits.length = 0;
        const pane = document.querySelector('.react-flow__pane') as HTMLElement;
        const touch1Start = {
          identifier: 10,
          clientX: 90,
          clientY: 80,
          pageX: 90,
          pageY: 80,
          target: cardA,
        };
        const touch1Thresh = {
          identifier: 10,
          clientX: 92,
          clientY: 80,
          pageX: 92,
          pageY: 80,
          target: cardA,
        };
        const touch1Moved = {
          identifier: 10,
          clientX: 110,
          clientY: 90,
          pageX: 110,
          pageY: 90,
          target: cardA,
        };
        const touch2Outside = {
          identifier: 11,
          clientX: 500,
          clientY: 500,
          pageX: 500,
          pageY: 500,
          target: pane,
        };
        const sendRawTouch = (
          target: EventTarget,
          type: 'touchstart' | 'touchmove' | 'touchend',
          changedTouches: unknown[],
          touches: unknown[],
        ) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            changedTouches: { value: changedTouches },
            touches: { value: touches },
            targetTouches: { value: touches },
            view: { value: window },
          });
          act(() => {
            target.dispatchEvent(event);
          });
        };

        sendRawTouch(cardA, 'touchstart', [touch1Start], [touch1Start]);
        sendRawTouch(cardA, 'touchmove', [touch1Thresh], [touch1Thresh]);
        sendRawTouch(cardA, 'touchmove', [touch1Moved], [touch1Moved]);
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 101, posY: 80 });

        // Unrelated touch 2 taps outside and releases while touch 1 stays in `touches`.
        sendRawTouch(pane, 'touchstart', [touch2Outside], [touch1Moved, touch2Outside]);
        sendRawTouch(pane, 'touchend', [touch2Outside], [touch1Moved]);

        // Advance past both 0 ms fallback macrotask and > 300 ms debounce.
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 101, posY: 80 });
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        expect(useStudySyncStore.getState().nodes[0]).toMatchObject({ posX: 101, posY: 80 });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([]);

        // Releasing touch 1 commits (101, 80) once.
        sendRawTouch(cardA, 'touchend', [touch1Moved], []);
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS * 2);
        });
        expect(commits).toEqual([{ id: 'a', posX: 101, posY: 80 }]);
      } finally {
        if (originalMaxTouchPoints) {
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', originalMaxTouchPoints);
        } else {
          delete (Navigator.prototype as { maxTouchPoints?: number }).maxTouchPoints;
        }
        vi.useRealTimers();
      }
    });

    it('waits for an in-flight layout write and any follow-up move before flushBeforeClose resolves (#182)', async () => {
      vi.useFakeTimers();
      try {
        let releaseFirstWrite: (() => void) | null = null;
        const commits: Array<{ id: string; posX: number; posY: number }> = [];
        const commitNodeLayout = vi.fn(
          async (nodeId: string, position?: { posX: number; posY: number }) => {
            if (commits.length === 0 && releaseFirstWrite === null) {
              await new Promise<void>((resolve) => {
                releaseFirstWrite = resolve;
              });
            }
            const target = useStudySyncStore.getState().nodes.find((n) => n.id === nodeId);
            commits.push({
              id: nodeId,
              posX: position?.posX ?? target?.posX ?? 0,
              posY: position?.posY ?? target?.posY ?? 0,
            });
          },
        );
        seed([node('a', 40, 40)], { selectedNodeId: 'a', commitNodeLayout });
        render(<MindMapPane open />);

        const cardA = cardElement('a');
        cardA.focus();
        fireEvent.keyDown(cardA, { key: 'ArrowRight' });
        await act(async () => {
          vi.advanceTimersByTime(KEYBOARD_MOVE_COMMIT_DEBOUNCE_MS);
        });
        expect(releaseFirstWrite).not.toBeNull();

        // While the first write is still in flight, move again and trigger close.
        fireEvent.keyDown(cardA, { key: 'ArrowDown' });
        let closeDone = false;
        const closePromise = flushBeforeClose().then(() => {
          closeDone = true;
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(closeDone).toBe(false);

        await act(async () => {
          releaseFirstWrite?.();
          await closePromise;
        });
        expect(closeDone).toBe(true);
        expect(commits).toEqual([
          { id: 'a', posX: 45, posY: 40 },
          { id: 'a', posX: 45, posY: 45 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('screen reader names and descriptions (#185)', () => {
    it('gives cards and links title-based accessible names and accurate keyboard descriptions', () => {
      const OriginalResizeObserver = globalThis.ResizeObserver;
      const originalDOMMatrixReadOnly = globalThis.DOMMatrixReadOnly;
      const originalOffsetWidth = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetWidth',
      );
      const originalOffsetHeight = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetHeight',
      );

      const observers: Array<{
        callback: ResizeObserverCallback;
        targets: Element[];
        instance: ResizeObserver;
      }> = [];
      class MeasuringResizeObserver implements ResizeObserver {
        private entry: {
          callback: ResizeObserverCallback;
          targets: Element[];
          instance: ResizeObserver;
        };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [], instance: this };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      }
      globalThis.ResizeObserver = MeasuringResizeObserver;
      if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
        globalThis.DOMMatrixReadOnly = class {
          m22 = 1;
        } as unknown as typeof DOMMatrixReadOnly;
      }
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
          if (this.classList.contains('react-flow')) return PANE.width;
          if (this.classList.contains('react-flow__node')) return 240;
          if (this.classList.contains('react-flow__handle')) return 6;
          return 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          if (this.classList.contains('react-flow')) return PANE.height;
          if (this.classList.contains('react-flow__node')) return 96;
          if (this.classList.contains('react-flow__handle')) return 6;
          return 0;
        },
      });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.classList.contains('react-flow')) {
          return DOMRect.fromRect({ x: 0, y: 0, ...PANE });
        }
        if (this.classList.contains('react-flow__node')) {
          return DOMRect.fromRect({ x: 0, y: 0, width: 240, height: 96 });
        }
        if (this.classList.contains('react-flow__handle')) {
          const isRight = this.classList.contains('react-flow__handle-right');
          return DOMRect.fromRect({ x: isRight ? 237 : -3, y: 45, width: 6, height: 6 });
        }
        return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      });

      try {
        const doc: StudyDocument = {
          id: 'doc-1',
          filePath: '/books/habits.txt',
          fileHash: 'hash',
          format: 'txt',
          title: 'Habits Book',
          displayTitle: null,
          encoding: 'utf-8',
          lastCursorAnchor: null,
          lastOpenedAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        };
        const annParent: Annotation = {
          id: 'ann-parent',
          documentId: doc.id,
          notebookId: notebook.id,
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 10, lineIndex: 0 },
          excerptText: 'Habits',
          excerptImagePath: null,
          note: null,
          color: 'yellow',
          style: 'highlight',
          locationLabel: 'Line 1',
          createdAt: '2026-01-01T00:00:00Z',
        };
        const annChild: Annotation = {
          ...annParent,
          id: 'ann-child',
          excerptText: 'The quick brown fox',
          locationLabel: 'Line 6',
        };
        const parentCard: NoteCard = {
          id: 'card-parent-uuid',
          notebookId: notebook.id,
          title: 'Habits',
          markdownNotes: '',
          tags: [],
          annotationIds: [annParent.id],
          createdAt: '2026-01-01T00:00:00Z',
        };
        const childCard: NoteCard = {
          id: 'card-child-uuid',
          notebookId: notebook.id,
          title: 'The quick brown fox',
          markdownNotes: 'Important takeaway',
          tags: ['focus', 'routine'],
          annotationIds: [annChild.id],
          createdAt: '2026-01-01T00:00:00Z',
        };
        const peerCard: NoteCard = {
          id: 'card-peer-uuid',
          notebookId: notebook.id,
          title: 'Memory',
          markdownNotes: '',
          tags: [],
          annotationIds: [],
          createdAt: '2026-01-01T00:00:00Z',
        };
        const parentNode: MindMapNode = {
          ...node('node-parent-uuid', 40, 40),
          cardId: parentCard.id,
        };
        const childNode: MindMapNode = {
          ...node('node-child-uuid', 360, 40),
          cardId: childCard.id,
          parentNodeId: parentNode.id,
        };
        const peerNode: MindMapNode = {
          ...node('node-peer-uuid', 360, 220),
          cardId: peerCard.id,
        };
        const nestingEdge: MindMapEdge = {
          id: 'edge-nesting-uuid',
          notebookId: notebook.id,
          sourceNodeId: parentNode.id,
          targetNodeId: childNode.id,
          label: null,
        };
        const crossEdge: MindMapEdge = {
          id: 'edge-cross-uuid',
          notebookId: notebook.id,
          sourceNodeId: childNode.id,
          targetNodeId: peerNode.id,
          label: null,
        };

        useStudySyncStore.setState({
          notebook,
          documents: [doc],
          annotations: [annParent, annChild],
          cards: [parentCard, childCard, peerCard],
          nodes: [parentNode, childNode, peerNode],
          edges: [nestingEdge, crossEdge],
          selectedNodeId: childNode.id,
        });

        render(<MindMapPane open />);
        act(() => {
          for (const { callback, targets, instance } of observers) {
            const entries = targets
              .filter(
                (target) =>
                  target.classList.contains('react-flow__node') ||
                  target.classList.contains('react-flow'),
              )
              .map((target) => {
                const isFlow = target.classList.contains('react-flow');
                const width = isFlow ? PANE.width : 240;
                const height = isFlow ? PANE.height : 96;
                return {
                  target,
                  contentRect: DOMRect.fromRect({ x: 0, y: 0, width, height }),
                  borderBoxSize: [{ inlineSize: width, blockSize: height }],
                  contentBoxSize: [{ inlineSize: width, blockSize: height }],
                  devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
                } as ResizeObserverEntry;
              });
            if (entries.length > 0) callback(entries, instance);
          }
        });

        const childEl = cardElement(childNode.id);
        expect(childEl.getAttribute('aria-label')).toBe(
          'Card: The quick brown fox, from Habits Book · Line 6, nested under ‘Habits’, has notes, 2 tags',
        );
        expect(childEl.getAttribute('aria-label')).not.toContain('uuid');

        const peerEl = cardElement(peerNode.id);
        expect(peerEl.getAttribute('aria-label')).toBe('Card: Memory, source removed');

        const nodeDescId = childEl.getAttribute('aria-describedby');
        expect(nodeDescId).toBeTruthy();
        const nodeDesc = document.getElementById(nodeDescId as string)?.textContent ?? '';
        expect(nodeDesc).toContain('to edit card');
        expect(nodeDesc).toContain(
          'Space to select this card and make it the target for the next excerpt',
        );
        expect(nodeDesc).toContain('Once selected, use the arrow keys to move it');
        expect(nodeDesc).toContain('to delete it');
        expect(nodeDesc).toContain('to undo');
        expect(nodeDesc).not.toContain('Press enter or space to select a node');

        const nestingEl = document.querySelector(
          `.react-flow__edge[data-id="${nestingEdge.id}"]`,
        ) as Element | null;
        expect(nestingEl).not.toBeNull();
        expect(nestingEl?.getAttribute('aria-label')).toBe(
          '‘The quick brown fox’ nested under ‘Habits’',
        );

        const crossEl = document.querySelector(
          `.react-flow__edge[data-id="${crossEdge.id}"]`,
        ) as Element | null;
        expect(crossEl).not.toBeNull();
        expect(crossEl?.getAttribute('aria-label')).toBe(
          'Link from ‘The quick brown fox’ to ‘Memory’',
        );

        const edgeDescId = nestingEl?.getAttribute('aria-describedby');
        expect(edgeDescId).toBeTruthy();
        const edgeDesc = document.getElementById(edgeDescId as string)?.textContent ?? '';
        expect(edgeDesc).toContain('to select this link');
        expect(edgeDesc).toContain('to remove it');
        expect(edgeDesc).not.toContain('select an edge');

        // Arrow-key movement announces direction without raw x/y pixel coordinates.
        childEl.focus();
        fireEvent.keyDown(childEl, { key: 'ArrowDown' });
        const liveRegion = document.querySelector('[id^="react-flow__aria-live-"]');
        expect(liveRegion?.textContent).toBe('Moved selected card down.');
      } finally {
        globalThis.ResizeObserver = OriginalResizeObserver;
        globalThis.DOMMatrixReadOnly = originalDOMMatrixReadOnly;
        if (originalOffsetWidth) {
          Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
        }
        if (originalOffsetHeight) {
          Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
        }
      }
    });
  });
});
