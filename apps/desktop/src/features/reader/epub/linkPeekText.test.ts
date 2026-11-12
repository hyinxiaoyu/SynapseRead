import { afterEach, describe, expect, it } from 'vitest';

import {
  isNoteRef,
  noteTextAt,
  PEEK_MAX_CHARS,
  plainText,
  SHORT_TARGET_CHARS,
} from './linkPeekText';
import { sanitizeChapter } from './sanitizeChapter';

/** A chapter parsed the way epub.js parses one: XHTML, in a document of its own. */
const chapter = (body: string) =>
  new DOMParser().parseFromString(
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>t</title><style>p { color: red; }</style></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  );

const flags = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete flags.__peekScriptRan;
  delete flags.__peekHandlerRan;
});

describe('isNoteRef', () => {
  it('knows a note reference by epub:type or ARIA role', () => {
    const doc = chapter(`<p>
      <a id="a" epub:type="noteref" href="#n">1</a>
      <a id="b" epub:type="glossref noteref" href="#n">2</a>
      <a id="c" role="doc-noteref" href="#n">3</a>
      <a id="d" href="#n">4</a></p>`);
    const link = (id: string) => doc.getElementById(id) as Element;
    expect(isNoteRef(link('a'))).toBe(true);
    expect(isNoteRef(link('b'))).toBe(true);
    expect(isNoteRef(link('c'))).toBe(true);
    expect(isNoteRef(link('d'))).toBe(false);
  });
});

describe('noteTextAt', () => {
  it('reads a footnote as plain text, without its back link', () => {
    const doc = chapter(`<aside epub:type="footnote" id="fn1"><p>
      <a epub:type="backlink" href="ch1.xhtml#r1">1.</a> The   first
      <em>footnote</em><br/>explains.</p></aside>`);
    expect(noteTextAt(doc, 'fn1', { noteref: true })).toBe('The first footnote explains.');
  });

  it('never returns markup, and never runs it (ADR 0005)', () => {
    const doc = chapter(`<aside epub:type="footnote" id="fn2"><p><b>Bold</b> words<img
      src="missing.png" alt="" onerror="window.__peekHandlerRan = true"/><script>
      window.__peekScriptRan = true;</script><style>b { color: red }</style><svg><text>svg
      text</text></svg> and &lt;img src=x onerror=alert(1)&gt; stay text.</p></aside>`);
    const text = noteTextAt(doc, 'fn2', { noteref: true });
    // Escaped markup stays characters; real markup leaves only its text.
    expect(text).toBe('Bold words and <img src=x onerror=alert(1)> stay text.');
    expect(flags.__peekScriptRan).toBeUndefined();
    expect(flags.__peekHandlerRan).toBeUndefined();
  });

  it('gives the same text once the chapter is sanitized, as the reader loads it', () => {
    const doc = chapter(`<p id="n">Note <script>alert(1)</script><a href="javascript:alert(1)"
      onclick="alert(1)">text</a>.</p>`);
    sanitizeChapter(doc);
    expect(noteTextAt(doc, 'n', { noteref: true })).toBe('Note text.');
  });

  it('reads the whole note when the id sits on its label, as EPUB 2 books do', () => {
    const doc = chapter(`
      <p class="footnote"><a id="fn1" href="ch1.xhtml#ref1">[1]</a> The first note.</p>
      <p><span id="fn2">2.</span> The second <em>note</em>.</p>
      <ol><li><a name="fn3" href="ch1.xhtml#ref3">3</a> A listed note.</li></ol>`);
    // With noteref or without: a link that only says `[1]` is not worth a card.
    for (const noteref of [true, false]) {
      expect(noteTextAt(doc, 'fn1', { noteref })).toBe('[1] The first note.');
      expect(noteTextAt(doc, 'fn2', { noteref })).toBe('2. The second note.');
      expect(noteTextAt(doc, 'fn3', { noteref })).toBe('3 A listed note.');
    }
  });

  it('jumps from an inline target in a long paragraph', () => {
    const long = 'word '.repeat(SHORT_TARGET_CHARS / 4);
    const doc = chapter(`<p>${long}<span id="term">a term</span> ${long}</p>`);
    expect(noteTextAt(doc, 'term', { noteref: false })).toBeNull();
  });

  it('peeks at a short target without noteref, and jumps to a long one', () => {
    const short = 'An aside of a sentence.';
    const long = 'word '.repeat(SHORT_TARGET_CHARS / 4);
    const doc = chapter(`<p id="short">${short}</p><p id="long">${long}</p>`);
    expect(noteTextAt(doc, 'short', { noteref: false })).toBe(short);
    expect(noteTextAt(doc, 'long', { noteref: false })).toBeNull();
    // A reference that says it is a note is shown however long, up to the card's limit.
    const shown = noteTextAt(doc, 'long', { noteref: true }) ?? '';
    expect(shown.length).toBeLessThanOrEqual(PEEK_MAX_CHARS + 1);
  });

  it('jumps to headings and sections unless the target says it is a note', () => {
    const doc = chapter(`<section id="part"><h2 id="title">Part Two</h2><p>Body.</p></section>
      <section id="notes" epub:type="endnote"><p>An endnote.</p></section>`);
    expect(noteTextAt(doc, 'title', { noteref: false })).toBeNull();
    expect(noteTextAt(doc, 'part', { noteref: false })).toBeNull();
    expect(noteTextAt(doc, 'notes', { noteref: false })).toBe('An endnote.');
  });

  it('reads an empty marker as the block it sits in, and finds old name anchors', () => {
    const doc = chapter(`<p><a id="fn3"/>3. A note marked by an empty anchor.</p>
      <p><a name="fn4"></a>4. A note marked by name.</p>
      <p id="caf%C3%A9-x">Never matched.</p><p id="café">An encoded id.</p>`);
    expect(noteTextAt(doc, 'fn3', { noteref: true })).toBe('3. A note marked by an empty anchor.');
    expect(noteTextAt(doc, 'fn4', { noteref: true })).toBe('4. A note marked by name.');
    expect(noteTextAt(doc, 'caf%C3%A9', { noteref: true })).toBe('An encoded id.');
  });

  it('jumps when there is no such target or nothing to read', () => {
    const doc = chapter(`<p id="empty"><img src="x.png" alt="x"/></p>`);
    expect(noteTextAt(doc, 'missing', { noteref: true })).toBeNull();
    expect(noteTextAt(doc, '', { noteref: true })).toBeNull();
    expect(noteTextAt(doc, 'empty', { noteref: true })).toBeNull();
  });

  it('ends a long note in an ellipsis at a word', () => {
    const doc = chapter(`<aside epub:type="footnote" id="n">${'longword '.repeat(200)}</aside>`);
    const text = noteTextAt(doc, 'n', { noteref: true }) ?? '';
    expect(text.endsWith('longword…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PEEK_MAX_CHARS + 1);
  });
});

describe('plainText', () => {
  it('keeps CDATA text and drops comments', () => {
    const doc = chapter(`<p id="p">One<!-- hidden --> <![CDATA[two]]></p>`);
    expect(plainText(doc.getElementById('p') as Element)).toBe('One two');
  });
});
