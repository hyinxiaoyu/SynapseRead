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

## M2: Reader engines (Phase 2), next

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

**Open decisions for M2**

1. **TXT offsets in lossy chunks.** `TextChunk` offsets are exact at chunk
   boundaries. Inside a chunk, the frontend derives offsets from the UTF-8 length
   of the decoded text, which drifts when `hadReplacements` is true, since U+FFFD
   is not the same length as the malformed bytes it replaced. Either send a
   replacement map or anchor such chunks to their boundaries.
2. **Asset access and path scope.** Enable Tauri's asset protocol with a scope
   limited to registered documents. `read_text_stream` currently accepts any path
   the webview supplies; restrict it to registered documents before release.
3. **Image captures.** Decide where rectangle captures live on disk (proposed:
   under the app-data directory, keyed by annotation id).
4. **pdf.js and Node.** `pdfjs-dist` declares Node ≥ 22.13 only for tooling; it
   runs in the webview. Confirm its worker loads under the app CSP.

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
