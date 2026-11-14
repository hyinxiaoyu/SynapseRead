import { assert } from './harness.mjs';

const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const titleIs = (title) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
const frame = `${visible('epub-host')}?.querySelector('iframe')`;
const chapterIs = (title) =>
  `${frame}?.contentDocument?.querySelector('h1')?.textContent === ${JSON.stringify(title)}`;
const card = `document.querySelector('[data-testid="link-peek"]')`;
const cardText = `${card}?.querySelector('[data-testid="link-peek-text"]')?.textContent`;
const cardShows = (text) => `${cardText} === ${JSON.stringify(text)}`;
const backChip = `${visible('reader-back-chip')}`;
const pdfPageField = `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')`;

/** The center of an element in the book's frame, on screen. */
const bookPoint = (page, id) =>
  page.waitFor(
    `(() => {
      const view = ${frame};
      const link = view?.contentDocument?.getElementById(${JSON.stringify(id)});
      if (!link) return null;
      const outer = view.getBoundingClientRect();
      const r = link.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: outer.left + r.left + r.width / 2, y: outer.top + r.top + r.height / 2 };
    })()`,
    `the book's link #${id}`,
  );

/** The center of the PDF's `index`th internal link on screen. */
const pdfLinkPoint = (page, index) =>
  page.waitFor(
    `(() => {
      const links = ${visible('pdf-viewer')}?.querySelectorAll('[data-testid="pdf-internal-link"]') ?? [];
      const r = links[${index}]?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`,
    `PDF link ${index}`,
  );

/** The card's box, once it is placed. */
const readCard = (page, description) =>
  page.waitFor(
    `(() => {
      const element = ${card};
      if (!element || element.style.visibility === 'hidden') return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })()`,
    `${description}: the card placed`,
  );

/** The card sits beside the link it was opened from, and holds nothing but text. */
async function assertCardBeside(page, point, description) {
  // Measured once it has finished opening: two reads 100 ms apart agree.
  let box = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const previous = box;
    await new Promise((done) => setTimeout(done, 100));
    box = await readCard(page, description);
    if (previous && JSON.stringify(previous) === JSON.stringify(box)) break;
  }
  const gap = Math.min(Math.abs(box.top - point.y), Math.abs(box.bottom - point.y));
  assert(
    gap < 40,
    `${description}: the card is beside its link: ${JSON.stringify({ box, point })}`,
  );
  const markup = await page.evaluate(
    `${card}.querySelector('[data-testid="link-peek-text"]').childElementCount`,
  );
  assert(markup === 0, `${description}: the card's text holds no elements`);
}

/**
 * #49, phase 2: a footnote reference shows its note beside it, Go to Note goes there
 * with a way back, and other links still jump. Book markup only ever reaches the app
 * as text (ADR 0005).
 */
export async function linkPeekFlow(page) {
  // EPUB.
  await page.openUntil(`${visible('epub-host')} && ${titleIs('sample-footnotes')}`, 'the EPUB');
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One');
  await page.waitForReaderLayout();

  // A noteref into another chapter: the note shows, and the page stays.
  const ref1 = await bookPoint(page, 'ref1');
  await page.click(ref1);
  await page.waitFor(cardShows('The first footnote explains the claim.'), 'the first footnote');
  await assertCardBeside(page, ref1, 'EPUB noteref');
  assert(await page.evaluate(chapterIs('Chapter One')), 'peeking stays on Chapter One');
  await page.waitFor(
    `document.activeElement?.dataset.testid === 'link-peek-go'`,
    'the keyboard on Go to Note',
  );

  // Go to Note goes there, and the chip comes back.
  await page.clickButton('Go to Note');
  await page.waitFor(chapterIs('Notes'), 'Go to Note to open the notes');
  await page.waitFor(`!${card}`, 'the card to close on Go to Note');
  await page.waitFor(`${backChip}?.textContent.startsWith('Back to')`, 'the Back chip');
  await page.evaluate(`${backChip}.click()`);
  await page.waitFor(chapterIs('Chapter One'), 'the Back chip to return to Chapter One');
  await page.waitForReaderLayout();

  // A hostile note: its tags, handler, and script reach the card only as text.
  await page.click(await bookPoint(page, 'ref2'));
  await page.waitFor(
    cardShows('Bold words and <img src=x onerror=alert(1)> stay text.'),
    'the hostile note as text',
  );
  const ran = await page.evaluate(`({
    script: window.__peekScriptRan ?? null,
    handler: window.__peekHandlerRan ?? null,
    elements: ${card}.querySelectorAll('img, script, b').length,
  })`);
  assert(
    ran.script === null && ran.handler === null && ran.elements === 0,
    `the hostile note stays inert: ${JSON.stringify(ran)}`,
  );
  await page.press('Escape');
  await page.waitFor(`!${card}`, 'Esc to put the card away');
  assert(await page.evaluate(chapterIs('Chapter One')), 'Esc goes nowhere');

  // A link that does not say it is a note, to a short target, peeks too; a press on
  // the page puts the card away.
  await page.click(await bookPoint(page, 'ref3'));
  await page.waitFor(
    cardShows('The aside is a short paragraph in the same chapter.'),
    'the short in-chapter target',
  );
  await page.click(await bookPoint(page, 'aside'));
  await page.waitFor(`!${card}`, 'a press in the chapter to put the card away');

  // A link to a long part of the book jumps straight there.
  await page.click(await bookPoint(page, 'ref4'));
  await page.waitFor(chapterIs('Chapter Two'), 'a link to a long target to jump');
  assert(!(await page.evaluate(`!!${card}`)), 'no card for a long target');

  // PDF.
  await page.openUntil(`${visible('pdf-viewer')} && ${titleIs('sample-footnotes')}`, 'the PDF');
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'the PDF on page 1');

  // Marker 1 points at the foot of its own page: two lines, not the note after them.
  const marker1 = await pdfLinkPoint(page, 0);
  await page.click(marker1);
  await page.waitFor(
    cardShows('1 The first footnote, at the foot of page one. It wraps onto a second line.'),
    'the first PDF footnote',
  );
  await assertCardBeside(page, marker1, 'PDF footnote');
  assert(await page.evaluate(`${pdfPageField}.value === '1'`), 'peeking stays on page 1');
  await page.press('Escape');
  await page.waitFor(`!${card}`, 'Esc to put the first PDF card away');

  // Markup in a PDF's text is only characters.
  await page.click(await pdfLinkPoint(page, 1));
  await page.waitFor(
    cardShows('2 A second note <img src=x onerror=alert(1)> stays apart.'),
    'the second PDF footnote as text',
  );
  assert(
    (await page.evaluate(`${card}.querySelectorAll('img').length`)) === 0,
    'the PDF note stays text',
  );
  await page.press('Escape');
  await page.waitFor(`!${card}`, 'Esc to put the PDF card away');

  // Marker 3 points at an endnote on page 2; Go to Note goes there with the chip.
  await page.click(await pdfLinkPoint(page, 2));
  await page.waitFor(
    cardShows('3 The endnote on page two sits under a heading.'),
    'the PDF endnote',
  );
  await page.clickButton('Go to Note');
  await page.waitFor(`${pdfPageField}?.value === '2'`, 'Go to Note to reach page 2');
  await page.waitFor(`${backChip}?.textContent === 'Back to page 1'`, 'the PDF Back chip');
  await page.evaluate(`${backChip}.click()`);
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'the Back chip to return to page 1');

  // A link on words jumps, as before.
  await page.click(await pdfLinkPoint(page, 3));
  await page.waitFor(`${pdfPageField}?.value === '2'`, 'a link on words to jump to page 2');
  assert(!(await page.evaluate(`!!${card}`)), 'no card for a link on words');
}
