import { assert } from './harness.mjs';

const META = 4;

// Windows clipboard text is read back with CRLF even when the app writes LF.
const clipboardText = (text) => (process.platform === 'win32' ? text.replace(/\r\n/g, '\n') : text);

const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;

const visibleViewer = visible('epub-viewer');
const visibleHost = visible('epub-host');
const frame = `${visibleHost}?.querySelector('iframe')`;
const frameDocument = `${frame}?.contentDocument`;
const scroller = `${visibleHost}?.querySelector('.epub-container')`;
const titleIs = (title) =>
  `document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.dataset.documentStem === ${JSON.stringify(title)}`;
const chapterIs = (title) =>
  `[...(${visibleHost}?.querySelectorAll('iframe') ?? [])].some((view) => view.contentDocument?.querySelector('h1')?.textContent === ${JSON.stringify(title)})`;
const excerptEnabled = `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`;

const EXPECTED_PLAIN_TEXT = [
  'def collect_batch(items):',
  '    count = 0',
  '\treturn count + len(items)',
  '$ deploy-tool --cluster staging --region us-west',
  '# (1) synthetic callout comment',
  'LONG_START_TOKEN = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega LONG_END_TOKEN"',
].join('\n');

const EXPECTED_PANDOC_TEXT = [
  'service: synthetic-worker',
  '  endpoint: https://example.invalid/v2/stream?mode=paginated&chunk=4096',
].join('\n');

/** Waits until the paginated strip has stopped moving and only the active frame remains. */
async function waitForTurnToSettle(page) {
  await page.evaluate('delete window.__codeBlockStripSettle');
  await page.waitFor(
    `(() => {
      const container = ${scroller};
      const left = container?.scrollLeft ?? 0;
      const views = ${visibleHost}?.querySelectorAll('iframe').length ?? 0;
      const now = performance.now();
      const state = (window.__codeBlockStripSettle ??= { left, views, since: now });
      if (state.left !== left || state.views !== views) {
        state.left = left;
        state.views = views;
        state.since = now;
        return false;
      }
      return views <= 1 && now - state.since > 200;
    })()`,
    'the page turn to settle',
  );
}

/** WCAG AA contrast probe across all visible text nodes inside the active EPUB chapter iframe. */
async function assertIframeContrast(page, description) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const failures = await page.evaluate(`(() => {
      const host = ${visibleHost};
      const view = host?.querySelector('iframe');
      const doc = view?.contentDocument;
      const win = doc?.defaultView;
      if (!doc?.body || !win) return ['chapter document missing'];
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = '#000';
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
      };
      const over = (top, bottom) => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      });
      const backdrop = (element) => {
        const layers = [];
        for (let node = element; node; node = node.parentElement) {
          const layer = rgba(win.getComputedStyle(node).backgroundColor);
          if (layer.a > 0) layers.push(layer);
          if (layer.a >= 1) break;
        }
        return layers.reduceRight((below, layer) => over(layer, below), {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        });
      };
      const luminance = ({ r, g, b }) => {
        const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      };
      const opaque = (element) => {
        for (let node = element; node; node = node.parentElement) {
          if (Number(win.getComputedStyle(node).opacity) < 1) return false;
        }
        return true;
      };
      const problems = [];
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const element = text.parentElement;
        if (!text.data.trim() || !element?.checkVisibility({ visibilityProperty: true })) continue;
        if (!opaque(element)) continue;
        const background = backdrop(element);
        const foreground = over(rgba(win.getComputedStyle(element).color), background);
        const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        const ratio = (light + 0.05) / (dark + 0.05);
        if (ratio < 4.5) problems.push(text.data.trim().slice(0, 40) + ': ' + ratio.toFixed(2));
      }
      return problems;
    })()`);
    if (failures.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`${description}: iframe text below 4.5:1: ${failures.join('; ')}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Screen point of a visible fragment of `selector` inside the active EPUB host. */
function visibleFragmentPoint(page, selector) {
  return page.evaluate(`(() => {
    const host = ${visibleHost};
    const view = host?.querySelector('iframe');
    const element = view?.contentDocument?.querySelector(${JSON.stringify(selector)});
    if (!host || !view || !element) return null;
    const hr = host.getBoundingClientRect();
    const fr = view.getBoundingClientRect();
    for (const r of element.getClientRects()) {
      const left = Math.max(hr.left, fr.left + r.left);
      const right = Math.min(hr.right, fr.left + r.right);
      const top = Math.max(hr.top, fr.top + r.top);
      const bottom = Math.min(hr.bottom, fr.top + r.bottom);
      if (right - left >= 24 && bottom - top >= 16) {
        return {
          x: left + Math.min(32, (right - left) / 2),
          y: top + Math.min(16, (bottom - top) / 2),
          left,
          right,
          top,
          bottom,
        };
      }
    }
    return null;
  })()`);
}

/** Turns forward in the current chapter until `selector` has a visible fragment inside host bounds. */
async function turnUntilVisible(page, selector, description) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const point = await visibleFragmentPoint(page, selector);
    if (point) return point;
    await page.clickButton('Next Page');
    await waitForTurnToSettle(page);
  }
  throw new Error(`never reached visible element ${selector} (${description})`);
}

/** Sends a true non-pressed pointer move (`buttons: 0`) so hover listeners trigger as in a real mouse hover. */
async function hoverPoint(page, { x, y }) {
  await page.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
  });
}

/** Moves pointer away from any code block so the action pill clears, then hovers `selector`. */
async function hoverCodeBlock(page, selector) {
  await hoverPoint(page, { x: 1, y: 1 });
  await page.waitFor(
    `!document.querySelector('[data-testid="epub-code-copy"]')`,
    'any prior code action pill to dismiss before hovering target',
  );
  const point = await turnUntilVisible(page, selector, `hover target ${selector}`);
  await hoverPoint(page, point);
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-copy"]')?.checkVisibility({ visibilityProperty: true })
      && document.querySelector('[data-testid="epub-code-expand"]')?.checkVisibility({ visibilityProperty: true })`,
    `code block action pill for ${selector}`,
  );
}

/** Clicks a visible element identified by `data-testid` once its geometry has settled. */
async function clickTestId(page, testId) {
  const point = await page.waitFor(
    `(() => {
      const el = [...document.querySelectorAll('[data-testid="${testId}"]')].find((e) =>
        e.checkVisibility({ visibilityProperty: true }),
      );
      if (!el || el.disabled) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const key = JSON.stringify(p);
      const settled = window.__e2eLastTestIdPoint === key;
      window.__e2eLastTestIdPoint = key;
      return settled ? p : null;
    })()`,
    `visible settled [data-testid="${testId}"]`,
  );
  await page.click(point);
}

/** Screen endpoints of `text` inside the visible portion of the current EPUB chapter frame. */
function visibleTextPoints(page, text) {
  return page.waitFor(
    `(() => {
      const host = ${visibleHost};
      const view = host?.querySelector('iframe');
      const book = view?.contentDocument;
      if (!host || !book) return null;
      const hr = host.getBoundingClientRect();
      const outer = view.getBoundingClientRect();
      const walker = book.createTreeWalker(book.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.data.indexOf(${JSON.stringify(text)});
        if (index === -1) continue;
        const range = book.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + ${JSON.stringify(text)}.length);
        const rects = [...range.getClientRects()].filter((r) => {
          if (r.width <= 0 || r.height <= 0) return false;
          const left = outer.left + r.left;
          const right = outer.left + r.right;
          const top = outer.top + r.top;
          const bottom = outer.top + r.bottom;
          return left >= hr.left - 1 && right <= hr.right + 1 && top >= hr.top - 1 && bottom <= hr.bottom + 1;
        });
        if (rects.length === 0) continue;
        const first = rects[0];
        const last = rects[rects.length - 1];
        return {
          start: { x: outer.left + first.left + 0.5, y: outer.top + first.top + first.height / 2 },
          end: { x: outer.left + last.right - 0.5, y: outer.top + last.top + last.height / 2 },
        };
      }
      return null;
    })()`,
    `visible text in EPUB chapter: ${text}`,
  );
}

/** Reads all numbered `line_NNN` entries visible inside host bounds, and reports any clipped rects. */
async function scanVisibleChapterTwoLines(page) {
  return page.evaluate(`(() => {
    const host = ${visibleHost};
    const view = host?.querySelector('iframe');
    const doc = view?.contentDocument;
    const code = doc?.querySelector('#tall-block code');
    if (!host || !view || !doc || !code) return null;
    const hr = host.getBoundingClientRect();
    const fr = view.getBoundingClientRect();
    const textNode = code.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
    const data = textNode.data;
    const seen = [];
    const clipped = [];
    const regex = /line_(\\d{3}) = [^\\n]*/g;
    for (let match = regex.exec(data); match; match = regex.exec(data)) {
      const label = 'line_' + match[1];
      const range = doc.createRange();
      range.setStart(textNode, match.index);
      range.setEnd(textNode, match.index + match[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 0);
      let anyInside = false;
      for (const r of rects) {
        const left = fr.left + r.left;
        const right = fr.left + r.right;
        const top = fr.top + r.top;
        const bottom = fr.top + r.bottom;
        const overlapsHost =
          right > hr.left + 2 && left < hr.right - 2 && bottom > hr.top + 2 && top < hr.bottom - 2;
        if (!overlapsHost) continue;
        const fullyInside =
          left >= hr.left - 2 && right <= hr.right + 2 && top >= hr.top - 2 && bottom <= hr.bottom + 2;
        if (!fullyInside) {
          clipped.push({
            label,
            rect: { left, right, top, bottom },
            host: { left: hr.left, right: hr.right, top: hr.top, bottom: hr.bottom },
          });
        } else {
          anyInside = true;
        }
      }
      if (anyInside) seen.push(label);
    }
    const container = ${scroller};
    return {
      seen,
      clipped,
      scrollLeft: container?.scrollLeft ?? 0,
      scrollWidth: container?.scrollWidth ?? 0,
      clientWidth: container?.clientWidth ?? 0,
    };
  })()`);
}

/** Walks Chapter Two page by page, verifying all 95 lines appear without vertical or horizontal clipping. */
async function verifyTallCodeBlockAcrossPages(page, modeName, minTurns) {
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('Chapter Two');
  await page.waitFor(chapterIs('Chapter Two'), `Chapter Two in ${modeName}`);
  await page.hideSidebar();
  await page.waitForReaderLayout();
  await waitForTurnToSettle(page);

  const seenAll = new Set();
  let pageTurns = 0;

  for (let step = 0; step < 30; step += 1) {
    const scan = await scanVisibleChapterTwoLines(page);
    assert(scan !== null, `Chapter Two scan failed in ${modeName} at step ${step}`);
    assert(
      scan.clipped.length === 0,
      `clipped code lines in ${modeName} at step ${step}: ${JSON.stringify(scan.clipped)}`,
    );
    if (step === 0) {
      assert(
        !scan.seen.includes('line_095'),
        `${modeName}: line_095 must not fit on the first page/spread`,
      );
    }
    for (const line of scan.seen) seenAll.add(line);
    if (seenAll.has('line_095') && scan.scrollLeft + scan.clientWidth >= scan.scrollWidth - 4) {
      break;
    }
    const beforeLeft = scan.scrollLeft;
    await page.clickButton('Next Page');
    await waitForTurnToSettle(page);
    pageTurns += 1;
    const afterLeft = await page.evaluate(`${scroller}?.scrollLeft ?? 0`);
    if (afterLeft === beforeLeft) break;
  }

  assert(
    pageTurns >= minTurns,
    `${modeName}: 95-line block must span >= ${minTurns + 1} pages/spreads (>= ${minTurns} turns), took ${pageTurns}`,
  );
  assert(seenAll.has('line_001'), `${modeName}: line_001 was visible inside host bounds`);
  assert(
    seenAll.has('line_048'),
    `${modeName}: middle wide line_048 was visible inside host bounds`,
  );
  assert(seenAll.has('line_095'), `${modeName}: line_095 was visible inside host bounds`);
  const missing = [];
  for (let i = 1; i <= 95; i += 1) {
    const label = `line_${String(i).padStart(3, '0')}`;
    if (!seenAll.has(label)) missing.push(label);
  }
  assert(missing.length === 0, `${modeName}: missing lines across pages: ${missing.join(', ')}`);
}

/**
 * #104: EPUB code blocks preserve formatting, contrast, multi-page continuity,
 * hanging wrap indent, Copy/Expand actions, keyboard/wheel isolation, selection,
 * search, and annotation persistence.
 */
export async function epubCodeBlocksFlow(page) {
  await page.cdp.send('Browser.grantPermissions', {
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    origin: await page.evaluate('location.origin'),
  });

  await page.openUntil(`${visibleHost} && ${titleIs('sample-code')}`, 'the sample-code EPUB');
  await page.evaluate(`
    [...document.querySelectorAll('[aria-label^="Close "]')]
      .filter((button) => button.closest('[data-document-stem]')?.dataset.documentStem !== 'sample-code')
      .forEach((button) => button.click());
  `);
  await page.waitFor(
    `document.querySelectorAll('[role="tab"]').length === 1`,
    'only the sample-code tab remaining open',
  );
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One to render');
  await page.waitForReaderLayout();

  // 1. Inline <code> stays inline monospace; <pre> overrides hostile CSS and scales with reading font size.
  const initialStyles = await page.evaluate(`(() => {
    const doc = ${frameDocument};
    const inlineCode = doc?.querySelector('p code');
    const pre = doc?.querySelector('#plain-block');
    if (!inlineCode || !pre) return null;
    const inlineStyle = doc.defaultView.getComputedStyle(inlineCode);
    const preStyle = doc.defaultView.getComputedStyle(pre);
    return {
      inline: {
        display: inlineStyle.display,
        fontFamily: inlineStyle.fontFamily,
      },
      pre: {
        overflowX: preStyle.overflowX,
        overflowY: preStyle.overflowY,
        wordBreak: preStyle.wordBreak,
        overflowWrap: preStyle.overflowWrap,
        fontFamily: preStyle.fontFamily,
        fontSize: parseFloat(preStyle.fontSize),
      },
    };
  })()`);
  assert(initialStyles !== null, 'inline code and #plain-block exist');
  assert(
    initialStyles.inline.display === 'inline',
    `inline <code> display must stay inline, got ${initialStyles.inline.display}`,
  );
  assert(
    /mono/i.test(initialStyles.inline.fontFamily),
    `inline <code> must use monospace font: ${initialStyles.inline.fontFamily}`,
  );
  assert(
    initialStyles.pre.overflowX === 'visible' && initialStyles.pre.overflowY === 'visible',
    `<pre> overflow must be visible, got ${initialStyles.pre.overflowX}/${initialStyles.pre.overflowY}`,
  );
  assert(
    initialStyles.pre.wordBreak === 'normal',
    `<pre> word-break must be normal, got ${initialStyles.pre.wordBreak}`,
  );
  assert(
    initialStyles.pre.overflowWrap === 'anywhere',
    `<pre> overflow-wrap must be anywhere, got ${initialStyles.pre.overflowWrap}`,
  );
  assert(
    /mono/i.test(initialStyles.pre.fontFamily),
    `<pre> must use monospace font: ${initialStyles.pre.fontFamily}`,
  );

  // Scale reading font size via view.zoomIn (⌘=) to 160%+ and verify <pre> scales proportionally.
  for (let step = 0; step < 6; step += 1) {
    await page.press('=', 'Equal', META);
  }
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `parseInt(document.querySelector('[data-testid="reading-font-size"]')?.textContent ?? '0', 10) >= 160`,
    'reading font size reaches 160%+',
  );
  const scaledPreFontPx = await page.waitFor(
    `(() => {
      const pre = ${frameDocument}?.querySelector('#plain-block');
      if (!pre) return null;
      const size = parseFloat(${frameDocument}.defaultView.getComputedStyle(pre).fontSize);
      return size >= ${initialStyles.pre.fontSize * 1.5} ? size : null;
    })()`,
    '<pre> font size scaling to 160%+',
  );
  assert(
    Math.abs(scaledPreFontPx - initialStyles.pre.fontSize * 1.6) < 0.75,
    `<pre> font size scaled from ${initialStyles.pre.fontSize} to ${scaledPreFontPx}`,
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover closed after font check',
  );
  // Restore 100% font size via Actual Size (⌘0).
  await page.press('0', 'Digit0', META);
  await page.waitFor(
    `(() => {
      const pre = ${frameDocument}?.querySelector('#plain-block');
      if (!pre) return false;
      const size = parseFloat(${frameDocument}.defaultView.getComputedStyle(pre).fontSize);
      return Math.abs(size - ${initialStyles.pre.fontSize}) < 0.5;
    })()`,
    '<pre> font size returning to 100%',
  );
  await page.waitForReaderLayout();

  // 2. Hanging wrap indent: wrapped long line inside <pre> has continuation left > start left.
  await turnUntilVisible(page, '#plain-block', 'hanging wrap indent check');
  const wrapRects = await page.evaluate(`(() => {
    const doc = ${frameDocument};
    const code = doc?.querySelector('#plain-block code');
    const textNode = code?.firstChild;
    if (!doc || !textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
    const startIdx = textNode.data.indexOf('LONG_START_TOKEN');
    const endIdx = textNode.data.indexOf('LONG_END_TOKEN"');
    if (startIdx < 0 || endIdx < 0) return null;
    const range = doc.createRange();
    range.setStart(textNode, startIdx);
    range.setEnd(textNode, endIdx + 'LONG_END_TOKEN"'.length);
    const rects = [...range.getClientRects()]
      .filter((r) => r.width > 1 && r.height > 0)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    const lines = [];
    for (const r of rects) {
      const last = lines.at(-1);
      if (!last || Math.abs(r.top - last.top) > 4) {
        lines.push({ top: r.top, left: r.left });
      } else {
        last.left = Math.min(last.left, r.left);
      }
    }
    const hostRect = ${visibleHost}.getBoundingClientRect();
    const frameRect = ${frame}.getBoundingClientRect();
    return {
      lines,
      maxRight: Math.max(...rects.map((r) => frameRect.left + r.right)),
      hostRight: hostRect.right,
    };
  })()`);
  assert(
    wrapRects !== null && wrapRects.lines.length >= 2,
    `long line must wrap onto 2+ visual lines: ${JSON.stringify(wrapRects)}`,
  );
  assert(
    wrapRects.lines[1].left > wrapRects.lines[0].left + 4,
    `hanging wrap indent must shift continuation line right: ${JSON.stringify(wrapRects.lines)}`,
  );
  assert(
    wrapRects.maxRight <= wrapRects.hostRight + 2,
    `wrapped line must not overflow host right edge: ${JSON.stringify(wrapRects)}`,
  );

  // 3. Clicking Pandoc aria-hidden="true" anchor inside <pre> does NOT open link-peek.
  await turnUntilVisible(page, '#cb1 pre', 'Pandoc anchor click test');
  await page.evaluate(`(() => {
    const anchor = ${frameDocument}?.querySelector('#cb1 a[aria-hidden="true"]');
    if (!anchor) throw new Error('missing Pandoc aria-hidden anchor');
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  })()`);
  await new Promise((done) => setTimeout(done, 150));
  assert(
    !(await page.evaluate(`document.querySelector('[data-testid="link-peek"]')`)),
    'clicking Pandoc aria-hidden anchor inside <pre> must not open link-peek',
  );
  assert(
    await page.evaluate(chapterIs('Chapter One')),
    'Pandoc aria-hidden click stays on Chapter One',
  );

  // 4. Hovering <pre> shows Copy + Expand and copies exact source text for BOTH plain and Pandoc blocks.
  await hoverCodeBlock(page, '#plain-block');
  await clickTestId(page, 'epub-code-copy');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-copy"]')?.textContent?.includes('Copied')`,
    'Copy button shows Copied feedback',
  );
  const copiedPlain = await page.evaluate('navigator.clipboard.readText()');
  assert(
    clipboardText(copiedPlain) === EXPECTED_PLAIN_TEXT,
    `plain block clipboard mismatch:\nEXPECTED: ${JSON.stringify(EXPECTED_PLAIN_TEXT)}\nACTUAL:   ${JSON.stringify(copiedPlain)}`,
  );

  await hoverCodeBlock(page, '#cb1 pre');
  await clickTestId(page, 'epub-code-copy');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-copy"]')?.textContent?.includes('Copied')`,
    'Pandoc Copy button shows Copied feedback',
  );
  const copiedPandoc = await page.evaluate('navigator.clipboard.readText()');
  assert(
    clipboardText(copiedPandoc) === EXPECTED_PANDOC_TEXT,
    `Pandoc block clipboard mismatch:\nEXPECTED: ${JSON.stringify(EXPECTED_PANDOC_TEXT)}\nACTUAL:   ${JSON.stringify(copiedPandoc)}`,
  );

  // 5. Expanded Code Dialog: unwrapped overflow, wheel isolation, Wrap toggle, Copy, Esc close.
  await hoverCodeBlock(page, '#plain-block');
  await clickTestId(page, 'epub-code-expand');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-dialog"]')?.checkVisibility({ visibilityProperty: true })`,
    'expanded code dialog to open',
  );
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-dialog-scroll"]')`,
    'expanded code viewport to take focus on open',
  );
  const dialogInitial = await page.evaluate(`(() => {
    const dialog = document.querySelector('[data-testid="epub-code-dialog"]');
    const count = dialog.querySelector('[data-testid="epub-code-line-count"]')?.textContent?.trim();
    const wrapBtn = dialog.querySelector('[data-testid="epub-code-wrap-toggle"]');
    const scrollEl = dialog.querySelector('[data-testid="epub-code-dialog-scroll"]');
    const preEl = dialog.querySelector('[data-testid="epub-code-dialog-pre"]');
    const r = scrollEl.getBoundingClientRect();
    return {
      count,
      headerText: dialog.textContent,
      wrapPressed: wrapBtn?.getAttribute('aria-pressed'),
      scrollWidth: scrollEl.scrollWidth,
      clientWidth: scrollEl.clientWidth,
      whiteSpace: getComputedStyle(preEl).whiteSpace,
      center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    };
  })()`);
  assert(
    dialogInitial.count === '6 lines',
    `expected 6 lines in dialog header, got ${JSON.stringify(dialogInitial.count)}`,
  );
  assert(
    dialogInitial.wrapPressed === 'false',
    `dialog wrap toggle starts off: ${dialogInitial.wrapPressed}`,
  );
  assert(
    dialogInitial.scrollWidth > dialogInitial.clientWidth,
    `unwrapped dialog code must overflow horizontally (${dialogInitial.scrollWidth} <= ${dialogInitial.clientWidth})`,
  );

  // Wheel / horizontal swipe events on the dialog must not turn the EPUB page behind it.
  const epubLeftBeforeWheel = await page.evaluate(`${scroller}?.scrollLeft ?? 0`);
  await page.wheel(dialogInitial.center, 120);
  await page.swipe(dialogInitial.center, 120, { steps: 3, gapMs: 20 });
  await new Promise((done) => setTimeout(done, 250));
  const epubLeftAfterWheel = await page.evaluate(`${scroller}?.scrollLeft ?? 0`);
  assert(
    epubLeftAfterWheel === epubLeftBeforeWheel,
    `wheel on expanded code dialog turned EPUB behind it: ${epubLeftBeforeWheel} -> ${epubLeftAfterWheel}`,
  );
  assert(await page.evaluate(chapterIs('Chapter One')), 'dialog wheel stays on Chapter One');

  // Toggle Wrap inside dialog.
  await clickTestId(page, 'epub-code-wrap-toggle');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-wrap-toggle"]')?.getAttribute('aria-pressed') === 'true'`,
    'Wrap toggle aria-pressed to become true',
  );
  const dialogWrapped = await page.evaluate(`(() => {
    const scrollEl = document.querySelector('[data-testid="epub-code-dialog-scroll"]');
    const preEl = document.querySelector('[data-testid="epub-code-dialog-pre"]');
    const style = getComputedStyle(preEl);
    return {
      scrollWidth: scrollEl.scrollWidth,
      clientWidth: scrollEl.clientWidth,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      overflowWrap: style.overflowWrap,
    };
  })()`);
  assert(
    dialogWrapped.whiteSpace === 'pre-wrap' &&
      dialogWrapped.wordBreak === 'normal' &&
      dialogWrapped.overflowWrap === 'anywhere',
    `wrapped dialog <pre> styles mismatch: ${JSON.stringify(dialogWrapped)}`,
  );
  assert(
    dialogWrapped.scrollWidth <= dialogWrapped.clientWidth + 2,
    `wrapped dialog code must fit width (${dialogWrapped.scrollWidth} > ${dialogWrapped.clientWidth})`,
  );

  // Copy inside dialog.
  await clickTestId(page, 'epub-code-dialog-copy');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-dialog-copy"]')?.textContent?.includes('Copied')`,
    'dialog Copy button shows Copied feedback',
  );
  const copiedFromDialog = await page.evaluate('navigator.clipboard.readText()');
  assert(
    clipboardText(copiedFromDialog) === EXPECTED_PLAIN_TEXT,
    `dialog clipboard mismatch:\nEXPECTED: ${JSON.stringify(EXPECTED_PLAIN_TEXT)}\nACTUAL:   ${JSON.stringify(copiedFromDialog)}`,
  );

  // Escape closes dialog and restores focus.
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="epub-code-dialog"]')`,
    'Escape closes expanded code dialog',
  );
  assert(
    await page.evaluate(`document.activeElement !== document.body`),
    'focus returned cleanly after closing expanded code dialog',
  );

  // 5b. Keyboard-only flow: Tab from toolbar into ordinary <pre>, pill Copy/Expand via Tab/Shift+Tab/Enter.
  await hoverPoint(page, { x: 1, y: 1 });
  await page.waitFor(
    `!document.querySelector('[data-testid="epub-code-copy"]')`,
    'action pill dismissed before keyboard-only flow',
  );
  await page.waitFor(
    `${frameDocument}?.querySelector('#plain-block')?.getAttribute('tabindex') === '0'`,
    'ordinary <pre> has managed tabindex="0"',
  );
  await page.evaluate(`${visibleHost}?.focus({ preventScroll: true })`);
  await page.waitFor(
    `document.activeElement === ${visibleHost}`,
    'epub-host focused before tabbing into chapter',
  );
  await page.press('Tab', 'Tab');
  await page.waitFor(
    `${frameDocument}?.activeElement?.id === 'plain-block'
      && document.querySelector('[data-testid="epub-code-copy"]')?.checkVisibility({ visibilityProperty: true })`,
    'Tab from reader host focuses #plain-block and shows action pill',
  );
  await page.press('Tab', 'Tab');
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-copy"]')`,
    'Tab from focused <pre> moves focus to Copy button',
  );
  await page.evaluate(`navigator.clipboard.writeText('__stale__')`);
  await page.press('Enter', 'Enter');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-copy"]')?.textContent?.includes('Copied')`,
    'Enter on keyboard-focused Copy button shows Copied feedback',
  );
  const keyboardCopied = await page.evaluate('navigator.clipboard.readText()');
  assert(
    clipboardText(keyboardCopied) === EXPECTED_PLAIN_TEXT,
    `keyboard copy mismatch:\nEXPECTED: ${JSON.stringify(EXPECTED_PLAIN_TEXT)}\nACTUAL:   ${JSON.stringify(keyboardCopied)}`,
  );
  await page.press('Tab', 'Tab');
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-expand"]')`,
    'Tab moves focus from Copy to Expand button',
  );
  await page.press('Tab', 'Tab', 8);
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-copy"]')`,
    'Shift+Tab moves focus back from Expand to Copy',
  );
  await page.press('Tab', 'Tab', 8);
  await page.waitFor(
    `${frameDocument}?.activeElement?.id === 'plain-block'`,
    'Shift+Tab on Copy returns focus to #plain-block',
  );
  await page.press('Tab', 'Tab');
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-copy"]')`,
    'Tab returns focus to Copy',
  );
  await page.press('Tab', 'Tab');
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="epub-code-expand"]')`,
    'Tab returns focus to Expand',
  );
  await page.press('Enter', 'Enter');
  await page.waitFor(
    `document.querySelector('[data-testid="epub-code-dialog"]')?.checkVisibility({ visibilityProperty: true })`,
    'Enter on Expand opens expanded code dialog',
  );
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="epub-code-dialog"]')`,
    'Escape closes expanded dialog opened via keyboard',
  );

  // 6. Narrow (960x600) & wide (1440x900) viewports across Light, Sepia, and Dark themes (iframe + overlay/dialog >= 4.5:1).
  for (const viewport of [
    { width: 960, height: 600 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewport(viewport.width, viewport.height);
    await page.waitForReaderLayout();
    for (const theme of ['Light', 'Sepia', 'Dark']) {
      await page.clickButton('Reading appearance');
      await page.clickButton(theme);
      await page.waitFor(
        `${visibleViewer}?.dataset.resolvedTheme === '${theme.toLowerCase()}'`,
        `${theme} theme at ${viewport.width}x${viewport.height}`,
      );
      await page.press('Escape');
      await page.waitFor(
        `!document.querySelector('[data-testid="appearance-popover"]')`,
        'appearance popover closed before contrast probe',
      );
      await assertIframeContrast(
        page,
        `Chapter One iframe ${theme} ${viewport.width}x${viewport.height}`,
      );
      await hoverCodeBlock(page, '#plain-block');
      await page.assertContrast(
        '[data-testid="unified-toolbar"], [aria-label="Document reader"]',
        `Reader chrome & pill ${theme} ${viewport.width}x${viewport.height}`,
      );
      await clickTestId(page, 'epub-code-expand');
      await page.waitFor(
        `document.querySelector('[data-testid="epub-code-dialog"]')`,
        `dialog in ${theme} ${viewport.width}x${viewport.height}`,
      );
      await page.assertContrast(
        '[data-testid="epub-code-dialog"]',
        `Expanded code dialog ${theme} ${viewport.width}x${viewport.height}`,
      );
      await page.press('Escape');
      await page.waitFor(
        `!document.querySelector('[data-testid="epub-code-dialog"]')`,
        'dialog closed after contrast probe',
      );
    }
  }
  await page.clickButton('Reading appearance');
  await page.clickButton('Auto');
  await page.press('Escape');
  await page.resetViewport();
  await page.waitForReaderLayout();

  // 7. Multi-page 95-line <pre> in Two pages and Single page modes: zero clipped or missing lines.
  await page.clickButton('Two pages');
  await page.waitFor(`${visibleViewer}?.dataset.readingMode === 'spread'`, 'Two pages mode');
  await verifyTallCodeBlockAcrossPages(page, 'Two pages', 1);

  await page.clickButton('Single page');
  await page.waitFor(`${visibleViewer}?.dataset.readingMode === 'paged'`, 'Single page mode');
  await verifyTallCodeBlockAcrossPages(page, 'Single page', 2);

  // 8. Selection inside <pre> -> Excerpt to MindMap, Find (⌘F) inside code block, Highlight, Bookmark, and Reopen persistence.
  await page.clickButton('Show MindMap');
  await page.showSidebarTab('Table of Contents');
  await page.clickTreeItem('Chapter One');
  await page.waitFor(chapterIs('Chapter One'), 'Chapter One before selection excerpt');
  await page.hideSidebar();
  await page.waitForReaderLayout();

  await turnUntilVisible(page, '#plain-block', 'plain-block visible for selection');
  const excerptTarget = 'deploy-tool --cluster staging';
  const excerptPoints = await visibleTextPoints(page, excerptTarget);
  await page.drag(excerptPoints.start, excerptPoints.end);
  await page.waitFor(
    `document.querySelector('[data-testid="selection-popover"]')`,
    'selection popover inside <pre>',
  );
  assert(
    !(await page.evaluate(`document.querySelector('[data-testid="epub-code-copy"]')`)),
    'code action pill is suppressed while selection popover is open',
  );
  await page.waitFor(excerptEnabled, 'Excerpt to MindMap enabled for code selection');
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector(${JSON.stringify(`[aria-label^="Jump to source of ${excerptTarget} ("]`)})`,
    'MindMap card created from <pre> selection',
  );
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id] rect')`,
    'highlight drawn inside Chapter One <pre>',
  );
  await page.clickButton('Hide MindMap');
  await page.waitForReaderLayout();

  // Find (⌘F) into Chapter Two's tall code block.
  await page.press('f', 'KeyF', META);
  await page.waitFor(
    `document.activeElement === document.querySelector('[data-testid="search-input"]')`,
    '⌘F focuses search input',
  );
  await page.setInputValue('[data-testid="search-input"]', 'line_048');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="search-status"]')?.textContent === '1 of 1'`,
    'Find matches line_048 inside Chapter Two code block',
  );
  await page.waitFor(chapterIs('Chapter Two'), 'Find jumped to Chapter Two');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id="__search_active__"] rect')`,
    'active search highlight inside #tall-block',
  );
  await page.leaveSearch();
  await page.waitForReaderLayout();

  // Bookmark current location & create independent highlight on line_048 inside #tall-block.
  await page.clickButton('Bookmark current location');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="toggle-bookmark-button"]')?.getAttribute('aria-pressed') === 'true'`,
    'bookmark toggle pressed on line_048 page',
  );
  const line48Points = await visibleTextPoints(page, 'line_048 = "middle');
  await page.drag(line48Points.start, line48Points.end);
  await page.waitFor(
    `document.querySelector('[data-testid="selection-popover"]')`,
    'selection popover on line_048',
  );
  await page.clickButton('Yellow highlight');
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id] rect')`,
    'highlight painted on line_048 inside #tall-block',
  );

  // Wait past cursor save debounce, close tab, reopen from Recent documents, verify position + highlight + bookmark.
  await new Promise((done) => setTimeout(done, 700));
  await page.evaluate(
    `document.querySelector('[data-document-stem="sample-code"] button[aria-label^="Close"]')?.click()`,
  );
  await page.waitFor(`!${visibleHost}`, 'sample-code tab to close');

  await page.clickButton('Recent documents');
  await page.waitFor(
    `document.querySelector('[data-testid="recent-documents-menu"]')`,
    'Recent documents menu to open',
  );
  await page.evaluate(`
    [...document.querySelectorAll('[data-testid="recent-document-item"]')]
      .find((item) => item.dataset.documentStem === 'sample-code')
      ?.click();
  `);
  await page.waitFor(`${visibleHost} && ${titleIs('sample-code')}`, 'sample-code reopened');
  await page.waitFor(chapterIs('Chapter Two'), 'reopened sample-code restored Chapter Two');
  await page.waitForReaderLayout();
  await page.waitFor(
    `${visibleHost}?.querySelector('g[data-annotation-id] rect')`,
    'reopened sample-code repainted highlight inside <pre>',
  );
  const line48Restored = await visibleTextPoints(page, 'line_048 = "middle');
  assert(line48Restored !== null, 'reopened sample-code restored exact page containing line_048');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"] [data-testid="toggle-bookmark-button"]')?.getAttribute('aria-pressed') === 'true'`,
    'reopened sample-code preserved bookmark state',
  );
}
