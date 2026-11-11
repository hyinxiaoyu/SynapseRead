import { describe, expect, it, vi } from 'vitest';

import {
  bookFraction,
  buildTextWeights,
  countSectionText,
  locateBookFraction,
  measureBook,
  minutesLeftInSection,
  minutesLeftText,
  type SectionTextCount,
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
