import { describe, expect, it } from 'vitest';

import {
  type EpubTocItem,
  resolveEpubFallbackChapterLabel,
  resolveEpubSelectionChapterLabel,
} from './epubTocLocation';

function createXhtmlDoc(bodyHtml: string): Document {
  const doc = document.implementation.createHTMLDocument('Fixture');
  doc.body.innerHTML = bodyHtml;
  return doc;
}

function rangeForText(doc: Document, needle: string): Range {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const idx = text.indexOf(needle);
    if (idx !== -1) {
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      return range;
    }
  }
  throw new Error(`Text not found in document: ${needle}`);
}

describe('epubTocLocation (#125)', () => {
  it('resolves two chapters sharing one XHTML file by DOM order of #fragment targets', () => {
    const toc: EpubTocItem[] = [
      { id: 'ch1', label: 'Chapter One: Arrival', href: 'chapter1.xhtml#arrival', children: [] },
      {
        id: 'ch2',
        label: 'Chapter Two: Departure',
        href: 'chapter1.xhtml#departure',
        children: [],
      },
    ];
    const doc = createXhtmlDoc(`
      <p>Front epigraph before first chapter.</p>
      <section id="arrival">
        <h1>Chapter One: Arrival</h1>
        <p>The ship reached the harbor at dawn.</p>
      </section>
      <section id="departure">
        <h1>Chapter Two: Departure</h1>
        <p>The crew cast off the lines at dusk.</p>
      </section>
    `);

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'harbor at dawn'),
      }),
    ).toBe('Chapter One: Arrival');

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'cast off the lines'),
      }),
    ).toBe('Chapter Two: Departure');

    // Selection inside the heading of chapter 2 itself also resolves to chapter 2.
    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Chapter Two: Departure'),
      }),
    ).toBe('Chapter Two: Departure');

    // Text before the first fragment with no file-level entry falls back to null (book title only).
    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Front epigraph'),
      }),
    ).toBeNull();
  });

  it('resolves mixed file-level and nested #fragment entries in one XHTML file', () => {
    const toc: EpubTocItem[] = [
      {
        id: 'ch1',
        label: 'One',
        href: 'chapter1.xhtml',
        children: [
          { id: 'sec1', label: 'Section 1.1', href: 'chapter1.xhtml#section-1-1', children: [] },
        ],
      },
    ];
    const doc = createXhtmlDoc(`
      <h1>Chapter One</h1>
      <p>The quick brown fox jumps over the lazy dog.</p>
      <h2 id="section-1-1">Section 1.1</h2>
      <p>Details inside subsection one point one.</p>
    `);

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'quick brown fox'),
      }),
    ).toBe('One');

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'subsection one point one'),
      }),
    ).toBe('Section 1.1');
  });

  it('falls back safely when a fragment target cannot be resolved or DOM is unavailable', () => {
    const fragmentOnlyToc: EpubTocItem[] = [
      { id: 'ch1', label: 'Chapter One: Arrival', href: 'chapter1.xhtml#arrival', children: [] },
      {
        id: 'ch2',
        label: 'Chapter Two: Departure',
        href: 'chapter1.xhtml#missing-anchor',
        children: [],
      },
    ];
    const doc = createXhtmlDoc(`
      <section id="arrival"><p>Arrival text.</p></section>
      <section><p>Departure text without id.</p></section>
    `);

    // Unresolvable fragment in a fragment-only shared file -> null (never guesses Arrival).
    expect(
      resolveEpubSelectionChapterLabel({
        toc: fragmentOnlyToc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Departure text'),
      }),
    ).toBeNull();

    // Without a DOM, fragment-only shared file also falls back to null.
    expect(
      resolveEpubFallbackChapterLabel(fragmentOnlyToc, 'OEBPS/chapter1.xhtml', 0, [
        'Chapter One: Arrival',
      ]),
    ).toBeNull();

    // When a unique file-level TOC entry exists alongside an unresolvable fragment, fall back to it.
    const withFileLevelToc: EpubTocItem[] = [
      {
        id: 'part',
        label: 'Part I',
        href: 'chapter1.xhtml',
        children: [
          { id: 'sec', label: 'Missing Section', href: 'chapter1.xhtml#gone', children: [] },
        ],
      },
    ];
    expect(
      resolveEpubSelectionChapterLabel({
        toc: withFileLevelToc,
        chapterHref: 'OEBPS/chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Departure text'),
      }),
    ).toBe('Part I');
    expect(
      resolveEpubFallbackChapterLabel(withFileLevelToc, 'OEBPS/chapter1.xhtml', 0, ['Part I']),
    ).toBe('Part I');
  });

  it('supports percent-encoded fragments and legacy <a name="..."> anchors, and orders by DOM position', () => {
    const toc: EpubTocItem[] = [
      // Deliberately out of DOM order in TOC to verify DOM order governs.
      { id: 'ch2', label: 'Second Part', href: 'chapter1.xhtml#part%20two', children: [] },
      { id: 'ch1', label: 'First Part', href: 'chapter1.xhtml#part-one', children: [] },
    ];
    const doc = createXhtmlDoc(`
      <a name="part-one"></a>
      <p>Opening paragraph of first part.</p>
      <h2 id="part two">Second Part</h2>
      <p>Closing paragraph of second part.</p>
    `);

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Opening paragraph'),
      }),
    ).toBe('First Part');

    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'chapter1.xhtml',
        document: doc,
        selectionRange: rangeForText(doc, 'Closing paragraph'),
      }),
    ).toBe('Second Part');
  });

  it('returns undefined when no TOC entry matches the file so spine fallback applies', () => {
    const toc: EpubTocItem[] = [{ id: 'ch1', label: 'One', href: 'chapter1.xhtml', children: [] }];
    expect(
      resolveEpubSelectionChapterLabel({
        toc,
        chapterHref: 'chapter2.xhtml',
        document: null,
        selectionRange: null,
      }),
    ).toBeUndefined();
    expect(resolveEpubFallbackChapterLabel(toc, 'chapter2.xhtml', 1, ['One', 'One'])).toBe('One');
    expect(resolveEpubFallbackChapterLabel([], 'chapter2.xhtml', 1, [])).toBe('Chapter 2');
  });
});
