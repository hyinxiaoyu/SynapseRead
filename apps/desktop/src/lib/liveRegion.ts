/** How long a live region stays empty before it is repopulated. */
export const LIVE_REGION_REPOPULATE_MS = 30;

/**
 * Puts `text` into a live region that is mounted (empty) from startup. Screen
 * readers announce a change to an existing region, not a region that appears
 * with its text, and they ignore a write of the text already there. So a region
 * that already has text is cleared first and repopulated a moment later, which
 * makes a repeat of the same message announce again (WCAG ARIA22).
 *
 * Returns a cleanup that cancels a pending repopulate, for an effect to return.
 */
export function announceInLiveRegion(region: HTMLElement, text: string): (() => void) | undefined {
  if (region.textContent === '') {
    region.textContent = text;
    return undefined;
  }
  region.textContent = '';
  const timer = window.setTimeout(() => {
    region.textContent = text;
  }, LIVE_REGION_REPOPULATE_MS);
  return () => window.clearTimeout(timer);
}
