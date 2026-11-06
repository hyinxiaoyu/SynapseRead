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
- Click through the native file picker. `pick_document` is the one command no test runs.
- Large files: TXT holds the whole file in memory, a closed tab does not stop the Rust
  read, and PDFs load whole rather than by range.
- A file edited in place still opens, and its anchors can drift, because `file_hash` is
  not re-checked on open.

## Reader experience: next priority

Complete the principal local reading workflows before expanding card operations:
EPUB targets Apple Books, PDF targets macOS Preview, and TXT shares applicable
controls. See [the reader implementation plan](READER_PLAN.md) for task IDs,
dependencies, acceptance criteria, and estimates.

- Daily reading core (R01–R07): native baseline, navigation/progress, preferences,
  PDF zoom, document search, bookmarks, and independent annotations.
- Desktop parity and hardening (R08–R12): PDF thumbnails/display modes/links,
  recent documents/session restoration, source recovery, resource limits, and
  native acceptance.
- Planning estimate: 17–23 implementation sessions, 18–33 engineer days; reserve
  approximately 5–9 working weeks including contingency. Re-estimate after the
  native baseline, search, and annotation milestones. Release packaging is extra.

These tasks are planned, not complete. Relevant M2 carryovers and M4 recovery,
performance, and accessibility work are executed here and should not be counted
twice. Optional scope such as additional TXT encodings is estimated separately.

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
