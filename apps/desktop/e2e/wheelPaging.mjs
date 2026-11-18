import { assert } from './harness.mjs';
import {
  chapterIs,
  closeAppearance,
  createSyntheticEpubBase64,
  dropBinaryFile,
  openAppearance,
  pdfPageField,
  titleIs,
  visibleEpubHost,
  visibleEpubViewer,
  visiblePdfScroll,
  visiblePdfViewer,
  visibleTxtScroll,
} from './pagingHelpers.mjs';

function createNestedScrollEpubBase64() {
  const nestedLines = Array.from(
    { length: 24 },
    (_, i) => `<p>Nested scroll item ${i + 1}: vertical wheel here scrolls inside this box.</p>`,
  ).join('');
  const filler = Array.from(
    { length: 42 },
    (_, i) =>
      `<p>Outside filler paragraph ${i + 1} adding enough multi-page spread length for paginated EPUB testing across columns.</p>`,
  ).join('');

  return createSyntheticEpubBase64({
    id: 'nested-scroll-test',
    title: 'nested-scroll-test',
    chapters: [
      {
        id: 'ch1',
        href: 'ch1.xhtml',
        title: 'Nested Scroll Chapter',
        body: `<h1>Nested Scroll Chapter</h1>
  <div id="nested-scroll" style="height:90px;overflow-y:auto;border:1px solid #666;padding:6px">
    ${nestedLines}
  </div>
  <p id="outside-anchor">Outside paragraph outside the nested scroller.</p>
  ${filler}`,
      },
    ],
  });
}

async function waitForSettle(ms = 320) {
  await new Promise((done) => setTimeout(done, ms));
}

async function dispatchEpubWheelStream(page, deltas, { horizontal = false } = {}) {
  await page.evaluate(`(() => {
    const host = ${visibleEpubHost};
    const doc = host?.querySelector('iframe')?.contentDocument;
    const target = doc?.body ?? host;
    const WheelCtor = doc?.defaultView?.WheelEvent ?? WheelEvent;
    for (const delta of ${JSON.stringify(deltas)}) {
      target?.dispatchEvent(
        new WheelCtor('wheel', {
          deltaX: ${horizontal} ? delta : 0,
          deltaY: ${horizontal} ? 0 : delta,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return true;
  })()`);
}

async function dispatchPdfSwipeStream(page, deltas) {
  await page.evaluate(`(() => {
    const target = ${visiblePdfScroll};
    for (const deltaX of ${JSON.stringify(deltas)}) {
      target?.dispatchEvent(
        new WheelEvent('wheel', { deltaX, deltaY: 0, bubbles: true, cancelable: true }),
      );
    }
    return true;
  })()`);
}

async function dispatchPdfVerticalStream(page, deltas) {
  await page.evaluate(`(() => {
    const target = ${visiblePdfScroll};
    for (const deltaY of ${JSON.stringify(deltas)}) {
      target?.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 0, deltaY, bubbles: true, cancelable: true }),
      );
    }
    return true;
  })()`);
}

async function setWheelSensitivity(page, level, expectedLabel, { customize }) {
  await openAppearance(page, { customize });
  await page.evaluate(`(() => {
    const slider = document.querySelector('[data-testid="wheel-sensitivity-slider"]');
    slider?.scrollIntoView({ block: 'center' });
    slider?.focus();
  })()`);
  await page.waitFor(
    `document.activeElement?.dataset?.testid === 'wheel-sensitivity-slider'`,
    'wheel sensitivity slider focus',
  );
  if (level <= 1) {
    await page.press('Home');
  } else if (level >= 5) {
    await page.press('End');
  } else {
    await page.press('Home');
    for (let step = 1; step < level; step += 1) {
      await page.press('ArrowRight');
    }
  }
  await page.waitFor(
    `document.querySelector('[data-testid="wheel-sensitivity-value"]')?.textContent?.trim() === ${JSON.stringify(expectedLabel)}`,
    `wheel sensitivity label to become ${expectedLabel}`,
  );
  await closeAppearance(page);
}

async function waitForEpubSlideSettle(page) {
  await page.waitFor(
    `(() => {
      const host = ${visibleEpubHost};
      const pane = host?.closest('[data-testid="epub-slide-pane"]') ?? host;
      const curlHost = host?.closest('[data-testid="epub-page-area"]')?.querySelector('[data-testid="epub-curl-host"]');
      return (
        (host?.querySelectorAll('iframe')?.length ?? 0) === 1 &&
        (!pane || getComputedStyle(pane).transform === 'none') &&
        (!curlHost || getComputedStyle(curlHost).visibility === 'hidden')
      );
    })()`,
    'EPUB slide transition to settle',
  );
}

/**
 * #106: Vertical mouse wheel turns pages in paginated modes (EPUB spread/paged,
 * PDF single/two-page), handles trackpad inertia & reversals, respects EPUB/book seams,
 * ignores Ctrl+wheel, preserves horizontal swipe, prioritizes zoomed PDF vertical
 * scrolling with the 250 ms edge settle latch, respects nested EPUB scroll containers,
 * and leaves continuous modes (EPUB Scroll, PDF Continuous, TXT) untouched.
 */
export async function wheelPagingFlow(page) {
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // =========================================================================
  // 1. EPUB paginated: spread (2-col) and paged (1-col)
  // =========================================================================
  await page.setViewport(1728);
  await page.openUntil(`${visibleEpubHost} && ${titleIs('sample')}`, 'the sample EPUB');
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="true"]').dataset.e2e = 'wheel-epub'`,
  );
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One to render');
  await page.waitForReaderLayout();
  await page.waitFor(
    `${visibleEpubViewer}?.dataset.readingMode === 'spread'`,
    'EPUB 2-col spread mode',
  );
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollWidth ?? 0) > (${visibleEpubHost}?.querySelector('.epub-container')?.clientWidth ?? 0)`,
    'EPUB Chapter One multiple spreads',
  );

  const epubScroller = `${visibleEpubHost}?.querySelector('.epub-container')`;
  const epubPoint = () =>
    page.evaluate(`(() => {
      const r = ${visibleEpubHost}.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

  const centerEpub = await epubPoint();

  // Start boundary clamp: wheel up at start of Chapter One stays at scrollLeft === 0.
  await page.wheel(centerEpub, -120);
  await waitForSettle(220);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0 &&
      (await page.evaluate(chapterIs('Chapter One'))),
    'vertical wheel up at start of EPUB book must clamp on Chapter One start',
  );

  // Single vertical wheel notch down/up turns spread pages.
  await page.wheel(centerEpub, 120);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'vertical wheel down turns EPUB spread forward',
  );
  await waitForSettle(350);
  const spreadStepLeft = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);

  await page.wheel(centerEpub, -120);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 1) === 0`,
    'vertical wheel up turns EPUB spread back',
  );
  await waitForSettle(350);

  // Trackpad flick + decaying inertia advances once per flick, and reversal breaks inertia cleanly.
  await dispatchEpubWheelStream(page, [45, 55, 60, 40, 20, 10]);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'trackpad vertical flick advances EPUB',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(120);
  const afterInertiaLeft = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
  assert(
    Math.abs(afterInertiaLeft - spreadStepLeft) <= 4,
    `decaying inertia must advance only 1 step (expected ~${spreadStepLeft}, got ${afterInertiaLeft})`,
  );

  // Mid-inertia reversal: flick down then reverse sharply up before inertia expires.
  await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
  await waitForSettle(150);
  await dispatchEpubWheelStream(page, [50, 60, 50, 25, -70, -60]);
  await waitForEpubSlideSettle(page);
  await waitForSettle(120);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'reversing direction during vertical wheel inertia must return to previous spread',
  );

  // Ctrl+wheel (modifiers: 2) is ignored by vertical wheel paging; horizontal swipe still works.
  await page.wheel(centerEpub, 120, 2);
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'Ctrl+wheel must not turn EPUB page',
  );

  await dispatchEpubWheelStream(page, [90, 90, 90], { horizontal: true });
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'horizontal swipe still works in EPUB spread',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(120);
  await dispatchEpubWheelStream(page, [-90, -90, -90], { horizontal: true });
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 1) === 0`,
    'horizontal swipe back in EPUB spread',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(120);

  // Vertical wheel crosses EPUB chapter seams forward and backward, and clamps at book end.
  for (let i = 0; i < 8; i += 1) {
    if (await page.evaluate(chapterIs('Chapter Two'))) break;
    const beforeLeft = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
    await page.wheel(centerEpub, 120);
    await page.waitFor(
      `(() => {
        const host = ${visibleEpubHost};
        const scroller = ${epubScroller};
        const pane = host?.closest('[data-testid="epub-slide-pane"]') ?? host;
        const curlHost = host?.closest('[data-testid="epub-page-area"]')?.querySelector('[data-testid="epub-curl-host"]');
        const moved = ${chapterIs('Chapter Two')} || (scroller?.scrollLeft ?? 0) !== ${beforeLeft};
        const settled =
          (host?.querySelectorAll('iframe')?.length ?? 0) === 1 &&
          (!pane || getComputedStyle(pane).transform === 'none') &&
          (!curlHost || getComputedStyle(curlHost).visibility === 'hidden');
        return moved && settled;
      })()`,
      'EPUB wheel step or Chapter Two seam crossing to settle',
    );
  }
  assert(
    await page.evaluate(chapterIs('Chapter Two')),
    'vertical wheel down crosses seam from Chapter One into Chapter Two',
  );
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'crossing forward chapter seam via wheel lands at Chapter Two start (scrollLeft === 0)',
  );

  await page.wheel(centerEpub, -120);
  await page.waitFor(
    chapterIs('Chapter One'),
    'vertical wheel up crosses seam back to Chapter One',
  );
  await waitForEpubSlideSettle(page);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`)) > 0,
    'crossing backward chapter seam via wheel lands at last spread of Chapter One',
  );

  // Advance to the end of Chapter Two and confirm wheel down clamps cleanly.
  for (let i = 0; i < 12; i += 1) {
    const atBookEnd = await page.evaluate(
      `(() => {
        const s = ${epubScroller};
        return ${chapterIs('Chapter Two')} && s && s.scrollLeft + s.clientWidth >= s.scrollWidth - 2;
      })()`,
    );
    if (atBookEnd) break;
    const before = await page.evaluate(
      `({ left: ${epubScroller}?.scrollLeft ?? 0, ch2: ${chapterIs('Chapter Two')} })`,
    );
    await page.wheel(centerEpub, 120);
    await page.waitFor(
      `(() => {
        const host = ${visibleEpubHost};
        const scroller = ${epubScroller};
        const pane = host?.closest('[data-testid="epub-slide-pane"]') ?? host;
        const curlHost = host?.closest('[data-testid="epub-page-area"]')?.querySelector('[data-testid="epub-curl-host"]');
        const moved =
          (scroller?.scrollLeft ?? 0) !== ${before.left} ||
          (${chapterIs('Chapter Two')} && !${before.ch2});
        const settled =
          (host?.querySelectorAll('iframe')?.length ?? 0) === 1 &&
          (!pane || getComputedStyle(pane).transform === 'none') &&
          (!curlHost || getComputedStyle(curlHost).visibility === 'hidden');
        return moved && settled;
      })()`,
      'EPUB advance toward end of Chapter Two to settle',
    );
  }
  const endPos = await page.evaluate(
    `({ left: ${epubScroller}?.scrollLeft ?? 0, max: (${epubScroller}?.scrollWidth ?? 0) - (${epubScroller}?.clientWidth ?? 0) })`,
  );
  await page.wheel(centerEpub, 120);
  await waitForSettle(260);
  assert(
    (await page.evaluate(chapterIs('Chapter Two'))) &&
      Math.abs((await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`)) - endPos.left) <= 2,
    `vertical wheel down at end of book clamps at end of Chapter Two (${JSON.stringify(endPos)})`,
  );

  // Single-page (1-column) EPUB also supports vertical wheel down/up.
  await page.clickButton('Single page');
  await page.waitFor(
    `${visibleEpubViewer}?.dataset.readingMode === 'paged' && ${visibleEpubViewer}?.dataset.columns === '1'`,
    'EPUB 1-col single-page mode',
  );
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('One');
  await page.waitFor(chapterIs('Chapter One'), 'back to Chapter One in 1-col mode');
  await page.hideSidebar();
  await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
  await waitForSettle(200);
  const centerSingleEpub = await epubPoint();
  await page.wheel(centerSingleEpub, 120);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'vertical wheel turns 1-col EPUB forward',
  );
  await waitForSettle(350);
  await page.wheel(centerSingleEpub, -120);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 1) === 0`,
    'vertical wheel turns 1-col EPUB back',
  );
  await waitForSettle(300);

  // Configurable wheel sensitivity in EPUB Customize popover (#111).
  await setWheelSensitivity(page, 1, 'Very low', { customize: true });
  await dispatchEpubWheelStream(page, [8, 8]);
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'EPUB at Very low (1) sensitivity must not turn on [8, 8] (16px) vertical wheel stream',
  );
  await setWheelSensitivity(page, 5, 'Very high', { customize: true });
  await dispatchEpubWheelStream(page, [8, 8]);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'EPUB at Very high (5) sensitivity turns forward on [8, 8] (16px)',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(150);
  const singleColStepLeft = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
  await dispatchEpubWheelStream(page, [-8, -8]);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 1) === 0`,
    'EPUB at Very high (5) sensitivity turns backward on [-8, -8] (-16px)',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(150);
  // A long fluctuating scroll stream at Very high sensitivity still advances only 1 page.
  await dispatchEpubWheelStream(page, [15, 25, 12, 30, 10, 28, 35, 18, 24, 15, 8, 4]);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'EPUB long scroll stream advances from page start',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(150);
  const afterLongEpubLeft = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
  assert(
    Math.abs(afterLongEpubLeft - singleColStepLeft) <= 4,
    `long EPUB vertical scroll stream must advance only 1 page (expected ~${singleColStepLeft}, got ${afterLongEpubLeft})`,
  );
  await dispatchEpubWheelStream(page, [-15, -25, -12, -30, -10, -28, -20, -10, -4]);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 1) === 0`,
    'long EPUB backward scroll stream returns only 1 page',
  );
  await waitForEpubSlideSettle(page);
  await waitForSettle(150);
  await setWheelSensitivity(page, 3, 'Normal', { customize: true });

  // Nested scrollable container inside EPUB absorbs wheel without turning EPUB page.
  const nestedEpubBase64 = createNestedScrollEpubBase64();
  await dropBinaryFile(page, nestedEpubBase64, 'nested-scroll-test.epub', 'application/epub+zip');
  await page.waitFor(
    `${visibleEpubHost} && ${titleIs('nested-scroll-test')} && ${chapterIs('Nested Scroll Chapter')}`,
    'dropped nested-scroll EPUB to load',
  );
  await page.waitFor(
    `(${epubScroller}?.scrollWidth ?? 0) > (${epubScroller}?.clientWidth ?? 0)`,
    'nested-scroll EPUB to span multiple columns',
  );

  const nestedPoints = await page.evaluate(`(() => {
    const host = ${visibleEpubHost};
    const iframe = host?.querySelector('iframe');
    const doc = iframe?.contentDocument;
    const box = doc?.getElementById('nested-scroll');
    const outside = doc?.getElementById('outside-anchor');
    if (!iframe || !box || !outside || box.scrollHeight <= box.clientHeight) return null;
    const iRect = iframe.getBoundingClientRect();
    const bRect = box.getBoundingClientRect();
    const oRect = outside.getBoundingClientRect();
    return {
      nested: { x: Math.round(iRect.left + bRect.left + bRect.width / 2), y: Math.round(iRect.top + bRect.top + bRect.height / 2) },
      outside: { x: Math.round(iRect.left + oRect.left + oRect.width / 2), y: Math.round(iRect.top + oRect.top + oRect.height / 2) },
    };
  })()`);
  assert(
    nestedPoints !== null,
    'expected scrollable #nested-scroll box and #outside-anchor in EPUB',
  );

  await page.wheel(nestedPoints.nested, 120);
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.getElementById('nested-scroll')?.scrollTop ?? 0) > 0`,
    'vertical wheel over nested scrollable div scrolls inner container',
  );
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'wheel over nested scrollable div inside EPUB must NOT turn EPUB page',
  );

  await page.wheel(nestedPoints.outside, 120);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'wheel outside nested box turns EPUB page',
  );
  await waitForSettle(300);

  // =========================================================================
  // 2. PDF paginated: single, two-page, zoomed vertical scroll priority + settle latch
  // =========================================================================
  await page.resetViewport();
  await page.openUntil(`${visiblePdfViewer} && ${titleIs('sample')}`, 'the sample PDF');
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'single'`,
    'PDF single-page mode',
  );
  await page.clickButton('Fit page');
  await page.waitFor(`${visiblePdfViewer}?.dataset.zoomMode === 'fit-page'`, 'PDF Fit page');
  await page.evaluate(`document.activeElement?.blur?.()`);

  const pdfCenter = await page.evaluate(`(() => {
    const r = ${visiblePdfScroll}.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

  // Clamp at page 1, turn forward to 2, turn back to 1.
  await page.wheel(pdfCenter, -120);
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'wheel up on PDF page 1 stays on page 1',
  );

  await page.wheel(pdfCenter, 120);
  await page.waitFor(
    `${pdfPageField}?.value === '2'`,
    'wheel down on Fit page PDF turns to page 2',
  );
  await waitForSettle(320);

  await page.wheel(pdfCenter, -120);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'wheel up on Fit page PDF turns back to page 1',
  );
  await waitForSettle(320);

  // Ctrl+wheel zooms instead of turning page.
  await page.wheel(pdfCenter, -120, 2);
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'Ctrl+wheel in PDF must not turn page',
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.zoomMode !== 'fit-page'`,
    'Ctrl+wheel zooms PDF instead of turning',
  );
  await page.clickButton('Fit page');
  await page.waitFor(`${visiblePdfViewer}?.dataset.zoomMode === 'fit-page'`, 'restore Fit page');
  await page.evaluate(`document.activeElement?.blur?.()`);

  // Horizontal swipe still works alongside vertical wheel.
  await dispatchPdfSwipeStream(page, [90, 90, 90]);
  await page.waitFor(`${pdfPageField}?.value === '2'`, 'horizontal swipe advances PDF single page');
  await waitForSettle(320);
  await dispatchPdfSwipeStream(page, [-90, -90, -90]);
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'horizontal swipe returns PDF single page');
  await waitForSettle(320);

  // Two-page PDF vertical wheel down/up & end boundary clamp.
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-two-page"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'two-page'`,
    'PDF two-page mode',
  );
  await page.clickButton('Fit page');
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.zoomMode === 'fit-page'`,
    'PDF two-page Fit page',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);

  await page.wheel(pdfCenter, 120);
  await page.waitFor(
    `Number(${pdfPageField}?.value) > 1`,
    'wheel down advances PDF two-page spread',
  );
  await waitForSettle(320);
  await page.wheel(pdfCenter, -120);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'wheel up returns PDF two-page spread to page 1',
  );
  await waitForSettle(320);

  // Configurable wheel sensitivity in PDF appearance popover (#111).
  await setWheelSensitivity(page, 1, 'Very low', { customize: false });
  await dispatchPdfVerticalStream(page, [8, 8]);
  await waitForSettle(200);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'PDF at Very low (1) sensitivity must not turn on [8, 8] (16px) vertical wheel stream',
  );
  await setWheelSensitivity(page, 5, 'Very high', { customize: false });
  await dispatchPdfVerticalStream(page, [8, 8]);
  await page.waitFor(
    `Number(${pdfPageField}?.value) > 1`,
    'PDF at Very high (5) sensitivity turns forward on [8, 8] (16px)',
  );
  await waitForSettle(320);
  await dispatchPdfVerticalStream(page, [-8, -8]);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'PDF at Very high (5) sensitivity turns backward on [-8, -8] (-16px)',
  );
  await waitForSettle(320);
  // A long fluctuating scroll stream at Very high sensitivity advances only 1 spread (not straight to page 4-5).
  await dispatchPdfVerticalStream(page, [15, 25, 12, 30, 10, 28, 35, 18, 24, 15, 8, 4]);
  await page.waitFor(
    `Number(${pdfPageField}?.value) > 1`,
    'PDF long vertical scroll stream advances from page 1',
  );
  await waitForSettle(320);
  const afterLongPdfPage = Number(await page.evaluate(`${pdfPageField}?.value`));
  assert(
    afterLongPdfPage === 2 || afterLongPdfPage === 3,
    `long PDF vertical scroll stream must advance only 1 spread (got page ${afterLongPdfPage})`,
  );
  await dispatchPdfVerticalStream(page, [-15, -25, -12, -30, -10, -28, -20, -10, -4]);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'long PDF backward scroll stream returns to page 1',
  );
  await waitForSettle(320);
  // Horizontal swipe remains unaffected at Very high sensitivity; then restore Normal (3).
  await dispatchPdfSwipeStream(page, [90, 90, 90]);
  await page.waitFor(
    `Number(${pdfPageField}?.value) > 1`,
    'horizontal swipe still works at Very high sensitivity',
  );
  await waitForSettle(320);
  await dispatchPdfSwipeStream(page, [-90, -90, -90]);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'horizontal swipe back at Very high sensitivity',
  );
  await waitForSettle(320);
  await setWheelSensitivity(page, 3, 'Normal', { customize: false });

  const pdfMaxPage = await page.evaluate(`(() => {
    const label = document.querySelector('[data-testid="unified-toolbar"]')?.textContent ?? '';
    const match = label.match(/of\\s+(\\d+)/);
    return match ? Number(match[1]) : 5;
  })()`);
  for (let i = 0; i < 6; i += 1) {
    if (Number(await page.evaluate(`${pdfPageField}?.value`)) >= pdfMaxPage - 1) break;
    await page.wheel(pdfCenter, 120);
    await waitForSettle(300);
  }
  const beforePdfEnd = await page.evaluate(`${pdfPageField}?.value`);
  await page.wheel(pdfCenter, 120);
  await page.wheel(pdfCenter, 120);
  await waitForSettle(260);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === beforePdfEnd,
    'wheel down at last PDF spread clamps without wrapping',
  );

  // Zoomed/overflowing PDF (single + Fit width + Zoom in) vertical scroll priority & EDGE_SETTLE_MS (250 ms).
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'single'`,
    'PDF single for zoomed test',
  );
  await page.clickButton('Fit width');
  await page.clickButton('Zoom in');
  await page.evaluate(`document.activeElement?.blur?.()`);

  await page.waitFor(`${visiblePdfScroll}`, 'PDF scroller present');
  await page.evaluate(`(() => {
    const field = ${pdfPageField};
    field?.focus();
    field?.select();
  })()`);
  await page.typeText('1');
  await page.press('Enter');
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'jump to page 1 for zoomed vertical scroll');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollHeight ?? 0) > (${visiblePdfScroll}?.clientHeight ?? 0) + 100`,
    'zoomed PDF page 1 overflows vertically',
  );
  await page.evaluate(`(() => { const s = ${visiblePdfScroll}; if (s) s.scrollTop = 0; })()`);

  await page.wheel(pdfCenter, 120);
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > 0`,
    'wheel down scrolls inside overflowing PDF page 1',
  );
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'scrolling within zoomed PDF page 1 keeps page at 1',
  );

  // Move right above bottom edge, stream to bottom edge so EDGE_SETTLE_MS latches.
  await page.evaluate(`(() => {
    const s = ${visiblePdfScroll};
    if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 40);
  })()`);
  await waitForSettle(60);
  await page.wheel(pdfCenter, 120);
  const bottomLatch = await page.evaluate(`new Promise((resolve, reject) => {
    const s = ${visiblePdfScroll};
    if (!s) return reject(new Error('missing PDF scroller'));
    const deadline = performance.now() + 5000;
    const probe = () => {
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) {
        // Dispatch immediately on hitting the edge so waitFor/CDP latency never consumes EDGE_SETTLE_MS (250 ms).
        s.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
        resolve(true);
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error('timed out waiting for zoomed PDF to hit bottom edge'));
        return;
      }
      requestAnimationFrame(probe);
    };
    probe();
  })`);
  assert(bottomLatch === true, 'zoomed PDF hits bottom edge and probes latch');
  await waitForSettle(60);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'wheel within EDGE_SETTLE_MS (250 ms) after hitting PDF bottom edge must stay latched on page 1',
  );

  await waitForSettle(310);
  await page.wheel(pdfCenter, 120);
  await page.waitFor(
    `${pdfPageField}?.value === '2'`,
    'wheel after 250 ms edge settle turns zoomed PDF to page 2',
  );
  await waitForSettle(320);

  // Symmetric top-edge settle latch on page 2 -> back to page 1.
  await page.evaluate(`(() => { const s = ${visiblePdfScroll}; if (s) s.scrollTop = 40; })()`);
  await waitForSettle(60);
  await page.wheel(pdfCenter, -120);
  const topLatch = await page.evaluate(`new Promise((resolve, reject) => {
    const s = ${visiblePdfScroll};
    if (!s) return reject(new Error('missing PDF scroller'));
    const deadline = performance.now() + 5000;
    const probe = () => {
      if (s.scrollTop === 0) {
        s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        resolve(true);
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error('timed out waiting for zoomed PDF page 2 to hit top edge'));
        return;
      }
      requestAnimationFrame(probe);
    };
    probe();
  })`);
  assert(topLatch === true, 'zoomed PDF page 2 hits top edge and probes latch');
  await waitForSettle(60);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '2',
    'wheel up within EDGE_SETTLE_MS after hitting PDF top edge must stay latched on page 2',
  );

  await waitForSettle(310);
  await page.wheel(pdfCenter, -120);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'wheel up after edge settle turns back to page 1',
  );

  // =========================================================================
  // 3. Continuous modes left untouched by #106 vertical wheel paging
  // =========================================================================
  // PDF Continuous
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-continuous"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'continuous'`,
    'PDF Continuous mode',
  );
  await page.evaluate(`(() => { const s = ${visiblePdfScroll}; if (s) s.scrollTop = 0; })()`);
  await page.wheel(pdfCenter, 120);
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > 0`,
    'PDF Continuous scrolls vertically on wheel',
  );
  const pdfContStep = await page.evaluate(`${visiblePdfScroll}?.scrollTop ?? 0`);
  assert(
    pdfContStep > 0 && pdfContStep < 300,
    `PDF Continuous scrolls linearly on wheel (got ${pdfContStep})`,
  );

  // EPUB Scroll
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] [role="tab"][data-e2e="wheel-epub"]')?.click()`,
  );
  await page.waitFor(`${visibleEpubHost} && ${titleIs('sample')}`, 'back to sample EPUB tab');
  await page.clickButton('Scroll');
  await page.waitFor(`${visibleEpubViewer}?.dataset.readingMode === 'scroll'`, 'EPUB Scroll mode');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollHeight ?? 0) > (${visibleEpubHost}?.querySelector('.epub-container')?.clientHeight ?? 0)`,
    'EPUB Scroll container ready',
  );
  await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollTop = 0; })()`);
  const epubScrollPoint = await epubPoint();
  await page.wheel(epubScrollPoint, 120);
  await page.waitFor(
    `(${epubScroller}?.scrollTop ?? 0) > 0`,
    'EPUB Scroll scrolls natively on wheel',
  );
  const epubStep = await page.evaluate(`${epubScroller}?.scrollTop ?? 0`);
  assert(
    epubStep > 0 && epubStep < 300 && (await page.evaluate(chapterIs('Chapter One'))),
    `EPUB Scroll scrolls linearly without turning chapter (got ${epubStep})`,
  );

  // TXT
  await page.evaluate(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')[0]?.click()`,
  );
  await page.waitFor(`${visibleTxtScroll}`, 'back to initial TXT tab');
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  const txtCenter = await page.evaluate(`(() => {
    const r = ${visibleTxtScroll}.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await page.wheel(txtCenter, 120);
  await page.waitFor(`(${visibleTxtScroll}?.scrollTop ?? 0) > 0`, 'TXT scrolls natively on wheel');
  const txtStep = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);
  assert(txtStep > 0 && txtStep < 300, `TXT scrolls linearly on wheel (got ${txtStep})`);
}
