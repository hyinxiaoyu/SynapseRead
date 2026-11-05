//! Text streaming command.

use std::path::PathBuf;
use std::sync::Arc;

use synapse_core::CoreError;
use synapse_core::fs_reader::{TextChunk, stream_text_file};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Streams a text file to the frontend as UTF-8 chunks, resolving to the number
/// of chunks delivered. `encoding` of `None` means auto-detect, which in V1
/// always selects UTF-8 with lossy fallback.
///
/// Runs on a blocking thread so a huge file never stalls the async runtime. A
/// closed channel (reader tab closed) ends the read early without an error.
#[tauri::command]
pub async fn read_text_stream(
    path: String,
    encoding: Option<String>,
    on_chunk: Channel<TextChunk>,
    state: State<'_, AppState>,
) -> IpcResult<u64> {
    let decoders = Arc::clone(&state.decoders);
    let path = PathBuf::from(path);
    let delivered = tauri::async_runtime::spawn_blocking(move || {
        stream_text_file(&path, encoding.as_deref(), &decoders, |chunk| {
            on_chunk.send(chunk).map_err(|_| CoreError::StreamCancelled)
        })
    })
    .await
    .map_err(|error| IpcError::internal(error.to_string()))??;
    Ok(delivered)
}
