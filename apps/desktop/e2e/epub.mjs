import { assert } from './harness.mjs';

const visibleHost = `[...document.querySelectorAll('[data-testid="epub-host"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const frame = `${visibleHost}?.querySelector('iframe')`;
const frameDocument = `${frame}?.contentDocument`;
const scroller = `${visibleHost}?.querySelector('.epub-container')`;
const excerptEnabled = `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`;

/** The text `measureCharWidth` samples; see `appearance/measure.ts`. */
const MEASURE_SAMPLE =
  'The quick brown fox jumps over the lazy dog, and then reads a chapter or two of a good book.';
// 45–75ch, with room for the gap between the canvas measure and the page's own.
const MIN_PER_LINE = 45;
const MAX_PER_LINE = 78;

const openEpub = (page) => page.openUntil(visibleHost, 'the EPUB');

const chapterIs = (title) => `${frameDocument}?.querySelector('h1')?.textContent === '${title}'`;

/** Where text in the book's frame sits on screen, for a real mouse drag. */
const textPoints = (page, text) =>
  page.waitFor(
    `(() => {
      const view = ${frame};
      const book = view?.contentDocument;
      if (!book) return null;
      const walker = book.createTreeWalker(book.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.data.indexOf(${JSON.stringify(text)});
        if (index === -1) continue;
        const range = book.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + ${JSON.stringify(text)}.length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const outer = view.getBoundingClientRect();
        const first = rects[0];
        const last = rects[rects.length - 1];
        return {
          start: { x: outer.left + first.left + 0.5, y: outer.top + first.top + first.height / 2 },
          end: { x: outer.left + last.right - 0.5, y: outer.top + last.top + last.height / 2 },
        };
      }
      return null;
    })()`,
    `text in the book: ${text}`,
  );

const excerpt = async (page, text) => {
  const points = await textPoints(page, text);
  await page.drag(points.start, points.end);
  await page.waitFor(excerptEnabled, `selecting "${text}" to enable excerpting`);
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector(${JSON.stringify(`[aria-label="Jump to source of ${text}"]`)})`,
    `a card titled "${text}"`,
  );
  return points;
};

export async function epubFlow(page) {
  // MindMap and inspector start collapsed so the reader opens full-screen.
  const initialPanes = await page.evaluate(`({
    reader: document.getElementById('reader').getBoundingClientRect().width,
    mindmap: document.getElementById('mindmap').getBoundingClientRect().width,
    inspector: document.getElementById('inspector').getBoundingClientRect().width,
    viewport: window.innerWidth,
  })`);
  assert(
    initialPanes.mindmap === 0 && initialPanes.inspector === 0,
    `MindMap and inspector must start hidden: ${JSON.stringify(initialPanes)}`,
  );
  assert(
    initialPanes.reader >= initialPanes.viewport - 4,
    `reader must start full-screen: ${JSON.stringify(initialPanes)}`,
  );

  await page.clickButton('Show MindMap');
  await openEpub(page);
  await page.waitFor(chapterIs('Chapter One'), 'the first chapter to render');
  // The hostile content in the fixture must not have run, or even survived.
  const security = await page.evaluate(`(() => {
    const book = ${frameDocument};
    return {
      parent: window.__bookScriptRan ?? null,
      script: book.documentElement.getAttribute('data-book-script-ran'),
      handler: book.documentElement.getAttribute('data-book-handler-ran'),
      scriptTags: book.querySelectorAll('script').length,
      handlers: book.querySelectorAll('[onerror]').length,
      sandbox: ${frame}.getAttribute('sandbox'),
    };
  })()`);
  assert(security.parent === null, 'a book script reached the parent window');
  assert(security.script === null, 'a book script ran');
  assert(security.handler === null, 'a book event handler ran');
  assert(security.scriptTags === 0 && security.handlers === 0, 'sanitizing removed active content');
  assert(security.sandbox.includes('allow-scripts'), `sandbox for WebKit: ${security.sandbox}`);

  // Resources come out of the archive, under the CSP.
  await page.waitFor(
    `${frameDocument}.querySelector('img[alt="a small box"]')?.naturalWidth === 8`,
    'the book image to load from the archive',
  );
  const heading = await page.evaluate(
    `getComputedStyle(${frameDocument}.querySelector('h1')).color`,
  );
  assert(heading === 'rgb(32, 64, 128)', `the book's stylesheet applies: ${heading}`);
  const hasTypography = await page.evaluate(
    `Boolean(${frameDocument}.querySelector('style[data-synapse-typography]'))`,
  );
  assert(hasTypography, 'iBooks-like typography defaults are injected');
  // selection -> CFI -> persist, with a real drag inside the frame.
  const points = await excerpt(page, 'quick brown fox');

  // The highlight is drawn outside the frame, so its position proves the CFI resolved.
  const mark = await page.waitFor(
    `(() => {
      const element = ${visibleHost}.querySelector('g[data-annotation-id] rect');
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    })()`,
    'the highlight to draw',
  );
  assert(Math.abs(mark.left - points.start.x) < 4, 'the highlight starts at the text');
  assert(Math.abs(mark.y - points.start.y) < 6, 'the highlight is on the text line');

  // Multibyte text in another paragraph.
  await excerpt(page, '汉字');

  // Page turns: a click in the right edge of the page (inside the chapter frame),
  // a real Space press, and the edge chevron, until the second chapter shows.
  const location = `${visibleHost}.querySelector('.epub-container')?.scrollLeft ?? 0`;
  const edge = await page.evaluate(`(() => {
    const r = ${visibleHost}.getBoundingClientRect();
    return { x: r.right - 6, y: r.top + r.height - 12 };
  })()`);
  // The excerpts above leave a selection, and the click that dismisses one only does that.
  await page.evaluate(`${frameDocument}.getSelection().removeAllRanges()`);
  const before = await page.evaluate(`${location}`);
  await page.click(edge);
  await page.waitFor(
    `${chapterIs('Chapter Two')} || (${location}) !== ${before}`,
    'a click in the page edge to turn the page',
  );
  await page.evaluate(`${visibleHost}.focus()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(chapterIs('Chapter Two'))) break;
    if (attempt % 2 === 0) await page.press(' ', 'Space');
    else await page.clickButton('Next Page');
    await new Promise((done) => setTimeout(done, 120));
  }
  await page.waitFor(chapterIs('Chapter Two'), 'the second chapter');
  // The page slides in as it turns; text moves until the transition ends.
  await page.waitFor(`${visibleHost}.getAnimations().length === 0`, 'the page turn to settle');
  await excerpt(page, 'final target sentence');

  // Jump across chapters: the frame's chapter changes, and the highlight pulses.
  await page.clickButton('Jump to source of quick brown fox');
  await page.waitFor(chapterIs('Chapter One'), 'the jump to change chapter');
  await page.waitFor(`${visibleHost}.querySelector('g.anchor-pulse')`, 'the highlight to pulse');
  await page.waitFor(`!${visibleHost}.querySelector('g.anchor-pulse')`, 'the pulse to end');

  // And back: a highlight in the other chapter must repaint when it is shown again.
  // The newest card can sit outside the canvas viewport, where a mouse cannot reach it.
  await page.evaluate(
    `document.querySelector('[aria-label="Jump to source of final target sentence"]').click()`,
  );
  await page.waitFor(chapterIs('Chapter Two'), 'the jump back');
  await page.waitFor(`${visibleHost}.querySelector('g.anchor-pulse')`, 'the second pulse');
  await page.waitFor(`!${visibleHost}.querySelector('g.anchor-pulse')`, 'the second pulse to end');

  // Long enough for the debounced position to be saved.
  await new Promise((done) => setTimeout(done, 700));

  // Per-tab state: the book and its chapter survive a tab switch.
  await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].at(0).click()`);
  await page.waitFor(`!${visibleHost}`, 'the book tab to be hidden');
  await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].at(2).click()`);
  await page.waitFor(chapterIs('Chapter Two'), 'the chapter to survive a tab switch');

  // Reopen from a clean mount, at the saved chapter rather than the first.
  await page.evaluate(
    `[...document.querySelectorAll('[aria-label^="Close sample"]')].at(2).click()`,
  );
  await page.waitFor(`!${visibleHost}`, 'the tab to close');
  await openEpub(page);
  await page.waitFor(chapterIs('Chapter Two'), 'reopening at the last chapter');
  await page.waitFor(
    `${visibleHost}.querySelector('g[data-annotation-id] rect')`,
    'the reopened chapter to repaint its highlight',
  );
  assert(await page.evaluate(`!!${scroller}`), 'the book scrolls inside its container');

  // Reading modes: defaults to two-page spread, and switches to single-page and scroll.
  const visibleViewer = `[...document.querySelectorAll('[data-testid="epub-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  assert(
    (await page.evaluate(`${visibleViewer}.dataset.readingMode`)) === 'spread',
    'defaults to two-page spread mode',
  );
  // Collapse MindMap and verify the EPUB host expands across the full reader pane without wide side margins.
  await page.clickButton('Hide MindMap');
  await page.waitFor(
    `(() => {
      const reader = document.getElementById('reader').getBoundingClientRect().width;
      const host = ${visibleHost}.getBoundingClientRect().width;
      return reader >= window.innerWidth - 4 && host >= reader - 32;
    })()`,
    'EPUB host to fill the full-screen reader pane in spread mode',
  );
  await page.clickButton('Single page');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'paged'`, 'single-page mode');
  await page.waitFor(chapterIs('Chapter Two'), 'chapter preserved in single-page mode');
  // Progress lives in the footer under the page; the toolbar names the chapter.
  await page.waitFor(
    `${visibleViewer}.querySelector('[data-testid="reader-footer-readout"]')?.textContent.match(/in chapter|% of book/)`,
    'the footer to show progress',
  );
  assert(
    await page.evaluate(
      `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-subtitle"]')?.textContent.length > 0`,
    ),
    'the toolbar subtitle names the chapter',
  );
  const footer = await page.evaluate(`(() => {
    const readout = ${visibleViewer}.querySelector('[data-testid="reader-footer-readout"]');
    const slider = ${visibleViewer}.querySelector('[role="slider"]');
    return {
      fontSize: parseFloat(getComputedStyle(readout).fontSize),
      valueText: slider?.getAttribute('aria-valuetext') ?? '',
    };
  })()`);
  assert(footer.fontSize >= 11, `footer text is at least 11 pt: ${footer.fontSize}`);
  assert(
    /^Chapter 2 of 2, \d+%$/.test(footer.valueText),
    `the scrubber speaks the chapter and percentage: ${footer.valueText}`,
  );

  // Table of contents: nested items, chapter jump, and return to previous location.
  await page.showSidebarTab('Table of Contents');
  await page.waitFor(
    `${visibleViewer}.querySelector('[data-testid="reader-toc"]')`,
    'EPUB table of contents sidebar',
  );
  // Only the current chapter's path starts expanded; open One to reach its section.
  await page.expandTreeItem('One');
  await page.waitFor(
    `[...${visibleViewer}.querySelectorAll('[data-testid="reader-toc"] [role="treeitem"]')].some((b) => b.getAttribute('aria-label') === 'Section 1.1')`,
    'EPUB TOC renders nested entries',
  );
  await page.clickTreeItem('One');
  await page.waitFor(chapterIs('Chapter One'), 'TOC jump to Chapter One');
  await page.clickButton('Return to previous location');
  await page.waitFor(chapterIs('Chapter Two'), 'return to Chapter Two after TOC jump');

  await page.clickButton('Scroll');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'scroll'`, 'scroll mode');
  await page.waitFor(chapterIs('Chapter Two'), 'chapter preserved in scroll mode');

  // Reading appearance: the "Aa" popover, and a theme that tints the whole reader window.
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'EPUB appearance popover',
  );
  await page.clickButton('Sepia');
  await page.waitFor(`${visibleViewer}.dataset.readingTheme === 'sepia'`, 'sepia theme');
  const sepiaBg = await page.evaluate(`getComputedStyle(${frameDocument}.body).backgroundColor`);
  assert(sepiaBg === 'rgb(244, 236, 216)', `EPUB frame body applies sepia background: ${sepiaBg}`);
  const sepiaChrome = await page.evaluate(
    `getComputedStyle(document.querySelector('[data-testid="unified-toolbar"]')).backgroundColor`,
  );
  assert(sepiaChrome === 'rgb(239, 230, 209)', `the toolbar takes sepia chrome: ${sepiaChrome}`);

  // Chrome text meets WCAG AA in every theme, popover included.
  for (const theme of ['Light', 'Sepia', 'Dark']) {
    await page.clickButton(theme);
    await page.waitFor(
      `${visibleViewer}.dataset.resolvedTheme === '${theme.toLowerCase()}'`,
      `${theme} theme`,
    );
    await page.assertContrast(
      '[data-testid="unified-toolbar"], [aria-label="Document reader"]',
      `EPUB ${theme} chrome`,
    );
  }
  await page.clickButton('Auto');
  await page.waitFor(
    `${visibleViewer}.dataset.resolvedTheme === 'light'`,
    'Auto follows the system',
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'Esc closes the appearance popover',
  );
  assert(
    await page.evaluate(
      `document.activeElement?.getAttribute('aria-label') === 'Reading appearance'`,
    ),
    'focus returns to the Aa button',
  );

  // The reading measure holds from a laptop to a large display.
  await page.clickButton('Two pages');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'spread'`, 'two-page mode');
  for (const width of [1280, 1728, 2560]) {
    await page.setViewport(width);
    const measure = await page.waitFor(
      `(() => {
        // A paginated frame is as wide as all its pages; the paragraph is one column.
        const paragraph = ${frame}?.contentDocument?.querySelector('p');
        if (!paragraph) return null;
        const probe = paragraph.ownerDocument.createElement('span');
        probe.textContent = ${JSON.stringify(MEASURE_SAMPLE)};
        probe.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap';
        paragraph.appendChild(probe);
        const advance = probe.getBoundingClientRect().width / probe.textContent.length;
        probe.remove();
        const perLine = paragraph.getBoundingClientRect().width / advance;
        if (perLine < ${MIN_PER_LINE} || perLine > ${MAX_PER_LINE}) return null;
        const spine = document.querySelector('[data-testid="epub-spine"]');
        return {
          perLine,
          columns: Number(${visibleViewer}.dataset.columns),
          spine: spine ? spine.getBoundingClientRect().width : 0,
        };
      })()`,
      `${MIN_PER_LINE}–${MAX_PER_LINE} characters per line at ${width} px`,
    );
    console.log(
      `     epub: ${width} px, ${measure.columns} pages, ${measure.perLine.toFixed(1)} characters per line`,
    );
    if (width >= 1728) {
      assert(measure.columns === 2, `two pages at ${width} px`);
      assert(measure.spine >= 48, `a spine gutter of 48 px at ${width} px: ${measure.spine}`);
    }
  }
  await page.cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.clickButton('Scroll');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'scroll'`, 'back to scroll mode');

  // In-document search across unrendered EPUB chapters, CFI highlight, and return.
  await page.setInputValue('[data-testid="search-input"]', 'quick brown fox');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '1 of 1'`,
    'EPUB search match in unrendered Chapter One',
  );
  await page.waitFor(
    `${visibleViewer}?.querySelector('[data-testid="search-result-location"]')?.textContent === 'One'`,
    'EPUB search result location for Chapter 1',
  );
  await page.waitFor(chapterIs('Chapter One'), 'EPUB search jump to Chapter One');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id="__search_active__"] rect')`,
    'EPUB active search highlight',
  );
  await page.clickButton('Return to previous location');
  await page.waitFor(chapterIs('Chapter Two'), 'returning from EPUB search jump to Chapter Two');
  await page.leaveSearch();

  // Independent bookmarks in EPUB: bookmark Chapter Two, jump to Chapter One, jump back via bookmark, and remove.
  await page.clickButton('Bookmark current location');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="toggle-bookmark-button"]')?.getAttribute('aria-pressed') === 'true'`,
    'EPUB bookmark toggle pressed',
  );
  await page.clickTreeItem('One');
  await page.waitFor(chapterIs('Chapter One'), 'EPUB jump to Chapter One before bookmark jump');
  await page.showSidebarTab('Bookmarks');
  await page.waitFor(
    `${visibleViewer}?.querySelector('[data-testid="bookmark-jump-button"]')`,
    'EPUB bookmark item in list',
  );
  await page.evaluate(
    `${visibleViewer}.querySelector('[data-testid="bookmark-jump-button"]').click()`,
  );
  await page.waitFor(chapterIs('Chapter Two'), 'jumping to EPUB bookmark in Chapter Two');
  await page.evaluate(
    `${visibleViewer}.querySelector('[data-testid="bookmark-remove-button"]').click()`,
  );
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="bookmarks-empty"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    'removing EPUB bookmark',
  );
  await page.hideSidebar();

  // Independent highlights & notes in EPUB: highlight without creating a MindMap card, delete, and undo.
  const epubPoints = await textPoints(page, 'final target sentence');
  await page.drag(epubPoints.start, epubPoints.end);
  await page.clickButton('Yellow highlight');
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="annotation-item"]')].filter((e) => e.checkVisibility({ visibilityProperty: true })).length === 4`,
    'EPUB independent highlight count (3 excerpts + 1 independent)',
  );
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `${visibleViewer}?.querySelectorAll('[data-testid="annotation-item"]').length === 4`,
    'EPUB annotations list items',
  );
  await page.evaluate(
    `[...${visibleViewer}.querySelectorAll('[data-testid="annotation-delete-button"]')].at(-1).click()`,
  );
  await page.waitFor(
    `${visibleViewer}?.querySelectorAll('[data-testid="annotation-item"]').length === 3`,
    'deleting EPUB independent highlight',
  );
  await page.evaluate(
    `${visibleViewer}.querySelector('[data-testid="undo-delete-annotation-button"]').click()`,
  );
  await page.waitFor(
    `${visibleViewer}?.querySelectorAll('[data-testid="annotation-item"]').length === 4`,
    'undoing EPUB highlight deletion',
  );
  await page.hideSidebar();
}
