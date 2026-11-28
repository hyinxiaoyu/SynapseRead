use serde::Serialize;
use synapse_core::CoreError;
use synapse_lan::LanError;

/// Error shape received by the frontend: see `IpcError` in `types/domain.ts`.
#[derive(Debug, Clone, Serialize)]
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

impl From<LanError> for IpcError {
    fn from(error: LanError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub type IpcResult<T> = Result<T, IpcError>;
