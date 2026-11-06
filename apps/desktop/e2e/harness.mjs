// A small end-to-end harness with no dependencies: it serves the production bundle
// under the app's real CSP and drives system Chromium over the DevTools protocol.
// The app runs on the memory backend here, so nothing is saved.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  async click({ x, y }) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  async clickButton(name) {
    const point = await this.waitFor(
      `(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === ${JSON.stringify(name)}
            && !b.disabled && b.checkVisibility({ visibilityProperty: true }));
        if (!button) return null;
        const r = button.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      `an enabled, visible button named ${name}`,
    );
    await this.click(point);
  }

  async setInputValue(selector, value) {
    await this.waitFor(
      `(() => {
        const input = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
          (element) => element.checkVisibility({ visibilityProperty: true }));
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
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
    for (let attempt = 0; attempt < 6; attempt += 1) {
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

  /** Selects `text` with the mouse. */
  async selectText(selector, text) {
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

  /** CSP violations recorded since the page loaded. */
  cspViolations() {
    return this.evaluate('window.__cspViolations');
  }
}

export async function launchPage(url, { width = 1440, height = 900 } = {}) {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error('No Chromium found. Set CHROME_PATH to a Chromium-based browser.');

  const profile = mkdtempSync(join(tmpdir(), 'synapseread-e2e-'));
  const process_ = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const browserUrl = await new Promise((done, fail) => {
    let output = '';
    process_.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) done(match[1]);
    });
    process_.once('exit', (code) => fail(new Error(`Chromium exited (${code}): ${output}`)));
  });

  const { port } = new URL(browserUrl);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === 'page');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = new Page(cdp);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        window.__cspViolations.push([event.effectiveDirective, event.blockedURI,
          (event.sourceFile || location.href) + ':' + event.lineNumber + ':' + event.columnNumber,
          event.sample].join(' ')));`,
  });
  await cdp.send('Page.navigate', { url });
  await page.waitFor(`document.querySelector('[aria-label="Document reader"]')`, 'the workspace');

  return {
    page,
    close() {
      cdp.close();
      process_.removeAllListeners('exit');
      process_.kill();
      // Chromium may still be writing while it exits.
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 200);
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
