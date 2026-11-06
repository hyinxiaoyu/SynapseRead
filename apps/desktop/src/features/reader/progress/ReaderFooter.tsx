import { Undo2 } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import {
  availableReadout,
  type FooterReadouts,
  nextReadout,
  useFooterReadout,
} from './useFooterReadout';

const READOUT_NAMES = {
  remaining: 'pages left',
  position: 'page number',
  percent: 'percentage',
} as const;

/** A chapter start on the scrubber, as a fraction of the document. */
export interface ScrubberTick {
  position: number;
  label: string;
}

/** What the scrubber needs from a reader; positions are fractions `0..1`. */
export interface ScrubberModel {
  value: number;
  /** Spoken for the current position, e.g. "Chapter 11 of 23, 45%". */
  valueText: string;
  ticks: readonly ScrubberTick[];
  /** The tooltip for a position under the pointer: chapter and location. */
  describe: (fraction: number) => string;
  /** Goes to a position the reader released the scrubber at. */
  onCommit: (fraction: number) => void;
  onStepPage: (direction: 1 | -1) => void;
  onStepChapter: (direction: 1 | -1) => void;
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

function ProgressScrubber({ model, disabled }: { model: ScrubberModel; disabled: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const fractionAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return model.value;
    return clamp01((clientX - rect.left) / rect.width);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    setPreview(fractionAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    setPreview(fractionAt(event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    model.onCommit(fractionAt(event.clientX));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        model.onStepPage(1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        model.onStepPage(-1);
        break;
      case 'PageDown':
        model.onStepChapter(1);
        break;
      case 'PageUp':
        model.onStepChapter(-1);
        break;
      case 'Home':
        model.onCommit(0);
        break;
      case 'End':
        model.onCommit(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const shown = dragging ? (preview ?? model.value) : model.value;
  const tooltipAt = preview ?? (focused ? model.value : null);
  const percent = Math.round(model.value * 100);

  return (
    <div className="relative h-5 w-full">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Reading position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={model.valueText}
        aria-disabled={disabled || undefined}
        data-testid="progress-scrubber"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setDragging(false);
          setPreview(null);
        }}
        onPointerLeave={() => {
          if (!dragging) setPreview(null);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 flex cursor-pointer touch-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative h-1 w-full rounded-full bg-current/20">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-current/70"
            style={{ width: `${shown * 100}%` }}
          />
          {model.ticks.map((tick) => (
            <span
              key={`${tick.position}:${tick.label}`}
              aria-hidden="true"
              data-testid="progress-scrubber-tick"
              className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-current/50"
              style={{ left: `${tick.position * 100}%` }}
            />
          ))}
          <span
            aria-hidden="true"
            className="absolute top-1/2 size-3 -translate-1/2 rounded-full border border-current/40 bg-background shadow-sm"
            style={{ left: `${shown * 100}%` }}
          />
        </div>
      </div>
      {tooltipAt !== null && !disabled && (
        <div
          aria-hidden="true"
          data-testid="progress-scrubber-tooltip"
          className="pointer-events-none absolute bottom-full z-30 mb-1.5 max-w-64 -translate-x-1/2 truncate rounded-md border bg-background px-2 py-1 text-xs text-foreground shadow-md"
          style={{ left: `clamp(4rem, ${tooltipAt * 100}%, calc(100% - 4rem))` }}
        >
          {model.describe(tooltipAt)}
        </div>
      )}
    </div>
  );
}

/**
 * Progress under the page, as in Books: a quiet readout that cycles on click
 * (pages left, page number, percentage), and on hover or focus a scrubber with
 * chapter ticks. After a big jump, a chip leads back.
 */
export function ReaderFooter({
  readouts,
  scrubber,
  backLabel,
  onBack,
  disabled = false,
  className,
  style,
}: {
  readouts: FooterReadouts;
  scrubber: ScrubberModel | null;
  /** "Back to page 12", or null with nowhere to go back to. */
  backLabel: string | null;
  onBack: () => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { readout: chosen, choose } = useFooterReadout();
  const readout = availableReadout(chosen, readouts);
  const text = readout ? readouts[readout] : undefined;
  const following = readout ? nextReadout(readout, readouts) : null;
  const canCycle = following !== null && following !== readout;

  return (
    <div
      role="group"
      aria-label="Reading progress"
      data-testid="reader-footer"
      className={cn(
        'group/footer relative flex h-11 shrink-0 flex-col justify-center gap-0.5 px-6 text-xs',
        className,
      )}
      style={style}
    >
      {scrubber && (
        <div
          className={cn(
            'transition-opacity duration-150 motion-reduce:transition-none',
            'opacity-0 group-hover/footer:opacity-100 group-focus-within/footer:opacity-100',
          )}
        >
          <ProgressScrubber model={scrubber} disabled={disabled} />
        </div>
      )}
      <div className="relative flex h-5 items-center justify-center">
        {backLabel && (
          <button
            type="button"
            data-testid="reader-back-chip"
            onClick={onBack}
            title={backLabel}
            className="absolute left-0 flex h-6 max-w-[40%] items-center gap-1 truncate rounded-full border bg-background px-2.5 text-xs text-foreground shadow-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Undo2 className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{backLabel}</span>
          </button>
        )}
        {text !== undefined && (
          <button
            type="button"
            data-testid="reader-footer-readout"
            data-readout={readout}
            disabled={!canCycle}
            aria-label={canCycle && following ? `${text}. Show ${READOUT_NAMES[following]}` : text}
            title={canCycle && following ? `Show ${READOUT_NAMES[following]}` : undefined}
            onClick={() => {
              if (following) choose(following);
            }}
            className="rounded px-1.5 text-xs tabular-nums outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:no-underline"
          >
            {text}
          </button>
        )}
      </div>
    </div>
  );
}
