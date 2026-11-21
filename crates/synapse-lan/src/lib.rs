//! Tauri-free session-scoped local LAN book sync crate for SynapseRead
//! (ADR 0008).
//!
//! All network activity in this crate is strictly user-initiated, session-scoped,
//! and restricted to private IPv4 / link-local (`169.254.0.0/16`) same-subnet
//! peers. Loopback (`127.0.0.1`) is available only via test-gated constructors
//! unreachable from Tauri IPC.

pub mod address;
pub mod bind;
pub mod error;
pub mod listener;

pub use address::{
    AddressPolicy, InterfaceProvider, Ipv4Subnet, LanInterface, PeerPolicy, PeerRejectReason,
    RawInterface, SystemInterfaceProvider, is_lan_ipv4, list_candidate_interfaces,
    parse_lan_address, select_candidate_interfaces,
};
pub use bind::{BoundListener, DEFAULT_LAN_PORT, LAN_PORT_END, LAN_PORT_START, bind_auto};
pub use error::{LanError, LanResult};
pub use listener::{
    ConnectionHandler, DEFAULT_CODE_EXPIRY, DEFAULT_IDLE_TIMEOUT, DEFAULT_INTERFACE_POLL_INTERVAL,
    DEFAULT_MAX_CONNECTIONS, LanListener, LanListenerHandle, ListenerConfig, ListenerEvent,
    ListenerStopReason, MAX_CONCURRENT_CONNECTIONS, MonotonicClock, PlaceholderHttp1Handler,
    TokioMonotonicClock,
};
