//! Platform-neutral core of SynapseRead.
//!
//! Nothing here depends on Tauri, so the persistence layer and the decoding
//! pipeline build and test on any host without a webview. The desktop crate
//! only adapts these APIs to Tauri commands.

pub mod db;
pub mod domain;
pub mod error;
pub mod fs_reader;

pub use error::{CoreError, CoreResult};
