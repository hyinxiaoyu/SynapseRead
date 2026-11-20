import { type ReactNode, useEffect, useRef, useState } from 'react';

import { ReaderNotice } from '@/features/reader/ReaderNotice';
import { announceInLiveRegion } from '@/lib/liveRegion';
import { type DeletedCardSnapshot, useStudySyncStore } from '@/stores/useStudySyncStore';

export const CARD_DELETED_MESSAGE = 'Card deleted';

/**
 * A short "Card deleted · Undo" notice after any card deletion, whatever route
 * deleted it, so a deletion is never silent (#123). It offers Undo only while
 * that card is still the one Undo would restore.
 *
 * The visible notice is not what screen readers hear: it mounts with its text,
 * which a live region does not announce. `liveRegion` is mounted empty from the
 * start and stays mounted, and each deletion updates it, as the workspace does
 * for excerpts. Render it once, outside anything that hides or unmounts.
 */
export function useCardDeletedNotice(): { notice: ReactNode; liveRegion: ReactNode } {
  const undoRemoveCard = useStudySyncStore((state) => state.undoRemoveCard);
  const [shown, setShown] = useState<{ snapshot: DeletedCardSnapshot; key: number } | null>(null);
  const liveRegionRef = useRef<HTMLParagraphElement>(null);
  // Counts every announced deletion, so each one gets a fresh notice (and timer)
  // and a fresh announcement, even when the previous notice is already gone.
  const sequence = useRef(0);
  // A failed Undo puts the same snapshot back; it was announced already.
  const announced = useRef(new WeakSet<DeletedCardSnapshot>());

  useEffect(
    () =>
      useStudySyncStore.subscribe((state, previous) => {
        if (state.deletedCardHistory === previous.deletedCardHistory) return;
        const snapshot = state.deletedCardHistory.at(-1);
        if (snapshot && !announced.current.has(snapshot)) {
          announced.current.add(snapshot);
          sequence.current += 1;
          setShown({ snapshot, key: sequence.current });
          return;
        }
        // Undone, rolled back, or overtaken: Undo no longer restores this card.
        setShown((current) => (current && current.snapshot === snapshot ? current : null));
      }),
    [],
  );

  const announcement = shown?.key;
  useEffect(() => {
    const region = liveRegionRef.current;
    if (!region || announcement === undefined) return;
    return announceInLiveRegion(region, CARD_DELETED_MESSAGE);
  }, [announcement]);

  const notice = shown ? (
    <ReaderNotice
      key={`card-deleted-${shown.key}`}
      tone="info"
      testId="card-deleted-notice"
      announce={false}
      action={{
        label: 'Undo',
        onClick: () => {
          setShown(null);
          void undoRemoveCard();
        },
      }}
      onDismiss={() => setShown(null)}
    >
      {CARD_DELETED_MESSAGE}
    </ReaderNotice>
  ) : null;

  const liveRegion = (
    <p
      ref={liveRegionRef}
      data-testid="card-deleted-status"
      role="status"
      aria-atomic="true"
      className="sr-only"
    />
  );

  return { notice, liveRegion };
}
