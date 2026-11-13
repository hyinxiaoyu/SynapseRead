import { describe, expect, it, vi } from 'vitest';

import {
  bookFraction,
  buildTextWeights,
  countedOffsets,
  countSectionText,
  forEachReadableText,
  locateBookFraction,
  measureBook,
  minutesLeftInSection,
  minutesLeftText,
  rawOffsetOfCounted,
  readCachedWeights,
  type SectionTextCount,
  TEXT_WEIGHT_RULES_VERSION,
  TextCounter,
  writeCachedWeights,
} from './textWeights';

const text = (characters: number, cjk = 0): SectionTextCount => ({ characters, cjk });

/** Ten one-line front-matter files, then three chapters of 6,000, 1,200 and 14,000. */
const UNEVEN = [...Array.from({ length: 10 }, () => text(20)), text(6000), text(1200), text(14000)];

describe('countSectionText', () => {
  it('counts whitespace runs once and none at the ends', () => {
    expect(countSectionText('\n  Chapter   One\n\n  It was  dark.  ')).toEqual({
      characters: 'Chapter One It was dark.'.length,
      cjk: 0,
    });
    expect(countSectionText('   \n\t')).toEqual({ characters: 0, cjk: 0 });
  });

  it('counts Han and kana separately, since they are read more slowly', () => {
    expect(countSectionText('第十二章 ひらがな カタカナ abc')).toEqual({ characters: 18, cjk: 12 });
  });
});

describe('TextCounter', () => {
  /** What the counter must agree with: the text collapsed in one go. */
  const collapsed = (value: string) => value.replace(/\s+/g, ' ').trim();

  it('counts like collapsing the joined text, however it is split into nodes', () => {
    const pieces = ['\n    ', '<p>', ' Chapter\u00a0', '\t One', '', '  \n', 'It\u3000was', ' '];
    const counter = new TextCounter();
    for (const piece of pieces) counter.add(piece);
    expect(counter.characters).toBe(collapsed(pieces.join('')).length);
    for (const sample of ['', '   ', 'a', ' a ', 'a  b', '\ufeffa\u2028b\u205f']) {
      expect(countSectionText(sample).characters).toBe(collapsed(sample).length);
    }
  });

  it('counts Hangul at the slower CJK rate too', () => {
    expect(countSectionText('제1장 한국어')).toEqual({ characters: 7, cjk: 5 });
  });
});

describe('positions in a chapter', () => {
  // Pretty-printed XHTML: most raw characters are indentation.
  const raw = '\n        Alpha\n        beta\n        gamma\n      ';

  it('maps raw offsets to counted characters', () => {
    expect(countedOffsets(raw, [raw.indexOf('Alpha'), raw.indexOf('beta'), raw.length])).toEqual([
      0, 6, 16,
    ]);
  });

  it('lands a counted fraction on the same text the weights measured', () => {
    const counted = countSectionText(raw).characters;
    expect(counted).toBe('Alpha beta gamma'.length);
    // Half the counted text is in "beta", whatever the indentation around it.
    expect(raw[rawOffsetOfCounted(raw, Math.floor(counted / 2))]).toBe('t');
    expect(rawOffsetOfCounted(raw, 0)).toBe(raw.indexOf('Alpha'));
    expect(rawOffsetOfCounted(raw, 999)).toBe(raw.lastIndexOf('a'));
    for (const word of ['Alpha', 'beta', 'gamma']) {
      const [at = -1] = countedOffsets(raw, [raw.indexOf(word)]);
      expect(rawOffsetOfCounted(raw, at)).toBe(raw.indexOf(word));
    }
  });
});

describe('cached weights', () => {
  it('reads back what was written, for the same file and chapter count only', () => {
    window.localStorage.clear();
    const weights = buildTextWeights([text(10), text(20, 5)]);
    writeCachedWeights('hash-a', weights);
    expect(readCachedWeights('hash-a', 2)).toEqual(weights);
    expect(readCachedWeights('hash-a', 3)).toBeNull();
    expect(readCachedWeights('hash-b', 2)).toBeNull();
  });

  it('ignores a damaged cache and keeps only the most recent books', () => {
    window.localStorage.setItem('synapseread.epubTextWeights.v1', '{not json');
    expect(readCachedWeights('hash-a', 2)).toBeNull();
    window.localStorage.setItem(
      'synapseread.epubTextWeights.v1',
      JSON.stringify({
        'hash-a': { at: 1, rules: TEXT_WEIGHT_RULES_VERSION, sections: [[-1, 0]] },
      }),
    );
    expect(readCachedWeights('hash-a', 1)).toBeNull();

    window.localStorage.clear();
    const weights = buildTextWeights([text(1)]);
    for (let book = 0; book < 45; book += 1) writeCachedWeights(`book-${book}`, weights, book);
    expect(readCachedWeights('book-0', 1)).toBeNull();
    expect(readCachedWeights('book-5', 1)).not.toBeNull();
    expect(readCachedWeights('book-44', 1)).not.toBeNull();
  });

  it('treats entries without a matching counting-rules version as misses (#68)', () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'synapseread.epubTextWeights.v1',
      JSON.stringify({
        legacy: { at: 1, sections: [[10, 0]] },
        future: { at: 1, rules: TEXT_WEIGHT_RULES_VERSION + 1, sections: [[10, 0]] },
      }),
    );
    expect(readCachedWeights('legacy', 1)).toBeNull();
    expect(readCachedWeights('future', 1)).toBeNull();
  });

  it('refreshes entry timestamps on hit for true LRU eviction (#67)', () => {
    window.localStorage.clear();
    const weights = buildTextWeights([text(1)]);
    for (let book = 0; book < 40; book += 1) writeCachedWeights(`book-${book}`, weights, book);

    // Reading book-0 promotes it above book-1..39 before book-40 forces eviction.
    expect(readCachedWeights('book-0', 1, 100)).toEqual(weights);
    writeCachedWeights('book-40', weights, 40);

    expect(readCachedWeights('book-0', 1, 101)).toEqual(weights);
    expect(readCachedWeights('book-1', 1, 102)).toBeNull();

    // A failing localStorage.setItem during hit refresh still returns the validated hit.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(readCachedWeights('book-0', 1, 103)).toEqual(weights);
    } finally {
      setItem.mockRestore();
    }
  });

  it('pins the counting-rules version to a semantic digest of the counting rules (#68)', () => {
    let fnv = 0x811c9dc5;
    const mix = (value: number) => {
      fnv ^= value >>> 0;
      fnv = Math.imul(fnv, 0x01000193) >>> 0;
    };

    mix(TEXT_WEIGHT_RULES_VERSION);

    // Pin `isSpace` and `TextCounter` transitions across all 65,536 UTF-16 code units.
    for (let code = 0; code <= 0xffff; code += 1) {
      const counter = new TextCounter();
      counter.step(0x61); // 'a'
      const spaceResult = counter.step(code) ? 1 : 0;
      counter.step(0x62); // 'b'
      mix((code << 4) | (spaceResult << 2) | counter.characters);
    }

    // Pin `CJK` script classification across assigned script samples (ICU-upgrade safe).
    const scriptSamples = [
      'A',
      'é',
      'Ω',
      'Ж',
      'א',
      'ع',
      '汉',
      '\u{20000}',
      'あ',
      'ア',
      '한',
      'ㄱ',
      'ㄅ',
      '。',
      '\u{1f600}',
    ];
    for (const sample of scriptSamples) {
      const { characters, cjk } = countSectionText(sample);
      mix((characters << 2) | cjk);
    }

    // Pin `forEachReadableText` DOM filtering and node traversal order.
    const doc = new DOMParser().parseFromString(
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>t</title><style>s</style></head>
<body><p>  a\u00a0b </p><script>x</script><noscript>y</noscript><style>z</style><svg><title>v</title><text>g</text></svg><div><!--c--><![CDATA[d]]><span></span>e</div></body>
</html>`,
      'application/xhtml+xml',
    );
    const domCounter = new TextCounter();
    forEachReadableText(doc, (node) => domCounter.add(node.data));
    mix(domCounter.characters);
    mix(domCounter.cjk);

    const digest = fnv.toString(16).padStart(8, '0');
    expect(TEXT_WEIGHT_RULES_VERSION).toBe(1);
    expect(
      digest,
      'Counting rules changed; bump TEXT_WEIGHT_RULES_VERSION and update this digest.',
    ).toBe('ec4f7ddc');
  });
});

describe('book positions', () => {
  const weights = buildTextWeights(UNEVEN);

  it('puts Chapter One near the start, not at 10/13 of the book', () => {
    expect(weights.total).toBe(21_400);
    expect(bookFraction(weights, 13, 10, 0)).toBeCloseTo(200 / 21_400);
    // The same position by file, which is what #52 reports.
    expect(bookFraction(null, 13, 10, 0)).toBeCloseTo(10 / 13);
  });

  it('weighs a page by how far into its chapter it is', () => {
    expect(bookFraction(weights, 13, 12, 0.5)).toBeCloseTo((7400 + 7000) / 21_400);
    expect(bookFraction(weights, 13, 12, 1)).toBe(1);
    // Out-of-range input is clamped rather than leaving the book.
    expect(bookFraction(weights, 13, 99, 2)).toBe(1);
    expect(bookFraction(weights, 13, -1, -1)).toBe(0);
    expect(bookFraction(weights, 0, 0, 0)).toBe(0);
  });

  it('gives an image-only section a place of its own', () => {
    const cover = buildTextWeights([text(0), text(100)]);
    expect(bookFraction(cover, 2, 1, 0)).toBeGreaterThan(0);
    expect(bookFraction(cover, 2, 1, 0)).toBeLessThan(0.02);
  });

  it('finds the chapter and point a book fraction falls in', () => {
    expect(locateBookFraction(weights, 13, 0)).toEqual({ index: 0, within: 0 });
    const middle = locateBookFraction(weights, 13, 0.5);
    expect(middle.index).toBe(12);
    expect(middle.within).toBeCloseTo((10_700 - 7400) / 14_000);
    expect(locateBookFraction(weights, 13, 1)).toEqual({ index: 12, within: 1 });
    // Round trips with `bookFraction` everywhere.
    for (const fraction of [0.001, 0.01, 0.2, 0.33, 0.34, 0.7, 0.999]) {
      const { index, within } = locateBookFraction(weights, 13, fraction);
      expect(bookFraction(weights, 13, index, within)).toBeCloseTo(fraction, 6);
    }
  });

  it('falls back to equal shares without weights, or with weights for another book', () => {
    expect(locateBookFraction(null, 4, 0.6)).toEqual({ index: 2, within: expect.closeTo(0.4) });
    expect(locateBookFraction(weights, 4, 0.6).index).toBe(2);
    expect(bookFraction(buildTextWeights([text(5)]), 4, 2, 0)).toBe(0.5);
  });
});

describe('minutes left', () => {
  it('estimates from the text left in the chapter, reading CJK more slowly', () => {
    expect(minutesLeftInSection(text(13_000), 0)).toBeCloseTo(10);
    expect(minutesLeftInSection(text(13_000), 0.5)).toBeCloseTo(5);
    expect(minutesLeftInSection(text(3000, 3000), 0)).toBeCloseTo(10);
    expect(minutesLeftInSection(text(13_000), 1)).toBe(0);
  });

  it('says it in words a reader can take in at a glance', () => {
    expect(minutesLeftText(0.4)).toBe('Less than a minute left in chapter');
    expect(minutesLeftText(1.2)).toBe('About 1 minute left in chapter');
    expect(minutesLeftText(12.6)).toBe('About 13 minutes left in chapter');
    expect(minutesLeftText(60)).toBe('About 1 h left in chapter');
    expect(minutesLeftText(95)).toBe('About 1 h 35 min left in chapter');
  });
});

describe('measureBook', () => {
  const immediate = async (signal: AbortSignal) => signal.throwIfAborted();

  it('measures each section in order, waiting for an idle moment before each', async () => {
    const order: string[] = [];
    const idle = vi.fn(async (signal: AbortSignal) => {
      order.push('idle');
      signal.throwIfAborted();
    });
    const weights = await measureBook(
      3,
      async (index) => {
        order.push(`measure ${index}`);
        return text((index + 1) * 10);
      },
      new AbortController().signal,
      idle,
    );
    expect(order).toEqual(['idle', 'measure 0', 'idle', 'measure 1', 'idle', 'measure 2']);
    expect(weights.starts).toEqual([0, 10, 30]);
    expect(weights.total).toBe(60);
  });

  it('stops loading sections as soon as it is aborted', async () => {
    const controller = new AbortController();
    const measure = vi.fn(async (index: number) => {
      if (index === 1) controller.abort(new Error('closed'));
      return text(10);
    });
    await expect(measureBook(5, measure, controller.signal, immediate)).rejects.toThrow('closed');
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('counts a section it cannot read as empty and carries on', async () => {
    const weights = await measureBook(
      3,
      async (index) => {
        if (index === 0) throw new Error('broken file');
        return index === 1 ? null : text(50);
      },
      new AbortController().signal,
      immediate,
    );
    expect(weights.sections).toEqual([text(0), text(0), text(50)]);
  });

  it('waits for the browser to be idle, or for a timer where it has no idle callback', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestIdleCallback', undefined);
      const measure = vi.fn(async () => text(1));
      const done = measureBook(2, measure, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(measure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await expect(done).resolves.toMatchObject({ total: 2 });
      expect(measure).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
