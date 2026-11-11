import { assert } from './harness.mjs';

const visibleViewer = `[...document.querySelectorAll('[data-testid="epub-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const frameDocument = `${visibleViewer}?.querySelector('[data-testid="epub-host"] iframe')?.contentDocument`;
const chapterIs = (title) => `${frameDocument}?.querySelector('h1')?.textContent === '${title}'`;
const titleIs = (title) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
const readout = `${visibleViewer}?.querySelector('[data-testid="reader-footer-readout"]')`;

/** Clicks the footer readout until it shows `kind`, and returns its text. */
async function showReadout(page, kind) {
  return page.waitFor(
    `(() => {
      const button = ${readout};
      if (!button) return null;
      if (button.dataset.readout === ${JSON.stringify(kind)}) return button.textContent;
      button.click();
      return null;
    })()`,
    `the footer to show its ${kind} readout`,
  );
}

/**
 * #52: EPUB progress follows the text, not the spine. `sample-uneven.epub` has ten
 * short front-matter files before three chapters of very different lengths, so by
 * file Chapter One would open at 77% and the ticks would bunch at the end. This
 * runs the real epub.js engine: the background pass measures every chapter, then
 * the ticks, the percentage, the minutes readout, and the Recent list follow.
 */
export async function epubProgressFlow(page) {
  await page.openUntil(`${visibleViewer} && ${titleIs('sample-uneven')}`, 'the uneven EPUB');

  // Ticks for Title Page, Chapter One, Two and Three, placed by the text before them.
  // By spine file they would sit at 23%, 77%, 85% and 92%.
  const ticks = await page.waitFor(
    `(() => {
      const ticks = [...${visibleViewer}.querySelectorAll('[data-testid="progress-scrubber-tick"]')]
        .map((tick) => parseFloat(tick.style.left));
      return ticks.length === 4 && ticks[3] < 50 ? ticks : null;
    })()`,
    'the chapter ticks to move to where the text puts them',
  );
  const [titlePage, one, two, three] = ticks;
  assert(titlePage < 1 && one < 3, `front matter is a sliver of the book: ${ticks}`);
  assert(two > 25 && two < 32, `Chapter Two follows the long Chapter One: ${ticks}`);
  assert(three > 30 && three < 38, `Chapter Three holds most of the book: ${ticks}`);

  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('Chapter One');
  await page.waitFor(chapterIs('Chapter One'), 'the Contents jump to Chapter One');
  await page.hideSidebar();

  const position = await page.waitFor(
    `(() => {
      const slider = ${visibleViewer}.querySelector('[role="slider"]');
      const text = slider?.getAttribute('aria-valuetext') ?? '';
      return text.startsWith('Chapter 11 of 13') ? { now: Number(slider.getAttribute('aria-valuenow')), text } : null;
    })()`,
    'the scrubber to report Chapter One',
  );
  assert(position.now <= 3, `Chapter One starts near the start of the book: ${position.text}`);

  const percent = await showReadout(page, 'percent');
  assert(
    /^[0-9]% of book$/.test(percent),
    `Chapter One's first page is a few percent in: ${percent}`,
  );
  const minutes = await showReadout(page, 'minutes');
  assert(
    /^(About \d+ minutes? left in chapter|Less than a minute left in chapter)$/.test(minutes),
    `the footer estimates the time left in the chapter: ${minutes}`,
  );

  // The saved position carries the same percentage to the Recent list. The cursor
  // report is debounced, and the cover reported 0% when measuring finished, so this
  // waits for the footer's figure rather than any percentage.
  const shown = `Continue reading · ${percent.replace(' of book', '')}`;
  await page.clickButton('Recent documents');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="recent-documents-menu"] [data-testid="recent-document-item"]')]
      .some((entry) => entry.textContent.includes('sample-uneven')
        && entry.textContent.includes(${JSON.stringify(shown)}))`,
    `the Recent list to say ${shown}`,
  );
}
