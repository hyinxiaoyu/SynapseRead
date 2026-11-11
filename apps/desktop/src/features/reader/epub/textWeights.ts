/**
 * How much text each spine section holds, and the book positions that follow.
 *
 * epub.js knows a book only as a list of files, so a reader that treats each one
 * as an equal share puts Chapter 1 of a book with ten short front-matter files
 * at 25% (#52). Weighting each file by its characters makes the percentage, the
 * scrubber, and the chapter ticks say how much of the text lies behind the reader.
 *
 * Nothing here touches epub.js: the engine measures a section, this module turns
 * the measurements into positions.
 */

/** One section's readable text, with whitespace runs counted once. */
export interface SectionTextCount {
  characters: number;
  /** Han and kana characters, which are read far fewer per minute. */
  cjk: number;
}

export interface TextWeights {
  readonly sections: readonly SectionTextCount[];
  /** Where each section starts, in characters from the start of the book. */
  readonly starts: readonly number[];
  readonly total: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** Counts what a reader reads: whitespace runs as one, none at either end. */
export function countSectionText(text: string): SectionTextCount {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return { characters: collapsed.length, cjk: collapsed.match(CJK)?.length ?? 0 };
}

/**
 * Every section weighs at least one character, so an image-only cover still has
 * a place of its own and positions stay strictly ordered.
 */
const weightOf = (count: SectionTextCount) => Math.max(count.characters, 1);

export function buildTextWeights(sections: readonly SectionTextCount[]): TextWeights {
  const starts: number[] = [];
  let total = 0;
  for (const section of sections) {
    starts.push(total);
    total += weightOf(section);
  }
  return { sections, starts, total };
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * The share of the book before a point `within` (`0..1`) of a section. Without
 * weights every section is an equal share, which is what the reader shows while
 * the measuring pass is still running.
 */
export function bookFraction(
  weights: TextWeights | null,
  sectionCount: number,
  index: number,
  within: number,
): number {
  if (sectionCount <= 0) return 0;
  const section = Math.min(Math.max(index, 0), sectionCount - 1);
  const section01 = clamp01(within);
  const count = weights?.sections[section];
  const start = weights?.starts[section];
  if (!weights || weights.total <= 0 || count === undefined || start === undefined) {
    return (section + section01) / sectionCount;
  }
  return clamp01((start + weightOf(count) * section01) / weights.total);
}

/** The section holding a book fraction, and how far into that section it is. */
export function locateBookFraction(
  weights: TextWeights | null,
  sectionCount: number,
  fraction: number,
): { index: number; within: number } {
  if (sectionCount <= 0) return { index: 0, within: 0 };
  const at = clamp01(fraction);
  if (!weights || weights.total <= 0 || weights.sections.length !== sectionCount) {
    const scaled = at * sectionCount;
    const index = Math.min(Math.floor(scaled), sectionCount - 1);
    return { index, within: clamp01(scaled - index) };
  }
  const target = at * weights.total;
  // The last section that starts at or before the target; binary search, since a
  // drag asks this on every pointer move.
  let low = 0;
  let high = sectionCount - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((weights.starts[middle] ?? Infinity) <= target) low = middle;
    else high = middle - 1;
  }
  const count = weights.sections[low];
  const start = weights.starts[low] ?? 0;
  const within = count ? clamp01((target - start) / weightOf(count)) : 0;
  return { index: low, within };
}

/**
 * Silent reading speeds from Brysbaert (2019) for English, about 238 words or
 * 1,300 characters a minute, and Trauzettel-Klosinski et al. (2012) for Chinese
 * and Japanese, about 260 to 360 characters a minute. A rough guide by design:
 * the readout says "about".
 */
export const ALPHABETIC_CHARS_PER_MINUTE = 1300;
export const CJK_CHARS_PER_MINUTE = 300;

/** Minutes of reading left in a section from a point `within` (`0..1`) of it. */
export function minutesLeftInSection(count: SectionTextCount, within: number): number {
  const left = 1 - clamp01(within);
  const cjk = Math.min(count.cjk, count.characters);
  return (
    (left * (count.characters - cjk)) / ALPHABETIC_CHARS_PER_MINUTE +
    (left * cjk) / CJK_CHARS_PER_MINUTE
  );
}

export function minutesLeftText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'Less than a minute left in chapter';
  const rounded = Math.round(minutes);
  if (rounded < 60) {
    return rounded === 1
      ? 'About 1 minute left in chapter'
      : `About ${rounded} minutes left in chapter`;
  }
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `About ${hours} h${rest > 0 ? ` ${rest} min` : ''} left in chapter`;
}

/** Waits for a moment the page is idle, so measuring never delays a page turn. */
export function whenIdle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      cancel();
      reject(signal.reason);
    };
    const done = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    // WebKit has no `requestIdleCallback`, so WKWebView falls back to a timer.
    const idle = globalThis.requestIdleCallback as
      ((callback: () => void, options?: { timeout: number }) => number) | undefined;
    let cancel: () => void;
    if (typeof idle === 'function') {
      const id = idle(done, { timeout: 1000 });
      cancel = () => globalThis.cancelIdleCallback?.(id);
    } else {
      const id = globalThis.setTimeout(done, IDLE_FALLBACK_MS);
      cancel = () => globalThis.clearTimeout(id);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Without idle callbacks, wait long enough for a page turn's frames to go first. */
const IDLE_FALLBACK_MS = 50;

/**
 * Measures every section in order, one per idle moment, and resolves with the
 * weights. Rejects with the abort reason once `signal` aborts, so a closed book
 * stops loading chapters at once. A section that cannot be read weighs nothing
 * rather than stopping the pass.
 */
export async function measureBook(
  sectionCount: number,
  measure: (index: number) => Promise<SectionTextCount | null>,
  signal: AbortSignal,
  idle: (signal: AbortSignal) => Promise<void> = whenIdle,
): Promise<TextWeights> {
  const sections: SectionTextCount[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    await idle(signal);
    let count: SectionTextCount | null;
    try {
      count = await measure(index);
    } catch {
      count = null;
    }
    signal.throwIfAborted();
    sections.push(count ?? { characters: 0, cjk: 0 });
  }
  return buildTextWeights(sections);
}
