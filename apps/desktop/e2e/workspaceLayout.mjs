import { assert } from './harness.mjs';

const PANE_METRICS = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, height: box.height };
  };
  const reader = document.getElementById('reader');
  const mindmap = document.getElementById('mindmap');
  const inspector = document.getElementById('inspector');
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  const excerptButton = document.querySelector('[data-testid="excerpt-button"]');
  return {
    reader: rect(reader),
    mindmap: rect(mindmap),
    inspector: rect(inspector),
    activeTab: rect(activeTab),
    excerptButton: rect(excerptButton),
  };
})()`;

const approx = (actual, expected, tolerance, label) => {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
};

async function measure(page) {
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  return page.evaluate(PANE_METRICS);
}

/**
 * Verifies #180 at the app's minimum window size (960 × 600):
 * - Hiding either side pane gives its width back to the reader, leaving the
 *   sibling pane unchanged (±1 px).
 * - Any sequence of Show/Hide MindMap and Show/Hide inspector restores identical
 *   widths without squeezing the reader below its minimum.
 * - With all three panes open at 960 × 600, both the active document tab and
 *   Excerpt to MindMap remain visible inside the reader panel.
 */
export async function workspaceLayoutFlow(page) {
  await page.setViewport(960, 600);
  await page.clickButton('Open');
  await page.waitFor(
    'document.querySelector(\'[role="tab"][aria-selected="true"]\')',
    'active document tab',
  );

  // Open both side panes.
  await page.clickButton('Show MindMap');
  await page.clickButton('Show inspector');
  const allOpen = await measure(page);

  assert(
    allOpen.reader.width >= 420,
    `reader should stay >= 420 px at 960x600 with all panes open, got ${allOpen.reader.width}`,
  );
  assert(allOpen.mindmap.width > 0, `mindmap should be open, got ${allOpen.mindmap.width}`);
  assert(allOpen.inspector.width > 0, `inspector should be open, got ${allOpen.inspector.width}`);
  assert(
    allOpen.activeTab && allOpen.activeTab.width > 20,
    `active tab should remain visible, got ${JSON.stringify(allOpen.activeTab)}`,
  );
  assert(
    allOpen.excerptButton &&
      allOpen.excerptButton.left >= allOpen.reader.left - 0.5 &&
      allOpen.excerptButton.right <= allOpen.reader.right + 0.5,
    `Excerpt to MindMap (${JSON.stringify(allOpen.excerptButton)}) must stay inside reader (${JSON.stringify(allOpen.reader)})`,
  );

  // Hide MindMap: width returns to reader; Inspector stays unchanged (±1 px).
  await page.clickButton('Hide MindMap');
  const mindMapHidden = await measure(page);
  approx(mindMapHidden.mindmap.width, 0, 1, 'MindMap collapsed width');
  approx(
    mindMapHidden.inspector.width,
    allOpen.inspector.width,
    1,
    'Inspector width after hiding MindMap',
  );
  approx(
    mindMapHidden.reader.width,
    allOpen.reader.width + allOpen.mindmap.width,
    2,
    'Reader width after hiding MindMap',
  );

  // Hide Inspector, then bring both back: widths match initial all-open state.
  await page.clickButton('Hide inspector');
  const bothHidden = await measure(page);
  approx(bothHidden.mindmap.width, 0, 1, 'MindMap width with both hidden');
  approx(bothHidden.inspector.width, 0, 1, 'Inspector width with both hidden');

  await page.clickButton('Show MindMap');
  const onlyMindMap = await measure(page);
  approx(onlyMindMap.mindmap.width, allOpen.mindmap.width, 1, 'MindMap width when re-shown');
  approx(
    onlyMindMap.reader.width,
    allOpen.reader.width + allOpen.inspector.width,
    2,
    'Reader width with only MindMap open',
  );

  await page.clickButton('Show inspector');
  const reopenedAll = await measure(page);
  approx(reopenedAll.reader.width, allOpen.reader.width, 1, 'Reader width after full cycle');
  approx(reopenedAll.mindmap.width, allOpen.mindmap.width, 1, 'MindMap width after full cycle');
  approx(
    reopenedAll.inspector.width,
    allOpen.inspector.width,
    1,
    'Inspector width after full cycle',
  );
  assert(
    reopenedAll.activeTab && reopenedAll.activeTab.width > 20,
    `active tab should still be visible after full cycle, got ${JSON.stringify(reopenedAll.activeTab)}`,
  );
  assert(
    reopenedAll.excerptButton && reopenedAll.excerptButton.right <= reopenedAll.reader.right + 0.5,
    `Excerpt to MindMap should still fit inside reader after full cycle`,
  );

  // Hide Inspector: width returns to reader; MindMap stays unchanged (±1 px).
  await page.clickButton('Hide inspector');
  const inspectorHidden = await measure(page);
  approx(inspectorHidden.inspector.width, 0, 1, 'Inspector collapsed width');
  approx(
    inspectorHidden.mindmap.width,
    allOpen.mindmap.width,
    1,
    'MindMap width after hiding Inspector',
  );
  approx(
    inspectorHidden.reader.width,
    allOpen.reader.width + allOpen.inspector.width,
    2,
    'Reader width after hiding Inspector',
  );

  // Reset to 1440 × 900 and verify a user handle drag still persists across show/hide (#119, #180).
  await page.resetViewport();
  await page.clickButton('Show inspector');
  const beforeDrag = await measure(page);

  const separatorBox = await page.evaluate(`(() => {
    const separators = [...document.querySelectorAll('[data-slot="resizable-handle"]')];
    const first = separators[0];
    if (!first) return null;
    const rect = first.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(separatorBox, 'expected first resize handle');

  // Drag Reader | MindMap handle left by 100 px to widen MindMap.
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: separatorBox.x,
    y: separatorBox.y,
  });
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    x: separatorBox.x,
    y: separatorBox.y,
  });
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    button: 'left',
    buttons: 1,
    x: separatorBox.x - 100,
    y: separatorBox.y,
  });
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    x: separatorBox.x - 100,
    y: separatorBox.y,
  });

  const afterDrag = await measure(page);
  assert(
    afterDrag.mindmap.width > beforeDrag.mindmap.width + 60,
    `dragging handle should widen MindMap (${beforeDrag.mindmap.width} -> ${afterDrag.mindmap.width})`,
  );

  // Hide and re-show MindMap: the user-dragged width is preserved.
  await page.clickButton('Hide MindMap');
  const afterHide = await measure(page);
  approx(
    afterHide.inspector.width,
    afterDrag.inspector.width,
    1,
    'Inspector width stays unchanged when hiding resized MindMap',
  );
  await page.clickButton('Show MindMap');
  const afterReshow = await measure(page);
  approx(
    afterReshow.mindmap.width,
    afterDrag.mindmap.width,
    2,
    'User-dragged MindMap width persists across hide/show',
  );
}
