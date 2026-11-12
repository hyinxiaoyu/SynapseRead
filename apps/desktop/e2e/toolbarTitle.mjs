import { assert } from './harness.mjs';

// Read the toolbar's layout as the browser painted it: which layout branch is active,
// the title block, and the content edges of the two control groups. Hidden (collapsed)
// controls have no box and do not count, exactly as they do not count for the app.
const GEOMETRY = `(() => {
  const toolbar = document.querySelector('[data-testid="unified-toolbar"]');
  const center = toolbar?.querySelector('[data-testid="toolbar-center"]')?.parentElement;
  const leading = toolbar?.querySelector('[data-testid="toolbar-leading"]');
  const trailing = toolbar?.querySelector('[data-testid="toolbar-trailing"]')?.parentElement;
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, middle: (rect.left + rect.right) / 2 };
  };
  // The center slot holds the reader's node inside a display: contents wrapper, and
  // the notebook title beside it, so descend past the wrapper to the boxes themselves.
  const boxes = (host) => {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (getComputedStyle(child).display === 'contents') {
          visit(child);
          continue;
        }
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        found.push(rect);
      }
    };
    visit(host);
    return found;
  };
  const content = (host) => {
    const found = boxes(host);
    if (found.length === 0) return null;
    return {
      left: Math.min(...found.map((rect) => rect.left)),
      right: Math.max(...found.map((rect) => rect.right)),
    };
  };
  const title = content(center);
  return {
    display: getComputedStyle(toolbar).display,
    toolbar: box(toolbar),
    title: { left: title.left, right: title.right, middle: (title.left + title.right) / 2 },
    leading: content(leading),
    trailing: content(trailing),
    gap: Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0,
  };
})()`;

/**
 * Checks one of the toolbar's three states:
 * - `centered`: three-column grid, title on the toolbar's own center (`shift === 0`);
 * - `slid`: three-column grid, title pushed just clear of the wider trailing group;
 * - `fallback`: flex row between the groups once the title can no longer fit whole.
 */
async function checkTitle(page, description, { mode = 'centered', groups = true } = {}) {
  const geometry = await page.evaluate(GEOMETRY);
  const expectedDisplay = mode === 'fallback' ? 'flex' : 'grid';
  assert(
    geometry.display === expectedDisplay,
    `${description}: expected ${expectedDisplay} layout, got ${geometry.display}`,
  );
  if (mode === 'centered') {
    assert(
      Math.abs(geometry.title.middle - geometry.toolbar.middle) <= 1.5,
      `${description}: the title center ${geometry.title.middle} is not the toolbar center ${geometry.toolbar.middle}`,
    );
  }
  if (!groups) return geometry;
  assert(
    geometry.leading && geometry.trailing,
    `${description}: the toolbar has no control groups`,
  );
  assert(
    geometry.title.left >= geometry.leading.right + geometry.gap - 0.5,
    `${description}: the title (${geometry.title.left}) reaches into the leading group (${geometry.leading.right} + ${geometry.gap})`,
  );
  assert(
    geometry.title.right <= geometry.trailing.left - geometry.gap + 0.5,
    `${description}: the title (${geometry.title.right}) reaches into the trailing group (${geometry.trailing.left} - ${geometry.gap})`,
  );
  if (mode === 'slid') {
    assert(
      geometry.title.middle < geometry.toolbar.middle - 4,
      `${description}: expected a non-zero left shift from ${geometry.toolbar.middle}, got ${geometry.title.middle}`,
    );
    const trailingEdge = geometry.trailing.left - geometry.gap;
    assert(
      Math.abs(geometry.title.right - trailingEdge) <= 1,
      `${description}: expected title right (${geometry.title.right}) to kiss ${trailingEdge}`,
    );
  }
  return geometry;
}

/** Drops an in-memory text document so its filename becomes the toolbar title. */
async function dropTextDocument(page, title, body) {
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(`${title}.txt`)}, {
      type: 'text/plain',
    }));
    document.querySelector('main').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  })()`);
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`,
    `the dropped document "${title}"`,
  );
}

/** Waits until no CSS width transitions are still running inside the toolbar. */
async function waitForToolbarTransitions(page) {
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"]')
      .getAnimations({ subtree: true })
      .every((animation) => animation.playState !== 'running')`,
    'toolbar width transitions to finish',
  );
  await page.evaluate(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
  );
}

/**
 * #75: the center slot of the unified toolbar used to center the title in the space
 * the two control groups left, which pushed it left of the window whenever the trailing
 * group was the wider one. The title now sits on the toolbar's center itself, gives way
 * only as far as a control forces it to, and meets the truncating fallback without a jump.
 */
export async function toolbarTitleFlow(page) {
  const titleIs = (title) =>
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.textContent === ${JSON.stringify(title)}`;
  const epubVisible = `[...document.querySelectorAll('[data-testid="epub-viewer"]')]
    .some((viewer) => viewer.checkVisibility({ visibilityProperty: true }))`;

  // The notebook title stands in the same center slot before a document opens, when
  // there is no group of reader controls to clear.
  await checkTitle(page, 'the notebook title', { groups: false });

  await page.openUntil(`${epubVisible} && ${titleIs('sample')}`, 'the sample EPUB');

  for (const width of [1440, 2400]) {
    await page.setViewport(width, 900);
    await checkTitle(page, `the EPUB title at ${width} px`);
  }

  // Open a long-titled document so all three regimes (centered, slid against the
  // trailing group, and the narrow truncating fallback) are exercised on one title.
  const longTitle =
    'On the Exact Centering of Long Document Titles Within the Unified Reader Toolbar';
  await dropTextDocument(page, longTitle, 'SynapseRead searchable text in a long-titled book.\n');

  const wide = await checkTitle(page, 'the long title at 2400 px');
  const naturalTitleWidth = wide.title.right - wide.title.left;
  const chromeAt = (g) =>
    g.leading.right - g.toolbar.left + (g.toolbar.right - g.trailing.left) + 2 * g.gap;

  // Refine `switchWidth` once at its own container-query band so collapsed items match.
  let switchWidth = Math.round(naturalTitleWidth + chromeAt(wide));
  await page.setViewport(switchWidth, 900);
  switchWidth = Math.round(naturalTitleWidth + chromeAt(await page.evaluate(GEOMETRY)));

  // 140 px above the switch, the title fits with room to spare for the 80 px search
  // expansion, yet the wider trailing group still pushes it off the toolbar's center.
  const slideWidth = switchWidth + 140;
  await page.setViewport(slideWidth, 900);
  const beforeSearch = await checkTitle(page, `the long title slid at ${slideWidth} px`, {
    mode: 'slid',
  });

  // Starting a search animates the search slot from `w-40` to `w-60` over 150 ms without
  // resizing the toolbar itself; `ResizeObserver` on the group must follow the animation.
  await page.setInputValue('[data-testid="search-input"]', 'searchable');
  await page.waitFor(
    `document.querySelector('[data-testid="search-status"]')?.textContent?.includes('1 of 1')`,
    'the search match count',
  );
  await waitForToolbarTransitions(page);
  const duringSearch = await checkTitle(page, 'the long title after search widens', {
    mode: 'slid',
  });
  assert(
    beforeSearch.trailing.left - duringSearch.trailing.left >= 70,
    `expected search to widen the trailing group by ~80 px, got ${beforeSearch.trailing.left - duringSearch.trailing.left}`,
  );
  await page.leaveSearch();
  await waitForToolbarTransitions(page);

  // Step across the exact width where the centered grid hands off to the flex fallback:
  // above `switchWidth` the whole title slides left by `delta`; below it, the left edge
  // pins at `leading.right + gap` and the right edge continues moving with the window.
  const delta = 3;
  await page.setViewport(switchWidth + delta, 900);
  const aboveSwitch = await checkTitle(
    page,
    `just above the layout switch (${switchWidth + delta} px)`,
    { mode: 'slid' },
  );

  await page.setViewport(switchWidth - delta, 900);
  const belowSwitch = await checkTitle(
    page,
    `just below the layout switch (${switchWidth - delta} px)`,
    { mode: 'fallback' },
  );

  assert(
    Math.abs(aboveSwitch.title.left - belowSwitch.title.left) <= delta + 1.5,
    `title jumped horizontally on the left across the switch: ${aboveSwitch.title.left} -> ${belowSwitch.title.left}`,
  );
  assert(
    Math.abs(aboveSwitch.title.right - belowSwitch.title.right - 2 * delta) <= 1.5,
    `title jumped horizontally on the right across the ${2 * delta} px switch: ${aboveSwitch.title.right} -> ${belowSwitch.title.right}`,
  );

  // At the narrowest window the app allows, the fallback truncates clear of both groups.
  await page.setViewport(960, 900);
  await checkTitle(page, 'the long title at 960 px', { mode: 'fallback' });
}
