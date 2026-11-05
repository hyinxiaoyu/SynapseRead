import { assert } from './harness.mjs';

const visibleHost = `[...document.querySelectorAll('[data-testid="epub-host"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const frame = `${visibleHost}?.querySelector('iframe')`;
const frameDocument = `${frame}?.contentDocument`;
const scroller = `${visibleHost}?.querySelector('.epub-container')`;
const excerptEnabled = `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`;

const openEpub = async (page) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.clickButton('Open');
    await new Promise((done) => setTimeout(done, 200));
    if (await page.evaluate(`!!${visibleHost}`)) return;
  }
  throw new Error('the picker never offered the EPUB');
};

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

  // Move to the second chapter, and take an excerpt there too.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(chapterIs('Chapter Two'))) break;
    await page.clickButton('Next');
    await new Promise((done) => setTimeout(done, 120));
  }
  await page.waitFor(chapterIs('Chapter Two'), 'the second chapter');
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
}
