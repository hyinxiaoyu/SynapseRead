import { assert } from './harness.mjs';

// Read the toolbar's layout as the browser painted it: the title block, and the content
// edges of the two control groups. Hidden (collapsed) controls have no box and do not
// count, exactly as they do not count for the app.
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
    toolbar: box(toolbar),
    title: { left: title.left, right: title.right, middle: (title.left + title.right) / 2 },
    leading: content(leading),
    trailing: content(trailing),
    gap: Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0,
  };
})()`;

/**
 * The title sits on the toolbar's center, and never on top of a control group. At
 * widths where centering is impossible it slides only as far as it must, so the no
 * overlap assertion still applies but the centering one does not.
 */
async function checkTitle(page, description, { centered = true, groups = true } = {}) {
  const geometry = await page.evaluate(GEOMETRY);
  if (centered) {
    assert(
      Math.abs(geometry.title.middle - geometry.toolbar.middle) <= 1.5,
      `${description}: the title center ${geometry.title.middle} is not the toolbar center ${geometry.toolbar.middle}`,
    );
  }
  if (!groups) return;
  assert(
    geometry.leading && geometry.trailing,
    `${description}: the toolbar has no control groups`,
  );
  assert(
    geometry.title.left >= geometry.leading.right + geometry.gap - 0.5,
    `${description}: the title reaches into the leading group`,
  );
  assert(
    geometry.title.right <= geometry.trailing.left - geometry.gap + 0.5,
    `${description}: the title reaches into the trailing group`,
  );
}

/**
 * #75: the center slot of the unified toolbar used to center the title in the space
 * the two control groups left, which pushed it left of the window whenever the trailing
 * group was the wider one. The title now sits on the toolbar's center itself, and gives
 * way only as far as a control forces it to.
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

  // The narrowest window the app allows has no room to center a title; it must still
  // stay clear of the controls instead of being covered by them.
  await page.setViewport(960, 900);
  await checkTitle(page, 'the EPUB title at 960 px', { centered: false });
}
