//! Persistence commands. Each one is a thin adapter over `synapse_core::db`.

use std::path::Path;

use synapse_core::domain::{
    AnchorLocation, CardPatch, CreateExcerptInput, CreatedExcerpt, Document, MindMapEdge,
    NodeLayoutPatch, NoteCard, NotebookGraph, StudyNotebook, Viewport,
};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[tauri::command]
pub fn register_document(path: String, state: State<'_, AppState>) -> IpcResult<Document> {
    Ok(state.database()?.register_document(Path::new(&path))?)
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
