import { assert } from './harness.mjs';
import {
  chapterIs,
  createSyntheticEpubBase64,
  dropBinaryFile,
  dropTextFile,
  pdfPageField,
  selectPageTurn as selectPaginatedTransition,
  titleIs,
  visibleEpubArea,
  visibleEpubHost,
  visibleEpubViewer,
  visiblePdfScroll,
  visiblePdfViewer,
  visibleTxtScroll,
} from './pagingHelpers.mjs';

function createMultiSpreadEpubBase64() {
  const ch1Paragraphs = Array.from(
    { length: 85 },
    (_, i) =>
      `<p class="body-copy">Chapter one paragraph ${i + 1} with selectable alphaWord${i + 1} betaPhrase gammaTerm for paginated column layouts and double-click testing.</p>`,
  ).join('');
  const ch2Paragraphs = Array.from(
    { length: 50 },
    (_, i) =>
      `<p class="body-copy">Chapter two paragraph ${i + 1} providing enough multi-spread pagination depth across seams and rapid reversals.</p>`,
  ).join('');

  return createSyntheticEpubBase64({
    id: 'clicks-test',
    title: 'clicks-test',
    chapters: [
      {
        id: 'ch1',
        href: 'ch1.xhtml',
        title: 'Chapter One',
        body: `<h1>Chapter One</h1>\n  ${ch1Paragraphs}`,
      },
      {
        id: 'ch2',
        href: 'ch2.xhtml',
        title: 'Chapter Two',
        body: `<h1>Chapter Two</h1>\n  ${ch2Paragraphs}`,
      },
    ],
  });
}

async function waitSettle(ms = 420) {
  await new Promise((done) => setTimeout(done, ms));
}

async function waitForEpubAnimationsClear(page) {
  await page.waitFor(
    `(${visibleEpubHost}?.getAnimations?.() ?? []).length === 0`,
    'EPUB turn animations to finish',
  );
}

/**
 * #107: Consecutive / double blank-margin clicks advance multiple pages reliably in
 * EPUB (1-col & 2-col across Slide & Curl, inner & outer margins, seams & reversals),
 * PDF (single & two-page across Slide & Curl, reversals & boundaries), and TXT;
 * double-clicking body text, highlighted text, and EPUB `<pre>` code blocks selects
 * without turning; and Click 1 selection dismissal + rapid Click 2 turns only once.
 */
export async function consecutiveClicksFlow(page) {
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // =========================================================================
  // 1. EPUB: 1-col, 2-col, Slide & Curl, outer & inner margins, seams, selection dismissal
  // =========================================================================
  await page.setViewport(1728);
  await page.openUntil(`${visibleEpubHost} && ${titleIs('sample')}`, 'the sample EPUB first');
  const epubBase64 = createMultiSpreadEpubBase64();
  await dropBinaryFile(page, epubBase64, 'clicks-test.epub', 'application/epub+zip');
  await page.waitFor(
    `${visibleEpubHost} && ${titleIs('clicks-test')} && ${chapterIs('Chapter One')}`,
    'dropped multi-spread EPUB clicks-test',
  );
  await page.waitForReaderLayout();

  const epubScroller = `${visibleEpubHost}?.querySelector('.epub-container')`;
  const getEpubPoints = () =>
    page.evaluate(`(() => {
      const host = ${visibleEpubHost};
      const area = ${visibleEpubArea};
      const scroller = host?.querySelector('.epub-container');
      const iframe = host?.querySelector('iframe');
      if (!host || !area || !scroller || !iframe) return null;
      const hRect = host.getBoundingClientRect();
      const aRect = area.getBoundingClientRect();
      const bottomY = Math.round(hRect.top + hRect.height - 40);
      const outerRightGap = aRect.right - hRect.right;
      const doc = iframe.contentDocument;
      const p = [...(doc?.querySelectorAll('p.body-copy') ?? [])].find((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= hRect.width && r.top >= 40 && r.bottom <= hRect.height - 80;
      });
      let wordPoint = null;
      if (p?.firstChild) {
        const idx = p.firstChild.data.indexOf('alphaWord');
        if (idx !== -1) {
          const range = doc.createRange();
          range.setStart(p.firstChild, idx);
          range.setEnd(p.firstChild, idx + 'alphaWord1'.length);
          const rr = range.getBoundingClientRect();
          const ir = iframe.getBoundingClientRect();
          wordPoint = { x: Math.round(ir.left + rr.left + rr.width / 2), y: Math.round(ir.top + rr.top + rr.height / 2) };
        }
      }
      return {
        innerRight: { x: Math.round(hRect.right - 22), y: bottomY },
        innerLeft: { x: Math.round(hRect.left + 22), y: bottomY },
        outerRight: outerRightGap >= 30 ? { x: Math.round(hRect.right + Math.min(20, outerRightGap / 2)), y: bottomY } : null,
        wordPoint,
        clientWidth: scroller.clientWidth,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
      };
    })()`);

  // --- 1A. EPUB Single page (1-col), Slide & Curl ---
  await page.clickButton('Single page');
  await page.waitFor(
    `${visibleEpubViewer}?.dataset.readingMode === 'paged' && ${visibleEpubViewer}?.dataset.columns === '1'`,
    'EPUB 1-col mode',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `(${epubScroller}?.scrollWidth ?? 0) >= (${epubScroller}?.clientWidth ?? 1) * 4`,
    'at least 4 columns in 1-col Chapter One',
  );

  for (const effect of ['Slide', 'Curl']) {
    await selectPaginatedTransition(page, effect, { customize: true });
    await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
    await waitSettle(150);

    const pts = await getEpubPoints();
    assert(pts && pts.clientWidth > 0, 'EPUB 1-col points resolved');

    // Consecutive double-click on blank right margin -> +2 columns.
    await page.multiClick(pts.innerRight, 2);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 0) >= ${pts.clientWidth * 2 - 4}`,
      `EPUB 1-col (${effect}) double blank right click advances 2 columns`,
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(180);

    // Consecutive double-click on blank left margin -> -2 columns back to 0.
    await page.multiClick(pts.innerLeft, 2);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 1) <= 4`,
      `EPUB 1-col (${effect}) double blank left click retreats 2 columns`,
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(180);
  }

  // Verify body-text double-click selects text WITHOUT turning, and selection dismissal
  // Click 1 + rapid Click 2 only turns ONCE (for both inner margin and outer epub-page-area).
  await selectPaginatedTransition(page, 'Slide', { customize: true });
  await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
  await waitSettle(150);
  const pts1Col = await getEpubPoints();
  assert(pts1Col?.wordPoint, 'expected visible body paragraph word in EPUB 1-col');
  await page.multiClick(pts1Col.wordPoint, 2);
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'double-clicking EPUB body text creates selection',
  );
  await waitSettle(200);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === 0,
    'double-clicking EPUB body text must NOT turn the page',
  );

  // Selection active -> Click 1 dismisses, rapid Click 2 turns ONLY 1 column (inner margin).
  await page.multiClick(pts1Col.innerRight, 2, 25);
  await page.waitFor(
    `(${epubScroller}?.scrollLeft ?? 0) > 0`,
    'Click 1 dismissal + rapid Click 2 turns EPUB page forward',
  );
  await waitForEpubAnimationsClear(page);
  await waitSettle(220);
  const afterDismissInner = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
  assert(
    Math.abs(afterDismissInner - pts1Col.clientWidth) <= 6,
    `Click 1 selection dismissal + rapid Click 2 must turn ONLY 1 column (expected ~${pts1Col.clientWidth}, got ${afterDismissInner})`,
  );

  // Repeat with outer `epub-page-area` blank margin.
  if (pts1Col.outerRight) {
    await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
    await waitSettle(150);
    await page.multiClick(pts1Col.outerRight, 2);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 0) >= ${pts1Col.clientWidth * 2 - 4}`,
      'outer epub-page-area blank double-click advances 2 columns',
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(180);

    await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
    await waitSettle(150);
    await page.multiClick(pts1Col.wordPoint, 2);
    await page.waitFor(
      `(${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
      'iframe selection before outer margin Click 1 + Click 2',
    );
    await page.multiClick(pts1Col.outerRight, 2, 25);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 0) > 0`,
      'outer margin Click 1 dismissal + rapid Click 2 turns once',
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(220);
    const afterDismissOuter = await page.evaluate(`${epubScroller}?.scrollLeft ?? 0`);
    assert(
      Math.abs(afterDismissOuter - pts1Col.clientWidth) <= 6,
      `outer epub-page-area Click 1 + rapid Click 2 must turn ONLY 1 column (expected ~${pts1Col.clientWidth}, got ${afterDismissOuter})`,
    );
  }

  // --- 1B. EPUB Two pages (2-col spread), Slide & Curl, chapter seam +2 and +1/-1 reversal ---
  await page.clickButton('Two pages');
  await page.waitFor(
    `${visibleEpubViewer}?.dataset.readingMode === 'spread' && ${visibleEpubViewer}?.dataset.columns === '2'`,
    'EPUB 2-col spread mode',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `(${epubScroller}?.scrollWidth ?? 0) >= (${epubScroller}?.clientWidth ?? 1) * 3`,
    'at least 3 spreads in 2-col Chapter One',
  );

  for (const effect of ['Slide', 'Curl']) {
    await selectPaginatedTransition(page, effect, { customize: true });
    await page.evaluate(`(() => { const s = ${epubScroller}; if (s) s.scrollLeft = 0; })()`);
    await waitSettle(150);
    const spreadPts = await getEpubPoints();

    await page.multiClick(spreadPts.innerRight, 2);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 0) >= ${spreadPts.clientWidth * 2 - 4}`,
      `EPUB 2-col (${effect}) double blank right click advances 2 spreads`,
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(200);

    await page.multiClick(spreadPts.innerLeft, 2);
    await page.waitFor(
      `(${epubScroller}?.scrollLeft ?? 1) <= 4`,
      `EPUB 2-col (${effect}) double blank left click retreats 2 spreads`,
    );
    await waitForEpubAnimationsClear(page);
    await waitSettle(200);
  }

  // EPUB seam double-click (+2 across Chapter One end -> Chapter Two 2nd spread) & rapid +1/-1 reversal.
  await selectPaginatedTransition(page, 'Curl', { customize: true });
  await page.evaluate(`(() => {
    const s = ${epubScroller};
    if (s) s.scrollLeft = Math.max(0, s.scrollWidth - s.clientWidth);
  })()`);
  await waitSettle(150);
  const seamPts = await getEpubPoints();
  await page.multiClick(seamPts.innerRight, 2);
  await page.waitFor(
    `${chapterIs('Chapter Two')} && (${epubScroller}?.scrollLeft ?? 0) > 0`,
    'double-clicking blank right margin on last spread of Chapter One lands past Chapter Two start (seam +2)',
  );
  await waitForEpubAnimationsClear(page);
  await waitSettle(250);

  // Rapid +1/-1 reversal across chapter seam settles cleanly back onto 1 active view.
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('Chapter One');
  await page.waitFor(chapterIs('Chapter One'), 'back to Chapter One for seam reversal test');
  await page.hideSidebar();
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.evaluate(`(() => {
    const s = ${epubScroller};
    if (s) s.scrollLeft = Math.max(0, s.scrollWidth - s.clientWidth);
  })()`);
  await waitSettle(150);
  await page.click(seamPts.innerRight);
  await waitSettle(40);
  await page.click(seamPts.innerLeft);
  await page.waitFor(
    `(() => {
      const host = ${visibleEpubHost};
      const area = host?.closest('[data-testid="epub-page-area"]');
      const curlHost = area?.querySelector('[data-testid="epub-curl-host"]');
      const leaf = area?.querySelector('[data-curl-part="leaf"]');
      return (
        ${chapterIs('Chapter One')} &&
        (host?.querySelectorAll('iframe')?.length ?? 0) === 1 &&
        (curlHost?.childElementCount ?? 0) === 0 &&
        (!curlHost || getComputedStyle(curlHost).visibility === 'hidden') &&
        Number(leaf ? getComputedStyle(leaf).opacity : 0) === 0
      );
    })()`,
    'rapid +1/-1 reversal across EPUB seam to settle on Chapter One with a single active view',
  );
  await waitForEpubAnimationsClear(page);
  assert(
    await page.evaluate(
      `${chapterIs('Chapter One')} && (${visibleEpubHost}?.querySelectorAll('iframe')?.length ?? 0) === 1`,
    ),
    'rapid +1/-1 reversal across EPUB seam returns cleanly to Chapter One with a single active view',
  );

  // --- 1C. EPUB `<pre>` code block double-click (`sample-code.epub`) ---
  await page.openUntil(`${visibleEpubHost} && ${titleIs('sample-code')}`, 'the sample-code EPUB');
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One of sample-code');
  await page.waitFor(
    `${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.querySelector('pre code')`,
    '<pre><code> block to render',
  );
  const codePoint = await page.evaluate(`(() => {
    const host = ${visibleEpubHost};
    const iframe = host?.querySelector('iframe');
    const doc = iframe?.contentDocument;
    const pre = doc?.querySelector('pre code') ?? doc?.querySelector('pre');
    if (!iframe || !doc || !pre) return null;
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.data.indexOf('collect_batch');
      if (idx === -1) continue;
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + 'collect_batch'.length);
      const rr = range.getBoundingClientRect();
      const ir = iframe.getBoundingClientRect();
      return {
        point: { x: Math.round(ir.left + rr.left + rr.width / 2), y: Math.round(ir.top + rr.top + rr.height / 2) },
        scrollLeft: host.querySelector('.epub-container')?.scrollLeft ?? 0,
      };
    }
    return null;
  })()`);
  assert(codePoint !== null, 'expected collect_batch token in sample-code <pre> block');
  await page.multiClick(codePoint.point, 2);
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.getSelection()?.toString() ?? '').includes('collect_batch')`,
    'double-clicking EPUB <pre> code selects word',
  );
  await waitSettle(200);
  assert(
    (await page.evaluate(`${epubScroller}?.scrollLeft ?? -1`)) === codePoint.scrollLeft,
    'double-clicking EPUB <pre> code must NOT turn the page',
  );

  // =========================================================================
  // 2. PDF: single & two-page (Slide & Curl), reversal, bounds, text/highlight dblclick, dismissal
  // =========================================================================
  await page.resetViewport();
  await page.openUntil(`${visiblePdfViewer} && ${titleIs('sample')}`, 'the sample PDF');
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(`${visiblePdfViewer}?.dataset.displayMode === 'single'`, 'PDF Single page');
  await page.clickButton('Fit page');
  await page.waitFor(`${visiblePdfViewer}?.dataset.zoomMode === 'fit-page'`, 'PDF Fit page');
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `${visiblePdfScroll}?.querySelectorAll('.textLayer span')?.length > 0`,
    'PDF page 1 textLayer spans rendered',
  );

  const getPdfPoints = () =>
    page.evaluate(`(() => {
      const s = ${visiblePdfScroll};
      if (!s) return null;
      const r = s.getBoundingClientRect();
      const bottomY = Math.round(r.top + r.height - 40);
      const span = [...s.querySelectorAll('.textLayer span')].find((el) => {
        const txt = el.textContent?.trim() ?? '';
        const sr = el.getBoundingClientRect();
        return txt.length >= 6 && sr.width >= 30 && sr.left >= r.left + 30 && sr.right <= r.right - 30 && sr.top >= r.top + 30 && sr.bottom <= r.bottom - 50;
      });
      let wordPoint = null;
      if (span?.firstChild?.nodeType === 3) {
        const range = document.createRange();
        const wordMatch = span.firstChild.data.match(/[A-Za-z]{4,}/);
        if (wordMatch) {
          const start = wordMatch.index ?? 0;
          range.setStart(span.firstChild, start);
          range.setEnd(span.firstChild, start + wordMatch[0].length);
          const rr = range.getBoundingClientRect();
          wordPoint = { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2) };
        }
      }
      return {
        right: { x: Math.round(r.right - 22), y: bottomY },
        left: { x: Math.round(r.left + 22), y: bottomY },
        wordPoint,
      };
    })()`);

  for (const effect of ['Slide', 'Curl']) {
    await selectPaginatedTransition(page, effect, { customize: false });
    await page.evaluate(
      `(() => { const f = ${pdfPageField}; if (f) { f.focus(); f.select(); } })()`,
    );
    await page.typeText('1');
    await page.press('Enter');
    await page.waitFor(`${pdfPageField}?.value === '1'`, 'PDF reset to page 1');
    await waitSettle(150);

    const pts = await getPdfPoints();
    assert(pts !== null, 'PDF margin points available');

    await page.multiClick(pts.right, 2);
    await page.waitFor(
      `${pdfPageField}?.value === '3'`,
      `PDF single (${effect}) double blank right click -> page 3`,
    );
    await waitSettle(350);

    await page.multiClick(pts.left, 2);
    await page.waitFor(
      `${pdfPageField}?.value === '1'`,
      `PDF single (${effect}) double blank left click -> page 1`,
    );
    await waitSettle(350);
  }

  // Rapid +1/-1 reversal in PDF Curl settles back on page 1 without stuck overlay.
  const pdfPts = await getPdfPoints();
  await page.click(pdfPts.right);
  await waitSettle(40);
  await page.click(pdfPts.left);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'PDF Curl rapid +1/-1 settles back on page 1',
  );
  await waitSettle(350);

  // Boundary clamp: left dblclick on page 1 stays 1; right dblclick near end clamps on page 5.
  await page.multiClick(pdfPts.left, 2);
  await waitSettle(200);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'PDF start double-click stays at page 1',
  );

  await page.evaluate(`(() => { const f = ${pdfPageField}; if (f) { f.focus(); f.select(); } })()`);
  await page.typeText('4');
  await page.press('Enter');
  await page.waitFor(`${pdfPageField}?.value === '4'`, 'jump to PDF page 4');
  await waitSettle(150);
  await page.multiClick(pdfPts.right, 2);
  await page.waitFor(
    `${pdfPageField}?.value === '5'`,
    'PDF double-click near end clamps at page 5',
  );
  await waitSettle(200);

  // Return to page 1 for body-text dblclick, highlight dblclick, and Click 1 + Click 2 dismissal.
  await page.evaluate(`(() => { const f = ${pdfPageField}; if (f) { f.focus(); f.select(); } })()`);
  await page.typeText('1');
  await page.press('Enter');
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'back to PDF page 1');
  await page.waitFor(
    `${visiblePdfScroll}?.querySelectorAll('.textLayer span')?.length > 0`,
    'PDF page 1 textLayer spans re-rendered',
  );

  const pdfWordPts = await getPdfPoints();
  assert(pdfWordPts?.wordPoint, 'expected selectable word in PDF page 1 textLayer');
  await page.multiClick(pdfWordPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'double-clicking PDF body word selects text',
  );
  await waitSettle(150);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1',
    'double-clicking PDF body text must NOT turn',
  );

  // Click 1 dismissal + rapid Click 2 turns ONLY ONCE ('1' -> '2').
  await page.multiClick(pdfWordPts.right, 2, 25);
  await page.waitFor(
    `${pdfPageField}?.value === '2'`,
    'PDF Click 1 dismissal + rapid Click 2 turns once to page 2',
  );
  await waitSettle(350);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '2',
    'PDF rapid post-selection click did not double-turn',
  );

  // Double-clicking a highlighted word in PDF selects without turning or opening popover.
  await page.multiClick(pdfWordPts.left, 1);
  await page.waitFor(`${pdfPageField}?.value === '1'`, 'back to PDF page 1 for highlight test');
  await page.waitFor(
    `${visiblePdfScroll}?.querySelectorAll('.textLayer span')?.length > 0`,
    'PDF page 1 textLayer spans for highlight',
  );
  const pdfHlPts = await getPdfPoints();
  await page.multiClick(pdfHlPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'select word to highlight in PDF',
  );
  await page.clickButton('Yellow highlight');
  await page.waitFor(
    `!document.querySelector('[data-testid="selection-popover"]')`,
    'highlight created and selection popover closed',
  );
  await page.multiClick(pdfHlPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'double-clicking highlighted PDF word selects text cleanly',
  );
  await waitSettle(180);
  assert(
    (await page.evaluate(`${pdfPageField}?.value`)) === '1' &&
      !(await page.evaluate(
        `Boolean(document.querySelector('[data-testid="selection-popover"][data-popover-mode="edit"]'))`,
      )),
    'double-clicking highlighted PDF word neither turns page nor opens annotation popover',
  );
  await page.evaluate(`document.getSelection()?.removeAllRanges()`);

  // PDF two-page double-click forward & backward.
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-two-page"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'two-page'`,
    'PDF two-page mode',
  );
  await page.clickButton('Fit page');
  await page.evaluate(`document.activeElement?.blur?.()`);
  const pdfTwoPts = await getPdfPoints();
  await page.multiClick(pdfTwoPts.right, 2);
  await page.waitFor(
    `Number(${pdfPageField}?.value) >= 4`,
    'PDF two-page double blank right click advances 2 spreads',
  );
  await waitSettle(350);
  await page.multiClick(pdfTwoPts.left, 2);
  await page.waitFor(
    `${pdfPageField}?.value === '1'`,
    'PDF two-page double blank left click retreats to page 1',
  );

  // =========================================================================
  // 3. TXT: blank multi-click (+2/-2 steps), body & highlighted word dblclick, dismissal
  // =========================================================================
  const txtPayload = Array.from(
    { length: 160 },
    (_, i) =>
      `Click line ${String(i + 1).padStart(3, '0')}: selectableWord${i + 1} for multi-click blank margin coverage.`,
  ).join('\n\n');
  await dropTextFile(page, txtPayload, 'clicks-test.txt');
  await page.waitFor(
    `${visibleTxtScroll} && ${titleIs('clicks-test')}`,
    'dropped multi-page TXT clicks-test',
  );
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollHeight ?? 0) > (${visibleTxtScroll}?.clientHeight ?? 0) * 3`,
    'dropped TXT spans 3+ viewports',
  );

  await selectPaginatedTransition(page, 'Fade', { customize: true });

  const getTxtPoints = () =>
    page.evaluate(`(() => {
      const s = ${visibleTxtScroll};
      if (!s) return null;
      const r = s.getBoundingClientRect();
      const row = [...s.querySelectorAll('[data-index]')].find((el) => {
        const rr = el.getBoundingClientRect();
        return el.textContent?.includes('selectableWord') && rr.top >= r.top + 40 && rr.bottom <= r.bottom - 80;
      });
      let wordPoint = null;
      if (row) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const idx = node.data.indexOf('selectableWord');
          if (idx === -1) continue;
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 'selectableWord'.length);
          const rr = range.getBoundingClientRect();
          wordPoint = { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2) };
          break;
        }
      }
      return {
        right: { x: Math.round(r.right - 20), y: Math.round(r.top + r.height - 40) },
        left: { x: Math.round(r.left + 20), y: Math.round(r.top + r.height - 40) },
        wordPoint,
        clientHeight: s.clientHeight,
      };
    })()`);

  // Measure single blank click distance first.
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  const txtPts = await getTxtPoints();
  assert(txtPts?.wordPoint, 'expected selectable word in TXT');
  await page.click(txtPts.right);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > 0`,
    'TXT single blank click steps once',
  );
  const txtSingleTop = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);

  // Reset to 0 -> double-click blank right margin advances 2 steps (> singleStep + half viewport).
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  await waitSettle(80);
  await page.multiClick(txtPts.right, 2);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > ${txtSingleTop + Math.round(txtPts.clientHeight * 0.45)}`,
    'TXT consecutive double blank right click advances 2 steps',
  );
  await waitSettle(260);
  const txtAfterDouble = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);

  // Double-click blank left margin steps back 2 steps (> singleStep + half viewport).
  await page.multiClick(txtPts.left, 2);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? ${txtAfterDouble}) < ${txtAfterDouble - txtSingleTop - Math.round(txtPts.clientHeight * 0.45)}`,
    'TXT consecutive double blank left click retreats 2 steps',
  );
  await waitSettle(260);

  // Double-click body word -> selects without turning; Click 1 + rapid Click 2 turns ONLY once.
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  await waitSettle(80);
  const txtWordPts = await getTxtPoints();
  await page.multiClick(txtWordPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'double-clicking TXT word creates selection',
  );
  await waitSettle(150);
  assert(
    (await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? -1`)) === 0,
    'double-clicking TXT word must NOT turn',
  );

  await page.multiClick(txtWordPts.right, 2, 25);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > 0`,
    'TXT Click 1 dismissal + rapid Click 2 turns once',
  );
  await waitSettle(280);
  const txtAfterDismiss = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);
  assert(
    Math.abs(txtAfterDismiss - txtSingleTop) <= 40,
    `TXT Click 1 selection dismissal + rapid Click 2 must turn ONLY once (single=${txtSingleTop}, got=${txtAfterDismiss})`,
  );

  // Double-clicking a highlighted word in TXT selects cleanly without turning or opening annotation popover.
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  await waitSettle(80);
  const txtHlPts = await getTxtPoints();
  await page.multiClick(txtHlPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'select TXT word for highlight',
  );
  await page.clickButton('Yellow highlight');
  await page.waitFor(
    `!document.querySelector('[data-testid="selection-popover"]')`,
    'TXT highlight created',
  );
  await page.multiClick(txtHlPts.wordPoint, 2);
  await page.waitFor(
    `(document.getSelection()?.toString()?.trim()?.length ?? 0) > 0`,
    'double-clicking highlighted TXT word selects cleanly',
  );
  await waitSettle(150);
  assert(
    (await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? -1`)) === 0 &&
      !(await page.evaluate(
        `Boolean(document.querySelector('[data-testid="selection-popover"][data-popover-mode="edit"]'))`,
      )),
    'double-clicking highlighted TXT word neither scrolls nor opens annotation popover',
  );
}
