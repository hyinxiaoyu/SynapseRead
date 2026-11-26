//! Tauri adapter: wires `synapse-core` to IPC commands. Keep logic in the core crate.

mod access;
mod close_flush;
mod commands;
mod error;
mod menu;
#[cfg(not(target_os = "macos"))]
mod menu_bar;
mod state;

use tauri::{Builder, Manager, Runtime, Url};

use close_flush::{
    BEFORE_CLOSE_EVENT, BeforeClosePayload, CloseDecision, CloseFlushCoordinator, FLUSH_TIMEOUT,
};
use state::AppState;

const DATABASE_FILE: &str = "synapseread.sqlite3";

/// Registers every IPC command. Generic over the runtime so tests can exercise
/// the real command layer on Tauri's mock runtime, without a webview.
fn with_commands<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::db::pick_document,
        commands::db::list_documents,
        commands::db::update_document_cursor,
        commands::db::create_notebook,
        commands::db::list_notebooks,
        commands::db::save_notebook_viewport,
        commands::db::load_notebook_graph,
        commands::db::create_excerpt,
        commands::db::create_annotation,
        commands::db::update_annotation,
        commands::db::delete_annotation,
        commands::db::restore_annotation,
        commands::db::capture_path,
        commands::db::update_card,
        commands::db::delete_card,
        commands::db::restore_card,
        commands::db::update_node_layout,
        commands::db::create_edge,
        commands::db::delete_edge,
        commands::db::get_reading_preferences,
        commands::db::save_reading_preferences,
        commands::db::get_pdf_layout,
        commands::db::save_pdf_layout,
        commands::db::list_bookmarks,
        commands::db::create_bookmark,
        commands::db::delete_bookmark,
        commands::db::touch_document_opened,
        commands::db::hide_document_from_recent,
        commands::db::set_document_display_title,
        commands::db::get_workspace_session,
        commands::db::save_workspace_session,
        commands::db::verify_document_source,
        commands::db::relink_document,
        commands::fs_reader::read_text_stream,
        commands::fs_reader::cancel_text_stream,
        commands::lan::lan_list_interfaces,
        commands::lan::lan_share_start,
        commands::lan::lan_share_status,
        commands::lan::lan_share_regenerate_code,
        commands::lan::lan_share_stop,
        commands::lan::lan_share_disconnect_peer,
        commands::lan::lan_import_connect,
        commands::lan::lan_import_catalog,
        commands::lan::lan_import_plan,
        commands::lan::lan_import_execute,
        commands::lan::lan_import_cancel,
        commands::lan::lan_import_disconnect,
        menu::set_menu_item_states,
        close_flush::confirm_flush_before_close,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = with_commands(Builder::default().plugin(tauri_plugin_dialog::init()))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::open(&data_dir.join(DATABASE_FILE))?;
            access::grant_all(app, &state)?;
            app.manage(state);
            app.manage(CloseFlushCoordinator::default());
            let (menu, menu_items) = menu::build(app)?;
            app.set_menu(menu)?;
            app.manage(menu_items);
            create_main_window(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == menu::QUIT_MENU_ID {
                request_app_exit(app);
                return;
            }
            if let Some(payload) = menu::menu_command_payload(event.id().as_ref()) {
                let _ = tauri::Emitter::emit(app, menu::MENU_COMMAND_EVENT, &payload);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                // Tear down active LAN sharing and receiver imports immediately
                // so closing the last window on macOS never leaves a socket or
                // background import running (`R2-03`, `R3-05`, `T-10`).
                app.state::<AppState>().lan.shutdown_all();
                let coordinator = app.state::<CloseFlushCoordinator>();
                match coordinator.begin_close() {
                    CloseDecision::Proceed => {}
                    CloseDecision::AlreadyWaiting => {
                        api.prevent_close();
                    }
                    CloseDecision::StartFlush(token) => {
                        api.prevent_close();
                        let _ = tauri::Emitter::emit(
                            window,
                            BEFORE_CLOSE_EVENT,
                            &BeforeClosePayload { token },
                        );
                        let window = window.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let coordinator = app.state::<CloseFlushCoordinator>();
                            coordinator.wait_for_flush(token, FLUSH_TIMEOUT);
                            app.state::<AppState>().lan.shutdown_all();
                            coordinator.mark_allow_close();
                            let _ = window.close();
                        });
                    }
                }
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let payload = access::register_dropped_paths(&app, &paths);
                    let _ = tauri::Emitter::emit(&app, access::DOCUMENTS_DROPPED_EVENT, &payload);
                });
            }
            // Full screen has no window event of its own: entering and leaving it
            // both arrive as a resize.
            #[cfg(not(target_os = "macos"))]
            {
                if matches!(event, tauri::WindowEvent::Resized(_)) {
                    menu_bar::follow_fullscreen(window);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build SynapseRead");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // Always tear down active LAN sharing and receiver imports
                // before any early return (including programmatic `code.is_some()`
                // exits from `request_app_exit`: `R2-03`, `R3-05`, `T-10`).
                app_handle.state::<AppState>().lan.shutdown_all();
                // Programmatic exit or no live windows: proceed immediately.
                if code.is_some() || app_handle.webview_windows().is_empty() {
                    return;
                }
                let coordinator = app_handle.state::<CloseFlushCoordinator>();
                match coordinator.begin_exit() {
                    CloseDecision::Proceed => {}
                    CloseDecision::AlreadyWaiting => {
                        api.prevent_exit();
                    }
                    CloseDecision::StartFlush(token) => {
                        api.prevent_exit();
                        spawn_exit_flush(app_handle, token);
                    }
                }
            }
            tauri::RunEvent::Exit => {
                app_handle.state::<AppState>().lan.shutdown_all();
            }
            _ => {}
        }
    });
}

/// Flushes unsaved webview drafts before exiting the app (used by the explicit
/// Quit menu item / `⌘Q`, since macOS `PredefinedMenuItem::quit` invokes AppKit
/// `terminate:` directly and bypasses `RunEvent::ExitRequested`: #117).
fn request_app_exit<R: Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<AppState>().lan.shutdown_all();
    if app.webview_windows().is_empty() {
        app.exit(0);
        return;
    }
    let coordinator = app.state::<CloseFlushCoordinator>();
    match coordinator.begin_exit() {
        CloseDecision::Proceed => app.exit(0),
        CloseDecision::AlreadyWaiting => {}
        CloseDecision::StartFlush(token) => spawn_exit_flush(app, token),
    }
}

fn spawn_exit_flush<R: Runtime>(app: &tauri::AppHandle<R>, token: u64) {
    let _ = tauri::Emitter::emit(app, BEFORE_CLOSE_EVENT, &BeforeClosePayload { token });
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let coordinator = app.state::<CloseFlushCoordinator>();
        coordinator.wait_for_flush(token, FLUSH_TIMEOUT);
        app.state::<AppState>().lan.shutdown_all();
        coordinator.mark_allow_exit();
        app.exit(0);
    });
}

/// The window is created here rather than from `tauri.conf.json` so that only
/// macOS gets the unified title bar: the toolbar draws under the traffic lights,
/// while Windows and Linux keep their standard frame. It is also where the webview
/// is kept inside the app: no second window, and no navigation off the app's own
/// content (#84).
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.first().cloned() else {
        return Ok(());
    };
    // Only a dev build loads from the Vite server. A release build refuses it even
    // though the embedded config still names it.
    let dev_server = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        // A document link or `window.open` must not open a second webview: the
        // app's own tabs are the only way to another document.
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |url| is_app_navigation(url, dev_server.as_ref()));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 22.0));
    builder.build()?;
    Ok(())
}

/// Whether the main webview may follow `url`.
///
/// Only the app's own content may replace it. `about:` covers the `srcdoc` frames
/// EPUB chapters are rendered into, and `blob:` and `data:` the URLs PDF.js and
/// packaged images draw from; none of them leaves the app. A remote page,
/// `view-source:`, or `javascript:` is refused, so a stray link or a browser
/// accelerator cannot navigate away from the app.
fn is_app_navigation(url: &Url, dev_server: Option<&Url>) -> bool {
    match url.scheme() {
        // The bundled app: `tauri://localhost`, and the asset protocol it serves
        // documents and captures from.
        "tauri" | "asset" => true,
        "http" | "https" => {
            matches!(url.host_str(), Some("tauri.localhost" | "asset.localhost"))
                || dev_server.is_some_and(|dev| dev.origin() == url.origin())
        }
        "about" | "blob" | "data" => true,
        _ => false,
    }
}

#[cfg(test)]
mod ipc_tests;

#[cfg(test)]
mod window_tests;
