import type { CSSProperties, RefObject } from 'react';

import { type PaperCurlPalette, paperCurlVariables } from '@/features/reader/appearance/themes';
import { cn } from '@/lib/utils';

/**
 * The four coordinated CSS layers that render a conical paper-curl peel over
 * stationary outgoing and incoming pages. It is always a sibling above the page
 * surface—never a child of EPUB iframes or PDF text layers—and only toggles
 * layer opacity, clip-paths, and gradients so hit-testing and text selection
 * geometry never drift.
 *
 * Layers sit in physical back-to-front order:
 * - `cast-shadow`: soft penumbra cast onto the revealed incoming page beneath.
 * - `under-shadow`: tight ambient occlusion ahead of the lifted free edge on
 *   the unpeeled outgoing page.
 * - `spine`: dynamic 50% binding gutter valley active in two-page spreads.
 * - `leaf`: conical folded paper backside with cylinder highlight, roll-off,
 *   lifted rim bevel, and faint reverse bleed-through.
 *
 * `className` and `style` should match the active page/spread bounds so the
 * crease, shadows, and 50% spine align with the paper rather than outer margins.
 */
export function PageTurnShadow({
  shadowRef,
  palette,
  className,
  style,
}: {
  shadowRef: RefObject<HTMLDivElement | null>;
  /** Theme-calibrated paper stock and optical shadow tokens. */
  palette?: PaperCurlPalette | undefined;
  className: string;
  style?: CSSProperties | undefined;
}) {
  const mergedStyle =
    palette === undefined && style === undefined
      ? undefined
      : ({
          ...style,
          ...(palette === undefined ? {} : paperCurlVariables(palette)),
        } as CSSProperties);

  return (
    <div
      ref={shadowRef}
      aria-hidden="true"
      data-testid="page-turn-shadow"
      className={cn('pointer-events-none absolute z-20 overflow-hidden', className)}
      style={mergedStyle}
    >
      <div aria-hidden="true" data-curl-part="cast-shadow" className="absolute inset-0 opacity-0" />
      <div
        aria-hidden="true"
        data-curl-part="under-shadow"
        className="absolute inset-0 opacity-0"
      />
      <div
        aria-hidden="true"
        data-curl-part="spine"
        className="absolute inset-y-0 left-[44%] w-[12%] opacity-0"
      />
      <div aria-hidden="true" data-curl-part="leaf" className="absolute inset-0 opacity-0" />
    </div>
  );
}
