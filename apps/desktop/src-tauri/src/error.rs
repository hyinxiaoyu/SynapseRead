use serde::Serialize;
use synapse_core::CoreError;

/// Error shape received by the frontend: see `IpcError` in `types/domain.ts`.
#[derive(Debug, Serialize)]
pub struct IpcError {
    code: &'static str,
    message: String,
}

impl From<CoreError> for IpcError {
    fn from(error: CoreError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl IpcError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal",
            message: message.into(),
        }
    }
}

pub type IpcResult<T> = Result<T, IpcError>;
