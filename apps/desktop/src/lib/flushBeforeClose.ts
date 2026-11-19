/**
 * Coordinates flushing unsaved UI drafts (such as Inspector card edits) before
 * the window closes, the app quits, or a card is deleted (#117).
 */
export interface BeforeCloseFlusher {
  /** Whether this flusher currently has unsaved or in-flight work. */
  isDirty(): boolean;
  /** Flushes any pending edit and resolves once persisted. */
  flush(): Promise<void>;
}

const flushers = new Set<BeforeCloseFlusher>();

export function registerBeforeCloseFlush(flusher: BeforeCloseFlusher): () => void {
  flushers.add(flusher);
  return () => {
    flushers.delete(flusher);
  };
}

export function hasPendingBeforeCloseFlush(): boolean {
  for (const flusher of flushers) {
    if (flusher.isDirty()) return true;
  }
  return false;
}

export async function flushBeforeClose(): Promise<void> {
  await Promise.allSettled([...flushers].map((flusher) => flusher.flush()));
}
