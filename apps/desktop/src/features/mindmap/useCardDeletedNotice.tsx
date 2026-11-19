import { type ReactNode, useEffect, useRef, useState } from 'react';

import { ReaderNotice } from '@/features/reader/ReaderNotice';
import { type DeletedCardSnapshot, useStudySyncStore } from '@/stores/useStudySyncStore';

/**
 * A short "Card deleted · Undo" notice after any card deletion, whatever route
 * deleted it, so a deletion is never silent (#123). It is announced politely and
 * offers Undo only while that card is still the one Undo would restore.
 */
export function useCardDeletedNotice(): ReactNode {
  const undoRemoveCard = useStudySyncStore((state) => state.undoRemoveCard);
  const [shown, setShown] = useState<{ snapshot: DeletedCardSnapshot; key: number } | null>(null);
  // A failed Undo puts the same snapshot back; it was announced already.
  const announced = useRef(new WeakSet<DeletedCardSnapshot>());

  useEffect(
    () =>
      useStudySyncStore.subscribe((state, previous) => {
        if (state.deletedCardHistory === previous.deletedCardHistory) return;
        const snapshot = state.deletedCardHistory.at(-1);
        if (snapshot && !announced.current.has(snapshot)) {
          announced.current.add(snapshot);
          setShown((current) => ({ snapshot, key: (current?.key ?? 0) + 1 }));
          return;
        }
        // Undone, rolled back, or overtaken: Undo no longer restores this card.
        setShown((current) => (current && current.snapshot === snapshot ? current : null));
      }),
    [],
  );

  if (!shown) return null;
  return (
    <ReaderNotice
      key={shown.key}
      tone="info"
      testId="card-deleted-notice"
      action={{
        label: 'Undo',
        onClick: () => {
          setShown(null);
          void undoRemoveCard();
        },
      }}
      onDismiss={() => setShown(null)}
    >
      Card deleted
    </ReaderNotice>
  );
}
