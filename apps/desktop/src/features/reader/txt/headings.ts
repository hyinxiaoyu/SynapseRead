/**
 * Chapter headings in plain text, found line by line as a file streams in (#52).
 *
 * Plain text declares no structure, so this guesses from the shapes novels use:
 * `Chapter 12`, `CHAPTER XII. The Storm`, `Part II`, `Book One`, `第十二章`, `第三卷`,
 * and short all-caps lines set apart by blank lines. Each guess is cheap and local,
 * because it runs on every line of a file that can be hundreds of megabytes.
 *
 * Two shapes are filtered out. A block of headings with no prose between them is a
 * table of contents, not the chapters themselves. And an all-caps line right after
 * a numbered heading (`CHAPTER I` then `THE STORM`) is that chapter's title.
 */

/** 0 for parts, books and volumes; 1 for chapters. Contents nests 1 under 0. */
export type HeadingLevel = 0 | 1;

/** A heading as the scanner finds it; the model adds where it is in the source. */
export interface ScannedHeading {
  /** The row the heading is on, in the model that found it. */
  row: number;
  label: string;
  level: HeadingLevel;
  /**
   * Follows another heading with no prose between (`Part Two`, then `Chapter 3`).
   * Both are listed, but they open one stretch of text: one place to go to.
   */
  joined: boolean;
}

/** A line the scanner is offered: whole, or a piece of a line too long to be a heading. */
export interface ScannedLine {
  row: number;
  text: string;
  /** False for a piece of a line split at `MAX_ROW_UNITS`: never a heading. */
  wholeLine: boolean;
}

/** Longer than this is a sentence, not a heading. */
const MAX_HEADING_CHARS = 72;
const MAX_CAPS_HEADING_CHARS = 48;

/**
 * Words in either case, for a pattern that cannot take the `i` flag: under it `\p{Lu}`
 * matches lower case too, and Roman numerals would match words like `Civil` and `Mid`.
 */
const anyCase = (words: readonly string[]) =>
  `(?:${words
    .map((word) =>
      [...word]
        .map((char) => (/[a-z]/u.test(char) ? `[${char.toUpperCase()}${char}]` : `\\${char}`))
        .join(''),
    )
    .join('|')})`;

const NUMBER_WORDS = anyCase(
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred'.split(
    ' ',
  ),
);
const ORDINAL_WORDS = anyCase(
  'first second third fourth fifth sixth seventh eighth ninth tenth last final'.split(' '),
);
/** A well-formed Roman numeral in one case: `XII` or `xii`, never `Mix` or `Did`. */
const roman = (m: string, d: string, c: string, l: string, x: string, v: string, i: string) =>
  `(?=[${m}${d}${c}${l}${x}${v}${i}])${m}{0,4}(?:${c}${m}|${c}${d}|${d}?${c}{0,3})(?:${x}${c}|${x}${l}|${l}?${x}{0,3})(?:${i}${x}|${i}${v}|${v}?${i}{0,3})`;
const NUMBER = `(\\d{1,4}|${roman('M', 'D', 'C', 'L', 'X', 'V', 'I')}|${roman('m', 'd', 'c', 'l', 'x', 'v', 'i')}|${NUMBER_WORDS}(?:[- ]${NUMBER_WORDS})*|${ORDINAL_WORDS})`;

/**
 * What may follow the number: nothing, a separator and a title, or a space and a
 * capitalized title. `Chapter 12 was long` is a sentence and fails here. Part of the
 * same pattern as the number, so `Chapter Last` can back off the numeral `L`.
 */
const AFTER_NUMBER = `(?:\\s*$|\\s*[.:\\-–—)]\\s*\\S.*$|\\s*[.:]\\s*$|\\s+[\\p{Lu}\\p{Lt}\\p{N}"“'‘(\\[].*$)`;
const AFTER_NAME = /^(?:\s*$|\s*[.:\-–—]\s*\S.*$|\s*[.:]\s*$)/u;

const ENGLISH_NUMBERED = new RegExp(
  `^(?:(${anyCase(['part', 'book', 'volume', 'vol.'])})|(${anyCase(['chapter', 'chap.'])}))\\s+${NUMBER}${AFTER_NUMBER}`,
  'u',
);
const ENGLISH_NAMED =
  /^(?:prologue|epilogue|preface|foreword|introduction|afterword|interlude|appendix(?:\s+[a-z\d]{1,3})?)/iu;

/** `第十二章`, `第 3 回`, `第二卷`: the number may be Chinese, Arabic or full-width digits. */
const CHINESE_NUMBERED =
  /^(第\s*[0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*([章回节節卷部篇集]))(?:\s*$|[\s:：、.．·—\-－]+\S.*$)/u;

const CHINESE_NAMED =
  /^(序章|序言|序|楔子|引子|引言|前言|尾声|尾聲|后记|後記|番外)(?:\s*$|[\s:：、·—\-－]+\S.*$)/u;

const CHINESE_PART_MARKERS = new Set(['卷', '部', '篇', '集']);

/** Sentence-ending punctuation: a short shouted line of dialogue is not a heading. */
const TRAILING_PUNCTUATION = /[,;!?…，；！？。、]$/u;

interface Candidate {
  row: number;
  label: string;
  level: HeadingLevel;
  /** What the heading names, without its title: a contents entry and its chapter share it. */
  key: string;
  numbered: boolean;
  /** A numbered heading that already took the all-caps title line after it. */
  titled: boolean;
}

/** Collapses runs of whitespace (including the ideographic space) for display. */
const tidy = (text: string) => text.trim().replace(/\s+/gu, ' ');

/** Compares headings by name: `CHAPTER I` and `Chapter I. The Storm`, `第１章` and `第1章`. */
const keyOf = (...parts: string[]) =>
  parts
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s-]+/gu, ' ')
    .trim();

/** A numbered or named heading, or null. Independent of the lines around it. */
export function matchNumberedHeading(
  text: string,
): { level: HeadingLevel; label: string; key: string } | null {
  const line = text.trim();
  if (line.length === 0 || line.length > MAX_HEADING_CHARS) return null;
  // A clause or sentence that happens to start with a heading word.
  if (/[,;，；。]$/u.test(line)) return null;

  const chinese = CHINESE_NUMBERED.exec(line);
  if (chinese) {
    return {
      level: CHINESE_PART_MARKERS.has(chinese[2] ?? '') ? 0 : 1,
      label: tidy(line),
      key: keyOf((chinese[1] as string).replace(/\s+/gu, '')),
    };
  }
  const chineseNamed = CHINESE_NAMED.exec(line);
  if (chineseNamed) return { level: 1, label: tidy(line), key: keyOf(chineseNamed[1] as string) };

  // A line that starts in lower case is the middle of a sentence.
  if (!/^\p{Lu}/u.test(line)) return null;
  const english = ENGLISH_NUMBERED.exec(line);
  if (english) {
    const word = english[1] ?? english[2] ?? '';
    return { level: english[1] ? 0 : 1, label: tidy(line), key: keyOf(word, english[3] ?? '') };
  }
  const named = ENGLISH_NAMED.exec(line);
  if (named && AFTER_NAME.test(line.slice(named[0].length))) {
    return { level: 1, label: tidy(line), key: keyOf(named[0]) };
  }
  return null;
}

/**
 * Whether a line is short, all capitals, and not a shouted sentence. The scanner
 * also requires a blank line on each side.
 */
export function isCapsHeading(text: string): boolean {
  const line = text.trim();
  if (line.length < 3 || line.length > MAX_CAPS_HEADING_CHARS) return false;
  if (TRAILING_PUNCTUATION.test(line)) return false;
  // Two capitals, no lower case: excludes `I`, `A.`, numbers and rules like `* * *`.
  const capitals = line.match(/\p{Lu}/gu)?.length ?? 0;
  return capitals >= 2 && !/\p{Ll}/u.test(line);
}

/**
 * Turns lines into headings as they arrive. Guesses are held until the next line of
 * prose settles them, which is at most a few lines behind the stream.
 */
export class HeadingScanner {
  private readonly found: ScannedHeading[] = [];
  private previousBlank = true;
  /** An all-caps line that still needs a blank line after it. */
  private capsLine: Candidate | null = null;
  /** Headings since the last line of prose. */
  private run: Candidate[] = [];

  get headings(): readonly ScannedHeading[] {
    return this.found;
  }

  push(line: ScannedLine): void {
    const blank = line.text.trim() === '';
    if (this.capsLine) {
      const caps = this.capsLine;
      this.capsLine = null;
      if (blank) this.candidate(caps);
      else this.prose();
    }
    if (blank) {
      this.previousBlank = true;
      return;
    }
    const wasBlank = this.previousBlank;
    this.previousBlank = false;
    if (!line.wholeLine) {
      this.prose();
      return;
    }
    const numbered = matchNumberedHeading(line.text);
    if (numbered) {
      this.candidate({ ...at(line), ...numbered, numbered: true, titled: false });
    } else if (wasBlank && isCapsHeading(line.text)) {
      this.capsLine = {
        ...at(line),
        label: tidy(line.text),
        key: keyOf(line.text),
        level: 1,
        numbered: false,
        titled: false,
      };
    } else {
      this.prose();
    }
  }

  /** The file ended: its end counts as a blank line, then as prose. */
  finish(): void {
    if (this.capsLine) this.candidate(this.capsLine);
    this.capsLine = null;
    this.prose();
  }

  private candidate(next: Candidate): void {
    const last = this.run.at(-1);
    if (last && !next.numbered && last.numbered && !last.titled) {
      // `CHAPTER I` then `THE STORM`: one heading, titled.
      last.titled = true;
      if (!/[:.\-–—]\s*\S/u.test(last.label)) last.label = `${last.label}: ${next.label}`;
      return;
    }
    this.run.push(next);
  }

  /**
   * Prose settles the run. A run that repeats a level (`Chapter 1`, `Chapter 2`, …)
   * is a table of contents; at most its tail, where each level appears once, heads the
   * text that follows. `Part One` then `Chapter 1` repeats nothing and stays whole.
   *
   * The tail heads the text only from where the contents comes round again
   * (`Chapter 1` a second time) or reaches a level it never listed (a body that opens
   * with `Chapter 1` under a contents of parts). Otherwise the tail is the contents'
   * last entries, as when a dedication or epigraph sits between it and the text.
   */
  private prose(): void {
    const run = this.run;
    if (run.length === 0) return;
    this.run = [];
    const seen = new Set<HeadingLevel>();
    let first = run.length;
    while (first > 0) {
      const level = (run[first - 1] as Candidate).level;
      if (seen.has(level)) break;
      seen.add(level);
      first -= 1;
    }
    if (first > 0) {
      const listedKeys = new Set(run.slice(0, first).map(({ key }) => key));
      const listedLevels = new Set(run.slice(0, first).map(({ level }) => level));
      for (; first < run.length; first += 1) {
        const { key, level } = run[first] as Candidate;
        if (listedKeys.has(key) || !listedLevels.has(level)) break;
        listedKeys.add(key);
        listedLevels.add(level);
      }
    }
    for (const [index, { row, label, level }] of run.slice(first).entries()) {
      this.found.push({ row, label, level, joined: index > 0 });
    }
  }
}

const at = (line: ScannedLine) => ({ row: line.row });
