//! Persistence commands. Each one is a thin adapter over `synapse_core::db`.

use std::path::PathBuf;
use synapse_core::domain::DocumentFormat;

use synapse_core::domain::{
    AnchorLocation, CardPatch, CreateExcerptInput, CreatedExcerpt, Document, MindMapEdge,
    NodeLayoutPatch, NoteCard, NotebookGraph, StudyNotebook, Viewport,
};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::access::register_and_grant;
use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Shows the native picker and registers the chosen file, resolving to `None`
/// on cancel. The webview cannot name a path: see `docs/adr/0001-path-scope.md`.
///
/// The dialog blocks and hashing a large file is slow, so neither may run on
/// the main thread or a runtime worker.
#[tauri::command]
pub async fn pick_document<R: Runtime>(app: AppHandle<R>) -> IpcResult<Option<Document>> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Documents", DocumentFormat::EXTENSIONS)
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|error| IpcError::internal(error.to_string()))?;
        register_and_grant(&app, &path).map(Some)
    })
    .await
    .map_err(|error| IpcError::internal(error.to_string()))?
}

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> IpcResult<Vec<Document>> {
    Ok(state.database()?.list_documents()?)
}

#[tauri::command]
pub fn update_document_cursor(
    document_id: String,
    anchor: AnchorLocation,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    Ok(state
        .database()?
        .update_document_cursor(&document_id, &anchor)?)
}

#[tauri::command]
pub fn create_notebook(title: String, state: State<'_, AppState>) -> IpcResult<StudyNotebook> {
    Ok(state.database()?.create_notebook(&title)?)
}

#[tauri::command]
pub fn list_notebooks(state: State<'_, AppState>) -> IpcResult<Vec<StudyNotebook>> {
    Ok(state.database()?.list_notebooks()?)
}

#[tauri::command]
pub fn save_notebook_viewport(
    notebook_id: String,
    viewport: Viewport,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    Ok(state
        .database()?
        .save_notebook_viewport(&notebook_id, &viewport)?)
}

#[tauri::command]
pub fn load_notebook_graph(
    notebook_id: String,
    state: State<'_, AppState>,
) -> IpcResult<NotebookGraph> {
    Ok(state.database()?.load_notebook_graph(&notebook_id)?)
}

#[tauri::command]
pub fn create_excerpt(
    input: CreateExcerptInput,
    state: State<'_, AppState>,
) -> IpcResult<CreatedExcerpt> {
    Ok(state.database()?.create_excerpt(&input)?)
}

/// Where an annotation's capture lives, for the asset protocol to load.
#[tauri::command]
pub fn capture_path(
    annotation_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Option<PathBuf>> {
    Ok(state.database()?.capture_path(&annotation_id)?)
}

#[tauri::command]
pub fn update_card(
    card_id: String,
    patch: CardPatch,
    state: State<'_, AppState>,
) -> IpcResult<NoteCard> {
    Ok(state.database()?.update_card(&card_id, &patch)?)
}

#[tauri::command]
pub fn update_node_layout(
    node_id: String,
    patch: NodeLayoutPatch,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    Ok(state.database()?.update_node_layout(&node_id, &patch)?)
}

#[tauri::command]
pub fn create_edge(
    notebook_id: String,
    source_node_id: String,
    target_node_id: String,
    label: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<MindMapEdge> {
    Ok(state.database()?.create_edge(
        &notebook_id,
        &source_node_id,
        &target_node_id,
        label.as_deref(),
    )?)
}

#[tauri::command]
pub fn delete_edge(edge_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    Ok(state.database()?.delete_edge(&edge_id)?)
}
