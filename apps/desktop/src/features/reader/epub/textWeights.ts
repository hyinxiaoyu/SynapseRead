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
  /**
   * Han, kana and Hangul characters, which are read far fewer per minute than
   * alphabetic ones.
   */
  cjk: number;
}

export interface TextWeights {
  readonly sections: readonly SectionTextCount[];
  /** Where each section starts, in characters from the start of the book. */
  readonly starts: readonly number[];
  readonly total: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** The UTF-16 units `/\s/` matches; all are single units, so a unit loop suffices. */
function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Visits each text node a reader sees, in document order.
 * Shared with `epubEngine.ts` so section measurements, `collectText`, and Find
 * walk the exact same nodes under `TEXT_WEIGHT_RULES_VERSION`.
 */
export function forEachReadableText(chapterDoc: Document, visit: (node: Text) => void): void {
  const root = chapterDoc.body ?? chapterDoc.documentElement;
  if (!root) return;
  const walker = chapterDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    const parentTag = textNode.parentElement?.tagName.toLowerCase();
    if (
      parentTag === 'style' ||
      parentTag === 'script' ||
      parentTag === 'noscript' ||
      parentTag === 'title' ||
      textNode.parentElement?.closest('head, style, script, noscript')
    ) {
      continue;
    }
    if (textNode.data) visit(textNode);
  }
}

/**
 * Counts text as a reader reads it, fed one stretch at a time: whitespace runs
 * count once, and none at either end. Measuring a chapter feeds it each text node
 * as it walks the tree, so it never builds the chapter's text.
 *
 * This is the one place "position in a chapter" is defined. Weights, scrubber
 * jumps, and Find marks all count this way, so a jump to a fraction lands where
 * the weights put that fraction (pretty-printed XHTML indentation counts once).
 */
export class TextCounter {
  characters = 0;
  cjk = 0;
  private started = false;
  private pendingSpace = false;

  /** Where the next non-space character would sit, in counted characters. */
  get position(): number {
    return this.characters + (this.pendingSpace ? 1 : 0);
  }

  add(value: string): void {
    this.cjk += value.match(CJK)?.length ?? 0;
    for (let index = 0; index < value.length; index += 1) this.step(value.charCodeAt(index));
  }

  /** Feeds one UTF-16 unit; true when it counts as a character of its own. */
  step(code: number): boolean {
    if (isSpace(code)) {
      if (this.started) this.pendingSpace = true;
      return false;
    }
    if (this.pendingSpace) {
      this.characters += 1;
      this.pendingSpace = false;
    }
    this.characters += 1;
    this.started = true;
    return true;
  }

  result(): SectionTextCount {
    return { characters: this.characters, cjk: this.cjk };
  }
}

/** Counts what a reader reads: whitespace runs as one, none at either end. */
export function countSectionText(text: string): SectionTextCount {
  const counter = new TextCounter();
  counter.add(text);
  return counter.result();
}

/**
 * Where each raw offset into `text` falls in counted characters. `offsets` must
 * be ascending, as search matches are, so the text is walked once.
 */
export function countedOffsets(text: string, offsets: readonly number[]): number[] {
  const counter = new TextCounter();
  const result: number[] = [];
  let raw = 0;
  for (const offset of offsets) {
    const end = Math.min(Math.max(offset, raw), text.length);
    for (; raw < end; raw += 1) counter.step(text.charCodeAt(raw));
    // Trailing whitespace is not counted, so the end is the count itself.
    result.push(raw >= text.length ? counter.characters : counter.position);
  }
  return result;
}

/**
 * The raw offset into `text` of the counted character at `target`, the inverse
 * of `countedOffsets`: where a jump to a fraction of the chapter should land.
 * Past the end it is the last character.
 */
export function rawOffsetOfCounted(text: string, target: number): number {
  const counter = new TextCounter();
  let last = 0;
  for (let raw = 0; raw < text.length; raw += 1) {
    const at = counter.position;
    if (counter.step(text.charCodeAt(raw))) {
      if (at >= target) return raw;
      last = raw;
    }
  }
  return last;
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
 * and Japanese, about 260 to 360 characters a minute. Korean Hangul uses the CJK
 * rate too: a syllable block is read far slower than a Latin letter, and no rate
 * of its own is sourced yet, so this errs toward more minutes rather than fewer.
 * A rough guide by design: the readout says "about".
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

/**
 * Version of the section counting rules (`TextCounter`, `isSpace`, `CJK`, and
 * `forEachReadableText`). Bump this whenever any of those rules change so old
 * cached section weights are treated as misses rather than mixing metrics (#68).
 */
export const TEXT_WEIGHT_RULES_VERSION = 1;

/**
 * Outer map storage key (`synapseread.epubTextWeights.v1`); per-entry counting
 * compatibility is versioned by `TEXT_WEIGHT_RULES_VERSION` above.
 */
const CACHE_KEY = 'synapseread.epubTextWeights.v1';
/** Enough for a reader's current shelf; each entry is a few bytes per chapter. */
const CACHE_LIMIT = 40;

interface CachedBookEntry {
  at: number;
  rules?: number;
  sections: [number, number][];
}

type CachedBooks = Record<string, CachedBookEntry>;

function readCache(): CachedBooks {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CachedBooks)
      : {};
  } catch {
    return {};
  }
}

/**
 * A book's measured text from an earlier open, so reopening it shows the
 * text-based percentage at once instead of re-measuring every chapter. Keyed by
 * the file's content hash, so a changed file is measured afresh. Refreshes `at`
 * on a hit for true LRU eviction (#67). Null when there is none, the rules
 * version differs (#68), or the entry does not fit this book.
 */
export function readCachedWeights(
  fileHash: string,
  sectionCount: number,
  now = Date.now(),
): TextWeights | null {
  const books = readCache();
  const entry = books[fileHash];
  if (!entry || entry.rules !== TEXT_WEIGHT_RULES_VERSION) return null;
  const sections = entry.sections;
  if (!Array.isArray(sections) || sections.length !== sectionCount) return null;
  const counts: SectionTextCount[] = [];
  for (const pair of sections) {
    const [characters, cjk] = Array.isArray(pair) ? pair : [];
    if (
      typeof characters !== 'number' ||
      typeof cjk !== 'number' ||
      !Number.isFinite(characters) ||
      !Number.isFinite(cjk) ||
      characters < 0 ||
      cjk < 0
    ) {
      return null;
    }
    counts.push({ characters, cjk });
  }
  try {
    books[fileHash] = { ...entry, at: now };
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(books));
  } catch {
    // Storage can be full or read-only; the validated hit is still usable.
  }
  return buildTextWeights(counts);
}

/** Remembers a measured book, dropping the least recently used past the limit. */
export function writeCachedWeights(fileHash: string, weights: TextWeights, now = Date.now()): void {
  try {
    const books = readCache();
    books[fileHash] = {
      at: now,
      rules: TEXT_WEIGHT_RULES_VERSION,
      sections: weights.sections.map((count) => [count.characters, count.cjk]),
    };
    const kept = Object.entries(books)
      .sort(([, one], [, two]) => (two.at ?? 0) - (one.at ?? 0))
      .slice(0, CACHE_LIMIT);
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage can be full or disabled; the book is simply measured again next time.
  }
}
