//! Thin Tauri IPC adapter for session-scoped local LAN book sync (ADR 0008, `#143`).
//!
//! All network, protocol, and merge logic lives in `crates/synapse-lan` and
//! `crates/synapse-core`. This module handles:
//! - native OS share confirmation (`OD-11`, `T-12`)
//! - Rust-owned bearer tokens, peer handles, and `ImportPlan` cursor snapshots (`R3-07`)
//! - per-book asset grants before completion progress events emit (`R2-07`)
//! - cancellation of in-flight receiver operations and full teardown on window close / exit (`R2-03`, `R3-05`)

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use synapse_core::domain::{Document, ImportLimits};
use synapse_lan::{
    AddressPolicy, BookCommitEvent, BookImportDecision, BookImportResult, BookSyncState,
    BookmarkExecutionSummary, BoundListener, CancelHandle, CancelToken, CatalogBookClassification,
    ComponentOutcome, HttpServerConfig, ImportErrorInfo, ImportExecutionReport, ImportPlan,
    ImportPlanSummary, ImportProgress, InterfaceProvider, LanClient, LanError, LanHttpHandler,
    LanInterface, LanListener, LanListenerHandle, LanResult, ListenerConfig, ListenerEvent,
    ListenerStopReason, OrchestratorConfig, PairedClient, PeerPolicy, PeerRejectReason,
    PlanProgress, RemoteCatalogBook, SessionConfig, SessionManager, SessionStatus,
    SharePermissions, SnapshotBook, SqliteSourceApiHandler, SystemInterfaceProvider,
    TokioMonotonicClock, bind_auto, classify_catalog, execute_import, list_candidate_interfaces,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

use crate::access;
use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Emitted whenever an active sharing listener blocks an out-of-subnet peer or
/// stops (timeout, network change, session end, or user stop).
pub const LAN_SHARE_EVENT: &str = "synapse://lan-share-event";

const DISCONNECT_SESSION_END_TIMEOUT: Duration = Duration::from_secs(2);

/// Summary shown to the user in the Rust-native confirmation dialog before
/// opening any LAN listening socket (`OD-11`, `F-03`, `T-12`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareConfirmPrompt {
    pub book_count: usize,
    pub positions: bool,
    pub bookmarks: bool,
    pub bind_ip: Ipv4Addr,
    pub interface_name: String,
}

impl ShareConfirmPrompt {
    pub fn title(&self) -> &'static str {
        "Share Books on This Network"
    }

    pub fn message(&self) -> String {
        let noun = if self.book_count == 1 {
            "book"
        } else {
            "books"
        };
        let mut includes = vec!["book files"];
        if self.positions {
            includes.push("reading positions");
        }
        if self.bookmarks {
            includes.push("bookmarks");
        }
        format!(
            "Share {} {noun} on your local network ({})?\n\nIncludes: {}.\n\nUse only on networks you trust. Transfers are not encrypted.",
            self.book_count,
            self.bind_ip,
            includes.join(", ")
        )
    }
}

/// Injectable confirmation hook for tests (`T-12`); production builds use
/// `tauri-plugin-dialog`.
pub type ShareConfirmer = Arc<dyn Fn(&ShareConfirmPrompt) -> bool + Send + Sync>;

/// Test-only socket binder hook so `ipc_tests` can exercise real listener
/// stop/rebind lifecycles on CI runners without a physical LAN IP.
#[cfg(test)]
pub type ShareBinder = Arc<dyn Fn(Ipv4Addr) -> LanResult<BoundListener> + Send + Sync>;

// ---------------------------------------------------------------------------
// IPC DTOs (strictly camelCase, zero tokens, zero local/peer paths, zero anchors)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareStartInput {
    pub document_ids: Vec<String>,
    pub positions: bool,
    pub bookmarks: bool,
    #[serde(default)]
    pub interface_ip: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LanShareStatus {
    Off,
    Listening {
        failed_attempts: u32,
        max_failed_attempts: u32,
    },
    CodeLocked,
    Paired {
        peer_ip: Ipv4Addr,
    },
}

impl From<SessionStatus> for LanShareStatus {
    fn from(value: SessionStatus) -> Self {
        match value {
            SessionStatus::Off => Self::Off,
            SessionStatus::Listening {
                failed_attempts,
                max_failed_attempts,
            } => Self::Listening {
                failed_attempts,
                max_failed_attempts,
            },
            SessionStatus::CodeLocked => Self::CodeLocked,
            SessionStatus::Paired { peer_ip } => Self::Paired { peer_ip },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareSnapshot {
    pub status: LanShareStatus,
    pub address: Option<String>,
    pub interface_name: Option<String>,
    pub pairing_code: Option<String>,
    pub code_expires_at_ms: Option<u64>,
    pub permissions: Option<SharePermissions>,
    pub shared_book_count: usize,
    pub blocked_peer_count: u64,
    pub last_blocked_peer_ip: Option<String>,
    pub last_stop_reason: Option<ListenerStopReason>,
    pub last_stop_error_code: Option<&'static str>,
}

impl LanShareSnapshot {
    fn off(
        last_stop_reason: Option<ListenerStopReason>,
        blocked_peer_count: u64,
        last_blocked_peer_ip: Option<String>,
    ) -> Self {
        Self {
            status: LanShareStatus::Off,
            address: None,
            interface_name: None,
            pairing_code: None,
            code_expires_at_ms: None,
            permissions: None,
            shared_book_count: 0,
            blocked_peer_count,
            last_blocked_peer_ip,
            last_stop_reason,
            last_stop_error_code: last_stop_reason.and_then(ListenerStopReason::error_code),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LanShareEventKind {
    PeerBlocked {
        peer_ip: String,
        reason: PeerRejectReason,
        total_blocked: u64,
    },
    Stopped {
        reason: ListenerStopReason,
        error_code: Option<&'static str>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareEventPayload {
    pub event: LanShareEventKind,
    pub snapshot: LanShareSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportConnectInput {
    pub address: String,
    pub code: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportSessionInfo {
    pub session_id: String,
    pub address: String,
    pub idle_timeout_seconds: u64,
    pub permissions: SharePermissions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportPlanInput {
    pub session_id: String,
    pub book_ids: Vec<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportPlanResult {
    pub plan_id: String,
    pub summary: ImportPlanSummary,
    pub default_decisions: Vec<BookImportDecision>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportExecuteInput {
    pub session_id: String,
    pub plan_id: String,
    pub decisions: Vec<BookImportDecision>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LanComponentOutcome {
    Applied,
    Skipped {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Blocked {
        reason: String,
    },
    Conflict {
        code: String,
        has_current_position: bool,
        current_progress: Option<f64>,
    },
    Failed {
        error: ImportErrorInfo,
    },
    Cancelled,
}

impl From<ComponentOutcome> for LanComponentOutcome {
    fn from(value: ComponentOutcome) -> Self {
        match value {
            ComponentOutcome::Applied => Self::Applied,
            ComponentOutcome::Skipped { reason } => Self::Skipped { reason },
            ComponentOutcome::Blocked { reason } => Self::Blocked { reason },
            ComponentOutcome::Conflict {
                code,
                has_current_position,
                current_progress,
            } => Self::Conflict {
                code,
                has_current_position,
                current_progress,
            },
            ComponentOutcome::Failed { error } => Self::Failed { error },
            ComponentOutcome::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanBookImportResult {
    pub book_id: String,
    pub document_id: Option<String>,
    pub state: BookSyncState,
    pub file: LanComponentOutcome,
    pub position: LanComponentOutcome,
    pub bookmarks: LanComponentOutcome,
    pub bookmark_counts: BookmarkExecutionSummary,
}

impl From<BookImportResult> for LanBookImportResult {
    fn from(value: BookImportResult) -> Self {
        Self {
            book_id: value.book_id,
            document_id: value.document_id,
            state: value.state,
            file: value.file.into(),
            position: value.position.into(),
            bookmarks: value.bookmarks.into(),
            bookmark_counts: value.bookmark_counts,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LanImportProgress {
    BookStarted {
        book_id: String,
        book_index: usize,
        total_books: usize,
    },
    FileTransfer {
        book_id: String,
        downloaded_bytes: u64,
        total_bytes: u64,
    },
    BookCompleted {
        book_id: String,
        book_index: usize,
        total_books: usize,
        result: Box<LanBookImportResult>,
    },
}

impl From<ImportProgress> for LanImportProgress {
    fn from(value: ImportProgress) -> Self {
        match value {
            ImportProgress::BookStarted {
                book_id,
                book_index,
                total_books,
            } => Self::BookStarted {
                book_id,
                book_index,
                total_books,
            },
            ImportProgress::FileTransfer {
                book_id,
                downloaded_bytes,
                total_bytes,
            } => Self::FileTransfer {
                book_id,
                downloaded_bytes,
                total_bytes,
            },
            ImportProgress::BookCompleted {
                book_id,
                book_index,
                total_books,
                result,
            } => Self::BookCompleted {
                book_id,
                book_index,
                total_books,
                result: Box::new((*result).into()),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanImportExecutionReport {
    pub books: Vec<LanBookImportResult>,
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_error: Option<ImportErrorInfo>,
}

impl From<ImportExecutionReport> for LanImportExecutionReport {
    fn from(value: ImportExecutionReport) -> Self {
        Self {
            books: value.books.into_iter().map(Into::into).collect(),
            cancelled: value.cancelled,
            session_error: value.session_error,
        }
    }
}

// ---------------------------------------------------------------------------
// Rust-owned LAN runtime state (never serialized across IPC)
// ---------------------------------------------------------------------------

struct ActiveShare {
    generation: u64,
    handle: LanListenerHandle,
    session: Arc<SessionManager>,
    address: String,
    interface_name: String,
    pairing_code: Option<String>,
    code_expires_at_ms: Option<u64>,
    shared_book_count: usize,
    blocked_peer_count: u64,
    last_blocked_peer_ip: Option<String>,
}

impl ActiveShare {
    fn snapshot(&mut self) -> LanShareSnapshot {
        let status = self.session.status();
        let blocked_peer_count = self
            .blocked_peer_count
            .max(self.handle.blocked_peer_count());
        self.blocked_peer_count = blocked_peer_count;

        if !matches!(status, SessionStatus::Listening { .. }) {
            self.pairing_code = None;
        }
        if matches!(status, SessionStatus::Off | SessionStatus::Paired { .. }) {
            self.code_expires_at_ms = None;
        }

        LanShareSnapshot {
            status: status.into(),
            address: Some(self.address.clone()),
            interface_name: Some(self.interface_name.clone()),
            pairing_code: self.pairing_code.clone(),
            code_expires_at_ms: self.code_expires_at_ms,
            permissions: Some(self.session.permissions()),
            shared_book_count: self.shared_book_count,
            blocked_peer_count,
            last_blocked_peer_ip: self.last_blocked_peer_ip.clone(),
            last_stop_reason: None,
            last_stop_error_code: None,
        }
    }
}

#[derive(Default)]
enum SharePhase {
    #[default]
    Idle,
    /// Exclusive reservation held while preparing and awaiting native OS confirmation.
    /// Stop / Close / Quit flips `invalidated = true` so a late confirmation never binds.
    Starting {
        generation: u64,
        invalidated: bool,
    },
    Active(Box<ActiveShare>),
    /// Held while awaiting `LanListenerHandle::wait_stopped()` so a new share cannot
    /// start until the old socket has exited and released its port.
    Stopping {
        generation: u64,
    },
}

#[derive(Default)]
struct ShareRuntime {
    next_generation: u64,
    phase: SharePhase,
    /// Latched `true` by `shutdown_all()` when window close or app exit begins,
    /// preventing any late `lan_share_start` from opening a confirmation dialog
    /// or binding a socket during close-flush.
    closing: bool,
    last_stop_reason: Option<ListenerStopReason>,
    last_blocked_peer_count: u64,
    last_blocked_peer_ip: Option<String>,
}

impl ShareRuntime {
    /// Transitions a naturally exited `Active` listener to `Idle` so callers
    /// see an accurate state immediately.
    fn reap_if_stopped(&mut self) {
        let stopped_reason = match &self.phase {
            SharePhase::Active(active) => active.handle.stop_reason(),
            _ => None,
        };
        if let Some(reason) = stopped_reason
            && let SharePhase::Active(active) = std::mem::replace(&mut self.phase, SharePhase::Idle)
        {
            self.last_stop_reason = Some(reason);
            self.last_blocked_peer_count = active
                .blocked_peer_count
                .max(active.handle.blocked_peer_count());
            self.last_blocked_peer_ip = active.last_blocked_peer_ip;
        }
    }
}

struct ReceiverSession {
    client: PairedClient,
    catalog_books: Vec<RemoteCatalogBook>,
    plans: HashMap<String, ImportPlan>,
    executing_plans: HashSet<String>,
}

struct ActiveOperation {
    registration_id: u64,
    session_id: Option<String>,
    cancel: CancelHandle,
}

#[derive(Default)]
struct ReceiverRuntime {
    next_registration_id: u64,
    /// Latched `true` by `shutdown_all()` when window close or app exit begins,
    /// preventing any late `lan_import_*` operation from registering or starting
    /// network I/O during close-flush.
    closing: bool,
    sessions: HashMap<String, ReceiverSession>,
    operations: HashMap<String, ActiveOperation>,
}

impl ReceiverRuntime {
    fn register_operation(
        &mut self,
        lan: &Arc<LanState>,
        operation_id: Option<String>,
        session_id: Option<String>,
    ) -> (OperationGuard, CancelToken) {
        let key = operation_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.next_registration_id = self.next_registration_id.wrapping_add(1);
        let registration_id = self.next_registration_id;
        let (handle, token) = CancelHandle::new();
        if let Some(previous) = self.operations.insert(
            key.clone(),
            ActiveOperation {
                registration_id,
                session_id,
                cancel: handle,
            },
        ) {
            previous.cancel.cancel();
        }
        (
            OperationGuard {
                lan: Arc::clone(lan),
                key,
                registration_id,
            },
            token,
        )
    }

    fn is_operation_active(&self, guard: &OperationGuard) -> bool {
        self.operations
            .get(&guard.key)
            .is_some_and(|op| op.registration_id == guard.registration_id)
    }
}

/// Manages active LAN sharing and receiver import state inside Rust `AppState`.
pub struct LanState {
    share: Mutex<ShareRuntime>,
    receiver: Mutex<ReceiverRuntime>,
    confirmer: Option<ShareConfirmer>,
    interface_provider: Arc<dyn InterfaceProvider>,
    #[cfg(test)]
    binder: Option<ShareBinder>,
}

impl Default for LanState {
    fn default() -> Self {
        Self::new()
    }
}

impl LanState {
    pub fn new() -> Self {
        Self {
            share: Mutex::new(ShareRuntime::default()),
            receiver: Mutex::new(ReceiverRuntime::default()),
            confirmer: None,
            interface_provider: Arc::new(SystemInterfaceProvider),
            #[cfg(test)]
            binder: None,
        }
    }

    #[cfg(test)]
    pub fn with_overrides(
        confirmer: Option<ShareConfirmer>,
        interface_provider: Arc<dyn InterfaceProvider>,
    ) -> Self {
        Self::with_test_hooks(confirmer, interface_provider, None)
    }

    #[cfg(test)]
    pub fn with_test_hooks(
        confirmer: Option<ShareConfirmer>,
        interface_provider: Arc<dyn InterfaceProvider>,
        binder: Option<ShareBinder>,
    ) -> Self {
        Self {
            share: Mutex::new(ShareRuntime::default()),
            receiver: Mutex::new(ReceiverRuntime::default()),
            confirmer,
            interface_provider,
            binder,
        }
    }

    #[cfg(test)]
    pub fn register_operation_for_tests(
        self: &Arc<Self>,
        operation_id: &str,
    ) -> (OperationGuard, CancelToken) {
        let mut receiver = self.receiver.lock().unwrap();
        receiver.register_operation(self, Some(operation_id.to_owned()), None)
    }

    #[cfg(test)]
    pub fn set_stopping_for_tests(&self) {
        let mut share = self.share.lock().unwrap();
        share.next_generation = share.next_generation.wrapping_add(1);
        let generation = share.next_generation;
        share.phase = SharePhase::Stopping { generation };
    }

    #[cfg(test)]
    pub fn clear_stopping_for_tests(&self) {
        let mut share = self.share.lock().unwrap();
        if matches!(share.phase, SharePhase::Stopping { .. }) {
            share.phase = SharePhase::Idle;
        }
    }

    fn bind_listener(&self, ip: Ipv4Addr) -> LanResult<BoundListener> {
        #[cfg(test)]
        if let Some(binder) = &self.binder {
            return binder(ip);
        }
        bind_auto(ip)
    }

    fn lock_share(&self) -> Result<std::sync::MutexGuard<'_, ShareRuntime>, IpcError> {
        self.share
            .lock()
            .map_err(|_| IpcError::internal("LAN share state lock poisoned"))
    }

    fn lock_receiver(&self) -> Result<std::sync::MutexGuard<'_, ReceiverRuntime>, IpcError> {
        self.receiver
            .lock()
            .map_err(|_| IpcError::internal("LAN receiver state lock poisoned"))
    }

    pub fn cancel_operation(&self, operation_id: &str) -> bool {
        let Ok(receiver) = self.receiver.lock() else {
            return false;
        };
        if let Some(op) = receiver.operations.get(operation_id) {
            op.cancel.cancel();
            true
        } else {
            false
        }
    }

    /// Synchronously stops any active sharing listener/session, invalidates any
    /// in-flight share confirmation, and cancels every active receiver operation
    /// (`R2-03`, `R3-05`, `T-10`). Idempotent and safe to call across window
    /// close and all app-exit hooks.
    pub fn shutdown_all(&self) {
        if let Ok(mut share) = self.share.lock() {
            share.closing = true;
            match &mut share.phase {
                SharePhase::Idle | SharePhase::Stopping { .. } => {}
                SharePhase::Starting { invalidated, .. } => {
                    *invalidated = true;
                    share.last_stop_reason = Some(ListenerStopReason::Shutdown);
                }
                SharePhase::Active(_) => {
                    if let SharePhase::Active(active) =
                        std::mem::replace(&mut share.phase, SharePhase::Idle)
                    {
                        share.last_stop_reason = Some(ListenerStopReason::Shutdown);
                        share.last_blocked_peer_count = active
                            .blocked_peer_count
                            .max(active.handle.blocked_peer_count());
                        share.last_blocked_peer_ip = active.last_blocked_peer_ip.clone();
                        // Send Shutdown to listener BEFORE revoking session so stop reason is Shutdown.
                        active.handle.shutdown();
                        active.session.revoke();
                    }
                }
            }
        }

        if let Ok(mut receiver) = self.receiver.lock() {
            receiver.closing = true;
            for op in receiver.operations.values() {
                op.cancel.cancel();
            }
            receiver.operations.clear();
            receiver.sessions.clear();
        }
    }

    fn share_snapshot(&self) -> IpcResult<LanShareSnapshot> {
        let mut share = self.lock_share()?;
        share.reap_if_stopped();
        match &mut share.phase {
            SharePhase::Active(active) => Ok(active.snapshot()),
            SharePhase::Idle | SharePhase::Starting { .. } | SharePhase::Stopping { .. } => {
                Ok(LanShareSnapshot::off(
                    share.last_stop_reason,
                    share.last_blocked_peer_count,
                    share.last_blocked_peer_ip.clone(),
                ))
            }
        }
    }

    fn record_listener_event(
        &self,
        generation: u64,
        event: &ListenerEvent,
    ) -> Option<LanShareEventPayload> {
        let mut share = self.share.lock().ok()?;
        match event {
            ListenerEvent::PeerBlocked {
                peer_ip,
                reason,
                total_blocked,
            } => {
                let SharePhase::Active(active) = &mut share.phase else {
                    return None;
                };
                if active.generation != generation {
                    return None;
                }
                active.blocked_peer_count = active.blocked_peer_count.max(*total_blocked);
                active.last_blocked_peer_ip = Some(peer_ip.to_string());
                let snapshot = active.snapshot();
                Some(LanShareEventPayload {
                    event: LanShareEventKind::PeerBlocked {
                        peer_ip: peer_ip.to_string(),
                        reason: *reason,
                        total_blocked: *total_blocked,
                    },
                    snapshot,
                })
            }
            ListenerEvent::Stopped { reason } => {
                let is_matching_active = matches!(
                    &share.phase,
                    SharePhase::Active(active) if active.generation == generation
                );
                if !is_matching_active {
                    return None;
                }
                let SharePhase::Active(active) =
                    std::mem::replace(&mut share.phase, SharePhase::Idle)
                else {
                    return None;
                };
                let blocked_count = active
                    .blocked_peer_count
                    .max(active.handle.blocked_peer_count());
                let last_blocked_ip = active.last_blocked_peer_ip.clone();
                share.last_stop_reason = Some(*reason);
                share.last_blocked_peer_count = blocked_count;
                share.last_blocked_peer_ip = last_blocked_ip.clone();
                let snapshot = LanShareSnapshot::off(Some(*reason), blocked_count, last_blocked_ip);
                Some(LanShareEventPayload {
                    event: LanShareEventKind::Stopped {
                        reason: *reason,
                        error_code: reason.error_code(),
                    },
                    snapshot,
                })
            }
        }
    }
}

/// RAII guard that releases a `SharePhase::Starting` reservation if
/// `lan_share_start` returns early, is declined, or fails before transitioning
/// to `Active`.
struct StartReservationGuard {
    lan: Arc<LanState>,
    generation: u64,
    armed: bool,
}

impl StartReservationGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartReservationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut share) = self.lan.share.lock()
            && matches!(
                share.phase,
                SharePhase::Starting { generation, .. } if generation == self.generation
            )
        {
            share.phase = SharePhase::Idle;
        }
    }
}

/// RAII guard for a registered receiver operation. Checks `registration_id` on
/// drop so a stale guard can never delete a newer operation reusing the same
/// `operationId`.
pub struct OperationGuard {
    lan: Arc<LanState>,
    key: String,
    registration_id: u64,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut receiver) = self.lan.receiver.lock()
            && receiver
                .operations
                .get(&self.key)
                .is_some_and(|op| op.registration_id == self.registration_id)
        {
            receiver.operations.remove(&self.key);
        }
    }
}

/// RAII guard for a checked-out `ImportPlan` during `lan_import_execute`,
/// guaranteeing `executing_plans` and `plans` are always restored even on early
/// return or panic.
struct PlanCheckoutGuard {
    lan: Arc<LanState>,
    session_id: String,
    plan_id: String,
    plan: Option<ImportPlan>,
}

impl PlanCheckoutGuard {
    fn plan_mut(&mut self) -> Option<&mut ImportPlan> {
        self.plan.as_mut()
    }
}

impl Drop for PlanCheckoutGuard {
    fn drop(&mut self) {
        if let Some(plan) = self.plan.take()
            && let Ok(mut receiver) = self.lan.receiver.lock()
            && let Some(session) = receiver.sessions.get_mut(&self.session_id)
        {
            session.executing_plans.remove(&self.plan_id);
            session.plans.insert(self.plan_id.clone(), plan);
        }
    }
}

fn epoch_ms_after(duration: Duration) -> Option<u64> {
    let deadline = SystemTime::now().checked_add(duration)?;
    let ms = deadline.duration_since(UNIX_EPOCH).ok()?.as_millis();
    u64::try_from(ms).ok()
}

fn validate_pairing_code_format(code: &str) -> IpcResult<()> {
    if code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(IpcError::new(
            "lan_auth_invalid",
            "pairing code must be exactly 6 digits",
        ))
    }
}

async fn confirm_share<R: Runtime>(
    app: &AppHandle<R>,
    lan: &LanState,
    prompt: ShareConfirmPrompt,
) -> IpcResult<bool> {
    if let Some(confirmer) = &lan.confirmer {
        let confirmer = Arc::clone(confirmer);
        return tauri::async_runtime::spawn_blocking(move || confirmer(&prompt))
            .await
            .map_err(|err| IpcError::internal(err.to_string()));
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(prompt.message())
            .title(prompt.title())
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Start Sharing".into(),
                "Cancel".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|err| IpcError::internal(err.to_string()))
}

// ---------------------------------------------------------------------------
// Sharing (Source) IPC Commands
// ---------------------------------------------------------------------------

/// Lists vetted private/link-local broadcast-capable IPv4 interfaces eligible
/// for binding a sharing listener.
#[tauri::command]
pub async fn lan_list_interfaces(state: State<'_, AppState>) -> IpcResult<Vec<LanInterface>> {
    let provider = Arc::clone(&state.lan.interface_provider);
    let interfaces =
        tauri::async_runtime::spawn_blocking(move || list_candidate_interfaces(provider.as_ref()))
            .await
            .map_err(|err| IpcError::internal(err.to_string()))??;
    Ok(interfaces)
}

/// Starts a session-scoped LAN sharing listener after native OS confirmation
/// (`OD-11`, `F-03`, `T-12`). Returns `None` if the user declines confirmation.
#[tauri::command]
pub async fn lan_share_start<R: Runtime>(
    app: AppHandle<R>,
    input: LanShareStartInput,
    state: State<'_, AppState>,
) -> IpcResult<Option<LanShareSnapshot>> {
    if input.document_ids.is_empty() {
        return Err(IpcError::new(
            "lan_scope_denied",
            "select at least one book to share",
        ));
    }

    // Reserve an exclusive `Starting` slot before any async work or dialog so
    // concurrent Starts are serialized (`lan_session_busy`) and Stop/Close/Quit
    // can invalidate an in-flight confirmation.
    let generation = {
        let mut share = state.lan.lock_share()?;
        if share.closing {
            return Err(LanError::Cancelled.into());
        }
        share.reap_if_stopped();
        if !matches!(share.phase, SharePhase::Idle) {
            return Err(LanError::SessionBusy.into());
        }
        share.next_generation = share.next_generation.wrapping_add(1);
        let generation = share.next_generation;
        share.phase = SharePhase::Starting {
            generation,
            invalidated: false,
        };
        generation
    };
    let mut reservation = StartReservationGuard {
        lan: Arc::clone(&state.lan),
        generation,
        armed: true,
    };

    // Deduplicate requested document IDs and capture `(document_id, file_hash)`
    // snapshot from SQLite (`R3-03`).
    let mut seen = HashSet::with_capacity(input.document_ids.len());
    let unique_ids: Vec<String> = input
        .document_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();

    let db_arc = state.database_arc();
    let snapshot_books =
        tauri::async_runtime::spawn_blocking(move || -> IpcResult<Vec<SnapshotBook>> {
            let db = db_arc
                .lock()
                .map_err(|_| IpcError::internal("database lock poisoned"))?;
            let mut books = Vec::with_capacity(unique_ids.len());
            for id in unique_ids {
                let doc: Document = db.get_document(&id)?;
                books.push(SnapshotBook {
                    document_id: doc.id,
                    snapshot_file_hash: doc.file_hash,
                });
            }
            Ok(books)
        })
        .await
        .map_err(|err| IpcError::internal(err.to_string()))??;

    // Resolve target LAN interface candidate.
    let provider = Arc::clone(&state.lan.interface_provider);
    let requested_ip = match input.interface_ip {
        Some(raw) => {
            let parsed: Ipv4Addr = raw.trim().parse().map_err(|_| {
                LanError::AddressInvalid(format!("invalid IPv4 interface address: {raw}"))
            })?;
            AddressPolicy::lan_only().validate_ip(parsed)?;
            Some(parsed)
        }
        None => None,
    };

    let candidates =
        tauri::async_runtime::spawn_blocking(move || list_candidate_interfaces(provider.as_ref()))
            .await
            .map_err(|err| IpcError::internal(err.to_string()))??;

    let selected = match requested_ip {
        Some(ip) => candidates
            .into_iter()
            .find(|iface| iface.subnet.ip == ip)
            .ok_or_else(|| {
                LanError::AddressUnavailable(format!(
                    "selected LAN interface {ip} is not available"
                ))
            })?,
        None => candidates.into_iter().next().ok_or_else(|| {
            LanError::AddressUnavailable("no eligible local network interface found".into())
        })?,
    };

    // Native OS confirmation before binding any socket (`OD-11`, `T-12`).
    let prompt = ShareConfirmPrompt {
        book_count: snapshot_books.len(),
        positions: input.positions,
        bookmarks: input.bookmarks,
        bind_ip: selected.subnet.ip,
        interface_name: selected.name.clone(),
    };
    if !confirm_share(&app, &state.lan, prompt).await? {
        return Ok(None);
    }

    // Validate the `Starting` reservation, bind the socket, start the listener,
    // and transition `Starting -> Active` atomically under the same lock so
    // Close / Quit / Stop cannot race between confirmation and registration.
    let (events_rx, snapshot) = {
        let mut share = state.lan.lock_share()?;
        if share.closing {
            if matches!(
                share.phase,
                SharePhase::Starting { generation: g, .. } if g == generation
            ) {
                share.phase = SharePhase::Idle;
            }
            reservation.disarm();
            return Err(LanError::Cancelled.into());
        }
        match share.phase {
            SharePhase::Starting {
                generation: current_gen,
                invalidated: false,
            } if current_gen == generation => {}
            _ => {
                if matches!(
                    share.phase,
                    SharePhase::Starting { generation: g, .. } if g == generation
                ) {
                    share.phase = SharePhase::Idle;
                }
                reservation.disarm();
                return Err(LanError::Cancelled.into());
            }
        }

        let peer_policy = PeerPolicy::for_subnet(selected.subnet)?;
        let bound = state.lan.bind_listener(selected.subnet.ip)?;
        let bound_addr = bound.local_addr;

        let clock = Arc::new(TokioMonotonicClock);
        let session_config = SessionConfig::default();
        let permissions = SharePermissions {
            positions: input.positions,
            bookmarks: input.bookmarks,
        };
        let shared_book_count = snapshot_books.len();
        let (session, pairing_code) =
            SessionManager::new(session_config, clock.clone(), permissions, snapshot_books)?;
        let session = Arc::new(session);

        let api = Arc::new(SqliteSourceApiHandler::new(state.database_arc()));
        let handler = Arc::new(LanHttpHandler::new(
            bound_addr,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        ));

        let listener_config = ListenerConfig::default();
        let handle = LanListener::start(
            bound,
            peer_policy,
            Arc::clone(&state.lan.interface_provider),
            clock,
            listener_config,
            handler,
        );
        session.attach_listener(handle.control());

        let events_rx = handle.subscribe_events();
        let code_expires_at_ms = epoch_ms_after(session_config.code_expiry);
        let address = bound_addr.to_string();

        share.last_stop_reason = None;
        share.last_blocked_peer_count = 0;
        share.last_blocked_peer_ip = None;
        let mut active = ActiveShare {
            generation,
            handle,
            session,
            address,
            interface_name: selected.name,
            pairing_code: Some(pairing_code.expose().to_owned()),
            code_expires_at_ms,
            shared_book_count,
            blocked_peer_count: 0,
            last_blocked_peer_ip: None,
        };
        let snapshot = active.snapshot();
        share.phase = SharePhase::Active(Box::new(active));
        reservation.disarm();
        (events_rx, snapshot)
    };

    // Forward listener diagnostics (`PeerBlocked`, `Stopped`) to the webview.
    let lan_for_events = Arc::clone(&state.lan);
    let app_for_events = app.clone();
    let mut events_rx = events_rx;
    tauri::async_runtime::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(event) => {
                    let stopped = matches!(event, ListenerEvent::Stopped { .. });
                    if let Some(payload) = lan_for_events.record_listener_event(generation, &event)
                    {
                        let _ = app_for_events.emit(LAN_SHARE_EVENT, &payload);
                    }
                    if stopped {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Ok(Some(snapshot))
}

/// Returns the current sharing session snapshot.
#[tauri::command]
pub fn lan_share_status(state: State<'_, AppState>) -> IpcResult<LanShareSnapshot> {
    state.lan.share_snapshot()
}

/// Generates a fresh 6-digit pairing code, revoking the previous code and
/// unlocking `codeLocked` (`OD-5`).
#[tauri::command]
pub fn lan_share_regenerate_code(state: State<'_, AppState>) -> IpcResult<LanShareSnapshot> {
    let mut share = state.lan.lock_share()?;
    share.reap_if_stopped();
    let SharePhase::Active(active) = &mut share.phase else {
        return Err(LanError::AuthExpired.into());
    };
    let new_code = active.session.regenerate_code()?;
    active.pairing_code = Some(new_code.expose().to_owned());
    active.code_expires_at_ms = epoch_ms_after(SessionConfig::default().code_expiry);
    Ok(active.snapshot())
}

/// Stops the active sharing listener and revokes its session (`StoppedByUser`).
#[tauri::command]
pub async fn lan_share_stop(state: State<'_, AppState>) -> IpcResult<LanShareSnapshot> {
    stop_active_share(&state.lan, ListenerStopReason::StoppedByUser).await
}

/// Disconnects the currently paired receiver and ends the sharing session.
#[tauri::command]
pub async fn lan_share_disconnect_peer(state: State<'_, AppState>) -> IpcResult<LanShareSnapshot> {
    stop_active_share(&state.lan, ListenerStopReason::StoppedByUser).await
}

async fn stop_active_share(
    lan: &LanState,
    fallback_reason: ListenerStopReason,
) -> IpcResult<LanShareSnapshot> {
    let active = {
        let mut share = lan.lock_share()?;
        share.reap_if_stopped();
        match &mut share.phase {
            SharePhase::Starting { invalidated, .. } => {
                *invalidated = true;
                share.last_stop_reason = Some(fallback_reason);
                return Ok(LanShareSnapshot::off(
                    share.last_stop_reason,
                    share.last_blocked_peer_count,
                    share.last_blocked_peer_ip.clone(),
                ));
            }
            SharePhase::Active(_) => {
                let generation = match &share.phase {
                    SharePhase::Active(a) => a.generation,
                    _ => 0,
                };
                // Hold `Stopping` until `wait_stopped()` finishes so no concurrent
                // Start can race before the listener releases its TCP port.
                match std::mem::replace(&mut share.phase, SharePhase::Stopping { generation }) {
                    SharePhase::Active(active) => Some(active),
                    _ => None,
                }
            }
            SharePhase::Idle | SharePhase::Stopping { .. } => None,
        }
    };

    let Some(mut active) = active else {
        return lan.share_snapshot();
    };

    // Send `ControlCommand::Stop` to the listener FIRST so `wait_stopped()`
    // reports `StoppedByUser` rather than `SessionEnded` from `session.revoke()`.
    active.handle.stop();
    active.session.revoke();
    let reason = active.handle.wait_stopped().await;
    let final_reason = if matches!(reason, ListenerStopReason::Shutdown) {
        fallback_reason
    } else {
        reason
    };
    let blocked_count = active
        .blocked_peer_count
        .max(active.handle.blocked_peer_count());
    let last_blocked_ip = active.last_blocked_peer_ip.clone();
    let generation = active.generation;

    let mut share = lan.lock_share()?;
    if matches!(share.phase, SharePhase::Stopping { generation: g } if g == generation) {
        share.phase = SharePhase::Idle;
    }
    share.last_stop_reason = Some(final_reason);
    share.last_blocked_peer_count = blocked_count;
    share.last_blocked_peer_ip = last_blocked_ip.clone();
    Ok(LanShareSnapshot::off(
        Some(final_reason),
        blocked_count,
        last_blocked_ip,
    ))
}

// ---------------------------------------------------------------------------
// Import (Receiver) IPC Commands
// ---------------------------------------------------------------------------

/// Connects to a LAN source by private IPv4 literal (`ip` or `ip:port`) and
/// pairs using a 6-digit code. The bearer token stays strictly inside Rust.
#[tauri::command]
pub async fn lan_import_connect(
    input: LanImportConnectInput,
    state: State<'_, AppState>,
) -> IpcResult<LanImportSessionInfo> {
    validate_pairing_code_format(&input.code)?;

    // Strictly uses production `AddressPolicy::LanOnly` — loopback is never
    // reachable through IPC (`T-57`).
    let client = LanClient::with_defaults(&input.address)?;
    let (guard, cancel) = {
        let mut receiver = state.lan.lock_receiver()?;
        if receiver.closing {
            return Err(LanError::Cancelled.into());
        }
        receiver.register_operation(&state.lan, input.operation_id, None)
    };

    let _hello = client.hello(&cancel).await?;
    let paired = client.pair(&input.code, &cancel).await?;

    let address = paired.target().to_string();
    let idle_timeout_seconds = paired.idle_timeout_seconds();
    let permissions = paired.permissions();
    let session_id = Uuid::new_v4().to_string();

    // Recheck closing latch, cancellation & active registration under the same
    // lock before publishing the new session so a concurrent shutdown/cancel
    // cannot leak it.
    let published = {
        let mut receiver = state.lan.lock_receiver()?;
        if receiver.closing || cancel.is_cancelled() || !receiver.is_operation_active(&guard) {
            false
        } else {
            receiver.sessions.insert(
                session_id.clone(),
                ReceiverSession {
                    client: paired.clone(),
                    catalog_books: Vec::new(),
                    plans: HashMap::new(),
                    executing_plans: HashSet::new(),
                },
            );
            true
        }
    };

    if !published {
        let _ = tokio::time::timeout(
            DISCONNECT_SESSION_END_TIMEOUT,
            paired.session_end(&CancelToken::never()),
        )
        .await;
        return Err(LanError::Cancelled.into());
    }

    Ok(LanImportSessionInfo {
        session_id,
        address,
        idle_timeout_seconds,
        permissions,
    })
}

/// Fetches the remote source catalog and classifies every book against the
/// local library using DB hash lookups + `stat` only (`F-19`).
#[tauri::command]
pub async fn lan_import_catalog(
    session_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<CatalogBookClassification>> {
    // Atomically validate closing latch, session, clone client, and register
    // cancellation under one lock so disconnect/shutdown cannot slip in between.
    let (client, _guard, cancel) = {
        let mut receiver = state.lan.lock_receiver()?;
        if receiver.closing {
            return Err(LanError::Cancelled.into());
        }
        let client = receiver
            .sessions
            .get(&session_id)
            .map(|s| s.client.clone())
            .ok_or(LanError::AuthExpired)?;
        let (guard, cancel) =
            receiver.register_operation(&state.lan, None, Some(session_id.clone()));
        (client, guard, cancel)
    };

    let catalog = client.catalog(&cancel).await?;
    let classified = classify_catalog(
        &state.database_arc(),
        &catalog.books,
        &ImportLimits::default(),
    )
    .await?;

    {
        let mut receiver = state.lan.lock_receiver()?;
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled.into());
        }
        let session = receiver
            .sessions
            .get_mut(&session_id)
            .ok_or(LanError::AuthExpired)?;
        session.catalog_books = catalog.books;
    }

    Ok(classified)
}

/// Runs Phase 1 (`plan_import`) for the selected catalog book IDs, streaming
/// `PlanProgress` over `on_progress` and retaining `expected: CursorSnapshot`
/// exclusively inside Rust (`R3-02`, `R3-07`).
#[tauri::command]
pub async fn lan_import_plan(
    input: LanImportPlanInput,
    on_progress: Channel<PlanProgress>,
    state: State<'_, AppState>,
) -> IpcResult<LanImportPlanResult> {
    // Atomically validate closing latch, session, extract selected catalog
    // books, and register cancellation under a single lock.
    let (client, selected_books, _guard, cancel) = {
        let mut receiver = state.lan.lock_receiver()?;
        if receiver.closing {
            return Err(LanError::Cancelled.into());
        }
        let session = receiver
            .sessions
            .get(&input.session_id)
            .ok_or(LanError::AuthExpired)?;

        let mut seen = HashSet::with_capacity(input.book_ids.len());
        let mut selected = Vec::with_capacity(input.book_ids.len());
        for book_id in &input.book_ids {
            if !seen.insert(book_id.as_str()) {
                continue;
            }
            if let Some(book) = session.catalog_books.iter().find(|b| b.id == *book_id) {
                selected.push(book.clone());
            }
        }
        let client = session.client.clone();
        let (guard, cancel) = receiver.register_operation(
            &state.lan,
            input.operation_id,
            Some(input.session_id.clone()),
        );
        (client, selected, guard, cancel)
    };

    let plan = synapse_lan::plan_import(
        &client,
        &state.database_arc(),
        &selected_books,
        &OrchestratorConfig::default(),
        &cancel,
        |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await?;

    let summary = plan.summary();
    let default_decisions = plan.default_decisions();
    let plan_id = Uuid::new_v4().to_string();

    {
        let mut receiver = state.lan.lock_receiver()?;
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled.into());
        }
        let session = receiver
            .sessions
            .get_mut(&input.session_id)
            .ok_or(LanError::AuthExpired)?;
        session.plans.insert(plan_id.clone(), plan);
    }

    Ok(LanImportPlanResult {
        plan_id,
        summary,
        default_decisions,
    })
}

/// Runs Phase 2 (`execute_import`) for a Rust-owned `ImportPlan`, granting
/// exact-file asset scope per book **before** emitting `bookCompleted`
/// progress events (`R2-07`).
#[tauri::command]
pub async fn lan_import_execute<R: Runtime>(
    app: AppHandle<R>,
    input: LanImportExecuteInput,
    on_progress: Channel<LanImportProgress>,
    state: State<'_, AppState>,
) -> IpcResult<LanImportExecutionReport> {
    // Obtain managed library BEFORE checking out the plan so a missing library
    // can never leave a plan checked out.
    let library = {
        let db = state.database()?;
        db.managed_library()
            .cloned()
            .ok_or_else(|| IpcError::internal("managed library unavailable for in-memory db"))?
    };

    // Atomically validate closing latch, session, check out the plan, and
    // register cancellation under one lock so disconnect/shutdown cannot slip in between.
    let (client, mut plan_guard, _op_guard, cancel) = {
        let mut receiver = state.lan.lock_receiver()?;
        if receiver.closing {
            return Err(LanError::Cancelled.into());
        }
        let (client, plan) = {
            let session = receiver
                .sessions
                .get_mut(&input.session_id)
                .ok_or(LanError::AuthExpired)?;
            if session.executing_plans.contains(&input.plan_id) {
                return Err(LanError::TransferBusy.into());
            }
            let plan = session
                .plans
                .remove(&input.plan_id)
                .ok_or_else(|| IpcError::new("not_found", "import plan not found"))?;
            session.executing_plans.insert(input.plan_id.clone());
            (session.client.clone(), plan)
        };
        let (op_guard, cancel) = receiver.register_operation(
            &state.lan,
            input.operation_id,
            Some(input.session_id.clone()),
        );
        let plan_guard = PlanCheckoutGuard {
            lan: Arc::clone(&state.lan),
            session_id: input.session_id.clone(),
            plan_id: input.plan_id.clone(),
            plan: Some(plan),
        };
        (client, plan_guard, op_guard, cancel)
    };

    let Some(plan) = plan_guard.plan_mut() else {
        return Err(IpcError::internal("checked-out import plan missing"));
    };

    let db_arc = state.database_arc();
    let app_for_commit = app.clone();
    let report = execute_import(
        &client,
        &db_arc,
        &library,
        plan,
        &input.decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |commit| {
            // R2-07: grant exact-file asset scope BEFORE `BookCompleted` emits so
            // Continue reading works immediately while later books transfer.
            grant_committed_book(&app_for_commit, &commit);
        },
        |progress| {
            let _ = on_progress.send(progress.into());
        },
    )
    .await;

    // `plan_guard` Drop restores `plan` into `session.plans` (preserving any
    // `conflict_cursor` snapshots) and clears `executing_plans` automatically.
    drop(plan_guard);

    Ok(report.into())
}

/// Grants exact-file asset scope for a newly imported or repaired book before
/// its `BookCompleted` progress event is delivered to the webview (`R2-07`).
pub(crate) fn grant_committed_book<R: Runtime>(app: &AppHandle<R>, commit: &BookCommitEvent) {
    let _ = access::grant_documents(app, std::slice::from_ref(&commit.document));
}

/// Cancels an active receiver `connect`, `plan_import`, or `execute_import`
/// operation identified by `operation_id` (`R3-02`).
#[tauri::command]
pub fn lan_import_cancel(operation_id: String, state: State<'_, AppState>) -> bool {
    state.lan.cancel_operation(&operation_id)
}

/// Ends a paired receiver session cleanly (sending `POST /v1/session/end`
/// best-effort) and cancels any in-flight operations for that session.
#[tauri::command]
pub async fn lan_import_disconnect(
    session_id: String,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let client = {
        let mut receiver = state.lan.lock_receiver()?;
        for op in receiver.operations.values() {
            if op.session_id.as_deref() == Some(session_id.as_str()) {
                op.cancel.cancel();
            }
        }
        receiver
            .sessions
            .remove(&session_id)
            .map(|session| session.client)
    };

    if let Some(client) = client {
        let _ = tokio::time::timeout(
            DISCONNECT_SESSION_END_TIMEOUT,
            client.session_end(&CancelToken::never()),
        )
        .await;
    }

    Ok(())
}
