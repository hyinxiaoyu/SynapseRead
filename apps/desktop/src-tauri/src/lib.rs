//! Tauri adapter: wires `synapse-core` to IPC commands. Keep logic in the core crate.

mod access;
mod commands;
mod error;
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
        commands::db::capture_path,
        commands::db::update_card,
        commands::db::update_node_layout,
        commands::db::create_edge,
        commands::db::delete_edge,
        commands::fs_reader::read_text_stream,
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
            Ok(())
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

#[cfg(test)]
mod ipc_tests;
