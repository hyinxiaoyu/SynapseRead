# Reader experience implementation plan

Planning baseline: 2026-11-06. All tasks below are planned, not implemented.

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

## GitHub tracking

Tracking issue: https://github.com/hyinxiaoyu/SynapseRead/issues/7

- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/8 — **R01**: Establish macOS baseline and acceptance fixtures (1 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/9 — **R02**: Navigation sidebar, progress, and jump history (1–2 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/10 — **R03**: Persistent reading preferences (1 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/11 — **R04**: PDF zoom and viewport behavior (1 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/12 — **R05**: In-document search across PDF, EPUB, and TXT (2–3 sessions; 2–3 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/13 — **R06**: Independent bookmarks (1 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/14 — **R07**: Independent highlights and notes (2–3 sessions; 2–3 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/15 — **R08**: PDF thumbnails, display modes, links, and existing annotations (1–2 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/16 — **R09**: Recent documents and session restoration (1 sessions; 1–2 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/17 — **R10**: Source change detection and file recovery (2 sessions; 2–4 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/18 — **R11**: Large-file resource limits and cancellation (2–3 sessions; 3–5 engineer days)
- [ ] https://github.com/hyinxiaoyu/SynapseRead/issues/19 — **R12**: Native acceptance, accessibility, and release regression (2–3 sessions; 2–4 engineer days)
