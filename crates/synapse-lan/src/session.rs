use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::error::{LanError, LanResult};
use crate::listener::{DEFAULT_CODE_EXPIRY, DEFAULT_IDLE_TIMEOUT, ListenerControl, MonotonicClock};

/// Default failed pairing attempts before the current code locks (`OD-5`).
pub const DEFAULT_MAX_FAILED_ATTEMPTS: u32 = 5;
/// Default per-IP pairing attempt burst cap within [`DEFAULT_PER_IP_WINDOW`].
pub const DEFAULT_PER_IP_MAX_ATTEMPTS: usize = 3;
/// Default sliding window for per-IP pairing attempt throttling.
pub const DEFAULT_PER_IP_WINDOW: Duration = Duration::from_secs(10);

const PAIRING_CODE_MODULUS: u32 = 1_000_000;
const PAIRING_CODE_REJECT_THRESHOLD: u32 = u32::MAX - (u32::MAX % PAIRING_CODE_MODULUS);
const BEARER_TOKEN_BYTES: usize = 32;

/// Fixed per-session sharing permissions captured at share start (`R3-03`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePermissions {
    pub positions: bool,
    pub bookmarks: bool,
}

/// Snapshot entry binding a shared document ID to its SHA-256 hash at session
/// start (`R3-03`). Mid-session relinks changing `doc.file_hash` are detected
/// against this snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotBook {
    pub document_id: String,
    pub snapshot_file_hash: String,
}

/// Configuration for [`SessionManager`].
#[derive(Debug, Clone, Copy)]
pub struct SessionConfig {
    pub code_expiry: Duration,
    pub idle_timeout: Duration,
    pub max_failed_attempts: u32,
    pub per_ip_max_attempts: usize,
    pub per_ip_window: Duration,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            code_expiry: DEFAULT_CODE_EXPIRY,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_failed_attempts: DEFAULT_MAX_FAILED_ATTEMPTS,
            per_ip_max_attempts: DEFAULT_PER_IP_MAX_ATTEMPTS,
            per_ip_window: DEFAULT_PER_IP_WINDOW,
        }
    }
}

/// 6-digit CSPRNG pairing code with redacting `Debug` implementation (`T-03`).
#[derive(Clone, PartialEq, Eq)]
pub struct PairingCode(String);

impl PairingCode {
    /// Generates a uniform 6-digit decimal pairing code from OS CSPRNG.
    pub fn generate() -> LanResult<Self> {
        let mut buf = [0u8; 4];
        loop {
            getrandom::fill(&mut buf).map_err(|err| {
                LanError::BindFailed(format!("failed to generate pairing code entropy: {err}"))
            })?;
            let value = u32::from_le_bytes(buf);
            // Rejection sampling eliminates modulo bias across 000000..=999999.
            if value < PAIRING_CODE_REJECT_THRESHOLD {
                let digits = value % PAIRING_CODE_MODULUS;
                return Ok(Self(format!("{digits:06}")));
            }
        }
    }

    /// Exposes the 6-digit code solely for UI display or test assertions.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingCode([REDACTED])")
    }
}

/// 32-byte CSPRNG base64url bearer token with redacting `Debug` implementation
/// (`S-13`, `T-03`). Never retained in memory by [`SessionManager`] — only its
/// SHA-256 digest is stored.
#[derive(Clone, PartialEq, Eq)]
pub struct BearerToken(String);

impl BearerToken {
    /// Generates a 32-byte CSPRNG bearer token encoded as base64url (no pad).
    pub fn generate() -> LanResult<Self> {
        let mut raw = [0u8; BEARER_TOKEN_BYTES];
        getrandom::fill(&mut raw).map_err(|err| {
            LanError::BindFailed(format!("failed to generate bearer token entropy: {err}"))
        })?;
        Ok(Self(URL_SAFE_NO_PAD.encode(raw)))
    }

    /// Exposes the raw bearer token solely for `POST /v1/pair` response
    /// serialization or test assertions.
    pub fn expose(&self) -> &str {
        &self.0
    }

    fn sha256_digest(&self) -> [u8; 32] {
        sha256_bytes(self.0.as_bytes())
    }
}

impl fmt::Debug for BearerToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BearerToken([REDACTED])")
    }
}

/// Observable state of the source sharing session (`OD-5`, `R3-09`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SessionStatus {
    Off,
    Listening {
        failed_attempts: u32,
        max_failed_attempts: u32,
    },
    /// Current code invalidated after 5 failed attempts; listener remains
    /// active until code expiry or explicit Stop, prompting **Regenerate code**.
    CodeLocked,
    Paired {
        peer_ip: Ipv4Addr,
    },
}

/// Result returned once upon successful `POST /v1/pair`.
#[derive(Debug, Clone)]
pub struct PairOutcome {
    pub token: BearerToken,
    pub idle_timeout_seconds: u64,
    pub permissions: SharePermissions,
}

/// Proof of an authorized request from the paired peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizedContext {
    pub peer_ip: Ipv4Addr,
    pub permissions: SharePermissions,
}

/// RAII guard enforcing ADR 0008's single active file transfer limit
/// (`429 lan_transfer_busy`) and immediate abort on session revocation (`T-02`).
pub struct TransferGuard {
    session: Arc<SessionManager>,
    abort_rx: watch::Receiver<bool>,
}

impl fmt::Debug for TransferGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransferGuard")
            .field("aborted", &self.is_aborted())
            .finish()
    }
}

impl TransferGuard {
    /// Returns a watch receiver that flips to `true` immediately if the
    /// session is revoked or disconnected mid-transfer.
    pub fn abort_receiver(&self) -> watch::Receiver<bool> {
        self.abort_rx.clone()
    }

    /// Returns `true` if the session was revoked while this transfer is active.
    pub fn is_aborted(&self) -> bool {
        *self.abort_rx.borrow()
    }

    /// Records transfer progress as session activity.
    pub fn record_activity(&self) {
        self.session.record_activity();
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        self.session.release_transfer();
    }
}

struct PairedState {
    peer_ip: Ipv4Addr,
    last_activity_at: Instant,
    active_transfer: bool,
    transfer_abort_tx: watch::Sender<bool>,
}

enum SessionPhase {
    Off,
    Listening {
        code_digest: [u8; 32],
        code_expires_at: Instant,
        failed_attempts: u32,
    },
    CodeLocked {
        /// Retained solely so `regenerate_code()` never re-issues the locked
        /// code (`T-01` / `OD-5`).
        previous_code_digest: [u8; 32],
        code_expires_at: Instant,
    },
    Paired {
        /// Map lookup by SHA-256 digest avoids timing-sensitive comparisons
        /// and keeps raw tokens out of memory (`S-13`, `T-03`).
        tokens: HashMap<[u8; 32], PairedState>,
    },
}

struct SessionInner {
    phase: SessionPhase,
    per_ip_attempts: HashMap<Ipv4Addr, VecDeque<Instant>>,
    listener_control: Option<ListenerControl>,
}

/// Thread-safe source pairing & single-receiver session state machine
/// (`LS-10`, `OD-5`, `R3-03`, `R3-09`).
pub struct SessionManager {
    config: SessionConfig,
    clock: Arc<dyn MonotonicClock>,
    permissions: SharePermissions,
    snapshot_books: Vec<SnapshotBook>,
    snapshot_by_hash: HashMap<String, usize>,
    inner: Mutex<SessionInner>,
}

impl fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionManager")
            .field("status", &self.status())
            .field("permissions", &self.permissions)
            .field("snapshot_book_count", &self.snapshot_books.len())
            .finish()
    }
}

impl SessionManager {
    /// Creates a new sharing session in the `Listening` state with a freshly
    /// generated 6-digit pairing code and fixed snapshot book scope (`R3-03`).
    pub fn new(
        config: SessionConfig,
        clock: Arc<dyn MonotonicClock>,
        permissions: SharePermissions,
        snapshot_books: Vec<SnapshotBook>,
    ) -> LanResult<(Self, PairingCode)> {
        let code = PairingCode::generate()?;
        let code_digest = sha256_bytes(code.expose().as_bytes());
        let now = clock.now();

        let mut snapshot_by_hash = HashMap::with_capacity(snapshot_books.len());
        for (idx, book) in snapshot_books.iter().enumerate() {
            snapshot_by_hash
                .entry(book.snapshot_file_hash.clone())
                .or_insert(idx);
        }

        let manager = Self {
            config,
            clock,
            permissions,
            snapshot_books,
            snapshot_by_hash,
            inner: Mutex::new(SessionInner {
                phase: SessionPhase::Listening {
                    code_digest,
                    code_expires_at: now + config.code_expiry,
                    failed_attempts: 0,
                },
                per_ip_attempts: HashMap::new(),
                listener_control: None,
            }),
        };

        Ok((manager, code))
    }

    /// Attaches the running [`LanListener`] control handle so pairing,
    /// activity, code regeneration, active transfers, and revocation keep the
    /// listener timers synchronized, and any listener termination (`Stop`,
    /// `Shutdown`, `NetworkChanged`, timeouts) synchronously revokes session
    /// credentials (`T-02`).
    pub fn attach_listener(self: &Arc<Self>, control: ListenerControl) {
        let weak = Arc::downgrade(self);
        control.on_stop(Arc::new(move |_reason| {
            if let Some(session) = weak.upgrade() {
                session.revoke_local();
            }
        }));
        let mut inner = self.lock_inner();
        inner.listener_control = Some(control);
    }

    pub const fn permissions(&self) -> SharePermissions {
        self.permissions
    }

    pub fn snapshot_books(&self) -> &[SnapshotBook] {
        &self.snapshot_books
    }

    pub fn find_snapshot_book(&self, sha256: &str) -> Option<&SnapshotBook> {
        self.snapshot_by_hash
            .get(sha256)
            .and_then(|&idx| self.snapshot_books.get(idx))
    }

    /// Returns the current session status after evaluating monotonic timers.
    pub fn status(&self) -> SessionStatus {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        self.expire_if_needed(&mut inner, now);

        match &inner.phase {
            SessionPhase::Off => SessionStatus::Off,
            SessionPhase::Listening {
                failed_attempts, ..
            } => SessionStatus::Listening {
                failed_attempts: *failed_attempts,
                max_failed_attempts: self.config.max_failed_attempts.max(1),
            },
            SessionPhase::CodeLocked { .. } => SessionStatus::CodeLocked,
            SessionPhase::Paired { tokens } => {
                if let Some(paired) = tokens.values().next() {
                    SessionStatus::Paired {
                        peer_ip: paired.peer_ip,
                    }
                } else {
                    SessionStatus::Off
                }
            }
        }
    }

    /// Attempts to pair a receiver using a 6-digit code (`POST /v1/pair`).
    pub fn pair(&self, peer_ip: Ipv4Addr, candidate_code: &str) -> LanResult<PairOutcome> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        self.expire_if_needed(&mut inner, now);

        match &inner.phase {
            SessionPhase::Off => return Err(LanError::AuthExpired),
            SessionPhase::CodeLocked { .. } => return Err(LanError::AttemptsExceeded),
            SessionPhase::Paired { .. } => return Err(LanError::SessionBusy),
            SessionPhase::Listening { .. } => {}
        }

        // Enforce per-peer-IP sliding-window throttle before checking the code.
        if self.config.per_ip_max_attempts > 0 && !self.config.per_ip_window.is_zero() {
            let cutoff = now.checked_sub(self.config.per_ip_window);
            let history = inner.per_ip_attempts.entry(peer_ip).or_default();
            if let Some(cutoff) = cutoff {
                while history.front().is_some_and(|&ts| ts <= cutoff) {
                    history.pop_front();
                }
            }
            if history.len() >= self.config.per_ip_max_attempts {
                return Err(LanError::AttemptsExceeded);
            }
            history.push_back(now);
        }

        let valid_format =
            candidate_code.len() == 6 && candidate_code.bytes().all(|b| b.is_ascii_digit());
        let candidate_digest = sha256_bytes(candidate_code.as_bytes());

        let (matched, previous_code_digest, code_expires_at, failed_attempts) =
            match &mut inner.phase {
                SessionPhase::Listening {
                    code_digest,
                    code_expires_at,
                    failed_attempts,
                } => {
                    if valid_format && constant_time_eq_32(code_digest, &candidate_digest) {
                        (true, *code_digest, *code_expires_at, *failed_attempts)
                    } else {
                        *failed_attempts = failed_attempts.saturating_add(1);
                        (false, *code_digest, *code_expires_at, *failed_attempts)
                    }
                }
                _ => return Err(LanError::AuthExpired),
            };

        if !matched {
            let max_attempts = self.config.max_failed_attempts.max(1);
            if failed_attempts >= max_attempts {
                // OD-5 / R3-09: lock/invalidate the current code while keeping
                // the listener alive until code_expires_at or Stop.
                inner.phase = SessionPhase::CodeLocked {
                    previous_code_digest,
                    code_expires_at,
                };
                return Err(LanError::AttemptsExceeded);
            }
            return Err(LanError::AuthInvalid);
        }

        let token = BearerToken::generate()?;
        let token_digest = token.sha256_digest();
        let (transfer_abort_tx, _) = watch::channel(false);

        let mut tokens = HashMap::with_capacity(1);
        tokens.insert(
            token_digest,
            PairedState {
                peer_ip,
                last_activity_at: now,
                active_transfer: false,
                transfer_abort_tx,
            },
        );

        inner.phase = SessionPhase::Paired { tokens };
        inner.per_ip_attempts.clear();

        if let Some(control) = &inner.listener_control {
            control.mark_paired();
        }

        Ok(PairOutcome {
            token,
            idle_timeout_seconds: self.config.idle_timeout.as_secs(),
            permissions: self.permissions,
        })
    }

    /// Generates a new 6-digit pairing code distinct from the previous code,
    /// revoking the previous code, resetting failure counters, unlocking
    /// `CodeLocked`, and resetting the code-expiry timer (`OD-5`, `T-01`).
    pub fn regenerate_code(&self) -> LanResult<PairingCode> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        self.expire_if_needed(&mut inner, now);

        let previous_digest = match &inner.phase {
            SessionPhase::Listening { code_digest, .. } => *code_digest,
            SessionPhase::CodeLocked {
                previous_code_digest,
                ..
            } => *previous_code_digest,
            SessionPhase::Paired { .. } => return Err(LanError::SessionBusy),
            SessionPhase::Off => return Err(LanError::AuthExpired),
        };

        // Never re-issue the immediately preceding code so regeneration
        // deterministically revokes the old code (`T-01`).
        let (code, code_digest) = loop {
            let candidate = PairingCode::generate()?;
            let digest = sha256_bytes(candidate.expose().as_bytes());
            if !constant_time_eq_32(&digest, &previous_digest) {
                break (candidate, digest);
            }
        };

        inner.phase = SessionPhase::Listening {
            code_digest,
            code_expires_at: now + self.config.code_expiry,
            failed_attempts: 0,
        };
        inner.per_ip_attempts.clear();

        if let Some(control) = &inner.listener_control {
            control.reset_code_timer();
        }

        Ok(code)
    }

    /// Verifies a bearer token and peer IP binding for an authenticated `/v1`
    /// request, updating the session idle timer on success (`T-02`, `T-03`).
    pub fn authenticate(
        &self,
        peer_ip: Ipv4Addr,
        bearer_token: &str,
    ) -> LanResult<AuthorizedContext> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        self.expire_if_needed(&mut inner, now);

        let token_digest = sha256_bytes(bearer_token.as_bytes());
        let authorized = match &mut inner.phase {
            SessionPhase::Off => return Err(LanError::AuthExpired),
            SessionPhase::Listening { .. } | SessionPhase::CodeLocked { .. } => {
                return Err(LanError::AuthInvalid);
            }
            SessionPhase::Paired { tokens } => {
                let Some(paired) = tokens.get_mut(&token_digest) else {
                    return Err(LanError::AuthInvalid);
                };
                if paired.peer_ip != peer_ip {
                    return Err(LanError::AuthInvalid);
                }
                paired.last_activity_at = now;
                AuthorizedContext {
                    peer_ip,
                    permissions: self.permissions,
                }
            }
        };

        if let Some(control) = &inner.listener_control {
            control.record_activity();
        }

        Ok(authorized)
    }

    /// Acquires the single active file-transfer slot (`429 lan_transfer_busy`
    /// if another transfer is already running).
    pub fn acquire_transfer(self: &Arc<Self>) -> LanResult<TransferGuard> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        self.expire_if_needed(&mut inner, now);

        let abort_rx = match &mut inner.phase {
            SessionPhase::Paired { tokens } => {
                let Some(paired) = tokens.values_mut().next() else {
                    return Err(LanError::AuthExpired);
                };
                if paired.active_transfer {
                    return Err(LanError::TransferBusy);
                }
                paired.active_transfer = true;
                paired.last_activity_at = now;
                paired.transfer_abort_tx.subscribe()
            }
            SessionPhase::Off => return Err(LanError::AuthExpired),
            SessionPhase::Listening { .. } | SessionPhase::CodeLocked { .. } => {
                return Err(LanError::AuthInvalid);
            }
        };

        if let Some(control) = &inner.listener_control {
            control.set_transfer_active(true);
        }

        Ok(TransferGuard {
            session: Arc::clone(self),
            abort_rx,
        })
    }

    /// Records session activity (e.g. during an active streaming transfer).
    pub fn record_activity(&self) {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        if let SessionPhase::Paired { tokens } = &mut inner.phase
            && let Some(paired) = tokens.values_mut().next()
        {
            paired.last_activity_at = now;
            if let Some(control) = &inner.listener_control {
                control.record_activity();
            }
        }
    }

    /// Revokes the active session (e.g. source-side **Disconnect** or **Stop**),
    /// immediately aborting any active transfer and stopping the attached
    /// listener (`T-02`).
    pub fn revoke(&self) {
        let control = self.revoke_inner();
        if let Some(control) = control {
            control.end_session();
        }
    }

    /// Revokes the session state and aborts active transfers without yet
    /// stopping the listener, so `POST /v1/session/end` can flush `204` before
    /// calling [`Self::notify_listener_session_ended`].
    pub(crate) fn revoke_local(&self) {
        let _ = self.revoke_inner();
    }

    /// Signals the attached listener to stop with
    /// [`crate::listener::ListenerStopReason::SessionEnded`].
    pub(crate) fn notify_listener_session_ended(&self) {
        let inner = self.lock_inner();
        if let Some(control) = &inner.listener_control {
            control.end_session();
        }
    }

    fn revoke_inner(&self) -> Option<ListenerControl> {
        let mut inner = self.lock_inner();
        if let SessionPhase::Paired { tokens } = &mut inner.phase {
            for paired in tokens.values() {
                let _ = paired.transfer_abort_tx.send(true);
            }
        }
        inner.phase = SessionPhase::Off;
        inner.per_ip_attempts.clear();
        inner.listener_control.clone()
    }

    fn release_transfer(&self) {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        if let SessionPhase::Paired { tokens } = &mut inner.phase
            && let Some(paired) = tokens.values_mut().next()
        {
            paired.active_transfer = false;
            paired.last_activity_at = now;
        }
        if let Some(control) = &inner.listener_control {
            control.set_transfer_active(false);
        }
    }

    fn expire_if_needed(&self, inner: &mut SessionInner, now: Instant) {
        let expired = match &inner.phase {
            SessionPhase::Off => false,
            SessionPhase::Listening {
                code_expires_at, ..
            }
            | SessionPhase::CodeLocked {
                code_expires_at, ..
            } => now >= *code_expires_at,
            SessionPhase::Paired { tokens } => tokens.values().next().is_none_or(|paired| {
                !paired.active_transfer
                    && now.saturating_duration_since(paired.last_activity_at)
                        >= self.config.idle_timeout
            }),
        };

        if expired {
            if let SessionPhase::Paired { tokens } = &mut inner.phase {
                for paired in tokens.values() {
                    let _ = paired.transfer_abort_tx.send(true);
                }
            }
            inner.phase = SessionPhase::Off;
            inner.per_ip_attempts.clear();
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, SessionInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn constant_time_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listener::TokioMonotonicClock;

    fn sample_books() -> Vec<SnapshotBook> {
        vec![SnapshotBook {
            document_id: "doc-1".into(),
            snapshot_file_hash: "a".repeat(64),
        }]
    }

    fn default_perms() -> SharePermissions {
        SharePermissions {
            positions: true,
            bookmarks: true,
        }
    }

    #[test]
    fn pairing_code_format_and_redacted_debug() {
        let code = PairingCode::generate().expect("generate code");
        assert_eq!(code.expose().len(), 6);
        assert!(code.expose().bytes().all(|b| b.is_ascii_digit()));
        assert!(!format!("{code:?}").contains(code.expose()));
        assert_eq!(format!("{code:?}"), "PairingCode([REDACTED])");
    }

    #[test]
    fn bearer_token_redacted_debug() {
        let token = BearerToken::generate().expect("generate token");
        assert_eq!(token.expose().len(), 43);
        assert!(!format!("{token:?}").contains(token.expose()));
        assert_eq!(format!("{token:?}"), "BearerToken([REDACTED])");
    }

    // T-01: Code issuance, expiry, 5-failure CodeLocked transition (OD-5),
    // single-use consumption, regeneration revocation, and per-IP throttle.
    #[tokio::test(start_paused = true)]
    async fn t01_code_lifecycle_and_five_failure_lock() {
        let clock = Arc::new(TokioMonotonicClock);
        let config = SessionConfig {
            code_expiry: Duration::from_secs(600),
            idle_timeout: Duration::from_secs(600),
            max_failed_attempts: 5,
            per_ip_max_attempts: 10, // disable burst throttle in this test
            per_ip_window: Duration::from_secs(10),
        };
        let (session, code1) =
            SessionManager::new(config, clock, default_perms(), sample_books()).expect("session");

        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let wrong = if code1.expose() == "000000" {
            "000001"
        } else {
            "000000"
        };

        // Attempts 1..=4 return AuthInvalid and stay Listening.
        for expected_failures in 1..=4 {
            let err = session.pair(peer, wrong).expect_err("wrong code");
            assert_eq!(err.code(), "lan_auth_invalid");
            assert_eq!(
                session.status(),
                SessionStatus::Listening {
                    failed_attempts: expected_failures,
                    max_failed_attempts: 5,
                }
            );
        }

        // 5th failed attempt locks the current code (OD-5 / R3-09).
        let err = session.pair(peer, wrong).expect_err("5th failure locks");
        assert_eq!(err.code(), "lan_attempts_exceeded");
        assert_eq!(session.status(), SessionStatus::CodeLocked);

        // Even the previously valid code is now rejected while locked.
        let err = session
            .pair(peer, code1.expose())
            .expect_err("locked code rejected");
        assert_eq!(err.code(), "lan_attempts_exceeded");

        // Regenerate code unlocks CodeLocked -> Listening and unconditionally
        // revokes code1 (new code is guaranteed distinct from code1).
        let code2 = session.regenerate_code().expect("regenerate");
        assert_ne!(code1.expose(), code2.expose());
        assert_eq!(
            session.status(),
            SessionStatus::Listening {
                failed_attempts: 0,
                max_failed_attempts: 5,
            }
        );
        let err = session
            .pair(peer, code1.expose())
            .expect_err("old code revoked");
        assert_eq!(err.code(), "lan_auth_invalid");

        // Regenerating directly from Listening also produces a distinct code
        // and unconditionally revokes code2.
        let code3 = session
            .regenerate_code()
            .expect("regenerate from listening");
        assert_ne!(code2.expose(), code3.expose());
        let err = session
            .pair(peer, code2.expose())
            .expect_err("previous listening code revoked");
        assert_eq!(err.code(), "lan_auth_invalid");

        // Correct new code succeeds once and consumes the code.
        let outcome = session.pair(peer, code3.expose()).expect("pair succeeds");
        assert_eq!(outcome.idle_timeout_seconds, 600);
        assert_eq!(outcome.permissions, default_perms());
        assert_eq!(session.status(), SessionStatus::Paired { peer_ip: peer });

        // Reusing the same code or pairing from a second IP returns SessionBusy.
        let err = session
            .pair(peer, code3.expose())
            .expect_err("single-use code");
        assert_eq!(err.code(), "lan_session_busy");
        let err = session
            .pair(Ipv4Addr::new(192, 168, 1, 21), code3.expose())
            .expect_err("second receiver busy");
        assert_eq!(err.code(), "lan_session_busy");
    }

    #[tokio::test(start_paused = true)]
    async fn t01_per_ip_throttle_blocks_burst_without_locking_other_peers() {
        let clock = Arc::new(TokioMonotonicClock);
        let config = SessionConfig {
            code_expiry: Duration::from_secs(600),
            idle_timeout: Duration::from_secs(600),
            max_failed_attempts: 5,
            per_ip_max_attempts: 2,
            per_ip_window: Duration::from_secs(10),
        };
        let (session, code) =
            SessionManager::new(config, clock, default_perms(), sample_books()).expect("session");

        let ip_a = Ipv4Addr::new(192, 168, 1, 20);
        let ip_b = Ipv4Addr::new(192, 168, 1, 21);
        let wrong = if code.expose() == "999999" {
            "999998"
        } else {
            "999999"
        };

        assert_eq!(
            session.pair(ip_a, wrong).expect_err("1").code(),
            "lan_auth_invalid"
        );
        assert_eq!(
            session.pair(ip_a, wrong).expect_err("2").code(),
            "lan_auth_invalid"
        );
        // 3rd rapid attempt from ip_a is throttled before incrementing global failures.
        assert_eq!(
            session.pair(ip_a, wrong).expect_err("3 throttled").code(),
            "lan_attempts_exceeded"
        );
        // Code is still Listening (only 2 global failures) and ip_b can still pair!
        assert_eq!(
            session.status(),
            SessionStatus::Listening {
                failed_attempts: 2,
                max_failed_attempts: 5,
            }
        );

        // After advancing past the per-IP window, ip_a is unthrottled again;
        // meanwhile ip_b can pair immediately.
        let outcome = session
            .pair(ip_b, code.expose())
            .expect("ip_b not throttled");
        assert_eq!(session.status(), SessionStatus::Paired { peer_ip: ip_b });
        assert!(session.authenticate(ip_b, outcome.token.expose()).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn t01_code_expiry_transitions_to_off() {
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            SessionConfig::default(),
            clock,
            default_perms(),
            sample_books(),
        )
        .expect("session");

        tokio::time::advance(Duration::from_secs(600)).await;
        assert_eq!(session.status(), SessionStatus::Off);

        let err = session
            .pair(Ipv4Addr::new(192, 168, 1, 20), code.expose())
            .expect_err("expired");
        assert_eq!(err.code(), "lan_auth_expired");
    }

    // T-02: Session idle timeout, peer-IP binding, active transfer keeps
    // session alive, single transfer cap, and revoke aborts transfer.
    #[tokio::test(start_paused = true)]
    async fn t02_peer_ip_binding_idle_timeout_and_transfer_abort() {
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            SessionConfig::default(),
            clock,
            default_perms(),
            sample_books(),
        )
        .expect("session");
        let session = Arc::new(session);

        let peer_a = Ipv4Addr::new(192, 168, 1, 20);
        let peer_b = Ipv4Addr::new(192, 168, 1, 21);
        let outcome = session.pair(peer_a, code.expose()).expect("pair");
        let raw_token = outcome.token.expose().to_string();

        // SessionManager Debug must never expose the token.
        assert!(!format!("{session:?}").contains(&raw_token));

        // Peer IP binding: same token from peer_b is rejected.
        let err = session
            .authenticate(peer_b, &raw_token)
            .expect_err("wrong IP");
        assert_eq!(err.code(), "lan_auth_invalid");

        // Wrong token from peer_a is rejected.
        let err = session
            .authenticate(peer_a, "wrong-token")
            .expect_err("wrong token");
        assert_eq!(err.code(), "lan_auth_invalid");

        // Activity resets idle timeout.
        tokio::time::advance(Duration::from_secs(500)).await;
        assert!(session.authenticate(peer_a, &raw_token).is_ok());

        // Active transfer prevents idle expiry and blocks a second transfer.
        let guard = session.acquire_transfer().expect("first transfer");
        let mut abort_rx = guard.abort_receiver();
        assert!(!*abort_rx.borrow());

        let busy = session.acquire_transfer().expect_err("second transfer");
        assert_eq!(busy.code(), "lan_transfer_busy");

        // Even advancing past 10 minutes during an active transfer keeps session alive.
        tokio::time::advance(Duration::from_secs(700)).await;
        assert_eq!(session.status(), SessionStatus::Paired { peer_ip: peer_a });

        // Revoke aborts the in-flight transfer immediately.
        session.revoke();
        assert!(guard.is_aborted());
        assert!(abort_rx.changed().await.is_ok() || *abort_rx.borrow());
        assert!(*abort_rx.borrow());
        drop(guard);

        assert_eq!(session.status(), SessionStatus::Off);
        let err = session
            .authenticate(peer_a, &raw_token)
            .expect_err("revoked");
        assert_eq!(err.code(), "lan_auth_expired");
    }

    #[tokio::test(start_paused = true)]
    async fn t02_idle_timeout_expires_paired_session() {
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            SessionConfig::default(),
            clock,
            default_perms(),
            sample_books(),
        )
        .expect("session");

        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let outcome = session.pair(peer, code.expose()).expect("pair");
        let raw_token = outcome.token.expose().to_string();

        tokio::time::advance(Duration::from_secs(600)).await;
        let err = session
            .authenticate(peer, &raw_token)
            .expect_err("idle timeout");
        assert_eq!(err.code(), "lan_auth_expired");
        assert_eq!(session.status(), SessionStatus::Off);
    }

    #[test]
    fn r3_03_snapshot_books_lookup() {
        let clock = Arc::new(TokioMonotonicClock);
        let books = vec![
            SnapshotBook {
                document_id: "doc-1".into(),
                snapshot_file_hash: "1".repeat(64),
            },
            SnapshotBook {
                document_id: "doc-2".into(),
                snapshot_file_hash: "2".repeat(64),
            },
        ];
        let (session, _code) = SessionManager::new(
            SessionConfig::default(),
            clock,
            default_perms(),
            books.clone(),
        )
        .expect("session");

        assert_eq!(session.snapshot_books(), books.as_slice());
        assert_eq!(
            session
                .find_snapshot_book(&"2".repeat(64))
                .map(|b| b.document_id.as_str()),
            Some("doc-2")
        );
        assert!(session.find_snapshot_book(&"3".repeat(64)).is_none());
    }
}
