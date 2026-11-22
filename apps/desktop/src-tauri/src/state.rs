use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use synapse_core::CoreResult;
use synapse_core::db::Database;
use synapse_core::fs_reader::{DecoderRegistry, StreamCancellationRegistry};

use crate::commands::lan::LanState;
use crate::error::IpcError;

pub struct AppState {
    database: Arc<Mutex<Database>>,
    /// Shared with blocking stream tasks, which outlive the command borrowing state.
    pub decoders: Arc<DecoderRegistry>,
    /// Shared registry for cancelling closed-tab TXT streams immediately.
    pub streams: Arc<StreamCancellationRegistry>,
    /// Rust-owned LAN sync sharing/import runtime state (ADR 0008).
    pub lan: Arc<LanState>,
}

impl AppState {
    pub fn open(database_path: &Path) -> CoreResult<Self> {
        Self::open_with_lan(database_path, LanState::new())
    }

    pub fn open_with_lan(database_path: &Path, lan: LanState) -> CoreResult<Self> {
        Ok(Self {
            database: Arc::new(Mutex::new(Database::open(database_path)?)),
            decoders: Arc::new(DecoderRegistry::default()),
            streams: Arc::new(StreamCancellationRegistry::default()),
            lan: Arc::new(lan),
        })
    }

    pub fn database(&self) -> Result<MutexGuard<'_, Database>, IpcError> {
        self.database
            .lock()
            .map_err(|_| IpcError::internal("database lock poisoned"))
    }

    pub fn database_arc(&self) -> Arc<Mutex<Database>> {
        Arc::clone(&self.database)
    }
}
