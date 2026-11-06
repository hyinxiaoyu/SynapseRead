# ADR 0005: EPUB content and the iframe sandbox

**Status:** Accepted for M2. Proven on WebKitGTK 2.54 and macOS 15.6.1 WKWebView (`AppleWebKit/605.1.15`).

This was not one of the four planned decisions. It came up while building the engine,
and it changes how the app is secured.

## Context

Every EPUB is untrusted HTML. `epubjs` renders it in an iframe, sandboxed with
`allow-same-origin` and no `allow-scripts` by default, and its README warns that adding
`allow-scripts` makes the sandbox insecure, because same-origin script can reach the
parent, and from there Tauri IPC.

## Spike

[`0005-epub-sandbox.spike.patch`](0005-epub-sandbox.spike.patch) adds a page to the spike
from [ADR 0004](0004-pdfjs-worker-csp.md): the real Tauri app, with assets served from
`tauri://localhost`, on WebKitGTK 2.54. The fixture's first chapter contains a `<script>`
and an `onerror` handler that try to mark the document and the parent window.

| Sandbox                           | CSP   | Parent's listener fires | `selected` event | Book script runs        |
| --------------------------------- | ----- | ----------------------- | ---------------- | ----------------------- |
| `allow-same-origin`               | app's | **no**                  | **never**        | no                      |
| `allow-same-origin allow-scripts` | app's | yes                     | yes              | no, CSP violations seen |
| `allow-same-origin allow-scripts` | none  | yes                     | yes              | **yes, reached parent** |
| `allow-same-origin` (control)     | none  | **no**                  | never            | no                      |

Adding `'unsafe-inline'` to `script-src` still blocked the book's script in this setup,
with `script-src-elem` violations, which is why the controls remove the CSP entirely.

## Findings

1. **On WebKit, the default sandbox makes selection impossible.** Listeners that the
   parent attaches inside the frame do not fire without `allow-scripts`. Chromium does
   fire them, so testing only there would hide this until the first macOS run.
2. The CSP inherited by the `srcdoc` frame blocks both inline scripts and handlers,
   whatever the sandbox says.
3. The danger is real. With no CSP, the book's script reached `window.parent`.

4. Some Chrome builds report `script-src-attr` as soon as a handler is parsed into an inert
   `DOMParser` document, which epub.js does before the sanitizer runs. Nothing can execute
   there, so it is harmless, but a hostile book can produce that console report.
   `pnpm e2e` tolerates this one report, only on a browser it has probed for this behaviour.

## Decision

Use `allowScriptedContent: true`, so that events work, and rely on two independent
layers to keep book scripts from running:

1. **The app's CSP**, which `srcdoc` frames inherit. A book cannot host a script at
   `'self'`, and inline, `blob:`, and `data:` scripts are all refused.
2. **A sanitizing hook** on `book.spine.hooks.content`, which removes scripts, event
   handler attributes, `javascript:` URLs, frames, plugins, `<base>`, and refresh tags
   before a chapter is serialized. It does not depend on any policy being in force, and
   a dev server may not enforce the CSP at all.

The CSP also gains `style-src blob:` and `font-src 'self' blob: data:`, so a book's
stylesheets and embedded fonts load. Remote `img-src`, `style-src`, `font-src`, and
`frame-src` stay refused, so a book cannot call home.

## Tradeoffs

- Accepted: scripted EPUBs lose their interactivity, on purpose.
- Accepted: this gives up the sandbox as a layer. Should both layers fail, book script
  would reach the IPC bridge, which is why ADR 0001's rule matters: even then the webview
  cannot name a path to read.
- **Alternative rejected:** keeping the pure sandbox and polling the frame's selection.
  It retains that layer, but every other listener epub.js attaches stays dead on WebKit,
  including internal links.
- **Not exercised:** the fixture has no embedded font, so `font-src blob:` follows from
  how the CSP works and is not directly tested.

## What would reverse this

- An EPUB engine that renders without same-origin access, or a WebKit that fires these
  listeners: go back to the pure sandbox.
- A failure on macOS WKWebView, which must be re-tested before release along with
  ADR 0004. Whatever it shows, the sanitizing hook stays.
