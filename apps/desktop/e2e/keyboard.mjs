import { assert } from './harness.mjs';

// DevTools modifier bits, as `Input.dispatchKeyEvent` expects them.
const ALT = 1;
const META = 4;
const SHIFT = 8;

const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const visiblePdfScroll = visible('pdf-scroll');
const visibleTxtScroll = visible('txt-scroll');
const sidebarShown = `[...document.querySelectorAll('[data-testid="navigator-sidebar"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`;
const pdfPageField = `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value`;

/** The page itself has the keyboard, not a chrome control. */
const pageHasKeyboard = (selector) => `document.activeElement === (${selector})`;

/**
 * #50: the keyboard reaches the page. This flow proves, in a real browser, that a
 * document and a tab switch hand the keyboard to the page; that Next and Previous
 * Tab, Reopen Closed Tab, and the three layout keys work; that a sidebar shortcut
 * focuses its current row, Return on Contents goes back to the page, and Esc does
 * the same; and that a digit picks the selection color.
 */
export async function keyboardFlow(page) {
  // Both fixtures are titled "sample", so each step waits on the visible viewer.
  await page.openUntil(`${visible('txt-viewer')}`, 'the TXT reader');
  await page.openUntil(`${visible('pdf-viewer')}`, 'the PDF reader');
  await page.waitFor(`${visiblePdfScroll}`, 'the first PDF page to render');

  // Opening a document puts the keyboard on the page: no click is needed first.
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    'the PDF page to take the keyboard when the document opens',
  );

  // And the keys work without a click: this is the reported "Page Down did nothing".
  await page.press('ArrowRight', 'ArrowRight');
  await page.waitFor(`${pdfPageField} === '2'`, 'ArrowRight to turn the PDF page');

  // Previous Tab (⇧⌘[) activates the TXT tab and hands it the keyboard too.
  await page.press('[', 'BracketLeft', META | SHIFT);
  await page.waitFor(`${visibleTxtScroll}`, 'Previous Tab to show the TXT reader');
  await page.waitFor(
    pageHasKeyboard(visibleTxtScroll),
    'the TXT page to take the keyboard when its tab activates',
  );

  // Close Tab (⌘W) leaves the PDF, and its neighbour takes the keyboard back.
  await page.press('w', 'KeyW', META);
  await page.waitFor(
    `document.querySelectorAll('[role="tab"]').length === 1`,
    'Close Tab to remove the TXT tab',
  );
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    'the remaining page to take the keyboard when its neighbour closes',
  );

  // Reopen Closed Tab (⇧⌘T) brings it back, active and focused.
  await page.press('t', 'KeyT', META | SHIFT);
  await page.waitFor(
    `${visibleTxtScroll} && document.querySelectorAll('[role="tab"]').length === 2`,
    'Reopen Closed Tab to bring the TXT tab back',
  );
  await page.waitFor(pageHasKeyboard(visibleTxtScroll), 'the reopened tab to take the keyboard');

  // Back to the PDF for Preview's three layout keys (⌘1, ⌘2, ⌘3) via a real mouse click
  // on the tab: clicking a tab must hand the keyboard to the page, not leave it on `[role="tab"]`.
  const pdfTabPoint = await page.evaluate(`(() => {
    const tab = document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="false"]');
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.click(pdfTabPoint);
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    'clicking the PDF tab to give the keyboard to the PDF page',
  );

  // Clicking the already-active tab also returns keyboard focus to the page (#64).
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="true"]')?.focus()`,
  );
  await page.waitFor(
    `document.activeElement?.getAttribute('role') === 'tab'`,
    'focus to start on the active tab before clicking it',
  );
  const activeTabPoint = await page.evaluate(`(() => {
    const tab = document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="true"]');
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.click(activeTabPoint);
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    'clicking the already-active tab to return the keyboard to the PDF page',
  );
  for (const [key, code, mode] of [
    ['1', 'Digit1', 'single'],
    ['2', 'Digit2', 'two-page'],
    ['3', 'Digit3', 'continuous'],
  ]) {
    await page.press(key, code, META);
    await page.waitFor(
      `(${visible('pdf-viewer')})?.dataset.displayMode === '${mode}'`,
      `⌘${key} to choose the ${mode} layout`,
    );
  }

  // Table of Contents (⌥⌘3) opens the sidebar with focus on the current chapter.
  await page.press('3', 'Digit3', ALT | META);
  await page.waitFor(sidebarShown, 'Table of Contents to open the sidebar');
  await page.waitFor(
    `document.activeElement?.getAttribute('role') === 'treeitem'
      && document.activeElement.getAttribute('aria-current') === 'location'
      && document.activeElement.getAttribute('aria-disabled') !== 'true'`,
    'the sidebar to take the keyboard on the current chapter',
  );
  const chapter = await page.evaluate(`(() => {
    const item = document.activeElement;
    return {
      label: item.getAttribute('aria-label'),
      page: item.querySelector('[data-testid="toc-hint"]')?.textContent,
    };
  })()`);
  await page.press('Enter', 'Enter');
  // The current chapter's row always has a target, so Return jumps and returns focus.
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    `Return on “${chapter.label}” to give the keyboard back to the page`,
  );
  await page.waitFor(
    `${pdfPageField} === ${JSON.stringify(chapter.page)}`,
    `Contents to jump to the page “${chapter.label}” names`,
  );

  // Esc leaves the sidebar with the page focused, and the sidebar stays open.
  await page.press('3', 'Digit3', ALT | META);
  await page.waitFor(
    `document.activeElement?.getAttribute('role') === 'treeitem'`,
    'the sidebar to take the keyboard again',
  );
  await page.press('Escape');
  await page.waitFor(pageHasKeyboard(visiblePdfScroll), 'Esc to return to the page');
  await page.waitFor(sidebarShown, 'Esc to leave the sidebar open');

  // Esc out of the sidebar's filter field returns the keyboard to the page as well.
  await page.press('3', 'Digit3', ALT | META);
  await page.waitFor(
    `document.activeElement?.getAttribute('role') === 'treeitem'`,
    'the sidebar to take the keyboard once more',
  );
  await page.evaluate(`document.querySelector('[data-testid="navigator-filter"]')?.focus()`);
  await page.waitFor(
    `document.activeElement?.getAttribute('data-testid') === 'navigator-filter'`,
    'the filter field to take the keyboard',
  );
  await page.press('Escape');
  await page.waitFor(
    pageHasKeyboard(visiblePdfScroll),
    'Esc from the filter field to return to the page',
  );

  // A digit picks the selection color while the popover is open (#50).
  await page.hideSidebar();
  await page.evaluate(`(() => {
    const scroller = ${visiblePdfScroll};
    scroller.scrollTop = 0;
    return true;
  })()`);
  await page.waitFor(`${pdfPageField} === '1'`, 'the PDF back on page 1');
  await page.waitFor(
    `[...document.querySelectorAll('.textLayer span')].some((e) => e.textContent.includes('quick brown fox'))`,
    'the text layer to render',
  );
  await page.selectText('.textLayer span', 'quick brown fox');
  await page.waitFor(
    `document.querySelector('[data-testid="selection-popover"]')`,
    'the selection popover',
  );
  await page.press('2', 'Digit2');
  await page.waitFor(
    `!document.querySelector('[data-testid="selection-popover"]')`,
    'the digit to take the color and make the highlight',
  );

  // Highlights & Notes (⌥⌘4): the row it focuses is green, and Return stays in the list.
  await page.press('4', 'Digit4', ALT | META);
  await page.waitFor(visible('annotations-panel'), 'the Highlights & Notes sidebar');
  await page.waitFor(`document.activeElement?.hasAttribute('data-roving-row')`, 'the first row');
  const chip = await page.evaluate(
    `getComputedStyle(document.querySelector('[data-testid="navigator-sidebar"] [data-testid="annotation-color-chip"]')).backgroundColor`,
  );
  assert(chip === 'rgb(134, 239, 172)', `digit 2 makes a green highlight, but the row is ${chip}`);
  await page.press('Enter', 'Enter');
  await page.waitFor(
    `document.activeElement?.hasAttribute('data-roving-row')`,
    'Return in Highlights & Notes to stay in the list',
  );
}
