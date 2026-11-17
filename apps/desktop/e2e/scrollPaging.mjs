import { assert } from './harness.mjs';
import {
  chapterIs,
  dropTextFile,
  pdfPageField,
  readPageTurnOptions,
  selectPageTurn,
  titleIs,
  visibleEpubHost,
  visibleEpubViewer,
  visiblePdfScroll,
  visiblePdfViewer,
  visibleTxtScroll,
} from './pagingHelpers.mjs';

const ALT = 1;
const META = 4;
const SHIFT = 8;

/**
 * Installs a rAF observer before triggering a turn so the 200 ms fade Web Animation
 * (`id: 'page-turn'`) is sampled cleanly without racing wall-clock timers.
 */
async function armFadeProbe(page, targetsExpr, maxMs = 340) {
  await page.waitFor(
    `!(${targetsExpr}).filter(Boolean).some((el) => el.getAnimations().some((a) => a.id === 'page-turn'))`,
    'previous page-turn fade animation to settle before probing',
  );
  await page.evaluate(`(() => {
    const state = {
      done: false,
      minOpacity: 1,
      hadPageTurnAnim: false,
      allTransformsNone: true,
    };
    window.__fadeProbe = state;
    const start = performance.now();
    const tick = () => {
      const elements = (${targetsExpr}).filter(Boolean);
      for (const el of elements) {
        const cs = getComputedStyle(el);
        const op = Number.parseFloat(cs.opacity);
        if (Number.isFinite(op) && op < state.minOpacity) state.minOpacity = op;
        if (cs.transform && cs.transform !== 'none') {
          const translateX = new DOMMatrixReadOnly(cs.transform).e;
          if (Math.abs(translateX) > 0.5) state.allTransformsNone = false;
        }
        for (const anim of el.getAnimations()) {
          if (anim.id === 'page-turn') {
            state.hadPageTurnAnim = true;
            const kfs = anim.effect?.getKeyframes?.() ?? [];
            if (kfs.some((kf) => kf.transform !== undefined && kf.transform !== 'none')) {
              state.allTransformsNone = false;
            }
          }
        }
      }
      if (performance.now() - start >= ${maxMs}) {
        state.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

async function finishFadeProbe(page) {
  await page.waitFor(`window.__fadeProbe?.done === true`, 'fade probe window to complete');
  return page.evaluate(`window.__fadeProbe`);
}

function assertFadePlayed(probe, label) {
  assert(
    probe.hadPageTurnAnim && probe.minOpacity < 0.9,
    `${label} should animate fade opacity dip (got minOpacity=${probe.minOpacity}, hadPageTurnAnim=${probe.hadPageTurnAnim})`,
  );
  assert(probe.allTransformsNone, `${label} fade should not apply translate/slide transforms`);
}

function assertNoFade(probe, label) {
  assert(
    !probe.hadPageTurnAnim && probe.minOpacity === 1,
    `${label} should NOT run fade animation (got minOpacity=${probe.minOpacity}, hadPageTurnAnim=${probe.hadPageTurnAnim})`,
  );
}

/**
 * Positions `scrollerExpr` so an inner text line box straddles the top or bottom edge,
 * and returns a verifier marker `{ text }` so the test can confirm no line was skipped.
 */
async function setupEpubScrollLineStraddle(page, edge) {
  return page.evaluate(`(() => {
    const host = ${visibleEpubHost};
    const scroller = host?.querySelector('.epub-container');
    const iframe = host?.querySelector('iframe');
    const doc = iframe?.contentDocument;
    if (!scroller || !iframe || !doc) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();
    const candidateLines = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.data.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height < 10 || rect.height > 60 || rect.width < 40) continue;
        const absTop = iframeRect.top + rect.top - scrollerRect.top + scroller.scrollTop;
        const absBottom = absTop + rect.height;
        candidateLines.push({
          text: node.data.slice(0, 60),
          absTop,
          absBottom,
          height: rect.height,
        });
      }
    }
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (${JSON.stringify(edge)} === 'bottom') {
      const target = candidateLines.find(
        (line) => line.absTop > scroller.clientHeight + 20 && line.absBottom < scroller.scrollHeight - 40,
      );
      if (!target) return null;
      const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop - (scroller.clientHeight - target.height * 0.45))));
      scroller.scrollTop = nextTop;
      const straddleTop = target.absTop - scroller.scrollTop;
      const straddleBottom = target.absBottom - scroller.scrollTop;
      if (!(straddleTop < scroller.clientHeight - 1 && straddleBottom > scroller.clientHeight + 1)) return null;
      return { text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
    }
    const target = candidateLines.find(
      (line) => line.absTop > 120 && line.absTop + line.height * 0.45 <= maxScroll - 20,
    );
    if (!target) return null;
    const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop + target.height * 0.45)));
    scroller.scrollTop = nextTop;
    const straddleTop = target.absTop - scroller.scrollTop;
    const straddleBottom = target.absBottom - scroller.scrollTop;
    if (!(straddleTop < -1 && straddleBottom > 1)) return null;
    return { text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
  })()`);
}

async function checkEpubLineVisible(page, target) {
  return page.evaluate(`(() => {
    const host = ${visibleEpubHost};
    const scroller = host?.querySelector('.epub-container');
    if (!scroller) return null;
    const relTop = ${target.absTop} - scroller.scrollTop;
    const relBottom = ${target.absBottom} - scroller.scrollTop;
    return {
      relTop,
      relBottom,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      fullyVisible: relTop >= -2 && relBottom <= scroller.clientHeight + 2,
    };
  })()`);
}

async function setupPdfScrollLineStraddle(page, edge) {
  return page.evaluate(`(() => {
    const scroller = ${visiblePdfScroll};
    if (!scroller) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const spans = [...scroller.querySelectorAll('.textLayer span')]
      .filter((s) => s.textContent?.trim().length > 3)
      .map((s) => {
        const r = s.getBoundingClientRect();
        return {
          el: s,
          text: s.textContent?.trim() ?? '',
          absTop: r.top - scrollerRect.top + scroller.scrollTop,
          absBottom: r.bottom - scrollerRect.top + scroller.scrollTop,
          height: r.height,
        };
      })
      .filter((s) => s.height >= 8 && s.height <= 60);
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (${JSON.stringify(edge)} === 'bottom') {
      const target = spans.find(
        (s) => s.absTop > scroller.clientHeight + 20 && s.absBottom < scroller.scrollHeight - 40,
      );
      if (!target) return null;
      const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop - (scroller.clientHeight - target.height * 0.45))));
      scroller.scrollTop = nextTop;
      const straddleTop = target.absTop - scroller.scrollTop;
      const straddleBottom = target.absBottom - scroller.scrollTop;
      if (!(straddleTop < scroller.clientHeight - 1 && straddleBottom > scroller.clientHeight + 1)) return null;
      return { text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
    }
    const target = spans.find(
      (s) => s.absTop > 120 && s.absTop + s.height * 0.45 <= maxScroll - 20,
    );
    if (!target) return null;
    const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop + target.height * 0.45)));
    scroller.scrollTop = nextTop;
    const straddleTop = target.absTop - scroller.scrollTop;
    const straddleBottom = target.absBottom - scroller.scrollTop;
    if (!(straddleTop < -1 && straddleBottom > 1)) return null;
    return { text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
  })()`);
}

async function checkPdfLineVisible(page, target) {
  return page.evaluate(`(() => {
    const scroller = ${visiblePdfScroll};
    if (!scroller) return null;
    const relTop = ${target.absTop} - scroller.scrollTop;
    const relBottom = ${target.absBottom} - scroller.scrollTop;
    return {
      relTop,
      relBottom,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      fullyVisible: relTop >= -2 && relBottom <= scroller.clientHeight + 2,
    };
  })()`);
}

async function setupTxtLineStraddle(page, edge) {
  return page.evaluate(`(() => {
    const scroller = ${visibleTxtScroll};
    if (!scroller) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll('[data-index]')]
      .map((row) => {
        const r = row.getBoundingClientRect();
        return {
          index: Number(row.getAttribute('data-index')),
          text: row.textContent?.trim() ?? '',
          absTop: r.top - scrollerRect.top + scroller.scrollTop,
          absBottom: r.bottom - scrollerRect.top + scroller.scrollTop,
          height: r.height,
        };
      })
      .filter((r) => r.text.length > 0 && r.height > 10 && r.height < 60);
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (${JSON.stringify(edge)} === 'bottom') {
      const target = rows.find(
        (r) => r.absTop > scroller.clientHeight + 20 && r.absBottom < scroller.scrollHeight - 40,
      );
      if (!target) return null;
      const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop - (scroller.clientHeight - target.height * 0.45))));
      scroller.scrollTop = nextTop;
      const straddleTop = target.absTop - scroller.scrollTop;
      const straddleBottom = target.absBottom - scroller.scrollTop;
      if (!(straddleTop < scroller.clientHeight - 1 && straddleBottom > scroller.clientHeight + 1)) return null;
      return { index: target.index, text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
    }
    const target = rows.find(
      (r) => r.absTop > 120 && r.absTop + r.height * 0.45 <= maxScroll - 20,
    );
    if (!target) return null;
    const nextTop = Math.min(maxScroll, Math.max(0, Math.round(target.absTop + target.height * 0.45)));
    scroller.scrollTop = nextTop;
    const straddleTop = target.absTop - scroller.scrollTop;
    const straddleBottom = target.absBottom - scroller.scrollTop;
    if (!(straddleTop < -1 && straddleBottom > 1)) return null;
    return { index: target.index, text: target.text, absTop: target.absTop, absBottom: target.absBottom, scrollTop: scroller.scrollTop };
  })()`);
}

async function checkTxtLineVisible(page, target) {
  return page.evaluate(`(() => {
    const scroller = ${visibleTxtScroll};
    if (!scroller) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const row = scroller.querySelector('[data-index="' + ${target.index} + '"]');
    if (!row) return { missing: true, scrollTop: scroller.scrollTop };
    const r = row.getBoundingClientRect();
    const relTop = r.top - scrollerRect.top;
    const relBottom = r.bottom - scrollerRect.top;
    return {
      relTop,
      relBottom,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      fullyVisible: relTop >= -2 && relBottom <= scroller.clientHeight + 2,
    };
  })()`);
}

/**
 * #103: Continuous-scrolling explicit page turns in EPUB Scroll, PDF Continuous, and TXT.
 * Verifies None/Fade-only appearance options, paginated preference preservation, Fade vs
 * instant turns (under None / reduced motion), reading-continuity overlap so partially
 * obscured lines aren't skipped, EPUB backward chapter seam landing, normal wheel isolation,
 * and GoTo/boundary non-fade behavior.
 */
export async function scrollPagingFlow(page) {
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // =========================================================================
  // 1. EPUB Scroll (#103)
  // =========================================================================
  await page.openUntil(`${visibleEpubHost} && ${titleIs('sample')}`, 'the sample EPUB');
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One to load');

  // Choose Curl in paginated spread mode first so we verify scrolled toggles preserve it.
  await selectPageTurn(page, 'Curl', { customize: true });

  await page.clickButton('Scroll');
  await page.waitFor(`${visibleEpubViewer}?.dataset.readingMode === 'scroll'`, 'EPUB Scroll mode');
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `${visibleEpubHost}?.querySelector('.epub-container') && ${visibleEpubHost}?.querySelector('iframe')?.contentDocument?.body?.innerText?.trim()?.length > 0`,
    'EPUB Scroll chapter content to settle',
  );

  // Scrolled EPUB must not mount edge chevrons.
  assert(
    !(await page.evaluate(
      `[...document.querySelectorAll('[data-testid="page-turn-next"], [data-testid="page-turn-previous"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    )),
    'EPUB Scroll must not render visible edge page-turn chevrons',
  );

  // Appearance popover in EPUB Scroll must offer strictly None & Fade (default Fade from Curl).
  const epubScrollOptions = await readPageTurnOptions(page, { customize: true });
  assert(
    epubScrollOptions.length === 2 &&
      epubScrollOptions[0].label === 'None' &&
      epubScrollOptions[1].label === 'Fade' &&
      epubScrollOptions[1].checked,
    `EPUB Scroll Page turn must offer only None/Fade with Fade active (got ${JSON.stringify(epubScrollOptions)})`,
  );

  // Switching to None in Scroll mode must preserve Curl when returning to paginated mode.
  await selectPageTurn(page, 'None', { customize: true });
  await page.clickButton('Two pages');
  await page.waitFor(`${visibleEpubViewer}?.dataset.readingMode === 'spread'`, 'back to Two pages');
  const epubPaginatedOptions = await readPageTurnOptions(page, { customize: true });
  assert(
    epubPaginatedOptions.some((o) => o.label === 'Curl' && o.checked),
    `Toggling None in EPUB Scroll must preserve paginated Curl preference (got ${JSON.stringify(epubPaginatedOptions)})`,
  );

  await page.clickButton('Scroll');
  await page.waitFor(
    `${visibleEpubViewer}?.dataset.readingMode === 'scroll'`,
    'back to EPUB Scroll',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollHeight ?? 0) > (${visibleEpubHost}?.querySelector('.epub-container')?.clientHeight ?? 0)`,
    'scrollable EPUB chapter content',
  );

  // Explicit turn under None runs immediately without fade animation.
  await page.evaluate(
    `(() => { const s = ${visibleEpubHost}?.querySelector('.epub-container'); if (s) s.scrollTop = 0; })()`,
  );
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press(' ', 'Space');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) > 0`,
    'Space under None to advance in EPUB Scroll',
  );
  assertNoFade(await finishFadeProbe(page), 'EPUB Scroll explicit turn under None');

  // Switch back to Fade for fade + overlap tests, reset to top of Chapter One.
  await selectPageTurn(page, 'Fade', { customize: true });
  await page.evaluate(
    `(() => { const s = ${visibleEpubHost}?.querySelector('.epub-container'); if (s) s.scrollTop = 0; })()`,
  );
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? -1) === 0`,
    'EPUB Scroll at top of Chapter One',
  );

  // Document start boundary no-op: no scroll and no fade.
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press('ArrowLeft');
  const epubStartNoOp = await finishFadeProbe(page);
  assert(
    (await page.evaluate(
      `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? -1) === 0`,
    )) && (await page.evaluate(chapterIs('Chapter One'))),
    'ArrowLeft at EPUB Scroll start boundary stays at top of Chapter One',
  );
  assertNoFade(epubStartNoOp, 'EPUB Scroll start boundary no-op');

  // Forward reading-continuity overlap: straddling bottom line becomes completely visible.
  const epubFwdTarget = await setupEpubScrollLineStraddle(page, 'bottom');
  assert(epubFwdTarget !== null, 'expected a text line to straddle bottom edge in EPUB Scroll');
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press('ArrowRight');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) > ${epubFwdTarget.scrollTop}`,
    'ArrowRight to step EPUB Scroll forward',
  );
  assertFadePlayed(await finishFadeProbe(page), 'EPUB Scroll ArrowRight');
  const epubFwdCheck = await checkEpubLineVisible(page, epubFwdTarget);
  assert(
    epubFwdCheck?.fullyVisible,
    `EPUB Scroll forward overlap must keep bottom-straddling line visible (${JSON.stringify(epubFwdCheck)})`,
  );

  // Backward reading-continuity overlap: straddling top line becomes completely visible.
  const epubBackTarget = await setupEpubScrollLineStraddle(page, 'top');
  assert(epubBackTarget !== null, 'expected a text line to straddle top edge in EPUB Scroll');
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press('ArrowLeft');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) < ${epubBackTarget.scrollTop}`,
    'ArrowLeft to step EPUB Scroll backward',
  );
  assertFadePlayed(await finishFadeProbe(page), 'EPUB Scroll ArrowLeft');
  const epubBackCheck = await checkEpubLineVisible(page, epubBackTarget);
  assert(
    epubBackCheck?.fullyVisible,
    `EPUB Scroll backward overlap must keep top-straddling line visible (${JSON.stringify(epubBackCheck)})`,
  );

  // Progress scrubber ArrowRight performs an explicit turn with fade.
  const preScrubTop = await page.evaluate(
    `${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0`,
  );
  await page.evaluate(`document.querySelector('[data-testid="progress-scrubber"]')?.focus()`);
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press('ArrowRight');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) !== ${preScrubTop}`,
    'scrubber ArrowRight in EPUB Scroll',
  );
  assertFadePlayed(await finishFadeProbe(page), 'EPUB Scroll scrubber ArrowRight');
  await page.evaluate(`document.activeElement?.blur?.()`);

  // TOC jump lands directly without triggering page-turn fade, then return cleanly.
  await page.showSidebarTab('Table of Contents');
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.clickTreeItem('Two');
  await page.waitFor(chapterIs('Chapter Two'), 'TOC jump to Chapter Two');
  assertNoFade(await finishFadeProbe(page), 'EPUB Scroll TOC jump');
  await page.clickTreeItem('One');
  await page.waitFor(chapterIs('Chapter One'), 'TOC jump back to Chapter One');
  await page.hideSidebar();
  await page.evaluate(`document.activeElement?.blur?.()`);

  // EPUB Scroll chapter seam forward (bottom of Chapter One -> top of Chapter Two with fade).
  await page.evaluate(`(() => {
    const s = ${visibleEpubHost}?.querySelector('.epub-container');
    if (s) s.scrollTop = s.scrollHeight - s.clientHeight;
  })()`);
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press(' ', 'Space');
  await page.waitFor(
    chapterIs('Chapter Two'),
    'Space at bottom of Chapter One crosses to Chapter Two',
  );
  assertFadePlayed(await finishFadeProbe(page), 'EPUB Scroll forward chapter seam');
  assert(
    await page.evaluate(
      `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? -1) === 0`,
    ),
    'forward chapter seam in EPUB Scroll lands at top (scrollTop === 0) of Chapter Two',
  );

  // EPUB Scroll chapter seam backward (top of Chapter Two -> bottom of Chapter One with fade).
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press(' ', 'Space', SHIFT);
  await page.waitFor(
    chapterIs('Chapter One'),
    'Shift+Space at top of Chapter Two crosses back to Chapter One',
  );
  assertFadePlayed(await finishFadeProbe(page), 'EPUB Scroll backward chapter seam');
  const backSeamPos = await page.evaluate(`(() => {
    const s = ${visibleEpubHost}?.querySelector('.epub-container');
    return s ? { scrollTop: s.scrollTop, clientHeight: s.clientHeight, scrollHeight: s.scrollHeight } : null;
  })()`);
  assert(
    backSeamPos &&
      backSeamPos.scrollTop > 0 &&
      backSeamPos.scrollTop + backSeamPos.clientHeight >= backSeamPos.scrollHeight - 4,
    `backward chapter seam in EPUB Scroll must land at the bottom of Chapter One (${JSON.stringify(backSeamPos)})`,
  );

  // Return to Chapter Two bottom -> document end boundary no-op without fade.
  await page.evaluate(`(() => {
    const s = ${visibleEpubHost}?.querySelector('.epub-container');
    if (s) s.scrollTop = s.scrollHeight - s.clientHeight;
  })()`);
  await page.press(' ', 'Space');
  await page.waitFor(chapterIs('Chapter Two'), 'return to Chapter Two');
  await page.evaluate(`(() => {
    const s = ${visibleEpubHost}?.querySelector('.epub-container');
    if (s) s.scrollTop = s.scrollHeight - s.clientHeight;
  })()`);
  await new Promise((done) => setTimeout(done, 80));
  const endMetrics = await page.evaluate(`(() => {
    const s = ${visibleEpubHost}?.querySelector('.epub-container');
    return s ? { scrollTop: s.scrollTop, rect: (() => { const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })() } : null;
  })()`);
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press('PageDown');
  assertNoFade(await finishFadeProbe(page), 'EPUB Scroll end boundary no-op');
  assert(
    (await page.evaluate(
      `Math.abs((${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) - ${endMetrics.scrollTop}) <= 2`,
    )) && (await page.evaluate(chapterIs('Chapter Two'))),
    'PageDown at end of EPUB stays on last chapter bottom',
  );

  // Normal wheel scrolling in EPUB Scroll moves without fade.
  await page.evaluate(
    `(() => { const s = ${visibleEpubHost}?.querySelector('.epub-container'); if (s) s.scrollTop = 0; })()`,
  );
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.wheel(endMetrics.rect, 220);
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) > 0`,
    'wheel scroll in EPUB Scroll',
  );
  assertNoFade(await finishFadeProbe(page), 'EPUB Scroll normal wheel scroll');

  // Reduced motion disables fade in EPUB Scroll while still stepping cleanly.
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const beforeReducedEpub = await page.evaluate(
    `${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0`,
  );
  await armFadeProbe(page, `[${visibleEpubHost}]`);
  await page.press(' ', 'Space');
  await page.waitFor(
    `(${visibleEpubHost}?.querySelector('.epub-container')?.scrollTop ?? 0) > ${beforeReducedEpub}`,
    'EPUB Scroll Space under reduced motion',
  );
  assertNoFade(await finishFadeProbe(page), 'EPUB Scroll turn under prefers-reduced-motion');
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // =========================================================================
  // 2. PDF Continuous (#103)
  // =========================================================================
  await page.openUntil(`${visiblePdfViewer} && ${titleIs('sample')}`, 'the sample PDF');
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(`${visiblePdfViewer}?.dataset.displayMode === 'single'`, 'PDF Single page');
  await page.evaluate(`document.activeElement?.blur?.()`);
  await selectPageTurn(page, 'Curl', { customize: false });

  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-continuous"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'continuous'`,
    'PDF Continuous mode',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.clickButton('Fit width');
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.zoomMode === 'fit-width'`,
    'PDF Continuous Fit width',
  );
  await page.clickButton('Zoom in');
  await page.waitFor(
    `(${visiblePdfScroll}?.querySelector('[data-page-index="0"]')?.getBoundingClientRect().height ?? 0) > (${visiblePdfScroll}?.clientHeight ?? 0) * 1.2`,
    'PDF Continuous zoomed so page 1 overflows tall',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `${visiblePdfScroll}?.querySelectorAll('.textLayer span')?.length > 0`,
    'PDF Continuous textLayer spans',
  );

  // Continuous PDF must not show edge chevrons.
  assert(
    !(await page.evaluate(
      `[...document.querySelectorAll('[data-testid="page-turn-next"], [data-testid="page-turn-previous"]')].some((e) => e.checkVisibility({ visibilityProperty: true }))`,
    )),
    'PDF Continuous must not render visible edge page-turn chevrons',
  );

  // Appearance popover in PDF Continuous offers ONLY None and Fade (with Fade active from Curl).
  const pdfContOptions = await readPageTurnOptions(page, { customize: false });
  assert(
    pdfContOptions.length === 2 &&
      pdfContOptions[0].label === 'None' &&
      pdfContOptions[1].label === 'Fade' &&
      pdfContOptions[1].checked,
    `PDF Continuous Page turn must offer only None/Fade with Fade active (got ${JSON.stringify(pdfContOptions)})`,
  );

  // Selecting None in Continuous preserves Curl when switching back to Single page.
  await selectPageTurn(page, 'None', { customize: false });
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'single'`,
    'back to PDF Single page',
  );
  const pdfSingleOptions = await readPageTurnOptions(page, { customize: false });
  assert(
    pdfSingleOptions.some((o) => o.label === 'Curl' && o.checked),
    `Toggling None in PDF Continuous must preserve paginated Curl preference (got ${JSON.stringify(pdfSingleOptions)})`,
  );

  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-continuous"]').click()`,
  );
  await page.waitFor(
    `${visiblePdfViewer}?.dataset.displayMode === 'continuous'`,
    'back to PDF Continuous',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollHeight ?? 0) > (${visiblePdfScroll}?.clientHeight ?? 0)`,
    'PDF Continuous scrollable height',
  );

  // Explicit turn under None runs without fade.
  const pdfRowTargets = `[...(${visiblePdfScroll}?.querySelectorAll('[data-continuous-row]') ?? [])]`;
  await page.evaluate(`(() => { const s = ${visiblePdfScroll}; if (s) s.scrollTop = 0; })()`);
  await armFadeProbe(page, pdfRowTargets);
  await page.press(' ', 'Space');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > 0`,
    'Space under None in PDF Continuous',
  );
  assertNoFade(await finishFadeProbe(page), 'PDF Continuous explicit turn under None');

  // Switch back to Fade and reset to top.
  await selectPageTurn(page, 'Fade', { customize: false });
  await page.evaluate(`(() => { const s = ${visiblePdfScroll}; if (s) s.scrollTop = 0; })()`);
  await page.waitFor(`(${visiblePdfScroll}?.scrollTop ?? -1) === 0`, 'PDF Continuous back at top');

  // Start boundary no-op without fade.
  await armFadeProbe(page, pdfRowTargets);
  await page.press('ArrowLeft');
  assertNoFade(await finishFadeProbe(page), 'PDF Continuous start boundary no-op');
  assert(
    (await page.evaluate(`(${visiblePdfScroll}?.scrollTop ?? -1) === 0`)) &&
      (await page.evaluate(`${pdfPageField}?.value === '1'`)),
    'ArrowLeft at PDF Continuous start keeps scrollTop === 0 on page 1',
  );

  // Line-straddling overlap forward (PageDown) with fade.
  const pdfFwdTarget = await setupPdfScrollLineStraddle(page, 'bottom');
  assert(
    pdfFwdTarget !== null,
    'expected a textLayer span to straddle bottom edge in PDF Continuous',
  );
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, pdfRowTargets);
  await page.press('PageDown');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > ${pdfFwdTarget.scrollTop}`,
    'PageDown to advance PDF Continuous',
  );
  assertFadePlayed(await finishFadeProbe(page), 'PDF Continuous PageDown');
  const pdfFwdCheck = await checkPdfLineVisible(page, pdfFwdTarget);
  assert(
    pdfFwdCheck?.fullyVisible,
    `PDF Continuous forward overlap must keep bottom-straddling span visible (${JSON.stringify(pdfFwdCheck)})`,
  );

  // Line-straddling overlap backward (PageUp) with fade.
  const pdfBackTarget = await setupPdfScrollLineStraddle(page, 'top');
  assert(
    pdfBackTarget !== null,
    'expected a textLayer span to straddle top edge in PDF Continuous',
  );
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, pdfRowTargets);
  await page.press('PageUp');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) < ${pdfBackTarget.scrollTop}`,
    'PageUp to step back in PDF Continuous',
  );
  assertFadePlayed(await finishFadeProbe(page), 'PDF Continuous PageUp');
  const pdfBackCheck = await checkPdfLineVisible(page, pdfBackTarget);
  assert(
    pdfBackCheck?.fullyVisible,
    `PDF Continuous backward overlap must keep top-straddling span visible (${JSON.stringify(pdfBackCheck)})`,
  );

  // Scrubber ArrowRight performs explicit turn with fade.
  const prePdfScrub = await page.evaluate(`${visiblePdfScroll}?.scrollTop ?? 0`);
  await page.evaluate(`document.querySelector('[data-testid="progress-scrubber"]')?.focus()`);
  await armFadeProbe(page, pdfRowTargets);
  await page.press('ArrowRight');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > ${prePdfScrub}`,
    'scrubber ArrowRight in PDF Continuous',
  );
  assertFadePlayed(await finishFadeProbe(page), 'PDF Continuous scrubber ArrowRight');
  await page.evaluate(`document.activeElement?.blur?.()`);

  // Normal wheel scroll in PDF Continuous does not trigger fade.
  const pdfCenter = await page.evaluate(`(() => {
    const r = ${visiblePdfScroll}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const beforeWheelPdf = await page.evaluate(`${visiblePdfScroll}?.scrollTop ?? 0`);
  await armFadeProbe(page, pdfRowTargets);
  await page.wheel(pdfCenter, 220);
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) > ${beforeWheelPdf}`,
    'normal wheel scroll in PDF Continuous',
  );
  assertNoFade(await finishFadeProbe(page), 'PDF Continuous normal wheel scroll');

  // End boundary no-op without fade.
  await page.evaluate(`(() => {
    const s = ${visiblePdfScroll};
    if (s) s.scrollTop = s.scrollHeight - s.clientHeight;
  })()`);
  await new Promise((done) => setTimeout(done, 120));
  const pdfEndTop = await page.evaluate(`${visiblePdfScroll}?.scrollTop ?? 0`);
  await armFadeProbe(page, pdfRowTargets);
  await page.press('ArrowRight');
  assertNoFade(await finishFadeProbe(page), 'PDF Continuous end boundary no-op');
  assert(
    await page.evaluate(`Math.abs((${visiblePdfScroll}?.scrollTop ?? 0) - ${pdfEndTop}) <= 2`),
    'ArrowRight at bottom of PDF Continuous stays at end boundary',
  );

  // Reduced motion disables fade in PDF Continuous.
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const pdfBeforeReduced = await page.evaluate(`${visiblePdfScroll}?.scrollTop ?? 0`);
  await armFadeProbe(page, pdfRowTargets);
  await page.press('ArrowLeft');
  await page.waitFor(
    `(${visiblePdfScroll}?.scrollTop ?? 0) < ${pdfBeforeReduced}`,
    'PDF Continuous ArrowLeft under reduced motion',
  );
  assertNoFade(await finishFadeProbe(page), 'PDF Continuous turn under prefers-reduced-motion');
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // =========================================================================
  // 3. TXT (#103): chevrons, edge clicks, scrubber, overlap, GoTo, reduced motion
  // =========================================================================
  const txtPayload = Array.from(
    { length: 140 },
    (_, i) =>
      `Scroll overlap line ${String(i + 1).padStart(3, '0')}: steady reading measure anchor check.`,
  ).join('\n\n');
  await dropTextFile(page, txtPayload, 'scroll-paging-test.txt');
  await page.waitFor(
    `${visibleTxtScroll} && ${titleIs('scroll-paging-test')}`,
    'dropped multi-page TXT document',
  );
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollHeight ?? 0) > (${visibleTxtScroll}?.clientHeight ?? 0) * 2`,
    'dropped TXT to span multiple viewports',
  );

  await selectPageTurn(page, 'Fade', { customize: true });
  const txtFadeTarget = `[${visibleTxtScroll}?.querySelector('[role="document"]')]`;

  // Start boundary no-op in TXT without fade.
  await page.evaluate(`(() => { const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`);
  await armFadeProbe(page, txtFadeTarget);
  await page.press('ArrowLeft');
  assertNoFade(await finishFadeProbe(page), 'TXT start boundary no-op');
  assert(
    await page.evaluate(`(${visibleTxtScroll}?.scrollTop ?? -1) === 0`),
    'ArrowLeft at TXT start stays at scrollTop === 0',
  );

  // Chevrons (`Next Page` / `Previous Page`) perform explicit turns with fade.
  await armFadeProbe(page, txtFadeTarget);
  await page.clickButton('Next Page');
  await page.waitFor(`(${visibleTxtScroll}?.scrollTop ?? 0) > 0`, 'TXT Next Page chevron advances');
  assertFadePlayed(await finishFadeProbe(page), 'TXT Next Page chevron');
  const txtAfterNextChevron = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);

  await armFadeProbe(page, txtFadeTarget);
  await page.clickButton('Previous Page');
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? ${txtAfterNextChevron}) < ${txtAfterNextChevron}`,
    'TXT Previous Page chevron steps back',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT Previous Page chevron');
  await page.evaluate(
    `(() => { document.activeElement?.blur?.(); const s = ${visibleTxtScroll}; if (s) s.scrollTop = 0; })()`,
  );
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? -1) === 0`,
    'TXT reset to top for edge click',
  );

  // Blank edge clicks (bottom-corner outer margins away from centered chevrons) turn with fade.
  const txtMargins = await page.evaluate(`(() => {
    const r = ${visibleTxtScroll}.getBoundingClientRect();
    return {
      right: { x: Math.round(r.right - 20), y: Math.round(r.top + r.height - 40) },
      left: { x: Math.round(r.left + 20), y: Math.round(r.top + r.height - 40) },
      center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    };
  })()`);
  await armFadeProbe(page, txtFadeTarget);
  await page.click(txtMargins.right);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > 0`,
    'TXT right-edge blank click advances',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT blank right-edge click');
  const txtAfterRightEdge = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);

  await armFadeProbe(page, txtFadeTarget);
  await page.click(txtMargins.left);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? ${txtAfterRightEdge}) < ${txtAfterRightEdge}`,
    'TXT left-edge blank click steps back',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT blank left-edge click');

  // Line-straddling overlap forward & backward in TXT.
  const txtFwdTarget = await setupTxtLineStraddle(page, 'bottom');
  assert(txtFwdTarget !== null, 'expected a row to straddle bottom edge in TXT');
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, txtFadeTarget);
  await page.press(' ', 'Space');
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > ${txtFwdTarget.scrollTop}`,
    'Space to step TXT forward',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT Space forward turn');
  const txtFwdCheck = await checkTxtLineVisible(page, txtFwdTarget);
  assert(
    txtFwdCheck?.fullyVisible,
    `TXT forward overlap must keep bottom-straddling line visible (${JSON.stringify(txtFwdCheck)})`,
  );

  const txtBackTarget = await setupTxtLineStraddle(page, 'top');
  assert(txtBackTarget !== null, 'expected a row to straddle top edge in TXT');
  await new Promise((done) => setTimeout(done, 80));
  await armFadeProbe(page, txtFadeTarget);
  await page.press(' ', 'Space', SHIFT);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) < ${txtBackTarget.scrollTop}`,
    'Shift+Space to step TXT backward',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT Shift+Space backward turn');
  const txtBackCheck = await checkTxtLineVisible(page, txtBackTarget);
  assert(
    txtBackCheck?.fullyVisible,
    `TXT backward overlap must keep top-straddling line visible (${JSON.stringify(txtBackCheck)})`,
  );

  // Scrubber ArrowRight in TXT plays fade; GoTo jump (`⌥⌘G`) jumps directly without fade.
  const preTxtScrub = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);
  await page.evaluate(`document.querySelector('[data-testid="progress-scrubber"]')?.focus()`);
  await armFadeProbe(page, txtFadeTarget);
  await page.press('ArrowRight');
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > ${preTxtScrub}`,
    'scrubber ArrowRight in TXT',
  );
  assertFadePlayed(await finishFadeProbe(page), 'TXT scrubber ArrowRight');
  await page.evaluate(`document.activeElement?.blur?.()`);

  await page.press('g', 'KeyG', ALT | META);
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="unified-toolbar"] [data-testid="go-to-input"]')`,
    '⌥⌘G focuses TXT GoTo box',
  );
  await page.typeText('60');
  await armFadeProbe(page, txtFadeTarget);
  await page.press('Enter');
  await page.waitFor(
    `document.activeElement === ${visibleTxtScroll} && (${visibleTxtScroll}?.scrollTop ?? 0) > ${preTxtScrub}`,
    'GoTo Return jumps TXT without fade',
  );
  assertNoFade(await finishFadeProbe(page), 'TXT GoTo jump');

  // Normal wheel scroll in TXT does not fade.
  const beforeWheelTxt = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);
  await armFadeProbe(page, txtFadeTarget);
  await page.wheel(txtMargins.center, 220);
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) > ${beforeWheelTxt}`,
    'normal wheel in TXT',
  );
  assertNoFade(await finishFadeProbe(page), 'TXT normal wheel scroll');

  // Document end boundary no-op without fade.
  await page.press('End');
  await page.waitFor(
    `(() => { const s = ${visibleTxtScroll}; return s && s.scrollTop + s.clientHeight >= s.scrollHeight - 4; })()`,
    'End jumps to bottom of TXT',
  );
  const txtEndTop = await page.evaluate(`${visibleTxtScroll}?.scrollTop ?? 0`);
  await armFadeProbe(page, txtFadeTarget);
  await page.press('ArrowRight');
  assertNoFade(await finishFadeProbe(page), 'TXT end boundary no-op');
  assert(
    await page.evaluate(`Math.abs((${visibleTxtScroll}?.scrollTop ?? 0) - ${txtEndTop}) <= 2`),
    'ArrowRight at bottom of TXT stays at end boundary',
  );

  // Reduced motion disables fade in TXT.
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await armFadeProbe(page, txtFadeTarget);
  await page.press('ArrowLeft');
  await page.waitFor(
    `(${visibleTxtScroll}?.scrollTop ?? 0) < ${txtEndTop}`,
    'TXT ArrowLeft under reduced motion',
  );
  assertNoFade(await finishFadeProbe(page), 'TXT turn under prefers-reduced-motion');
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
}
