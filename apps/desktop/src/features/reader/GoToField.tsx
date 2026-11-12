import { type KeyboardEvent, type RefObject, useId, useRef, useState } from 'react';

import { commandTooltip } from '@/features/commands/commands';
import { cn } from '@/lib/utils';

/** A place a Go To box was asked for, before the reader resolves it. */
export type GoToTarget = { kind: 'line'; line: number } | { kind: 'percent'; percent: number };

/**
 * Reads what was typed into a Go To box: `45%` is a percentage, and a bare number
 * is a line where the format has lines, else a percentage. Null if it is neither.
 */
export function parseGoToInput(text: string, bareNumber: 'line' | 'percent'): GoToTarget | null {
  const trimmed = text.trim();
  const percent = /^(\d{1,3}(?:[.,]\d+)?)\s*[%％]$/u.exec(trimmed);
  if (percent) {
    const value = Number((percent[1] as string).replace(',', '.'));
    return value <= 100 ? { kind: 'percent', percent: value } : null;
  }
  const number = /^\d{1,12}$/u.exec(trimmed);
  if (!number) return null;
  const value = Number(number[0]);
  if (bareNumber === 'percent') return value <= 100 ? { kind: 'percent', percent: value } : null;
  return value >= 1 ? { kind: 'line', line: value } : null;
}

/** Focuses a Go To box with its text selected: what `go.page` does. */
export function useGoToField() {
  const inputRef = useRef<HTMLInputElement>(null);
  return {
    inputRef,
    focus: () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    },
  };
}

/**
 * The compact Go To box for formats without a page field (EPUB, TXT). Return goes
 * and gives the page back the keyboard; Esc gives it back without going. A value
 * the reader cannot reach stays, marked invalid, so it can be corrected.
 */
export function GoToField({
  inputRef,
  label,
  tooltipLabel,
  placeholder,
  disabled = false,
  onGo,
  onReturnFocus,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  /** The accessible name, which says what the box accepts. */
  label: string;
  /** The tooltip before its shortcut. */
  tooltipLabel: string;
  placeholder: string;
  disabled?: boolean;
  /** Goes to what was typed; false if it names nowhere in the document. */
  onGo: (text: string) => boolean;
  onReturnFocus: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const reset = () => {
    setValue('');
    setInvalid(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (value.trim() === '') {
        onReturnFocus();
        return;
      }
      if (!onGo(value)) {
        setInvalid(true);
        event.currentTarget.select();
        return;
      }
      reset();
      onReturnFocus();
    } else if (event.key === 'Escape') {
      // Handled here, so the Esc layers below (focus mode) do not also take it.
      event.preventDefault();
      reset();
      onReturnFocus();
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        data-testid="go-to-input"
        aria-invalid={invalid}
        title={commandTooltip(tooltipLabel, 'go.page')}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={reset}
        className={cn(
          'h-6 w-20 rounded-md border bg-background px-1.5 text-center text-[11px] text-foreground tabular-nums outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          invalid && 'border-destructive text-destructive',
        )}
      />
    </div>
  );
}
