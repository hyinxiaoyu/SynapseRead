import { assert } from './harness.mjs';

const TEXT = '.textLayer span';
const visibleScroller = `[...document.querySelectorAll('[data-testid="pdf-scroll"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
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

  // Reopen from a clean mount. pdf.js takes ownership of bytes it is given, so this
  // also fails if the source was not copied.
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
}
