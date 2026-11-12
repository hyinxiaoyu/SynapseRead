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

  it('reads the line a baseline destination points at', () => {
    // A 12-unit run box at 801 has its baseline near 801 + 0.81 * 12, past its middle.
    expect(textNearDestination(notes, 0.8107)).toBe(
      '1 The first footnote, at the foot of the page, wraps onto a second line.',
    );
    const single = page(run('Body.', 100, 100, 50), run('3 A one-line note.', 100, 500, 200));
    expect(textNearDestination(single, 0.5097)).toBe('3 A one-line note.');
  });

  it('stops at a note whose marker shares its run or ends in a period', () => {
    const inline = page(
      run('1 The first note runs on', 100, 800, 300),
      run('and wraps.', 110, 814, 100),
      run('2 The second note.', 100, 828, 300),
    );
    expect(textNearDestination(inline, 0.79)).toBe('1 The first note runs on and wraps.');
    const dotted = page(
      run('1.', 100, 800, 10),
      run('The first note.', 112, 800, 200),
      run('2.', 100, 814, 10),
      run('The second note.', 112, 814, 200),
    );
    expect(textNearDestination(dotted, 0.79)).toBe('1. The first note.');
    const bracketed = page(
      run('[1] The first note.', 100, 800, 300),
      run('[2] The second note.', 100, 814, 300),
    );
    expect(textNearDestination(bracketed, 0.79)).toBe('[1] The first note.');
  });

  it('keeps a wrapped line that starts with a number in its note', () => {
    // Hanging indent: the wrapped lines sit right of the marker's edge.
    const hanging = page(
      run('1', 100, 800, 6, 8),
      run('The study ran from', 110, 801, 300),
      run('1998', 110, 815, 30),
      run('to 2004 and found', 145, 815, 200),
      run('10', 110, 829, 12),
      run('cases.', 125, 829, 60),
    );
    expect(textNearDestination(hanging, 0.79)).toBe(
      '1 The study ran from 1998 to 2004 and found 10 cases.',
    );
    // First-line indent, as LaTeX sets footnotes: the wrapped lines sit flush left.
    const indented = page(
      run('1', 120, 800, 6, 8),
      run('The study ran from', 130, 801, 300),
      run('1998', 100, 815, 30),
      run('onwards.', 135, 815, 100),
      run('2', 120, 829, 6, 8),
      run('Another note.', 130, 830, 200),
    );
    expect(textNearDestination(indented, 0.79)).toBe('1 The study ran from 1998 onwards.');
  });

  it('stops at an unraised marker on the edge the note began on', () => {
    const hanging = page(
      run('1', 100, 800, 6),
      run('The first note', 110, 800, 300),
      run('wraps here.', 110, 814, 200),
      run('2', 100, 828, 6),
      run('The second note.', 110, 828, 300),
    );
    expect(textNearDestination(hanging, 0.79)).toBe('1 The first note wraps here.');
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
