import { ChevronLeft, ChevronRight } from 'lucide-react';

import { commandTooltip } from '@/features/commands/commands';
import { cn } from '@/lib/utils';

function Chevron({
  side,
  disabled,
  onClick,
}: {
  side: 'previous' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  const label = side === 'previous' ? 'Previous Page' : 'Next Page';
  const Icon = side === 'previous' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      title={commandTooltip(label, side === 'previous' ? 'go.previousPage' : 'go.nextPage')}
      data-testid={`page-turn-${side}`}
      disabled={disabled}
      // Keeps a text selection alive, and the page keeps keyboard focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'pointer-events-auto absolute top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border bg-background/90 text-foreground shadow-sm transition-opacity duration-150 outline-none motion-reduce:transition-none',
        'opacity-0 group-hover/page:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
        'hover:bg-accent disabled:pointer-events-none disabled:opacity-0',
        side === 'previous' ? 'left-2' : 'right-2',
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
    </button>
  );
}

/**
 * Previous and Next beside the page, shown while the pointer is over it (or a
 * key focuses them), like the arrows at the edges of a Books page.
 */
export function PageTurnChevrons({
  onPrevious,
  onNext,
  disabled = false,
}: {
  onPrevious: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Chevron side="previous" disabled={disabled} onClick={onPrevious} />
      <Chevron side="next" disabled={disabled} onClick={onNext} />
    </>
  );
}
