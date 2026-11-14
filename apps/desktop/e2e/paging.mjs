// `#86`: page turns are continuous, and a trackpad swipe scrubs the page it is on.
//
// The assertions are about motion, not pixels: a turn has to move the page over
// several frames with both pages at full opacity, a swipe has to follow the fingers
// before it commits, and nothing may be left transformed once it settles.

import { assert } from './harness.mjs';

const visibleHost = `[...document.querySelectorAll('[data-testid="epub-host"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const strip = `${visibleHost}?.querySelector('.epub-container')`;
// Parenthesised: templates are pasted into larger expressions, and `??` may not
// sit beside `&&` without them.
const scrollLeft = `(${strip}?.scrollLeft ?? 0)`;
const visibleScroller = `[...document.querySelectorAll('[data-testid="pdf-scroll"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const sampleTitle = `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === 'sample'`;
const openEpub = (page) => page.openUntil(`${visibleHost} && ${sampleTitle}`, 'the EPUB');
const pageField = `document.querySelector('[data-testid="unified-toolbar"] input[aria-label="Page number"]')?.value`;

/** Clears the selection an earlier excerpt left, which would swallow the click. */
const clearFrameSelection = `(() => {
  ${visibleHost}?.querySelector('iframe')?.contentDocument?.getSelection()?.removeAllRanges();
  return true;
})()`;

/**
 * Records the strip and the page's opacity every frame for `frames` frames, so a
 * turn can be asked whether it moved gradually and whether it ever dimmed.
 */
const sampleTurn = (page, { frames = 40, target = 'epub' } = {}) => {
  const element =
    target === 'epub' ? strip : `${visibleScroller}?.querySelector('[data-testid="pdf-stage"]')`;
  const host = target === 'epub' ? visibleHost : visibleScroller;
  return page.evaluate(`(() => {
    const element = ${element};
    const host = ${host};
    window.__turnSamples = [];
    let frames = 0;
    const step = () => {
      window.__turnSamples.push({
        position: Math.round(element?.scrollLeft ?? 0),
        // The computed transform, so a Web Animation's frames are visible here.
        transform: element ? getComputedStyle(element).transform : '',
        opacity: host ? Number(getComputedStyle(host).opacity) : 1,
      });
      frames += 1;
      if (frames < ${frames}) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
};

const turnSamples = (page) => page.evaluate('window.__turnSamples');
/** How many distinct positions the samples hold: more than two means it glided. */
const distinctPositions = (samples) => new Set(samples.map((sample) => sample.position)).size;

const REDUCED = [{ name: 'prefers-reduced-motion', value: 'reduce' }];
const ANIMATED = [{ name: 'prefers-reduced-motion', value: 'no-preference' }];

export async function pagingFlow(page) {
  // A CI runner may have "Reduce motion" switched on, and this flow is about the
  // motion itself: ask for it explicitly, and check the reduced path separately.
  await page.emulateMedia(ANIMATED);
  await page.clickButton('Show MindMap');
  await page.clickButton('Show inspector');
  await openEpub(page);
  await page.waitForReaderLayout();

  // ---- An EPUB page turn moves the strip, and never dims the paper ----
  const edge = await page.evaluate(`(() => {
    const r = ${visibleHost}.getBoundingClientRect();
    return { x: r.right - 6, y: r.top + r.height - 12 };
  })()`);
  await page.evaluate(clearFrameSelection);
  const before = await page.evaluate(scrollLeft);
  await sampleTurn(page);
  await page.click(edge);
  await page.waitFor(`${scrollLeft} > ${before}`, 'the strip to start moving');
  // The slide is eased, so it is still travelling for a few frames after it starts.
  await new Promise((done) => setTimeout(done, 600));
  const turn = await turnSamples(page);
  assert(
    distinctPositions(turn) > 3,
    `a slide has to travel over several frames, saw ${distinctPositions(turn)} positions`,
  );
  assert(
    turn.every((sample) => sample.opacity === 1),
    'the page must never dim during a turn',
  );
  // Nothing is left behind: no transform, and the strip is where the turn put it.
  const settled = await page.evaluate(`(() => {
    const host = ${visibleHost};
    return { transform: getComputedStyle(host).transform, left: ${scrollLeft} };
  })()`);
  assert(settled.transform === 'none', `the page must not stay transformed: ${settled.transform}`);
  assert(settled.left > before, 'the turn must move to the next page');

  // ---- With reduced motion a turn is instantaneous ----
  await page.emulateMedia(REDUCED);
  const beforeReduced = await page.evaluate(scrollLeft);
  await sampleTurn(page, { frames: 20 });
  await page.click(edge);
  await page.waitFor(`${scrollLeft} > ${beforeReduced}`, 'the reduced-motion turn');
  await new Promise((done) => setTimeout(done, 300));
  const reduced = await turnSamples(page);
  assert(
    distinctPositions(reduced) <= 2,
    `reduced motion must turn at once, saw ${distinctPositions(reduced)} positions`,
  );
  await page.emulateMedia(ANIMATED);

  // ---- A two-finger swipe scrubs the strip, then commits ----
  const pageBox = await page.evaluate(`(() => {
    const r = ${visibleHost}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const beforeSwipe = await page.evaluate(scrollLeft);
  // Fingers moving right scroll the strip forward, and each event must move it.
  await page.swipe(pageBox, 20, { steps: 6, gapMs: 16 });
  const scrubbed = await page.evaluate(scrollLeft);
  assert(
    scrubbed > beforeSwipe + 40,
    `a swipe must scrub the strip with the fingers: ${beforeSwipe} → ${scrubbed}`,
  );
  // The release is only known once the wheel has been quiet, and the strip then
  // settles on a whole page rather than where the fingers happened to stop.
  await page.waitFor(
    `(() => {
      const container = ${strip};
      const delta = container?.clientWidth ?? 0;
      const left = container?.scrollLeft ?? 0;
      return delta > 0 && Math.abs(left % delta) < 2 && left > ${beforeSwipe};
    })()`,
    'the swipe to settle on a page boundary',
  );

  // ---- A PDF page turn slides the staged spread, with the next one already drawn ----
  await page.openUntil(`${visibleScroller} && ${sampleTitle}`, 'the PDF');
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-single"]').click()`,
  );
  await page.waitFor(
    `(() => {
      const pages = [...${visibleScroller}.querySelectorAll('[data-page-index]')]
        .map((p) => p.dataset.pageIndex);
      return document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'single'
        && pages.includes('0') && pages.includes('1');
    })()`,
    'the single-page stage, with the next page already staged',
  );
  await sampleTurn(page, { target: 'pdf' });
  await page.clickButton('Next Page');
  await page.waitFor(`${pageField} === '2'`, 'the turn to land on page 2');
  const slides = await turnSamples(page);
  const transforms = new Set(
    slides.map((sample) => sample.transform).filter((value) => value !== 'none'),
  );
  assert(
    transforms.size > 2,
    `the staged spread has to slide, saw ${transforms.size} transform values`,
  );
  assert(
    slides.every((sample) => sample.opacity === 1),
    'the PDF page must never dim during a turn',
  );
  const stage = await page.evaluate(`(() => {
    const element = ${visibleScroller}?.querySelector('[data-testid="pdf-stage"]');
    const pages = [...${visibleScroller}.querySelectorAll('[data-page-index]')]
      .map((p) => p.dataset.pageIndex);
    return { transform: element?.style.transform ?? '', pages };
  })()`);
  assert(stage.transform === '', `the stage must not stay transformed: ${stage.transform}`);
  assert(
    stage.pages.length <= 3,
    `a paged stage keeps at most three spreads live, saw ${stage.pages.length} pages`,
  );
}
