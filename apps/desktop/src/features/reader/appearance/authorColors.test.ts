import { afterEach, describe, expect, it } from 'vitest';

import { contrastRatio } from '@/lib/contrast';

import { applyReadableAuthorColors, revertAuthorColors } from './authorColors';
import { PAGE_PALETTES } from './themes';

const AA_TEXT = 4.5;
const frames: HTMLIFrameElement[] = [];

/** A chapter frame, as epub.js gives the engine: its own document and window. */
function chapter(markup: string): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error('the test frame has no document');
  doc.head.innerHTML = `
    <style>
      body { color: rgb(228, 228, 231); }
      h1 { color: #204080; }
      .author-black { color: #000000; }
    </style>`;
  doc.body.innerHTML = markup;
  return doc;
}

const colorOf = (doc: Document, selector: string): string => {
  const element = doc.querySelector(selector);
  if (!element) throw new Error(`no ${selector} in the chapter`);
  return doc.defaultView?.getComputedStyle(element).color ?? '';
};

afterEach(() => {
  while (frames.length > 0) frames.pop()?.remove();
});

describe('readable author colors', () => {
  it('replaces only author colors below AA on the Dark page', () => {
    const doc = chapter(`
      <h1>Chapter One</h1>
      <p class="author-black">Body text</p>
      <p id="meaningful" style="color: #fde047">A meaningful heading color</p>
      <p id="callout" style="color: #000000; background-color: #ffffff">On its own paper</p>
      <span style="color: #204080">Inline reference</span>
    `);

    applyReadableAuthorColors(doc, 'dark');

    const palette = PAGE_PALETTES.dark;
    for (const selector of ['h1', '.author-black', 'span']) {
      expect(colorOf(doc, selector)).toBe('rgb(228, 228, 231)');
      expect(contrastRatio(colorOf(doc, selector), palette.background)).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
    // A color with enough contrast is a meaningful signal: keep it.
    expect(colorOf(doc, '#meaningful')).toBe('rgb(253, 224, 71)');
    // Dark text on the book's own white callout box is readable where it sits.
    expect(colorOf(doc, '#callout')).toBe('rgb(0, 0, 0)');
  });

  it('keeps the fixture blue in Sepia, where it already contrasts, and rescues pale ink', () => {
    const doc = chapter(`
      <h1>Chapter One</h1>
      <em style="color: #fff7d6">Pale ink</em>
    `);

    applyReadableAuthorColors(doc, 'sepia');

    expect(colorOf(doc, 'h1')).toBe('rgb(32, 64, 128)');
    expect(
      contrastRatio(colorOf(doc, 'h1'), PAGE_PALETTES.sepia.background),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(colorOf(doc, 'em')).toBe('rgb(67, 52, 34)');
    expect(
      contrastRatio(colorOf(doc, 'em'), PAGE_PALETTES.sepia.background),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('puts back the book’s own colors when a theme no longer tints the page', () => {
    const doc = chapter(`
      <h1>Chapter One</h1>
      <p class="author-black">Body text</p>
      <u style="color: #111111 !important">Important ink</u>
    `);
    const undecorated = (selector: string) => colorOf(doc, selector);

    applyReadableAuthorColors(doc, 'dark');
    expect(undecorated('h1')).toBe('rgb(228, 228, 231)');
    expect(doc.querySelector('h1')?.hasAttribute('data-synapse-readable-color')).toBe(true);

    applyReadableAuthorColors(doc, 'light');

    expect(undecorated('h1')).toBe('rgb(32, 64, 128)');
    expect(undecorated('p')).toBe('rgb(0, 0, 0)');
    expect(undecorated('u')).toBe('rgb(17, 17, 17)');
    expect(doc.querySelectorAll('[data-synapse-readable-color]')).toHaveLength(0);

    revertAuthorColors(doc);
    expect(doc.querySelectorAll('[data-synapse-readable-color]')).toHaveLength(0);
  });

  it('does not stack replacements when the same theme is settled twice', () => {
    const doc = chapter('<h1>Chapter One</h1>');

    applyReadableAuthorColors(doc, 'dark');
    const overridden = colorOf(doc, 'h1');
    applyReadableAuthorColors(doc, 'dark');

    expect(colorOf(doc, 'h1')).toBe(overridden);
    expect(doc.querySelectorAll('[data-synapse-readable-color]')).toHaveLength(1);
  });
});
