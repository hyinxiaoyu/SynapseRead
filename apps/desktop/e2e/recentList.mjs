import { assert } from './harness.mjs';

const RECENT_TITLES = Array.from(
  { length: 12 },
  (_, index) => `recent-${String(index + 1).padStart(2, '0')}`,
);

async function checkEmptyStateFitsViewport(page, width, height) {
  await page.setViewport(width, height);
  const metrics = await page.evaluate(`(() => {
    const header = [...document.querySelectorAll('header')].find((el) =>
      el.querySelector('[aria-label="Open documents"]'),
    );
    const empty = document.querySelector('[data-testid="reader-empty-state"]');
    const prompt = empty?.querySelector('p');
    const region = empty?.querySelector('[data-testid="empty-state-recent-documents"]');
    const firstItem = region?.querySelector('[data-testid="recent-document-item"]');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        text: el.textContent ?? '',
      };
    };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      header: box(header),
      prompt: box(prompt),
      region: box(region),
      firstItem: box(firstItem),
    };
  })()`);

  assert(metrics.header, 'reader header must exist');
  assert(metrics.prompt && metrics.region && metrics.firstItem, 'empty state elements must exist');
  for (const [label, rect] of [
    ['prompt', metrics.prompt],
    ['first recent item', metrics.firstItem],
  ]) {
    assert(
      rect.height > 0 &&
        rect.top >= metrics.header.bottom - 0.5 &&
        rect.bottom <= metrics.innerHeight + 0.5 &&
        rect.left >= -0.5 &&
        rect.right <= metrics.innerWidth + 0.5,
      `${width}x${height}: ${label} must be visible below header (${metrics.header.bottom}): ${JSON.stringify(rect)}`,
    );
  }
  assert(
    metrics.region.top >= metrics.header.bottom - 0.5,
    `${width}x${height}: Continue reading region (${metrics.region.top}) must not overlap header (${metrics.header.bottom})`,
  );
  assert(
    metrics.firstItem.text.includes('recent-12'),
    `${width}x${height}: newest item should be recent-12, got ${metrics.firstItem.text}`,
  );
}

async function verifyKeyboardExpandAndTabOrder(page, key, code) {
  await page.evaluate(
    `document.querySelector('[data-testid="recent-documents-show-all"]')?.focus()`,
  );
  await page.waitFor(
    `document.activeElement?.dataset.testid === 'recent-documents-show-all'`,
    'Show all button to receive focus',
  );
  await page.press(key, code);

  await page.waitFor(
    `(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      if (active.dataset.testid !== 'recent-document-item') return false;
      if (!active.textContent?.includes('recent-04')) return false;
      const list = active.closest('[data-testid="recent-documents-list"]');
      if (!list) return false;
      const a = active.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      return a.height > 0 && a.top >= l.top - 1 && a.bottom <= l.bottom + 1;
    })()`,
    `activating Show all with ${code} to focus recent-04 inside the scrollable list`,
  );

  await page.press('Tab', 'Tab');
  await page.waitFor(
    `(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.testid === 'recent-document-remove' &&
        active.closest('li')?.querySelector('[data-testid="recent-document-item"]')?.textContent?.includes('recent-04')
      );
    })()`,
    'Tab from recent-04 to move to its Remove button',
  );

  await page.press('Tab', 'Tab');
  await page.waitFor(
    `(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.testid === 'recent-document-item' &&
        active.textContent?.includes('recent-03')
      );
    })()`,
    'Tab from Remove button to move to recent-03',
  );
}

/**
 * #126: empty-state Continue reading stays reachable below the tab bar,
 * truncates at 8 items, and hands keyboard focus to the 9th item on Show all.
 */
export async function recentListFlow(page) {
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const title of ${JSON.stringify(RECENT_TITLES)}) {
      transfer.items.add(new File([title + ' body\\n'], title + '.txt', { type: 'text/plain' }));
    }
    document.querySelector('main').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  })()`);

  await page.waitFor(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]').length === 12`,
    'all 12 dropped documents to open',
  );

  await page.evaluate(`
    [...document.querySelectorAll('[aria-label="Open documents"] button[aria-label^="Close "]')]
      .forEach((button) => button.click());
  `);
  await page.waitFor(
    `document.querySelectorAll('[role="tab"]').length === 0 && !!document.querySelector('[data-testid="reader-empty-state"]')`,
    'all tabs to close and empty state to appear',
  );

  await checkEmptyStateFitsViewport(page, 1440, 900);
  await checkEmptyStateFitsViewport(page, 1280, 800);

  await verifyKeyboardExpandAndTabOrder(page, 'Enter', 'Enter');

  // Reopen an entry and close its tab to remount the collapsed empty state, then test Space at 1440x900.
  await page.evaluate(`
    [...document.querySelectorAll('[data-testid="empty-state-recent-documents"] [data-testid="recent-document-item"]')]
      .find((item) => item.textContent?.includes('recent-12'))
      ?.click();
  `);
  await page.waitFor(
    `!document.querySelector('[data-testid="reader-empty-state"]') && document.querySelectorAll('[role="tab"]').length === 1`,
    'recent-12 to reopen',
  );
  await page.evaluate(
    `document.querySelector('[aria-label="Open documents"] button[aria-label^="Close "]')?.click()`,
  );
  await page.waitFor(
    `!!document.querySelector('[data-testid="reader-empty-state"]') && !!document.querySelector('[data-testid="recent-documents-show-all"]')`,
    'empty state to remount with Show all',
  );

  await page.setViewport(1440, 900);
  await verifyKeyboardExpandAndTabOrder(page, ' ', 'Space');
}
