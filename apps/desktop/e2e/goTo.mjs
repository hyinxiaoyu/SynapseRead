import { assert } from './harness.mjs';

// DevTools modifier bits, as `Input.dispatchKeyEvent` expects them.
const ALT = 1;
const META = 4;

const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const toolbar = `document.querySelector('[data-testid="unified-toolbar"]')`;
const goToBox = `${toolbar}?.querySelector('[data-testid="go-to-input"]')`;
const pdfPageField = `${toolbar}?.querySelector('input[aria-label="Page number"]')`;
const titleIs = (title) =>
  `${toolbar}?.querySelector('[data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
const subtitle = `${toolbar}?.querySelector('[data-testid="reader-toolbar-subtitle"]')?.textContent`;
const hasKeyboard = (selector) => `document.activeElement === (${selector})`;
const sliderText = (viewer) =>
  `${visible(viewer)}?.querySelector('[role="slider"]')?.getAttribute('aria-valuetext') ?? ''`;

/**
 * Return with its character, as a keyboard sends it: a form submits on that, and a
 * bare keydown would leave the PDF's page field unsubmitted.
 */
async function pressReturn(page) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r' } : {}),
    });
  }
}

/** The value of `expression` once two reads 300 ms apart agree. */
async function settled(page, expression) {
  let previous = await page.evaluate(expression);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((done) => setTimeout(done, 300));
    const current = await page.evaluate(expression);
    if (current === previous) return current;
    previous = current;
  }
  throw new Error(`never settled: ${expression}`);
}

/** Go to Page (⌥⌘G), as the reader presses it. */
const pressGoTo = (page) => page.press('g', 'KeyG', ALT | META);

/**
 * #52: Go to Page in all three readers. ⌥⌘G puts the keyboard in the toolbar box
 * (PDF's page field, the Go To box elsewhere); Return goes there and gives the page
 * the keyboard back, and Esc gives it back without going anywhere.
 */
export async function goToFlow(page) {
  // PDF: a page number.
  await page.openUntil(`${visible('pdf-viewer')} && ${titleIs('sample')}`, 'the sample PDF');
  await page.waitFor(hasKeyboard(visible('pdf-scroll')), 'the PDF page to take the keyboard');
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(pdfPageField), '⌥⌘G to focus the PDF page field');
  await page.typeText('3');
  await pressReturn(page);
  await page.waitFor(`${pdfPageField}?.value === '3'`, 'Return to go to page 3');
  await page.waitFor(hasKeyboard(visible('pdf-scroll')), 'the PDF page to take the keyboard back');
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(pdfPageField), '⌥⌘G to focus the page field again');
  await page.typeText('5');
  await page.press('Escape');
  await page.waitFor(hasKeyboard(visible('pdf-scroll')), 'Esc to give the PDF page the keyboard');
  await page.waitFor(`${pdfPageField}?.value === '3'`, 'Esc to leave the PDF on page 3');

  // EPUB: a percentage of the book, by text once measured.
  await page.openUntil(
    `${visible('epub-viewer')} && ${titleIs('sample-uneven')}`,
    'the uneven EPUB',
  );
  await page.waitFor(`${goToBox} && !${goToBox}.disabled`, 'the EPUB Go To box');
  // Measured, the last tick (Chapter Three) moves from 92% by file to under half.
  await page.waitFor(
    `(() => {
      const ticks = [...${visible('epub-viewer')}.querySelectorAll('[data-testid="progress-scrubber-tick"]')];
      return ticks.length === 4 && parseFloat(ticks[3].style.left) < 50;
    })()`,
    'the book to be measured',
  );
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(goToBox), '⌥⌘G to focus the EPUB Go To box');
  await page.typeText('90%');
  await pressReturn(page);
  // Chapter Three, the thirteenth spine file, holds the last two thirds of the text.
  await page.waitFor(
    `${sliderText('epub-viewer')}.startsWith('Chapter 13 of 13')`,
    'Return to go 90% into the book',
  );
  await page.waitFor(hasKeyboard(visible('epub-host')), 'the EPUB page to take the keyboard back');
  const before = await settled(page, sliderText('epub-viewer'));
  assert(before.startsWith('Chapter 13 of 13'), `the EPUB stays where it went: ${before}`);
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(goToBox), '⌥⌘G to focus the EPUB box again');
  await page.typeText('1%');
  await page.press('Escape');
  await page.waitFor(hasKeyboard(visible('epub-host')), 'Esc to give the EPUB page the keyboard');
  const after = await settled(page, sliderText('epub-viewer'));
  assert(after === before, `Esc goes nowhere: ${before} became ${after}`);

  // TXT: a line, or a percentage.
  await page.openUntil(
    `${visible('txt-viewer')} && ${titleIs('sample-chapters')}`,
    'the chapters TXT',
  );
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'the TXT page to take the keyboard');
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(goToBox), '⌥⌘G to focus the TXT Go To box');
  await page.typeText('48');
  await pressReturn(page);
  await page.waitFor(
    `${sliderText('txt-viewer')}.startsWith('Line 48 of')`,
    'Return to go to line 48',
  );
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'the TXT page to take the keyboard back');
  await page.waitFor(`${subtitle} === 'Chapter 2. The Lighthouse'`, 'line 48 to be in Chapter 2');
  await pressGoTo(page);
  await page.typeText('100%');
  await pressReturn(page);
  const atEnd = `(() => { const s = ${visible('txt-scroll')}; return s.scrollTop + s.clientHeight >= s.scrollHeight - 2; })()`;
  await page.waitFor(atEnd, 'Return on 100% to go to the end of the file');
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'the keyboard back on the page');
  const end = await settled(page, sliderText('txt-viewer'));
  await pressGoTo(page);
  await page.typeText('1');
  await page.press('Escape');
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'Esc to give the TXT page the keyboard');
  const stayed = await settled(page, sliderText('txt-viewer'));
  assert(stayed === end, `Esc leaves the TXT where it was: ${end} became ${stayed}`);

  // Focus mode: the idle toolbar is inert, where focus() does nothing. ⌥⌘G brings it
  // back and the box still takes the keyboard; Esc there leaves focus mode on.
  await page.enterFocusMode(visible('txt-scroll'));
  await pressGoTo(page);
  await page.waitFor(`${toolbar}?.dataset.hidden !== 'true'`, '⌥⌘G to show the hidden toolbar');
  await page.waitFor(hasKeyboard(goToBox), '⌥⌘G to focus the Go To box in focus mode');
  await page.typeText('48');
  await pressReturn(page);
  await page.waitFor(
    `${sliderText('txt-viewer')}.startsWith('Line 48 of')`,
    'Return to go to line 48 in focus mode',
  );
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'the page to take the keyboard back');
  await page.waitFor(`${toolbar}?.dataset.hidden === 'true'`, 'the toolbar to hide again');
  await pressGoTo(page);
  await page.waitFor(hasKeyboard(goToBox), '⌥⌘G to focus the Go To box again');
  await page.press('Escape');
  await page.waitFor(hasKeyboard(visible('txt-scroll')), 'Esc to give the page the keyboard');
  assert(
    (await page.evaluate(`${toolbar}?.dataset.immersive`)) === 'true',
    'Esc in the Go To box leaves focus mode on',
  );
}
