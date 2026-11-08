import type { CSSProperties, RefObject } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shadow a `flip` casts from its hinge. It is a sibling of the animated
 * page, never a child: the EPUB host's children belong to epubjs, and the PDF
 * text and annotation layers must never be transformed. `animatePageTurn` only
 * moves its opacity, so it can never affect hit-testing or selection geometry.
 */
export function PageTurnShadow({
  shadowRef,
  color,
  className,
}: {
  shadowRef: RefObject<HTMLDivElement | null>;
  /** The theme's spine colour; the gradient itself is set per turn. */
  color?: string;
  className?: string;
}) {
  return (
    <div
      ref={shadowRef}
      aria-hidden="true"
      data-testid="page-turn-shadow"
      className={cn('pointer-events-none absolute inset-0 z-10 opacity-0', className)}
      style={color === undefined ? undefined : ({ '--page-turn-shadow': color } as CSSProperties)}
    />
  );
}
