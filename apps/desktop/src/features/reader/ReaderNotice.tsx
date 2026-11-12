import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

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
  if (hidden) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 top-2 z-30 flex flex-col items-end gap-2 *:pointer-events-auto *:w-full *:max-w-xl *:animate-in *:overflow-hidden *:rounded-lg *:border *:shadow-lg *:animation-duration-150 *:fade-in-0 *:slide-in-from-top-1 *:motion-reduce:animate-none">
      {children}
    </div>
  );
}

/**
 * One notice over the page, with a close button. An `info` notice only tells the
 * reader something, so it fades after a few seconds; it waits while the pointer
 * or focus is on it. A `warning` stays until it is closed or no longer true.
 */
export function ReaderNotice({
  tone,
  onDismiss,
  testId,
  children,
}: {
  tone: 'info' | 'warning';
  onDismiss: () => void;
  testId?: string;
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
