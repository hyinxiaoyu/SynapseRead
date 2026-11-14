import { assert } from './harness.mjs';
import { notesInPlaceFlow } from './notes.mjs';

const TEXT = '.textLayer span';
/** `WHEEL_ZOOM_IDLE_MS` in `usePinchZoom.ts`: how long a quiet wheel takes to end a pinch. */
const WHEEL_ZOOM_IDLE_MS = 160;
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

/** The active tab's title, as the toolbar shows it. */
const titleIs = (title) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
const closeTab = (title) =>
  `[...document.querySelectorAll('[aria-label=${JSON.stringify(`Close ${title}`)}]')].forEach((b) => b.click())`;
/** Every fixture is titled "sample", so the active tab is closed by its own button. */
const closeActiveTab = `document.querySelector('[role="tab"][aria-selected="true"]').nextElementSibling.click()`;
/**
 * The picker also offers other PDFs, so this names the one wanted. Passing the
 * others on the way opens them, so they are closed again: the steps below read the
 * first `pdf-viewer` in the page and mean this one.
 */
const openPdf = async (page) => {
  await page.openUntil(`${visibleScroller} && ${titleIs('sample')}`, 'the PDF');
  for (const other of ['sample-labels', 'sample-footnotes']) {
    await page.evaluate(closeTab(other));
    await page.waitFor(
      `!document.querySelector('[aria-label="Close ${other}"]')`,
      `${other}, passed on the way, to close`,
    );
  }
};
const openLabelledPdf = (page) =>
  page.openUntil(`${visibleScroller} && ${titleIs('sample-labels')}`, 'the labelled PDF');

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

  // The Stamp disclosure only informs: it has a close button and fades by itself (#45).
  const stampNotice = `document.querySelector('[data-testid="pdf-viewer"] [data-testid="pdf-unsupported-annotations-notice"]')`;
  await page.waitFor(
    `${stampNotice}?.textContent.includes('Stamp')`,
    'unsupported PDF Stamp annotation disclosure',
  );
  assert(
    await page.evaluate(
      `${stampNotice}.dataset.tone === 'info' && !!${stampNotice}.querySelector('button[aria-label="Close notice"]')`,
    ),
    'the Stamp disclosure is an info notice with a close button',
  );
  await page.waitFor(`!${stampNotice}`, 'the Stamp disclosure to fade on its own');

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
  await page.evaluate(closeActiveTab);
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
  // A fresh open discloses the Stamp again, and its close button puts it away.
  await page.waitFor(stampNotice, 'the Stamp disclosure on reopening');
  await page.evaluate(`${stampNotice}.querySelector('button[aria-label="Close notice"]').click()`);
  await page.waitFor(`!${stampNotice}`, 'the close button to put the disclosure away');

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

  // Notes in place on the highlight just made: the marker sits where it ends.
  const pdfViewer = `[...document.querySelectorAll('[data-testid="pdf-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  const page4Mark = `[...document.querySelectorAll('[data-page-index="3"] [data-annotation-id]')].filter((e) => !e.dataset.annotationId.startsWith('__')).at(-1)`;
  await notesInPlaceFlow(page, {
    name: 'PDF',
    viewer: pdfViewer,
    highlightPoint: `(() => {
      const mark = ${page4Mark};
      if (!mark) return null;
      const r = mark.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    markerShown: `(() => {
      const mark = ${page4Mark};
      const marker = mark && document.querySelector('[data-page-index="3"] [data-note-marker="' + mark.dataset.annotationId + '"]');
      if (!marker) return false;
      const m = marker.getBoundingClientRect();
      const r = mark.getBoundingClientRect();
      return Math.abs(m.left + m.width / 2 - r.right) < 3 && Math.abs(m.top + m.height / 2 - r.top) < 3;
    })()`,
  });

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
    `(() => {
      const pages = [...document.querySelectorAll('[data-page-index]')].map((p) => p.dataset.pageIndex);
      return document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'single'
        && pages.includes('0') && pages.includes('1');
    })()`,
    'PDF single-page display mode, with the next page already staged',
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
  await page.hideSidebar();

  // Focus mode (#45): page turns leave the toolbar hidden, and Esc leaves.
  await page.enterFocusMode(visibleScroller);
  await page.press('ArrowRight');
  await page.assertToolbarStaysHidden('ArrowRight in PDF focus mode');
  await page.press('Escape');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"]').dataset.immersive !== 'true'`,
    'Esc to leave PDF focus mode',
  );
}

/**
 * Each PDF keeps its layout (#51); a new one starts from the last display and zoom.
 * A flow of its own, so a fresh browser guarantees the labelled PDF has never been
 * opened: the picker cycles through the library, and the first read pins a layout.
 */
export async function pdfLayoutFlow(page) {
  await openPdf(page);
  const viewer = `[...document.querySelectorAll('[data-testid="pdf-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  const control = (testId) =>
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="${testId}"]')`;
  // The viewer only reports the cover page in Two Pages, so leave `cover` out otherwise.
  const layoutIs = ({ displayMode, zoomMode, rotation, cover }) =>
    `(() => {
      const data = ${viewer}?.dataset;
      return data?.displayMode === '${displayMode}' && data.zoomMode === '${zoomMode}'
        && data.rotation === '${rotation}'
        && ${cover === undefined ? 'true' : `data.coverPageAlone === '${cover}'`};
    })()`;
  /** Where pages sit on screen: one spread shares a top, and its pages rise in left. */
  const pageBoxes = `(() => {
    const boxes = {};
    for (const element of ${viewer}.querySelectorAll('[data-page-index]')) {
      const r = element.getBoundingClientRect();
      boxes[element.dataset.pageIndex] = { top: Math.round(r.top), left: Math.round(r.left) };
    }
    return boxes;
  })()`;

  await page.hideSidebar();
  await scrollToPage(page, 0);
  await page.evaluate(`${control('pdf-mode-two-page')}.click()`);
  await page.waitFor(`${viewer}?.dataset.coverPageAlone === 'false'`, 'two pages, cover paired');
  await page.waitFor(
    `(() => {
      const b = ${pageBoxes};
      return b[0] !== undefined && b[1] !== undefined && b[0].top === b[1].top
        && b[0].left < b[1].left;
    })()`,
    'pages 1 and 2 to face each other',
  );
  await page.evaluate(`${control('pdf-cover-page-alone')}.click()`);
  await page.waitFor(`${viewer}?.dataset.coverPageAlone === 'true'`, 'the cover page alone');
  const boxes = await page.waitFor(
    `(() => {
      const b = ${pageBoxes};
      return b[0] !== undefined && b[1] !== undefined && b[2] !== undefined
        && b[1].top === b[2].top && b[1].left < b[2].left && b[0].left < b[1].left ? b : null;
    })()`,
    'page 1 alone, then pages 2 and 3 side by side',
  );
  assert(boxes[0].left < boxes[1].left, 'the cover sits before the first spread');
  await page.evaluate(`${control('pdf-rotate-button')}.click()`);
  await page.clickButton('Fit page');
  const chosen = { displayMode: 'two-page', zoomMode: 'fit-page', rotation: 90, cover: true };
  await page.waitFor(layoutIs(chosen), 'the chosen layout');

  // A PDF never opened before takes that display and zoom, but its own rotation and cover.
  await openLabelledPdf(page);
  const inherited = { displayMode: 'two-page', zoomMode: 'fit-page', rotation: 0, cover: false };
  await page.waitFor(layoutIs(inherited), 'the new PDF to inherit display and zoom only');

  // Printed page labels in the page box, and jumps by label or physical page.
  const pageInput = `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')`;
  const pageCount = `${control('pdf-page-count')}?.textContent`;
  await page.waitFor(
    `${pageInput}?.value === 'i' && ${pageCount} === '(1 of 6)'`,
    'the printed label of the first page',
  );
  const jumpTo = async (value) => {
    await page.setInputValue(
      '[data-testid="unified-toolbar"] input[aria-label="Page number"]',
      value,
    );
    await page.evaluate(`${pageInput}.form.requestSubmit()`);
  };
  await jumpTo('2');
  await page.waitFor(
    `${pageInput}?.value === '2' && ${pageCount} === '(4 of 6)'`,
    'printed page 2 to be the fourth page',
  );
  await jumpTo('#2');
  await page.waitFor(
    `${pageInput}?.value === 'ii' && ${pageCount} === '(2 of 6)'`,
    '#2 to be the second page, shown by its label',
  );
  await jumpTo('vii');
  await page.waitFor(
    `${pageInput}?.getAttribute('aria-invalid') === 'true'`,
    'a label the document lacks to be rejected',
  );
  // No page is printed 5, so 5 is rejected rather than read as the fifth page.
  await jumpTo('5');
  await page.waitFor(
    `${pageInput}?.getAttribute('aria-invalid') === 'true' && ${pageCount} === '(2 of 6)'`,
    'a number no label claims to be rejected',
  );

  // The first PDF changes; the labelled one was shown in Two Pages and stays there.
  // `openPdf` closes the labelled tab on the way, so it reopens from a clean mount.
  await openPdf(page);
  // Every tab is titled "sample"; mark this one to close it later from another tab.
  await page.evaluate(
    `document.querySelector('[role="tab"][aria-selected="true"]').dataset.e2e = 'first-pdf'`,
  );
  await page.evaluate(`${control('pdf-mode-continuous')}.click()`);
  const changed = { displayMode: 'continuous', zoomMode: 'fit-page', rotation: 90 };
  await page.waitFor(layoutIs(changed), 'the first PDF switched to continuous');
  await openLabelledPdf(page);
  await page.waitFor(layoutIs(inherited), 'the labelled PDF keeping the layout it was shown');

  // Reopen from a clean mount: the store forgets a closed tab, so this reads the backend.
  // It is closed from the labelled tab, so the picker's next file is not the tab that
  // becomes active, which the picker would only re-select.
  await page.evaluate(
    `document.querySelector('[data-e2e="first-pdf"]').nextElementSibling.click()`,
  );
  await page.waitFor(`!document.querySelector('[data-e2e="first-pdf"]')`, 'the PDF tab to close');
  await openPdf(page);
  await page.waitFor(layoutIs(changed), 'reopening in the saved layout');
  await page.waitFor(
    `${viewer}.querySelector('[data-page-index] .textLayer span')`,
    'the reopened layout to render',
  );
}

/**
 * Pinch and ctrl-wheel zoom (#51), as Chromium reports a trackpad pinch: a wheel with
 * Ctrl held. In every layout and rotation the page point under the pointer stays
 * there, the pages redraw sharp, and the highlight, a selection, and an area capture
 * stay on the text. WebKit's gesture events are covered by the unit tests only.
 */
export async function pdfZoomFlow(page) {
  await page.clickButton('Show MindMap');
  await openPdf(page);
  await page.hideSidebar();
  const viewer = `[...document.querySelectorAll('[data-testid="pdf-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  const control = (testId) =>
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="${testId}"]')`;
  const zoomLevel = `${control('pdf-zoom-level')}?.textContent`;
  const content = `${visibleScroller}.firstElementChild`;
  await page.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(TEXT)})].some((e) => e.textContent.includes('quick brown fox'))`,
    'the text layer to render',
  );

  const selected = 'quick brown fox';
  await page.selectText(TEXT, selected);
  await page.waitFor(excerptEnabled, 'a selection to enable excerpting');
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector('[data-page-index="0"] [data-annotation-id]')`,
    'the highlight to paint',
  );

  /** The page under a client point, and how far across and down it the point is. */
  const pagePointAt = ({ x, y }) =>
    page.evaluate(`(() => {
      const element = document.elementsFromPoint(${x}, ${y}).find((e) => e.matches('[data-page-index]'));
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return {
        pageIndex: Number(element.dataset.pageIndex),
        x: (${x} - r.left) / r.width,
        y: (${y} - r.top) / r.height,
      };
    })()`);
  /** The bounding box of the selected words' text, and of their highlight. */
  const boxes = `(() => {
    const union = (rects) => rects.reduce((box, r) => ({
      left: Math.min(box.left, r.left), top: Math.min(box.top, r.top),
      right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const marks = [...document.querySelectorAll('[data-page-index="0"] [data-annotation-id]')];
    let text = null;
    for (const element of document.querySelectorAll('[data-page-index="0"] .textLayer span')) {
      const node = element.firstChild;
      const index = node?.nodeType === Node.TEXT_NODE ? node.data.indexOf(${JSON.stringify(selected)}) : -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + ${selected.length});
      text = union([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
    }
    if (!text || marks.length === 0) return null;
    return { text, mark: union(marks.map((m) => m.getBoundingClientRect())) };
  })()`;
  /** A page's canvas holds a pixel per device pixel of its box: drawn at this scale. */
  const sharp = (pageIndex) => `(() => {
    const canvas = ${viewer}.querySelector('[data-page-index="${pageIndex}"] canvas');
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    return Math.abs(canvas.width - r.width * devicePixelRatio) <= 2
      && Math.abs(canvas.height - r.height * devicePixelRatio) <= 2;
  })()`;

  /**
   * Zooms in with two ctrl-wheel notches over `point`, checking the preview is only a
   * transform, then that release kept the page point under the pointer.
   */
  const pinchAt = async (point, label) => {
    const before = await pagePointAt(point);
    assert(before, `${label}: a page under the pointer`);
    const level = await page.evaluate(zoomLevel);
    // Each CDP call is a round trip, and on a loaded runner one can outlast the
    // hook's idle window: an evaluate after the wheels may then see the release, or
    // a second gesture, rather than the preview. So the page samples itself as each
    // wheel is handled. A capture listener on window runs before the scroller's
    // handler and a bubble one after it, which bounds when the handler ran.
    await page.evaluate(`(() => {
      const samples = (window.__pinchSamples = []);
      let started = 0;
      const before = () => { started = performance.now(); };
      const after = () => samples.push({
        started,
        handled: performance.now(),
        transform: ${content}.style.transform,
        level: ${zoomLevel},
      });
      window.addEventListener('wheel', before, { capture: true });
      window.addEventListener('wheel', after);
      window.__stopPinchSamples = () => {
        window.removeEventListener('wheel', before, { capture: true });
        window.removeEventListener('wheel', after);
        return samples;
      };
    })()`);
    await page.wheel(point, -100, 2);
    await page.wheel(point, -100, 2);
    const samples = await page.evaluate('window.__stopPinchSamples()');
    assert(samples.length === 2, `${label}: both wheel notches reached the page`);
    const [first, second] = samples;
    for (const sample of samples) {
      assert(sample.transform.startsWith('scale('), `${label}: previews with a transform`);
    }
    assert(first.level === level, `${label}: does not re-render during the gesture`);
    // The first notch's idle timer is not due before it was set plus the window, and
    // no timer runs inside an event dispatch: handled before then, the second notch
    // is certainly the same gesture. Later than that, it may rightly start another.
    if (second.handled < first.started + WHEEL_ZOOM_IDLE_MS) {
      assert(second.level === level, `${label}: does not re-render during the gesture`);
      const ratio = (sample) => Number(/^scale\(([^)]+)\)/.exec(sample.transform)?.[1]);
      assert(ratio(second) > ratio(first), `${label}: the second notch adds to the first`);
    } else {
      const gap = Math.round(second.handled - first.started);
      console.log(`     ${label}: notches handled ${gap} ms apart, so two gestures`);
    }
    await page.waitFor(
      `${zoomLevel} !== ${JSON.stringify(level)} && ${content}.style.transform === ''`,
      `${label}: the zoom to apply on release`,
    );
    await page.waitFor(sharp(before.pageIndex), `${label}: the page to redraw sharp`);
    const after = await pagePointAt(point);
    assert(after?.pageIndex === before.pageIndex, `${label}: the same page under the pointer`);
    assert(
      Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01,
      `${label}: the same point under the pointer, was ${JSON.stringify(before)}, now ${JSON.stringify(after)}`,
    );
    const { text, mark } = await page.waitFor(boxes, `${label}: the highlight and its text`);
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      assert(
        Math.abs(text[edge] - mark[edge]) < 4,
        `${label}: the highlight's ${edge} edge on the text (${text[edge]} vs ${mark[edge]})`,
      );
    }
  };
  /** The middle of the highlight, brought into view: the words themselves. */
  const overHighlight = () =>
    page.evaluate(`(() => {
      const mark = document.querySelector('[data-page-index="0"] [data-annotation-id]');
      mark.scrollIntoView({ block: 'center', inline: 'center' });
      const r = mark.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  const reset = async () => {
    await page.clickButton('Fit width');
    await page.waitFor(`${viewer}?.dataset.zoomMode === 'fit-width'`, 'fit width again');
    await scrollToPage(page, 0);
  };

  // Continuous, then a single page.
  await scrollToPage(page, 0);
  await pinchAt(await overHighlight(), 'continuous');
  // A selection made in the zoomed layout is still the words under the drag.
  await page.selectText(TEXT, selected);
  await page.waitFor(
    `window.getSelection().toString().includes(${JSON.stringify(selected)})`,
    'a selection at the pinched zoom',
  );
  await page.evaluate(`window.getSelection().removeAllRanges()`);
  await reset();
  await page.evaluate(`${control('pdf-mode-single')}.click()`);
  await page.waitFor(`${viewer}?.dataset.displayMode === 'single'`, 'single page');
  await pinchAt(await overHighlight(), 'single page');
  await reset();

  // Two pages with the cover alone: over the left page of the 2–3 spread, which is
  // wider than the pane once zoomed, so it can stay put sideways too.
  await page.evaluate(`${control('pdf-mode-two-page')}.click()`);
  await page.waitFor(`${viewer}?.dataset.displayMode === 'two-page'`, 'two pages');
  await page.evaluate(`${control('pdf-cover-page-alone')}.click()`);
  await page.waitFor(`${viewer}?.dataset.coverPageAlone === 'true'`, 'the cover page alone');
  // A paged mode shows one spread, so turn to the 2-3 spread before pinching over it.
  await page.clickButton('Next Page');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value === '2'`,
    'the 2-3 spread to come up',
  );
  const overSpread = await page.waitFor(
    `(() => {
      const second = ${viewer}.querySelector('[data-page-index="1"]');
      const third = ${viewer}.querySelector('[data-page-index="2"]');
      if (!second || !third) return null;
      const a = second.getBoundingClientRect();
      const b = third.getBoundingClientRect();
      const pane = ${visibleScroller}.getBoundingClientRect();
      if (Math.round(a.top) !== Math.round(b.top) || a.left < pane.left) return null;
      return { x: a.left + a.width * 0.3, y: a.top + Math.min(a.height * 0.3, 200) };
    })()`,
    'pages 2 and 3 side by side',
  );
  await pinchAt(overSpread, 'two pages, cover alone');
  await reset();
  await page.evaluate(`${control('pdf-mode-continuous')}.click()`);
  await page.waitFor(`${viewer}?.dataset.displayMode === 'continuous'`, 'continuous again');

  // Each rotation, over the highlighted words.
  for (const rotation of [90, 180, 270]) {
    await page.evaluate(`${control('pdf-rotate-button')}.click()`);
    await page.waitFor(`${viewer}?.dataset.rotation === '${rotation}'`, `rotated ${rotation}°`);
    await scrollToPage(page, 0);
    await page.waitFor(boxes, `the highlight at ${rotation}°`);
    await pinchAt(await overHighlight(), `rotated ${rotation}°`);
    if (rotation !== 270) await reset();
  }

  // An area capture at the pinched zoom, still rotated: the box sits where it was drawn.
  await page.clickButton('Capture area');
  const drawn = await page.waitFor(
    `(() => {
      const surface = ${viewer}.querySelector('[data-page-index="0"] [data-testid="pdf-capture-surface"]');
      if (!surface) return null;
      // The page is wider and taller than the pane by now: start inside both.
      const r = surface.getBoundingClientRect();
      const pane = ${visibleScroller}.getBoundingClientRect();
      const top = Math.max(r.top, pane.top) + 40;
      const left = Math.max(r.left, pane.left) + 40;
      return { from: { x: left, y: top }, to: { x: left + 120, y: top + 80 } };
    })()`,
    'capture mode',
  );
  await page.drag(drawn.from, drawn.to);
  const captured = await page.waitFor(
    `(() => {
      const box = ${viewer}.querySelector('[data-testid="pdf-capture-box"]');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`,
    'the capture box',
  );
  for (const [edge, expected] of [
    ['left', drawn.from.x],
    ['top', drawn.from.y],
    ['right', drawn.to.x],
    ['bottom', drawn.to.y],
  ]) {
    assert(
      Math.abs(captured[edge] - expected) < 3,
      `the capture box's ${edge} edge where it was drawn (${captured[edge]} vs ${expected})`,
    );
  }
  await page.clickButton('Capture area');

  // The pinched scale is the document's own: it comes back from a clean mount.
  const pinched = await page.evaluate(zoomLevel);
  await page.evaluate(closeActiveTab);
  await page.waitFor(`!${viewer}`, 'the PDF tab to close');
  await openPdf(page);
  await page.waitFor(
    `${viewer}?.dataset.zoomMode === 'custom' && ${zoomLevel} === ${JSON.stringify(pinched)}`,
    'reopening at the pinched zoom',
  );
}
