import { describe, expect, it } from 'vitest';

import type { PdfPageText, PdfTextRun } from './pdfEngine';
import { isNoteMarker, linkLabel, PDF_PEEK_MAX_CHARS, textNearDestination } from './pdfLinkPeek';

/** A run on a 1000-unit page, so positions read as thousandths. */
const run = (text: string, x: number, y: number, width: number, height = 12): PdfTextRun => ({
  text,
  rect: { x: x / 1000, y: y / 1000, width: width / 1000, height: height / 1000 },
});
const page = (...runs: PdfTextRun[]): PdfPageText => ({ pageIndex: 0, runs });

describe('isNoteMarker', () => {
  it('knows note and citation markers from words', () => {
    for (const marker of ['1', '12', '*', '†', '‡‡', '[3]', '(4)', '[3, 5–7]', ' 2 ']) {
      expect(isNoteMarker(marker), marker).toBe(true);
    }
    for (const words of ['', 'see page 4', 'Chapter 2', 'a', '12345', '1.5', 'x1']) {
      expect(isNoteMarker(words), words).toBe(false);
    }
  });
});

describe('linkLabel', () => {
  it('reads only the characters under the link', () => {
    // "claim1" as one run: the link covers its last sixth.
    const text = page(run('claim1', 100, 100, 60), run('other line', 100, 200, 100));
    expect(linkLabel(text, { x: 0.15, y: 0.098, width: 0.012, height: 0.016 })).toBe('1');
    expect(linkLabel(text, { x: 0.5, y: 0.098, width: 0.05, height: 0.016 })).toBe('');
  });
});

describe('textNearDestination', () => {
  const notes = page(
    run('Body text above the notes.', 100, 100, 300),
    run('1', 100, 800, 6, 8),
    run('The first footnote, at the foot', 110, 801, 300),
    run('of the page, wraps onto a sec-', 110, 815, 300),
    run('ond line.', 110, 829, 100),
    run('2', 100, 845, 6, 8),
    run('A second note <b>stays</b> apart.', 110, 846, 300),
    run('Page 1', 480, 950, 40),
  );

  it('reads the paragraph at the destination, joining hyphenated lines', () => {
    expect(textNearDestination(notes, 0.79)).toBe(
      '1 The first footnote, at the foot of the page, wraps onto a second line.',
    );
  });

  it('stops at the next note marker and at a gap wider than a line', () => {
    // Markup in a PDF's text is only characters, kept as written.
    expect(textNearDestination(notes, 0.84)).toBe('2 A second note <b>stays</b> apart.');
  });

  it('is empty below the last line', () => {
    expect(textNearDestination(notes, 0.99)).toBe('');
    expect(textNearDestination(page(), 0)).toBe('');
  });

  it('keeps a long paragraph to the card', () => {
    const long = page(
      ...Array.from({ length: 6 }, (_, index) => run('x'.repeat(150), 100, 100 + index * 14, 800)),
    );
    const text = textNearDestination(long, 0);
    expect(text.length).toBeLessThanOrEqual(PDF_PEEK_MAX_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
  });
});
