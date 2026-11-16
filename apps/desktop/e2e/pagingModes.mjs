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

const turnAndMeasure = async (page) => {
  await closeAppearance(page);
  await samplePanes(page);
  await page.clickButton('Next Page');
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
}
