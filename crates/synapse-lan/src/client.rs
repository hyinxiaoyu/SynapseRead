//! Hardened HTTP/1.1 keep-alive receiver client, streaming file downloader,
//! and forward-compatible wire anchor parser (ADR 0008, LS-12).

use std::fmt;
use std::net::{SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1::SendRequest;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use synapse_core::CoreError;
use synapse_core::domain::{AnchorLocation, DocumentFormat};
use synapse_core::library::{ManagedLibrary, StagedFile, is_disk_full_error};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::address::{AddressPolicy, parse_lan_address};
use crate::error::{LanError, LanResult};
use crate::http::{ErrorResponseBody, PROTOCOL_HEADER, PROTOCOL_VERSION, is_valid_sha256_hex};
use crate::session::SharePermissions;

/// Default TCP connect timeout for LAN receiver requests (ADR 0008: 5 s).
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Default per-header / per-chunk inactivity timeout (ADR 0008: 30 s).
pub const DEFAULT_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);
/// Default maximum idle HTTP/1.1 keep-alive connections pooled per client (`R3-02`).
pub const DEFAULT_MAX_IDLE_CONNECTIONS: usize = 2;

/// Maximum raw response bytes for `/v1/hello`, `/v1/pair`, and error bodies (64 KiB).
pub const MAX_CONTROL_RESPONSE_BYTES: usize = 64 * 1024;
/// Maximum raw response bytes for `/v1/catalog` (ADR 0008: 8 MiB).
pub const MAX_CATALOG_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Maximum raw response bytes for `/v1/books/{sha256}/bookmarks` (ADR 0008: 2 MiB).
pub const MAX_BOOKMARKS_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum raw response bytes for `/v1/books/{sha256}/position` (ADR 0008: 64 KiB).
pub const MAX_POSITION_RESPONSE_BYTES: usize = 64 * 1024;
/// Maximum catalog books accepted by the receiver (ADR 0008: 10,000).
pub const MAX_CATALOG_BOOKS: usize = 10_000;
/// Maximum bookmarks per book accepted by the receiver (ADR 0008: 10,000).
pub const MAX_BOOKMARKS_PER_BOOK: usize = 10_000;

const EXPECTED_APP_ID: &str = "synapseread";

/// Hardening and timeout configuration for [`LanClient`] and [`PairedClient`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanClientConfig {
    pub connect_timeout: Duration,
    pub inactivity_timeout: Duration,
    pub max_idle_connections: usize,
    pub max_control_response_bytes: usize,
    pub max_catalog_response_bytes: usize,
    pub max_bookmarks_response_bytes: usize,
    pub max_position_response_bytes: usize,
    pub max_catalog_books: usize,
    pub max_bookmarks_per_book: usize,
}

impl Default for LanClientConfig {
    fn default() -> Self {
        Self {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            inactivity_timeout: DEFAULT_INACTIVITY_TIMEOUT,
            max_idle_connections: DEFAULT_MAX_IDLE_CONNECTIONS,
            max_control_response_bytes: MAX_CONTROL_RESPONSE_BYTES,
            max_catalog_response_bytes: MAX_CATALOG_RESPONSE_BYTES,
            max_bookmarks_response_bytes: MAX_BOOKMARKS_RESPONSE_BYTES,
            max_position_response_bytes: MAX_POSITION_RESPONSE_BYTES,
            max_catalog_books: MAX_CATALOG_BOOKS,
            max_bookmarks_per_book: MAX_BOOKMARKS_PER_BOOK,
        }
    }
}

/// Cooperative cancellation handle for receiver metadata fetches (`R3-02`) and
/// streaming file downloads (`T-18`).
#[derive(Debug, Clone)]
pub struct CancelHandle {
    tx: Arc<watch::Sender<bool>>,
}

impl CancelHandle {
    /// Creates a linked `(CancelHandle, CancelToken)` pair.
    pub fn new() -> (Self, CancelToken) {
        let (tx, rx) = watch::channel(false);
        (Self { tx: Arc::new(tx) }, CancelToken { rx: Some(rx) })
    }

    /// Signals cancellation to all derived [`CancelToken`]s immediately.
    pub fn cancel(&self) {
        let _ = self.tx.send(true);
    }

    /// Returns `true` if [`Self::cancel`] has been called.
    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }

    /// Creates a new [`CancelToken`] subscribed to this handle.
    pub fn token(&self) -> CancelToken {
        CancelToken {
            rx: Some(self.tx.subscribe()),
        }
    }
}

/// Read-only cancellation token checked before and during receiver network I/O.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    rx: Option<watch::Receiver<bool>>,
}

impl CancelToken {
    /// Returns a token that is never cancelled.
    pub fn never() -> Self {
        Self { rx: None }
    }

    /// Wraps an existing `tokio::sync::watch::Receiver<bool>` where `true`
    /// indicates cancellation.
    pub fn from_watch(rx: watch::Receiver<bool>) -> Self {
        Self { rx: Some(rx) }
    }

    /// Returns `true` if cancellation has already been requested.
    pub fn is_cancelled(&self) -> bool {
        self.rx.as_ref().is_some_and(|rx| *rx.borrow())
    }

    async fn wait_cancelled(&mut self) {
        match &mut self.rx {
            None => std::future::pending::<()>().await,
            Some(rx) => {
                if *rx.borrow() {
                    return;
                }
                while rx.changed().await.is_ok() {
                    if *rx.borrow() {
                        return;
                    }
                }
                if *rx.borrow() {
                    return;
                }
                std::future::pending::<()>().await;
            }
        }
    }
}

/// Opaque receiver-side bearer token with a redacting `Debug` implementation (`T-03`).
#[derive(Clone, PartialEq, Eq)]
struct ReceiverToken(String);

impl ReceiverToken {
    fn from_wire(raw: String) -> LanResult<Self> {
        if raw.is_empty()
            || raw
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(LanError::ProtocolIncompatible(
                "source returned malformed bearer token".into(),
            ));
        }
        Ok(Self(raw))
    }

    fn authorization_header(&self) -> LanResult<HeaderValue> {
        let mut value = String::with_capacity("Bearer ".len() + self.0.len());
        value.push_str("Bearer ");
        value.push_str(&self.0);
        HeaderValue::from_str(&value).map_err(|_| LanError::AuthInvalid)
    }
}

impl fmt::Debug for ReceiverToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReceiverToken([REDACTED])")
    }
}

/// Response returned by `GET /v1/hello` (ignores unknown fields for forward
/// compatibility, `R2-05`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloInfo {
    pub protocol: u32,
    pub min_protocol: u32,
    pub app: String,
}

/// A single book entry returned by `GET /v1/catalog` (ignores unknown fields,
/// `R2-05`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBook {
    pub id: String,
    pub title: String,
    pub format: String,
    pub extension: String,
    pub size_bytes: u64,
    pub file_available: bool,
    #[serde(default)]
    pub has_position: Option<bool>,
    #[serde(default)]
    pub bookmark_count: Option<u64>,
}

impl CatalogBook {
    /// Parses the wire format string into a known [`DocumentFormat`], returning
    /// `None` for unrecognized future formats.
    pub fn parsed_format(&self) -> Option<DocumentFormat> {
        DocumentFormat::parse(&self.format).ok()
    }
}

/// Response returned by `GET /v1/catalog` (ignores unknown fields, `R2-05`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub books: Vec<CatalogBook>,
}

/// Outcome of `GET /v1/books/{sha256}/position` with forward-compatible anchor
/// parsing (`R2-05`, `T-52`).
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedPosition {
    /// Source returned `204 No Content` (no saved reading position).
    None,
    /// Source returned `200 OK` with a recognized `AnchorLocation`.
    Valid {
        anchor: AnchorLocation,
        progress: Option<f64>,
    },
    /// Source returned `200 OK` with an unrecognized future anchor format or
    /// incompatible nested anchor fields; skipped cleanly without failing the
    /// response.
    Skipped { reason: String },
}

/// A parsed wire bookmark entry from `GET /v1/books/{sha256}/bookmarks`.
#[derive(Debug, Clone, PartialEq)]
pub struct WireBookmark {
    pub anchor: AnchorLocation,
    pub label: Option<String>,
    pub created_at: Option<String>,
}

/// Per-entry parse outcome for `GET /v1/books/{sha256}/bookmarks` (`R2-05`,
/// `T-52`).
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedBookmark {
    Valid(WireBookmark),
    Skipped { index: usize, reason: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequestWire<'a> {
    code: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponseWire {
    token: String,
    idle_timeout_seconds: u64,
    permissions: SharePermissions,
}

impl fmt::Debug for PairResponseWire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairResponseWire")
            .field("token", &"[REDACTED]")
            .field("idle_timeout_seconds", &self.idle_timeout_seconds)
            .field("permissions", &self.permissions)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionResponseWire {
    anchor: serde_json::Value,
    #[serde(default)]
    progress: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkEntryWire {
    anchor: serde_json::Value,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarksResponseWire {
    bookmarks: Vec<BookmarkEntryWire>,
}

/// Internal HTTP/1.1 keep-alive connection pool shared between [`LanClient`]
/// and [`PairedClient`] so `hello` -> `pair` -> `catalog` -> `position` ->
/// `bookmarks` -> `session_end` reuse the same TCP connection (`R3-02`).
struct Http1Pool {
    target: SocketAddrV4,
    host_header: HeaderValue,
    protocol_header: HeaderValue,
    config: LanClientConfig,
    idle: Mutex<Vec<SendRequest<Full<Bytes>>>>,
}

impl fmt::Debug for Http1Pool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Http1Pool")
            .field("target", &self.target)
            .field("config", &self.config)
            .finish()
    }
}

impl Http1Pool {
    fn new(target: SocketAddrV4, config: LanClientConfig) -> LanResult<Self> {
        let host_header = HeaderValue::from_str(&target.to_string()).map_err(|_| {
            LanError::AddressInvalid(format!("cannot encode Host header for {target}"))
        })?;
        let protocol_header = HeaderValue::from_str(&PROTOCOL_VERSION.to_string())
            .map_err(|_| LanError::ProtocolIncompatible("invalid protocol header value".into()))?;
        Ok(Self {
            target,
            host_header,
            protocol_header,
            config,
            idle: Mutex::new(Vec::with_capacity(config.max_idle_connections)),
        })
    }

    fn lock_idle(&self) -> std::sync::MutexGuard<'_, Vec<SendRequest<Full<Bytes>>>> {
        self.idle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clear_idle(&self) {
        self.lock_idle().clear();
    }

    fn checkin(&self, sender: SendRequest<Full<Bytes>>, headers: &HeaderMap) {
        if self.config.max_idle_connections == 0
            || sender.is_closed()
            || has_connection_close(headers)
        {
            return;
        }
        let mut idle = self.lock_idle();
        if idle.len() < self.config.max_idle_connections {
            idle.push(sender);
        }
    }

    async fn connect_fresh(
        &self,
        cancel: &mut CancelToken,
        paired: bool,
    ) -> LanResult<SendRequest<Full<Bytes>>> {
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled);
        }

        // Connect directly to a validated IPv4 SocketAddr (zero DNS, T-57).
        let stream = tokio::select! {
            biased;
            () = cancel.wait_cancelled() => return Err(LanError::Cancelled),
            res = tokio::time::timeout(
                self.config.connect_timeout,
                TcpStream::connect(SocketAddr::V4(self.target)),
            ) => match res {
                Ok(Ok(stream)) => stream,
                Ok(Err(err)) => {
                    return Err(transport_error(
                        paired,
                        format!("failed to connect to {}: {err}", self.target),
                    ));
                }
                Err(_) => {
                    return Err(transport_error(
                        paired,
                        format!("connection to {} timed out", self.target),
                    ));
                }
            }
        };

        let _ = stream.set_nodelay(true);
        let io = TokioIo::new(stream);

        let (mut sender, conn) = tokio::select! {
            biased;
            () = cancel.wait_cancelled() => return Err(LanError::Cancelled),
            res = tokio::time::timeout(
                self.config.inactivity_timeout,
                hyper::client::conn::http1::handshake(io),
            ) => match res {
                Ok(Ok(pair)) => pair,
                Ok(Err(err)) => {
                    return Err(transport_error(
                        paired,
                        format!("HTTP/1.1 handshake failed with {}: {err}", self.target),
                    ));
                }
                Err(_) => {
                    return Err(transport_error(
                        paired,
                        format!("HTTP/1.1 handshake timed out with {}", self.target),
                    ));
                }
            }
        };

        tokio::spawn(async move {
            let _ = conn.await;
        });

        tokio::select! {
            biased;
            () = cancel.wait_cancelled() => Err(LanError::Cancelled),
            res = tokio::time::timeout(self.config.inactivity_timeout, sender.ready()) => match res {
                Ok(Ok(())) => Ok(sender),
                Ok(Err(err)) => Err(transport_error(
                    paired,
                    format!("connection to {} closed before request: {err}", self.target),
                )),
                Err(_) => Err(transport_error(
                    paired,
                    format!("connection to {} timed out before request", self.target),
                )),
            }
        }
    }

    async fn checkout_or_connect(
        &self,
        cancel: &mut CancelToken,
        paired: bool,
    ) -> LanResult<(SendRequest<Full<Bytes>>, bool)> {
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled);
        }

        loop {
            let candidate = self.lock_idle().pop();
            let Some(mut sender) = candidate else {
                break;
            };
            if sender.is_closed() {
                continue;
            }
            let ready = tokio::select! {
                biased;
                () = cancel.wait_cancelled() => return Err(LanError::Cancelled),
                res = tokio::time::timeout(self.config.inactivity_timeout, sender.ready()) => res,
            };
            if matches!(ready, Ok(Ok(()))) {
                return Ok((sender, true));
            }
        }

        let sender = self.connect_fresh(cancel, paired).await?;
        Ok((sender, false))
    }

    fn build_request(
        &self,
        method: Method,
        path: &str,
        body: Bytes,
        auth_header: Option<&HeaderValue>,
    ) -> LanResult<Request<Full<Bytes>>> {
        let mut builder = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::HOST, self.host_header.clone())
            .header(PROTOCOL_HEADER, self.protocol_header.clone());

        if method == Method::POST {
            builder = builder.header(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }
        if let Some(auth) = auth_header {
            builder = builder.header(header::AUTHORIZATION, auth.clone());
        }

        builder.body(Full::new(body)).map_err(|err| {
            LanError::ProtocolIncompatible(format!("failed to build request: {err}"))
        })
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Bytes,
        auth_header: Option<&HeaderValue>,
        cancel: &mut CancelToken,
        paired: bool,
    ) -> LanResult<(Response<Incoming>, SendRequest<Full<Bytes>>)> {
        let (mut sender, reused) = self.checkout_or_connect(cancel, paired).await?;
        let req = self.build_request(method.clone(), path, body.clone(), auth_header)?;

        let first_attempt = tokio::select! {
            biased;
            () = cancel.wait_cancelled() => return Err(LanError::Cancelled),
            res = tokio::time::timeout(self.config.inactivity_timeout, sender.send_request(req)) => res,
        };

        match first_attempt {
            Ok(Ok(resp)) => Ok((resp, sender)),
            Ok(Err(_)) if reused && method == Method::GET => {
                // Server may have closed an idle keep-alive socket concurrently;
                // retry once on a fresh connection for idempotent GET requests.
                let mut fresh = self.connect_fresh(cancel, paired).await?;
                let retry_req = self.build_request(method, path, body, auth_header)?;
                tokio::select! {
                    biased;
                    () = cancel.wait_cancelled() => Err(LanError::Cancelled),
                    res = tokio::time::timeout(
                        self.config.inactivity_timeout,
                        fresh.send_request(retry_req),
                    ) => match res {
                        Ok(Ok(resp)) => Ok((resp, fresh)),
                        Ok(Err(err)) => Err(transport_error(
                            paired,
                            format!("HTTP request to {} failed: {err}", self.target),
                        )),
                        Err(_) => Err(transport_error(
                            paired,
                            format!("HTTP request to {} timed out", self.target),
                        )),
                    }
                }
            }
            Ok(Err(err)) => Err(transport_error(
                paired,
                format!("HTTP request to {} failed: {err}", self.target),
            )),
            Err(_) => Err(transport_error(
                paired,
                format!("HTTP request to {} timed out", self.target),
            )),
        }
    }
}

/// Unpaired LAN receiver client (`T-57`, `R3-02`).
///
/// Validates destination IPv4 literals strictly against [`AddressPolicy`]
/// without performing any DNS resolution, and reuses HTTP/1.1 keep-alive
/// connections across `hello` and `pair` (and passes the same connection pool
/// into [`PairedClient`]).
#[derive(Debug, Clone)]
pub struct LanClient {
    pool: Arc<Http1Pool>,
}

impl LanClient {
    /// Creates a production LAN receiver client enforcing strict RFC 1918 /
    /// `169.254.0.0/16` IPv4 literal validation (`T-57`).
    pub fn new(address: &str, config: LanClientConfig) -> LanResult<Self> {
        let target = parse_lan_address(address, AddressPolicy::lan_only())?;
        Ok(Self {
            pool: Arc::new(Http1Pool::new(target, config)?),
        })
    }

    /// Creates a production LAN receiver client with [`LanClientConfig::default`].
    pub fn with_defaults(address: &str) -> LanResult<Self> {
        Self::new(address, LanClientConfig::default())
    }

    /// Test-only constructor allowing `127.0.0.1` loopback targets for
    /// automated integration tests (`T-57`). Unreachable from Tauri IPC.
    #[cfg(any(test, feature = "test-loopback"))]
    pub fn new_loopback_for_tests(address: &str, config: LanClientConfig) -> LanResult<Self> {
        let target = parse_lan_address(address, AddressPolicy::loopback_for_tests())?;
        Ok(Self {
            pool: Arc::new(Http1Pool::new(target, config)?),
        })
    }

    /// Test-only constructor from a `SocketAddrV4` allowing loopback targets.
    #[cfg(any(test, feature = "test-loopback"))]
    pub fn from_addr_for_tests(target: SocketAddrV4, config: LanClientConfig) -> LanResult<Self> {
        AddressPolicy::loopback_for_tests().validate_ip(*target.ip())?;
        if target.port() == 0 {
            return Err(LanError::AddressInvalid(
                "port must be between 1 and 65535".into(),
            ));
        }
        Ok(Self {
            pool: Arc::new(Http1Pool::new(target, config)?),
        })
    }

    /// Returns the validated IPv4 `ip:port` target.
    pub fn target(&self) -> SocketAddrV4 {
        self.pool.target
    }

    /// Calls `GET /v1/hello` and validates protocol compatibility
    /// (`minProtocol <= 1 && protocol >= 1` and `app == "synapseread"`).
    pub async fn hello(&self, cancel: &CancelToken) -> LanResult<HelloInfo> {
        let mut cancel = cancel.clone();
        let (resp, sender) = self
            .pool
            .send(
                Method::GET,
                "/v1/hello",
                Bytes::new(),
                None,
                &mut cancel,
                false,
            )
            .await?;

        let status = resp.status();
        let max_bytes = self.pool.config.max_control_response_bytes;
        let (headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            false,
        )
        .await?;
        self.pool.checkin(sender, &headers);

        if status != StatusCode::OK {
            return Err(map_http_error(status, &body, false, false));
        }

        let info: HelloInfo = serde_json::from_slice(&body).map_err(|err| {
            LanError::ProtocolIncompatible(format!("invalid /v1/hello JSON payload: {err}"))
        })?;

        if info.app != EXPECTED_APP_ID {
            return Err(LanError::ProtocolIncompatible(format!(
                "unexpected LAN peer app identifier '{}'",
                info.app
            )));
        }
        if info.min_protocol > PROTOCOL_VERSION || info.protocol < PROTOCOL_VERSION {
            return Err(LanError::ProtocolIncompatible(format!(
                "peer protocol range {}..={} does not support v{}",
                info.min_protocol, info.protocol, PROTOCOL_VERSION
            )));
        }

        Ok(info)
    }

    /// Pairs with the source via `POST /v1/pair` using the 6-digit pairing code,
    /// returning a [`PairedClient`] that holds the opaque bearer token (`T-03`)
    /// and reuses the existing HTTP/1.1 keep-alive connection pool.
    pub async fn pair(&self, code: &str, cancel: &CancelToken) -> LanResult<PairedClient> {
        let mut cancel = cancel.clone();
        let payload = serde_json::to_vec(&PairRequestWire { code }).map_err(|err| {
            LanError::ProtocolIncompatible(format!("failed to encode pair request: {err}"))
        })?;

        let (resp, sender) = self
            .pool
            .send(
                Method::POST,
                "/v1/pair",
                Bytes::from(payload),
                None,
                &mut cancel,
                false,
            )
            .await?;

        let status = resp.status();
        let max_bytes = self.pool.config.max_control_response_bytes;
        let (headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            false,
        )
        .await?;
        self.pool.checkin(sender, &headers);

        if status != StatusCode::OK {
            return Err(map_http_error(status, &body, false, true));
        }

        let wire: PairResponseWire = serde_json::from_slice(&body).map_err(|err| {
            LanError::ProtocolIncompatible(format!("invalid /v1/pair JSON payload: {err}"))
        })?;
        let token = ReceiverToken::from_wire(wire.token)?;

        Ok(PairedClient {
            pool: Arc::clone(&self.pool),
            token,
            idle_timeout_seconds: wire.idle_timeout_seconds,
            permissions: wire.permissions,
        })
    }
}

/// Authenticated LAN receiver session holding an opaque, redacted bearer token
/// (`T-03`) and reusing HTTP/1.1 keep-alive connections (`R3-02`).
#[derive(Clone)]
pub struct PairedClient {
    pool: Arc<Http1Pool>,
    token: ReceiverToken,
    idle_timeout_seconds: u64,
    permissions: SharePermissions,
}

impl fmt::Debug for PairedClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairedClient")
            .field("target", &self.pool.target)
            .field("token", &self.token)
            .field("idle_timeout_seconds", &self.idle_timeout_seconds)
            .field("permissions", &self.permissions)
            .finish()
    }
}

impl PairedClient {
    /// Returns the validated IPv4 `ip:port` target.
    pub fn target(&self) -> SocketAddrV4 {
        self.pool.target
    }

    /// Returns the source-advertised session idle timeout in seconds.
    pub const fn idle_timeout_seconds(&self) -> u64 {
        self.idle_timeout_seconds
    }

    /// Returns the fixed sharing permissions negotiated for this session.
    pub const fn permissions(&self) -> SharePermissions {
        self.permissions
    }

    /// Fetches `GET /v1/catalog` with streaming raw-byte cap (`<= 8 MiB`) and
    /// entry count cap (`<= 10,000` books).
    pub async fn catalog(&self, cancel: &CancelToken) -> LanResult<CatalogResponse> {
        let mut cancel = cancel.clone();
        let auth = self.token.authorization_header()?;
        let (resp, sender) = self
            .pool
            .send(
                Method::GET,
                "/v1/catalog",
                Bytes::new(),
                Some(&auth),
                &mut cancel,
                true,
            )
            .await?;

        let status = resp.status();
        let max_bytes = if status == StatusCode::OK {
            self.pool.config.max_catalog_response_bytes
        } else {
            self.pool.config.max_control_response_bytes
        };
        let (headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            true,
        )
        .await?;
        self.pool.checkin(sender, &headers);

        if status != StatusCode::OK {
            return Err(map_http_error(status, &body, true, false));
        }

        let catalog: CatalogResponse = serde_json::from_slice(&body).map_err(|err| {
            LanError::ProtocolIncompatible(format!("invalid /v1/catalog JSON payload: {err}"))
        })?;

        if catalog.books.len() > self.pool.config.max_catalog_books {
            return Err(LanError::PayloadTooLarge(format!(
                "catalog contains {} books, exceeding limit of {}",
                catalog.books.len(),
                self.pool.config.max_catalog_books
            )));
        }

        Ok(catalog)
    }

    /// Fetches `GET /v1/books/{sha256}/position` (`200 OK` or `204 No Content`),
    /// enforcing the `<= 64 KiB` raw-byte cap before JSON parsing and parsing
    /// `anchor` forward-compatibly (`R2-05`, `T-52`).
    pub async fn book_position(
        &self,
        sha256: &str,
        cancel: &CancelToken,
    ) -> LanResult<ParsedPosition> {
        validate_sha256_path_segment(sha256)?;
        let mut cancel = cancel.clone();
        let auth = self.token.authorization_header()?;
        let path = format!("/v1/books/{sha256}/position");

        let (resp, sender) = self
            .pool
            .send(
                Method::GET,
                &path,
                Bytes::new(),
                Some(&auth),
                &mut cancel,
                true,
            )
            .await?;

        let status = resp.status();
        let max_bytes = if status == StatusCode::OK {
            self.pool.config.max_position_response_bytes
        } else {
            self.pool.config.max_control_response_bytes
        };
        let (headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            true,
        )
        .await?;
        self.pool.checkin(sender, &headers);

        if status == StatusCode::NO_CONTENT {
            return Ok(ParsedPosition::None);
        }
        if status != StatusCode::OK {
            return Err(map_http_error(status, &body, true, false));
        }

        let wire: PositionResponseWire = serde_json::from_slice(&body).map_err(|err| {
            LanError::ProtocolIncompatible(format!("invalid /position JSON payload: {err}"))
        })?;

        match serde_json::from_value::<AnchorLocation>(wire.anchor) {
            Ok(anchor) => Ok(ParsedPosition::Valid {
                anchor,
                progress: wire.progress,
            }),
            Err(err) => Ok(ParsedPosition::Skipped {
                reason: err.to_string(),
            }),
        }
    }

    /// Fetches `GET /v1/books/{sha256}/bookmarks`, enforcing `<= 2 MiB` raw
    /// bytes and `<= 10,000` bookmarks, and parsing each `anchor` individually
    /// so unknown future anchor formats or incompatible nested fields skip only
    /// that entry (`R2-05`, `T-52`).
    pub async fn book_bookmarks(
        &self,
        sha256: &str,
        cancel: &CancelToken,
    ) -> LanResult<Vec<ParsedBookmark>> {
        validate_sha256_path_segment(sha256)?;
        let mut cancel = cancel.clone();
        let auth = self.token.authorization_header()?;
        let path = format!("/v1/books/{sha256}/bookmarks");

        let (resp, sender) = self
            .pool
            .send(
                Method::GET,
                &path,
                Bytes::new(),
                Some(&auth),
                &mut cancel,
                true,
            )
            .await?;

        let status = resp.status();
        let max_bytes = if status == StatusCode::OK {
            self.pool.config.max_bookmarks_response_bytes
        } else {
            self.pool.config.max_control_response_bytes
        };
        let (headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            true,
        )
        .await?;
        self.pool.checkin(sender, &headers);

        if status != StatusCode::OK {
            return Err(map_http_error(status, &body, true, false));
        }

        let wire: BookmarksResponseWire = serde_json::from_slice(&body).map_err(|err| {
            LanError::ProtocolIncompatible(format!("invalid /bookmarks JSON payload: {err}"))
        })?;

        if wire.bookmarks.len() > self.pool.config.max_bookmarks_per_book {
            return Err(LanError::PayloadTooLarge(format!(
                "bookmarks response contains {} entries, exceeding limit of {}",
                wire.bookmarks.len(),
                self.pool.config.max_bookmarks_per_book
            )));
        }

        let parsed = wire
            .bookmarks
            .into_iter()
            .enumerate()
            .map(
                |(index, entry)| match serde_json::from_value::<AnchorLocation>(entry.anchor) {
                    Ok(anchor) => ParsedBookmark::Valid(WireBookmark {
                        anchor,
                        label: entry.label,
                        created_at: entry.created_at,
                    }),
                    Err(err) => ParsedBookmark::Skipped {
                        index,
                        reason: err.to_string(),
                    },
                },
            )
            .collect();

        Ok(parsed)
    }

    /// Streams `GET /v1/books/{sha256}/file` directly into a caller-provided
    /// [`StagedFile`], verifying exact `Content-Length`, checking cancellation
    /// on every chunk (`T-18`), invoking `on_progress(downloaded, total)`, and
    /// publishing atomically via [`StagedFile::finish`] (`T-16`).
    pub async fn download_book_into_staged<F>(
        &self,
        sha256: &str,
        mut staged: StagedFile,
        cancel: &CancelToken,
        mut on_progress: F,
    ) -> LanResult<PathBuf>
    where
        F: FnMut(u64, u64),
    {
        if cancel.is_cancelled() {
            staged.cancel();
            return Err(LanError::Cancelled);
        }
        if let Err(err) = validate_sha256_path_segment(sha256) {
            staged.cancel();
            return Err(err);
        }

        let expected_bytes = staged.expected_bytes();
        let mut cancel = cancel.clone();
        let auth = match self.token.authorization_header() {
            Ok(auth) => auth,
            Err(err) => {
                staged.cancel();
                return Err(err);
            }
        };
        let path = format!("/v1/books/{sha256}/file");

        let (resp, sender) = match self
            .pool
            .send(
                Method::GET,
                &path,
                Bytes::new(),
                Some(&auth),
                &mut cancel,
                true,
            )
            .await
        {
            Ok(pair) => pair,
            Err(err) => {
                staged.cancel();
                return Err(err);
            }
        };

        let status = resp.status();
        if status != StatusCode::OK {
            let max_bytes = self.pool.config.max_control_response_bytes;
            let err = match read_bounded_body(
                resp,
                max_bytes,
                self.pool.config.inactivity_timeout,
                &mut cancel,
                true,
            )
            .await
            {
                Ok((headers, body)) => {
                    self.pool.checkin(sender, &headers);
                    map_http_error(status, &body, true, false)
                }
                Err(err) => err,
            };
            staged.cancel();
            return Err(err);
        }

        let declared_len = match parse_exact_content_length(resp.headers()) {
            Some(len) => len,
            None => {
                staged.cancel();
                return Err(LanError::SizeMismatch {
                    expected: expected_bytes,
                    actual: 0,
                });
            }
        };
        if declared_len != expected_bytes {
            staged.cancel();
            return Err(LanError::SizeMismatch {
                expected: expected_bytes,
                actual: declared_len,
            });
        }

        let (parts, mut body) = resp.into_parts();
        let mut downloaded: u64 = 0;

        loop {
            if cancel.is_cancelled() {
                staged.cancel();
                return Err(LanError::Cancelled);
            }

            let next_frame = tokio::select! {
                biased;
                () = cancel.wait_cancelled() => {
                    staged.cancel();
                    return Err(LanError::Cancelled);
                }
                res = tokio::time::timeout(self.pool.config.inactivity_timeout, body.frame()) => res,
            };

            let frame_res = match next_frame {
                Ok(Some(res)) => res,
                Ok(None) => break,
                Err(_) => {
                    staged.cancel();
                    return Err(LanError::SourceStopped(
                        "file download timed out waiting for next chunk".into(),
                    ));
                }
            };

            let frame = match frame_res {
                Ok(frame) => frame,
                Err(err) => {
                    staged.cancel();
                    return Err(LanError::SourceStopped(format!(
                        "file download interrupted: {err}"
                    )));
                }
            };

            if let Some(data) = frame.data_ref()
                && !data.is_empty()
            {
                let next_total = downloaded.checked_add(data.len() as u64);
                if next_total.is_none_or(|total| total > expected_bytes) {
                    staged.cancel();
                    return Err(LanError::SizeMismatch {
                        expected: expected_bytes,
                        actual: downloaded.saturating_add(data.len() as u64),
                    });
                }

                if let Err(err) = staged.write_chunk(data) {
                    staged.cancel();
                    return Err(map_core_error(err, expected_bytes, downloaded));
                }

                downloaded += data.len() as u64;
                on_progress(downloaded, expected_bytes);
            }
        }

        if downloaded != expected_bytes {
            staged.cancel();
            return Err(LanError::SizeMismatch {
                expected: expected_bytes,
                actual: downloaded,
            });
        }

        // Body reached clean EOF; connection is safe to return to the pool.
        self.pool.checkin(sender, &parts.headers);

        staged
            .finish()
            .map_err(|err| map_core_error(err, expected_bytes, downloaded))
    }

    /// Convenience wrapper that calls [`ManagedLibrary::begin_stage`] and
    /// streams `GET /v1/books/{sha256}/file` into `<app-data>/library/<sha256>.<ext>`.
    #[allow(clippy::too_many_arguments)]
    pub async fn download_book_file<F>(
        &self,
        library: &ManagedLibrary,
        format: DocumentFormat,
        extension: &str,
        sha256: &str,
        expected_bytes: u64,
        cancel: &CancelToken,
        on_progress: F,
    ) -> LanResult<PathBuf>
    where
        F: FnMut(u64, u64),
    {
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled);
        }
        let staged = library
            .begin_stage(format, extension, sha256, expected_bytes)
            .map_err(|err| map_core_error(err, expected_bytes, 0))?;
        self.download_book_into_staged(sha256, staged, cancel, on_progress)
            .await
    }

    /// Cleanly terminates the paired session via `POST /v1/session/end` (`204`)
    /// and clears pooled idle connections.
    pub async fn session_end(&self, cancel: &CancelToken) -> LanResult<()> {
        let mut cancel = cancel.clone();
        let auth = self.token.authorization_header()?;
        let (resp, _sender) = self
            .pool
            .send(
                Method::POST,
                "/v1/session/end",
                Bytes::from_static(b"{}"),
                Some(&auth),
                &mut cancel,
                true,
            )
            .await?;

        let status = resp.status();
        let max_bytes = self.pool.config.max_control_response_bytes;
        let (_headers, body) = read_bounded_body(
            resp,
            max_bytes,
            self.pool.config.inactivity_timeout,
            &mut cancel,
            true,
        )
        .await?;

        // Source closes the session after `POST /v1/session/end`.
        self.pool.clear_idle();

        if status == StatusCode::NO_CONTENT || status == StatusCode::OK {
            Ok(())
        } else {
            Err(map_http_error(status, &body, true, false))
        }
    }
}

fn validate_sha256_path_segment(sha256: &str) -> LanResult<()> {
    if is_valid_sha256_hex(sha256) {
        Ok(())
    } else {
        Err(LanError::HashMismatch)
    }
}

fn parse_exact_content_length(headers: &HeaderMap) -> Option<u64> {
    let mut values = headers.get_all(header::CONTENT_LENGTH).iter();
    let first = values.next()?;
    if values.next().is_some() {
        return None;
    }
    first.to_str().ok()?.trim().parse::<u64>().ok()
}

fn has_connection_close(headers: &HeaderMap) -> bool {
    headers.get_all(header::CONNECTION).iter().any(|val| {
        val.to_str().is_ok_and(|raw| {
            raw.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("close"))
        })
    })
}

fn transport_error(paired: bool, message: String) -> LanError {
    if paired {
        LanError::SourceStopped(message)
    } else {
        LanError::Unreachable(message)
    }
}

fn map_core_error(err: CoreError, expected: u64, actual: u64) -> LanError {
    match err {
        CoreError::LanDiskFull(msg) => LanError::DiskFull(msg),
        CoreError::LanHashMismatch(_) => LanError::HashMismatch,
        CoreError::LanSizeMismatch(_) => LanError::SizeMismatch { expected, actual },
        CoreError::LanPayloadTooLarge(msg) => LanError::PayloadTooLarge(msg),
        CoreError::Io(io_err) if is_disk_full_error(&io_err) => {
            LanError::DiskFull(io_err.to_string())
        }
        other => LanError::Core(other),
    }
}

async fn read_bounded_body(
    resp: Response<Incoming>,
    max_bytes: usize,
    inactivity_timeout: Duration,
    cancel: &mut CancelToken,
    paired: bool,
) -> LanResult<(HeaderMap, Vec<u8>)> {
    if cancel.is_cancelled() {
        return Err(LanError::Cancelled);
    }

    if let Some(declared) = parse_exact_content_length(resp.headers())
        && declared > max_bytes as u64
    {
        return Err(LanError::PayloadTooLarge(format!(
            "response body of {declared} bytes exceeds limit of {max_bytes} bytes"
        )));
    }

    let (parts, mut body) = resp.into_parts();
    let mut buf = Vec::new();

    loop {
        if cancel.is_cancelled() {
            return Err(LanError::Cancelled);
        }

        let next_frame = tokio::select! {
            biased;
            () = cancel.wait_cancelled() => return Err(LanError::Cancelled),
            res = tokio::time::timeout(inactivity_timeout, body.frame()) => res,
        };

        let frame_res = match next_frame {
            Ok(Some(res)) => res,
            Ok(None) => break,
            Err(_) => {
                return Err(transport_error(
                    paired,
                    "timed out reading HTTP response body".into(),
                ));
            }
        };

        let frame = frame_res.map_err(|err| {
            transport_error(paired, format!("failed reading HTTP response body: {err}"))
        })?;

        if let Some(data) = frame.data_ref() {
            if buf.len().saturating_add(data.len()) > max_bytes {
                return Err(LanError::PayloadTooLarge(format!(
                    "response body exceeded limit of {max_bytes} bytes"
                )));
            }
            buf.extend_from_slice(data);
        }
    }

    Ok((parts.headers, buf))
}

fn map_http_error(
    status: StatusCode,
    body: &[u8],
    paired: bool,
    is_pair_endpoint: bool,
) -> LanError {
    if let Ok(parsed) = serde_json::from_slice::<ErrorResponseBody>(body) {
        let message = if parsed.message.is_empty() {
            format!("HTTP {}", status.as_u16())
        } else {
            parsed.message
        };
        return match parsed.code.as_str() {
            "lan_protocol_incompatible" => LanError::ProtocolIncompatible(message),
            "lan_auth_invalid" => LanError::AuthInvalid,
            "lan_auth_expired" => LanError::AuthExpired,
            "lan_attempts_exceeded" => LanError::AttemptsExceeded,
            "lan_session_busy" => LanError::SessionBusy,
            "lan_scope_denied" => LanError::ScopeDenied(message),
            "lan_transfer_busy" => LanError::TransferBusy,
            "lan_source_changed" => LanError::SourceChanged(message),
            "lan_payload_too_large" => LanError::PayloadTooLarge(message),
            "lan_size_mismatch" => LanError::SizeMismatch {
                expected: 0,
                actual: 0,
            },
            "lan_hash_mismatch" => LanError::HashMismatch,
            "lan_disk_full" => LanError::DiskFull(message),
            "lan_cancelled" => LanError::Cancelled,
            "lan_source_stopped" => LanError::SourceStopped(message),
            "lan_position_conflict" => LanError::PositionConflict(message),
            "lan_not_found" | "not_found" => LanError::Core(CoreError::NotFound {
                entity: "resource",
                id: message,
            }),
            _ => map_status_fallback(status, message, paired, is_pair_endpoint),
        };
    }

    map_status_fallback(
        status,
        format!("unexpected HTTP status {}", status.as_u16()),
        paired,
        is_pair_endpoint,
    )
}

fn map_status_fallback(
    status: StatusCode,
    message: String,
    paired: bool,
    is_pair_endpoint: bool,
) -> LanError {
    match status {
        StatusCode::UNAUTHORIZED => LanError::AuthInvalid,
        StatusCode::FORBIDDEN => LanError::ScopeDenied(message),
        StatusCode::NOT_FOUND => LanError::Core(CoreError::NotFound {
            entity: "resource",
            id: message,
        }),
        StatusCode::CONFLICT => {
            if is_pair_endpoint {
                LanError::SessionBusy
            } else {
                LanError::SourceChanged(message)
            }
        }
        StatusCode::GONE => LanError::AuthExpired,
        StatusCode::PAYLOAD_TOO_LARGE => LanError::PayloadTooLarge(message),
        StatusCode::TOO_MANY_REQUESTS => {
            if is_pair_endpoint {
                LanError::AttemptsExceeded
            } else {
                LanError::TransferBusy
            }
        }
        StatusCode::BAD_REQUEST
        | StatusCode::METHOD_NOT_ALLOWED
        | StatusCode::UNSUPPORTED_MEDIA_TYPE => LanError::ProtocolIncompatible(message),
        StatusCode::REQUEST_TIMEOUT => LanError::Cancelled,
        _ => transport_error(paired, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::convert::Infallible;
    use std::io;
    use std::net::Ipv4Addr;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use hyper::body::Frame;
    use hyper::service::service_fn;
    use sha2::{Digest, Sha256};
    use synapse_core::domain::NormalizedRect;
    use synapse_core::library::StageWriter;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    use crate::http::{
        HttpServerConfig, LanBoxBody, LanHttpHandler, LanResponse, SourceApiHandler,
        error_response, finalize_response, full_body, json_response, no_content_response,
    };
    use crate::listener::TokioMonotonicClock;
    use crate::session::{AuthorizedContext, SessionConfig, SessionManager, SnapshotBook};

    fn sha256_hex(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut out = String::with_capacity(64);
        for b in digest {
            use std::fmt::Write as _;
            let _ = write!(out, "{b:02x}");
        }
        out
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "synapse-lan-client-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    struct MockServerHandle {
        addr: SocketAddrV4,
        accept_count: Arc<AtomicUsize>,
        shutdown_tx: watch::Sender<bool>,
    }

    impl MockServerHandle {
        fn accepts(&self) -> usize {
            self.accept_count.load(Ordering::SeqCst)
        }

        fn stop(self) {
            let _ = self.shutdown_tx.send(true);
        }
    }

    async fn spawn_mock_http_server<F, Fut>(handler: F) -> MockServerHandle
    where
        F: Fn(Request<Incoming>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LanResponse> + Send + 'static,
    {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind loopback");
        let SocketAddr::V4(addr) = listener.local_addr().expect("local addr") else {
            panic!("expected IPv4 loopback");
        };
        let accept_count = Arc::new(AtomicUsize::new(0));
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let handler = Arc::new(handler);
        let count_clone = Arc::clone(&accept_count);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown_rx.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _peer)) = accepted else {
                            break;
                        };
                        count_clone.fetch_add(1, Ordering::SeqCst);
                        let handler = Arc::clone(&handler);
                        let mut conn_shutdown = shutdown_rx.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |req: Request<Incoming>| {
                                let handler = Arc::clone(&handler);
                                async move { Ok::<_, Infallible>(handler(req).await) }
                            });
                            let conn = hyper::server::conn::http1::Builder::new()
                                .keep_alive(true)
                                .serve_connection(TokioIo::new(stream), service);
                            tokio::pin!(conn);
                            tokio::select! {
                                biased;
                                _ = conn_shutdown.changed() => {}
                                _ = &mut conn => {}
                            }
                        });
                    }
                }
            }
        });

        MockServerHandle {
            addr,
            accept_count,
            shutdown_tx,
        }
    }

    // T-57: Strict IPv4 literal validation rejecting hostnames, public IPs,
    // multicast, 100.64/10, and loopback in production constructor.
    #[test]
    fn t57_client_address_validation_rejects_disallowed_targets() {
        for bad in [
            "",
            "   ",
            "localhost",
            "localhost:49319",
            "macbook.local:49319",
            "example.com:49319",
            "http://192.168.1.10:49319",
            "[::1]:49319",
            "8.8.8.8",
            "8.8.8.8:49319",
            "100.64.0.1:49319",
            "100.127.255.254:49319",
            "224.0.0.251:49319",
            "127.0.0.1",
            "127.0.0.1:49319",
            "0.0.0.0:49319",
            "192.168.1.10:0",
        ] {
            let err = LanClient::with_defaults(bad)
                .expect_err(&format!("production client must reject '{bad}'"));
            assert_eq!(err.code(), "lan_address_invalid", "bad input: {bad}");
        }

        // Valid RFC 1918 and link-local IPv4 literals accepted (with trimming & default port)
        let c1 = LanClient::with_defaults("  192.168.1.42  ").expect("valid private IP");
        assert_eq!(
            c1.target(),
            SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 42), 49319)
        );
        let c2 = LanClient::with_defaults("10.0.0.8:49325").expect("valid 10/8 IP");
        assert_eq!(
            c2.target(),
            SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 8), 49325)
        );
        let c3 = LanClient::with_defaults("169.254.12.34:49319").expect("valid link-local");
        assert_eq!(
            c3.target(),
            SocketAddrV4::new(Ipv4Addr::new(169, 254, 12, 34), 49319)
        );

        // Test-only loopback constructor permits 127.0.0.1
        let c_loop =
            LanClient::new_loopback_for_tests("127.0.0.1:49319", LanClientConfig::default())
                .expect("loopback allowed in test constructor");
        assert_eq!(
            c_loop.target(),
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 49319)
        );
    }

    // T-03: Bearer token is redacted in Debug and never appears in URLs or errors.
    #[tokio::test]
    async fn t03_bearer_token_redacted_in_debug_and_never_in_urls_or_errors() {
        let secret_token = "super_secret_bearer_token_value_1234567890";
        let observed_urls = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_urls_clone = Arc::clone(&observed_urls);

        let server = spawn_mock_http_server(move |req| {
            let observed_urls = Arc::clone(&observed_urls_clone);
            async move {
                observed_urls
                    .lock()
                    .expect("lock")
                    .push(req.uri().to_string());
                match req.uri().path() {
                    "/v1/pair" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "token": secret_token,
                            "idleTimeoutSeconds": 600,
                            "permissions": { "positions": true, "bookmarks": true }
                        }),
                    ),
                    "/v1/catalog" => {
                        error_response(StatusCode::UNAUTHORIZED, "lan_auth_invalid", "rejected")
                    }
                    _ => error_response(StatusCode::NOT_FOUND, "lan_not_found", "not found"),
                }
            }
        })
        .await;

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        // Debug output must redact the bearer token
        let debug_str = format!("{paired:?}");
        assert!(
            !debug_str.contains(secret_token),
            "Debug output leaked bearer token: {debug_str}"
        );
        assert!(debug_str.contains("[REDACTED]"));

        // Errors must not contain the bearer token
        let err = paired
            .catalog(&CancelToken::never())
            .await
            .expect_err("unauthorized");
        assert_eq!(err.code(), "lan_auth_invalid");
        assert!(!err.to_string().contains(secret_token));
        assert!(!format!("{err:?}").contains(secret_token));

        // No request URL may ever contain the bearer token
        for url in observed_urls.lock().expect("lock").iter() {
            assert!(!url.contains(secret_token), "URL leaked token: {url}");
        }

        server.stop();
    }

    struct StubSourceApi {
        sha256: String,
    }

    impl SourceApiHandler for StubSourceApi {
        fn catalog(
            &self,
            _auth: AuthorizedContext,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn std::future::Future<Output = LanResponse> + Send + 'static>> {
            let sha = self.sha256.clone();
            Box::pin(async move {
                json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "books": [{
                            "id": sha,
                            "title": "Sample Book",
                            "format": "txt",
                            "extension": "txt",
                            "sizeBytes": 12,
                            "fileAvailable": true,
                            "hasPosition": true,
                            "bookmarkCount": 1
                        }]
                    }),
                )
            })
        }

        fn book_file(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn std::future::Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async {
                let mut resp = Response::new(full_body(Bytes::from_static(b"hello world!")));
                *resp.status_mut() = StatusCode::OK;
                resp.headers_mut()
                    .insert(header::CONTENT_LENGTH, HeaderValue::from_static("12"));
                finalize_response(resp)
            })
        }

        fn book_position(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn std::future::Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async {
                json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "anchor": {
                            "format": "txt",
                            "startByteOffset": 0,
                            "endByteOffset": 5,
                            "lineIndex": 0
                        },
                        "progress": 0.5
                    }),
                )
            })
        }

        fn book_bookmarks(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn std::future::Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async {
                json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "bookmarks": [{
                            "anchor": {
                                "format": "txt",
                                "startByteOffset": 0,
                                "endByteOffset": 5,
                                "lineIndex": 0
                            },
                            "label": "Intro",
                            "createdAt": "2026-01-01T00:00:00Z"
                        }]
                    }),
                )
            })
        }
    }

    // R3-02: HTTP/1.1 keep-alive connection reuse across hello, pair, catalog,
    // position, bookmarks, and session_end verified by server accept count == 1.
    #[tokio::test]
    async fn r3_02_keep_alive_reuses_single_tcp_connection_with_real_http_handler() {
        let sha = sha256_hex(b"hello world!");
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let SocketAddr::V4(addr) = listener.local_addr().expect("addr") else {
            panic!("ipv4");
        };

        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            SessionConfig::default(),
            clock,
            SharePermissions {
                positions: true,
                bookmarks: true,
            },
            vec![SnapshotBook {
                document_id: "doc-1".into(),
                snapshot_file_hash: sha.clone(),
            }],
        )
        .expect("session");
        let session = Arc::new(session);
        let api = Arc::new(StubSourceApi {
            sha256: sha.clone(),
        });
        let handler = Arc::new(LanHttpHandler::new(
            addr,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        ));

        let accept_count = Arc::new(AtomicUsize::new(0));
        let count_clone = Arc::clone(&accept_count);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        tokio::spawn(async move {
            use crate::listener::ConnectionHandler as _;
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown_rx.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { break };
                        count_clone.fetch_add(1, Ordering::SeqCst);
                        let fut = handler.handle(stream, peer, shutdown_rx.clone());
                        tokio::spawn(fut);
                    }
                }
            }
        });

        let client =
            LanClient::from_addr_for_tests(addr, LanClientConfig::default()).expect("client");
        let cancel = CancelToken::never();

        let hello = client.hello(&cancel).await.expect("hello");
        assert_eq!(hello.protocol, 1);
        assert_eq!(hello.min_protocol, 1);
        assert_eq!(hello.app, "synapseread");

        let paired = client.pair(code.expose(), &cancel).await.expect("pair");
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        assert_eq!(catalog.books.len(), 1);
        assert_eq!(catalog.books[0].id, sha);

        let pos = paired.book_position(&sha, &cancel).await.expect("position");
        assert!(matches!(pos, ParsedPosition::Valid { .. }));

        let bookmarks = paired
            .book_bookmarks(&sha, &cancel)
            .await
            .expect("bookmarks");
        assert_eq!(bookmarks.len(), 1);
        assert!(matches!(bookmarks[0], ParsedBookmark::Valid(_)));

        paired.session_end(&cancel).await.expect("session_end");

        assert_eq!(
            accept_count.load(Ordering::SeqCst),
            1,
            "all 6 requests should have reused a single keep-alive TCP connection"
        );

        let _ = shutdown_tx.send(true);
    }

    // Streaming raw-byte cap enforcement BEFORE JSON deserialization.
    #[tokio::test]
    async fn streaming_raw_byte_cap_enforced_before_json_parsing() {
        let server = spawn_mock_http_server(|req| async move {
            match req.uri().path() {
                "/v1/pair" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "token": "tok-cap-test",
                        "idleTimeoutSeconds": 600,
                        "permissions": { "positions": true, "bookmarks": true }
                    }),
                ),
                "/v1/catalog" => {
                    // Chunked (no Content-Length) invalid-JSON oversized stream:
                    // must fail with PayloadTooLarge BEFORE JSON parsing runs!
                    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(8);
                    tokio::spawn(async move {
                        let chunk = Bytes::from(vec![b'X'; 512]);
                        for _ in 0..10 {
                            if tx.send(Ok(Frame::data(chunk.clone()))).await.is_err() {
                                break;
                            }
                        }
                    });
                    let body: LanBoxBody = BodyExt::boxed(MpscBody(rx));
                    let mut resp = Response::new(body);
                    *resp.status_mut() = StatusCode::OK;
                    finalize_response(resp)
                }
                _ => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "books": [
                            {"id": "a".repeat(64), "title": "1", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true},
                            {"id": "b".repeat(64), "title": "2", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true},
                            {"id": "c".repeat(64), "title": "3", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true}
                        ]
                    }),
                ),
            }
        })
        .await;

        let config = LanClientConfig {
            max_catalog_response_bytes: 1024,
            max_catalog_books: 2,
            ..LanClientConfig::default()
        };
        let client = LanClient::from_addr_for_tests(server.addr, config).expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let err = paired
            .catalog(&CancelToken::never())
            .await
            .expect_err("oversized catalog must fail");
        assert_eq!(err.code(), "lan_payload_too_large");

        server.stop();
    }

    // Book count & bookmark count cap enforcement.
    #[tokio::test]
    async fn catalog_and_bookmark_count_caps_enforced() {
        let sha = "a".repeat(64);
        let server = spawn_mock_http_server(|req| async move {
            match req.uri().path() {
                "/v1/pair" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "token": "tok-count-test",
                        "idleTimeoutSeconds": 600,
                        "permissions": { "positions": true, "bookmarks": true }
                    }),
                ),
                "/v1/catalog" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "books": [
                            {"id": "a".repeat(64), "title": "1", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true},
                            {"id": "b".repeat(64), "title": "2", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true},
                            {"id": "c".repeat(64), "title": "3", "format": "txt", "extension": "txt", "sizeBytes": 1, "fileAvailable": true}
                        ]
                    }),
                ),
                _ => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "bookmarks": [
                            {"anchor": {"format": "txt", "startByteOffset": 0, "endByteOffset": 1, "lineIndex": 0}},
                            {"anchor": {"format": "txt", "startByteOffset": 1, "endByteOffset": 2, "lineIndex": 0}},
                            {"anchor": {"format": "txt", "startByteOffset": 2, "endByteOffset": 3, "lineIndex": 0}}
                        ]
                    }),
                ),
            }
        })
        .await;

        let config = LanClientConfig {
            max_catalog_books: 2,
            max_bookmarks_per_book: 2,
            ..LanClientConfig::default()
        };
        let client = LanClient::from_addr_for_tests(server.addr, config).expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let err = paired
            .catalog(&CancelToken::never())
            .await
            .expect_err("too many books");
        assert_eq!(err.code(), "lan_payload_too_large");

        let err = paired
            .book_bookmarks(&sha, &CancelToken::never())
            .await
            .expect_err("too many bookmarks");
        assert_eq!(err.code(), "lan_payload_too_large");

        server.stop();
    }

    // T-16: Streaming file download into StagedFile with progress callback,
    // exact Content-Length enforcement, and hash mismatch cleanup.
    #[tokio::test]
    async fn t16_streaming_download_into_staged_file_and_content_length_enforcement() {
        let payload = b"The quick brown fox jumps over the lazy dog.\n".repeat(4096);
        let expected_sha = sha256_hex(&payload);
        let expected_len = payload.len() as u64;
        let payload_clone = payload.clone();

        let wrong_len_sha = "b".repeat(64);
        let wrong_hash_sha = "1".repeat(64);
        let wrong_len_path = format!("/v1/books/{wrong_len_sha}/file");
        let wrong_hash_path = format!("/v1/books/{wrong_hash_sha}/file");
        let good_path = format!("/v1/books/{expected_sha}/file");

        let server = spawn_mock_http_server(move |req| {
            let payload = payload_clone.clone();
            let good_path = good_path.clone();
            let wrong_len_path = wrong_len_path.clone();
            let wrong_hash_path = wrong_hash_path.clone();
            async move {
                match req.uri().path() {
                    "/v1/pair" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "token": "tok-dl-test",
                            "idleTimeoutSeconds": 600,
                            "permissions": { "positions": true, "bookmarks": true }
                        }),
                    ),
                    p if p == good_path => {
                        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(4);
                        let total = payload.len();
                        tokio::spawn(async move {
                            for chunk in payload.chunks(16 * 1024) {
                                if tx
                                    .send(Ok(Frame::data(Bytes::copy_from_slice(chunk))))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                tokio::task::yield_now().await;
                            }
                        });
                        let mut resp = Response::new(BodyExt::boxed(MpscBody(rx)));
                        *resp.status_mut() = StatusCode::OK;
                        resp.headers_mut().insert(
                            header::CONTENT_LENGTH,
                            HeaderValue::from_str(&total.to_string()).expect("len"),
                        );
                        finalize_response(resp)
                    }
                    p if p == wrong_len_path => {
                        let mut resp = Response::new(full_body(Bytes::from_static(b"short")));
                        *resp.status_mut() = StatusCode::OK;
                        resp.headers_mut()
                            .insert(header::CONTENT_LENGTH, HeaderValue::from_static("5"));
                        finalize_response(resp)
                    }
                    p if p == wrong_hash_path => {
                        let mut resp = Response::new(full_body(Bytes::from_static(b"corrupted!")));
                        *resp.status_mut() = StatusCode::OK;
                        resp.headers_mut()
                            .insert(header::CONTENT_LENGTH, HeaderValue::from_static("10"));
                        finalize_response(resp)
                    }
                    _ => error_response(StatusCode::NOT_FOUND, "lan_not_found", "missing"),
                }
            }
        })
        .await;

        let dir = temp_dir("t16");
        let library = ManagedLibrary::new(&dir);
        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let mut progress_events = Vec::new();
        let published = paired
            .download_book_file(
                &library,
                DocumentFormat::Txt,
                "txt",
                &expected_sha,
                expected_len,
                &CancelToken::never(),
                |done, total| progress_events.push((done, total)),
            )
            .await
            .expect("download succeeds");

        assert_eq!(std::fs::read(&published).expect("read published"), payload);
        assert!(
            progress_events.len() > 1,
            "expected multiple streaming chunks"
        );
        assert_eq!(
            progress_events.last().copied(),
            Some((expected_len, expected_len))
        );

        // Mismatched Content-Length must fail with SizeMismatch and leave no .part
        let err = paired
            .download_book_file(
                &library,
                DocumentFormat::Txt,
                "txt",
                &wrong_len_sha,
                100,
                &CancelToken::never(),
                |_, _| {},
            )
            .await
            .expect_err("content-length mismatch");
        assert_eq!(err.code(), "lan_size_mismatch");

        // Mismatched SHA-256 hash must fail with HashMismatch and leave no .part
        let err = paired
            .download_book_file(
                &library,
                DocumentFormat::Txt,
                "txt",
                &wrong_hash_sha,
                10,
                &CancelToken::never(),
                |_, _| {},
            )
            .await
            .expect_err("hash mismatch");
        assert_eq!(err.code(), "lan_hash_mismatch");

        assert_eq!(
            std::fs::read_dir(library.staging_dir())
                .expect("staging dir")
                .count(),
            0,
            "staging dir must have no leftover .part files"
        );

        let _ = std::fs::remove_dir_all(&dir);
        server.stop();
    }

    // T-18: Mid-stream cancellation aborts within one chunk and cleans up .part.
    #[tokio::test]
    async fn t18_mid_stream_cancellation_aborts_and_cleans_up_part() {
        let sha = "c".repeat(64);
        let total_size: u64 = 1024 * 64;
        let (chunk_sent_tx, mut chunk_sent_rx) = mpsc::channel::<()>(4);
        let chunk_sent_tx = Arc::new(chunk_sent_tx);

        let server = spawn_mock_http_server(move |req| {
            let chunk_sent_tx = Arc::clone(&chunk_sent_tx);
            async move {
                match req.uri().path() {
                    "/v1/pair" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "token": "tok-cancel-test",
                            "idleTimeoutSeconds": 600,
                            "permissions": { "positions": true, "bookmarks": true }
                        }),
                    ),
                    _ => {
                        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(2);
                        tokio::spawn(async move {
                            let _ = tx
                                .send(Ok(Frame::data(Bytes::from(vec![b'A'; 4096]))))
                                .await;
                            let _ = chunk_sent_tx.send(()).await;
                            // Stall indefinitely waiting for client cancel
                            tokio::time::sleep(Duration::from_secs(60)).await;
                        });
                        let mut resp = Response::new(BodyExt::boxed(MpscBody(rx)));
                        *resp.status_mut() = StatusCode::OK;
                        resp.headers_mut().insert(
                            header::CONTENT_LENGTH,
                            HeaderValue::from_str(&total_size.to_string()).expect("len"),
                        );
                        finalize_response(resp)
                    }
                }
            }
        })
        .await;

        let dir = temp_dir("t18");
        let library = ManagedLibrary::new(&dir);
        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let (cancel_handle, cancel_token) = CancelHandle::new();
        let cancel_trigger = cancel_handle.clone();
        tokio::spawn(async move {
            let _ = chunk_sent_rx.recv().await;
            cancel_trigger.cancel();
        });

        let err = paired
            .download_book_file(
                &library,
                DocumentFormat::Txt,
                "txt",
                &sha,
                total_size,
                &cancel_token,
                |_, _| {},
            )
            .await
            .expect_err("download must be cancelled");
        assert_eq!(err.code(), "lan_cancelled");
        assert_eq!(
            std::fs::read_dir(library.staging_dir())
                .expect("staging dir")
                .count(),
            0,
            "cancelled download must delete its .part file"
        );

        let _ = std::fs::remove_dir_all(&dir);
        server.stop();
    }

    // Disk-full (ENOSPC / StorageFull) mapping during streaming download.
    #[tokio::test]
    async fn streaming_download_maps_disk_full_error() {
        struct DiskFullWriter;
        impl io::Write for DiskFullWriter {
            fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::StorageFull, "no space left"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl StageWriter for DiskFullWriter {
            fn sync_file(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let payload = b"disk full test payload";
        let sha = sha256_hex(payload);
        let server = spawn_mock_http_server(move |req| async move {
            match req.uri().path() {
                "/v1/pair" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "token": "tok-enospc",
                        "idleTimeoutSeconds": 600,
                        "permissions": { "positions": true, "bookmarks": true }
                    }),
                ),
                _ => {
                    let mut resp = Response::new(full_body(Bytes::from_static(payload)));
                    *resp.status_mut() = StatusCode::OK;
                    resp.headers_mut().insert(
                        header::CONTENT_LENGTH,
                        HeaderValue::from_str(&payload.len().to_string()).expect("len"),
                    );
                    finalize_response(resp)
                }
            }
        })
        .await;

        let dir = temp_dir("enospc");
        let library = ManagedLibrary::new(&dir);
        let staged = library
            .begin_stage_with_writer(
                DocumentFormat::Txt,
                "txt",
                &sha,
                payload.len() as u64,
                |_path| Ok(Box::new(DiskFullWriter)),
            )
            .expect("begin stage");

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let err = paired
            .download_book_into_staged(&sha, staged, &CancelToken::never(), |_, _| {})
            .await
            .expect_err("disk full");
        assert_eq!(err.code(), "lan_disk_full");

        let _ = std::fs::remove_dir_all(&dir);
        server.stop();
    }

    // T-52 / R2-05: Unknown extra wire fields ignored; unknown future anchor
    // format or unknown field on NormalizedRect/PdfPageSpan skips only that
    // entry while preserving valid sibling bookmarks. Also tests 204 position.
    #[tokio::test]
    async fn t52_forward_compatible_wire_and_anchor_parsing() {
        let sha_ok = "d".repeat(64);
        let sha_204 = "e".repeat(64);
        let sha_future_pos = "f".repeat(64);

        let pos_204_path = format!("/v1/books/{sha_204}/position");
        let pos_future_path = format!("/v1/books/{sha_future_pos}/position");
        let bookmarks_path = format!("/v1/books/{sha_ok}/bookmarks");

        let server = spawn_mock_http_server(move |req| {
            let pos_204_path = pos_204_path.clone();
            let pos_future_path = pos_future_path.clone();
            let bookmarks_path = bookmarks_path.clone();
            async move {
                match req.uri().path() {
                    "/v1/hello" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "protocol": 2,
                            "minProtocol": 1,
                            "app": "synapseread",
                            "futureField": "ignored"
                        }),
                    ),
                    "/v1/pair" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "token": "tok-t52",
                            "idleTimeoutSeconds": 600,
                            "permissions": { "positions": true, "bookmarks": true },
                            "extraPairField": 42
                        }),
                    ),
                    "/v1/catalog" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "books": [{
                                "id": "d".repeat(64),
                                "title": "Future Book",
                                "format": "pdf",
                                "extension": "pdf",
                                "sizeBytes": 123,
                                "fileAvailable": true,
                                "futureBookField": true
                            }],
                            "futureCatalogField": "ok"
                        }),
                    ),
                    p if p == pos_204_path => no_content_response(),
                    p if p == pos_future_path => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "anchor": { "format": "cbz", "frame": 12 },
                            "progress": 0.25,
                            "extraPosField": "ignored"
                        }),
                    ),
                    p if p == bookmarks_path => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "extraTopLevel": true,
                            "bookmarks": [
                                {
                                    "anchor": {
                                        "format": "pdf",
                                        "pageIndex": 2,
                                        "rects": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1 }]
                                    },
                                    "label": "Valid PDF",
                                    "createdAt": "2026-01-01T00:00:00Z",
                                    "futureEntryField": "ignored"
                                },
                                {
                                    "anchor": {
                                        "format": "cbz",
                                        "panel": 7
                                    },
                                    "label": "Future Format"
                                },
                                {
                                    "anchor": {
                                        "format": "pdf",
                                        "pageIndex": 3,
                                        "rects": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1, "rotation": 90 }]
                                    },
                                    "label": "Unknown NormalizedRect field"
                                },
                                {
                                    "anchor": {
                                        "format": "pdf",
                                        "pageIndex": 4,
                                        "rects": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1 }],
                                        "pageSpans": [{
                                            "pageIndex": 4,
                                            "rects": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1 }],
                                            "futureSpanField": 123
                                        }]
                                    },
                                    "label": "Unknown PdfPageSpan field"
                                },
                                {
                                    "anchor": {
                                        "format": "txt",
                                        "startByteOffset": 10,
                                        "endByteOffset": 20,
                                        "lineIndex": 1
                                    },
                                    "label": "Valid Sibling"
                                }
                            ]
                        }),
                    ),
                    _ => error_response(StatusCode::NOT_FOUND, "lan_not_found", "not found"),
                }
            }
        })
        .await;

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let cancel = CancelToken::never();

        let hello = client.hello(&cancel).await.expect("hello with extra field");
        assert_eq!(hello.protocol, 2);
        assert_eq!(hello.min_protocol, 1);

        let paired = client.pair("123456", &cancel).await.expect("pair");
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        assert_eq!(catalog.books.len(), 1);

        // 204 position -> ParsedPosition::None
        assert_eq!(
            paired.book_position(&sha_204, &cancel).await.expect("204"),
            ParsedPosition::None
        );

        // Future anchor format on /position -> ParsedPosition::Skipped
        assert!(matches!(
            paired
                .book_position(&sha_future_pos, &cancel)
                .await
                .expect("skipped pos"),
            ParsedPosition::Skipped { .. }
        ));

        // Bookmarks: entries 0 and 4 valid; entries 1, 2, 3 skipped individually
        let bookmarks = paired
            .book_bookmarks(&sha_ok, &cancel)
            .await
            .expect("bookmarks");
        assert_eq!(bookmarks.len(), 5);

        assert_eq!(
            bookmarks[0],
            ParsedBookmark::Valid(WireBookmark {
                anchor: AnchorLocation::Pdf {
                    page_index: 2,
                    rects: vec![NormalizedRect {
                        x: 0.1,
                        y: 0.2,
                        width: 0.3,
                        height: 0.1,
                    }],
                    page_spans: None,
                },
                label: Some("Valid PDF".into()),
                created_at: Some("2026-01-01T00:00:00Z".into()),
            })
        );
        assert!(matches!(
            bookmarks[1],
            ParsedBookmark::Skipped { index: 1, .. }
        ));
        assert!(matches!(
            bookmarks[2],
            ParsedBookmark::Skipped { index: 2, .. }
        ));
        assert!(matches!(
            bookmarks[3],
            ParsedBookmark::Skipped { index: 3, .. }
        ));
        assert_eq!(
            bookmarks[4],
            ParsedBookmark::Valid(WireBookmark {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 10,
                    end_byte_offset: 20,
                    line_index: 1,
                },
                label: Some("Valid Sibling".into()),
                created_at: None,
            })
        );

        assert_eq!(
            server.accepts(),
            1,
            "all metadata requests should reuse one keep-alive connection"
        );

        server.stop();
    }

    // Reconnects automatically when server closes an idle connection (`Connection: close`),
    // and maps transport failures to `lan_unreachable` before pairing / `lan_source_stopped` after.
    #[tokio::test]
    async fn pool_reconnects_after_server_close_and_maps_transport_errors() {
        let server = spawn_mock_http_server(|req| async move {
            let mut resp = match req.uri().path() {
                "/v1/hello" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "protocol": 1,
                        "minProtocol": 1,
                        "app": "synapseread"
                    }),
                ),
                "/v1/pair" => json_response(
                    StatusCode::OK,
                    &serde_json::json!({
                        "token": "tok-reconnect",
                        "idleTimeoutSeconds": 600,
                        "permissions": { "positions": true, "bookmarks": true }
                    }),
                ),
                _ => json_response(StatusCode::OK, &serde_json::json!({ "books": [] })),
            };
            resp.headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
            resp
        })
        .await;

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let cancel = CancelToken::never();

        client.hello(&cancel).await.expect("first hello");
        let paired = client.pair("123456", &cancel).await.expect("pair");
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        assert!(catalog.books.is_empty());
        assert_eq!(server.accepts(), 3);

        // Stop server: paired request maps to lan_source_stopped, unpaired to lan_unreachable
        let stopped_addr = server.addr;
        server.stop();
        tokio::time::sleep(Duration::from_millis(20)).await;

        let err_paired = paired
            .catalog(&cancel)
            .await
            .expect_err("stopped server must fail");
        assert_eq!(err_paired.code(), "lan_source_stopped");

        let unpaired = LanClient::from_addr_for_tests(stopped_addr, LanClientConfig::default())
            .expect("client");
        let err_unpaired = unpaired
            .hello(&cancel)
            .await
            .expect_err("unreachable server must fail");
        assert_eq!(err_unpaired.code(), "lan_unreachable");
    }

    // R3-02: Metadata fetch cancellation (plan_import cancellation).
    #[tokio::test]
    async fn r3_02_metadata_fetch_cancellation() {
        let (req_seen_tx, mut req_seen_rx) = mpsc::channel::<()>(2);
        let req_seen_tx = Arc::new(req_seen_tx);

        let server = spawn_mock_http_server(move |req| {
            let req_seen_tx = Arc::clone(&req_seen_tx);
            async move {
                match req.uri().path() {
                    "/v1/pair" => json_response(
                        StatusCode::OK,
                        &serde_json::json!({
                            "token": "tok-meta-cancel",
                            "idleTimeoutSeconds": 600,
                            "permissions": { "positions": true, "bookmarks": true }
                        }),
                    ),
                    _ => {
                        let _ = req_seen_tx.send(()).await;
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        no_content_response()
                    }
                }
            }
        })
        .await;

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let paired = client
            .pair("123456", &CancelToken::never())
            .await
            .expect("pair");

        let (cancel_handle, cancel_token) = CancelHandle::new();
        let trigger = cancel_handle.clone();
        tokio::spawn(async move {
            let _ = req_seen_rx.recv().await;
            trigger.cancel();
        });

        let sha = "a".repeat(64);
        let err = paired
            .book_position(&sha, &cancel_token)
            .await
            .expect_err("metadata fetch must cancel");
        assert_eq!(err.code(), "lan_cancelled");

        server.stop();
    }

    // Protocol version incompatibility check on /v1/hello.
    #[tokio::test]
    async fn hello_rejects_incompatible_protocol_version() {
        let server = spawn_mock_http_server(|_req| async {
            json_response(
                StatusCode::OK,
                &serde_json::json!({
                    "protocol": 3,
                    "minProtocol": 2,
                    "app": "synapseread"
                }),
            )
        })
        .await;

        let client = LanClient::from_addr_for_tests(server.addr, LanClientConfig::default())
            .expect("client");
        let err = client
            .hello(&CancelToken::never())
            .await
            .expect_err("incompatible protocol");
        assert_eq!(err.code(), "lan_protocol_incompatible");

        server.stop();
    }

    // HTTP error code mapping for all ADR 0008 lan_* error codes.
    #[test]
    fn http_error_code_mapping_covers_all_lan_codes() {
        let cases = [
            (
                StatusCode::BAD_REQUEST,
                "lan_protocol_incompatible",
                "lan_protocol_incompatible",
            ),
            (
                StatusCode::UNAUTHORIZED,
                "lan_auth_invalid",
                "lan_auth_invalid",
            ),
            (StatusCode::GONE, "lan_auth_expired", "lan_auth_expired"),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "lan_attempts_exceeded",
                "lan_attempts_exceeded",
            ),
            (StatusCode::CONFLICT, "lan_session_busy", "lan_session_busy"),
            (
                StatusCode::FORBIDDEN,
                "lan_scope_denied",
                "lan_scope_denied",
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "lan_transfer_busy",
                "lan_transfer_busy",
            ),
            (
                StatusCode::CONFLICT,
                "lan_source_changed",
                "lan_source_changed",
            ),
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                "lan_payload_too_large",
                "lan_payload_too_large",
            ),
            (
                StatusCode::BAD_REQUEST,
                "lan_size_mismatch",
                "lan_size_mismatch",
            ),
            (
                StatusCode::BAD_REQUEST,
                "lan_hash_mismatch",
                "lan_hash_mismatch",
            ),
            (
                StatusCode::INSUFFICIENT_STORAGE,
                "lan_disk_full",
                "lan_disk_full",
            ),
            (
                StatusCode::REQUEST_TIMEOUT,
                "lan_cancelled",
                "lan_cancelled",
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "lan_source_stopped",
                "lan_source_stopped",
            ),
            (
                StatusCode::CONFLICT,
                "lan_position_conflict",
                "lan_position_conflict",
            ),
        ];

        for (status, wire_code, expected_code) in cases {
            let body = serde_json::to_vec(&ErrorResponseBody {
                code: wire_code.to_owned(),
                message: "details".to_owned(),
            })
            .expect("json");
            let err = map_http_error(status, &body, true, false);
            assert_eq!(err.code(), expected_code, "wire_code: {wire_code}");
        }

        // Non-JSON 500 fallback: unpaired -> lan_unreachable, paired -> lan_source_stopped
        let err_unpaired = map_http_error(StatusCode::INTERNAL_SERVER_ERROR, b"oops", false, false);
        assert_eq!(err_unpaired.code(), "lan_unreachable");
        let err_paired = map_http_error(StatusCode::INTERNAL_SERVER_ERROR, b"oops", true, false);
        assert_eq!(err_paired.code(), "lan_source_stopped");

        // Status fallback on non-JSON responses
        assert_eq!(
            map_http_error(StatusCode::UNAUTHORIZED, b"", true, false).code(),
            "lan_auth_invalid"
        );
        assert_eq!(
            map_http_error(StatusCode::CONFLICT, b"", false, true).code(),
            "lan_session_busy"
        );
        assert_eq!(
            map_http_error(StatusCode::TOO_MANY_REQUESTS, b"", false, true).code(),
            "lan_attempts_exceeded"
        );
        assert_eq!(
            map_http_error(StatusCode::TOO_MANY_REQUESTS, b"", true, false).code(),
            "lan_transfer_busy"
        );
    }

    // Minimal hyper::body::Body wrapper over mpsc::Receiver so tests need no extra dev-deps.
    struct MpscBody(mpsc::Receiver<Result<Frame<Bytes>, io::Error>>);

    impl hyper::body::Body for MpscBody {
        type Data = Bytes;
        type Error = io::Error;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            self.0.poll_recv(cx)
        }
    }
}
