import type { CSSProperties, RefObject } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shading a `curl` lays over the page. It is a sibling of the animated page,
 * never a child: the EPUB host's children belong to epubjs, and the PDF text and
 * annotation layers must never be transformed. `animatePageTurn` only moves these
 * layers' opacity and scale, so they can never affect hit-testing or selection
 * geometry.
 *
 * Two layers, because a turning leaf is shaded in two places:
 *
 * - `fold` is the curvature of the leaf itself, darkest at the hinge and fading
 *   across the turning half. Live text cannot be deformed without rasterizing it
 *   (`ADR 0005`), so this gradient is what makes the leaf read as paper bending
 *   rather than a flat card rotating.
 * - `cast` is the shadow that leaf throws onto the page beneath it, which is the
 *   half that stays put. `animatePageTurn` clips each layer to its own side, so
 *   neither can spill across the spine.
 *
 * `className` places the overlay, and should match the page rather than the pane
 * around it: a narrow page is centred in a wider container, and a shadow that
 * starts at the container edge lands in the margin instead of on the hinge.
 */
export function PageTurnShadow({
  shadowRef,
  color,
  className,
  style,
}: {
  shadowRef: RefObject<HTMLDivElement | null>;
  /** The theme's spine colour; the gradients themselves are set per turn. */
  color?: string;
  className: string;
  style?: CSSProperties | undefined;
}) {
  return (
    <div
      ref={shadowRef}
      aria-hidden="true"
      data-testid="page-turn-shadow"
      className={cn('pointer-events-none absolute z-10', className)}
      style={
        (color === undefined ? style : { ...style, '--page-turn-shadow': color }) as
          CSSProperties | undefined
      }
    >
      <div aria-hidden="true" data-page-turn-layer="fold" className="absolute inset-0 opacity-0" />
      <div aria-hidden="true" data-page-turn-layer="cast" className="absolute inset-0 opacity-0" />
    </div>
  );
}
