# ADR 0006: One command list for the menu bar, the keyboard, and the toolbar

**Status:** Accepted for the reader UX milestone (issues #31, #20, #23). The native-menu
path is unverified on a Mac, and its macOS-only code is reviewed against Tauri 2.12 only.

## Context

Shortcuts were separate `keydown` listeners in `ReaderPane`, `DocumentSearchBar`,
`BookmarksPanel`, `PdfViewer`, and `EpubViewer`, none listed anywhere a reader could find
them, and there was no menu bar. A native menu needs each command's title and key
equivalent in Rust, and the toolbar needs the same in its tooltips. Three hand-kept copies
would drift.

## Decision

`fixtures/contract/commands.json` lists every command once: id, title, shortcut in Tauri
accelerator syntax, an optional replacement off macOS (`F11` for full screen, where ⌃⌘F
would be Ctrl+Ctrl), keyboard-only aliases, and the menus that show it.

- **Rust** (`src-tauri/src/menu.rs`) builds the menu bar from it, with the predefined Edit
  items text fields need. Choosing an item emits `menu-command` with the id. It holds no
  state about documents: the frontend reports which items apply through
  `set_menu_item_states`, which may also retitle an item ("Remove Bookmark").
- **The frontend** (`features/commands`) reads the same file. Components register
  handlers with `useCommands` while active (only the visible tab's viewer does). One
  window `keydown` listener matches shortcuts on `event.code`, so ⌥ does not turn S into
  ß, and never fires in an editable field, except Find commands in the find field. The
  menu bridge runs menu choices through the same `runCommand`, so a toolbar click, a key,
  and a menu item cannot behave differently.
- A key equivalent may reach both the webview and the menu. A second run of the same
  command from the other source within 150 ms is ignored.
- Bare keys (←, →) are keyboard-only (`"accelerator": false`): as menu key equivalents
  they would be taken from every text field.
- Readers in iframes (EPUB) forward the frame's keydowns to `dispatchCommandKeydown`.

## Consequences

- Adding a shortcut is one JSON entry plus a handler. Both languages test the file: every
  menu entry names a command once, every accelerator parses, none repeat.
- The webview gains three window permissions (start dragging for the unified title bar,
  and set/query full screen). `ipc_tests` pins the capability list.
- The main window is created in `setup` rather than from `tauri.conf.json`, so the overlay
  title bar applies to macOS only, behind `cfg`.
