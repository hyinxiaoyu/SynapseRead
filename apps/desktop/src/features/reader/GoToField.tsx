import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';

import { commandTooltip } from '@/features/commands/commands';
import { cn } from '@/lib/utils';

/** A place a Go To box was asked for, before the reader resolves it. */
export type GoToTarget = { kind: 'line'; line: number } | { kind: 'percent'; percent: number };

/** A percentage, with a decimal point or comma: `12`, `12.5`, `12,5`. */
const PERCENT = '\\d{1,3}(?:[.,]\\d+)?';
const PERCENT_SIGNED = new RegExp(`^(${PERCENT})\\s*[%％]$`, 'u');
const PERCENT_BARE = new RegExp(`^${PERCENT}$`, 'u');

const toPercent = (text: string): GoToTarget | null => {
  const value = Number(text.replace(',', '.'));
  return value <= 100 ? { kind: 'percent', percent: value } : null;
};

/**
 * Reads what was typed into a Go To box: `45%` is a percentage, and a bare number
 * is a line where the format has lines, else a percentage. Null if it is neither.
 */
export function parseGoToInput(text: string, bareNumber: 'line' | 'percent'): GoToTarget | null {
  const trimmed = text.trim();
  const percent = PERCENT_SIGNED.exec(trimmed);
  if (percent) return toPercent(percent[1] as string);
  // Where a bare number is a percentage, it takes decimals as `12.5%` does.
  if (bareNumber === 'percent') return PERCENT_BARE.test(trimmed) ? toPercent(trimmed) : null;
  if (!/^\d{1,12}$/u.test(trimmed)) return null;
  const line = Number(trimmed);
  return line >= 1 ? { kind: 'line', line } : null;
}

/**
 * Focuses a Go To box with its text selected: what `go.page` does.
 *
 * In focus mode the idle toolbar is `inert`, and a browser ignores `focus()` inside
 * an inert subtree. `go.page` reveals the toolbar (its box declares the command),
 * but that is a state change, so focusing waits for the commit that clears `inert`.
 */
export function useGoToField() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    if (focusNonce === 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);
  return { inputRef, focus: () => setFocusNonce((nonce) => nonce + 1) };
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
        data-command="go.page"
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
