# ADR 0001: Path scope and the asset protocol

**Status:** Accepted for M2.

## Context

`read_text_stream` opens any path the webview supplies. The obvious fix, checking
that the path belongs to a registered document, is not enough on its own:
`register_document` also takes a webview-supplied path, so a compromised webview
could register `~/notes/secret.txt` and then read it. EPUB makes that threat real,
because every book is untrusted HTML rendered inside the app.

PDF and EPUB need the Tauri asset protocol, which has its own scope. The JavaScript
`open()` of `tauri-plugin-dialog` also widens that scope on its own for each picked
file (`tauri-plugin-dialog` 2.8.4, `commands.rs`), which would be a second, implicit
definition of what is readable.

## Decision

**The webview never names a path to read. The `documents` table is the only scope.**

1. `read_text_stream` takes a `documentId`. Core resolves it to `documents.file_path`;
   an unknown id is `not_found`.
2. The `register_document(path)` command is removed. A new `pick_document` command
   shows the native picker from Rust and registers the result, so a path enters the
   system only through a choice the user made. `dialog:allow-open` is removed from
   the capability, and `@tauri-apps/plugin-dialog` from the frontend.
3. The asset protocol is enabled with an **empty static scope**
   (`assetProtocol: { enable: true, scope: [] }`). One adapter function grants a
   document's exact file with `allow_file`, which escapes glob characters. It is
   called for every document at startup and after each registration.
4. PDF and EPUB load through that scope via `StudyBackend.loadDocumentSource`. Only
   `tauriBackend.ts` calls `convertFileSrc`.

## Tradeoffs

- Accepted: a file moved on disk and re-registered leaves its old path allowed until
  restart. Tauri scopes are additive, and `forbid_file` would permanently win if the
  file later moved back.
- Accepted: everything the user has ever registered stays readable by the webview.
  Scoping to open tabs would break jumping to a closed document's excerpt.
- Accepted: the picker is harder to test, as the mock runtime has no dialog. The
  command stays a thin wrapper around a tested `register_and_grant` helper.
- Not solved here: `file_hash` is not re-checked on open, so a file edited in place
  still opens and its anchors can drift. This belongs with M4's missing-file recovery.

**Alternatives rejected:** a static glob such as `$HOME/**` (exposes everything);
keeping `register_document(path)` with an allow-list check (no meaningful list exists
for files the user can keep anywhere); serving PDF and EPUB bytes over IPC only (loses
streaming, and adds a second read path to secure).

## What would reverse this

- OS drag-and-drop or "Open With" needs more entry points. Add them on the Rust side
  from native events; that extends this decision rather than reversing it.
- The asset protocol failing on macOS WKWebView would move PDF and EPUB bytes to an
  id-based streaming command under this same scope.
