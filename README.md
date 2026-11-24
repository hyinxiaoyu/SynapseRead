# SynapseRead

SynapseRead is a local-first desktop app for reading and synthesizing knowledge.
Read on one side, and excerpts become connected cards on an
infinite mind map on the other. Every card links back to the exact passage it came
from.

> **Status: Reader experience milestone (R01–R12) complete; V1 LAN Book Sync implemented.**
> PDF, EPUB, and TXT documents support full local reading, search, bookmarks, independent
> highlights and notes, session restoration, source recovery, and excerpting to the
> MindMap, verified on macOS (`arm64`, `WKWebView`), alongside session-scoped LAN book sync
> (local single-Mac baseline checked at `d4e7837`; two-Mac Apple-signed Finder acceptance
> tracked in `#147`). See the [roadmap](docs/ROADMAP.md),
> [reader implementation plan](docs/READER_PLAN.md), and
> [ADR 0008](docs/adr/0008-lan-book-sync.md).

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
  (`Standard` 75 ch, `Wide` 110 ch, `Full`), `none`/`slide`/`fade`/`curl`/`stack`
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
- Opt-in session-scoped LAN book sync (`File ▸ Share Books on This Network…` and
  `File ▸ Import from Another Device…`): pull-only read-only sharing between two
  SynapseRead desktop instances on the same private IPv4 LAN, gated by a native OS
  confirmation dialog, single-use 6-digit pairing code (10-minute expiry, 5-attempt
  lockout), single IP-bound receiver, selectable book scope, optional reading-position
  adoption (compare-and-swap) and insert-only bookmark merge, Focus-Mode-safe active
  sharing indicator, and offline-ready storage in `<app-data>/library/` (plaintext HTTP/1.1
  on trusted networks only; highlights, notes, captures, MindMap cards, preferences, local
  paths, and device names are never shared)
- Local SQLite storage with no accounts, no cloud services, and no telemetry; the only
  network activity is opt-in, session-scoped LAN book sync between your own devices on the
  same private IPv4 network

**Planned**

- Merging excerpts, collapsing subtrees, and multiple notebooks
- Multi-encoding text and a rendered Markdown reader (V1.1). Until then, Markdown files
  open as plain text in the TXT reader

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

For Apple Developer ID code-signing, notarization, and universal release builds via [`.github/workflows/release.yml`](.github/workflows/release.yml) or `scripts/macos-build-signed.sh`, see [docs/MACOS_SIGNING.md](docs/MACOS_SIGNING.md).

App data is stored in the OS app-data directory (for example
`~/Library/Application Support/app.synapseread.desktop/` on macOS):

- `synapseread.sqlite3` — local SQLite database for documents, annotations, bookmarks, and
  MindMap data
- `captures/` — rectangle image captures attached to excerpts
- `library/<sha256>.<ext>` — content-addressed book copies imported over LAN sync so they
  remain openable offline after the sharing device disconnects
- `sync-staging/` — temporary `.part` download staging cleaned up on cancellation or
  sole-connection startup reconciliation

## LAN book sync

SynapseRead can copy books, saved reading positions, and bookmarks from one desktop instance
to another over a trusted local network without accounts or cloud storage. No network
listener starts automatically at launch: sharing begins only when you choose
`File ▸ Share Books on This Network…` and confirm the native system prompt, and stops when
you click **Stop sharing**, the pairing code expires, the paired session is idle for 10
minutes, the bound IPv4 address is no longer available on an eligible interface, or the app
closes.

> **Trusted networks only:** V1 LAN sync uses plaintext HTTP/1.1 on your local network
> (`Use only on networks you trust. Transfers are not encrypted.`). Highlights, notes,
> captures, MindMap cards, reading preferences, local filesystem paths, and device/host
> names never leave the device.

### Troubleshooting

- **macOS Local Network permission (macOS 15 and later):** Packaged macOS builds launched
  from Finder require Local Network access on the receiving Mac (per Apple TN3179). If
  macOS denies access (or the first attempt fails), open **System Settings → Privacy &
  Security → Local Network**, enable **SynapseRead**, and click **Retry** (relaunch the
  app if macOS prompts you to do so). Note that dev builds launched from Terminal
  (`pnpm dev`) inherit Terminal's network access and do not display app-level permission
  prompts.
- **macOS Application Firewall:** On the sharing Mac, check **System Settings → Network →
  Firewall**. Allow incoming connections for **SynapseRead** and make sure **Block all
  incoming connections** is turned off.
- **Same-subnet, VLAN, and VPN constraints:** Sharing binds only to a single
  broadcast-capable private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or
  link-local (`169.254.0.0/16`) interface on ports `49319`–`49328` (default `49319`,
  advancing on port conflict). Loopback, CGNAT (`100.64.0.0/10`), and VPN/point-to-point
  (`utun*`) interfaces are excluded. Only connection attempts that reach the sharing
  listener and are rejected by its subnet/address policy increment the blocked-peer
  counter and surface a blocked-peer notice in the Share dialog. When VLAN routing, a
  firewall, or client isolation blocks traffic before it reaches the sharing device, no
  blocked-peer notice appears on the source — troubleshoot from the receiving device's
  connection failure instead.
- **Guest Wi-Fi and client isolation:** Guest Wi-Fi networks frequently isolate connected
  devices from reaching each other directly. If isolation drops traffic before it reaches
  the sharing listener, the receiver sees a connection failure and the source shows no
  blocked-peer notice; connect both devices to a non-isolated local Wi-Fi or Ethernet
  network.
- **Network changes while sharing:** While sharing, SynapseRead checks the bound IPv4
  address every 5 seconds; if that address is no longer present on an eligible interface,
  sharing stops and shows **Needs attention** (if a network change leaves the same IPv4
  address active on an eligible interface, the session continues running).

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
│   │   │   ├── commands/         # Central command registry and keyboard shortcuts
│   │   │   ├── workspace/        # Split-pane shell
│   │   │   ├── reader/           # Document tabs and the viewer registry
│   │   │   ├── mindmap/          # React Flow canvas
│   │   │   ├── inspector/        # Card editor
│   │   │   └── lanSync/          # Share/Import dialogs and active-sharing indicator
│   │   ├── lib/backend/          # StudyBackend: Tauri and in-memory implementations
│   │   ├── stores/               # useStudySyncStore, the Reader <-> MindMap bus
│   │   └── types/domain.ts       # Domain types, AnchorLocation, DocumentViewerProps
│   └── src-tauri/                # Tauri shell
│       ├── Info.plist            # macOS Local Network usage description
│       └── src/
│           ├── access.rs         # Asset scope, derived from registered documents
│           └── commands/         # db.rs, fs_reader.rs, lan.rs: thin IPC adapters
├── crates/synapse-core/          # Backend logic, free of Tauri
│   ├── migrations/               # SQLite schema
│   └── src/
│       ├── captures.rs           # Rectangle captures on disk
│       ├── db.rs                 # Migrations and queries
│       ├── domain.rs             # Domain types
│       ├── fs_reader.rs          # TextDecoderService, EncodingDetector, streaming
│       └── library.rs            # Managed library storage, staging, and reconciliation
├── crates/synapse-lan/           # Tauri-free LAN sync protocol, client/server, orchestrator
├── fixtures/contract/            # JSON & /v1 LAN fixtures checked by Rust and TypeScript
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
