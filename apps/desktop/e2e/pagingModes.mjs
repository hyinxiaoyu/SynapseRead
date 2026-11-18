// `#101`: the slide acts on the page area in every reading measure mode.
//
// The paging flow covers the default single-column Standard layout. This flow
// drives the same turn in a two-page spread and under Wide/Full width, where the
// measure is a different width from the paper the turn moves.

import { assert } from './harness.mjs';

const visibleHost = `[...document.querySelectorAll('[data-testid="epub-host"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const visibleViewer = `[...document.querySelectorAll('[data-testid="epub-viewer"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;
const strip = `${visibleHost}?.querySelector('.epub-container')`;
const sampleTitle = `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === 'sample'`;

const translateX = (transform) => {
  if (!transform || transform === 'none') return 0;
  const values = transform
    .slice(transform.indexOf('(') + 1, -1)
    .split(',')
    .map(Number);
  return values.length >= 16 ? values[12] : values[4];
};

/** Records the pane and the host transform every frame, so the turn is visible. */
const samplePanes = (page, { frames = 40 } = {}) =>
  page.evaluate(`(() => {
    const host = ${visibleHost};
    const pane = host?.closest('[data-testid="epub-slide-pane"]');
    const mirror = host?.closest('[data-testid="epub-page-area"]')?.querySelector('[data-testid="epub-curl-host"]');
    window.__paneSamples = [];
    let frames = 0;
    const step = () => {
      window.__paneSamples.push({
        pane: pane ? getComputedStyle(pane).transform : 'none',
        host: host ? getComputedStyle(host).transform : 'none',
        mirrorSpine: !!mirror?.querySelector('[data-testid="epub-mirror-spine"]'),
      });
      frames += 1;
      if (frames < ${frames}) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);

const paneSamples = (page) => page.evaluate('window.__paneSamples');

const widths = (page) =>
  page.evaluate(`(() => {
    const host = ${visibleHost};
    const area = host?.closest('[data-testid="epub-page-area"]');
    const pane = host?.closest('[data-testid="epub-slide-pane"]');
    return {
      area: area?.getBoundingClientRect().width ?? 0,
      measure: host?.getBoundingClientRect().width ?? 0,
      pane: pane?.getBoundingClientRect().width ?? 0,
      columns: Number(${visibleViewer}?.dataset.columns ?? 0),
      spineInPane: !!pane?.querySelector('[data-testid="epub-spine"]'),
    };
  })()`);

/** Turns once and returns the pane's travel and whether the host stayed put. */
/** Closes the appearance popover so its press-outside guard cannot eat the turn. */
const closeAppearance = async (page) => {
  if (await page.evaluate(`!!document.querySelector('[data-testid="appearance-popover"]')`)) {
    await page.press('Escape');
    await page.waitFor(
      `!document.querySelector('[data-testid="appearance-popover"]')`,
      'the appearance popover to close',
    );
  }
};

const turnAndMeasure = async (page, button = 'Next Page') => {
  await closeAppearance(page);
  await samplePanes(page);
  await page.clickButton(button);
  await new Promise((done) => setTimeout(done, 650));
  const samples = await paneSamples(page);
  const travel = Math.max(...samples.map((sample) => Math.abs(translateX(sample.pane))));
  const hostMoved = samples.some((sample) => sample.host !== 'none');
  const mirrorSpine = samples.some((sample) => sample.mirrorSpine);
  const settled = await page.evaluate(`(() => {
    const host = ${visibleHost};
    const pane = host?.closest('[data-testid="epub-slide-pane"]');
    return {
      pane: pane ? getComputedStyle(pane).transform : 'none',
      host: host ? getComputedStyle(host).transform : 'none',
    };
  })()`);
  return { travel, hostMoved, settled, mirrorSpine };
};

export async function pagingModesFlow(page) {
  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.openUntil(`${visibleHost} && ${sampleTitle}`, 'the EPUB');
  await page.waitForReaderLayout();

  // A wide viewport with the panels closed gives a two-page spread.
  await page.setViewport(1728, 1000);
  await page.waitForReaderLayout();
  await page.waitFor(`Number(${visibleViewer}?.dataset.columns) === 2`, 'a two-page spread');
  await page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const pane = host?.closest('[data-testid="epub-slide-pane"]');
      return !!pane && pane.getBoundingClientRect().width >= host.closest('[data-testid="epub-page-area"]').getBoundingClientRect().width - 2;
    })()`,
    'the slide pane to fill the page area',
  );

  const spread = await widths(page);
  assert(spread.columns === 2, `the fixture must open a spread: ${JSON.stringify(spread)}`);
  assert(
    spread.measure < spread.area - 8,
    `the spread must be narrower than the page area: ${JSON.stringify(spread)}`,
  );
  assert(
    spread.spineInPane,
    `the spine must live inside the pane so it travels with the page: ${JSON.stringify(spread)}`,
  );

  const spreadTurn = await turnAndMeasure(page);
  assert(
    spreadTurn.travel >= spread.area - 1,
    `a spread slide must travel the page area, not the measure: ${JSON.stringify({ spread, spreadTurn })}`,
  );
  assert(spreadTurn.mirrorSpine, 'the outgoing spread must keep its spine in the mirror');
  assert(!spreadTurn.hostMoved, 'the host must stay untransformed; the pane carries the slide');
  assert(
    spreadTurn.settled.pane === 'none' && spreadTurn.settled.host === 'none',
    `the spread turn must leave no transform: ${JSON.stringify(spreadTurn.settled)}`,
  );

  // Backward spread turn also moves the full page area with its spine.
  const backSpreadTurn = await turnAndMeasure(page, 'Previous Page');
  assert(
    backSpreadTurn.travel >= spread.area - 1,
    `a backward spread slide must travel the page area: ${JSON.stringify({ spread, backSpreadTurn })}`,
  );
  assert(backSpreadTurn.mirrorSpine, 'the backward outgoing spread must keep its spine');
  assert(!backSpreadTurn.hostMoved, 'the host must stay untransformed on backward spread slide');

  // Verify the seam shadow renders onto the outgoing paper in Light, Sepia, and Dark themes.
  for (const themeLabel of ['Light', 'Sepia', 'Dark']) {
    await page.clickButton('Reading appearance');
    await page.waitFor(
      `document.querySelector('[data-testid="appearance-popover"]')`,
      'appearance popover',
    );
    await page.clickButton(themeLabel);
    await closeAppearance(page);
    const midSeam = await page.evaluate(`(() => {
      const host = ${visibleHost};
      const area = host?.closest('[data-testid="epub-page-area"]');
      const pane = host?.closest('[data-testid="epub-slide-pane"]');
      for (let step = 0; step < 15; step += 1) {
        host.dispatchEvent(new WheelEvent('wheel', { deltaX: 20, deltaY: 0, bubbles: true, cancelable: true }));
      }
      // Keep the scrub alive at ±1 px so a slow screenshot round-trip never races
      // past the 90 ms release idle window before capturing the seam shadow.
      let toggle = 1;
      window.__seamHoldTimer = window.setInterval(() => {
        host.dispatchEvent(new WheelEvent('wheel', { deltaX: toggle, deltaY: 0, bubbles: true, cancelable: true }));
        toggle = -toggle;
      }, 30);
      const areaRect = area.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      return {
        seamX: Math.round(paneRect.left),
        y: Math.round(areaRect.top + 24),
        farX: Math.round(areaRect.left + 60),
      };
    })()`);
    const shot = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
    await page.evaluate(`(() => {
      window.clearInterval(window.__seamHoldTimer);
      delete window.__seamHoldTimer;
      return true;
    })()`);
    const contrast = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${shot.data}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const far = ctx.getImageData(${midSeam.farX}, ${midSeam.y}, 1, 1).data;
      let maxDiff = 0;
      for (let dx = -24; dx <= -2; dx += 2) {
        const px = ctx.getImageData(${midSeam.seamX} + dx, ${midSeam.y}, 1, 1).data;
        const diff = Math.abs(px[0] - far[0]) + Math.abs(px[1] - far[1]) + Math.abs(px[2] - far[2]);
        if (diff > maxDiff) maxDiff = diff;
      }
      return { far: [far[0], far[1], far[2]], maxDiff };
    })()`);
    assert(
      contrast.maxDiff >= 6,
      `the slide seam shadow must be visible in ${themeLabel} theme: ${JSON.stringify(contrast)}`,
    );
    await page.waitFor(
      `(() => {
        const pane = ${visibleHost}?.closest('[data-testid="epub-slide-pane"]');
        return pane ? getComputedStyle(pane).transform === 'none' : false;
      })()`,
      `${themeLabel} seam scrub to settle`,
    );
    await page.clickButton('Previous Page');
    await new Promise((done) => setTimeout(done, 400));
  }
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover',
  );
  await page.clickButton('Light');
  await closeAppearance(page);

  // Move to page 2 before testing a backward wide drag.
  await turnAndMeasure(page, 'Next Page');

  // A backward drag longer than the measure but shorter than the pane must keep
  // following the fingers; reverse it before release so the book stays put.
  const wideDrag = await page.evaluate(`(() => {
    const host = ${visibleHost};
    const pane = host?.closest('[data-testid="epub-slide-pane"]');
    const area = host?.closest('[data-testid="epub-page-area"]');
    const mirror = area?.querySelector('[data-testid="epub-curl-host"]');
    for (let step = 0; step < 70; step += 1) {
      host.dispatchEvent(
        new WheelEvent('wheel', { deltaX: -20, deltaY: 0, bubbles: true, cancelable: true }),
      );
    }
    const dragged = {
      pane: pane ? getComputedStyle(pane).transform : 'none',
      mirror: mirror ? getComputedStyle(mirror).transform : 'none',
      mirrorVisible: mirror ? getComputedStyle(mirror).visibility : 'hidden',
    };
    for (let step = 0; step < 70; step += 1) {
      host.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 20, deltaY: 0, bubbles: true, cancelable: true }),
      );
    }
    return {
      dragged,
      cancelled: {
        pane: pane ? getComputedStyle(pane).transform : 'none',
        mirror: mirror ? getComputedStyle(mirror).transform : 'none',
        mirrorVisible: mirror ? getComputedStyle(mirror).visibility : 'hidden',
      },
    };
  })()`);
  assert(
    wideDrag.dragged.mirror === 'matrix(1, 0, 0, 1, 1400, 0)',
    `a wide-area slide scrub must follow past the measure: ${JSON.stringify(wideDrag)}`,
  );
  assert(
    wideDrag.dragged.mirrorVisible === 'visible',
    `the outgoing mirror must be visible during a wide-area drag: ${JSON.stringify(wideDrag)}`,
  );
  assert(
    wideDrag.cancelled.pane === 'none' && wideDrag.cancelled.mirrorVisible === 'hidden',
    `reversing a wide-area drag must cancel its stage: ${JSON.stringify(wideDrag)}`,
  );
  await page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const pane = host?.closest('[data-testid="epub-slide-pane"]');
      return pane ? getComputedStyle(pane).transform === 'none' : false;
    })()`,
    'the wide-area scrub to settle',
  );
  // Wait past SCRUB_IDLE_MS (90 ms) so endScrub runs and confirm the cancelled drag stayed on Chapter One.
  await new Promise((done) => setTimeout(done, 150));
  const afterWideDrag = await page.evaluate(`(() => {
    const host = ${visibleHost};
    const ch = host?.querySelector('iframe')?.contentDocument?.querySelector('h1')?.textContent ?? '';
    return { ch, left: ${strip}?.scrollLeft ?? 0 };
  })()`);
  assert(
    afterWideDrag.ch === 'Chapter One' && afterWideDrag.left > 0,
    `cancelled wide-area drag must keep the book on Chapter One page 2: ${JSON.stringify(afterWideDrag)}`,
  );

  // Wide is wider than Standard but still narrower than the page area.
  await page.clickButton('Reading appearance');
  await page.clickButton('Wide');
  await page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const area = host?.closest('[data-testid="epub-page-area"]');
      const measure = host?.getBoundingClientRect().width ?? 0;
      return measure > ${spread.measure} + 100 && measure < (area?.getBoundingClientRect().width ?? 0) - 8;
    })()`,
    'the EPUB to widen to Wide',
  );
  // Let epub.js's 150 ms debounced re-layout finish before the turn.
  await new Promise((done) => setTimeout(done, 250));
  const wide = await widths(page);
  const wideTurn = await turnAndMeasure(page);
  assert(
    wideTurn.travel >= wide.area - 1,
    `a Wide slide must travel the page area, not the wider measure: ${JSON.stringify({ wide, wideTurn })}`,
  );
  assert(wideTurn.mirrorSpine, 'the Wide outgoing spread must keep its spine in the mirror');
  assert(!wideTurn.hostMoved, 'the host must stay untransformed at Wide width');

  // Full width makes the measure fill the page area; the turn still travels it.
  // The turn's Next Page click closes the popover, so reopen it first.
  await page.clickButton('Reading appearance');
  await page.clickButton('Full width');
  await page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const area = host?.closest('[data-testid="epub-page-area"]');
      return (host?.getBoundingClientRect().width ?? 0) >= (area?.getBoundingClientRect().width ?? 0) - 33;
    })()`,
    'the EPUB to fill the page area at Full width',
  );
  // Let epub.js's 150 ms debounced re-layout finish before the turn.
  await new Promise((done) => setTimeout(done, 250));
  const full = await widths(page);
  const fullTurn = await turnAndMeasure(page);
  assert(
    full.measure >= full.area - 33,
    `Full width must fill the page area: ${JSON.stringify(full)}`,
  );
  assert(
    fullTurn.travel >= full.area - 1,
    `a Full-width slide must travel the page area: ${JSON.stringify({ full, fullTurn })}`,
  );
  assert(fullTurn.mirrorSpine, 'the Full-width outgoing spread must keep its spine in the mirror');
  assert(!fullTurn.hostMoved, 'the host must stay untransformed at Full width');
  assert(
    fullTurn.settled.pane === 'none' && fullTurn.settled.host === 'none',
    `the Full-width turn must leave no transform: ${JSON.stringify(fullTurn.settled)}`,
  );

  // Full-width spread curl acts across the whole page area and shades the spine valley.
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover',
  );
  await page.evaluate(`(() => {
    const popover = document.querySelector('[data-testid="appearance-popover"]');
    const curl = [...(popover?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Curl');
    curl?.click();
    return !!curl;
  })()`);
  await closeAppearance(page);
  await page.evaluate(`(() => {
    const host = ${visibleHost};
    const area = host?.closest('[data-testid="epub-page-area"]');
    const curlHost = area?.querySelector('[data-testid="epub-curl-host"]');
    const shadow = area?.querySelector('[data-testid="page-turn-shadow"]');
    const spine = shadow?.querySelector('[data-curl-part="spine"]');
    const leaf = shadow?.querySelector('[data-curl-part="leaf"]');
    window.__spreadCurlSamples = [];
    let frames = 0;
    const step = () => {
      window.__spreadCurlSamples.push({
        curlW: curlHost?.getBoundingClientRect().width ?? 0,
        shadowW: shadow?.getBoundingClientRect().width ?? 0,
        areaW: area?.getBoundingClientRect().width ?? 0,
        spineOpacity: spine ? Number(getComputedStyle(spine).opacity) : 0,
        leafOpacity: leaf ? Number(getComputedStyle(leaf).opacity) : 0,
      });
      if (++frames < 40) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`);
  await page.clickButton('Previous Page');
  await new Promise((done) => setTimeout(done, 550));
  const spreadCurl = await page.evaluate('window.__spreadCurlSamples');
  assert(
    spreadCurl.some(
      (s) =>
        s.leafOpacity > 0.5 &&
        s.spineOpacity > 0.2 &&
        s.curlW >= s.areaW - 2 &&
        s.shadowW >= s.areaW - 2,
    ),
    `Full-width spread curl must span the page area and shade the spine: ${JSON.stringify(spreadCurl.slice(0, 6))}`,
  );

  // Cancelled scrub spring-back interrupted by viewport resize must restore the original page.
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover',
  );
  await page.evaluate(`(() => {
    const popover = document.querySelector('[data-testid="appearance-popover"]');
    const slide = [...(popover?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Slide');
    slide?.click();
    return !!slide;
  })()`);
  await closeAppearance(page);
  const beforeResizeLeft = await page.evaluate(`${strip}?.scrollLeft ?? 0`);
  for (let step = 0; step < 3; step += 1) {
    await page.evaluate(`(() => {
      ${visibleHost}.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 12, deltaY: 0, bubbles: true, cancelable: true }),
      );
      return true;
    })()`);
    if (step < 2) await new Promise((done) => setTimeout(done, 30));
  }
  await new Promise((done) => setTimeout(done, 100));
  await page.setViewport(1300, 900);
  await page.waitForReaderLayout();
  await new Promise((done) => setTimeout(done, 350));
  const afterResizeLeft = await page.evaluate(`${strip}?.scrollLeft ?? 0`);
  assert(
    afterResizeLeft === beforeResizeLeft,
    `cancelled scrub interrupted by resize must stay on original page (${beforeResizeLeft}), saw ${afterResizeLeft}`,
  );
}
