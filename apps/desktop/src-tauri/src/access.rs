//! The asset protocol scope, derived from the `documents` table.
//!
//! `tauri.conf.json` declares an empty scope. Everything the webview may load
//! is granted here, so there is one definition of what is readable: see
//! `docs/adr/0001-path-scope.md`.

use std::path::Path;

use synapse_core::domain::Document;
use tauri::{Manager, Runtime};

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

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
pub fn register_and_grant<R: Runtime>(app: &impl Manager<R>, path: &Path) -> IpcResult<Document> {
    let document = app
        .state::<AppState>()
        .database()?
        .register_document(path)?;
    grant_documents(app, std::slice::from_ref(&document))?;
    Ok(document)
}
