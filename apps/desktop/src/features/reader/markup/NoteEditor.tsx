import type { FocusEvent, KeyboardEvent, Ref } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Keeps focus (and the reader's selection) where it is through a press on a button. */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

/**
 * The one multi-line note field, shared by the selection popover and the
 * sidebar so a note reads and edits the same everywhere. Return is a new line,
 * as in Notes; ⌘↩ saves. Line breaks are kept as typed.
 */
export function NoteEditor({
  value,
  label,
  formLabel,
  testId,
  formTestId,
  saveTestId,
  fieldRef,
  autoFocus = false,
  className,
  fieldClassName,
  onChange,
  onSave,
  onCancel,
  onBlur,
  onKeyDown,
}: {
  value: string;
  /** The field's accessible name. */
  label: string;
  formLabel: string;
  testId: string;
  formTestId: string;
  saveTestId: string;
  fieldRef?: Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
  className?: string;
  fieldClassName?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <form
      aria-label={formLabel}
      data-testid={formTestId}
      className={cn('flex flex-col gap-1.5', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <textarea
        ref={fieldRef}
        aria-label={label}
        data-testid={testId}
        placeholder="Write a note…"
        rows={3}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
            return;
          }
          onKeyDown?.(event);
        }}
        className={cn(
          'field-sizing-content max-h-48 min-h-[4.5rem] w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
          fieldClassName,
        )}
      />
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onMouseDown={keepFocus}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-6 px-2 text-xs"
          data-testid={saveTestId}
          onMouseDown={keepFocus}
        >
          Save Note
        </Button>
      </div>
    </form>
  );
}
