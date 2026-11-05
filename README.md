# SynapseRead

SynapseRead is a local-first desktop app for reading and synthesizing knowledge,
inspired by MarginNote. Read on one side, and excerpts become connected cards on an
infinite mind map on the other. Every card links back to the exact passage it came
from.

> **Status: Phase 1 (foundation).** The workspace, database, and Reader ↔ MindMap
> pipeline work, but the PDF, EPUB, and TXT reader engines are not built yet. A
> placeholder viewer emits sample selections so the pipeline can be exercised. See
> the [roadmap](docs/ROADMAP.md).

## Features

**Working now**

- Resizable workspace: document tabs, mind map canvas, and card inspector
- Excerpt workflow that saves an annotation, card, and node in one transaction
- Jump from any card back to its source, with a pulse highlight
- Draggable nodes, parent-child nesting, and cross-link edges, with layout saved
- Format-agnostic anchors covering PDF, EPUB, TXT, and (reserved) Markdown
- Streaming UTF-8 text pipeline with a pluggable decoder interface
- Local SQLite storage, with no accounts and no network access

**Planned**

- PDF, EPUB, and TXT reader engines (next)
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

To build a macOS `.app` and `.dmg`:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm build --target universal-apple-darwin
```

App data is stored in the OS app-data directory, for example
`~/Library/Application Support/app.synapseread.desktop/synapseread.sqlite3` on
macOS.

## Development

```sh
pnpm check                # format check, lint, typecheck, frontend tests

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
│       └── src/commands/         # db.rs, fs_reader.rs: thin IPC adapters
├── crates/synapse-core/          # Backend logic, free of Tauri
│   ├── migrations/               # SQLite schema
│   └── src/
│       ├── db.rs                 # Migrations and queries
│       ├── domain.rs             # Domain types
│       └── fs_reader.rs          # TextDecoderService, EncodingDetector, streaming
├── fixtures/contract/            # JSON checked by both Rust and TypeScript tests
├── docs/ROADMAP.md               # Milestones and open decisions
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
