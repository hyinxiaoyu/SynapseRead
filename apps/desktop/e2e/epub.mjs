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

const statusIs = (value) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '${value}'`;
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

  // An internal book link joins the jump history, and its chip returns to the page
  // it was followed from.
  const linkPoint = await textPoints(page, 'Go to Chapter Two');
  await page.click(linkPoint.start);
  await page.waitFor(chapterIs('Chapter Two'), 'an internal link to change chapter');
  const linkChip = await page.waitFor(
    `document.querySelector('[data-testid="reader-back-chip"]')?.textContent`,
    'the Back chip after an internal link',
  );
  assert(linkChip.startsWith('Back to'), `internal link Back chip: ${linkChip}`);
  await page.evaluate(`document.querySelector('[data-testid="reader-back-chip"]').click()`);
  await page.waitFor(chapterIs('Chapter One'), 'the internal link Back chip to return');

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

  // Per-tab state: the book and its chapter survive a tab switch. The TXT, PDF,
  // and EPUB tabs were opened in that order, so switching back reaches both of the
  // earlier ones.
  for (const tab of [0, 1]) {
    await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].at(${tab}).click()`);
    await page.waitFor(`!${visibleHost}`, `the book tab to be hidden behind tab ${tab + 1}`);
    // #43: epub.js marks its views visible inline, which used to paint a background
    // EPUB over the active one. The inert panel keeps the frame hidden, not removed.
    const backgroundFrame = await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll('[role="tabpanel"]')].find(
        (p) => p.querySelector('[data-testid="epub-host"]'));
      const frame = panel?.querySelector('iframe');
      const view = panel?.querySelector('.epub-view');
      return {
        frame: frame ? getComputedStyle(frame).visibility : null,
        view: view ? getComputedStyle(view).visibility : null,
      };
    })()`);
    assert(
      backgroundFrame.frame === 'hidden' && backgroundFrame.view === 'hidden',
      `a background EPUB frame must stay hidden behind tab ${tab + 1}: ${JSON.stringify(backgroundFrame)}`,
    );
  }
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
  // Collapse MindMap and verify the EPUB page area fills the full reader pane in two-page spread mode.
  await page.clickButton('Hide MindMap');
  await page.waitFor(
    `(() => {
      const reader = document.getElementById('reader').getBoundingClientRect().width;
      const area = ${visibleViewer}.querySelector('[data-testid="epub-page-area"]').getBoundingClientRect().width;
      return reader >= window.innerWidth - 4 && area >= reader - 4 && Number(${visibleViewer}.dataset.columns) === 2;
    })()`,
    'EPUB page area to fill the full-screen reader pane in spread mode',
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
    // The fixture's heading sets #204080, which is 1.78:1 on the Dark page.
    // Only colors below AA are replaced; the same blue is legible on Light and Sepia.
    const expectedInk = theme === 'Dark' ? 'rgb(228, 228, 231)' : 'rgb(32, 64, 128)';
    const headingInk = await page.waitFor(
      `(() => {
        const book = ${frameDocument};
        const heading = book?.querySelector('h1');
        const body = book?.body;
        if (!heading || !body) return null;
        const color = getComputedStyle(heading).color;
        if (color !== ${JSON.stringify(expectedInk)}) return null;
        const channel = (c) => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (value) => {
          const parts = (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
          const [r, g, b] = parts.map(channel);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ink = luminance(color);
        const paper = luminance(getComputedStyle(body).backgroundColor);
        return {
          color,
          ratio: (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05),
        };
      })()`,
      `EPUB ${theme} heading at ${expectedInk}`,
    );
    assert(
      headingInk.ratio >= 4.5,
      `EPUB ${theme} heading meets AA: ${headingInk.color} at ${headingInk.ratio.toFixed(2)}:1`,
    );
  }
  await page.clickButton('Auto');
  await page.waitFor(
    `${visibleViewer}.dataset.resolvedTheme === 'light'`,
    'Auto follows the system',
  );
  // Leaving the tinted theme puts the book's own color back.
  await page.waitFor(
    `getComputedStyle(${frameDocument}.querySelector('h1')).color === 'rgb(32, 64, 128)'`,
    'the author color after leaving Dark',
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
  for (const mode of ['Two pages', 'Single page', 'Scroll']) {
    await page.clickButton(mode);
    await page.clickButton('Reading appearance');
    await page.clickButton('Standard');
    const hostWidth = `${visibleHost}.getBoundingClientRect().width`;
    await page.waitFor(`${hostWidth} < 1600`, `EPUB ${mode} standard width settles`);
    const standardWidth = await page.evaluate(hostWidth);
    await page.clickButton('Wide');
    await page.waitFor(
      `${hostWidth} > ${standardWidth} + 100`,
      `EPUB ${mode} Wide expands the host`,
    );
    await page.clickButton('Full width');
    await page.waitFor(
      `${hostWidth} >= ${visibleHost}.parentElement.clientWidth - 33`,
      `EPUB ${mode} Full width fills the pane`,
    );
    // Wait for epub.js's debounced resize, not just the outer React container.
    await page.waitFor(
      `(() => {
      const paragraph = ${frameDocument}?.querySelector('p');
      return paragraph && paragraph.getBoundingClientRect().width > 800;
    })()`,
      `EPUB ${mode} actual text expands beyond the standard cap`,
    );
    await page.press('Escape');
  }
  await page.setViewport(480);
  await page.waitFor(
    `${visibleHost}.getBoundingClientRect().width <= 480`,
    'EPUB Full width fits a narrow pane',
  );
  await page.clickButton('Reading appearance');
  await page.clickButton('Standard');
  await page.press('Escape');
  await page.cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.clickButton('Scroll');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'scroll'`, 'back to scroll mode');

  // In-document search across unrendered EPUB chapters, CFI highlight, and return.
  // The sidebar is already open, so the results take over its view (#44).
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

  // The same folded matcher reads accents, curly quotes, a soft hyphen, and a
  // word split at a line end.
  await page.setInputValue('[data-testid="search-input"]', 'cafe');
  await page.waitFor(statusIs('1 of 1'), 'EPUB accent-insensitive search');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id="__search_active__"] rect')`,
    'EPUB accent-folded highlight',
  );

  await page.setInputValue('[data-testid="search-input"]', 'hyphenated');
  await page.waitFor(statusIs('1 of 1'), 'EPUB search across a line-end hyphen');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id="__search_active__"] rect')`,
    'EPUB line-end hyphen highlight',
  );

  await page.setInputValue('[data-testid="search-input"]', '"curly quote" - an em dash');
  await page.waitFor(statusIs('1 of 1'), 'EPUB quote and dash folding');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id="__search_active__"] rect')`,
    'EPUB curly-quote highlight',
  );

  // Two matches in the rendered chapter: the inactive one is tinted and lands on
  // the scrubber together with the active one.
  await page.setInputValue('[data-testid="search-input"]', 'and');
  await page.waitFor(statusIs('1 of 2'), 'EPUB multiple matches in one chapter');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id^="__search_match_"] rect')`,
    'EPUB inactive matches tinted',
  );
  await page.waitFor(
    `document.querySelectorAll('[data-testid="progress-scrubber-search-mark"]').length === 1`,
    'EPUB search matches marked on the scrubber',
  );
  // The bookmark flow below starts from Chapter Two, so put the reader back there.
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('Two');
  await page.waitFor(chapterIs('Chapter Two'), 'returning to Chapter Two after the folding checks');
  await page.leaveSearch();
  // Clearing the query puts the view back and leaves the sidebar open.
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="navigator-sidebar"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    'the sidebar to stay open after the search is cleared',
  );

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

  // Back-to-back jumps: the newer one wins. epub.js resolves the older display as soon
  // as the newer one replaces it, and the older jump must not be re-issued over it (#41).
  await page.showSidebarTab('Table of Contents');
  await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="treeitem"]')];
    const jump = (label) => items.find((item) => item.getAttribute('aria-label') === label)?.click();
    jump('One');
    jump('Two');
  })()`);
  await page.waitFor(chapterIs('Chapter Two'), 'the newer of two back-to-back jumps to win');
  await page.hideSidebar();

  // A resize that lands while a jump is in flight must not undo it or leave the viewport
  // blank. epub.js clears its views on resize and re-displays `location.start.cfi`;
  // forcing a resize right as the return jump starts reproduces the overlap (#41).
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('One');
  await page.waitFor(chapterIs('Chapter One'), 'EPUB jump to Chapter One before the resize');
  await page.hideSidebar();
  await page.clickButton('Return to previous location');
  await page.evaluate(`(() => {
    const host = ${visibleHost};
    setTimeout(() => {
      host.style.width = '420px';
      host.getBoundingClientRect();
      window.dispatchEvent(new Event('resize'));
    }, 0);
  })()`);
  await page.waitFor(chapterIs('Chapter Two'), 'a resize during a jump not to undo it');
  await page.evaluate(`(${visibleHost}).style.width = ''`);
  await page.waitFor(
    `${visibleHost}.getBoundingClientRect().width > 420`,
    'the resized page area to return to its width',
  );
  await page.waitFor(chapterIs('Chapter Two'), 'restoring width after jump to keep Chapter Two');

  // An in-chapter jump must return to where it started even if a resize lands on the
  // return: epub.js re-displays its last reported location, which is now an anchor in
  // this same chapter, and a section check cannot tell the two positions apart (#41).
  const scrollerTop = `${visibleHost}.querySelector('.epub-container')?.scrollTop ?? 0`;
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('One');
  await page.waitFor(
    chapterIs('Chapter One'),
    'EPUB jump to Chapter One before the in-chapter return',
  );
  const originTop = await page.evaluate(scrollerTop);
  await page.expandTreeItem('One');
  await page.clickTreeItem('Section 1.1');
  await page.waitFor(
    `(${scrollerTop}) > ${originTop + 200}`,
    'the in-chapter jump to move down the chapter',
  );
  await page.hideSidebar();
  await page.clickButton('Return to previous location');
  await page.evaluate(`(() => {
    const host = ${visibleHost};
    setTimeout(() => {
      host.style.width = '420px';
      host.getBoundingClientRect();
      window.dispatchEvent(new Event('resize'));
    }, 0);
  })()`);
  await page.waitFor(
    `(${scrollerTop}) < ${originTop + 200}`,
    'an in-chapter return to survive a resize',
  );
  await page.evaluate(`(${visibleHost}).style.width = ''`);

  await focusModeFlow(page, visibleViewer);
}

/** Where the first line of text on the current page sits in the window. */
const firstLineTop = `(() => {
  const host = ${visibleHost};
  const view = host?.querySelector('iframe');
  const book = view?.contentDocument;
  if (!book?.body) return null;
  const shown = host.getBoundingClientRect();
  const outer = view.getBoundingClientRect();
  let top = Infinity;
  const walker = book.createTreeWalker(book.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.trim()) continue;
    const range = book.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      const left = outer.left + r.left;
      if (r.width === 0 || left < shown.left || left >= shown.right) continue;
      top = Math.min(top, outer.top + r.top);
    }
  }
  return Number.isFinite(top) ? top : null;
})()`;

/** A short stretch of the first line on the current page, for a real drag. */
const firstLineWords = `(() => {
  const host = ${visibleHost};
  const view = host?.querySelector('iframe');
  const book = view?.contentDocument;
  if (!book?.body) return null;
  const shown = host.getBoundingClientRect();
  const outer = view.getBoundingClientRect();
  const walker = book.createTreeWalker(book.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.data.trim().length < 12) continue;
    const range = book.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      const left = outer.left + r.left;
      if (r.width < 80 || left < shown.left || left + r.width > shown.right) continue;
      const y = outer.top + r.top + r.height / 2;
      return { start: { x: left + 2, y }, end: { x: left + Math.min(r.width - 2, 140), y } };
    }
  }
  return null;
})()`;

/** Flips "Focus mode uses full screen", which sits at the end of the Aa popover. */
async function toggleFocusFullScreen(page) {
  await page.clickButton('Reading appearance');
  const reveal = (name) =>
    page.evaluate(`[...document.querySelectorAll('[data-testid="appearance-popover"] button')]
      .find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})
      ?.scrollIntoView({ block: 'center' })`);
  await reveal('Customize');
  await page.clickButton('Customize');
  await page.waitFor(
    `!document.querySelector('[data-testid="focus-full-screen-switch"]')?.closest('[inert]')`,
    'Customize to open',
  );
  // The disclosure animates open; scroll once it has its height.
  await new Promise((done) => setTimeout(done, 300));
  await reveal('Focus mode uses full screen');
  await page.clickButton('Focus mode uses full screen');
}

/** Focus mode keeps the chrome off the text (#45). */
async function focusModeFlow(page, visibleViewer) {
  const toolbar = `document.querySelector('[data-testid="unified-toolbar"]')`;
  await page.clickButton('Single page');
  await page.waitFor(`${visibleViewer}.dataset.readingMode === 'paged'`, 'single-page mode');
  // A continuation page, where the text starts right at the top margin.
  await page.evaluate(`${visibleHost}.focus()`);
  await page.press('End');
  await page.waitFor(firstLineTop, 'text on the last page of the chapter');

  await page.enterFocusMode(visibleHost);
  await page.waitFor(
    `getComputedStyle(${visibleViewer}.querySelector('[data-testid="epub-page-area"]')).paddingTop === '48px'`,
    'the toolbar band as the top margin',
  );
  const toolbarBottom = await page.evaluate(`${toolbar}.getBoundingClientRect().height`);
  const top = await page.waitFor(
    `(() => { const top = ${firstLineTop}; return top !== null && top >= ${toolbarBottom} ? top : null; })()`,
    `the first line below the ${toolbarBottom} px toolbar`,
  );
  console.log(`     epub: focus mode, first line at ${top.toFixed(0)} px`);

  // A page turn shows on the page; the toolbar stays away.
  await page.press('ArrowRight');
  await page.assertToolbarStaysHidden('ArrowRight in EPUB focus mode');

  // Esc inside the chapter: the selection's popover first, then focus mode.
  const words = await page.waitFor(firstLineWords, 'a line of text on the page');
  await page.drag(words.start, words.end);
  await page.waitFor(
    `document.querySelector('[data-testid="selection-popover"]')`,
    'the selection popover in focus mode',
  );
  await page.waitFor(
    `document.activeElement === ${visibleHost}.querySelector('iframe')`,
    'focus inside the chapter after selecting',
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="selection-popover"]')`,
    'Esc in the chapter to close the popover',
  );
  assert(await page.inFocusMode(), 'the first Esc only closes the popover');
  // Click back into the text, so the next Esc also starts inside the chapter.
  await page.click(words.start);
  await page.waitFor(
    `document.activeElement === ${visibleHost}.querySelector('iframe')`,
    'focus back inside the chapter',
  );
  await page.press('Escape');
  await page.waitFor(`!(${toolbar}.dataset.immersive)`, 'Esc in the chapter to leave focus mode');

  // "Focus mode uses full screen" ties the two together.
  await toggleFocusFullScreen(page);
  await page.waitFor(
    `document.querySelector('[data-testid="focus-full-screen-switch"]')?.getAttribute('aria-checked') === 'true'`,
    'the full-screen preference on',
  );
  await page.press('Escape');
  await page.waitFor(`!document.querySelector('[data-testid="appearance-popover"]')`, 'Aa closed');
  await page.clickButton('Enter focus mode');
  await page.waitFor('document.fullscreenElement !== null', 'focus mode to enter full screen');
  // The window changed size under the pointer; bring the toolbar back from the top edge.
  await page.mouse('mouseMoved', 200, 2);
  await page.clickButton('Exit focus mode');
  await page.waitFor('document.fullscreenElement === null', 'leaving focus mode to leave it');
  assert(!(await page.inFocusMode()), 'focus mode off');
  await toggleFocusFullScreen(page);
  await page.press('Escape');
}
