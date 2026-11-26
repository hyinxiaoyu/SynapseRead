import { assert } from './harness.mjs';

const LONG_TITLE =
  'A remarkably long document title that keeps going well past any tab width limit';

/**
 * Generates an in-memory expression evaluating to a minimal single-page PDF byte array
 * whose `/Info /Title` is `title`, so `pdfjs-dist` extracts `title` directly.
 */
function browserBuildMinimalPdfExpr(title, bodyText) {
  return `(() => {
    const escapePdf = (s) => s.replace(/\\\\/g, '\\\\\\\\').replace(/\\(/g, '\\\\(').replace(/\\)/g, '\\\\)');
    const titleEsc = escapePdf(${JSON.stringify(title)});
    const bodyEsc = escapePdf(${JSON.stringify(bodyText)});
    const stream = 'BT /F1 12 Tf 72 720 Td (' + bodyEsc + ') Tj ET';
    const encoder = new TextEncoder();
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + encoder.encode(stream).length + ' >>\\nstream\\n' + stream + '\\nendstream',
      '<< /Title (' + titleEsc + ') >>',
    ];
    const parts = [encoder.encode('%PDF-1.4\\n')];
    let offset = parts[0].length;
    const offsets = [];
    for (let i = 0; i < objects.length; i += 1) {
      offsets.push(offset);
      const chunk = encoder.encode((i + 1) + ' 0 obj\\n' + objects[i] + '\\nendobj\\n');
      parts.push(chunk);
      offset += chunk.length;
    }
    const xrefOffset = offset;
    const pad = (n) => String(n).padStart(10, '0');
    const xrefLines = [
      'xref',
      '0 ' + (objects.length + 1),
      '0000000000 65535 f ',
      ...offsets.map((off) => pad(off) + ' 00000 n '),
      'trailer',
      '<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /Info 6 0 R >>',
      'startxref',
      String(xrefOffset),
      '%%EOF',
    ];
    parts.push(encoder.encode(xrefLines.join('\\n')));
    const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let pos = 0;
    for (const part of parts) {
      bytes.set(part, pos);
      pos += part.length;
    }
    return bytes;
  })()`;
}

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

async function checkThreeTabsBudget(page, width, height) {
  await page.setViewport(width, height);
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const tabs = await page.evaluate(`(() => {
    return [...document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')].map(
      (tab) => {
        const close = tab.nextElementSibling;
        const tabRect = tab.getBoundingClientRect();
        const closeRect = close?.getBoundingClientRect() ?? null;
        const base = tab.querySelector('span:not([data-testid])');
        const baseRect = base?.getBoundingClientRect() ?? null;
        const suffix = tab.querySelector('[data-testid="tab-label-suffix"]');
        const suffixRect = suffix?.getBoundingClientRect() ?? null;
        const closeCenterX = closeRect ? closeRect.left + closeRect.width / 2 : 0;
        const closeCenterY = closeRect ? closeRect.top + closeRect.height / 2 : 0;
        const hitAtClose = closeRect ? document.elementFromPoint(closeCenterX, closeCenterY) : null;
        return {
          id: tab.id,
          ariaLabel: tab.getAttribute('aria-label') ?? '',
          tabRect: { left: tabRect.left, right: tabRect.right, width: tabRect.width },
          base: base && baseRect
            ? {
                width: baseRect.width,
                scrollWidth: base.scrollWidth,
                clientWidth: base.clientWidth,
              }
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
          close: close && closeRect
            ? {
                left: closeRect.left,
                right: closeRect.right,
                width: closeRect.width,
                centerX: closeCenterX,
                centerY: closeCenterY,
                hittable: close.contains(hitAtClose),
              }
            : null,
        };
      },
    );
  })()`);

  assert(tabs.length === 3, `${width}x${height}: expected 3 tabs, got ${tabs.length}`);
  const suffixTexts = new Set();
  for (const tab of tabs) {
    assert(tab.suffix, `${width}x${height}: tab ${tab.id} missing suffix`);
    assert(tab.close, `${width}x${height}: tab ${tab.id} missing close button`);
    assert(
      tab.suffix.width > 0,
      `${width}x${height}: tab ${tab.id} suffix width must be > 0, got ${tab.suffix.width}`,
    );
    assert(
      tab.suffix.left >= tab.tabRect.left - 0.5 && tab.suffix.right <= tab.tabRect.right + 0.5,
      `${width}x${height}: tab ${tab.id} suffix overflows tab button: ${JSON.stringify(tab)}`,
    );
    assert(
      tab.suffix.scrollWidth <= tab.suffix.clientWidth + 1,
      `${width}x${height}: tab ${tab.id} suffix truncated: ${JSON.stringify(tab.suffix)}`,
    );
    assert(
      tab.suffix.right <= tab.close.left + 0.5 && tab.tabRect.right <= tab.close.left + 0.5,
      `${width}x${height}: tab ${tab.id} overlapped Close button: ${JSON.stringify(tab)}`,
    );
    assert(
      tab.base &&
        tab.base.width >= 32 &&
        tab.base.clientWidth >= 32 &&
        tab.base.scrollWidth > tab.base.clientWidth,
      `${width}x${height}: tab ${tab.id} base title must keep >= 32px width and truncate: ${JSON.stringify(tab.base)}`,
    );
    assert(
      tab.close.hittable,
      `${width}x${height}: tab ${tab.id} Close button is covered at center: ${JSON.stringify(tab.close)}`,
    );
    suffixTexts.add(tab.suffix.text);
  }
  assert(
    suffixTexts.has('· TXT') && suffixTexts.has('· PDF') && suffixTexts.has('· PDF (2)'),
    `${width}x${height}: expected · TXT, · PDF, · PDF (2), got ${JSON.stringify([...suffixTexts])}`,
  );
  return tabs;
}

/**
 * #129: long disambiguated tab titles keep compact suffixes visible across desktop and
 * narrower viewports, never crowd out the main title or Close button, and surface full
 * filenames on keyboard focus.
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

  // Stage 2: 1 TXT + 2 PDFs sharing the same long Info.Title with Chinese filenames differing only at the last character.
  await page.evaluate(`
    [...document.querySelectorAll('[aria-label="Open documents"] button[aria-label^="Close "]')]
      .forEach((button) => button.click());
  `);
  await page.waitFor(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]').length === 0`,
    'stage 1 tabs to close',
  );

  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['Long title text body\\n'], ${JSON.stringify(`${LONG_TITLE}.txt`)}, {
        type: 'text/plain',
      }),
    );
    transfer.items.add(
      new File([${browserBuildMinimalPdfExpr(LONG_TITLE, 'PDF 1')}], '读书读书读书读甲.pdf', {
        type: 'application/pdf',
      }),
    );
    transfer.items.add(
      new File([${browserBuildMinimalPdfExpr(LONG_TITLE, 'PDF 2')}], '读书读书读书读乙.pdf', {
        type: 'application/pdf',
      }),
    );
    document.querySelector('main').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  })()`);

  await page.waitFor(
    `(() => {
      const tabs = [...document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')];
      if (tabs.length !== 3) return false;
      const labels = tabs.map((t) => t.getAttribute('aria-label') ?? '');
      return (
        labels.some((l) => l.includes('读书读书读书读甲.pdf') && l.includes('· PDF ·')) &&
        labels.some((l) => l.includes('读书读书读书读乙.pdf') && l.includes('· PDF ·')) &&
        tabs.every((t) => !!t.querySelector('[data-testid="tab-label-suffix"]'))
      );
    })()`,
    'all three tabs with metadata titles from Chinese-named PDFs to disambiguate',
  );

  const tabs1280 = await checkThreeTabsBudget(page, 1280, 800);
  await checkThreeTabsBudget(page, 960, 900);

  // Return to 1280x800 and actually click the Close button on the second Chinese-named PDF tab.
  const tabsFinal = await checkThreeTabsBudget(page, 1280, 800);
  const targetCloseTab =
    tabsFinal.find((t) => t.ariaLabel.includes('读书读书读书读乙.pdf')) ?? tabs1280[2];
  await page.click({ x: targetCloseTab.close.centerX, y: targetCloseTab.close.centerY });
  await page.waitFor(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]').length === 2`,
    'clicking the Close button on the Chinese-named PDF tab to close it',
  );

  // Stage 3: Unbroken 150-char filenames, right-edge clamping, and tablist horizontal scroll tracking at 960x800.
  await page.evaluate(`
    [...document.querySelectorAll('[aria-label="Open documents"] button[aria-label^="Close "]')]
      .forEach((button) => button.click());
  `);
  await page.waitFor(
    `document.querySelectorAll('[aria-label="Open documents"] [role="tab"]').length === 0`,
    'stage 2 tabs to close',
  );

  await page.setViewport(960, 800);
  const longW = 'W'.repeat(150);
  const longM = 'M'.repeat(150);
  const fillerNames = [1, 2, 3, 4, 5].map((n) => `scroll-filler-${n}-extra-width.txt`);

  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    const names = [${JSON.stringify(`${longW}.txt`)}, ...${JSON.stringify(fillerNames)}, ${JSON.stringify(`${longM}.txt`)}];
    for (const name of names) {
      transfer.items.add(new File(['body of ' + name + '\\n'], name, { type: 'text/plain' }));
    }
    document.querySelector('main').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  })()`);

  await page.waitFor(
    `(() => {
      const tablist = document.querySelector('[aria-label="Open documents"]');
      const tabs = tablist?.querySelectorAll('[role="tab"]') ?? [];
      return tabs.length === 7 && tablist.scrollWidth > tablist.clientWidth;
    })()`,
    'all 7 tabs to open with a horizontally scrollable tablist',
  );

  const inspectFocusedTooltip = () =>
    page.evaluate(`(() => {
      const active = document.activeElement;
      const tablist = document.querySelector('[aria-label="Open documents"]');
      const tooltip = document.querySelector('[role="tooltip"]');
      if (!(active instanceof HTMLElement) || !tablist || !tooltip) return null;
      const tabRect = active.getBoundingClientRect();
      const tRect = tooltip.getBoundingClientRect();
      const walker = document.createTreeWalker(tooltip, NodeFilter.SHOW_TEXT);
      const textRects = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.data || node.data.trim().length === 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) {
            textRects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          }
        }
      }
      const distinctLines = new Set(textRects.map((r) => Math.round(r.top)));
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        activeAriaLabel: active.getAttribute('aria-label') ?? '',
        tabRect: { left: tabRect.left, right: tabRect.right, bottom: tabRect.bottom },
        scrollLeft: tablist.scrollLeft,
        tooltipText: tooltip.textContent ?? '',
        tooltipRect: {
          left: tRect.left,
          top: tRect.top,
          right: tRect.right,
          bottom: tRect.bottom,
          width: tRect.width,
        },
        scrollWidth: tooltip.scrollWidth,
        clientWidth: tooltip.clientWidth,
        textRects,
        lineCount: distinctLines.size,
      };
    })()`);

  const assertTooltipWithinBounds = (state, label, { expectMultiline = false } = {}) => {
    assert(state, `${label}: focused tooltip state missing`);
    assert(
      state.tooltipRect.left >= -0.5 &&
        state.tooltipRect.top >= -0.5 &&
        state.tooltipRect.right <= state.innerWidth + 0.5 &&
        state.tooltipRect.bottom <= state.innerHeight + 0.5,
      `${label}: tooltip rect overflows viewport: ${JSON.stringify(state.tooltipRect)}`,
    );
    assert(
      state.scrollWidth <= state.clientWidth + 1,
      `${label}: tooltip text overflows box (${state.scrollWidth} > ${state.clientWidth})`,
    );
    assert(state.textRects.length > 0, `${label}: expected measured text rects inside tooltip`);
    for (const r of state.textRects) {
      assert(
        r.left >= state.tooltipRect.left - 1 &&
          r.right <= state.tooltipRect.right + 1 &&
          r.left >= -0.5 &&
          r.right <= state.innerWidth + 0.5 &&
          r.top >= -0.5 &&
          r.bottom <= state.innerHeight + 0.5,
        `${label}: text line rect ${JSON.stringify(r)} overflows tooltip ${JSON.stringify(state.tooltipRect)} or viewport`,
      );
    }
    if (expectMultiline) {
      assert(
        state.lineCount >= 4,
        `${label}: expected wrapped multi-line tooltip (>= 4 lines), got ${state.lineCount}`,
      );
    }
  };

  // Case A: Unbroken 150-W filename on tab #0 wraps cleanly without overflowing viewport.
  await page.evaluate(`(() => {
    const tab = document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')[0];
    tab?.focus();
  })()`);
  await page.waitFor(
    `document.querySelector('[role="tooltip"]')?.textContent?.includes(${JSON.stringify(`${longW}.txt`)})`,
    'tooltip for 150-W tab to render',
  );
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const caseA = await inspectFocusedTooltip();
  assert(
    caseA.tooltipText === `${longW}\n${longW}.txt`,
    `Case A: expected newline between title and filename, got ${JSON.stringify(caseA.tooltipText)}`,
  );
  assertTooltipWithinBounds(caseA, 'Case A (150-W filename)', { expectMultiline: true });

  // Case B: Jump to rightmost tab via End and confirm tooltip clamps within viewport margin.
  await page.press('End', 'End');
  await page.waitFor(
    `document.querySelector('[role="tooltip"]')?.textContent?.includes(${JSON.stringify(`${longM}.txt`)})`,
    'End key to focus rightmost 150-M tab and open its tooltip',
  );
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const caseB = await inspectFocusedTooltip();
  assert(
    caseB.tabRect.left > 400,
    `Case B: expected rightmost tab to be near the right edge, got left=${caseB.tabRect.left}`,
  );
  assert(
    caseB.tooltipRect.left >= 7.5 && caseB.tooltipRect.right <= 952.5,
    `Case B: expected tooltip clamped within [7.5, 952.5], got ${JSON.stringify(caseB.tooltipRect)}`,
  );
  assertTooltipWithinBounds(caseB, 'Case B (rightmost tab clamping)', { expectMultiline: true });

  // Case C: Horizontal scrolling of the tablist moves the tooltip with its focused middle tab.
  await page.evaluate(`(() => {
    const tablist = document.querySelector('[aria-label="Open documents"]');
    const middleTab = tablist?.querySelectorAll('[role="tab"]')[3];
    middleTab?.focus({ preventScroll: true });
    if (tablist) tablist.scrollLeft = 240;
  })()`);
  await page.waitFor(
    `document.querySelector('[role="tooltip"]')?.textContent?.includes('scroll-filler-3-extra-width.txt')`,
    'middle tab tooltip to appear at scrollLeft=240',
  );
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const beforeScroll = await inspectFocusedTooltip();
  assert(
    Math.abs(beforeScroll.tooltipRect.left - beforeScroll.tabRect.left) <= 1.5,
    `Case C before scroll: tooltip (${beforeScroll.tooltipRect.left}) should align with tab (${beforeScroll.tabRect.left})`,
  );

  await page.evaluate(`(() => {
    const tablist = document.querySelector('[aria-label="Open documents"]');
    if (tablist) tablist.scrollLeft = 400;
  })()`);
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const afterScroll = await inspectFocusedTooltip();
  assert(
    afterScroll.tabRect.left < beforeScroll.tabRect.left - 80,
    `Case C: expected tab left to shift left by > 80px (${beforeScroll.tabRect.left} -> ${afterScroll.tabRect.left})`,
  );
  assert(
    afterScroll.tooltipRect.left < beforeScroll.tooltipRect.left - 80,
    `Case C: expected tooltip left to shift with tab (${beforeScroll.tooltipRect.left} -> ${afterScroll.tooltipRect.left})`,
  );
  assert(
    Math.abs(afterScroll.tooltipRect.left - afterScroll.tabRect.left) <= 1.5,
    `Case C after scroll: tooltip (${afterScroll.tooltipRect.left}) should track tab (${afterScroll.tabRect.left})`,
  );
  assertTooltipWithinBounds(afterScroll, 'Case C (scrolled middle tab)');
}
