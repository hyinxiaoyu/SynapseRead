//! The asset protocol scope, derived from the `documents` table.
//!
//! `tauri.conf.json` declares an empty scope. Everything the webview may load
//! is granted here, so there is one definition of what is readable: see
//! `docs/adr/0001-path-scope.md`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use synapse_core::CoreResult;
use synapse_core::db::{hash_document_for_registration, hash_document_for_relink};
use synapse_core::domain::{Document, DocumentFormat, RelinkDocumentResult};
use tauri::{Manager, Runtime};

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Emitted after native OS drag-and-drop paths are registered.
pub const DOCUMENTS_DROPPED_EVENT: &str = "synapse://documents-dropped";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedDocumentsPayload {
    pub documents: Vec<Document>,
    pub error: Option<IpcError>,
}

/// Allows exactly these documents' files. `allow_file` escapes glob characters,
/// so a file named `[a]*.pdf` grants only itself.
pub fn grant_documents<R: Runtime>(app: &impl Manager<R>, documents: &[Document]) -> IpcResult<()> {
    let scope = app.asset_protocol_scope();
    for document in documents {
        scope
            .allow_file(&document.file_path)
            .map_err(|error| IpcError::internal(error.to_string()))?;
    }
    Ok(())
}

/// Grants everything the database says the webview may load: every registered
/// document, plus the capture directory. Scopes are not persisted between
/// launches, so this runs at every startup.
pub fn grant_all<R: Runtime>(app: &impl Manager<R>, state: &AppState) -> IpcResult<()> {
    let database = state.database()?;
    grant_documents(app, &database.list_documents()?)?;
    if let Some(captures) = database.captures_directory() {
        // Not recursive, and the glob skips dotfiles such as in-progress writes.
        // The database beside this directory stays out of scope.
        std::fs::create_dir_all(&captures)
            .map_err(|error| IpcError::internal(error.to_string()))?;
        app.asset_protocol_scope()
            .allow_directory(&captures, false)
            .map_err(|error| IpcError::internal(error.to_string()))?;
    }
    Ok(())
}

/// Registers a path that came from a native source, then makes it loadable.
///
/// Hashing runs outside the database lock so large files do not stall other
/// commands.
pub fn register_and_grant<R: Runtime>(app: &impl Manager<R>, path: &Path) -> IpcResult<Document> {
    register_and_grant_with_hasher(app, path, hash_document_for_registration)
}

pub(crate) fn register_and_grant_with_hasher<R, F>(
    app: &impl Manager<R>,
    path: &Path,
    hasher: F,
) -> IpcResult<Document>
where
    R: Runtime,
    F: FnOnce(&Path) -> CoreResult<String>,
{
    let file_hash = hasher(path)?;
    let document = app
        .state::<AppState>()
        .database()?
        .register_document_with_hash(path, &file_hash)?;
    grant_documents(app, std::slice::from_ref(&document))?;
    Ok(document)
}

/// Relinks an existing document to a replacement path from the native picker,
/// then grants asset-protocol access to the new file.
///
/// The existing record is read under a brief lock, file hashing runs outside
/// the lock, and commit rechecks format and hash uniqueness in a transaction.
pub fn relink_and_grant<R: Runtime>(
    app: &impl Manager<R>,
    document_id: &str,
    path: &Path,
) -> IpcResult<RelinkDocumentResult> {
    relink_and_grant_with_hasher(app, document_id, path, hash_document_for_relink)
}

pub(crate) fn relink_and_grant_with_hasher<R, F>(
    app: &impl Manager<R>,
    document_id: &str,
    path: &Path,
    hasher: F,
) -> IpcResult<RelinkDocumentResult>
where
    R: Runtime,
    F: FnOnce(DocumentFormat, &Path) -> CoreResult<String>,
{
    let existing = app
        .state::<AppState>()
        .database()?
        .get_document(document_id)?;
    let new_hash = hasher(existing.format, path)?;
    let result = app
        .state::<AppState>()
        .database()?
        .relink_document_with_hash(document_id, path, &new_hash)?;
    grant_documents(app, std::slice::from_ref(&result.document))?;
    Ok(result)
}

/// Registers every supported file dropped onto the window from the OS and
/// grants its asset scope, capturing the first registration error if any path
/// cannot be opened.
pub fn register_dropped_paths<R: Runtime>(
    app: &impl Manager<R>,
    paths: &[PathBuf],
) -> DroppedDocumentsPayload {
    let mut documents = Vec::with_capacity(paths.len());
    let mut error = None;
    for path in paths {
        match register_and_grant(app, path) {
            Ok(document) => documents.push(document),
            Err(err) => {
                if error.is_none() {
                    error = Some(err);
                }
            }
        }
    }
    DroppedDocumentsPayload { documents, error }
}
