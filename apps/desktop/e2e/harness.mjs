// A small end-to-end harness with no dependencies: it serves the production bundle
// under the app's real CSP and drives system Chromium over the DevTools protocol.
// The app runs on the memory backend here, so nothing is saved.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

const DIST = resolve(import.meta.dirname, '../dist');
const TAURI_CONFIG = resolve(import.meta.dirname, '../src-tauri/tauri.conf.json');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

export function serveDist() {
  const { csp } = JSON.parse(readFileSync(TAURI_CONFIG, 'utf8')).app.security;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
    const file = join(DIST, relative);
    if (!file.startsWith(DIST + sep) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    // As in Tauri, only documents carry the policy.
    const headers = { 'Content-Type': type };
    if (type === 'text/html') headers['Content-Security-Policy'] = csp;
    response.writeHead(200, headers).end(readFileSync(file));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#socket = new WebSocket(url);
    await new Promise((done, fail) => {
      cdp.#socket.addEventListener('open', done, { once: true });
      cdp.#socket.addEventListener('error', fail, { once: true });
    });
    cdp.#socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const { done, fail } = cdp.#pending.get(message.id);
        cdp.#pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      } else {
        for (const listener of cdp.#listeners.get(message.method) ?? []) listener(message.params);
      }
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((done, fail) => {
      this.#pending.set(id, { done, fail });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Runs in the page. Colors go through a canvas, which resolves any CSS color
 * syntax (oklch included) to sRGB, and translucent backgrounds are composited
 * down to the first opaque one.
 */
const CONTRAST_PROBE = `(rootSelector) => {
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
      const layer = rgba(getComputedStyle(node).backgroundColor);
      if (layer.a > 0) layers.push(layer);
      if (layer.a >= 1) break;
    }
    return layers.reduceRight((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
  };
  const luminance = ({ r, g, b }) => {
    const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const opaque = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  };
  const failures = [];
  for (const root of document.querySelectorAll(rootSelector)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const element = text.parentElement;
      if (!text.data.trim() || !element?.checkVisibility({ visibilityProperty: true })) continue;
      if (element.closest(':disabled, [aria-disabled="true"]') || !opaque(element)) continue;
      const background = backdrop(element);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);
      if (ratio < 4.5) failures.push(text.data.trim().slice(0, 40) + ': ' + ratio.toFixed(2));
    }
  }
  return failures;
}`;

export class Page {
  errors = [];

  constructor(cdp) {
    this.cdp = cdp;
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
      this.errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text),
    );
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error')
        this.errors.push(args.map((arg) => arg.value ?? arg.description).join(' '));
    });
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  async waitFor(expression, description = expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A DOM node cannot cross the protocol by value, and only its presence matters.
      const value = await this.evaluate(`(() => {
        const value = (${expression});
        return value instanceof Node ? true : value;
      })()`);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  /**
   * Resizes the viewport, as dragging the window edge would, and waits past the
   * readers' debounced re-layout (150 ms).
   */
  async setViewport(width, height = 900) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.waitFor(`window.innerWidth === ${width}`, `a ${width} px viewport`);
    await new Promise((done) => setTimeout(done, 600));
  }

  /**
   * Text in `rootSelector` whose contrast with what is painted beneath it falls
   * below WCAG AA (4.5:1). Disabled controls are exempt, as WCAG exempts them.
   */
  async contrastFailures(rootSelector) {
    return this.evaluate(`(${CONTRAST_PROBE})(${JSON.stringify(rootSelector)})`);
  }

  /** Fails unless `rootSelector`'s text meets AA once color transitions settle. */
  async assertContrast(rootSelector, description) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const failures = await this.contrastFailures(rootSelector);
      if (failures.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`${description}: text below 4.5:1: ${failures.join('; ')}`);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : button,
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount,
    });
  }

  /** A real press, drag, and release, which is what makes the browser select text. */
  async drag(from, to) {
    await this.mouse('mouseMoved', from.x, from.y);
    await this.mouse('mousePressed', from.x, from.y);
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
        button: 'left',
        buttons: 1,
      });
    }
    await this.mouse('mouseReleased', to.x, to.y);
  }

  /**
   * A real wheel event. `modifiers` is the DevTools bit field (Ctrl 2), and Chromium
   * reports a trackpad pinch as exactly this: a wheel with Ctrl held.
   */
  async wheel({ x, y }, deltaY, modifiers = 0) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      modifiers,
    });
  }

  async click({ x, y }) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  /**
   * Clicks the button named `name` where it is when the press arrives. The button can
   * still move between finding it and the press (a popover opening on a slow macOS
   * runner), and a press that lands beside a popover closes it. So the press is
   * checked as it is dispatched: one that would land elsewhere is swallowed by
   * `CLICK_GUARD` before the app sees it, and the click is tried again.
   */
  async clickButton(name) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const point = await this.waitFor(
        `(() => {
          const button = [...document.querySelectorAll('button')].find(
            (b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === ${JSON.stringify(name)}
              && !b.disabled && b.checkVisibility({ visibilityProperty: true }));
          if (!button) return null;
          const r = button.getBoundingClientRect();
          const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          // Only once it (and any popover it sits in, whose height grows as its top shifts)
          // has stopped moving, its popover has finished opening, and nothing covers it.
          const popoverElement = button.closest('[data-reader-popover]');
          const popover = popoverElement?.getBoundingClientRect();
          const key = JSON.stringify({ point, ph: popover?.height ?? 0, py: popover?.y ?? 0 });
          const settled = window.__e2eLastButtonPoint === key;
          window.__e2eLastButtonPoint = key;
          if (!settled) return null;
          if (popoverElement?.getAnimations().some((a) => a.playState === 'running')) return null;
          if (!button.contains(document.elementFromPoint(point.x, point.y))) return null;
          window.__e2eClickGuard.arm(button);
          return point;
        })()`,
        `an enabled, visible, uncovered button named ${name}`,
      );
      await this.click(point);
      const { hit, missed } = await this.evaluate('window.__e2eClickGuard.disarm()');
      if (hit && !missed) return;
      console.log(`     a click on ${name} landed off the button; trying again`);
    }
    throw new Error(`clicks on ${name} kept landing off the button`);
  }

  /**
   * A real key press (keydown and keyup) to whatever has focus. `modifiers` is the
   * DevTools bit field: Alt 1, Ctrl 2, Meta 4, Shift 8.
   */
  async press(key, code = key, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: key === 'Escape' ? 27 : 0,
      });
    }
  }

  /** Types `text` into whatever has focus, as the keyboard would. */
  async typeText(text) {
    await this.cdp.send('Input.insertText', { text });
  }

  /**
   * Enters focus mode from its toolbar button, then moves the pointer and focus to
   * `pageSelector` and waits for the idle toolbar to slide away.
   */
  async enterFocusMode(pageSelector) {
    await this.clickButton('Enter focus mode');
    await this.waitFor(
      `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.immersive === 'true'`,
      'focus mode',
    );
    // Hover and focus in the toolbar hold it open, so put both on the page.
    const center = await this.evaluate(`(() => {
      const r = (${pageSelector}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await this.mouse('mouseMoved', center.x, center.y);
    await this.evaluate(`(${pageSelector}).focus({ preventScroll: true })`);
    await this.waitFor(
      `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.hidden === 'true'`,
      'the idle toolbar to hide in focus mode',
    );
  }

  /** Fails if the hidden toolbar comes back within `ms`. */
  async assertToolbarStaysHidden(description, ms = 600) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hidden = await this.evaluate(
        `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.hidden === 'true'`,
      );
      if (!hidden) throw new Error(`the toolbar came back: ${description}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  /** Whether the app is in focus mode. */
  inFocusMode() {
    return this.evaluate(
      `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.immersive === 'true'`,
    );
  }

  /** Leaves Find as a reader would: Esc in the field clears it and returns focus to the page. */
  async leaveSearch() {
    await this.evaluate(`document.querySelector('[data-testid="search-input"]').focus()`);
    await this.press('Escape');
    await this.waitFor(
      `document.querySelector('[data-testid="search-input"]').value === ''
        && !document.querySelector('[data-testid="document-search-field"]').contains(document.activeElement)
        && document.activeElement !== document.body`,
      'Esc to clear the search and return focus to the page',
    );
  }

  /** Clicks a table-of-contents entry by its full title. */
  async clickTreeItem(name) {
    const point = await this.waitFor(
      `(() => {
        const item = [...document.querySelectorAll('[role="treeitem"]')].find(
          (e) => e.getAttribute('aria-label') === ${JSON.stringify(name)}
            && e.checkVisibility({ visibilityProperty: true }));
        if (!item) return null;
        item.scrollIntoView({ block: 'nearest' });
        const r = item.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      `a visible outline entry named ${name}`,
    );
    await this.click(point);
  }

  /** Expands a collapsed table-of-contents branch from its disclosure triangle. */
  async expandTreeItem(name) {
    await this.waitFor(
      `(() => {
        const item = [...document.querySelectorAll('[role="treeitem"]')].find(
          (e) => e.getAttribute('aria-label') === ${JSON.stringify(name)}
            && e.checkVisibility({ visibilityProperty: true }));
        if (!item) return false;
        if (item.getAttribute('aria-expanded') === 'false') {
          item.querySelector('[data-testid="toc-disclosure"]').click();
        }
        return true;
      })()`,
      `a visible outline branch named ${name}`,
    );
  }

  /** Opens the reader's Navigator sidebar if needed and selects the tab named `name`. */
  async showSidebarTab(name) {
    const tabVisible = await this.evaluate(
      `[...document.querySelectorAll('[role="tab"]')].some(
        (t) => t.getAttribute('aria-label') === ${JSON.stringify(name)}
          && t.checkVisibility({ visibilityProperty: true }))`,
    );
    if (!tabVisible) await this.clickButton('Sidebar');
    await this.clickButton(name);
  }

  /** Puts the reader's Navigator sidebar away if it is showing. */
  async hideSidebar() {
    const shown = await this.evaluate(
      `[...document.querySelectorAll('[data-testid="navigator-sidebar"]')].some(
        (e) => e.checkVisibility({ visibilityProperty: true }))`,
    );
    if (shown) await this.clickButton('Sidebar');
  }

  /**
   * Waits until the visible reader has re-laid out for its pane. Opening or closing
   * the sidebar resizes the pane at once, but each reader re-lays out after a 150 ms
   * debounce (and PDF re-renders its pages), so text measured before then moves.
   */
  async waitForReaderLayout() {
    const signature = `(() => {
      const pane = [...document.querySelectorAll('[aria-label="Document reader"] > div:last-child > div')]
        .find((e) => e.checkVisibility({ visibilityProperty: true }));
      if (!pane) return '';
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const probes = [...pane.querySelectorAll('.textLayer span, [data-unit], iframe')].slice(0, 8);
      return JSON.stringify(probes.map((e) => {
        if (!(e instanceof HTMLIFrameElement)) return box(e);
        const text = e.contentDocument?.querySelector('p, h1, h2, h3, li');
        return [box(e), text ? box(text) : null];
      }));
    })()`;
    const deadline = Date.now() + 15000;
    let previous = await this.evaluate(signature);
    let stableSince = Date.now();
    while (Date.now() - stableSince < 400) {
      if (Date.now() > deadline)
        throw new Error('timed out waiting for: the reader layout to settle');
      await new Promise((done) => setTimeout(done, 100));
      const current = await this.evaluate(signature);
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
    }
  }

  async setInputValue(selector, value) {
    await this.waitFor(
      `(() => {
        const input = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
          (element) => element.checkVisibility({ visibilityProperty: true }));
        if (!input) return false;
        // Inputs and textareas each have their own value setter, which React listens behind.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      `visible input ${selector}`,
    );
  }

  /**
   * Clicks Open until `isTarget` holds. The fake picker cycles through its library, so
   * this waits for each open to finish first: on a slow machine, clicking again too soon
   * opens extra documents and leaves later steps acting on the wrong tab.
   */
  async openUntil(isTarget, description) {
    const activeTab = `[...document.querySelectorAll('[role="tab"]')].findIndex(
      (tab) => tab.getAttribute('aria-selected') === 'true')`;
    // Whichever engine it is, the visible tab has moved past its loading message.
    const viewerSettled = `[...document.querySelectorAll('[aria-label="Document reader"] > div:last-child > div')]
      .some((pane) => pane.checkVisibility({ visibilityProperty: true })
        && !pane.textContent.startsWith('Opening '))`;
    // One pass through the picker's library, which holds nine files.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const before = await this.evaluate(
        `({ tab: ${activeTab}, count: document.querySelectorAll('[role="tab"]').length })`,
      );
      await this.clickButton('Open');
      await this.waitFor(
        `${activeTab} !== ${before.tab} || document.querySelectorAll('[role="tab"]').length !== ${before.count}`,
        'the picked document to activate',
      );
      await this.waitFor(viewerSettled, 'the picked document to open');
      if (await this.evaluate(`!!(${isTarget})`)) return;
    }
    throw new Error(`the picker never offered ${description}`);
  }

  /** Screen rectangle of `text` inside rendered elements matching `selector`. */
  textRect(selector, text) {
    return this.evaluate(
      `(() => {
        for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
          if (!element.checkVisibility({ visibilityProperty: true })) continue;
          const node = element.firstChild;
          if (node?.nodeType !== Node.TEXT_NODE) continue;
          const index = node.data.indexOf(${JSON.stringify(text)});
          if (index === -1) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + ${JSON.stringify(text)}.length);
          // Text can wrap, so the ends are on the first and last line boxes.
          const rects = [...range.getClientRects()].filter((r) => r.width > 0);
          const first = rects[0];
          const last = rects[rects.length - 1];
          return {
            start: { x: first.left + 0.5, y: first.top + first.height / 2 },
            end: { x: last.right - 0.5, y: last.top + last.height / 2 },
          };
        }
        return null;
      })()`,
    );
  }

  /** Selects `text` with the mouse, measured once the reader has finished laying out. */
  async selectText(selector, text) {
    await this.waitForReaderLayout();
    const rect = await this.textRect(selector, text);
    if (!rect) throw new Error(`text is not rendered: ${text}`);
    await this.drag(rect.start, rect.end);
  }

  /**
   * Whether this browser reports an inline handler merely for parsing it into an inert
   * document. Some Chrome builds do, and epub.js parses every chapter before the sanitizer
   * sees it, so the hostile fixture causes a blocked report even though nothing can run.
   */
  async parserReportsHandlers() {
    const count = await this.evaluate(`(async () => {
      window.__cspViolations.length = 0;
      new DOMParser().parseFromString(
        '<img xmlns="http://www.w3.org/1999/xhtml" onerror="x"/>',
        'application/xhtml+xml',
      );
      await new Promise((done) => setTimeout(done, 100));
      const count = window.__cspViolations.length;
      window.__cspViolations.length = 0;
      return count;
    })()`);
    return count > 0;
  }

  /**
   * What a failed flow leaves behind: a screenshot in `dir`, and the reader state a
   * timeout message cannot show (which popover is open, in which mode, the note being
   * typed, where focus is). For flakes seen only on CI runners.
   */
  async diagnose(dir, name) {
    const state = await this.evaluate(
      `(() => {
      const popover = document.querySelector('[data-testid="selection-popover"]');
      const active = document.activeElement;
      return {
        hasFocus: document.hasFocus(),
        activeElement: active && (active.getAttribute('data-testid') || active.getAttribute('aria-label') || active.tagName),
        popover: popover && { mode: popover.dataset.popoverMode, rect: popover.getBoundingClientRect().toJSON() },
        noteField: document.querySelector('[data-testid="popover-note-input"]')?.value ?? null,
        selection: String(window.getSelection()).slice(0, 80),
        marks: document.querySelectorAll('[data-annotation-id]:not([data-annotation-id^="__"])').length,
        noteMarkers: document.querySelectorAll('[data-note-marker]').length,
        viewport: [innerWidth, innerHeight],
      };
    })()`,
    ).catch((error) => ({ error: error.message }));
    console.error(`     ${name} state: ${JSON.stringify(state)}`);
    try {
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
    } catch (error) {
      console.error(`     ${name}: no screenshot: ${error.message}`);
    }
  }

  /** CSP violations recorded since the page loaded. */
  cspViolations() {
    return this.evaluate('window.__cspViolations');
  }
}

/**
 * Installed before the app's scripts, so its capture listeners on `window` run before
 * any the app adds (a popover's press-outside listener among them). While armed with a
 * target, a real press, release or click that lands off it is stopped and noted.
 */
const CLICK_GUARD = `(() => {
  let target = null;
  let hit = false;
  let missed = false;
  window.__e2eClickGuard = {
    arm(element) { target = element; hit = false; missed = false; },
    disarm() { target = null; return { hit, missed }; },
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, (event) => {
      if (target === null || !event.isTrusted) return;
      if (target.isConnected && target.contains(event.target)) {
        if (type === 'pointerdown') hit = true;
        return;
      }
      missed = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
})();`;

/** How long a launched Chromium may take to open DevTools before it counts as hung. */
const DEVTOOLS_TIMEOUT_MS = 15000;
/**
 * The first launch on a fresh CI runner is not a hang: on ubuntu-latest it took 11-18 s
 * on every run (pages in the browser from a cold disk, builds font and code caches),
 * where every later launch takes about 1 s. `warmUp` pays that once, so the flows
 * keep the short deadline.
 */
const COLD_START_TIMEOUT_MS = 60000;

/**
 * Launches Chromium once and opens the app, with a deadline for a cold start, so the
 * one-off first-launch cost does not land on whichever flow happens to run first.
 * Returns how long it took.
 */
export async function warmUp(url) {
  const started = Date.now();
  const { close } = await launchPage(url, { devtoolsTimeoutMs: COLD_START_TIMEOUT_MS });
  await close();
  return Date.now() - started;
}

export async function launchPage(
  url,
  { width = 1440, height = 900, devtoolsTimeoutMs = DEVTOOLS_TIMEOUT_MS, retries = 1 } = {},
) {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error('No Chromium found. Set CHROME_PATH to a Chromium-based browser.');

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await launchPageOnce(chrome, url, { width, height, devtoolsTimeoutMs });
    } catch (error) {
      if (attempt >= retries) throw error;
      console.warn(`     Chromium launch failed (${error.message}); retrying once`);
    }
  }
}

async function launchPageOnce(chrome, url, { width, height, devtoolsTimeoutMs }) {
  const profile = mkdtempSync(join(tmpdir(), 'synapseread-e2e-'));
  let cdp = null;
  let process_ = null;

  const close = async () => {
    cdp?.close();
    if (process_) {
      process_.removeAllListeners('exit');
      if (process_.exitCode === null && process_.signalCode === null) {
        const exited = new Promise((done) => process_.once('exit', done));
        const killTimer = setTimeout(() => process_.kill('SIGKILL'), 2000);
        killTimer.unref();
        try {
          process_.kill();
          await exited;
        } finally {
          clearTimeout(killTimer);
        }
      }
    }
    // Helper processes (Crashpad, GPU) can still write into the profile briefly after
    // the main browser process exits, which makes an immediate single `rm` hit ENOTEMPTY.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort temp cleanup must not fail a passing flow.
    }
  };

  try {
    process_ = spawn(
      chrome,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        // Nothing but the flow: no component downloads or background requests to
        // compete with it (or change the browser) while it runs.
        '--disable-component-update',
        '--disable-background-networking',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const browserUrl = await new Promise((done, fail) => {
      let output = '';
      const timer = setTimeout(
        () => fail(new Error(`timed out waiting for Chromium DevTools: ${output}`)),
        devtoolsTimeoutMs,
      );
      const settle = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };
      process_.stderr.on('data', (data) => {
        output += data;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) settle(done, match[1]);
      });
      process_.once('error', (error) => settle(fail, error));
      process_.once('exit', (code) =>
        settle(fail, new Error(`Chromium exited (${code}): ${output}`)),
      );
    });

    const { port } = new URL(browserUrl);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((candidate) => candidate.type === 'page');
    if (!target) throw new Error('Chromium reported no page target.');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const page = new Page(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLICK_GUARD });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
          window.__cspViolations.push([event.effectiveDirective, event.blockedURI,
            (event.sourceFile || location.href) + ':' + event.lineNumber + ':' + event.columnNumber,
            event.sample].join(' ')));`,
    });
    await cdp.send('Page.navigate', { url });
    // On macOS, `--headless=new` leaves its virtual NSWindow inactive (`document.hasFocus()`
    // is false), and synthetic CDP input never activates the window; Chromium's fullscreen
    // controller then denies `requestFullscreen()` with `TypeError: not granted`.
    await cdp.send('Page.bringToFront');
    await page.waitFor(
      `document.hasFocus() && document.querySelector('[aria-label="Document reader"]')`,
      'the focused workspace',
    );

    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
