import { assert } from './harness.mjs';

// DevTools modifier bits, as `Input.dispatchKeyEvent` expects them.
const ALT = 1;

const viewer = `[...document.querySelectorAll('[data-testid="txt-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const scroller = `${viewer}?.querySelector('[data-testid="txt-scroll"]')`;
const toolbar = `document.querySelector('[data-testid="unified-toolbar"]')`;
const titleIs = (title) =>
  `${toolbar}?.querySelector('[data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
const subtitle = `${toolbar}?.querySelector('[data-testid="reader-toolbar-subtitle"]')?.textContent ?? null`;
const subtitleIs = (label) => `${subtitle} === ${JSON.stringify(label)}`;
/** The heading's row is at the top of the page, give or take a rounding pixel. */
const topRowStartsWith = (text) =>
  `(() => {
    const top = ${scroller}.getBoundingClientRect().top;
    return [...${scroller}.querySelectorAll('[data-index]')].some(
      (row) => row.textContent.startsWith(${JSON.stringify(text)})
        && Math.abs(row.getBoundingClientRect().top - top) < 4);
  })()`;

/**
 * #52: a text file's map. `sample-chapters.txt` has a contents list, English parts and
 * chapters (one titled by an all-caps line), and Chinese chapters. The headings feed
 * Contents, the scrubber's ticks, the toolbar subtitle, and the chapter commands.
 */
export async function txtChaptersFlow(page) {
  await page.openUntil(`${viewer} && ${titleIs('sample-chapters')}`, 'the chapters TXT');

  // One tick per heading after the first line; the contents list adds none.
  const ticks = await page.waitFor(
    `(() => {
      const ticks = [...${viewer}.querySelectorAll('[data-testid="progress-scrubber-tick"]')]
        .map((tick) => parseFloat(tick.style.left));
      return ticks.length === 7 ? ticks : null;
    })()`,
    'a scrubber tick for each of the seven headings',
  );
  assert(
    ticks.every((tick, index) => index === 0 || tick > ticks[index - 1]),
    `ticks run in order: ${ticks}`,
  );

  await page.showSidebarTab('Table of Contents');
  const top = await page.evaluate(
    `[...document.querySelectorAll('[data-testid="navigator-sidebar"] [role="treeitem"][aria-level="1"]')].map((e) => e.getAttribute('aria-label'))`,
  );
  assert(
    JSON.stringify(top) === JSON.stringify(['PART ONE', 'Part Two']),
    `parts head the Contents: ${JSON.stringify(top)}`,
  );
  await page.expandTreeItem('Part Two');
  await page.clickTreeItem('第三章 归途');
  await page.waitFor(subtitleIs('第三章 归途'), 'Contents to jump to the Chinese chapter');
  await page.waitFor(topRowStartsWith('第三章 归途'), 'the heading at the top of the page');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="navigator-sidebar"] [role="treeitem"]')].find((e) => e.getAttribute('aria-current') === 'location')?.getAttribute('aria-label') === '第三章 归途'`,
    'Contents to mark the chapter being read',
  );
  await page.hideSidebar();

  // Next and Previous Chapter (⌥↓ and ⌥↑) on the page. `Part Two` and `第三章` open
  // one stretch of text, so they are one stop.
  await page.evaluate(`${scroller}.focus()`);
  await page.press('ArrowDown', 'ArrowDown', ALT);
  await page.waitFor(subtitleIs('第四章：灯塔'), 'Next Chapter');
  await page.waitFor(topRowStartsWith('第四章：灯塔'), 'Next Chapter to put the heading on top');
  await page.press('ArrowUp', 'ArrowUp', ALT);
  await page.waitFor(topRowStartsWith('Part Two'), 'Previous Chapter to the part');
  await page.waitFor(subtitleIs('Part Two'), 'the part in the subtitle');
  await page.press('ArrowUp', 'ArrowUp', ALT);
  await page.waitFor(topRowStartsWith('Chapter 2. The Lighthouse'), 'Previous Chapter again');
  await page.waitFor(subtitleIs('Chapter 2. The Lighthouse'), 'Chapter 2 in the subtitle');

  // Home is the start of the chapter being read, not of the file.
  await page.evaluate(`${scroller}.scrollBy({ top: 200 })`);
  await page.waitFor(`!(${topRowStartsWith('Chapter 2. The Lighthouse')})`, 'reading on');
  await page.waitFor(subtitleIs('Chapter 2. The Lighthouse'), 'still in Chapter 2');
  await page.press('Home', 'Home');
  await page.waitFor(topRowStartsWith('Chapter 2. The Lighthouse'), 'Home to the chapter start');

  // A last chapter shorter than the page cannot reach the top, but at the end of the
  // file it is the one being read.
  await page.press('ArrowDown', 'ArrowDown', ALT);
  await page.waitFor(subtitleIs('Part Two'), 'Next Chapter to the part');
  await page.press('ArrowDown', 'ArrowDown', ALT);
  await page.waitFor(subtitleIs('第四章：灯塔'), 'Next Chapter to the fourth chapter');
  await page.press('ArrowDown', 'ArrowDown', ALT);
  await page.waitFor(
    `${scroller}.scrollTop + ${scroller}.clientHeight >= ${scroller}.scrollHeight - 2`,
    'Next Chapter to the end of the file',
  );
  await new Promise((done) => setTimeout(done, 400));
  assert(
    (await page.evaluate(subtitle)) === 'Epilogue',
    `the epilogue is the chapter at the end: ${await page.evaluate(subtitle)}`,
  );
}
