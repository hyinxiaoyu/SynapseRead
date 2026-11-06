import { assert } from './harness.mjs';

/** The text `measureCharWidth` samples; see `appearance/measure.ts`. */
const MEASURE_SAMPLE =
  'The quick brown fox jumps over the lazy dog, and then reads a chapter or two of a good book.';

const SEGMENT = '[data-testid="txt-scroll"] [data-unit]';
const scrollTop = `document.querySelector('[data-testid="txt-scroll"]').scrollTop`;
const visibleScroller = `[...document.querySelectorAll('[data-testid="txt-scroll"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;

export async function txtFlow(page) {
  await page.clickButton('Show MindMap');
  await page.clickButton('Open');
  await page.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(SEGMENT)})].some((e) => e.textContent.includes('SynapseRead sample text'))`,
    'the sample text to render',
  );

  // selection -> anchor -> persist, with a real mouse drag and a real click.
  await page.selectText(SEGMENT, 'quick brown fox');
  await page.waitFor(
    `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`,
    'a real drag to enable excerpting',
  );
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `[...document.querySelectorAll('[data-annotation-id]')].some((e) => e.textContent === 'quick brown fox')`,
    'the excerpt to paint exactly the selected text',
  );
  await page.waitFor(
    `document.querySelector('[aria-label="Jump to source of quick brown fox"]')`,
    'a card for the excerpt',
  );

  // Multibyte: the highlight must land on the same characters that were selected.
  await page.selectText(SEGMENT, 'café and € and 😀');
  await page.waitFor(
    `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`,
    'a second selection',
  );
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `[...document.querySelectorAll('[data-annotation-id]')].some((e) => e.textContent === 'café and € and 😀')`,
    'a multibyte excerpt to paint exactly',
  );

  // Scroll far down, so a jump has somewhere to come back from.
  await page.evaluate(`${visibleScroller}.scrollTop = 2600`);
  await page.waitFor(`${visibleScroller}.scrollTop === 2600`, 'scrolling');
  await page.waitFor(
    `![...document.querySelectorAll(${JSON.stringify(SEGMENT)})].some((e) => e.textContent.includes('quick brown fox') && e.getBoundingClientRect().bottom > 0 && e.getBoundingClientRect().top < innerHeight)`,
    'the excerpt to leave the viewport',
  );

  // Jump round trip: scrolled back, pulsed, then completed.
  await page.clickButton('Jump to source of quick brown fox');
  const inView = await page.waitFor(
    `(() => {
      const hit = [...document.querySelectorAll('.anchor-pulse')].find((e) => e.textContent === 'quick brown fox');
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    })()`,
    'the jump to pulse the excerpt in view',
  );
  assert(inView, 'the pulsed excerpt is in the viewport');
  await page.waitFor(`!document.querySelector('.anchor-pulse')`, 'the pulse to end');

  // Per-tab state: another tab must not disturb this one.
  await page.evaluate(`${visibleScroller}.scrollTop = 1500`);
  await page.waitFor(`${visibleScroller}.scrollTop === 1500`, 'scrolling');
  // Longer than the cursor debounce, so reopening below has a position to restore.
  await new Promise((done) => setTimeout(done, 600));
  const tabs = () => `[...document.querySelectorAll('[role="tab"]')]`;
  await page.clickButton('Open');
  await page.waitFor(`${tabs()}.length === 2`, 'a second tab');
  await page.waitFor(`!${visibleScroller}`, 'the text tab to be hidden');
  await page.evaluate(`${tabs()}[0].click()`);
  await page.waitFor(`${visibleScroller}?.scrollTop === 1500`, 'the scroll position to survive');

  // Reopen: close the tab and reopen it from the Recent documents list, from a clean mount.
  const before = await page.evaluate(scrollTop);
  assert(before === 1500, `scroll position before closing: ${before}`);
  await page.evaluate(`document.querySelector('[aria-label^="Close sample"]').click()`);
  await page.waitFor(`!${visibleScroller}`, 'the tab to close');
  await page.clickButton('Recent documents');
  await page.waitFor(
    `document.querySelector('[data-testid="recent-documents-menu"]')`,
    'recent documents menu to open',
  );
  await page.evaluate(
    `[...document.querySelectorAll('[data-testid="recent-document-item"]')].find((b) => b.dataset.documentFormat === 'txt').click()`,
  );
  await page.waitFor(visibleScroller, 'the recent text document to reopen');
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) < 40`,
    'reopening at the last position',
  );

  // In-document search across virtualized TXT rows, active match highlight, and return.
  const visibleTxtViewer = `[...document.querySelectorAll('[data-testid="txt-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  await page.setInputValue('[data-testid="search-input"]', 'quick brown fox');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '1 of 1'`,
    'TXT search match count',
  );
  await page.waitFor(
    `${visibleTxtViewer}?.querySelector('[data-testid="search-result-location"]')?.textContent === 'Line 6'`,
    'TXT search match location',
  );
  await page.waitFor(
    `[...${visibleTxtViewer}.querySelectorAll('[data-annotation-id="__search_active__"]')].some((e) => e.textContent === 'quick brown fox')`,
    'TXT active search highlight',
  );
  await page.clickButton('Return to previous location');
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) < 40`,
    'returning from TXT search jump to previous scroll offset',
  );
  await page.leaveSearch();

  // Independent bookmarks in TXT: bookmark at scrollTop 1500, scroll to top, jump back, and remove.
  await page.clickButton('Bookmark current location');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="toggle-bookmark-button"]')?.getAttribute('aria-pressed') === 'true'`,
    'TXT bookmark toggle pressed',
  );
  await page.evaluate(`${visibleScroller}.scrollTop = 0`);
  await page.waitFor(`${visibleScroller}.scrollTop === 0`, 'scrolling TXT to top');
  await page.showSidebarTab('Bookmarks');
  await page.waitFor(
    `${visibleTxtViewer}?.querySelector('[data-testid="bookmark-jump-button"]')`,
    'TXT bookmark item in list',
  );
  await page.evaluate(
    `${visibleTxtViewer}.querySelector('[data-testid="bookmark-jump-button"]').click()`,
  );
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) < 40`,
    'jumping to TXT bookmark',
  );
  await page.evaluate(
    `${visibleTxtViewer}.querySelector('[data-testid="bookmark-remove-button"]').click()`,
  );
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="bookmarks-empty"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    'removing TXT bookmark',
  );
  await page.hideSidebar();

  // Drag and drop a file onto the workspace and verify it opens and renders automatically.
  await page.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Dropped E2E document content'], 'dropped-e2e.txt', { type: 'text/plain' }));
    const main = document.querySelector('main');
    main.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await page.waitFor(
    `[...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.includes('dropped-e2e') && t.getAttribute('aria-selected') === 'true')`,
    'the dropped file tab to open and activate',
  );
  await page.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(SEGMENT)})].some((e) => e.textContent.includes('Dropped E2E document content'))`,
    'the dropped file content to render',
  );

  // Reading appearance controls in TXT viewer.
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'TXT appearance popover',
  );
  await page.clickButton('Dark');
  await page.waitFor(`${visibleTxtViewer}.dataset.readingTheme === 'dark'`, 'TXT dark theme');
  await page.assertContrast(
    '[data-testid="unified-toolbar"], [aria-label="Document reader"]',
    'TXT Dark chrome',
  );
  await page.clickButton('Light');
  await page.waitFor(`${visibleTxtViewer}.dataset.readingTheme === 'light'`, 'TXT light theme');
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'Esc closes the TXT appearance popover',
  );

  // Independent highlights & notes in TXT viewer: highlight dropped file text without creating a MindMap card, delete, and undo.
  await page.selectText(SEGMENT, 'Dropped E2E');
  await page.clickButton('Highlight selection');
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="annotation-item"]')].filter((e) => e.checkVisibility({ visibilityProperty: true })).length === 1`,
    'TXT independent highlight count',
  );
  await page.showSidebarTab('Highlights & Notes');
  await page.waitFor(
    `${visibleTxtViewer}?.querySelectorAll('[data-testid="annotation-item"]').length === 1`,
    'TXT annotation item in list',
  );
  await page.evaluate(
    `${visibleTxtViewer}.querySelector('[data-testid="annotation-delete-button"]').click()`,
  );
  await page.waitFor(
    `${visibleTxtViewer}?.querySelector('[data-testid="annotations-empty"]')`,
    'deleting TXT independent highlight',
  );
  await page.evaluate(
    `${visibleTxtViewer}.querySelector('[data-testid="undo-delete-annotation-button"]').click()`,
  );
  await page.waitFor(
    `${visibleTxtViewer}?.querySelectorAll('[data-testid="annotation-item"]').length === 1`,
    'undoing TXT highlight deletion',
  );
  await page.hideSidebar();

  // Last, because resizing reflows the text and moves every scroll offset above.
  // TXT keeps the same reading measure as EPUB at every window width.
  for (const width of [1280, 1728, 2560]) {
    await page.setViewport(width);
    const perLine = await page.waitFor(
      `(() => {
        const row = ${visibleTxtViewer}?.querySelector('[role="document"] [data-index]');
        if (!row || row.closest('[role="document"]').getBoundingClientRect().width > ${width}) {
          return null;
        }
        const style = getComputedStyle(row);
        const column =
          row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const probe = document.createElement('span');
        probe.textContent = ${JSON.stringify(MEASURE_SAMPLE)};
        probe.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap';
        row.appendChild(probe);
        const advance = probe.getBoundingClientRect().width / probe.textContent.length;
        probe.remove();
        const perLine = column / advance;
        return perLine >= 45 && perLine <= 78 ? perLine : null;
      })()`,
      `TXT 45–78 characters per line at ${width} px`,
    );
    console.log(`     txt: ${width} px, ${perLine.toFixed(1)} characters per line`);
  }
  await page.cdp.send('Emulation.clearDeviceMetricsOverride');
}
