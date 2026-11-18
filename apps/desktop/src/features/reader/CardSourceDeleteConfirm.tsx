import { useEffect, useId, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const CARD_SOURCE_DELETE_WARNING =
  'This highlight is the source of a MindMap card. The card stays, but loses its link to this text. Undo brings the link back.';

/**
 * Asks before deleting a highlight a MindMap card cites (#97). Cards cannot be
 * deleted yet, so the reader is told what happens to theirs instead of finding a
 * card that no longer leads anywhere.
 */
export function CardSourceDeleteConfirm({
  onConfirm,
  onCancel,
  keepSelection,
  className,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  /** The popover keeps the reader's text selection through a press. */
  keepSelection?: (event: { preventDefault: () => void }) => void;
  className?: string;
}) {
  const warningId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <div
      role="group"
      aria-label="Confirm delete"
      data-testid="card-source-delete-confirm"
      className={cn('flex max-w-[24rem] flex-col gap-1.5', className)}
      // Esc takes back the question before it closes anything around it.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p id={warningId} className="text-xs text-muted-foreground">
        {CARD_SOURCE_DELETE_WARNING}
      </p>
      <div className="flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          data-testid="card-source-delete-cancel"
          onMouseDown={keepSelection}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          ref={confirmRef}
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs text-destructive hover:text-destructive"
          aria-describedby={warningId}
          data-testid="card-source-delete-confirm-button"
          onMouseDown={keepSelection}
          onClick={onConfirm}
        >
          Delete Highlight
        </Button>
      </div>
    </div>
  );
}
