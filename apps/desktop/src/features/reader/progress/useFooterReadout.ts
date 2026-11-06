import { useCallback, useState } from 'react';

/**
 * What the footer says about progress. Each format offers the ones it can
 * compute; `remaining` needs pages and chapters, so plain text has none.
 */
export type FooterReadout = 'remaining' | 'position' | 'percent';

export const FOOTER_READOUTS: readonly FooterReadout[] = ['remaining', 'position', 'percent'];

export type FooterReadouts = Partial<Record<FooterReadout, string>>;

const STORAGE_KEY = 'synapseread.footer.v1';

/** A layout preference like the sidebar's: it stays in this webview's storage. */
function readStored(): FooterReadout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const readout = (parsed as { readout?: unknown } | null)?.readout;
    return FOOTER_READOUTS.includes(readout as FooterReadout)
      ? (readout as FooterReadout)
      : 'remaining';
  } catch {
    return 'remaining';
  }
}

function writeStored(readout: FooterReadout) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ readout }));
  } catch {
    // Storage can be full or disabled; the choice still holds for this session.
  }
}

/** The readout shown when `chosen` is not available: the next one that is. */
export function availableReadout(
  chosen: FooterReadout,
  readouts: FooterReadouts,
): FooterReadout | null {
  const start = FOOTER_READOUTS.indexOf(chosen);
  for (let step = 0; step < FOOTER_READOUTS.length; step += 1) {
    const candidate = FOOTER_READOUTS[(start + step) % FOOTER_READOUTS.length];
    if (candidate && readouts[candidate] !== undefined) return candidate;
  }
  return null;
}

/** The readout after `current` that this document offers. */
export function nextReadout(current: FooterReadout, readouts: FooterReadouts): FooterReadout {
  const start = FOOTER_READOUTS.indexOf(current);
  for (let step = 1; step <= FOOTER_READOUTS.length; step += 1) {
    const candidate = FOOTER_READOUTS[(start + step) % FOOTER_READOUTS.length];
    if (candidate && readouts[candidate] !== undefined) return candidate;
  }
  return current;
}

/** The chosen readout, shared by every reader and remembered between launches. */
export function useFooterReadout() {
  const [readout, setReadout] = useState<FooterReadout>(readStored);
  const choose = useCallback((next: FooterReadout) => {
    setReadout(next);
    writeStored(next);
  }, []);
  return { readout, choose };
}
