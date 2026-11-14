import type { CSSProperties, RefObject } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shading a `curl` lays over the page. It is a sibling of the animated page,
 * never a child: the EPUB host's children belong to epubjs, and the PDF text and
 * annotation layers must never be transformed. `animatePageTurn` only moves these
 * layers' opacity and scale, so they can never affect hit-testing or selection
 * geometry.
 *
 * Three layers, because a curling leaf is seen from three sides at once:
 *
 * - `back` is the strip of the leaf that has folded over: the paper's reverse,
 *   lit at its free edge and dark where it meets the fold. It fills the part of
 *   the page the fold has pulled away from, which is what makes the turn read as
 *   paper bending rather than a page being cut.
 * - `fold` is the curvature on the leaf's own face, darkest along the fold line.
 * - `cast` is the shadow the leaf throws on the half that stays put.
 *
 * Live text cannot be deformed without rasterizing it (`ADR 0005`), so the fold is
 * the page's own outline bending — a clip on the leaf, not a mesh — and these
 * gradients are what give that outline a surface. `animatePageTurn` confines every
 * layer to its own side of the spine, so none can spill across it.
 *
 * `className` places the overlay, and should match the page rather than the pane
 * around it: a narrow page is centred in a wider container, and a shadow that
 * starts at the container edge lands in the margin instead of on the hinge.
 */
export function PageTurnShadow({
  shadowRef,
  color,
  paper,
  className,
  style,
}: {
  shadowRef: RefObject<HTMLDivElement | null>;
  /** The theme's spine colour; the gradients themselves are set per turn. */
  color?: string;
  /** The page's own colour, for the reverse of a folded leaf. White by default. */
  paper?: string;
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
        (color === undefined && paper === undefined
          ? style
          : {
              ...style,
              ...(color === undefined ? {} : { '--page-turn-shadow': color }),
              ...(paper === undefined ? {} : { '--page-turn-paper': paper }),
            }) as CSSProperties | undefined
      }
    >
      <div aria-hidden="true" data-page-turn-layer="back" className="absolute inset-0 opacity-0" />
      <div aria-hidden="true" data-page-turn-layer="fold" className="absolute inset-0 opacity-0" />
      <div aria-hidden="true" data-page-turn-layer="cast" className="absolute inset-0 opacity-0" />
    </div>
  );
}
