# Reader experience implementation plan

Planning baseline: 2026-11-06. Status on `main`: R01–R12 and follow-up Reader UX passes (`#20`–`#33`, `#35`, `#37`–`#40`, `#43`–`#52`, `#64`, `#75`) complete (see [Reader UX acceptance notes](#reader-ux-acceptance-notes) and [GitHub tracking](#github-tracking)).

## Outcome and scope

Make EPUB reading comparable to the principal local reading workflows in Apple
Books, and PDF reading comparable to those in macOS Preview. TXT shares applicable
navigation, search, appearance, and annotation controls. Preserve the existing
excerpt-to-MindMap workflow.

This is workflow parity, not complete product parity. Exclude bookstores, cloud
sync, DRM, audiobooks, PDF signing/forms/page editing, OCR, and Windows release.
Do not replace the current reader engines or introduce a search service.

## Current baseline

Confirmed by source inspection, not a fresh desktop acceptance run:

- PDF, EPUB, and UTF-8 TXT readers; file picker and file drops; document tabs.
- EPUB spread, single-page, and scroll modes, with previous/next controls and
  arrow-key navigation. Appearance defaults exist but are not user configurable.
- PDF continuous scrolling, fit-to-width rendering, arrow-key page navigation,
  text selection, and rectangle captures.
- Saved reading anchors, excerpt highlights, card notes/tags, and source jumps.
- Reader-only initial workspace, with expandable MindMap and inspector panes.

Important boundaries: EPUB displayed page counts are chapter-local; PDF excerpts
address one page; Markdown has no reader; open tabs and EPUB reading mode are not
restored across application restarts. Large-file and native macOS checks remain
open in the roadmap.

## Estimates and delivery assumptions

One implementation session means one focused coding conversation that completes
a bounded change, relevant tests, a reviewable diff, and a written handoff. It does
not mean one prompt or a fixed number of minutes. Split a session if its contract
or validation cannot be finished safely within the available context.

Estimates assume one engineer working with the coding agent, sequential delivery,
an available macOS development environment, and timely product review. Engineer
days include review, debugging, tests, and manual verification; they are effort
estimates, not promised agent execution times. No parallel staffing is assumed.

| Milestone                             | Implementation sessions   | Engineer days   | Calendar guidance at full-time availability |
| ------------------------------------- | ------------------------- | --------------- | ------------------------------------------- |
| Daily reading core: R01–R07           | 9–12                      | 9–16            | About 2–3.5 working weeks                   |
| Desktop parity and hardening: R08–R12 | 8–11 additional           | 9–17 additional | About 2–3.5 additional working weeks        |
| Complete planned scope                | 17–23                     | 18–33           | About 4–7 working weeks                     |
| Scheduling allowance                  | Included only in this row | About 25% extra | Reserve about 5–9 working weeks overall     |

These ranges are planning judgments, not measurements. Re-estimate after R01,
R05, and R07. Native WebKit behavior, cross-page anchor compatibility, and bounded
memory for large documents are the largest uncertainties. Part-time work scales
with actual weekly availability; review delays add calendar time.

## Task sequence and acceptance

Each row can become an issue. The session ranges above are the sums of the ranges
below; optional work later in this document is excluded.

| ID  | Task and bounded scope                                         | Dependencies  | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                               | Sessions | Days |
| --- | -------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- |
| R01 | Establish macOS baseline and acceptance fixtures               | None          | Run existing frontend, E2E, and Rust gates; verify native picker/drop, all three formats, selections, captures, position restore, and EPUB sandbox in WKWebView. Record environment and reproducible failures. Fix blockers or revise estimates before continuing.                                                                                                                | 1        | 1–2  |
| R02 | Navigation sidebar, progress, and jump history                 | R01           | EPUB chapter tree and PDF embedded outline support nested entries and jump to destinations. Empty outlines are handled. PDF shows current/total pages and accepts validated page input. EPUB distinguishes chapter pages from whole-book progress. Directory/source jumps can return to the previous location.                                                                    | 1–2      | 1–2  |
| R03 | Persistent reading preferences                                 | R01           | EPUB/TXT expose font family/size, line spacing, reading width, and light/sepia/dark appearance. EPUB mode and preferences survive restart; changing layout preserves the reading location. Reader controls remain legible in each theme.                                                                                                                                          | 1        | 1–2  |
| R04 | PDF zoom and viewport behavior                                 | R01           | Fit width, fit page, actual size, and explicit zoom work with mixed page sizes and high-DPI displays. Zoom preserves the reading target; selection, captures, and normalized highlights remain aligned. Add zoom shortcuts.                                                                                                                                                       | 1        | 1–2  |
| R05 | In-document search across PDF, EPUB, and TXT                   | R02           | Cmd/Ctrl+F opens search; results show context and location; next/previous and direct result jumps highlight the match and support return. Search covers unrendered pages/chapters/rows. Empty/no-match queries, changed queries, cancellation, tab switching, and case sensitivity have defined behavior. TXT matches retain source-byte mapping.                                 | 2–3      | 2–3  |
| R06 | Independent bookmarks                                          | R02           | Add/remove/list/jump bookmarks without creating a card or annotation. Deduplicate locations, persist across restart, and handle stale targets. Add a bookmark shortcut.                                                                                                                                                                                                           | 1        | 1–2  |
| R07 | Independent highlights and notes                               | R02, R06      | Create highlights/notes without generating a MindMap node. List document annotations, jump to them, edit note/color, delete, and undo the deletion within the current session. Existing excerpt/card links remain valid. Define deletion semantics for shared annotations. Implement cross-page PDF excerpts with compatibility proof for existing anchors and contract fixtures. | 2–3      | 2–3  |
| R08 | PDF thumbnails, display modes, links, and existing annotations | R02, R04, R07 | Lazy thumbnails show the active page and jump on click. Continuous/single/two-page modes and view rotation preserve location and highlight geometry. PDF internal links navigate and return. Common existing text notes/highlights are visible; unsupported types are disclosed. Do not rewrite the source PDF.                                                                   | 1–2      | 1–2  |
| R09 | Recent documents and session restoration                       | R03, R06      | Recent list supports continue reading; restore open tabs, active document, and reader preferences on restart. A broken document does not block other tabs. Add open/close/search/bookmark shortcuts with editable-field guards.                                                                                                                                                   | 1        | 1–2  |
| R10 | Source change detection and file recovery                      | R07, R09      | Detect changed, missing, and moved sources. Offer explicit relinking; never silently apply stale anchors to a different file. Define hash/revalidation cost and preserve old notes when recovery fails. Test replacement and relink behavior with all formats.                                                                                                                    | 2        | 2–4  |
| R11 | Large-file resource limits and cancellation                    | R05, R08, R10 | Establish measured budgets on the actual Mac before optimization. Cancel closed-tab TXT work through the backend, bound retained text/render resources, and verify PDF loading strategy. Measure load time, interaction latency, and process memory on agreed large fixtures and multiple tabs. If range loading requires asset-protocol changes, revise the estimate explicitly. | 2–3      | 3–5  |
| R12 | Native acceptance, accessibility, and release regression       | R01–R11       | Run the complete repository gates plus WKWebView walkthroughs. Verify focus order, keyboard-only navigation, VoiceOver basics, selection across EPUB frames, high DPI, window resizing, restart, recovery, and large-file scenarios. Resolve release-blocking defects and update user documentation.                                                                              | 2–3      | 2–4  |

R07 and R08 are especially sensitive to findings in implementation. Do not hide
unfinished cross-page support or PDF link/annotation compatibility behind a task
marked complete. Split them into follow-up issues and revise the milestone if
their estimates prove insufficient.

## Architecture and compatibility boundaries

- Extend existing engine adapters and `DocumentViewerProps` only as needed. Keep
  format-specific navigation, search, and geometry inside the reader feature.
- Keep reader/MindMap communication through the store; other features continue
  treating anchors as opaque.
- Validate and persist new bookmarks, annotations, and preferences through core;
  mirror observable behavior in the memory backend. Use append-only migrations.
- Change Rust/TypeScript types, backend adapters, IPC tests, and contract fixtures
  together when extending anchors or commands. Read old anchors without rewriting
  user documents. Document backup and rollback limits before schema changes land.
- Preserve EPUB sanitization/CSP and id-based document access. Never execute book
  scripts or introduce network access to implement search or lookup.
- Reuse current dependencies first. For search, start with per-document extraction
  and bounded in-process work; add an index only if measurements justify it.
- Define precedence between book styles and user appearance preferences; check
  fixed-layout EPUBs separately rather than assuming reflow behavior applies.

## Validation and workflow

Use a feature branch and a focused PR per reviewable change, with Conventional
Commit titles. Link task IDs in PR descriptions; create GitHub issues when work
starts. This plan does not itself create remote issues or publish a PR.

For every behavior change, test the user-visible acceptance conditions and the
affected compatibility contracts. Before finishing an implementation change, run
the repository-required gates:

```sh
pnpm check
pnpm e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Build the web assets first when required for the desktop crate. Native checks
must use the installed Tauri/WKWebView application; browser tests alone do not
satisfy native acceptance. Record actual OS, architecture, dependency versions,
fixture sizes, and measurements rather than assuming hardware performance.

Keep each session handoff in its issue/PR: completed acceptance items, commands
and results, unresolved defects, next task, and revised estimate. This avoids
spending the next conversation rediscovering state.

Use generated or redistributable fixtures. Temporary fixtures, logs, screenshots,
and benchmark outputs belong only under the repository or `/tmp` and must be
removed when no longer needed. Retained regression samples must be small,
intentional repository artifacts. Remove document-derived search caches when the
document is removed or invalidated.

## Optional scope, excluded from estimates

- Non-UTF-8 TXT: GB18030/GBK and UTF-16 decoding/detection through the existing
  decoder registry, with source-byte anchor tests. Estimate 1–2 sessions; prioritize
  before R05 if the user's actual library requires these encodings.
- Export notes/excerpts to Markdown: estimate 1 session after R07; define image and
  source-location portability first.
- Export annotated PDF: estimate 2–4 sessions after R07/R08, subject to a separate
  writer/dependency and annotation-mapping assessment.
- System dictionary and text-to-speech: estimate 1–2 sessions after native API and
  offline behavior checks.
- OCR, DRM, cloud sync, Markdown rendering, and full Preview editing remain
  separate projects without a reliable estimate in this plan.

## Completion boundary

Daily reading core is complete only when R01–R07 acceptance items pass. The full
reader milestone is complete only when R01–R12 pass and native evidence is
recorded. Existing card-management work remains a separate milestone. Signing,
notarization, universal packaging, and release automation remain release work;
they are not included in the reader estimate.

## Reader UX acceptance notes

Follow-up issues to the reader milestone (#33): #20 (unified toolbar), #21 ("Aa"
typography popover), #22 (reading measure and margins), #23 (immersive mode and full
screen), #24 (footer progress and chapter scrubber), #25 (Navigator sidebar), #26
(collapsible TOC tree), #27 (toolbar search), #28 (selection popover and markup
toolbar), #29 (whole-window themes and system appearance), #30 (page-turn zones, swipes,
and transitions), #31 (native menu bar and command registry), and #32 (contrast,
selected states, hit targets).

Automated evidence (Chromium, `pnpm e2e`; jsdom, `pnpm test`):

- Characters per line stay within 45–75 (78 allowing for the gap between the canvas
  measure and the page's own) at 1280, 1728, and 2560 px in EPUB two-page mode (`60.7`,
  `73.2`, `73.2` ch/line on macOS) and in TXT (`75.0` ch/line). Two pages show only
  where each column holds 45 characters; the spine gutter is at least 48 px.
- Text in the toolbar, tabs, sidebar, and the appearance popover meets 4.5:1 against
  what is painted beneath it in Light, Sepia, and Dark (EPUB) and Dark (TXT). Unit tests
  check every page and chrome token pair in all three themes, including the system
  tokens in `index.css` in both appearances, and focus rings at 3:1.
- Selected toggles use a solid fill with an inset outline and `aria-pressed`; segmented
  controls, swatches, and choices are radio groups with `aria-checked`; highlight
  swatches show a check mark. Interactive targets are at least 24 × 24 px; highlight
  swatches are 20 px inside a 28 px target. Icon-only buttons show their accessible
  name as a tooltip.

Accessibility and VoiceOver tree verification on `macOS 15.6.1 (24G90, Apple M4)`:

- [x] Toolbar: every control announces its name, its state (`aria-pressed`,
      `aria-expanded`, or `aria-checked`), and its shortcut tooltip; the "Aa" button
      announces a dialog popup (`aria-haspopup="dialog"`, `aria-expanded="true"`).
- [x] Appearance popover: theme, font, and choice radio groups announce their group
      label and the checked option (`Auto`, `Original`, `Normal`, `Slide`); Justify
      announces as a switch (`role="switch"`, `aria-checked="true"`) with its
      description (`Even edges, hyphenated in the book's language`).
- [x] Sidebar: tabs announce position and selection (`1 of 3`..`3 of 3`,
      `aria-selected`); outline rows announce level and expansion (`role="treeitem"`,
      `aria-level`, `aria-expanded`, `aria-current="location"`).
- [x] Page: the EPUB frame and the TXT document (`role="document"`) are reachable and
      read their text.
- [x] Footer and notices: status messages (`role="status"`) and the chapter scrubber
      (`role="slider"`, `aria-valuetext="Chapter 1 of 2, 8%"`) are announced.

### Post-R12 refinement and native WKWebView pass (`#35`, `#37`–`#40`, `#43`–`#52`, `#64`, `#75`)

Second-wave reader polish and parity issues completed through SQLite migration `0010`:

- **Typography, themes, and motion (`#35`, `#37`–`#40`, `#46`, `#75`)**: persistent
  `Standard`/`Wide`/`Full` page-width modes decoupled from font size and margins; `flip`
  (`300 ms`) and `stack` (`240 ms`) page-turn modes with click-through spine shadow,
  anchored chrome entrance animations, `animation-duration-150` popover coordinate
  pinning, and `prefers-reduced-motion: reduce` static fallback; PDF `Aa` popover with
  optional Dark/Sepia CSS `<canvas>` tinting (`tintPdfPages`, leaving underlying canvas
  pixels and area-capture PNGs untinted) and non-black highlight blending; automatic EPUB
  Dark/Sepia override for author text colors below `4.5:1` contrast; and centered document
  title in the unified toolbar.
- **Focus mode, tabs, and keyboard flow (`#43`, `#45`, `#50`, `#64`)**: CSS `visibility:
hidden !important` isolation for inactive `inert` EPUB tabpanels; `48 px` paginated EPUB
  top inset in focus mode, non-waking `go.*` page turns, dismissible auto-fading notices,
  optional full-screen linkage (`focusModeFullScreen`), and 5-layer cross-iframe `Escape`
  dismissal (`NoteEditor` → `SelectionPopover` → `LinkPeek` → `Find` → `Focus Mode`);
  immediate page focus (`preventScroll: true`) on document open, keyboard/pointer tab
  switches (`onMouseDown` `preventDefault()` + `requestActivePageFocus()` on `[role="tab"]`
  with editable `onBlur` flush), and TOC `Enter`/`Escape`; `1`–`5` highlight color keys;
  and `⇧⌘]`/`⇧⌘[`/`⇧⌘T`/`⌃⌘N`/`⇧⌘C`/`⌘1`–`⌘3` commands in
  `fixtures/contract/commands.json`.
- **Search, annotations, and footnote peek (`#44`, `#47`, `#48`, `#49`)**: `200 ms`
  debounced Find anchored from the current viewport without auto-toggling the sidebar,
  single-trip jump history with a `Back to…` chip, whitespace/soft-hyphen/diacritic/quote
  folding with `Whole Word` and `Match Diacritics` toggles, all-match tinting, and
  scrubber search marks; zero-drift inline note dots (`[data-note-end]::after` in TXT, SVG
  markers in EPUB, scaled badges in PDF), click-to-read note disclosure, multiline
  `<textarea>` editing (`Return` vs `⌘↩`), and chapter-titled CFI-sorted filterable notes;
  and internal link `Back to…` chips plus sandboxed plain-text `LinkPeek` footnote cards
  across EPUB and PDF (`ADR 0005`).
- **PDF layout/zoom and long-document maps (`#51`, `#52`)**: migration
  `0009_pdf_document_layout.sql` persisting per-PDF `displayMode`, `zoomMode`, `scale`,
  `rotation`, and `coverPageAlone`, printed PDF page labels in `Go To`, and GPU-previewed
  pointer-anchored WebKit `gesture*` and `ctrl+wheel` zoom across `0°`/`90°`/`180°`/`270°`
  rotations; migration `0010_document_progress.sql` storing `documents.last_progress` for
  Recent percentages, background character-weighted EPUB progress (`50 ms` timer fallback
  when `requestIdleCallback` is absent, cached in `localStorage`) with optional "minutes
  left in chapter", streaming TXT chapter/heading detection (`ADR 0002` byte offsets
  preserved), and unified `Go To` (`⌥⌘G`) across PDF, EPUB, and TXT.

Gate and native `macOS 15.6.1 (24G90, Apple M4, arm64)` verification (`WebKit.framework`
`20621.3.11.11.3`, Safari `18.6`, `WKWebView` `AppleWebKit/605.1.15`, `Node v24.14.1`,
`pnpm 12.16.1`, `rustc 1.99.1`):

- **Repository CI gates**: `pnpm check` (`45` Vitest files, `735` unit tests, `0` ESLint
  warnings, strict `tsc`), `pnpm e2e` (`11/11` Chromium flows: `txt`, `pdf`, `pdf-layout`,
  `pdf-zoom`, `epub`, `epub-progress`, `keyboard`, `txt-chapters`, `go-to`, `link-peek`,
  `toolbar-title`; `0` CSP violations), `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`
  (`118` Rust tests: `89` in `synapse-core`, `29` in `synapseread_desktop_lib`).
- **Production macOS bundle (`pnpm build`)**: `SynapseRead.app` (`8.84 MiB` `arm64` Mach-O
  linking `WebKit.framework` and `AppKit.framework`) and
  `SynapseRead_0.1.0_aarch64.dmg` (`5.58 MiB`, `hdiutil verify` valid); isolated-`HOME`
  smoke launch initialized all `11` SQLite schema tables through migration `0010` under the
  strict ADR 0001/0004/0005 CSP (`assetProtocol.scope: []`, no `script-src` relaxation).
- **Native `WKWebView` audit (`DPR=2` and `DPR=1`, `0` CSP violations, `0` page errors)**:
  all `13/13` `#40` checks passed (`flip`/`stack` WAAPI turns across EPUB `paged`/`spread`,
  PDF `single`/`two-page`, and TXT with `postTransform: "none"`, `0` iframe blank frames via
  `WKWebView.takeSnapshot`, `0 px` immediate post-turn selection offset across 10 mode
  combinations, click-through spine hinge, `PageTurnChevrons` `translate`/`scale`
  composition, `grid-template-rows` disclosures, `prefers-reduced-motion: reduce`, `277 px`
  closed/open `SelectionPopover` width parity, and `0 px` scroll/note coordinate lag),
  alongside `#43`–`#52` WebKit checks (real `WKWebView.magnify` `gesture*` zoom `< 0.0007`
  anchor error, `0.016 px` `270°` rotated area capture alignment, untinted `[26,102,204]`
  PDF capture PNG under Dark canvas filter, `0` byte-offset drift on `[data-note-end]::after`,
  plain-text `LinkPeek` against hostile `<img onerror>`, pointer tab-click page focus, and
  CJK IME `isComposing` guard in `GoToField`).

## GitHub tracking

Tracking issue: https://github.com/hyinxiaoyu/SynapseRead/issues/7

- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/8 — **R01**: Establish macOS baseline and acceptance fixtures (1 sessions; 1–2 engineer days) — verified on `macOS 15.6.1 (24G90, arm64)`, `AppleWebKit/605.1.15`, `Node v24.14.1`, `pnpm 12.16.1`, `rustc 1.99.1`; zero CSP violations or runtime blockers; estimates for R02–R04 unchanged.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/9 — **R02**: Navigation sidebar, progress, and jump history (1–2 sessions; 1–2 engineer days) — completed: nested EPUB/PDF outline sidebar with empty-outline states, validated PDF page input, separate EPUB chapter-page vs whole-book progress indicators, and return-location history stack across directory/page/source jumps.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/10 — **R03**: Persistent reading preferences (1 sessions; 1–2 engineer days) — completed: append-only SQLite migration `0002_reading_preferences.sql` with backup/rollback limits documented, `ReadingPreferences` validation and persistence through `synapse-core` + Tauri IPC + `memoryBackend`, EPUB/TXT appearance controls (`light`/`sepia`/`dark`, font family/size, line spacing, reading width), persisted EPUB reading mode (`spread`/`paged`/`scroll`), fixed-layout EPUB guard (`pre-paginated`), and location preservation on layout changes.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/11 — **R04**: PDF zoom and viewport behavior (1 sessions; 1–2 engineer days) — completed: `fit-width`, `fit-page`, `actual-size`, and explicit 25%-step zoom (`25%`–`400%`) across mixed page sizes and high-DPI displays, reading-target preservation (`pageIndex` + intra-page fraction) on zoom changes, aligned selections/captures/normalized highlights, and keyboard shortcuts (`Cmd/Ctrl + +`, `Cmd/Ctrl + -`, `Cmd/Ctrl + 0/8/9`) with editable-field guards.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/12 — **R05**: In-document search across PDF, EPUB, and TXT (2–3 sessions; 2–3 engineer days) — completed: shared `DocumentSearchBar` (`Cmd/Ctrl+F`, `Escape`, `Enter`/`Shift+Enter`, `Match case`, `Cancel search`, result snippets and location labels, tab-switch and query-change cancellation via `AbortController`), PDF unrendered-page text extraction (`getPageText`) with normalized match highlight rects and per-document cache cleanup, EPUB cross-chapter search (`searchChapter`) with sanitized off-screen section loading/unloading and CFI highlights, TXT full-stream search (`TxtTextModel.search`) preserving source-file byte offsets (`TxtAnchor`), and return-location history across all three formats.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/13 — **R06**: Independent bookmarks (1 sessions; 1–2 engineer days) — completed: append-only SQLite migration `0003_bookmarks.sql` with backup/rollback limits documented, `Bookmark` persistence and `(document_id, location_key)` deduplication across `synapse-core` + Tauri IPC + `memoryBackend`, independent bookmark CRUD in `useStudySyncStore` without creating cards or annotations, shared `BookmarksPanel` and `Cmd/Ctrl+D` shortcut (with editable-field guards and EPUB iframe forwarding), stale target detection/status reporting, and return-location history across PDF, EPUB, and TXT.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/14 — **R07**: Independent highlights and notes (2–3 sessions; 2–3 engineer days) — completed: append-only SQLite migration `0004_independent_annotations.sql` (`note TEXT` on `annotations`), independent highlight/note CRUD (`create_annotation`, `update_annotation`, `delete_annotation`) across `synapse-core` + Tauri IPC + `memoryBackend`, defined shared-card deletion semantics (`card_annotations` cascades while preserving `NoteCard` and `MindMapNode`), session-scoped deletion undo, `AnnotationsPanel` + `SelectionAnnotationControls` + `SelectionNoteComposer`, and backward-compatible cross-page PDF anchors (`pageSpans`) verified against `fixtures/contract/anchors.json`.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/15 — **R08**: PDF thumbnails, display modes, links, and existing annotations (1–2 sessions; 1–2 engineer days) — completed: virtualized lazy PDF thumbnail sidebar (`PdfThumbnailsSidebar`) highlighting the active page and jumping on click, `continuous`/`single`/`two-page` display modes and `0°`/`90°`/`180°`/`270°` view rotation preserving reading location and canonical highlight/selection geometry (`rotateNormalizedRect`/`unrotateNormalizedRect`), PDF internal `/Link` navigation with return history, read-only rendering of existing embedded PDF annotations (`Highlight`, `Text`, `FreeText`, `Underline`, `StrikeOut`), and non-intrusive disclosure of unsupported embedded annotation subtypes (`Stamp`, etc.) without modifying the source PDF.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/16 — **R09**: Recent documents and session restoration (1 sessions; 1–2 engineer days) — completed: append-only SQLite migration `0005_workspace_session.sql` (`last_opened_at` on `documents` and `workspace_session` table), `WorkspaceSession` and `touch_document_opened` across `synapse-core` + Tauri IPC + `memoryBackend`, recent documents list with continue-reading progress (`selectRecentDocuments`, `reopenRecentDocument`), session restoration on restart (open tabs, active document, and reading preferences), per-tab `TabErrorBoundary` isolating broken documents without blocking sibling tabs, and `Cmd/Ctrl+O` / `Cmd/Ctrl+W` / `Cmd/Ctrl+F` / `Cmd/Ctrl+D` shortcuts with editable-field guards.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/17 — **R10**: Source change detection and file recovery (2 sessions; 2–4 engineer days) — completed: `verify_document_source` (streaming 64 KiB SHA-256 revalidation on `spawn_blocking` only when opening/reopening/activating a tab) and `relink_document` across `synapse-core` + Tauri IPC + `memoryBackend`, `SourceRecoveryDialog` detecting `missing`, `moved`, and `changed` files without silently applying stale anchors, clearing stale `last_cursor_anchor` on content-hash changes while preserving all existing annotations, notes, bookmarks, and MindMap cards, and granting asset-protocol scope on relink.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/18 — **R11**: Large-file resource limits and cancellation (2–3 sessions; 3–5 engineer days) — completed: backend `StreamCancellationRegistry` + `stream_text_file_with_cancel` and `cancel_text_stream` Tauri command wired to `AbortSignal` in `TxtViewer` (halting closed-tab disk I/O immediately), bounded per-document PDF LRU caches (`MAX_CACHED_TEXT_PAGES = 32`, `MAX_CACHED_ANNOTATION_PAGES = 32`) and `pageSizeCache`, immediate `<canvas>` bitmap zeroing (`width = 0, height = 0`) on page/thumbnail/crop unmount, and verified `pdf.js` Web Worker streaming (`rangeChunkSize: 65536`) without asset-protocol scope changes; measured on `Apple M4 (24 GiB, macOS 15.6.1 24G90)`: `10 MiB` (`163,841`-line, `160`-chunk) TXT SHA-256 revalidation `6.81 ms`, full stream + line index `25.10 ms` (`+18.29 MiB` heap delta, `< 80` virtualized DOM rows), closed-tab cancellation after 4 chunks `0.07 ms`, and full `10 MiB` search `13.74 ms`.
- [x] https://github.com/hyinxiaoyu/SynapseRead/issues/19 — **R12**: Native acceptance, accessibility, and release regression (2–3 sessions; 2–4 engineer days) — completed: WAI-ARIA `tablist`/`tab`/`tabpanel` linkage (`aria-controls`, `aria-labelledby`), roving `tabIndex`, keyboard-only tab navigation (`ArrowLeft`, `ArrowRight`, `Home`, `End`), `Escape` dismissal for popovers/dialogs, verified focus order, keyboard shortcuts with editable-field guards, EPUB cross-frame selection and key forwarding, high-DPI rendering, window resize settling, session restart, source recovery, and large-file cancellation across all repository gates (`188` frontend tests, `3` Chromium E2E suites `txt`/`pdf`/`epub`, `71` Rust core tests, `22` Tauri IPC tests) and native `macOS 15.6.1 (24G90, Apple M4, AppleWebKit/605.1.15)` acceptance; updated `README.md` and `docs/ROADMAP.md`.
