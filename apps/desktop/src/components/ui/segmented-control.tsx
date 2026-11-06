import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
  /** Tooltip; defaults to the label. */
  title?: string;
  testId?: string;
}

/**
 * One choice of several, drawn as icon segments (macOS NSSegmentedControl). It is
 * a radio group: one tab stop, arrow keys move and select, Home and End jump.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  disabled = false,
  onChange,
  className,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === null) return;
    event.preventDefault();
    const wrapped = (next + options.length) % options.length;
    const option = options[wrapped];
    if (!option) return;
    onChange(option.value);
    buttons.current[wrapped]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('flex shrink-0 items-center rounded-md bg-muted p-0.5', className)}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            title={option.title ?? option.label}
            data-testid={option.testId}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'flex h-6 w-7 items-center justify-center rounded-[5px] text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-3.5',
              checked
                ? 'bg-background text-foreground shadow-xs'
                : 'hover:text-foreground hover:bg-background/50',
            )}
          >
            <Icon aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
