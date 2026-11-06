import { assert } from './harness.mjs';

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

  // Reopen: close the tab and open the file again, from a clean mount.
  const before = await page.evaluate(scrollTop);
  assert(before === 1500, `scroll position before closing: ${before}`);
  await page.evaluate(`document.querySelector('[aria-label^="Close sample"]').click()`);
  await page.waitFor(`!${visibleScroller}`, 'the tab to close');
  // The fake picker cycles through its library back to the text file.
  await page.openUntil(visibleScroller, 'the text file');
  await page.waitFor(
    `Math.abs(${visibleScroller}?.scrollTop - 1500) < 40`,
    'reopening at the last position',
  );

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
  const visibleTxtViewer = `[...document.querySelectorAll('[data-testid="txt-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `${visibleTxtViewer}.querySelector('[data-testid="reading-preferences-bar"]')`,
    'TXT reading preferences bar',
  );
  await page.clickButton('Dark');
  await page.waitFor(`${visibleTxtViewer}.dataset.readingTheme === 'dark'`, 'TXT dark theme');
  await page.clickButton('Light');
  await page.waitFor(`${visibleTxtViewer}.dataset.readingTheme === 'light'`, 'TXT light theme');
}
