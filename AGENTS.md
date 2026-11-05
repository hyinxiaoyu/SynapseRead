# AGENTS.md

Guidance for AI agents and contributors working on SynapseRead, a local-first
reading and knowledge-synthesis desktop app. See `docs/ROADMAP.md` for what is
built and what is next.

## Commands

Run from the repository root. Requires Node 24+ and pnpm (`corepack enable`), plus
Rust stable.

| Task                       | Command                                                 |
| -------------------------- | ------------------------------------------------------- |
| Install                    | `pnpm install`                                          |
| Desktop app                | `pnpm dev`                                              |
| Browser preview            | `pnpm dev:web` (in-memory backend, nothing is saved)    |
| All frontend checks        | `pnpm check`                                            |
| Format                     | `pnpm format`                                           |
| Lint / types / tests       | `pnpm lint` / `pnpm typecheck` / `pnpm test`            |
| One frontend test file     | `pnpm --filter @synapseread/desktop test <path>`        |
| Reader engines, end to end | `pnpm e2e` (real Chromium, memory backend, app CSP)     |
| Rust format                | `cargo fmt --all`                                       |
| Rust lint                  | `cargo clippy --workspace --all-targets -- -D warnings` |
| Rust tests                 | `cargo test --workspace`                                |
| Core tests only            | `cargo test -p synapse-core` (no webview libraries)     |
| Release bundle             | `pnpm build`                                            |

`apps/desktop/dist` must exist before compiling the desktop crate because
`tauri::generate_context!` reads it. Run `pnpm build:web` or
`mkdir -p apps/desktop/dist`.

### Before finishing a change

Run the checks CI enforces and fix every failure:

```sh
pnpm check
pnpm e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Architecture

```
React components ──> useStudySyncStore ──> StudyBackend ──> Tauri commands ──> synapse-core ──> SQLite
                                                     └──> memory backend (tests, browser)
```

- **`crates/synapse-core`** holds all backend logic. It must not depend on Tauri,
  so it builds and tests anywhere.
- **`apps/desktop/src-tauri`** only adapts core APIs to commands. A command body
  should be a line or two; logic belongs in core.
- **`src/lib/backend`** is the only frontend code allowed to import `@tauri-apps/*`.
- **`useStudySyncStore`** is the bus between Reader and MindMap. Neither imports
  the other: readers publish selections and consume `jumpRequest`; the canvas
  publishes jumps and renders excerpts.

## Principles and constraints

**Anchors are format-agnostic.** Only a reader may inspect an `AnchorLocation`.
The MindMap, the inspector, and the store treat it as opaque. Adding a format must
not change canvas code.

**Readers implement `DocumentViewerProps`** and register in
`features/reader/viewerRegistry.ts`. They report through callbacks and never touch
the store or the database directly.

**Rust is the source of truth.** Validate in core, not only in the UI. Multi-row
writes use one transaction. The memory backend mimics observable behaviour only.

**TXT offsets address source-file bytes**, never decoded text, so anchors survive
re-chunking and future encodings. Decoders report every place their output differs
from the source as a `SourceSpan`, and `TxtTextModel` is the only frontend code that
converts between text positions and bytes
([ADR 0002](docs/adr/0002-txt-anchor-drift.md)).

**The webview never names a path.** Commands take document ids, files enter through
the native picker, and the asset scope is derived from the `documents` table
([ADR 0001](docs/adr/0001-path-scope.md)).

**Text encodings plug in; the pipeline does not change.** New character sets are
`TextDecoderService` / `EncodingDetector` implementations registered in
`DecoderRegistry`. An explicitly requested encoding that nothing handles is an
error, not a silent UTF-8 fallback. Only malformed bytes fall back (lossily).

**Migrations are append-only.** Never edit a released file in
`crates/synapse-core/migrations/`; add a new one and list it in `MIGRATIONS`.

**Keep it cross-platform.** V1 ships for macOS only, but do not add macOS-only code
paths outside a `cfg` or an adapter, and never hard-code path separators.

**Local-first.** No telemetry and no network calls. User documents and data stay
on the device.

## Changing the IPC contract

A change to a command or a domain type must be made together in:

1. `crates/synapse-core/src/domain.rs` (Rust types, camelCase over the wire)
2. `apps/desktop/src/types/domain.ts` (TypeScript types and `isAnchorLocation`)
3. `apps/desktop/src/lib/backend/` (`types.ts`, `tauriBackend.ts`, `memoryBackend.ts`)
4. `apps/desktop/src-tauri/src/ipc_tests.rs` (the JSON the frontend actually sends)
5. `fixtures/contract/anchors.json` when anchors change, and
   `fixtures/contract/text-chunks.json` when text chunks change; both languages test them

Tauri maps camelCase JS argument names to snake_case Rust parameters.

## Code style

**TypeScript:** strict mode, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. No `any`. Use the `@/` import alias. Add Shadcn
components under `components/ui/`; organize feature code under `features/<name>/`.

**Rust:** edition 2024, `unsafe` is forbidden, and clippy warnings fail CI. Return
`CoreResult`; do not `unwrap` or `expect` outside tests and fatal startup. New
`CoreError` variants need a stable `code()`, which the frontend can branch on.

**Comments** explain why, not what. **Tests** accompany behaviour changes: Rust
beside the code in `#[cfg(test)]`, frontend as `*.test.ts(x)` beside the source.

## Dependency notes

- TypeScript is pinned to `~6.0` because `typescript-eslint` does not yet support 7.
- pnpm build scripts are denied by default. Decide on new ones in
  `allowBuilds` in `pnpm-workspace.yaml`, or `pnpm install` fails.
- `pdfjs-dist` and `epubjs` are installed for Phase 2 and are not imported yet.

## Git

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, and so on). Commit
`Cargo.lock` and `pnpm-lock.yaml`. Never commit secrets, local databases, or user
documents.
