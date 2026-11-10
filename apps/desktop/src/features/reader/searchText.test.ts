import { describe, expect, it } from 'vitest';

import { findSearchMatches, foldSearchText } from './searchText';

const slice = (text: string, match: { start: number; end: number }) =>
  text.slice(match.start, match.end);

describe('findSearchMatches', () => {
  it('finds a phrase that wraps across a line break and keeps the original range', () => {
    const text = 'The lazy dog.\nPack my box with five dozen liquor jugs.';
    const [match] = findSearchMatches(text, 'dog. Pack');
    expect(match).toBeDefined();
    expect(slice(text, match!)).toBe('dog.\nPack');
  });

  it('collapses a run of blank lines between two parts of a phrase', () => {
    const text = 'The lazy dog.\n\n  Pack my box.';
    const [match] = findSearchMatches(text, 'dog. Pack');
    expect(slice(text, match!)).toBe('dog.\n\n  Pack');
  });

  it('joins words split by a soft hyphen or an end-of-line hyphen', () => {
    const soft = 'A co\u00adoperate sentence.';
    const line = 'A hyphen-\nated word.';
    expect(slice(soft, findSearchMatches(soft, 'cooperate')[0]!)).toBe('co\u00adoperate');
    expect(slice(line, findSearchMatches(line, 'hyphenated')[0]!)).toBe('hyphen-\nated');
    // A hyphen inside a word is not a line-end break.
    expect(findSearchMatches('A state-of-the-art book.', 'stateoftheart')).toEqual([]);
  });

  it('folds accents unless the reader asks to match them', () => {
    const text = 'A café and a crème brûlée.';
    expect(findSearchMatches(text, 'cafe')).toHaveLength(1);
    expect(findSearchMatches(text, 'creme brulee')).toHaveLength(1);
    expect(findSearchMatches(text, 'cafe', { matchDiacritics: true })).toEqual([]);
    expect(findSearchMatches(text, 'café', { matchDiacritics: true })).toHaveLength(1);
    // The returned range still covers the accented source characters.
    expect(slice(text, findSearchMatches(text, 'cafe')[0]!)).toBe('café');
  });

  it('matches composed input against decomposed text', () => {
    const text = 'A cafe\u0301 sentence.';
    expect(findSearchMatches(text, 'café')).toHaveLength(1);
    expect(findSearchMatches(text, 'cafe')).toHaveLength(1);
  });

  it('folds case by default and honors Match Case', () => {
    const text = 'Fox and fox.';
    expect(findSearchMatches(text, 'fox')).toHaveLength(2);
    expect(findSearchMatches(text, 'fox', { caseSensitive: true })).toHaveLength(1);
  });

  it('unifies curly quotes and dash variants', () => {
    const text = 'She said “curly” — then an en–dash.';
    const [match] = findSearchMatches(text, '"curly" - then an en-dash');
    expect(match).toBeDefined();
    expect(slice(text, match!)).toBe('“curly” — then an en–dash');
  });

  it('checks whole-word boundaries around punctuation', () => {
    const text = 'dog dogma (dog) dog.';
    expect(findSearchMatches(text, 'dog')).toHaveLength(4);
    expect(findSearchMatches(text, 'dog', { wholeWord: true })).toHaveLength(3);
    expect(findSearchMatches(text, 'dog.', { wholeWord: true })).toHaveLength(1);
  });

  it('reports two matches for repeated text and advances past each one', () => {
    const text = 'quick, quicker, quickest';
    const matches = findSearchMatches(text, 'quick');
    expect(matches.map((match) => slice(text, match))).toEqual(['quick', 'quick', 'quick']);
    expect(matches[1]?.start).toBe(text.indexOf('quick', 1));
  });

  it('returns no matches for an empty or whitespace-only query', () => {
    expect(findSearchMatches('some text', '')).toEqual([]);
    expect(findSearchMatches('some text', '   ')).toEqual([]);
    expect(findSearchMatches('', 'some')).toEqual([]);
  });
});

describe('foldSearchText', () => {
  it('maps every folded range back onto the original text', () => {
    const text = 'One  café,\n\ntwo “quoted” words.';
    const folded = foldSearchText(text);
    expect(folded.text).toBe('one cafe, two "quoted" words.');
    const start = folded.text.indexOf('cafe');
    const range = folded.originalRange(start, start + 'cafe'.length);
    expect(text.slice(range.start, range.end)).toBe('café');
    const quoted = folded.text.indexOf('"quoted"');
    const quotedRange = folded.originalRange(quoted, quoted + '"quoted"'.length);
    expect(text.slice(quotedRange.start, quotedRange.end)).toBe('“quoted”');
  });

  it('keeps a dropped soft hyphen inside the match range', () => {
    const text = 'co\u00adoperate now';
    const [match] = findSearchMatches(text, 'cooperate');
    expect(text.slice(match!.start, match!.end)).toBe('co\u00adoperate');
  });
});
