import { assert } from './harness.mjs';

const LONG_TITLE =
  'A remarkably long document title that keeps going well past any tab width limit';

async function checkTabs(page, width, height) {
  await page.setViewport(width, height);
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const tabs = await page.evaluate(`(() => {
    return [...document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')].map(
      (tab) => {
        const tabRect = tab.getBoundingClientRect();
        const base = tab.querySelector('span:not([data-testid])');
        const suffix = tab.querySelector('[data-testid="tab-label-suffix"]');
        const suffixRect = suffix?.getBoundingClientRect() ?? null;
        return {
          id: tab.id,
          ariaLabel: tab.getAttribute('aria-label') ?? '',
          tabRect: { left: tabRect.left, right: tabRect.right, width: tabRect.width },
          base: base
            ? { scrollWidth: base.scrollWidth, clientWidth: base.clientWidth }
            : null,
          suffix: suffix && suffixRect
            ? {
                text: (suffix.textContent ?? '').trim(),
                width: suffixRect.width,
                left: suffixRect.left,
                right: suffixRect.right,
                scrollWidth: suffix.scrollWidth,
                clientWidth: suffix.clientWidth,
              }
            : null,
        };
      },
    );
  })()`);

  assert(tabs.length === 2, `${width}x${height}: expected 2 tabs, got ${tabs.length}`);
  const suffixTexts = new Set();
  for (const tab of tabs) {
    assert(
      tab.suffix,
      `${width}x${height}: tab ${tab.id} is missing [data-testid="tab-label-suffix"]`,
    );
    assert(
      tab.suffix.width > 0,
      `${width}x${height}: tab ${tab.id} suffix width must be > 0, got ${tab.suffix.width}`,
    );
    assert(
      tab.suffix.left >= tab.tabRect.left - 0.5 && tab.suffix.right <= tab.tabRect.right + 0.5,
      `${width}x${height}: tab ${tab.id} suffix (${tab.suffix.left}..${tab.suffix.right}) overflows tab (${tab.tabRect.left}..${tab.tabRect.right})`,
    );
    assert(
      tab.suffix.scrollWidth <= tab.suffix.clientWidth + 1,
      `${width}x${height}: tab ${tab.id} suffix truncated (${tab.suffix.scrollWidth} > ${tab.suffix.clientWidth})`,
    );
    assert(
      tab.base && tab.base.scrollWidth > tab.base.clientWidth,
      `${width}x${height}: tab ${tab.id} base span must truncate (${JSON.stringify(tab.base)})`,
    );
    suffixTexts.add(tab.suffix.text);
  }
  assert(
    suffixTexts.has('· TXT') && suffixTexts.has('· Markdown'),
    `${width}x${height}: expected · TXT and · Markdown suffixes, got ${JSON.stringify([...suffixTexts])}`,
  );
}

/**
 * #129: long disambiguated tab titles keep their format/ordinal suffix visible
 * across desktop and narrower viewports and surface the full filename on keyboard focus.
 */
export async function tabLabelsFlow(page) {
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['Long title text body\\n'], ${JSON.stringify(`${LONG_TITLE}.txt`)}, {
        type: 'text/plain',
      }),
    );
    transfer.items.add(
      new File(['# Heading\\n\\nLong title markdown body\\n'], ${JSON.stringify(`${LONG_TITLE}.md`)}, {
        type: 'text/markdown',
      }),
    );
    document.querySelector('main').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  })()`);

  await page.waitFor(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]').length === 2`,
    'both long-titled documents to open as tabs',
  );

  await checkTabs(page, 1440, 900);
  await checkTabs(page, 960, 900);

  const initialTabId = await page.evaluate(`(() => {
    const tab = document.querySelector('[aria-label="Open documents"] [role="tab"][aria-selected="true"]');
    tab?.focus();
    return tab?.id ?? '';
  })()`);
  assert(initialTabId.length > 0, 'active tab id must exist');

  await page.waitFor(
    `document.activeElement?.id === ${JSON.stringify(initialTabId)} && document.activeElement?.getAttribute('role') === 'tab'`,
    'active tab to receive focus before ArrowRight',
  );

  await page.press('ArrowRight', 'ArrowRight');

  await page.waitFor(
    `(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.getAttribute('role') === 'tab' &&
        active.id !== ${JSON.stringify(initialTabId)} &&
        !!document.querySelector('[role="tooltip"]')
      );
    })()`,
    'ArrowRight to move focus to the sibling tab and open its tooltip',
  );

  const tooltipCheck = await page.evaluate(`(() => {
    const active = document.activeElement;
    const tooltip = document.querySelector('[role="tooltip"]');
    const tRect = tooltip.getBoundingClientRect();
    const suffixRect = active.querySelector('[data-testid="tab-label-suffix"]')?.getBoundingClientRect() ?? null;
    const titleLines = (active.getAttribute('title') ?? '').split('\\n');
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      tooltipText: tooltip.textContent ?? '',
      expectedFileName: titleLines[1] ?? '',
      tooltipRect: {
        left: tRect.left,
        top: tRect.top,
        right: tRect.right,
        bottom: tRect.bottom,
      },
      suffixWidth: suffixRect?.width ?? 0,
    };
  })()`);

  assert(
    tooltipCheck.tooltipRect.left >= -0.5 &&
      tooltipCheck.tooltipRect.top >= -0.5 &&
      tooltipCheck.tooltipRect.right <= tooltipCheck.innerWidth + 0.5 &&
      tooltipCheck.tooltipRect.bottom <= tooltipCheck.innerHeight + 0.5,
    `tooltip must stay within viewport: ${JSON.stringify(tooltipCheck)}`,
  );
  assert(
    tooltipCheck.expectedFileName === `${LONG_TITLE}.txt` ||
      tooltipCheck.expectedFileName === `${LONG_TITLE}.md`,
    `expected full filename in tab title attribute, got ${JSON.stringify(tooltipCheck.expectedFileName)}`,
  );
  assert(
    tooltipCheck.tooltipText.includes(tooltipCheck.expectedFileName),
    `tooltip text must contain full filename "${tooltipCheck.expectedFileName}", got ${JSON.stringify(tooltipCheck.tooltipText)}`,
  );
  assert(
    tooltipCheck.suffixWidth > 0,
    `focused tab suffix width must be > 0, got ${tooltipCheck.suffixWidth}`,
  );
}
