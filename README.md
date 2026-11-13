# SynapseRead

SynapseRead is a local-first desktop app for reading and synthesizing knowledge,
inspired by MarginNote. Read on one side, and excerpts become connected cards on an
infinite mind map on the other. Every card links back to the exact passage it came
from.

> **Status: Reader experience milestone (R01–R12) complete.** PDF, EPUB, and TXT
> documents support full local reading, search, bookmarks, independent highlights and
> notes, session restoration, source recovery, and excerpting to the MindMap, verified
> on macOS (`arm64`, `WKWebView`). See the [roadmap](docs/ROADMAP.md) and
> [reader implementation plan](docs/READER_PLAN.md).

## Features

**Working now**

- Resizable workspace: document tabs, mind map canvas, and card inspector
- Excerpt workflow that saves an annotation, card, and node in one transaction
- Independent highlights and notes with inline note indicators, click-to-read note
  popovers, multiline editing, chapter-ordered/filterable annotations, quick `1`–`5`
  color keys, and session-scoped deletion undo, plus independent bookmarks (`Cmd/Ctrl+D`)
  without creating MindMap cards
- In-document search (`Cmd/Ctrl+F`) across unrendered PDF pages, EPUB chapters, and
  TXT rows: debounced from the current reading position, folds whitespace, soft hyphens,
  diacritics, and quotes (`Match Case`, `Whole Word`, `Match Diacritics`), tints every
  match on screen, marks matches on the progress scrubber, and returns to the starting
  spot in one step (`Back to…`)
- An "Aa" appearance popover across EPUB, TXT, and PDF: `auto`/`light`/`sepia`/`dark`
  themes that tint the whole reader window (`auto` follows the system), optional Dark and
  Sepia page tinting for PDFs (keeping underlying bitmaps and area captures untinted),
  automatic EPUB low-contrast ink adjustment, named reading faces, font size
  (`Cmd/Ctrl +`/`-`/`0`), line spacing, margins, justification, persistent page widths
  (`Standard` 75 ch, `Wide` 110 ch, `Full`), `none`/`slide`/`fade`/`flip`/`stack`
  page-turn animations, and distraction-free focus mode with optional full-screen linkage
- Inline `LinkPeek` footnote preview cards for EPUB `noteref`s and PDF note markers
  (rendered strictly as plain text), plus `Back to…` return chips on internal links and
  jumps from any card, bookmark, annotation, or search result
- Draggable nodes, parent-child nesting, and cross-link edges, with layout saved
- Format-agnostic anchors covering PDF (including cross-page excerpts), EPUB, TXT, and
  (reserved) Markdown
- TXT reader: virtualized rendering, highlights that stay on the right bytes even in
  damaged files, streaming chapter/heading detection (`Chapter`, `Part`, CJK `第…章`)
  driving Contents and scrubber ticks, `Go To` (`Opt+Cmd+G` / `Ctrl+Alt+G`) by line or
  percentage, cancellable backend streaming when tabs close, and reopening where you left
  off
- PDF reader: pages rendered off the main thread, per-document saved layout
  (`continuous`/`single`/`two-page`, `Cover page alone`, `fit-width`/`fit-page`/
  `actual-size` and `25%`–`400%` zoom, `90°` view rotation), smooth pointer-anchored
  trackpad pinch and `Ctrl`+wheel zoom, printed page labels in `Go To`, lazy page
  thumbnails, internal links, embedded annotation rendering/disclosure, text selection,
  cross-page excerpts, and rectangle captures
- EPUB reader: nested table of contents, `spread`/`paged`/`scroll` modes (two pages only
  when each fits at least 45 characters), background character-weighted whole-book
  progress and scrubber ticks, optional "minutes left in chapter" readout, percentage
  `Go To`, chapters addressed by CFI, and book scripts kept from running
- Recent documents (`Continue reading`) with saved reading percentages, workspace session
  restoration across restarts, reopen closed tab (`Shift+Cmd/Ctrl+T`), immediate page
  keyboard focus on tab open/click/switch, per-tab error isolation, and source change
  detection (`missing`/`moved`/`changed`) with explicit file relinking (`Cmd/Ctrl+O`,
  `Cmd/Ctrl+W`)
- Streaming UTF-8 text pipeline with a pluggable decoder interface
- Local SQLite storage, with no accounts and no network access

**Planned**

- Merging excerpts, collapsing subtrees, and multiple notebooks
- Multi-encoding text and Markdown (V1.1)

## Platform support

V1.0 targets macOS on Apple Silicon and Intel. The architecture is built for
Windows too, with a Windows release planned after V1.0.

## Prerequisites

| Tool                     | Version | Notes                                                                               |
| ------------------------ | ------- | ----------------------------------------------------------------------------------- |
| Node.js                  | 24+     | `.nvmrc` is provided                                                                |
| pnpm                     | 12      | Run `corepack enable`; the version is pinned in `package.json`                      |
| Rust                     | stable  | Install with [rustup](https://rustup.rs); `rust-toolchain.toml` selects the channel |
| Xcode Command Line Tools | latest  | macOS: `xcode-select --install`                                                     |

To build the desktop crate on another OS, see
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/). The core crate
and the browser preview need no system libraries beyond a C compiler, which the
bundled SQLite requires.

## Getting started

```sh
git clone https://github.com/hyinxiaoyu/SynapseRead.git
cd SynapseRead
pnpm install

pnpm dev        # launch the desktop app
```

To work on the UI without compiling Rust, use the browser preview. It runs on an
in-memory backend, so **nothing is saved**:

```sh
pnpm dev:web    # http://localhost:1420
```

To build release packages:

- **macOS** (`.app` and `.dmg`):

  ```sh
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  pnpm build --target universal-apple-darwin
  ```

- **Windows** (`.exe` NSIS installer and `.msi`, on Windows with Visual Studio Build Tools):

  ```sh
  rustup target add x86_64-pc-windows-msvc
  pnpm build --target x86_64-pc-windows-msvc
  ```

Pushing a `v*` tag or running [the release workflow](.github/workflows/release.yml) builds both macOS Universal and Windows x64 packages in GitHub Actions.

App data is stored in the OS app-data directory, for example
`~/Library/Application Support/app.synapseread.desktop/synapseread.sqlite3` on
macOS.

## Development

```sh
pnpm check                # format check, lint, typecheck, frontend tests
pnpm e2e                  # reader engines in real Chromium; set CHROME_PATH if needed

mkdir -p apps/desktop/dist   # needed once before compiling the desktop crate
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs these on every pull request and on pushes to `main`. See
[`.github/workflows`](.github/workflows).

Contributors and AI agents should read [AGENTS.md](AGENTS.md) for architecture rules
and coding constraints.

## Repository structure

```
.
├── apps/desktop/                 # Desktop application
│   ├── src/                      # React frontend
│   │   ├── components/ui/        # Shadcn UI components
│   │   ├── features/
│   │   │   ├── workspace/        # Split-pane shell
│   │   │   ├── reader/           # Document tabs and the viewer registry
│   │   │   ├── mindmap/          # React Flow canvas
│   │   │   └── inspector/        # Card editor
│   │   ├── lib/backend/          # StudyBackend: Tauri and in-memory implementations
│   │   ├── stores/               # useStudySyncStore, the Reader <-> MindMap bus
│   │   └── types/domain.ts       # Domain types, AnchorLocation, DocumentViewerProps
│   └── src-tauri/                # Tauri shell
│       └── src/
│           ├── access.rs         # Asset scope, derived from registered documents
│           └── commands/         # db.rs, fs_reader.rs: thin IPC adapters
├── crates/synapse-core/          # Backend logic, free of Tauri
│   ├── migrations/               # SQLite schema
│   └── src/
│       ├── captures.rs           # Rectangle captures on disk
│       ├── db.rs                 # Migrations and queries
│       ├── domain.rs             # Domain types
│       └── fs_reader.rs          # TextDecoderService, EncodingDetector, streaming
├── fixtures/contract/            # JSON checked by both Rust and TypeScript tests
├── fixtures/documents/           # Small sample documents for tests and the preview
├── docs/ROADMAP.md               # Milestones
├── docs/adr/                     # Decision records
└── .github/workflows/            # CI
```

## Tech stack

| Area          | Choice                                            |
| ------------- | ------------------------------------------------- |
| App framework | Tauri v2                                          |
| Frontend      | React, TypeScript, Vite, Tailwind CSS, Shadcn UI  |
| State         | Zustand                                           |
| Canvas        | `@xyflow/react`                                   |
| Readers       | `pdfjs-dist`, `epubjs`, `@tanstack/react-virtual` |
| Persistence   | SQLite through `rusqlite`                         |

## License

No license has been chosen yet; all rights are reserved until one is added.
