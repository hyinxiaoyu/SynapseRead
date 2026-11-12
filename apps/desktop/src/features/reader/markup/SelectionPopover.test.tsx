import { fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useAnnotationsController } from '@/features/reader/AnnotationsPanel';
import { SelectionPopover } from '@/features/reader/markup/SelectionPopover';
import type { SelectionPopoverController } from '@/features/reader/markup/useSelectionPopover';
import type { ReaderSelection } from '@/types/domain';

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
  it('disables CSS property transitions so scroll and note growth keep coordinates pinned (#40)', () => {
    render(<Harness />);
    const dialog = screen.getByTestId('selection-popover');
    // `duration-150` drives `@keyframes` entrance via `--tw-duration`; `transition-none`
    // prevents `top`, `left`, and `transform-origin` from rubber-banding over 150ms.
    expect(dialog).toHaveClass('transition-none');
    expect(dialog).toHaveClass('animate-in');

    const noteField = screen.getByTestId('popover-note-input');
    expect(noteField.closest('[inert]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('popover-note'));
    expect(noteField.closest('[inert]')).toBeNull();
  });
});
