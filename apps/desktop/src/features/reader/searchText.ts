/**
 * Smart matching for in-document search.
 *
 * A reader types what they see, not what the file stores: a phrase may wrap
 * across a line, a word may be hyphenated at a line end, an accent may be
 * missing, and curly quotes may be typed straight. This module folds a copy of
 * the text for matching and maps every folded offset back to the original text,
 * so PDF rectangles, EPUB CFI ranges, and TXT byte anchors keep addressing the
 * source they were derived from (ADR 0002).
 */

export interface SearchOptions {
  caseSensitive?: boolean;
  matchDiacritics?: boolean;
  wholeWord?: boolean;
}

export interface SearchMatchRange {
  start: number;
  end: number;
}

/** A contiguous range of folded text and the original range it came from. */
interface OffsetSpan {
  targetStart: number;
  targetEnd: number;
  sourceStart: number;
  sourceEnd: number;
  /** Whether the two ranges are the same length, so an offset maps by addition. */
  linear: boolean;
}

/** Maps offsets in one string onto the string it was derived from. */
class OffsetMap {
  constructor(
    readonly spans: OffsetSpan[],
    readonly targetLength: number,
    readonly sourceLength: number,
  ) {}

  /** The source offset where a target range starts. */
  sourceStartAt(target: number): number {
    if (this.spans.length === 0 || target <= 0) return 0;
    let low = 0;
    let high = this.spans.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.spans[middle] as OffsetSpan).targetStart <= target) low = middle;
      else high = middle - 1;
    }
    const span = this.spans[low] as OffsetSpan;
    if (!span.linear) return span.sourceStart;
    const within = Math.min(
      Math.max(target - span.targetStart, 0),
      span.targetEnd - span.targetStart,
    );
    return span.sourceStart + within;
  }

  /** The source offset where a target range ends (exclusive). */
  sourceEndAt(target: number): number {
    if (this.spans.length === 0 || target <= 0) return 0;
    if (target >= this.targetLength) return this.sourceLength;
    let low = 0;
    let high = this.spans.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.spans[middle] as OffsetSpan).targetEnd >= target) high = middle;
      else low = middle + 1;
    }
    const span = this.spans[low] as OffsetSpan;
    if (!span.linear) return span.sourceEnd;
    const within = Math.min(
      Math.max(target - span.targetStart, 0),
      span.targetEnd - span.targetStart,
    );
    return span.sourceStart + within;
  }
}

interface SourceText {
  text: string;
  map: OffsetMap;
}

export interface FoldedText {
  text: string;
  /** Maps a range in `text` back onto the original text. */
  originalRange(start: number, end: number): SearchMatchRange;
}

class FoldedSearchText implements FoldedText {
  constructor(
    readonly text: string,
    private readonly foldedToBase: OffsetMap,
    private readonly baseToOriginal: OffsetMap,
  ) {}

  originalRange(start: number, end: number): SearchMatchRange {
    const baseStart = this.foldedToBase.sourceStartAt(start);
    const baseEnd = this.foldedToBase.sourceEndAt(end);
    return {
      start: this.baseToOriginal.sourceStartAt(baseStart),
      end: this.baseToOriginal.sourceEndAt(baseEnd),
    };
  }
}

/** Curly and typographic quotes readers type as straight ones. */
const QUOTE_MAP: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u2032': "'",
  '\u02bc': "'",
  '\uff07': "'",
  '\u00b4': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2033': '"',
};

const QUOTE_RE =
  /[\u2018\u2019\u201a\u201b\u2032\u02bc\uff07\u00b4\u201c\u201d\u201e\u201f\u2033]/g;
/** Hyphen-like characters that should behave like a typed hyphen. */
const DASH_RE = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
/** Latin letters and combining marks whose accent can be folded. */
const DIACRITIC_CHAR_RE = /[\u00c0-\u024f\u1e00-\u1eff]|\p{M}/gu;
const DIACRITIC_CHAR_TEST = /[\u00c0-\u024f\u1e00-\u1eff]|\p{M}/u;
const HAS_MARK_RE = /\p{M}/u;
const MARKS_RE = /\p{M}+/gu;
/** A character that carries word meaning, for Whole Word boundaries. */
const WORD_CHAR_RE = /\p{L}|\p{N}/u;
const WHITESPACE_TEST = /\s/u;
const SOFT_HYPHEN = '\u00ad';
/** Only runs of two or more spaces need a rewrite; a single one maps one-to-one. */
const COLLAPSE_RE = /\s{2,}|\u00ad|-(?=\s)/g;
const ALL_WHITESPACE_RE = /\s/g;

const normalizePunctuation = (value: string) =>
  value.replace(QUOTE_RE, (character) => QUOTE_MAP[character] ?? character).replace(DASH_RE, '-');

const stripAccents = (value: string): string => {
  const decomposed = value.normalize('NFD');
  return HAS_MARK_RE.test(decomposed) ? decomposed.replace(MARKS_RE, '') : value;
};

/** One character folded: case, punctuation, and (unless asked to keep it) accents. */
function foldCharacter(character: string, options: SearchOptions): string {
  const cased = options.caseSensitive ? character : character.toLowerCase();
  const punctuated = normalizePunctuation(cased);
  return options.matchDiacritics ? punctuated : stripAccents(punctuated);
}

function addLinearSpan(
  spans: OffsetSpan[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
) {
  const length = sourceEnd - sourceStart;
  if (length <= 0) return;
  const last = spans.at(-1);
  if (last && last.linear && last.sourceEnd === sourceStart && last.targetEnd === targetStart) {
    last.sourceEnd = sourceEnd;
    last.targetEnd = targetStart + length;
    return;
  }
  spans.push({
    targetStart,
    targetEnd: targetStart + length,
    sourceStart,
    sourceEnd,
    linear: true,
  });
}

function addSpecialSpan(
  spans: OffsetSpan[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetLength: number,
) {
  if (sourceEnd <= sourceStart && targetLength === 0) return;
  spans.push({
    targetStart,
    targetEnd: targetStart + targetLength,
    sourceStart,
    sourceEnd,
    linear: false,
  });
}

/** Case and punctuation only: every character maps one-to-one. */
function buildPlainBase(text: string, options: SearchOptions): SourceText {
  const cased = options.caseSensitive ? text : text.toLowerCase();
  const base = normalizePunctuation(cased);
  return {
    text: base,
    map: new OffsetMap(
      [
        {
          targetStart: 0,
          targetEnd: base.length,
          sourceStart: 0,
          sourceEnd: text.length,
          linear: true,
        },
      ],
      base.length,
      text.length,
    ),
  };
}

/**
 * Folds accents while keeping the one-to-one stretches whole. Only characters
 * that decompose into a different number of code units split the map, so a long
 * French text still costs about one regex pass rather than one object per char.
 */
function buildAccentedBase(text: string, options: SearchOptions): SourceText {
  const parts: string[] = [];
  const spans: OffsetSpan[] = [];
  let targetLength = 0;
  let sourceCursor = 0;

  const appendPlain = (from: number, to: number) => {
    if (to <= from) return;
    const piece = text.slice(from, to);
    const folded = normalizePunctuation(options.caseSensitive ? piece : piece.toLowerCase());
    parts.push(folded);
    addLinearSpan(spans, from, to, targetLength);
    targetLength += folded.length;
  };

  for (const match of text.matchAll(DIACRITIC_CHAR_RE)) {
    const index = match.index ?? 0;
    const original = match[0];
    appendPlain(sourceCursor, index);
    const folded = foldCharacter(original, options);
    parts.push(folded);
    if (folded.length === original.length) {
      addLinearSpan(spans, index, index + original.length, targetLength);
    } else {
      addSpecialSpan(spans, index, index + original.length, targetLength, folded.length);
    }
    targetLength += folded.length;
    sourceCursor = index + original.length;
  }
  appendPlain(sourceCursor, text.length);

  return { text: parts.join(''), map: new OffsetMap(spans, targetLength, text.length) };
}

/**
 * The fallback for text whose whole-string lowercasing changed length (mostly
 * `İ`). Every code point is folded individually so offsets stay exact.
 */
function buildCharacterBase(text: string, options: SearchOptions): SourceText {
  const parts: string[] = [];
  const spans: OffsetSpan[] = [];
  let targetLength = 0;
  let pendingStart = 0;
  let pending = '';

  const flush = (nextSource: number) => {
    if (pending.length === 0) return;
    parts.push(pending);
    addLinearSpan(spans, pendingStart, nextSource, targetLength);
    targetLength += pending.length;
    pending = '';
  };

  let index = 0;
  while (index < text.length) {
    const width = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    const original = text.slice(index, index + width);
    const folded = foldCharacter(original, options);
    if (folded.length === original.length) {
      if (pending.length === 0) pendingStart = index;
      pending += folded;
    } else {
      flush(index);
      addSpecialSpan(spans, index, index + width, targetLength, folded.length);
      parts.push(folded);
      targetLength += folded.length;
      pendingStart = index + width;
    }
    index += width;
  }
  flush(text.length);

  return { text: parts.join(''), map: new OffsetMap(spans, targetLength, text.length) };
}

/**
 * The text with case, accents, and punctuation folded, before whitespace
 * normalization. Accents are skipped entirely when the reader asks to match them.
 */
function buildBase(text: string, options: SearchOptions): SourceText {
  const cased = options.caseSensitive ? text : text.toLowerCase();
  if (cased.length !== text.length) return buildCharacterBase(text, options);
  if (!options.matchDiacritics && DIACRITIC_CHAR_TEST.test(text)) {
    return buildAccentedBase(text, options);
  }
  return buildPlainBase(text, options);
}

const isWordCharacterAt = (text: string, index: number): boolean => {
  if (index < 0 || index >= text.length) return false;
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && WORD_CHAR_RE.test(String.fromCodePoint(codePoint));
};

const isWordCharacterBefore = (text: string, index: number): boolean => {
  if (index <= 0) return false;
  let start = index - 1;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
  return isWordCharacterAt(text, start);
};

/**
 * Drops soft hyphens and line-end hyphens, and collapses every whitespace run to
 * one space. The map records each rewrite, so a phrase found across a break still
 * addresses the original line break.
 */
function collapseWhitespace(base: SourceText): SourceText {
  const parts: string[] = [];
  const spans: OffsetSpan[] = [];
  let targetLength = 0;
  let sourceCursor = 0;

  const appendPlain = (to: number) => {
    if (to <= sourceCursor) return;
    // A single line break still becomes a space, but its length does not change,
    // so the whole stretch stays one linear span.
    const piece = base.text.slice(sourceCursor, to).replace(ALL_WHITESPACE_RE, ' ');
    parts.push(piece);
    addLinearSpan(spans, sourceCursor, to, targetLength);
    targetLength += piece.length;
    sourceCursor = to;
    COLLAPSE_RE.lastIndex = to;
  };

  COLLAPSE_RE.lastIndex = 0;
  for (let match = COLLAPSE_RE.exec(base.text); match; match = COLLAPSE_RE.exec(base.text)) {
    const start = match.index;
    const token = match[0];
    if (start < sourceCursor) continue;
    appendPlain(start);

    if (token === SOFT_HYPHEN) {
      addSpecialSpan(spans, start, start + 1, targetLength, 0);
      sourceCursor = start + 1;
      COLLAPSE_RE.lastIndex = sourceCursor;
      continue;
    }

    if (token === '-' && token.length === 1) {
      let afterWhitespace = start + 1;
      while (
        afterWhitespace < base.text.length &&
        WHITESPACE_TEST.test(base.text[afterWhitespace] as string)
      ) {
        afterWhitespace += 1;
      }
      const joinsWord =
        afterWhitespace > start + 1 &&
        afterWhitespace < base.text.length &&
        isWordCharacterAt(base.text, afterWhitespace) &&
        isWordCharacterBefore(base.text, start);
      if (joinsWord) {
        addSpecialSpan(spans, start, afterWhitespace, targetLength, 0);
        sourceCursor = afterWhitespace;
        COLLAPSE_RE.lastIndex = afterWhitespace;
        continue;
      }
      // A dash inside a word stays a dash; the whitespace after it is normal.
      parts.push('-');
      addLinearSpan(spans, start, start + 1, targetLength);
      targetLength += 1;
      sourceCursor = start + 1;
      COLLAPSE_RE.lastIndex = sourceCursor;
      continue;
    }

    parts.push(' ');
    addSpecialSpan(spans, start, start + token.length, targetLength, 1);
    targetLength += 1;
    sourceCursor = start + token.length;
    COLLAPSE_RE.lastIndex = sourceCursor;
  }
  appendPlain(base.text.length);

  return { text: parts.join(''), map: new OffsetMap(spans, targetLength, base.text.length) };
}

/** Folds `text` for search. */
export function foldSearchText(text: string, options: SearchOptions = {}): FoldedText {
  const base = buildBase(text, options);
  const collapsed = collapseWhitespace(base);
  return new FoldedSearchText(collapsed.text, collapsed.map, base.map);
}

/**
 * Non-overlapping matches of `query` in `text`, as original-text offsets.
 *
 * Matching happens on a folded copy where case, accents, quotes, dashes,
 * whitespace runs, soft hyphens, and line-end hyphens are normalized, so a
 * reader can type the way the text reads. Whole-word boundaries are checked on
 * the folded text but returned offsets always address the original.
 */
export function findSearchMatches(
  text: string,
  query: string,
  options: SearchOptions = {},
): SearchMatchRange[] {
  if (text.length === 0 || query.trim() === '') return [];
  const foldedText = foldSearchText(text, options);
  const foldedQuery = foldSearchText(query, options).text.trim();
  if (foldedQuery.length === 0) return [];

  let queryFirstWord = 0;
  while (queryFirstWord < foldedQuery.length && !isWordCharacterAt(foldedQuery, queryFirstWord)) {
    queryFirstWord += 1;
  }
  let queryEnd = foldedQuery.length;
  while (queryEnd > queryFirstWord && !isWordCharacterBefore(foldedQuery, queryEnd)) {
    queryEnd -= 1;
  }
  const hasWord = queryFirstWord < queryEnd;
  const trailingNonWord = foldedQuery.length - queryEnd;

  const matches: SearchMatchRange[] = [];
  let from = 0;
  while (from <= foldedText.text.length - foldedQuery.length) {
    const found = foldedText.text.indexOf(foldedQuery, from);
    if (found === -1) break;
    const end = found + foldedQuery.length;
    const wholeWord =
      !options.wholeWord ||
      !hasWord ||
      (!isWordCharacterBefore(foldedText.text, found + queryFirstWord) &&
        !isWordCharacterAt(foldedText.text, end - trailingNonWord));
    if (wholeWord) matches.push(foldedText.originalRange(found, end));
    from = end;
  }
  return matches;
}
