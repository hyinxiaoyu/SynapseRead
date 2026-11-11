//! Tauri adapter: wires `synapse-core` to IPC commands. Keep logic in the core crate.

mod access;
mod commands;
mod error;
mod menu;
mod state;

use tauri::{Builder, Manager, Runtime};

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
        commands::db::capture_path,
        commands::db::update_card,
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
        commands::db::get_workspace_session,
        commands::db::save_workspace_session,
        commands::db::verify_document_source,
        commands::db::relink_document,
        commands::fs_reader::read_text_stream,
        commands::fs_reader::cancel_text_stream,
        menu::set_menu_item_states,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(Builder::default().plugin(tauri_plugin_dialog::init()))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::open(&data_dir.join(DATABASE_FILE))?;
            access::grant_all(app, &state)?;
            app.manage(state);
            let (menu, menu_items) = menu::build(app)?;
            app.set_menu(menu)?;
            app.manage(menu_items);
            create_main_window(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(payload) = menu::menu_command_payload(event.id().as_ref()) {
                let _ = tauri::Emitter::emit(app, menu::MENU_COMMAND_EVENT, &payload);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let payload = access::register_dropped_paths(&app, &paths);
                    let _ = tauri::Emitter::emit(&app, access::DOCUMENTS_DROPPED_EVENT, &payload);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run SynapseRead");
}

/// The window is created here rather than from `tauri.conf.json` so that only
/// macOS gets the unified title bar: the toolbar draws under the traffic lights,
/// while Windows and Linux keep their standard frame.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.first().cloned() else {
        return Ok(());
    };
    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 22.0));
    builder.build()?;
    Ok(())
}

#[cfg(test)]
mod ipc_tests;
