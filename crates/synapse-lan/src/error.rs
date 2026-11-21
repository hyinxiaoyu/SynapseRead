use std::net::Ipv4Addr;

use thiserror::Error;

pub type LanResult<T> = Result<T, LanError>;

/// Errors produced by `synapse-lan` with stable machine-readable codes matching
/// ADR 0008. Kept separate from `synapse_core::CoreError` so LAN sync modules
/// evolve without coupling to core schema/IPC PRs.
#[derive(Debug, Error)]
pub enum LanError {
    // Address & listener
    #[error("invalid LAN address: {0}")]
    AddressInvalid(String),

    #[error("LAN address unavailable: {0}")]
    AddressUnavailable(String),

    #[error("failed to bind LAN listener: {0}")]
    BindFailed(String),

    #[error("all LAN sync ports ({start_port}..={end_port}) on {ip} are in use")]
    PortsExhausted {
        ip: Ipv4Addr,
        start_port: u16,
        end_port: u16,
    },

    #[error("network interface changed: {0}")]
    NetworkChanged(String),

    // Connection
    #[error("LAN peer unreachable: {0}")]
    Unreachable(String),

    #[error("incompatible LAN sync protocol: {0}")]
    ProtocolIncompatible(String),

    #[error("LAN source stopped: {0}")]
    SourceStopped(String),

    // Authorization
    #[error("invalid pairing code or bearer token")]
    AuthInvalid,

    #[error("pairing code or session expired")]
    AuthExpired,

    #[error("pairing attempt limit exceeded")]
    AttemptsExceeded,

    #[error("LAN sharing session is already paired with another device")]
    SessionBusy,

    #[error("LAN sharing scope denied: {0}")]
    ScopeDenied(String),

    // Transfer
    #[error("another file transfer is already active")]
    TransferBusy,

    #[error("source book changed during sharing session: {0}")]
    SourceChanged(String),

    #[error("transferred byte count mismatch (expected {expected}, got {actual})")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error("transferred file SHA-256 hash mismatch")]
    HashMismatch,

    #[error("LAN payload exceeded size limit: {0}")]
    PayloadTooLarge(String),

    #[error("insufficient disk space for LAN import: {0}")]
    DiskFull(String),

    #[error("LAN operation cancelled")]
    Cancelled,

    // Merge / core
    #[error("reading position conflict: {0}")]
    PositionConflict(String),

    #[error(transparent)]
    Core(#[from] synapse_core::CoreError),
}

impl LanError {
    /// Stable machine-readable code matching ADR 0008.
    pub fn code(&self) -> &'static str {
        match self {
            Self::AddressInvalid(_) => "lan_address_invalid",
            Self::AddressUnavailable(_) => "lan_address_unavailable",
            Self::BindFailed(_) => "lan_bind_failed",
            Self::PortsExhausted { .. } => "lan_ports_exhausted",
            Self::NetworkChanged(_) => "lan_network_changed",
            Self::Unreachable(_) => "lan_unreachable",
            Self::ProtocolIncompatible(_) => "lan_protocol_incompatible",
            Self::SourceStopped(_) => "lan_source_stopped",
            Self::AuthInvalid => "lan_auth_invalid",
            Self::AuthExpired => "lan_auth_expired",
            Self::AttemptsExceeded => "lan_attempts_exceeded",
            Self::SessionBusy => "lan_session_busy",
            Self::ScopeDenied(_) => "lan_scope_denied",
            Self::TransferBusy => "lan_transfer_busy",
            Self::SourceChanged(_) => "lan_source_changed",
            Self::SizeMismatch { .. } => "lan_size_mismatch",
            Self::HashMismatch => "lan_hash_mismatch",
            Self::PayloadTooLarge(_) => "lan_payload_too_large",
            Self::DiskFull(_) => "lan_disk_full",
            Self::Cancelled => "lan_cancelled",
            Self::PositionConflict(_) => "lan_position_conflict",
            Self::Core(err) => err.code(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_match_adr_0008() {
        assert_eq!(
            LanError::AddressInvalid("bad".into()).code(),
            "lan_address_invalid"
        );
        assert_eq!(
            LanError::AddressUnavailable("gone".into()).code(),
            "lan_address_unavailable"
        );
        assert_eq!(
            LanError::BindFailed("eacces".into()).code(),
            "lan_bind_failed"
        );
        assert_eq!(
            LanError::PortsExhausted {
                ip: Ipv4Addr::new(192, 168, 1, 10),
                start_port: 49319,
                end_port: 49328,
            }
            .code(),
            "lan_ports_exhausted"
        );
        assert_eq!(
            LanError::NetworkChanged("en0 down".into()).code(),
            "lan_network_changed"
        );
        assert_eq!(
            LanError::Unreachable("timeout".into()).code(),
            "lan_unreachable"
        );
        assert_eq!(
            LanError::ProtocolIncompatible("v2".into()).code(),
            "lan_protocol_incompatible"
        );
        assert_eq!(
            LanError::SourceStopped("closed".into()).code(),
            "lan_source_stopped"
        );
        assert_eq!(LanError::AuthInvalid.code(), "lan_auth_invalid");
        assert_eq!(LanError::AuthExpired.code(), "lan_auth_expired");
        assert_eq!(LanError::AttemptsExceeded.code(), "lan_attempts_exceeded");
        assert_eq!(LanError::SessionBusy.code(), "lan_session_busy");
        assert_eq!(
            LanError::ScopeDenied("bookmarks".into()).code(),
            "lan_scope_denied"
        );
        assert_eq!(LanError::TransferBusy.code(), "lan_transfer_busy");
        assert_eq!(
            LanError::SourceChanged("relinked".into()).code(),
            "lan_source_changed"
        );
        assert_eq!(
            LanError::SizeMismatch {
                expected: 10,
                actual: 5
            }
            .code(),
            "lan_size_mismatch"
        );
        assert_eq!(LanError::HashMismatch.code(), "lan_hash_mismatch");
        assert_eq!(
            LanError::PayloadTooLarge("9 MiB".into()).code(),
            "lan_payload_too_large"
        );
        assert_eq!(LanError::DiskFull("enospc".into()).code(), "lan_disk_full");
        assert_eq!(LanError::Cancelled.code(), "lan_cancelled");
        assert_eq!(
            LanError::PositionConflict("stale".into()).code(),
            "lan_position_conflict"
        );
    }
}
