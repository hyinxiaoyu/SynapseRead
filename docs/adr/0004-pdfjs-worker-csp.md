# ADR 0004: pdf.js worker under the app CSP

**Status:** Accepted for M2. Proven on WebKitGTK, **not yet on macOS WKWebView**.

## Spike

[`0004-pdfjs-worker-csp.spike.patch`](0004-pdfjs-worker-csp.spike.patch) adds a page and
a reporting command to the real Tauri app. It was built with `custom-protocol`, so
assets come from `tauri://localhost` and the CSP is enforced, then run under Xvfb on
WebKitGTK 2.54 with `pdfjs-dist` 6.5.438 and a PDF with embedded fonts.

| `tauri.conf.json` CSP                     | Real worker | Asset fetch | Renders | Violations    |
| ----------------------------------------- | ----------- | ----------- | ------- | ------------- |
| M1 CSP, unchanged                         | yes         | **blocked** | **no**  | `connect-src` |
| `worker-src 'self' blob:` + `asset:`      | yes         | 200         | yes     | none          |
| `worker-src 'self'` + `asset:` (**used**) | yes         | 200         | yes     | none          |
| `worker-src 'none'` (negative control)    | **no**      | 200         | **yes** | `worker-src`  |

In the working configurations, a same-origin module worker also compiled WebAssembly
with no `wasm-unsafe-eval`, and an `asset://` file outside the scope returned 403.

## Findings

1. The worker itself loads under the M1 CSP. **The blocker was `connect-src`**, which
   did not allow the asset protocol.
2. **A rendered page does not prove the worker loaded.** In the negative control,
   pdf.js logged `Setting up fake worker` and parsed on the main thread with correct
   output. A check must assert that `PDFWorker.port` is a real `Worker`.
3. The modern `pdfjs-dist` build calls APIs like `Map.getOrInsertComputed` without
   polyfills, and `vite build.target` transpiles syntax only. The app targets
   `safari16`, so it must use `pdfjs-dist/legacy/build`.
4. The asset protocol sends `Accept-Ranges` only on range responses and does not expose
   it through CORS, so pdf.js falls back to reading the whole file. Range requests do
   work (206, with a readable `Content-Range`).

5. `pdfjs-dist` 6.5 removed `isEvalSupported`, so there is no switch to set (the spike
   passed it, and it was ignored). The only `Function(` left is a core-js global lookup
   in the legacy build, reached only if `globalThis` is missing. The CSP blocks `eval` on
   the main thread regardless; the worker has no CSP of its own in this setup.

## Decision

- CSP: add `asset: http://asset.localhost` to `connect-src` and `img-src`, and narrow
  `worker-src` to `'self'`. The Windows form of the protocol is included now so a later
  port does not silently fail.
- Load `pdfjs-dist/legacy/build` and its worker through a Vite `?url` import.
- Ship `cmaps/`, `standard_fonts/`, `wasm/`, and `iccs/` as same-origin static files.
- A Rust test pins the CSP directives, and a browser test asserts a real worker.

## Tradeoffs

- Accepted: a larger bundle, since the legacy build is bigger, in exchange for running
  on older WebKit.
- Accepted: whole-file reads for now. A 1000-page PDF costs its file size in memory
  until M4 adds a `PDFDataRangeTransport` over asset range requests.

## What would reverse this

- A failure on macOS WKWebView. The custom-scheme handler differs from WebKitGTK, so
  **re-run the spike on macOS before release**. If module workers or asset fetches fail
  there, fall back to feeding bytes over IPC under the same scope.
- A raised minimum macOS version could drop the legacy build.

## Reproducing

```sh
# The patch applies to commit 380baaa.
git apply docs/adr/0004-pdfjs-worker-csp.spike.patch
# In tauri.conf.json: add assetProtocol { enable: true, scope: [] }, set the CSP under test.
cd apps/desktop
pnpm exec vite build --config spike/vite.config.js
mkdir -p dist/pdfjs && cp -r node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm} dist/pdfjs/
cd ../.. && cargo build -p synapseread-desktop
SPIKE_PDF=/abs/file.pdf SPIKE_UNLISTED=/abs/other.html WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  xvfb-run -a target/debug/synapseread-desktop
```
