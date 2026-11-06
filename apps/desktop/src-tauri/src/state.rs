use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use synapse_core::CoreResult;
use synapse_core::db::Database;
use synapse_core::fs_reader::{DecoderRegistry, StreamCancellationRegistry};

use crate::error::IpcError;

pub struct AppState {
    database: Mutex<Database>,
    /// Shared with blocking stream tasks, which outlive the command borrowing state.
    pub decoders: Arc<DecoderRegistry>,
    /// Shared registry for cancelling closed-tab TXT streams immediately.
    pub streams: Arc<StreamCancellationRegistry>,
}

impl AppState {
    pub fn open(database_path: &Path) -> CoreResult<Self> {
        Ok(Self {
            database: Mutex::new(Database::open(database_path)?),
            decoders: Arc::new(DecoderRegistry::default()),
            streams: Arc::new(StreamCancellationRegistry::default()),
        })
    }

    pub fn database(&self) -> Result<MutexGuard<'_, Database>, IpcError> {
        self.database
            .lock()
            .map_err(|_| IpcError::internal("database lock poisoned"))
    }
}
