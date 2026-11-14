//! The window boundary: what the webview may navigate to, and when the native
//! menu bar steps aside for full screen (#84, #85).
//!
//! Both are decisions about a URL and a boolean, so they are tested here without a
//! window: the runtime's own behaviour is what `on_window_event` and
//! `on_navigation` hand these functions.

use tauri::Url;

use crate::is_app_navigation;

fn url(text: &str) -> Url {
    text.parse().unwrap()
}

#[test]
fn follows_the_app_and_the_frames_the_readers_build_in_place() {
    // Windows serves the bundle from `http://tauri.localhost`, macOS from `tauri://`.
    assert!(is_app_navigation(&url("http://tauri.localhost/"), None));
    assert!(is_app_navigation(&url("https://tauri.localhost/"), None));
    assert!(is_app_navigation(
        &url("tauri://localhost/index.html"),
        None
    ));
    // The asset protocol: a document's file, and a capture image.
    assert!(is_app_navigation(
        &url("http://asset.localhost/C%3A/books/a.pdf"),
        None
    ));
    assert!(is_app_navigation(&url("asset://localhost/a.pdf"), None));
    // EPUB chapters are `srcdoc` frames, and PDF.js draws into `blob:` URLs.
    assert!(is_app_navigation(&url("about:srcdoc"), None));
    assert!(is_app_navigation(&url("about:blank"), None));
    assert!(is_app_navigation(
        &url("blob:http://tauri.localhost/9a1c"),
        None
    ));
    assert!(is_app_navigation(&url("data:text/html,<p>hi</p>"), None));
}

#[test]
fn refuses_a_page_that_would_replace_the_app() {
    // `Ctrl+U`'s `view-source:`, and any remote page a stray link names.
    assert!(!is_app_navigation(
        &url("view-source:http://tauri.localhost/"),
        None
    ));
    assert!(!is_app_navigation(&url("https://example.com/"), None));
    // A host that only starts with the app's own is a different origin.
    assert!(!is_app_navigation(
        &url("http://tauri.localhost.example.com/"),
        None
    ));
    assert!(!is_app_navigation(&url("javascript:void(0)"), None));
    assert!(!is_app_navigation(&url("file:///C:/Windows/win.ini"), None));
}

#[test]
fn follows_the_dev_server_only_where_one_is_configured() {
    let dev = url("http://localhost:1420");
    assert!(is_app_navigation(
        &url("http://localhost:1420/index.html"),
        Some(&dev)
    ));
    assert!(is_app_navigation(
        &url("http://localhost:1420/@vite/client"),
        Some(&dev)
    ));
    // A release build passes no dev server, so even the configured port is refused.
    assert!(!is_app_navigation(&url("http://localhost:1420/"), None));
    // Another port on the same host is another origin.
    assert!(!is_app_navigation(
        &url("http://localhost:9999/"),
        Some(&dev)
    ));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn the_menu_bar_changes_once_per_full_screen_edge() {
    use crate::menu_bar::MenuBarState;

    let state = MenuBarState::windowed();
    // A window that starts windowed leaves the menu bar alone.
    assert_eq!(state.change(false), None);
    assert_eq!(state.change(true), Some(true));
    // `SetMenu` and `DrawMenuBar` resize the client area and dispatch another
    // `Resized`; that one must not hide the bar again (or show it back).
    assert_eq!(state.change(true), None);
    assert_eq!(state.change(false), Some(false));
    assert_eq!(state.change(false), None);
}
