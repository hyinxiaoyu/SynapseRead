import { X } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

type RegisterPopoverLayer = (element: HTMLDivElement | null) => void;

const ReaderPopoverSlotContext = createContext<RegisterPopoverLayer | null>(null);

/**
 * Gives a viewer's `ReaderPopoverLayer` to its parent `ReaderPane` so workspace
 * notices can join the active tab's notice stack instead of overlapping it.
 */
export function ReaderPopoverSlotProvider({
  register,
  children,
}: {
  register: RegisterPopoverLayer;
  children: ReactNode;
}) {
  return (
    <ReaderPopoverSlotContext.Provider value={register}>
      {children}
    </ReaderPopoverSlotContext.Provider>
  );
}

/** How long an informational notice stays before it fades on its own. */
export const INFO_NOTICE_MS = 6000;
/** The fade itself; reduced motion skips the transition but keeps the wait. */
export const NOTICE_FADE_MS = 300;

/**
 * Notices float over the page as popovers instead of stacking strips above it,
 * so the reading area never jumps. Focus mode keeps the page clear: notices wait,
 * and show again (with a fresh timer) once it ends.
 */
export function ReaderPopoverLayer({
  hidden = false,
  children,
}: {
  hidden?: boolean;
  children: ReactNode;
}) {
  const register = useContext(ReaderPopoverSlotContext);
  if (hidden) return null;
  return (
    <div
      ref={register ?? undefined}
      className="pointer-events-none absolute inset-x-3 top-2 z-30 flex flex-col items-end gap-2 *:pointer-events-auto *:w-full *:max-w-xl *:animate-in *:overflow-hidden *:rounded-lg *:border *:shadow-lg *:animation-duration-150 *:fade-in-0 *:slide-in-from-top-1 *:motion-reduce:animate-none"
    >
      {children}
    </div>
  );
}

/**
 * One notice over the page, with a close button. An `info` notice only tells the
 * reader something, so it fades after a few seconds; it waits while the pointer
 * or focus is on it. A `warning` stays until it is closed or no longer true.
 * An `action` is a button beside the message, outside the announced text.
 */
export function ReaderNotice({
  tone,
  onDismiss,
  testId,
  action,
  children,
}: {
  tone: 'info' | 'warning';
  onDismiss: () => void;
  testId?: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const [fading, setFading] = useState(false);
  const latestDismiss = useRef(onDismiss);
  useEffect(() => {
    latestDismiss.current = onDismiss;
  });

  const waiting = tone === 'info' && !held.pointer && !held.focus;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setFading(true), INFO_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => latestDismiss.current(), NOTICE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [fading]);

  // Reaching for the notice brings it back from a fade and holds it.
  const hold = (key: 'pointer' | 'focus', value: boolean) => {
    setHeld((current) => ({ ...current, [key]: value }));
    if (value) setFading(false);
  };

  return (
    <div
      data-testid={testId}
      data-tone={tone}
      data-fading={fading || undefined}
      onPointerEnter={() => hold('pointer', true)}
      onPointerLeave={() => hold('pointer', false)}
      onFocus={() => hold('focus', true)}
      onBlur={() => hold('focus', false)}
      className={cn(
        'flex items-start gap-2 bg-muted py-1 pr-1 pl-4 text-xs text-foreground transition-opacity motion-reduce:transition-none',
        fading && 'opacity-0',
      )}
      style={{ transitionDuration: `${NOTICE_FADE_MS}ms` }}
    >
      <p role="status" className="min-w-0 flex-1 py-0.5">
        {children}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Close notice"
        title="Close notice"
        onClick={onDismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
