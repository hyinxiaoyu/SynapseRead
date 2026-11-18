import type { PageTransition, ReadingPreferences, ScrollPageTransition } from '@/types/domain';

export interface PageTransitionOption<T extends PageTransition = PageTransition> {
  readonly value: T;
  readonly label: string;
}

export const PAGE_TRANSITIONS: readonly PageTransitionOption<PageTransition>[] = [
  { value: 'none', label: 'None' },
  { value: 'slide', label: 'Slide' },
  { value: 'fade', label: 'Fade' },
  { value: 'curl', label: 'Curl' },
  { value: 'stack', label: 'Stack' },
];

export const SCROLL_PAGE_TRANSITIONS: readonly PageTransitionOption<ScrollPageTransition>[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
];

export type TransitionPreferences = Pick<ReadingPreferences, 'pageTransition'> & {
  scrollPageTransition?: ScrollPageTransition | null | undefined;
};

/**
 * Resolves the active transition for continuous-scrolling modes: an explicit
 * `scrollPageTransition` wins; otherwise `'none'` stays `'none'` and any
 * paginated effect becomes `'fade'`.
 */
export function resolveScrollTransition(preferences: TransitionPreferences): ScrollPageTransition {
  if (preferences.scrollPageTransition === 'none' || preferences.scrollPageTransition === 'fade') {
    return preferences.scrollPageTransition;
  }
  return preferences.pageTransition === 'none' ? 'none' : 'fade';
}

/**
 * Resolves the effective page-turn transition for either paginated or
 * continuous-scrolling layouts without mutating the other mode's preference.
 */
export function resolvePageTransition(
  preferences: TransitionPreferences,
  { scrolled }: { scrolled: boolean },
): PageTransition {
  return scrolled ? resolveScrollTransition(preferences) : preferences.pageTransition;
}
