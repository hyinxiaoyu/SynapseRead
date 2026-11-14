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
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="true"]').dataset.e2e = 'paging-epub'`,
  );

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

  // ---- A two-finger swipe scrubs the strip 1:1, then commits ----
  const beforeSwipe = await page.evaluate(scrollLeft);
  // Six events in one task, as one flick: a DevTools round trip between them can
  // outlast the idle window on a slow runner and split the flick into several
  // gestures, each of which springs back before the next one starts.
  await page.evaluate(`(() => {
    const target = ${visibleHost};
    for (let step = 0; step < 6; step += 1) {
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 20, deltaY: 0, bubbles: true, cancelable: true }),
      );
    }
    return true;
  })()`);
  const scrubbed = await page.evaluate(scrollLeft);
  assert(
    scrubbed >= beforeSwipe + 100,
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

  // ---- With reduced motion a turn is instantaneous ----
  const leftEdge = await page.evaluate(`(() => {
    const r = ${visibleHost}.getBoundingClientRect();
    return { x: r.left + 6, y: r.top + r.height - 12 };
  })()`);
  await page.emulateMedia(REDUCED);
  const beforeReduced = await page.evaluate(scrollLeft);
  await sampleTurn(page, { frames: 20 });
  // Turn back, so the reduced-motion check has a page to reach either way.
  await page.click(leftEdge);
  await page.waitFor(`${scrollLeft} < ${beforeReduced}`, 'the reduced-motion turn');
  await new Promise((done) => setTimeout(done, 300));
  const reduced = await turnSamples(page);
  assert(
    distinctPositions(reduced) <= 2,
    `reduced motion must turn at once, saw ${distinctPositions(reduced)} positions`,
  );
  await page.emulateMedia(ANIMATED);

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

  // ---- A spread's curl: the fold on the turning half, the cast shadow on the
  // half that stays put, each confined to its own side of the spine ----
  await page.evaluate(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="pdf-mode-two-page"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="pdf-viewer"]')?.dataset.displayMode === 'two-page'`,
    'two pages, so a curl has a spine to hinge on',
  );
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'the PDF appearance popover',
  );
  await page.clickButton('Curl');
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'the appearance popover to close',
  );

  await page.evaluate(`(() => {
    // The EPUB tab is still open behind this one, so name the visible viewer's shadow.
    const viewer = [...document.querySelectorAll('[data-testid="pdf-viewer"]')]
      .find((element) => element.checkVisibility({ visibilityProperty: true }));
    const shadow = viewer?.querySelector('[data-testid="page-turn-shadow"]');
    const part = (name) => shadow?.querySelector('[data-curl-part="' + name + '"]');
    const stage = viewer?.querySelector('[data-testid="pdf-stage"]');
    window.__curlSamples = [];
    let frames = 0;
    const step = () => {
      const leaf = part('leaf');
      const cast = part('cast-shadow');
      const under = part('under-shadow');
      const spine = part('spine');
      const slots = [...(stage?.querySelectorAll('[data-stage-row]') ?? [])];
      const clippedSlot = slots.find((slot) => getComputedStyle(slot).clipPath !== 'none');
      const outgoingUnclippedOnTop = slots.some(
        (slot) => slot.style.zIndex === '2' && getComputedStyle(slot).clipPath === 'none',
      );
      window.__curlSamples.push({
        leaf: leaf ? Number(getComputedStyle(leaf).opacity) : 0,
        cast: cast ? Number(getComputedStyle(cast).opacity) : 0,
        under: under ? Number(getComputedStyle(under).opacity) : 0,
        spine: spine ? Number(getComputedStyle(spine).opacity) : 0,
        leafClip: leaf ? getComputedStyle(leaf).clipPath : 'none',
        slotClip: clippedSlot ? getComputedStyle(clippedSlot).clipPath : 'none',
        outgoingUnclippedOnTop,
        stageTransform: stage ? getComputedStyle(stage).transform : 'none',
      });
      frames += 1;
      if (frames < 40) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
  await page.clickButton('Next Page');
  await new Promise((done) => setTimeout(done, 700));
  const curl = await page.evaluate('window.__curlSamples');
  assert(
    curl.some((sample) => sample.leaf > 0.5),
    'the conical paper backside leaf must light up while curling',
  );
  assert(
    curl.some((sample) => sample.cast > 0.15),
    'the revealed incoming spread must catch the cast shadow',
  );
  assert(
    curl.some((sample) => sample.under > 0.1),
    'the outgoing spread must show under-edge ambient occlusion',
  );
  assert(
    curl.some((sample) => sample.spine > 0.15),
    'a two-page curl must shade the center binding spine valley',
  );
  assert(
    curl.every((sample) => sample.stageTransform === 'none'),
    'the PDF stage must stay stationary (zero slide/rotateY) during a paper curl',
  );
  const firstClippedIndex = curl.findIndex((sample) => sample.slotClip !== 'none');
  assert(firstClippedIndex >= 0, 'the curl turn must clip the outgoing PDF slot');
  assert(
    curl.slice(firstClippedIndex).every((sample) => !sample.outgoingUnclippedOnTop),
    'once peeling begins, the top outgoing PDF slot must stay clipped until settled',
  );
  const curling = curl.filter((sample) => sample.leaf > 0.1);
  assert(curling.length > 0, 'the curl turn has to be active for at least a frame');
  assert(
    curling.every((sample) => sample.slotClip !== 'none' && sample.leafClip !== 'none'),
    'both the outgoing slot and folded leaf must stay clipped while curling',
  );
  const slotOutlines = new Set(curling.map((sample) => sample.slotClip));
  const leafOutlines = new Set(curling.map((sample) => sample.leafClip));
  assert(
    slotOutlines.size > 3,
    `the outgoing slot crease must sweep over several frames, saw ${slotOutlines.size} shapes`,
  );
  assert(
    leafOutlines.size > 3,
    `the conical backside leaf must reshape over several frames, saw ${leafOutlines.size} shapes`,
  );
  const settledCurl = curl.at(-1);
  assert(
    settledCurl.leaf === 0 &&
      settledCurl.cast === 0 &&
      settledCurl.under === 0 &&
      settledCurl.spine === 0,
    `all four curl layers must settle to 0 opacity: ${JSON.stringify(settledCurl)}`,
  );
  const afterCurl = await page.evaluate(`(() => {
    const stage = ${visibleScroller}?.querySelector('[data-testid="pdf-stage"]');
    const content = stage?.parentElement;
    const slots = [...(stage?.querySelectorAll('[data-stage-row]') ?? [])];
    return {
      stageTransform: stage ? getComputedStyle(stage).transform : 'none',
      contentTransform: content ? getComputedStyle(content).transform : 'none',
      contentClipPath: content ? getComputedStyle(content).clipPath : 'none',
      anySlotClipped: slots.some((slot) => getComputedStyle(slot).clipPath !== 'none'),
      anySlotTransformed: slots.some((slot) => getComputedStyle(slot).transform !== 'none'),
    };
  })()`);
  assert(
    afterCurl.stageTransform === 'none' && afterCurl.contentTransform === 'none',
    `a PDF curl must leave zero transform: ${JSON.stringify(afterCurl)}`,
  );
  assert(
    afterCurl.contentClipPath === 'none' &&
      !afterCurl.anySlotClipped &&
      !afterCurl.anySlotTransformed,
    `a PDF curl must leave zero residual clip/transform on slots: ${JSON.stringify(afterCurl)}`,
  );

  // ---- A horizontal trackpad swipe scrubs the PDF curl 1:1, then settles cleanly ----
  const duringScrub = await page.evaluate(`(() => {
    const scroller = ${visibleScroller};
    const viewer = scroller?.closest('[data-testid="pdf-viewer"]');
    const leaf = viewer?.querySelector('[data-curl-part="leaf"]');
    for (let step = 0; step < 6; step += 1) {
      scroller?.dispatchEvent(
        new WheelEvent('wheel', { deltaX: -25, deltaY: 0, bubbles: true, cancelable: true }),
      );
    }
    const slots = [...(viewer?.querySelectorAll('[data-stage-row]') ?? [])];
    return {
      leafOpacity: leaf ? Number(getComputedStyle(leaf).opacity) : 0,
      hasClippedSlot: slots.some((slot) => getComputedStyle(slot).clipPath !== 'none'),
    };
  })()`);
  assert(
    duringScrub.leafOpacity > 0.2,
    `horizontal scrub must drive the curl leaf 1:1, saw opacity ${duringScrub.leafOpacity}`,
  );
  assert(duringScrub.hasClippedSlot, 'horizontal scrub must clip the outgoing PDF stage slot');
  await page.waitFor(
    `(() => {
      const viewer = [...document.querySelectorAll('[data-testid="pdf-viewer"]')]
        .find((element) => element.checkVisibility({ visibilityProperty: true }));
      const leaf = viewer?.querySelector('[data-curl-part="leaf"]');
      const slots = [...(viewer?.querySelectorAll('[data-stage-row]') ?? [])];
      return Number(leaf ? getComputedStyle(leaf).opacity : 0) === 0 &&
        slots.every((slot) => getComputedStyle(slot).clipPath === 'none');
    })()`,
    'the PDF curl scrub to settle cleanly',
  );

  // ---- Switching back to the EPUB tab exercises the inert curl mirror with zero rotateY ----
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] [role="tab"][data-e2e="paging-epub"]')?.click()`,
  );
  await page.waitFor(visibleHost, 'the EPUB tab to return for curl check');
  await page.waitForReaderLayout();
  await page.evaluate(`(() => {
    const host = ${visibleHost};
    const wrapper = host?.parentElement;
    const curlHost = wrapper?.querySelector('[data-testid="epub-curl-host"]');
    const leaf = wrapper?.querySelector('[data-curl-part="leaf"]');
    window.__epubCurlSamples = [];
    let frames = 0;
    const step = () => {
      window.__epubCurlSamples.push({
        children: curlHost ? curlHost.childElementCount : 0,
        visibility: curlHost ? getComputedStyle(curlHost).visibility : 'hidden',
        clipPath: curlHost ? getComputedStyle(curlHost).clipPath : 'none',
        hostTransform: host ? getComputedStyle(host).transform : 'none',
        leafOpacity: leaf ? Number(getComputedStyle(leaf).opacity) : 0,
        mirrorCompat: curlHost?.querySelector('iframe')?.contentDocument?.compatMode ?? null,
      });
      frames += 1;
      if (frames < 40) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
  await page.clickButton('Next Page');
  await new Promise((done) => setTimeout(done, 700));
  const epubCurl = await page.evaluate('window.__epubCurlSamples');
  assert(
    epubCurl.some((sample) => sample.children > 0),
    'an EPUB curl turn must mirror the outgoing spread inside epub-curl-host',
  );
  const mirrorCompats = epubCurl.map((sample) => sample.mirrorCompat).filter(Boolean);
  assert(
    mirrorCompats.length > 0 && mirrorCompats.every((mode) => mode === 'CSS1Compat'),
    `EPUB curl mirror iframe must render in Standards Mode (CSS1Compat), saw ${JSON.stringify(mirrorCompats)}`,
  );
  assert(
    epubCurl.some((sample) => sample.leafOpacity > 0.5),
    'an EPUB curl turn must light up the conical backside leaf',
  );
  assert(
    epubCurl.every((sample) => sample.hostTransform === 'none'),
    'epub-host must remain stationary (no rotateY) during curl',
  );
  const firstEpubClipIndex = epubCurl.findIndex((sample) => sample.clipPath !== 'none');
  assert(firstEpubClipIndex >= 0, 'EPUB curl must clip epub-curl-host while peeling');
  assert(
    epubCurl
      .slice(firstEpubClipIndex)
      .every((sample) => sample.visibility !== 'visible' || sample.clipPath !== 'none'),
    'once EPUB peeling begins, visible epub-curl-host must never flash unclipped',
  );
  const epubCurling = epubCurl.filter((sample) => sample.leafOpacity > 0.1);
  assert(epubCurling.length > 0, 'EPUB curl animation must be observed for at least one frame');
  const epubOutlines = new Set(
    epubCurling.map((sample) => sample.clipPath).filter((clip) => clip !== 'none'),
  );
  assert(
    epubOutlines.size > 3,
    `epub-curl-host must sweep across several polygon shapes, saw ${epubOutlines.size}`,
  );
  await page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const wrapper = host?.parentElement;
      const curlHost = wrapper?.querySelector('[data-testid="epub-curl-host"]');
      const leaf = wrapper?.querySelector('[data-curl-part="leaf"]');
      return (
        curlHost?.childElementCount === 0 &&
        getComputedStyle(curlHost).clipPath === 'none' &&
        getComputedStyle(host).transform === 'none' &&
        Number(leaf ? getComputedStyle(leaf).opacity : 0) === 0
      );
    })()`,
    'EPUB curl host and overlay to empty and reset after settle',
  );

  // ---- A TXT curl keeps the snapshot and shadow aligned with the text column ----
  const visibleTxtDoc = `[...document.querySelectorAll('[data-testid="txt-scroll"] [role="document"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
  await page.evaluate(`(() => {
    const doc = [...document.querySelectorAll('[data-testid="txt-scroll"] [role="document"]')]
      .find((e) => e.textContent.includes('SynapseRead sample text'));
    const panelId = doc?.closest('[role="tabpanel"]')?.id;
    document.querySelector('[aria-label="Open documents"] [role="tab"][aria-controls="' + panelId + '"]')?.click();
  })()`);
  await page.waitFor(visibleTxtDoc, 'the TXT tab to return for curl check');
  await page.waitForReaderLayout();
  await page.evaluate(`(() => {
    const doc = ${visibleTxtDoc};
    const stage = doc?.closest('[data-testid="txt-scroll"]')?.parentElement;
    const curlHost = stage?.querySelector('[data-testid="txt-curl-host"]');
    const shadow = stage?.querySelector('[data-testid="page-turn-shadow"]');
    const leaf = shadow?.querySelector('[data-curl-part="leaf"]');
    window.__txtCurlSamples = [];
    let frames = 0;
    const step = () => {
      const curlVisible = curlHost && getComputedStyle(curlHost).visibility === 'visible';
      const docRect = doc?.getBoundingClientRect();
      const curlRect = curlHost?.getBoundingClientRect();
      const shadowRect = shadow?.getBoundingClientRect();
      window.__txtCurlSamples.push({
        children: curlHost ? curlHost.childElementCount : 0,
        visibility: curlHost ? getComputedStyle(curlHost).visibility : 'hidden',
        clipPath: curlHost ? getComputedStyle(curlHost).clipPath : 'none',
        leafOpacity: leaf ? Number(getComputedStyle(leaf).opacity) : 0,
        deltaLeft:
          curlVisible && docRect && curlRect ? Math.abs(curlRect.left - docRect.left) : 0,
        shadowDeltaLeft:
          curlVisible && docRect && shadowRect ? Math.abs(shadowRect.left - docRect.left) : 0,
      });
      frames += 1;
      if (frames < 40) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
  await page.clickButton('Next Page');
  await new Promise((done) => setTimeout(done, 700));
  const txtCurl = await page.evaluate('window.__txtCurlSamples');
  assert(
    txtCurl.some((sample) => sample.children > 0 && sample.leafOpacity > 0.5),
    'a TXT curl turn must capture and animate the text snapshot',
  );
  const firstTxtClipIndex = txtCurl.findIndex((sample) => sample.clipPath !== 'none');
  assert(firstTxtClipIndex >= 0, 'TXT curl must clip txt-curl-host while peeling');
  assert(
    txtCurl
      .slice(firstTxtClipIndex)
      .every((sample) => sample.visibility !== 'visible' || sample.clipPath !== 'none'),
    'once TXT peeling begins, visible txt-curl-host must never flash unclipped',
  );
  assert(
    txtCurl.every((sample) => sample.deltaLeft < 0.5 && sample.shadowDeltaLeft < 0.5),
    `txt-curl-host and shadow must align with the text column, saw max deltas (${Math.max(...txtCurl.map((s) => s.deltaLeft))}, ${Math.max(...txtCurl.map((s) => s.shadowDeltaLeft))})`,
  );
}
