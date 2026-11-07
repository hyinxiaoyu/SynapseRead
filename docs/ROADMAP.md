# Roadmap

Implementation plan derived from the SynapseRead requirements. Status reflects
what is on `main`.

**Scope:** the architecture is cross-platform (macOS and Windows); V1.0 ships for
macOS only (`aarch64-apple-darwin`, `x86_64-apple-darwin`).

## M1: Foundation (Phase 1), complete

| Task                                                                            | Status |
| ------------------------------------------------------------------------------- | ------ |
| Tauri v2 + React + TypeScript monorepo, Tailwind, Shadcn UI setup               | Done   |
| SQLite migration with the seven core tables; `user_version` migration runner    | Done   |
| Persistence commands, including the atomic `create_excerpt` write               | Done   |
| `read_text_stream` with `TextDecoderService` / `EncodingDetector`, UTF-8 lossy  | Done   |
| `types/domain.ts`: `AnchorLocation` union, `DocumentViewerProps`, MindMap types | Done   |
| Resizable Reader / MindMap / Inspector shell, collapsible to two panes          | Done   |
| `useStudySyncStore`: selection → excerpt → node, node → jump → pulse            | Done   |
| Canvas: draggable nodes, cross-link edges, persisted layout and viewport        | Done   |
| Inspector: edit title, notes, and tags                                          | Done   |
| CI, agent guidelines, documentation                                             | Done   |

## M2: Reader engines (Phase 2), complete

| Task                                                        | Status |
| ----------------------------------------------------------- | ------ |
| Path scope: id-based reads, native picker, asset scope, CSP | Done   |
| TXT engine, with the span map from ADR 0002                 | Done   |
| PDF engine, with captures from ADR 0003                     | Done   |
| EPUB engine, with the content rules from ADR 0005           | Done   |

Each engine implements `DocumentViewerProps` and is registered in
`features/reader/viewerRegistry.ts`. `pnpm e2e` drives all three in real Chromium.

**Decisions for M2**

Each record states its tradeoffs and what would reverse it. The first four were settled
before implementation; the fifth came up while building the EPUB engine.

1. [Path scope and the asset protocol](adr/0001-path-scope.md): the webview never names
   a path; the `documents` table is the only scope for commands and asset loading alike.
2. [TXT anchors in lossy chunks](adr/0002-txt-anchor-drift.md): each chunk carries a map
   of its non-identity spans, which also covers the BOM.
3. [Rectangle captures](adr/0003-rectangle-captures.md): core writes
   `<app-data>/captures/<annotation-id>.png` inside `create_excerpt`.
4. [pdf.js worker under the CSP](adr/0004-pdfjs-worker-csp.md): proven by a spike on
   WebKitGTK.
5. [EPUB content and the iframe sandbox](adr/0005-epub-sandbox.md): `allow-scripts` is
   required on WebKit, so the CSP and a sanitizing hook keep book scripts from running.

**Carried into M4**

- [x] Run the [whole-app self-test](adr/0004-pdfjs-worker-csp.md#whole-app-check) on macOS
      WKWebView (`macOS 15.6.1`, `arm64`, `AppleWebKit/605.1.15`).
- [x] Native file picker and drag-and-drop registration (`pick_document`, `relink_document`,
      `register_dropped_paths`).
- [x] Large files: closed-tab TXT streams cancel immediately through `cancel_text_stream`,
      and PDF/DOM resources are bounded via per-document LRU caches and canvas bitmap zeroing.
- [x] Source change detection (`verify_document_source`) and explicit relinking
      (`relink_document`) prevent stale anchors from silently applying to modified files.

## Reader experience (R01–R12), complete

Completed the principal local reading workflows across EPUB (Apple Books parity),
PDF (macOS Preview parity), and TXT. See [the reader implementation plan](READER_PLAN.md)
for task IDs, acceptance evidence, and measurements.

- [x] Daily reading core (R01–R07): native baseline, navigation/progress, preferences,
      PDF zoom, document search, bookmarks, and independent annotations (including
      cross-page PDF anchors).
- [x] Desktop parity and hardening (R08–R12): PDF thumbnails/display modes/rotation/links
      and embedded annotations, recent documents/session restoration, source recovery,
      stream cancellation and bounded resource limits, and native/accessibility acceptance.
- [x] Reader UX and visual design pass (`#20`–`#33`,
      [ADR 0006](adr/0006-command-registry.md)): native menu bar and central command
      registry, unified macOS overlay toolbar, immersive focus mode, Preview-style
      Navigator sidebar, collapsible outline tree, unified toolbar search, Apple Books
      "Aa" typography popover, constrained `45–75ch` reading measure and margins,
      whole-window themes (`Auto`/`Light`/`Sepia`/`Dark`), Books-style footer progress
      scrubber, page-turn click zones/trackpad swipes/transitions, contextual selection
      popover and Markup bar, and WCAG AA chrome contrast/hit-target compliance.

## M3: Card operations (after reader experience)

- Hierarchical nesting: re-parent by drag, collapse and expand subtrees
  (`is_collapsed` is stored; there is no UI yet).
- Merge several excerpts into one card, using `card_annotations`.
- Delete nodes and cards with confirmation; delete annotations with their
  highlight.
- Edge labels; multi-select on the canvas.
- Multiple notebooks: create, switch, rename.

## M4: V1.0 release (macOS)

- Performance targets with large fixtures (multi-GB TXT, 1000+ page PDF).
- Universal build, code signing, and notarization; release workflow.
- Error reporting and recovery (missing or moved source files).
- Accessibility and keyboard navigation pass.

## V1.1 and later

- Multi-encoding support: `encoding_rs` decoders and a `chardetng` detector,
  registered in `DecoderRegistry`, with no pipeline changes.
- Markdown reader using the reserved `MarkdownAnchor`.
- Windows release: `tauri.conf.json` bundle targets, WebView2 checks, signing.
