use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("unsupported text encoding: {0}")]
    UnsupportedEncoding(String),

    #[error("unsupported document format: {0}")]
    UnsupportedFormat(String),

    #[error("invalid anchor: {0}")]
    InvalidAnchor(String),

    #[error("invalid capture: {0}")]
    InvalidCapture(String),

    #[error("invalid graph operation: {0}")]
    InvalidGraph(String),

    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },

    /// The consumer of a text stream went away; reading stops without error UI.
    #[error("stream cancelled by consumer")]
    StreamCancelled,
}

impl CoreError {
    /// Stable machine-readable code the frontend can branch on.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Database(_) => "database",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            Self::UnsupportedEncoding(_) => "unsupported_encoding",
            Self::UnsupportedFormat(_) => "unsupported_format",
            Self::InvalidAnchor(_) => "invalid_anchor",
            Self::InvalidCapture(_) => "invalid_capture",
            Self::InvalidGraph(_) => "invalid_graph",
            Self::NotFound { .. } => "not_found",
            Self::StreamCancelled => "stream_cancelled",
        }
    }
}
