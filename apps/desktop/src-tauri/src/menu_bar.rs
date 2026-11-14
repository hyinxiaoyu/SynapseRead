//! The native menu bar against full screen, off macOS (#85).
//!
//! `app.set_menu` puts a Win32 `HMENU` above the webview with `SetMenu`, and
//! borderless full screen keeps it: `WS_CAPTION` goes away, the menu does not. The
//! reader would keep a menu bar's height of chrome at the top of the display, and
//! the toolbar's top-edge reveal would sit under it instead of at `y = 0`.
//!
//! macOS is excluded: there the menu bar belongs to the system and full screen
//! already moves it into the screen edge.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Runtime, Window};

/// The state the menu bar was last set for. A static because the app has one
/// window, and the state has to outlive any single event.
static MENU_BAR: MenuBarState = MenuBarState::windowed();

/// Remembers the full screen state the menu bar was last set for.
pub struct MenuBarState(AtomicBool);

impl MenuBarState {
    /// A window that is not in full screen.
    pub const fn windowed() -> Self {
        Self(AtomicBool::new(false))
    }

    /// Whether the menu bar must hide (`true`) or show (`false`) for this state,
    /// recording it. `None` when it is already in step.
    ///
    /// The state is kept because `SetMenu` and `DrawMenuBar` change the client area
    /// by a menu bar's height and dispatch another `Resized`: acting on every resize
    /// would hide and show the bar forever.
    pub fn change(&self, fullscreen: bool) -> Option<bool> {
        (self.0.swap(fullscreen, Ordering::SeqCst) != fullscreen).then_some(fullscreen)
    }
}

/// Hides the menu bar in full screen and restores it on the way out.
///
/// `is_menu_visible` is deliberately not called: it answers through the event loop
/// (`run_on_main_thread` and a blocking channel), and this runs on the very thread
/// that loop would have to reach. `is_fullscreen` is safe here because the runtime
/// answers a getter from the main thread inline instead of posting it.
pub fn follow_fullscreen<R: Runtime>(window: &Window<R>) {
    let Ok(fullscreen) = window.is_fullscreen() else {
        return;
    };
    match MENU_BAR.change(fullscreen) {
        Some(true) => {
            let _ = window.hide_menu();
        }
        Some(false) => {
            let _ = window.show_menu();
        }
        None => {}
    }
}
