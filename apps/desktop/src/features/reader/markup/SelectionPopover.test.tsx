import { fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useAnnotationsController } from '@/features/reader/AnnotationsPanel';
import { SelectionPopover } from '@/features/reader/markup/SelectionPopover';
import type { SelectionPopoverController } from '@/features/reader/markup/useSelectionPopover';
import type { Annotation, ReaderSelection } from '@/types/domain';

const sampleSelection: ReaderSelection = {
  documentId: 'doc-1',
  text: 'quick brown fox',
  imagePng: null,
  anchor: { format: 'txt', startByteOffset: 4, endByteOffset: 19, lineIndex: 0 },
};

function Harness() {
  const boundsRef = createRef<HTMLDivElement>();
  const [noteOpen, setNoteOpen] = useState(false);
  const annotations = useAnnotationsController({
    documentId: 'doc-1',
    selection: sampleSelection,
    onSelectAnnotation: vi.fn(),
  });
  const popover: SelectionPopoverController = {
    target: { kind: 'selection' },
    focusRequest: 0,
    noteOpen,
    selectionRect: () => ({ left: 100, top: 200, right: 220, bottom: 220, width: 120, height: 20 }),
    openForAnnotation: vi.fn(),
    showFromKeyboard: vi.fn(),
    openNote: () => setNoteOpen(true),
    closeNote: () => setNoteOpen(false),
    dismiss: vi.fn(),
    reportPointer: vi.fn(),
  };

  return (
    <div ref={boundsRef}>
      <SelectionPopover
        popover={popover}
        annotations={annotations}
        selection={sampleSelection}
        boundsRef={boundsRef}
        onExcerpt={vi.fn()}
        onReturnFocus={vi.fn()}
      />
    </div>
  );
}

describe('SelectionPopover', () => {
  it('uses animation-duration-150 without arming CSS property transitions (#40)', () => {
    render(<Harness />);
    const dialog = screen.getByTestId('selection-popover');
    // `animation-duration-150` drives `@keyframes` entrance without setting
    // `transition-duration`, keeping `top`, `left`, and `transform-origin` pinned.
    expect(dialog).toHaveClass('animate-in', 'animation-duration-150');
    expect(dialog).not.toHaveClass('duration-150');

    const noteField = screen.getByTestId('popover-note-input');
    expect(noteField.closest('[inert]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('popover-note'));
    expect(noteField.closest('[inert]')).toBeNull();
  });
});

const highlight: Annotation = {
  id: 'ann-1',
  documentId: 'doc-1',
  notebookId: 'nb',
  anchor: sampleSelection.anchor,
  excerptText: sampleSelection.text,
  excerptImagePath: null,
  note: null,
  color: '#fde047',
  style: 'highlight',
  createdAt: '2026-11-01T10:00:00.000Z',
};

/** A clicked highlight's popover, with `cardSource` saying whether a card cites it. */
function HighlightHarness({
  cardSource,
  onDelete,
  dismiss,
}: {
  cardSource: boolean;
  onDelete: (annotationId: string) => void;
  dismiss: () => void;
}) {
  const boundsRef = createRef<HTMLDivElement>();
  const annotations = useAnnotationsController({
    documentId: 'doc-1',
    annotations: [highlight],
    onDeleteAnnotation: onDelete,
    cardSourceAnnotationIds: new Set(cardSource ? [highlight.id] : []),
    onSelectAnnotation: vi.fn(),
  });
  const popover: SelectionPopoverController = {
    target: { kind: 'annotation', annotationId: highlight.id, rect: null },
    focusRequest: 0,
    noteOpen: false,
    selectionRect: () => null,
    openForAnnotation: vi.fn(),
    showFromKeyboard: vi.fn(),
    openNote: vi.fn(),
    closeNote: vi.fn(),
    dismiss,
    reportPointer: vi.fn(),
  };
  return (
    <div ref={boundsRef}>
      <SelectionPopover
        popover={popover}
        annotations={annotations}
        selection={null}
        boundsRef={boundsRef}
        onReturnFocus={vi.fn()}
      />
    </div>
  );
}

// #97: a card's source is not deleted without saying what happens to the card.
describe('SelectionPopover Delete Highlight', () => {
  it('deletes a highlight no card cites at once', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    render(<HighlightHarness cardSource={false} onDelete={onDelete} dismiss={dismiss} />);

    fireEvent.click(screen.getByTestId('popover-delete'));
    expect(onDelete).toHaveBeenCalledWith(highlight.id);
    expect(dismiss).toHaveBeenCalled();
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
  });

  it('warns before deleting a card source, and deletes only once confirmed', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    render(<HighlightHarness cardSource onDelete={onDelete} dismiss={dismiss} />);

    fireEvent.click(screen.getByTestId('popover-delete'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('card-source-delete-confirm-button');
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription(/source of a MindMap card/);

    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledWith(highlight.id);
    expect(dismiss).toHaveBeenCalled();
  });

  it('keeps the highlight when the warning is cancelled or put away with Esc', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    render(<HighlightHarness cardSource onDelete={onDelete} dismiss={dismiss} />);

    fireEvent.click(screen.getByTestId('popover-delete'));
    fireEvent.click(screen.getByTestId('card-source-delete-cancel'));
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
    expect(screen.getByTestId('popover-delete')).toHaveFocus();

    fireEvent.click(screen.getByTestId('popover-delete'));
    fireEvent.keyDown(screen.getByTestId('card-source-delete-confirm-button'), { key: 'Escape' });
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
    // Esc took back the question only; the popover is still open.
    expect(dismiss).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
