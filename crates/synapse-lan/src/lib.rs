//! Tauri-free session-scoped local LAN book sync crate for SynapseRead
//! (ADR 0008).
//!
//! All network activity in this crate is strictly user-initiated, session-scoped,
//! and restricted to private IPv4 / link-local (`169.254.0.0/16`) same-subnet
//! peers. Loopback (`127.0.0.1`) is available only via test-gated constructors
//! unreachable from Tauri IPC.

pub mod address;
pub mod bind;
pub mod client;
#[cfg(test)]
mod e2e_tests;
pub mod error;
pub mod http;
pub mod listener;
pub mod orchestrator;
pub mod session;
pub mod source;
pub mod wire;

pub use address::{
    AddressPolicy, InterfaceProvider, Ipv4Subnet, LanInterface, PeerPolicy, PeerRejectReason,
    RawInterface, SystemInterfaceProvider, is_lan_ipv4, list_candidate_interfaces,
    parse_lan_address, select_candidate_interfaces,
};
pub use bind::{BoundListener, DEFAULT_LAN_PORT, LAN_PORT_END, LAN_PORT_START, bind_auto};
pub use client::{
    CancelHandle, CancelToken, CatalogBook as RemoteCatalogBook,
    CatalogResponse as RemoteCatalogResponse, DEFAULT_CONNECT_TIMEOUT, DEFAULT_INACTIVITY_TIMEOUT,
    DEFAULT_MAX_IDLE_CONNECTIONS, HelloInfo, LanClient, LanClientConfig, MAX_BOOKMARKS_PER_BOOK,
    MAX_BOOKMARKS_RESPONSE_BYTES, MAX_CATALOG_BOOKS, MAX_CATALOG_RESPONSE_BYTES,
    MAX_CONTROL_RESPONSE_BYTES, MAX_POSITION_RESPONSE_BYTES, PairedClient, ParsedBookmark,
    ParsedPosition, WireBookmark as RemoteBookmark,
};
pub use error::{LanError, LanResult};
pub use http::{
    DEFAULT_BODY_READ_TIMEOUT, DEFAULT_HEADER_READ_TIMEOUT, ErrorResponseBody, HttpServerConfig,
    LanBoxBody, LanHttpHandler, LanResponse, MAX_HEADER_BYTES, MAX_POST_BODY_BYTES,
    MAX_REQUEST_HEADERS, PROTOCOL_HEADER, PROTOCOL_VERSION, SourceApiHandler,
    UnimplementedSourceApiHandler, empty_body, error_response, finalize_response, full_body,
    is_valid_sha256_hex, json_response, lan_error_response, no_content_response,
};
pub use listener::{
    ConnectionHandler, DEFAULT_CODE_EXPIRY, DEFAULT_IDLE_TIMEOUT, DEFAULT_INTERFACE_POLL_INTERVAL,
    DEFAULT_MAX_CONNECTIONS, LanListener, LanListenerHandle, ListenerConfig, ListenerControl,
    ListenerEvent, ListenerStopReason, MAX_CONCURRENT_CONNECTIONS, MonotonicClock,
    PlaceholderHttp1Handler, TokioMonotonicClock,
};
pub use orchestrator::{
    BookCommitEvent, BookImportDecision, BookImportResult, BookPlanSummary, BookSyncState,
    BookmarkExecutionSummary, BookmarkPlanSkipReason, BookmarkPlanSummary,
    CatalogBookClassification, ComponentOutcome, DefaultStageFactory, ImportErrorInfo,
    ImportExecutionReport, ImportPlan, ImportPlanSummary, ImportProgress, MAX_PLANNER_CONCURRENCY,
    OrchestratorConfig, PlanProgress, PlannedBookmarkPreview, PlannedBookmarkStatus,
    PositionPlanSummary, StageFactory, classify_catalog, execute_import,
    execute_import_with_stage_factory, plan_import,
};
pub use session::{
    AuthorizedContext, BearerToken, DEFAULT_MAX_FAILED_ATTEMPTS, DEFAULT_PER_IP_MAX_ATTEMPTS,
    DEFAULT_PER_IP_WINDOW, PairOutcome, PairingCode, SessionConfig, SessionManager, SessionStatus,
    SharePermissions, SnapshotBook, TransferGuard,
};
pub use source::SqliteSourceApiHandler;
pub use wire::{
    BookmarksResponse, CatalogBook, CatalogResponse, HelloResponse, PairRequest, PairResponse,
    PositionResponse, WireBookmark,
};
