import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** `Nov 6, 2026`: when a highlight or bookmark was made. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A row's delete control: beside the item, shown on hover or while the row has
 * focus. It is not a tab stop; the keyboard deletes the focused row with ⌫.
 */
export function RowDeleteButton({
  label,
  testId,
  onDelete,
}: {
  label: string;
  testId: string;
  /** Given the button, so the list can keep focus near the removed row. */
  onDelete: (from: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={`${label} (⌫)`}
      data-testid={testId}
      onClick={(event) => onDelete(event.currentTarget)}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity outline-none group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-background hover:text-destructive motion-reduce:transition-none"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

/** What a tab shows with nothing in it, and how to add the first item. */
export function NavigatorEmptyState({
  testId,
  title,
  children,
}: {
  testId?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="px-4 py-6 text-center text-[13px] text-muted-foreground">
      <p className="font-medium text-foreground/80">{title}</p>
      {children && <p className="mt-1 text-xs">{children}</p>}
    </div>
  );
}

export function rowClassName(active: boolean): string {
  return cn(
    'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
  );
}
