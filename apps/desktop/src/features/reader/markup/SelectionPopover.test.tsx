import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { dispatchEscape } from '@/features/commands/escape';
import { forgetRecentCommandRuns, runCommand } from '@/features/commands/registry';
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

function Harness({
  excerptTargetTitle = null,
  onClearExcerptTarget,
}: {
  excerptTargetTitle?: string | null;
  onClearExcerptTarget?: () => void;
} = {}) {
  const boundsRef = { current: document.body };
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
    <div>
      <SelectionPopover
        popover={popover}
        annotations={annotations}
        selection={sampleSelection}
        boundsRef={boundsRef}
        onExcerpt={vi.fn()}
        excerptTargetTitle={excerptTargetTitle}
        onClearExcerptTarget={onClearExcerptTarget}
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

  it('names the active nesting target and lets the reader clear it from the popover (#127)', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <Harness excerptTargetTitle="Quick brown fox" onClearExcerptTarget={onClear} />,
    );

    const excerptBtn = screen.getByTestId('popover-excerpt');
    expect(excerptBtn).toHaveAccessibleName('Excerpt under ‘Quick brown fox’');
    expect(excerptBtn).toHaveAttribute(
      'title',
      expect.stringContaining('Excerpt under ‘Quick brown fox’'),
    );

    const targetRow = screen.getByTestId('popover-nesting-target');
    expect(targetRow).toHaveTextContent('Under ‘Quick brown fox’');

    const clearBtn = screen.getByTestId('popover-clear-nesting-target');
    expect(clearBtn).toHaveAccessibleName('Clear nesting target ‘Quick brown fox’');
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(<Harness excerptTargetTitle={null} onClearExcerptTarget={onClear} />);
    expect(screen.getByTestId('popover-excerpt')).toHaveAccessibleName('Excerpt to MindMap');
    expect(screen.queryByTestId('popover-nesting-target')).toBeNull();
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
  excerpting = false,
  onDelete,
  onUpdate,
  dismiss,
  onExcerptAnnotation,
  onShowAnnotationCard,
  excerptTargetTitle = null,
  onClearExcerptTarget,
  annotationOverride,
}: {
  cardSource: boolean;
  excerpting?: boolean;
  onDelete: (annotationId: string) => void;
  onUpdate?: (
    annotationId: string,
    patch: { note: string | null; color: string | null },
  ) => void | Promise<boolean>;
  dismiss: () => void;
  onExcerptAnnotation?: (annotationId: string) => void;
  onShowAnnotationCard?: (annotationId: string) => void;
  excerptTargetTitle?: string | null;
  onClearExcerptTarget?: () => void;
  annotationOverride?: Partial<Annotation>;
}) {
  const boundsRef = { current: document.body };
  const [noteOpen, setNoteOpen] = useState(false);
  const current = { ...highlight, ...annotationOverride };
  const annotations = useAnnotationsController({
    documentId: 'doc-1',
    annotations: [current],
    onUpdateAnnotation: onUpdate,
    onDeleteAnnotation: onDelete,
    cardSourceAnnotationIds: new Set(cardSource ? [current.id] : []),
    excerptingAnnotationIds: new Set(excerpting ? [current.id] : []),
    onExcerptAnnotation,
    onShowAnnotationCard,
    excerptTargetTitle,
    onSelectAnnotation: vi.fn(),
  });
  const popover: SelectionPopoverController = {
    target: { kind: 'annotation', annotationId: current.id, rect: null },
    focusRequest: 0,
    noteOpen,
    selectionRect: () => null,
    openForAnnotation: vi.fn(),
    showFromKeyboard: vi.fn(),
    openNote: () => setNoteOpen(true),
    closeNote: () => setNoteOpen(false),
    dismiss,
    reportPointer: vi.fn(),
  };
  return (
    <div>
      <SelectionPopover
        popover={popover}
        annotations={annotations}
        selection={null}
        boundsRef={boundsRef}
        excerptTargetTitle={excerptTargetTitle}
        onClearExcerptTarget={onClearExcerptTarget}
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

    // Clicking the toolbar delete button again cannot bypass the confirmation.
    const deleteButton = screen.getByTestId('popover-delete');
    deleteButton.focus();
    fireEvent.click(deleteButton);
    expect(onDelete).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(confirm).toBeInTheDocument();
    expect(confirm).toHaveFocus();

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

  it('cancels delete confirmation on Esc even when focus is on the toolbar or outside the popover', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    render(<HighlightHarness cardSource onDelete={onDelete} dismiss={dismiss} />);

    // Focus moved back to a toolbar button (e.g. Shift+Tab).
    fireEvent.click(screen.getByTestId('popover-delete'));
    const colorButton = screen.getByTestId('popover-color-yellow');
    colorButton.focus();
    fireEvent.keyDown(colorButton, { key: 'Escape' });
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
    expect(screen.getByTestId('popover-delete')).toHaveFocus();
    expect(dismiss).not.toHaveBeenCalled();

    // Focus outside the popover (e.g. reader page or EPUB iframe forwarding Escape).
    fireEvent.click(screen.getByTestId('popover-delete'));
    act(() => {
      expect(
        dispatchEscape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
      ).toBe(true);
    });
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();

    // A second Esc closes the popover.
    act(() => {
      expect(
        dispatchEscape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
      ).toBe(true);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('closes delete confirmation when opening the note editor, and vice versa', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    render(<HighlightHarness cardSource onDelete={onDelete} dismiss={dismiss} />);

    fireEvent.click(screen.getByTestId('popover-delete'));
    expect(screen.getByTestId('card-source-delete-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('popover-note'));
    expect(screen.queryByTestId('card-source-delete-confirm')).toBeNull();
    expect(screen.getByTestId('popover-note-input').closest('[inert]')).toBeNull();

    fireEvent.click(screen.getByTestId('popover-delete'));
    expect(screen.getByTestId('popover-note-input').closest('[inert]')).not.toBeNull();
    expect(screen.getByTestId('card-source-delete-confirm')).toBeInTheDocument();
  });
});

// #124: an existing highlight or underline can be sent to the MindMap or reveal its card.
describe('SelectionPopover MindMap actions for existing highlights (#124)', () => {
  it('offers Excerpt to MindMap for an unlinked highlight or underline, including nesting target and ⇧⌘E', () => {
    forgetRecentCommandRuns();
    const onExcerptAnnotation = vi.fn();
    const onShowAnnotationCard = vi.fn();
    const dismiss = vi.fn();
    render(
      <HighlightHarness
        cardSource={false}
        onDelete={vi.fn()}
        dismiss={dismiss}
        onExcerptAnnotation={onExcerptAnnotation}
        onShowAnnotationCard={onShowAnnotationCard}
        excerptTargetTitle="Parent card"
        annotationOverride={{ style: 'underline' }}
      />,
    );

    const excerptBtn = screen.getByTestId('popover-excerpt');
    expect(excerptBtn).toHaveAccessibleName('Excerpt under ‘Parent card’');
    expect(screen.getByTestId('popover-nesting-target')).toHaveTextContent('Under ‘Parent card’');
    expect(screen.queryByTestId('popover-show-in-mindmap')).toBeNull();

    fireEvent.click(excerptBtn);
    expect(onExcerptAnnotation).toHaveBeenCalledWith(highlight.id);
    expect(dismiss).toHaveBeenCalledTimes(1);

    forgetRecentCommandRuns();
    act(() => {
      expect(runCommand('edit.excerpt', 'keyboard')).toBe(true);
    });
    expect(onExcerptAnnotation).toHaveBeenCalledTimes(2);
    expect(onShowAnnotationCard).not.toHaveBeenCalled();
  });

  it('replaces Excerpt with Show in MindMap for a highlight that already backs a card', () => {
    forgetRecentCommandRuns();
    const onExcerptAnnotation = vi.fn();
    const onShowAnnotationCard = vi.fn();
    const dismiss = vi.fn();
    render(
      <HighlightHarness
        cardSource
        onDelete={vi.fn()}
        dismiss={dismiss}
        onExcerptAnnotation={onExcerptAnnotation}
        onShowAnnotationCard={onShowAnnotationCard}
        excerptTargetTitle="Parent card"
      />,
    );

    expect(screen.queryByTestId('popover-excerpt')).toBeNull();
    expect(screen.queryByTestId('popover-nesting-target')).toBeNull();
    const showBtn = screen.getByTestId('popover-show-in-mindmap');
    expect(showBtn).toHaveAccessibleName('Show in MindMap');

    fireEvent.click(showBtn);
    expect(onShowAnnotationCard).toHaveBeenCalledWith(highlight.id);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onExcerptAnnotation).not.toHaveBeenCalled();
  });

  it('disables Delete Highlight while the annotation is being excerpted, then confirms once linked (#124)', () => {
    const onDelete = vi.fn();
    const dismiss = vi.fn();
    const { rerender } = render(
      <HighlightHarness cardSource={false} excerpting onDelete={onDelete} dismiss={dismiss} />,
    );

    const deleteBtn = screen.getByTestId('popover-delete');
    expect(deleteBtn).toBeDisabled();
    fireEvent.click(deleteBtn);
    expect(onDelete).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();

    rerender(
      <HighlightHarness cardSource excerpting={false} onDelete={onDelete} dismiss={dismiss} />,
    );
    expect(screen.getByTestId('popover-delete')).toBeEnabled();
    fireEvent.click(screen.getByTestId('popover-delete'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('card-source-delete-confirm')).toBeInTheDocument();
  });

  it('protects unsaved new, edited, or cleared note drafts across click, shortcut, and menu for Excerpt and Show in MindMap (#124)', () => {
    // 1. New note draft on unlinked highlight: click, keyboard shortcut, and menu all keep editor open & warn.
    {
      const onExcerptAnnotation = vi.fn();
      const onUpdate = vi.fn();
      const dismiss = vi.fn();
      const { unmount } = render(
        <HighlightHarness
          cardSource={false}
          onDelete={vi.fn()}
          onUpdate={onUpdate}
          dismiss={dismiss}
          onExcerptAnnotation={onExcerptAnnotation}
        />,
      );

      fireEvent.click(screen.getByTestId('popover-note'));
      const field = screen.getByTestId('popover-note-input');
      fireEvent.change(field, { target: { value: 'Unsaved new note' } });

      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-unsaved-note-warning')).toHaveTextContent(
        /Save or cancel/i,
      );
      expect(field).toHaveValue('Unsaved new note');
      expect(field).toHaveFocus();

      // Same guard for keyboard shortcut and native menu routes.
      forgetRecentCommandRuns();
      act(() => {
        expect(runCommand('edit.excerpt', 'keyboard')).toBe(true);
      });
      forgetRecentCommandRuns();
      act(() => {
        expect(runCommand('edit.excerpt', 'menu')).toBe(true);
      });
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();

      // Saving closes the editor and clears the warning; immediate Excerpt succeeds.
      fireEvent.click(screen.getByTestId('popover-note-save'));
      expect(onUpdate).toHaveBeenCalledWith(highlight.id, {
        note: 'Unsaved new note',
        color: null,
      });
      expect(screen.queryByTestId('popover-unsaved-note-warning')).toBeNull();

      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).toHaveBeenCalledWith(highlight.id);
      expect(dismiss).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 2. Modifying or clearing an existing note blocks Excerpt until saved or cancelled.
    {
      const onExcerptAnnotation = vi.fn();
      const dismiss = vi.fn();
      const { unmount } = render(
        <HighlightHarness
          cardSource={false}
          onDelete={vi.fn()}
          dismiss={dismiss}
          onExcerptAnnotation={onExcerptAnnotation}
          annotationOverride={{ note: 'Existing note' }}
        />,
      );

      fireEvent.click(screen.getByTestId('popover-note-edit'));
      const field = screen.getByTestId('popover-note-input');
      fireEvent.change(field, { target: { value: 'Edited note' } });
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-unsaved-note-warning')).toBeVisible();

      // Clearing the existing note to empty is also an unsaved change.
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-unsaved-note-warning')).toBeVisible();

      // Cancelling discards the draft and clears the warning so Excerpt can proceed.
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('popover-unsaved-note-warning')).toBeNull();
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).toHaveBeenCalledWith(highlight.id);
      unmount();
    }

    // 3. Show in MindMap on an already-linked highlight also protects unsaved note drafts.
    {
      const onShowAnnotationCard = vi.fn();
      const dismiss = vi.fn();
      render(
        <HighlightHarness
          cardSource
          onDelete={vi.fn()}
          dismiss={dismiss}
          onShowAnnotationCard={onShowAnnotationCard}
          annotationOverride={{ note: 'Linked note' }}
        />,
      );

      fireEvent.click(screen.getByTestId('popover-note-edit'));
      const field = screen.getByTestId('popover-note-input');
      fireEvent.change(field, { target: { value: 'Unsaved linked edit' } });

      fireEvent.click(screen.getByTestId('popover-show-in-mindmap'));
      expect(onShowAnnotationCard).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-unsaved-note-warning')).toBeVisible();
      expect(field).toHaveValue('Unsaved linked edit');

      forgetRecentCommandRuns();
      act(() => {
        expect(runCommand('edit.excerpt', 'menu')).toBe(true);
      });
      expect(onShowAnnotationCard).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByTestId('popover-show-in-mindmap'));
      expect(onShowAnnotationCard).toHaveBeenCalledWith(highlight.id);
      expect(dismiss).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the popover editor and draft open when async Save Note fails, and excerpts once on success (#124)', async () => {
    // 1. Save Note fails after immediate Excerpt click -> editor stays open with draft, no excerpt/dismiss; retry succeeds.
    {
      let resolveFirstSave!: (ok: boolean) => void;
      let resolveRetrySave!: (ok: boolean) => void;
      const onUpdate = vi
        .fn<
          (id: string, patch: { note: string | null; color: string | null }) => Promise<boolean>
        >()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              resolveFirstSave = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              resolveRetrySave = resolve;
            }),
        );
      const onExcerptAnnotation = vi.fn();
      const dismiss = vi.fn();

      const { unmount } = render(
        <HighlightHarness
          cardSource={false}
          onDelete={vi.fn()}
          onUpdate={onUpdate}
          dismiss={dismiss}
          onExcerptAnnotation={onExcerptAnnotation}
          annotationOverride={{ note: 'Original note' }}
        />,
      );

      fireEvent.click(screen.getByTestId('popover-note-edit'));
      const field = screen.getByTestId('popover-note-input');
      fireEvent.change(field, { target: { value: 'Revised note' } });
      fireEvent.click(screen.getByTestId('popover-note-save'));

      // Editor stays open while save is in flight; clicking Excerpt queues it without closing yet.
      expect(field.closest('[inert]')).toBeNull();
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-delete')).toBeDisabled();

      // Fail the save: editor stays open with the revised draft intact and focused; no card created.
      await act(async () => {
        resolveFirstSave(false);
      });
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(field.closest('[inert]')).toBeNull();
      expect(field).toHaveValue('Revised note');
      expect(field).toHaveFocus();

      // Clicking Excerpt now without retrying Save still blocks and warns.
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      expect(onExcerptAnnotation).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover-unsaved-note-warning')).toBeVisible();

      // Retry Save Note and immediately click Excerpt -> resolves true -> closes editor, excerpts once, dismisses.
      fireEvent.click(screen.getByTestId('popover-note-save'));
      fireEvent.click(screen.getByTestId('popover-excerpt'));
      await act(async () => {
        resolveRetrySave(true);
      });
      expect(onExcerptAnnotation).toHaveBeenCalledTimes(1);
      expect(onExcerptAnnotation).toHaveBeenCalledWith(highlight.id);
      expect(dismiss).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 2. Save Note succeeds without queued Excerpt -> editor closes only once save confirms.
    {
      let resolveSave!: (ok: boolean) => void;
      const onUpdate = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSave = resolve;
          }),
      );
      render(
        <HighlightHarness
          cardSource={false}
          onDelete={vi.fn()}
          onUpdate={onUpdate}
          dismiss={vi.fn()}
          onExcerptAnnotation={vi.fn()}
          annotationOverride={{ note: 'Original note' }}
        />,
      );

      fireEvent.click(screen.getByTestId('popover-note-edit'));
      const field = screen.getByTestId('popover-note-input');
      fireEvent.change(field, { target: { value: 'Confirmed note' } });
      fireEvent.click(screen.getByTestId('popover-note-save'));
      expect(field.closest('[inert]')).toBeNull();

      await act(async () => {
        resolveSave(true);
      });
      expect(field.closest('[inert]')).not.toBeNull();
    }
  });
});
