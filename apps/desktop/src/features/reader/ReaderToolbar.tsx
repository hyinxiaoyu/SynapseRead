import { ArrowLeft, ArrowRight, ChevronsRight, type LucideIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { type CommandId, commandTooltip } from '@/features/commands/commands';
import { cn } from '@/lib/utils';
import { useDismissOnOutside } from '@/features/reader/useDismissOnOutside';

/**
 * Where the active reader's controls render. The workspace's unified toolbar
 * provides the slots; a viewer rendered on its own (tests, a future detached
 * window) gets an inline toolbar instead.
 */
export interface ToolbarSlots {
  leading: HTMLElement | null;
  center: HTMLElement | null;
  trailing: HTMLElement | null;
}

export const ToolbarSlotsContext = createContext<ToolbarSlots | null>(null);

/**
 * Below which toolbar width (a container query on the toolbar) an item moves
 * into the `»` overflow menu. The toolbar never wraps to a second line.
 */
export type ToolbarCollapse = 'md' | 'lg' | 'xl';

// Literal class names so Tailwind generates them.
const HIDE_WHEN_NARROW: Record<ToolbarCollapse, string> = {
  md: '@max-5xl/toolbar:hidden',
  lg: '@max-6xl/toolbar:hidden',
  xl: '@max-7xl/toolbar:hidden',
};
const SHOW_WHEN_NARROW: Record<ToolbarCollapse, string> = {
  md: '@5xl/toolbar:hidden',
  lg: '@6xl/toolbar:hidden',
  xl: '@7xl/toolbar:hidden',
};
const COLLAPSE_ORDER: readonly ToolbarCollapse[] = ['md', 'lg', 'xl'];

export function collapseClass(collapse: ToolbarCollapse | undefined): string | undefined {
  return collapse ? HIDE_WHEN_NARROW[collapse] : undefined;
}

export function ReaderToolbar({
  isActive,
  leading,
  center,
  trailing,
}: {
  isActive: boolean;
  leading?: ReactNode;
  center?: ReactNode;
  trailing?: ReactNode;
}) {
  const slots = useContext(ToolbarSlotsContext);
  if (slots) {
    // Hidden tabs stay mounted; only the active one owns the toolbar.
    if (!isActive) return null;
    return (
      <>
        {slots.leading && leading ? createPortal(leading, slots.leading) : null}
        {slots.center && center ? createPortal(center, slots.center) : null}
        {slots.trailing && trailing ? createPortal(trailing, slots.trailing) : null}
      </>
    );
  }
  return (
    <div
      data-testid="reader-toolbar"
      className="@container/toolbar flex h-10 shrink-0 items-center gap-3 border-b bg-background px-2 text-foreground"
    >
      <div className="flex shrink-0 items-center gap-1">{leading}</div>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">{center}</div>
      <div className="flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

export function ToolbarSeparator({ collapse }: { collapse?: ToolbarCollapse }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn('mx-1.5 h-5 w-px shrink-0 bg-border', collapseClass(collapse))}
    />
  );
}

/**
 * The unified toolbar's height. In focus mode it floats over the page, so a paged
 * reader keeps this much of the top clear for it.
 */
export const TOOLBAR_HEIGHT_PX = 48;

export interface ToolbarButtonProps {
  icon: LucideIcon;
  /** The accessible name, and the tooltip before its shortcut. */
  label: string;
  command?: CommandId;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
  badge?: number;
  badgeTestId?: string;
  collapse?: ToolbarCollapse;
  /** Keeps the reader's text selection alive through the click. */
  preserveSelection?: boolean;
  className?: string;
  /** For a button that opens a popover. */
  ariaHasPopup?: 'dialog' | 'menu';
  ariaExpanded?: boolean;
}

/** An icon-only toolbar control: tooltip with its shortcut, and an accessible name. */
export function ToolbarButton({
  icon: Icon,
  label,
  command,
  pressed,
  disabled = false,
  onClick,
  testId,
  badge,
  badgeTestId,
  collapse,
  preserveSelection = false,
  className,
  ariaHasPopup,
  ariaExpanded,
}: ToolbarButtonProps) {
  return (
    <Button
      variant={pressed ? 'selected' : 'ghost'}
      size="icon"
      className={cn('relative size-7', collapseClass(collapse), className)}
      aria-label={label}
      // A popover trigger reports open or closed, not pressed.
      aria-pressed={ariaExpanded === undefined ? pressed : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      title={command ? commandTooltip(label, command) : label}
      data-testid={testId}
      data-command={command}
      disabled={disabled}
      onMouseDown={preserveSelection ? (event) => event.preventDefault() : undefined}
      onClick={onClick}
    >
      <Icon />
      {badge !== undefined && badge > 0 && (
        <span
          data-testid={badgeTestId}
          className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground tabular-nums"
        >
          {badge}
        </span>
      )}
    </Button>
  );
}

export interface OverflowItem {
  label: string;
  collapse: ToolbarCollapse;
  onSelect: () => void;
  disabled?: boolean;
  /** For toggles: rendered as a checked menu item. */
  pressed?: boolean;
}

/**
 * `»`: the items the toolbar hides at its current width. Each item shows here
 * exactly when its toolbar button is hidden, using the same container queries.
 */
export function ToolbarOverflowMenu({ items }: { items: readonly OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const widest = COLLAPSE_ORDER.findLast((collapse) =>
    items.some((item) => item.collapse === collapse),
  );

  useDismissOnOutside(open, () => setOpen(false), { rootRef });

  if (!widest) return null;
  return (
    <div ref={rootRef} className={cn('relative', SHOW_WHEN_NARROW[widest])}>
      <Button
        variant={open ? 'selected' : 'ghost'}
        size="icon"
        className="size-7"
        aria-label="More toolbar items"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More toolbar items"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronsRight />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="More toolbar items"
          data-reader-popover=""
          className="absolute top-full right-0 z-50 mt-1 min-w-44 origin-top-right animate-in rounded-md border bg-background p-1 text-xs text-foreground shadow-lg duration-150 fade-in-0 slide-in-from-top-1 zoom-in-[0.96] motion-reduce:animate-none"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.pressed === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.pressed}
              disabled={item.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50',
                SHOW_WHEN_NARROW[item.collapse],
              )}
            >
              {item.label}
              {item.pressed && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The document title, and under it the chapter being read (Preview's window
 * subtitle). Progress itself lives in the footer under the page.
 */
export function ToolbarTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center leading-tight">
      <span
        data-testid="reader-toolbar-title"
        className="max-w-full truncate text-xs font-semibold"
      >
        {title}
      </span>
      {subtitle && (
        <span
          data-testid="reader-toolbar-subtitle"
          title={typeof subtitle === 'string' ? subtitle : undefined}
          className="max-w-full truncate text-[11px] text-muted-foreground"
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}

/** Back and Forward through jump history; each appears once it has somewhere to go. */
export function HistoryButtons({
  canGoBack,
  canGoForward,
  disabled = false,
  onBack,
  onForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  disabled?: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  if (!canGoBack && !canGoForward) return null;
  return (
    <>
      <ToolbarSeparator />
      {canGoBack && (
        <ToolbarButton
          icon={ArrowLeft}
          label="Return to previous location"
          command="go.back"
          disabled={disabled}
          onClick={onBack}
        />
      )}
      {canGoForward && (
        <ToolbarButton
          icon={ArrowRight}
          label="Go forward"
          command="go.forward"
          disabled={disabled}
          onClick={onForward}
        />
      )}
    </>
  );
}
