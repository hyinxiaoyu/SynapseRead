import { X } from 'lucide-react';
import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.getAttribute('aria-hidden') === 'true') return false;
      if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    },
  );
}

const SIZE_CLASSES = {
  md: 'max-w-xl',
  lg: 'max-w-3xl',
} as const;

export interface LanSyncDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** When false, Escape and backdrop clicks cannot dismiss the dialog (e.g. active transfer). */
  dismissible?: boolean;
  dismissBlockedHint?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  testId: string;
  size?: keyof typeof SIZE_CLASSES;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Reusable accessible modal shell for LAN sync dialogs (`R3-04`, `T-56`).
 * Provides initial focus, Tab/Shift+Tab trapping, focus restoration on close,
 * capture-phase Escape handling, and configurable dismissal lock during transfers.
 */
export function LanSyncDialog({ open, ...rest }: LanSyncDialogProps) {
  if (!open) return null;
  return <LanSyncDialogContent {...rest} />;
}

function LanSyncDialogContent({
  title,
  description,
  onClose,
  dismissible = true,
  dismissBlockedHint,
  initialFocusRef,
  testId,
  size = 'md',
  headerExtra,
  footer,
  children,
}: Omit<LanSyncDialogProps, 'open'>) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const initialFocusRefRef = useRef(initialFocusRef);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    initialFocusRefRef.current = initialFocusRef;
  });

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const requested = initialFocusRefRef.current?.current;
    if (requested && dialog.contains(requested) && !requested.hasAttribute('disabled')) {
      requested.focus({ preventScroll: true });
    } else {
      const focusable = getFocusableElements(dialog);
      const firstTarget = focusable[0] ?? dialog;
      firstTarget.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const openModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (openModals.length > 0 && openModals[openModals.length - 1] !== dialog) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (dismissibleRef.current) {
          onCloseRef.current();
        }
        return;
      }

      if (event.key === 'Tab') {
        const focusable = getFocusableElements(dialog);
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (!(active instanceof Node) || !dialog.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
          return;
        }

        if (event.shiftKey) {
          if (active === first || active === dialog) {
            event.preventDefault();
            last?.focus();
          }
        } else if (active === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    // Capture phase ensures Escape and Tab never leak to Focus Mode or reader panes.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (previousFocused && previousFocused.isConnected) {
        previousFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      data-testid={`${testId}-backdrop`}
      className="fixed inset-0 z-[60] flex animate-in items-center justify-center bg-black/40 p-4 sm:p-6 animation-duration-150 fade-in-0 motion-reduce:animate-none"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (dismissible) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-reader-popover=""
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          'flex max-h-full w-full animate-in flex-col rounded-lg border bg-background text-foreground shadow-xl outline-none animation-duration-150 fade-in-0 zoom-in-95 motion-reduce:animate-none',
          SIZE_CLASSES[size],
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-sm font-semibold text-foreground">
                {title}
              </h2>
              {headerExtra}
            </div>
            {description && (
              <p id={descriptionId} className="text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={`Close ${title}`}
            title={!dismissible && dismissBlockedHint ? dismissBlockedHint : `Close ${title}`}
            disabled={!dismissible}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
