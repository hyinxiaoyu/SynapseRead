//! Persistence commands. Each one is a thin adapter over `synapse_core::db`.

use std::path::{Path, PathBuf};
use synapse_core::CoreResult;
use synapse_core::db::verify_document_file_with_hasher;
use synapse_core::domain::DocumentFormat;
use synapse_core::fs_reader::hash_file;

use synapse_core::domain::{
    AnchorLocation, Annotation, AnnotationPatch, Bookmark, CardPatch, CreateAnnotationInput,
    CreateBookmarkInput, CreateExcerptInput, CreatedExcerpt, DeletedCard, Document,
    DocumentSourceStatus, MindMapEdge, NodeLayoutPatch, NoteCard, NotebookGraph, PdfLayout,
    ReadingPreferences, RelinkDocumentResult, RestoredAnnotation, RestoredCard, StudyNotebook,
    Viewport, WorkspaceSession,
};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::access::{register_and_grant, relink_and_grant};
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
    progress: Option<f64>,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    Ok(state
        .database()?
        .update_document_cursor(&document_id, &anchor, progress)?)
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
pub fn create_annotation(
    input: CreateAnnotationInput,
    state: State<'_, AppState>,
) -> IpcResult<Annotation> {
    Ok(state.database()?.create_annotation(&input)?)
}

#[tauri::command]
pub fn update_annotation(
    annotation_id: String,
    patch: AnnotationPatch,
    state: State<'_, AppState>,
) -> IpcResult<Annotation> {
    Ok(state
        .database()?
        .update_annotation(&annotation_id, &patch)?)
}

#[tauri::command]
pub fn delete_annotation(annotation_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    Ok(state.database()?.delete_annotation(&annotation_id)?)
}

#[tauri::command]
pub fn restore_annotation(
    annotation_id: String,
    state: State<'_, AppState>,
) -> IpcResult<RestoredAnnotation> {
    Ok(state.database()?.restore_annotation(&annotation_id)?)
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
pub fn delete_card(card_id: String, state: State<'_, AppState>) -> IpcResult<DeletedCard> {
    Ok(state.database()?.delete_card(&card_id)?)
}

#[tauri::command]
pub fn restore_card(card_id: String, state: State<'_, AppState>) -> IpcResult<RestoredCard> {
    Ok(state.database()?.restore_card(&card_id)?)
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

#[tauri::command]
pub fn get_reading_preferences(state: State<'_, AppState>) -> IpcResult<ReadingPreferences> {
    Ok(state.database()?.get_reading_preferences()?)
}

#[tauri::command]
pub fn save_reading_preferences(
    preferences: ReadingPreferences,
    state: State<'_, AppState>,
) -> IpcResult<ReadingPreferences> {
    Ok(state.database()?.save_reading_preferences(&preferences)?)
}

#[tauri::command]
pub fn get_pdf_layout(document_id: String, state: State<'_, AppState>) -> IpcResult<PdfLayout> {
    Ok(state.database()?.get_pdf_layout(&document_id)?)
}

#[tauri::command]
pub fn save_pdf_layout(
    document_id: String,
    layout: PdfLayout,
    state: State<'_, AppState>,
) -> IpcResult<PdfLayout> {
    Ok(state.database()?.save_pdf_layout(&document_id, &layout)?)
}

#[tauri::command]
pub fn list_bookmarks(state: State<'_, AppState>) -> IpcResult<Vec<Bookmark>> {
    Ok(state.database()?.list_bookmarks()?)
}

#[tauri::command]
pub fn create_bookmark(
    input: CreateBookmarkInput,
    state: State<'_, AppState>,
) -> IpcResult<Bookmark> {
    Ok(state.database()?.create_bookmark(&input)?)
}

#[tauri::command]
pub fn delete_bookmark(bookmark_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    Ok(state.database()?.delete_bookmark(&bookmark_id)?)
}

#[tauri::command]
pub fn touch_document_opened(
    document_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Document> {
    Ok(state.database()?.touch_document_opened(&document_id)?)
}

#[tauri::command]
pub fn hide_document_from_recent(
    document_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Document> {
    Ok(state.database()?.hide_document_from_recent(&document_id)?)
}

#[tauri::command]
pub fn set_document_display_title(
    document_id: String,
    display_title: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Document> {
    Ok(state
        .database()?
        .set_document_display_title(&document_id, display_title.as_deref())?)
}

#[tauri::command]
pub fn get_workspace_session(state: State<'_, AppState>) -> IpcResult<WorkspaceSession> {
    Ok(state.database()?.get_workspace_session()?)
}

#[tauri::command]
pub fn save_workspace_session(
    session: WorkspaceSession,
    state: State<'_, AppState>,
) -> IpcResult<WorkspaceSession> {
    Ok(state.database()?.save_workspace_session(&session)?)
}

/// Reads the document record under a brief lock, verifies `fs::metadata` and
/// `hash_file` outside the database lock so large files do not stall other
/// commands, then rechecks the database row under a brief lock before returning.
/// If a concurrent relink changed `file_path` or `file_hash` while hashing was
/// in flight, verification retries against the updated record instead of
/// returning a stale status.
pub(crate) fn verify_document_source_with_hasher<R, F>(
    app: &impl Manager<R>,
    document_id: &str,
    mut hasher: F,
) -> IpcResult<DocumentSourceStatus>
where
    R: Runtime,
    F: FnMut(&Path) -> CoreResult<String>,
{
    const MAX_VERIFY_ATTEMPTS: usize = 8;

    let mut snapshot = app
        .state::<AppState>()
        .database()?
        .get_document(document_id)?;

    for _ in 0..MAX_VERIFY_ATTEMPTS {
        let result = verify_document_file_with_hasher(&snapshot, &mut hasher);
        let current = app
            .state::<AppState>()
            .database()?
            .get_document(document_id)?;
        if current.file_path == snapshot.file_path && current.file_hash == snapshot.file_hash {
            return Ok(result?);
        }
        snapshot = current;
    }

    Err(IpcError::internal(format!(
        "document {document_id} changed repeatedly during verification"
    )))
}

#[tauri::command]
pub async fn verify_document_source(
    document_id: String,
    app: AppHandle<impl Runtime>,
) -> IpcResult<DocumentSourceStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        verify_document_source_with_hasher(&app, &document_id, hash_file)
    })
    .await
    .map_err(|error| IpcError::internal(error.to_string()))?
}

/// Shows the native file picker to explicitly relink `document_id` to a new file
/// (or confirm an in-place modified file when `confirm_in_place` is true).
#[tauri::command]
pub async fn relink_document<R: Runtime>(
    document_id: String,
    confirm_in_place: Option<bool>,
    app: AppHandle<R>,
) -> IpcResult<Option<RelinkDocumentResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let existing = app
            .state::<AppState>()
            .database()?
            .get_document(&document_id)?;
        let path = if confirm_in_place.unwrap_or(false) {
            PathBuf::from(&existing.file_path)
        } else {
            let picked = app
                .dialog()
                .file()
                .add_filter("Documents", existing.format.extensions())
                .blocking_pick_file();
            let Some(picked) = picked else {
                return Ok(None);
            };
            picked
                .into_path()
                .map_err(|error| IpcError::internal(error.to_string()))?
        };
        relink_and_grant(&app, &document_id, &path).map(Some)
    })
    .await
    .map_err(|error| IpcError::internal(error.to_string()))?
}
