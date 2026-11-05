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

`EnginePendingViewer` stands in for the real engines and emits sample anchors so
the loop can run end to end. M2 deletes it.

## M2: Reader engines (Phase 2), in progress

| Task                                                        | Status |
| ----------------------------------------------------------- | ------ |
| Path scope: id-based reads, native picker, asset scope, CSP | Done   |
| TXT engine, with the span map from ADR 0002                 | Done   |
| PDF engine                                                  | Next   |
| EPUB engine                                                 | To do  |

Each engine implements `DocumentViewerProps` and is registered in
`features/reader/viewerRegistry.ts`.

- **TXT:** virtualized line renderer (`@tanstack/react-virtual`) fed by
  `read_text_stream`; map DOM selections to `TxtAnchor`; paint highlights; jump
  and pulse.
- **PDF:** `pdfjs-dist` canvas and text layer; text selection to normalized
  rects; rectangle drag capture saved to `excerpt_image_path`.
- **EPUB:** `epubjs` rendition; CFI selection to `EpubAnchor`; jump via
  `rendition.display(cfi)`.
- **All:** reopen at `lastCursorAnchor`; multi-document tabs keep their state.

**Decisions for M2**

Settled before implementation. Each record states its tradeoffs and what would reverse it.

1. [Path scope and the asset protocol](adr/0001-path-scope.md): the webview never names
   a path; the `documents` table is the only scope for commands and asset loading alike.
2. [TXT anchors in lossy chunks](adr/0002-txt-anchor-drift.md): each chunk carries a map
   of its non-identity spans, which also covers the BOM.
3. [Rectangle captures](adr/0003-rectangle-captures.md): core writes
   `<app-data>/captures/<annotation-id>.png` inside `create_excerpt`.
4. [pdf.js worker under the CSP](adr/0004-pdfjs-worker-csp.md): proven by a spike on
   WebKitGTK. It must be re-run on macOS WKWebView before release.

## M3: Card operations

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
