//! Text streaming command.

use std::sync::Arc;

use synapse_core::CoreError;
use synapse_core::fs_reader::{TextChunk, stream_text_file_with_cancel};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Streams a registered document to the frontend as UTF-8 chunks, resolving to the number
/// of chunks delivered. `encoding` of `None` means auto-detect, which in V1
/// always selects UTF-8 with lossy fallback.
///
/// Runs on a blocking thread so a huge file never stalls the async runtime.
/// Closing the reader tab cancels the stream via [`cancel_text_stream`] or a
/// closed channel without an error.
#[tauri::command]
pub async fn read_text_stream(
    document_id: String,
    encoding: Option<String>,
    stream_id: Option<String>,
    on_chunk: Channel<TextChunk>,
    state: State<'_, AppState>,
) -> IpcResult<u64> {
    let decoders = Arc::clone(&state.decoders);
    let ticket = state.streams.register(stream_id.as_deref());
    let path = state.database()?.document_path(&document_id)?;
    let delivered = tauri::async_runtime::spawn_blocking(move || {
        stream_text_file_with_cancel(
            &path,
            encoding.as_deref(),
            &decoders,
            ticket.flag(),
            |chunk| on_chunk.send(chunk).map_err(|_| CoreError::StreamCancelled),
        )
    })
    .await
    .map_err(|error| IpcError::internal(error.to_string()))??;
    Ok(delivered)
}

/// Cancels an active or pending text stream identified by `stream_id`.
#[tauri::command]
pub fn cancel_text_stream(stream_id: String, state: State<'_, AppState>) -> bool {
    state.streams.cancel(&stream_id)
}
