import { assert } from './harness.mjs';

const TEXT = '.textLayer span';
const visibleScroller = `[...document.querySelectorAll('[data-testid="pdf-scroll"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const statusIs = (value) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '${value}'`;
const excerptEnabled = `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`;

/** Dark or coloured pixels in a page's canvas: a blank canvas would have none. */
const inkOn = (pageIndex) => `(() => {
  const canvas = document.querySelector('[data-page-index="${pageIndex}"] canvas');
  if (!canvas || canvas.width === 0) return 0;
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 3] > 0) ink += 1;
  return ink;
})()`;

const openPdf = (page) => page.openUntil(visibleScroller, 'the PDF');

const scrollToPage = async (page, pageIndex) => {
  // The virtualizer only renders nearby pages, so aim for it, then align exactly.
  await page.waitFor(
    `(() => {
      const scroller = ${visibleScroller};
      const target = document.querySelector('[data-page-index="${pageIndex}"]');
      if (target) { target.scrollIntoView({ block: 'start' }); return true; }
      // The fixture's five pages are close enough in height to aim by proportion.
      scroller.scrollTop = (scroller.scrollHeight * ${pageIndex}) / 5;
      return false;
    })()`,
    `page ${pageIndex} to render`,
  );
};

export async function pdfFlow(page) {
  await page.clickButton('Show MindMap');
  await page.clickButton('Show inspector');
  await openPdf(page);

  // The worker: a rendered page does not prove this, as pdf.js falls back silently.
  await page.waitFor(`document.querySelector('[data-testid="pdf-viewer"]')`, 'the PDF to open');
  const worker = await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"]').dataset.pdfWorker`,
  );
  assert(worker === 'worker', `pdf.js must use a real worker, but used: ${worker}`);

  await page.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(TEXT)})].some((e) => e.textContent.includes('quick brown fox'))`,
    'the text layer to render',
  );
  await page.waitFor(`${inkOn(0)} > 100`, 'the canvas to show text');

  // selection -> anchor -> persist, with a real drag over the real text layer.
  const selected = 'quick brown fox';
  const expected = await page.textRect(TEXT, selected);
  await page.selectText(TEXT, selected);
  await page.waitFor(excerptEnabled, 'a real drag to enable excerpting');
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector('[aria-label^="Jump to source of quick brown fox"]')`,
    'a card titled with the selected text',
  );

  // The highlight must sit where the text is, which proves the normalization.
  const painted = await page.waitFor(
    `(() => {
      const element = document.querySelector('[data-page-index="0"] [data-annotation-id]');
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    })()`,
    'the highlight to paint',
  );
  assert(Math.abs(painted.left - expected.start.x) < 3, 'the highlight starts at the text');
  assert(Math.abs(painted.right - expected.end.x) < 3, 'the highlight ends at the text');
  assert(Math.abs(painted.y - expected.start.y) < 4, 'the highlight is on the text line');

  // A non-embedded CJK font only produces this text if the CMap files load. Whether its
  // glyphs then draw depends on the machine's fonts, so that is not asserted here.
  await scrollToPage(page, 4);
  await page.waitFor(
    `[...document.querySelectorAll('[data-page-index="4"] .textLayer span')].some((e) => e.textContent.includes('汉字'))`,
    'CJK text, which needs the CMap files',
  );

  // Rectangle capture over the fixture's blue box on page 3.
  await scrollToPage(page, 2);
  await page.waitFor(`document.querySelector('[data-page-index="2"] canvas')?.width > 0`, 'page 3');
  await page.waitFor(`${inkOn(2)} > 1000`, 'the blue box to draw');
  await page.clickButton('Capture area');
  const box = await page.waitFor(
    `(() => {
      const surface = document.querySelector('[data-page-index="2"] [data-testid="pdf-capture-surface"]');
      if (!surface) return null;
      const r = surface.getBoundingClientRect();
      // The box spans x 150..350 and y 400..550 on a 612 x 792 page, from the bottom.
      return {
        from: { x: r.left + r.width * (170 / 612), y: r.top + r.height * ((792 - 530) / 792) },
        to: { x: r.left + r.width * (330 / 612), y: r.top + r.height * ((792 - 420) / 792) },
      };
    })()`,
    'capture mode',
  );
  await page.drag(box.from, box.to);
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-capture-box"]')`,
    'the capture box',
  );
  await page.waitFor(excerptEnabled, 'a capture to enable excerpting');
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector('[aria-label="Jump to source of Image excerpt"]')`,
    'a card for the capture',
  );

  // The stored PNG must hold exactly the blue box: this reads its actual pixels.
  const pixel = await page.waitFor(
    `(async () => {
      const image = document.querySelector('img[alt="Captured area"]');
      if (!image) return null;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
      return {
        size: [canvas.width, canvas.height],
        corner: at(2, 2),
        center: at(canvas.width >> 1, canvas.height >> 1),
      };
    })()`,
    'the capture to show in the inspector',
  );
  for (const [name, [r, g, b]] of [
    ['corner', pixel.corner],
    ['center', pixel.center],
  ]) {
    assert(
      Math.abs(r - 26) < 12 && Math.abs(g - 102) < 12 && Math.abs(b - 204) < 12,
      `the capture's ${name} is the fixture's blue, got ${r},${g},${b}`,
    );
  }
  assert(pixel.size[0] > 50 && pixel.size[1] > 50, `the capture has real size: ${pixel.size}`);

  // Appearance on a PDF tab (#46): the Aa popover offers only what applies, and
  // the tint is a CSS filter on the canvas, so the bitmap a capture copies stays
  // the page's own colors.
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'the PDF appearance popover',
  );
  const pdfAppearance = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="appearance-popover"]');
    return {
      themes: panel?.querySelectorAll('[data-testid^="theme-swatch-"]').length ?? 0,
      tint: panel?.querySelector('[data-testid="tint-pdf-switch"]')?.getAttribute('aria-checked') ?? null,
      textSize: Boolean(panel?.querySelector('[data-testid="reading-font-size"]')),
      fonts: panel?.querySelectorAll('[data-testid^="font-option-"]').length ?? 0,
    };
  })()`);
  assert(
    pdfAppearance.themes === 4,
    `PDF appearance offers every theme: ${JSON.stringify(pdfAppearance)}`,
  );
  assert(pdfAppearance.tint === 'false', `the PDF tint starts off: ${pdfAppearance.tint}`);
  assert(
    !pdfAppearance.textSize && pdfAppearance.fonts === 0,
    'PDF appearance omits the text controls a bitmap cannot use',
  );
  await page.clickButton('Dark');
  await page.clickButton('Tint PDF pages');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.tintPdf === 'dark'`,
    'the Dark tint on PDF pages',
  );
  const canvasFilter = await page.waitFor(
    `(() => {
      const canvas = document.querySelector('[data-page-index="2"] canvas');
      const filter = canvas ? getComputedStyle(canvas).filter : '';
      return filter.includes('invert') ? filter : null;
    })()`,
    'the Dark filter on the page canvas',
  );
  // The tint is presentation only: read the blue box out of the bitmap itself.
  const tintedBitmap = await page.evaluate(`(() => {
    const canvas = document.querySelector('[data-page-index="2"] canvas');
    const context = canvas.getContext('2d');
    const pixel = context.getImageData(
      Math.floor(canvas.width * 0.408),
      Math.floor(canvas.height * 0.4),
      1,
      1,
    ).data;
    return [...pixel];
  })()`);
  const [tintR, tintG, tintB] = tintedBitmap;
  assert(
    Math.abs(tintR - 26) < 12 && Math.abs(tintG - 102) < 12 && Math.abs(tintB - 204) < 12,
    `the tinted canvas bitmap keeps the fixture's blue, got ${tintedBitmap.slice(0, 3)} (${canvasFilter})`,
  );
  // Multiply blending would turn a highlight black on the inverted page, and an
  // opaque fill would hide it: a tinted page uses a translucent normal fill.
  const tintedMark = await page.waitFor(
    `(() => {
      const mark = document.querySelector('[data-page-index="2"] [data-annotation-id]');
      if (!mark) return null;
      const style = getComputedStyle(mark);
      return { blend: style.mixBlendMode, opacity: Number(style.opacity) };
    })()`,
    'a highlight on the tinted page',
  );
  assert(
    tintedMark.blend === 'normal',
    `a highlight leaves multiply blending when tinted: ${tintedMark.blend}`,
  );
  assert(
    tintedMark.opacity < 1,
    `a tinted highlight lets the page text through: opacity ${tintedMark.opacity}`,
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'Esc closes the PDF appearance popover',
  );

  // Jump back to the text excerpt on page 1, from far away.
  await page.clickButton('Jump to source of quick brown fox');
  const inView = await page.waitFor(
    `(() => {
      const hit = document.querySelector('[data-page-index="0"] .anchor-pulse');
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      const scroller = ${visibleScroller}.getBoundingClientRect();
      return r.top >= scroller.top && r.bottom <= scroller.bottom;
    })()`,
    'the jump to pulse the excerpt in view',
  );
  assert(inView, 'the pulsed excerpt is in the viewport');
  await page.waitFor(`!document.querySelector('.anchor-pulse')`, 'the pulse to end');

  // Per-tab state: leave and come back, and the document is not reopened.
  await page.evaluate(`${visibleScroller}.scrollTop = 1500`);
  await page.waitFor(`${visibleScroller}.scrollTop === 1500`, 'scrolling');
  await new Promise((done) => setTimeout(done, 600));
  const marker = `document.querySelector('[data-testid="pdf-viewer"]')`;
  await page.evaluate(`${marker}.dataset.sameInstance = 'yes'`);
  await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].at(0).click()`);
  await page.waitFor(`!${visibleScroller}`, 'the PDF tab to be hidden');
  await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].at(-1).click()`);
  await page.waitFor(`${visibleScroller}?.scrollTop === 1500`, 'the scroll position to survive');
  assert(await page.evaluate(`${marker}.dataset.sameInstance === 'yes'`), 'the tab stayed mounted');

  // Reopen from a clean mount.
  await page.evaluate(
    `[...document.querySelectorAll('[aria-label^="Close sample"]')].at(-1).click()`,
  );
  await page.waitFor(`!${visibleScroller}`, 'the tab to close');
  await openPdf(page);
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) < 40`,
    'reopening at the last position',
  );
  await page.waitFor(
    `document.querySelector('[data-page-index] .textLayer span')`,
    'the reopened document to render',
  );

  // Embedded PDF outline (with nested entry), jump return, and validated page input.
  await page.showSidebarTab('Table of Contents');
  // Only the current chapter's path starts expanded; open Part One to reach its section.
  await page.expandTreeItem('Part One');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="pdf-viewer"] [data-testid="reader-toc"] [role="treeitem"]')].some((b) => b.getAttribute('aria-label') === 'Blue Box Section')`,
    'PDF outline to render nested entries from the document',
  );
  // Opening the outline narrows the pane, and fit width rescales the pages around
  // the reading position: the same place now sits at a new offset.
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) > 40`,
    'the outline to re-anchor',
  );
  await new Promise((done) => setTimeout(done, 400));
  const beforeOutlineJump = await page.evaluate(`${visibleScroller}.scrollTop`);
  await page.clickTreeItem('Part Two');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '4'`,
    'PDF outline jump to page 4',
  );
  await page.clickButton('Return to previous location');
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - ${beforeOutlineJump}) < 40`,
    'returning from PDF outline jump to previous scroll offset',
  );
  // Forward retraces the jump.
  await page.clickButton('Go forward');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '4'`,
    'going forward to the outline target again',
  );
  await page.clickButton('Return to previous location');
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - ${beforeOutlineJump}) < 40`,
    'returning again',
  );

  // Zoom modes, explicit zoom, and highlight alignment on page 1.
  await scrollToPage(page, 0);
  await page.clickButton('Actual size');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.zoomMode === 'actual-size' && document.querySelector('[data-testid="pdf-zoom-level"]')?.textContent === '100%'`,
    'Actual size zoom mode (100%)',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] button[aria-label="Zoom in"]')?.click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.zoomMode === 'custom' && document.querySelector('[data-testid="pdf-zoom-level"]')?.textContent === '125%'`,
    'explicit Zoom in (125%)',
  );
  await page.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(TEXT)})].some((e) => e.textContent.includes('quick brown fox'))`,
    'text layer at 125% zoom',
  );
  const zoomedExpected = await page.textRect(TEXT, selected);
  const zoomedPainted = await page.waitFor(
    `(() => {
      const element = document.querySelector('[data-page-index="0"] [data-annotation-id]');
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    })()`,
    'the highlight at 125% zoom',
  );
  assert(
    Math.abs(zoomedPainted.left - zoomedExpected.start.x) < 4,
    'highlight stays aligned at 125% zoom (left)',
  );
  assert(
    Math.abs(zoomedPainted.right - zoomedExpected.end.x) < 4,
    'highlight stays aligned at 125% zoom (right)',
  );
  await page.clickButton('Fit page');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.zoomMode === 'fit-page'`,
    'Fit page zoom mode',
  );
  await page.clickButton('Fit width');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.zoomMode === 'fit-width'`,
    'Fit width zoom mode',
  );

  // In-document search across unrendered PDF pages, match highlight, and return.
  await page.setInputValue('[data-testid="search-input"]', '汉字');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '1 of 1'`,
    'PDF search match on unrendered page 5',
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="search-result-location"]')?.textContent === 'Page 5'`,
    'PDF search result location for page 5',
  );
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '5'`,
    'PDF search jump to page 5',
  );
  await page.waitFor(
    `document.querySelector('[data-page-index="4"] [data-annotation-id="__search_active__"]')`,
    'PDF active search highlight on page 5',
  );
  await page.clickButton('Return to previous location');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '1'`,
    'returning from PDF search jump to page 1',
  );

  // A phrase split across two PDF lines is found as the reader types it.
  await page.setInputValue('[data-testid="search-input"]', 'dog. Pack');
  await page.waitFor(statusIs('1 of 1'), 'PDF search across a line break');
  await page.waitFor(
    `document.querySelector('[data-page-index="0"] [data-annotation-id="__search_active__"]')`,
    'PDF active highlight for the wrapped phrase',
  );

  // Two pages hold matches: every match is tinted and the scrubber marks both.
  await page.setInputValue('[data-testid="search-input"]', 'line');
  await page.waitFor(statusIs('1 of 30'), 'PDF multiple matches on two pages');
  await page.waitFor(
    `document.querySelector('[data-annotation-id^="__search_match_"]')`,
    'PDF inactive matches tinted',
  );
  await page.waitFor(
    `document.querySelectorAll('[data-testid="progress-scrubber-search-mark"]').length === 2`,
    'PDF search matches marked on the scrubber',
  );
  await page.leaveSearch();

  // Independent bookmarks in PDF: bookmark page 4 via outline jump, return to page 1, jump to bookmark, and remove.
  await page.clickTreeItem('Part Two');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '4'`,
    'PDF jump to page 4 before bookmarking',
  );
  await page.clickButton('Bookmark current location');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="toggle-bookmark-button"]')?.getAttribute('aria-pressed') === 'true'`,
    'PDF bookmark toggle pressed',
  );
  await scrollToPage(page, 0);
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '1'`,
    'PDF scroll back to page 1',
  );
  await page.showSidebarTab('Bookmarks');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="bookmark-jump-button"]')`,
    'PDF bookmark item in list',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="bookmark-jump-button"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '4'`,
    'jumping to PDF bookmark on page 4',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="bookmark-remove-button"]').click()`,
  );
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="bookmarks-empty"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    'removing PDF bookmark',
  );

  // Independent highlights & notes in PDF: highlight on page 4 without creating a MindMap node, delete, and undo.
  await page.waitFor(
    `[...document.querySelectorAll('[data-page-index="3"] .textLayer span')].some((e) => e.textContent.includes('final target sentence'))`,
    'page 4 text layer before independent highlight',
  );
  const cardCountBefore = await page.evaluate(
    `document.querySelectorAll('[aria-label^="Jump to source of "]').length`,
  );
  await page.selectText('[data-page-index="3"] .textLayer span', 'final target sentence');
  await page.waitFor(excerptEnabled, 'selecting text on page 4 for independent highlight');
  await page.clickButton('Yellow highlight');
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="annotation-item"]')].filter((e) => e.checkVisibility({ visibilityProperty: true })).length === 3`,
    'PDF independent highlight count (2 existing excerpts + 1 independent)',
  );
  const cardCountAfter = await page.evaluate(
    `document.querySelectorAll('[aria-label^="Jump to source of "]').length`,
  );
  assert(
    cardCountAfter === cardCountBefore,
    'independent PDF highlight must not create a MindMap card',
  );
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `document.querySelectorAll('[data-testid="pdf-viewer"] [data-testid="annotation-item"]').length === 3`,
    'PDF annotations list items',
  );
  await page.evaluate(
    `[...document.querySelectorAll('[data-testid="pdf-viewer"] [data-testid="annotation-delete-button"]')].at(-1).click()`,
  );
  await page.waitFor(
    `document.querySelectorAll('[data-testid="pdf-viewer"] [data-testid="annotation-item"]').length === 2`,
    'deleting PDF independent highlight',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="undo-delete-annotation-button"]').click()`,
  );
  await page.waitFor(
    `document.querySelectorAll('[data-testid="pdf-viewer"] [data-testid="annotation-item"]').length === 3`,
    'undoing PDF highlight deletion',
  );

  // Lazy thumbnails, embedded PDF annotations, internal links, display modes, and rotation.
  await page.showSidebarTab('Thumbnails');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-thumbnail-3"]')?.getAttribute('aria-current') === 'page'`,
    'PDF thumbnails sidebar active page 4',
  );
  const thumbnailFilter = await page.waitFor(
    `(() => {
      const canvas = document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-thumbnail-0"] canvas');
      const filter = canvas ? getComputedStyle(canvas).filter : '';
      return filter.includes('invert') ? filter : null;
    })()`,
    'the Dark filter on PDF thumbnails',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-thumbnail-0"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '1'`,
    'jumping to page 1 via PDF thumbnail click',
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-embedded-annotation"]')?.dataset.annotationSubtype === 'Highlight'`,
    'embedded PDF Highlight annotation on page 1',
  );
  // Restore the untinted page and the multiply blending it was designed for.
  await page.clickButton('Reading appearance');
  await page.clickButton('Tint PDF pages');
  await page.clickButton('Auto');
  await page.waitFor(
    `getComputedStyle(document.querySelector('[data-page-index="0"] canvas')).filter === 'none'`,
    'the page filter to clear',
  );
  await page.waitFor(
    `(() => {
      const mark = document.querySelector('[data-page-index="0"] [data-annotation-id]');
      if (!mark) return false;
      const style = getComputedStyle(mark);
      return style.mixBlendMode === 'multiply' && Number(style.opacity) === 1;
    })()`,
    'highlights back to multiply blending and full opacity',
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'the PDF appearance popover to close',
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-unsupported-annotations-notice"]')?.textContent.includes('Stamp')`,
    'unsupported PDF Stamp annotation disclosure banner',
  );
  const linkTarget = await page.evaluate(`(() => {
    const link = document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-internal-link"]');
    return {
      page: Number(link?.dataset.targetPage ?? -1),
      fraction: Number(link?.dataset.targetFraction ?? 0),
    };
  })()`);
  assert(
    linkTarget.page === 3 && linkTarget.fraction > 0.05,
    `the fixture link must name a page-relative destination: ${JSON.stringify(linkTarget)}`,
  );
  await page.evaluate(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-internal-link"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '4'`,
    'PDF internal link jump to page 4',
  );
  // The destination's vertical fraction puts the line above the target at the top,
  // rather than showing the page from its first line as a hard-coded zero would.
  await page.waitFor(
    `(() => {
      const scroller = ${visibleScroller};
      const page = document.querySelector('[data-page-index="${linkTarget.page}"]');
      if (!scroller || !page) return false;
      const height = page.getBoundingClientRect().height;
      const top = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return height > 0 && Math.abs(top + ${linkTarget.fraction} * height) < 6;
    })()`,
    'PDF internal link to land on the destination fraction',
  );
  const linkChip = await page.waitFor(
    `document.querySelector('[data-testid="reader-back-chip"]')?.textContent`,
    'the Back chip after a PDF internal link',
  );
  assert(linkChip === 'Back to page 1', `PDF internal link Back chip: ${linkChip}`);
  await page.evaluate(`document.querySelector('[data-testid="reader-back-chip"]').click()`);
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '1'`,
    'the PDF internal link Back chip to return to page 1',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'single' && document.querySelectorAll('[data-page-index]').length === 1`,
    'PDF single-page display mode',
  );
  // Page turns in single-page mode: edge clicks, Space, and Page Up, as in Preview.
  const pageField = `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value`;
  const edges = await page.evaluate(`(() => {
    const r = ${visibleScroller}.getBoundingClientRect();
    return {
      left: { x: r.left + 6, y: r.top + r.height / 2 },
      right: { x: r.right - 24, y: r.top + r.height / 2 },
    };
  })()`);
  await page.click(edges.right);
  await page.waitFor(`${pageField} === '2'`, 'a click in the right page edge to turn the page');
  await page.evaluate(`${visibleScroller}.focus()`);
  await page.press(' ', 'Space');
  await page.waitFor(`${pageField} === '3'`, 'Space to turn the page');
  await page.press('PageUp');
  await page.waitFor(`${pageField} === '2'`, 'Page Up to turn back');
  await page.click(edges.left);
  await page.waitFor(`${pageField} === '1'`, 'a click in the left page edge to turn back');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="reader-footer-readout"]')?.textContent.length > 0`,
    'the PDF footer to show progress',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-two-page"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'two-page' && document.querySelector('[data-page-index="1"]') !== null`,
    'PDF two-page display mode',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-rotate-button"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.rotation === '90'`,
    'PDF view rotation 90 degrees',
  );
  for (let step = 0; step < 3; step += 1) {
    await page.evaluate(
      `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-rotate-button"]').click()`,
    );
  }
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.rotation === '0'`,
    'PDF view rotation restored to 0 degrees',
  );
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-continuous"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'continuous'`,
    'PDF continuous display mode restored',
  );
  await page.hideSidebar();

  // Find keeps the reader's place (#44): with the sidebar closed, typing must not
  // open it, because opening it rescales a fit-width page and jumps.
  await scrollToPage(page, 0);
  await page.waitFor(`${pageField} === '1'`, 'PDF back on page 1 before searching');
  const sidebarShown = `[...document.querySelectorAll('[data-testid="navigator-sidebar"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`;
  await page.setInputValue('[data-testid="search-input"]', '汉字');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '1 of 1'`,
    'PDF search with the sidebar closed',
  );
  await page.waitFor(`!${sidebarShown}`, 'the sidebar to stay closed while typing');
  await page.waitFor(`${pageField} === '5'`, 'the search to reach page 5 with the sidebar closed');
  // A search is one trip: one history entry, and a chip back to where it started.
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="reader-back-chip"]')?.textContent.includes('Back to page 1')`,
    'a Back chip naming where the search started',
  );
  await page.clickButton('Show search results');
  await page.waitFor(sidebarShown, 'the search results to open on request');
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"] [data-testid="search-result-location"]')?.textContent === 'Page 5'`,
    'PDF search result location for page 5',
  );
  await page.leaveSearch();
  // Clearing the query leaves the sidebar as the reader left it.
  await page.waitFor(sidebarShown, 'the sidebar to stay open after the search is cleared');
}
