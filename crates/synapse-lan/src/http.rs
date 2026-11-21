use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Body;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, header};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::error::{LanError, LanResult};
use crate::listener::ConnectionHandler;
use crate::session::{AuthorizedContext, SessionManager, SharePermissions};

/// Wire protocol version served under `/v1` (ADR 0008).
pub const PROTOCOL_VERSION: u32 = 1;
/// Required request header on every `/v1` request (DNS-rebinding defense `S-5`).
pub const PROTOCOL_HEADER: &str = "x-synapseread-protocol";
/// Default HTTP header read timeout (ADR 0008: 10 s).
pub const DEFAULT_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Default HTTP POST body read timeout (prevents slow-body connection slot
/// starvation across the 4-connection cap, `T-04` / `T-11`).
pub const DEFAULT_BODY_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Default HTTP/1.1 header buffer cap (ADR 0008: 8 KiB).
pub const MAX_HEADER_BYTES: usize = 8 * 1024;
/// Default POST request body cap (ADR 0008: 4 KiB).
pub const MAX_POST_BODY_BYTES: usize = 4 * 1024;
/// Upper bound on HTTP header count per request.
pub const MAX_REQUEST_HEADERS: usize = 64;

const MAX_BEARER_TOKEN_LEN: usize = 128;

/// Boxed HTTP response body supporting both in-memory JSON and streaming file
/// responses (`#141`).
pub type LanBoxBody = BoxBody<Bytes, std::io::Error>;
/// Standard HTTP response type for all `/v1` endpoints.
pub type LanResponse = Response<LanBoxBody>;

/// Hardening configuration for [`LanHttpHandler`].
#[derive(Debug, Clone, Copy)]
pub struct HttpServerConfig {
    pub header_read_timeout: Duration,
    pub body_read_timeout: Duration,
    pub max_header_bytes: usize,
    pub max_post_body_bytes: usize,
}

impl Default for HttpServerConfig {
    fn default() -> Self {
        Self {
            header_read_timeout: DEFAULT_HEADER_READ_TIMEOUT,
            body_read_timeout: DEFAULT_BODY_READ_TIMEOUT,
            max_header_bytes: MAX_HEADER_BYTES,
            max_post_body_bytes: MAX_POST_BODY_BYTES,
        }
    }
}

/// Wire error body returned on HTTP 4xx/5xx responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponseBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloResponse {
    protocol: u32,
    min_protocol: u32,
    app: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
}

impl std::fmt::Debug for PairRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairRequest")
            .field("code", &"[REDACTED]")
            .finish()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
    idle_timeout_seconds: u64,
    permissions: SharePermissions,
}

impl std::fmt::Debug for PairResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairResponse")
            .field("token", &"[REDACTED]")
            .field("idle_timeout_seconds", &self.idle_timeout_seconds)
            .field("permissions", &self.permissions)
            .finish()
    }
}

/// Extension hook for authenticated `/v1` data endpoints (`/catalog`,
/// `/books/{sha256}/{file,position,bookmarks}`), implemented in `#141`.
///
/// Request guards (`Host`, `X-SynapseRead-Protocol`, query rejection,
/// `Authorization: Bearer`, peer-IP binding, `sha256` format validation,
/// `Cache-Control: no-store`, and zero CORS headers) are enforced centrally
/// before any method on this trait is invoked.
pub trait SourceApiHandler: Send + Sync + 'static {
    fn catalog(
        &self,
        auth: AuthorizedContext,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>>;

    fn book_file(
        &self,
        auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>>;

    fn book_position(
        &self,
        auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>>;

    fn book_bookmarks(
        &self,
        auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>>;
}

/// Default placeholder [`SourceApiHandler`] returning `501 Not Implemented`
/// until `#141` wires the SQLite-backed source endpoints.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnimplementedSourceApiHandler;

impl SourceApiHandler for UnimplementedSourceApiHandler {
    fn catalog(
        &self,
        _auth: AuthorizedContext,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async {
            error_response(
                StatusCode::NOT_IMPLEMENTED,
                "lan_not_implemented",
                "catalog endpoint not configured",
            )
        })
    }

    fn book_file(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async {
            error_response(
                StatusCode::NOT_IMPLEMENTED,
                "lan_not_implemented",
                "book file endpoint not configured",
            )
        })
    }

    fn book_position(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async {
            error_response(
                StatusCode::NOT_IMPLEMENTED,
                "lan_not_implemented",
                "book position endpoint not configured",
            )
        })
    }

    fn book_bookmarks(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async {
            error_response(
                StatusCode::NOT_IMPLEMENTED,
                "lan_not_implemented",
                "book bookmarks endpoint not configured",
            )
        })
    }
}

/// Hardened HTTP/1.1 connection handler with keep-alive, request guards,
/// pairing/session endpoints, and pluggable [`SourceApiHandler`].
pub struct LanHttpHandler<A = UnimplementedSourceApiHandler> {
    expected_host: Arc<str>,
    session: Arc<SessionManager>,
    api: Arc<A>,
    config: HttpServerConfig,
}

impl<A: SourceApiHandler> LanHttpHandler<A> {
    pub fn new(
        bound_addr: SocketAddrV4,
        session: Arc<SessionManager>,
        api: Arc<A>,
        config: HttpServerConfig,
    ) -> Self {
        Self {
            expected_host: Arc::from(bound_addr.to_string()),
            session,
            api,
            config,
        }
    }

    /// Routes a single HTTP request through all guards and endpoints.
    pub async fn route_request<B>(
        &self,
        req: Request<B>,
        peer_ip: Ipv4Addr,
        post_response_stop: &AtomicBool,
    ) -> LanResponse
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: std::fmt::Display,
    {
        let resp = route_request_inner(
            req,
            peer_ip,
            &self.expected_host,
            &self.session,
            self.api.as_ref(),
            self.config.max_post_body_bytes,
            self.config.body_read_timeout,
            post_response_stop,
        )
        .await;
        finalize_response(resp)
    }
}

impl<A: SourceApiHandler> ConnectionHandler for LanHttpHandler<A> {
    fn handle(
        &self,
        stream: TcpStream,
        peer_addr: SocketAddr,
        mut shutdown: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let expected_host = Arc::clone(&self.expected_host);
        let session = Arc::clone(&self.session);
        let api = Arc::clone(&self.api);
        let config = self.config;

        Box::pin(async move {
            let IpAddr::V4(peer_ip) = peer_addr.ip() else {
                // Defense-in-depth: PeerPolicy already drops non-IPv4 sockets.
                return;
            };

            let post_response_stop = Arc::new(AtomicBool::new(false));
            let service = {
                let expected_host = Arc::clone(&expected_host);
                let session = Arc::clone(&session);
                let api = Arc::clone(&api);
                let post_response_stop = Arc::clone(&post_response_stop);
                service_fn(move |req: Request<hyper::body::Incoming>| {
                    let expected_host = Arc::clone(&expected_host);
                    let session = Arc::clone(&session);
                    let api = Arc::clone(&api);
                    let post_response_stop = Arc::clone(&post_response_stop);
                    async move {
                        let resp = route_request_inner(
                            req,
                            peer_ip,
                            &expected_host,
                            &session,
                            api.as_ref(),
                            config.max_post_body_bytes,
                            config.body_read_timeout,
                            &post_response_stop,
                        )
                        .await;
                        Ok::<_, Infallible>(finalize_response(resp))
                    }
                })
            };

            let io = TokioIo::new(stream);
            // hyper requires max_buf_size >= 8192 bytes; set max_header_size
            // explicitly so every request (including reused keep-alive requests
            // and chunked trailers) is strictly capped at `max_header_bytes`.
            let max_buf_size = config.max_header_bytes.max(8 * 1024);
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .keep_alive(true)
                .header_read_timeout(config.header_read_timeout)
                .max_buf_size(max_buf_size)
                .max_header_size(config.max_header_bytes)
                .max_headers(MAX_REQUEST_HEADERS)
                .serve_connection(io, service);
            tokio::pin!(conn);

            tokio::select! {
                biased;
                () = wait_for_shutdown(&mut shutdown) => {}
                _ = &mut conn => {}
            }

            if post_response_stop.load(Ordering::Acquire) {
                session.notify_listener_session_ended();
            }
        })
    }
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    while shutdown.changed().await.is_ok() {
        if *shutdown.borrow() {
            return;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Hello,
    Pair,
    SessionEnd,
    Catalog,
    BookFile(String),
    BookPosition(String),
    BookBookmarks(String),
}

fn match_route(path: &str) -> Option<Route> {
    match path {
        "/v1/hello" => Some(Route::Hello),
        "/v1/pair" => Some(Route::Pair),
        "/v1/session/end" => Some(Route::SessionEnd),
        "/v1/catalog" => Some(Route::Catalog),
        _ => {
            let rest = path.strip_prefix("/v1/books/")?;
            let (sha256, leaf) = rest.split_once('/')?;
            if !is_valid_sha256_hex(sha256) {
                return None;
            }
            match leaf {
                "file" => Some(Route::BookFile(sha256.to_owned())),
                "position" => Some(Route::BookPosition(sha256.to_owned())),
                "bookmarks" => Some(Route::BookBookmarks(sha256.to_owned())),
                _ => None,
            }
        }
    }
}

/// Validates a 64-character lowercase hexadecimal SHA-256 string.
pub fn is_valid_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[allow(clippy::too_many_arguments)]
async fn route_request_inner<B, A>(
    req: Request<B>,
    peer_ip: Ipv4Addr,
    expected_host: &str,
    session: &Arc<SessionManager>,
    api: &A,
    max_post_body_bytes: usize,
    body_read_timeout: Duration,
    post_response_stop: &AtomicBool,
) -> LanResponse
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display,
    A: SourceApiHandler,
{
    if let Some(resp) = check_host_header(&req, expected_host) {
        return resp;
    }
    if let Some(resp) = check_protocol_header(&req) {
        return resp;
    }
    if req.uri().query().is_some() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "lan_auth_invalid",
            "query parameters are not permitted",
        );
    }

    let Some(route) = match_route(req.uri().path()) else {
        return error_response(StatusCode::NOT_FOUND, "lan_not_found", "unknown endpoint");
    };

    let expected_method = match &route {
        Route::Hello
        | Route::Catalog
        | Route::BookFile(_)
        | Route::BookPosition(_)
        | Route::BookBookmarks(_) => Method::GET,
        Route::Pair | Route::SessionEnd => Method::POST,
    };

    if req.method() != expected_method {
        let mut resp = error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "lan_method_not_allowed",
            "method not allowed",
        );
        if let Ok(val) = header::HeaderValue::from_str(expected_method.as_str()) {
            resp.headers_mut().insert(header::ALLOW, val);
        }
        return resp;
    }

    if expected_method == Method::POST
        && let Some(resp) = check_json_content_type(&req)
    {
        return resp;
    }

    match route {
        Route::Hello => json_response(
            StatusCode::OK,
            &HelloResponse {
                protocol: PROTOCOL_VERSION,
                min_protocol: PROTOCOL_VERSION,
                app: "synapseread",
            },
        ),
        Route::Pair => {
            let body = match read_bounded_body(req, max_post_body_bytes, body_read_timeout).await {
                Ok(bytes) => bytes,
                Err(err) => return lan_error_response(&err),
            };
            let parsed: PairRequest = match serde_json::from_slice(&body) {
                Ok(parsed) => parsed,
                Err(_) => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "lan_auth_invalid",
                        "invalid pairing request body",
                    );
                }
            };
            match session.pair(peer_ip, &parsed.code) {
                Ok(outcome) => json_response(
                    StatusCode::OK,
                    &PairResponse {
                        token: outcome.token.expose().to_owned(),
                        idle_timeout_seconds: outcome.idle_timeout_seconds,
                        permissions: outcome.permissions,
                    },
                ),
                Err(err) => lan_error_response(&err),
            }
        }
        Route::SessionEnd => {
            let token = match extract_bearer_token(&req) {
                Ok(token) => token,
                Err(err) => return lan_error_response(&err),
            };
            if let Err(err) = session.authenticate(peer_ip, &token) {
                return lan_error_response(&err);
            }
            if let Err(err) = read_bounded_body(req, max_post_body_bytes, body_read_timeout).await {
                return lan_error_response(&err);
            }
            session.revoke_local();
            post_response_stop.store(true, Ordering::Release);
            let mut resp = no_content_response();
            resp.headers_mut().insert(
                header::CONNECTION,
                header::HeaderValue::from_static("close"),
            );
            resp
        }
        Route::Catalog => {
            let auth = match authenticate_request(&req, peer_ip, session) {
                Ok(auth) => auth,
                Err(err) => return lan_error_response(&err),
            };
            api.catalog(auth, Arc::clone(session)).await
        }
        Route::BookFile(sha256) => {
            let auth = match authenticate_request(&req, peer_ip, session) {
                Ok(auth) => auth,
                Err(err) => return lan_error_response(&err),
            };
            api.book_file(auth, sha256, Arc::clone(session)).await
        }
        Route::BookPosition(sha256) => {
            let auth = match authenticate_request(&req, peer_ip, session) {
                Ok(auth) => auth,
                Err(err) => return lan_error_response(&err),
            };
            api.book_position(auth, sha256, Arc::clone(session)).await
        }
        Route::BookBookmarks(sha256) => {
            let auth = match authenticate_request(&req, peer_ip, session) {
                Ok(auth) => auth,
                Err(err) => return lan_error_response(&err),
            };
            api.book_bookmarks(auth, sha256, Arc::clone(session)).await
        }
    }
}

fn check_host_header<B>(req: &Request<B>, expected_host: &str) -> Option<LanResponse> {
    let mut hosts = req.headers().get_all(header::HOST).iter();
    let Some(first) = hosts.next() else {
        return Some(error_response(
            StatusCode::FORBIDDEN,
            "lan_auth_invalid",
            "missing Host header",
        ));
    };
    if hosts.next().is_some() {
        return Some(error_response(
            StatusCode::FORBIDDEN,
            "lan_auth_invalid",
            "duplicate Host header",
        ));
    }
    match first.to_str() {
        Ok(value) if value == expected_host => None,
        _ => Some(error_response(
            StatusCode::FORBIDDEN,
            "lan_auth_invalid",
            "Host header does not match bound LAN address",
        )),
    }
}

fn check_protocol_header<B>(req: &Request<B>) -> Option<LanResponse> {
    let mut headers = req.headers().get_all(PROTOCOL_HEADER).iter();
    let Some(first) = headers.next() else {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "lan_protocol_incompatible",
            "missing X-SynapseRead-Protocol header",
        ));
    };
    if headers.next().is_some() {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "lan_protocol_incompatible",
            "duplicate X-SynapseRead-Protocol header",
        ));
    }
    match first.to_str() {
        Ok("1") => None,
        _ => Some(error_response(
            StatusCode::BAD_REQUEST,
            "lan_protocol_incompatible",
            "unsupported X-SynapseRead-Protocol version",
        )),
    }
}

fn check_json_content_type<B>(req: &Request<B>) -> Option<LanResponse> {
    let mut values = req.headers().get_all(header::CONTENT_TYPE).iter();
    let Some(first) = values.next() else {
        return Some(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "lan_protocol_incompatible",
            "POST requests require Content-Type: application/json",
        ));
    };
    if values.next().is_some() {
        return Some(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "lan_protocol_incompatible",
            "duplicate Content-Type header",
        ));
    }
    let Ok(raw) = first.to_str() else {
        return Some(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "lan_protocol_incompatible",
            "invalid Content-Type header",
        ));
    };
    let media_type = raw.split(';').next().unwrap_or("").trim();
    if media_type.eq_ignore_ascii_case("application/json") {
        None
    } else {
        Some(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "lan_protocol_incompatible",
            "POST requests require Content-Type: application/json",
        ))
    }
}

fn extract_bearer_token<B>(req: &Request<B>) -> LanResult<String> {
    let mut values = req.headers().get_all(header::AUTHORIZATION).iter();
    let Some(first) = values.next() else {
        return Err(LanError::AuthInvalid);
    };
    if values.next().is_some() {
        return Err(LanError::AuthInvalid);
    }
    let raw = first.to_str().map_err(|_| LanError::AuthInvalid)?;
    let token = raw.strip_prefix("Bearer ").ok_or(LanError::AuthInvalid)?;
    if token.is_empty()
        || token.len() > MAX_BEARER_TOKEN_LEN
        || token
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(LanError::AuthInvalid);
    }
    Ok(token.to_owned())
}

fn authenticate_request<B>(
    req: &Request<B>,
    peer_ip: Ipv4Addr,
    session: &SessionManager,
) -> LanResult<AuthorizedContext> {
    let token = extract_bearer_token(req)?;
    session.authenticate(peer_ip, &token)
}

async fn read_bounded_body<B>(
    req: Request<B>,
    max_bytes: usize,
    read_timeout: Duration,
) -> LanResult<Vec<u8>>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display,
{
    if let Some(len_header) = req.headers().get(header::CONTENT_LENGTH)
        && let Ok(len_str) = len_header.to_str()
        && let Ok(declared_len) = len_str.trim().parse::<u64>()
        && declared_len > max_bytes as u64
    {
        return Err(LanError::PayloadTooLarge(format!(
            "request body exceeds {max_bytes} bytes"
        )));
    }

    let body = req.into_body();
    tokio::pin!(body);
    let read_fut = async move {
        let mut buf = Vec::new();
        while let Some(frame_res) = body.frame().await {
            let frame = frame_res.map_err(|_| {
                LanError::PayloadTooLarge("failed to read HTTP request body".into())
            })?;
            if let Some(data) = frame.data_ref() {
                if buf.len().saturating_add(data.len()) > max_bytes {
                    return Err(LanError::PayloadTooLarge(format!(
                        "request body exceeds {max_bytes} bytes"
                    )));
                }
                buf.extend_from_slice(data);
            }
        }
        Ok(buf)
    };

    tokio::time::timeout(read_timeout, read_fut)
        .await
        .map_err(|_| LanError::Cancelled)?
}

/// Constructs an empty [`LanBoxBody`].
pub fn empty_body() -> LanBoxBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Constructs a complete in-memory [`LanBoxBody`].
pub fn full_body(bytes: impl Into<Bytes>) -> LanBoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

/// Builds a `204 No Content` response with `Cache-Control: no-store`.
pub fn no_content_response() -> LanResponse {
    let mut resp = Response::new(empty_body());
    *resp.status_mut() = StatusCode::NO_CONTENT;
    finalize_response(resp)
}

/// Serializes `value` as JSON with `Cache-Control: no-store`.
pub fn json_response<T: Serialize>(status: StatusCode, value: &T) -> LanResponse {
    let bytes = match serde_json::to_vec(value) {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "lan_internal_error",
                "failed to serialize response",
            );
        }
    };
    let mut resp = Response::new(full_body(bytes));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    finalize_response(resp)
}

/// Builds a JSON error response with a stable machine-readable code.
pub fn error_response(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> LanResponse {
    let payload = ErrorResponseBody {
        code: code.to_owned(),
        message: message.into(),
    };
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| {
        b"{\"code\":\"lan_internal_error\",\"message\":\"internal error\"}".to_vec()
    });
    let mut resp = Response::new(full_body(bytes));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    finalize_response(resp)
}

/// Maps a [`LanError`] to its canonical ADR 0008 HTTP status code and JSON
/// error body without ever leaking secret tokens or pairing codes.
pub fn lan_error_response(err: &LanError) -> LanResponse {
    let status = match err {
        LanError::AuthInvalid => StatusCode::UNAUTHORIZED,
        LanError::AuthExpired => StatusCode::GONE,
        LanError::AttemptsExceeded => StatusCode::TOO_MANY_REQUESTS,
        LanError::SessionBusy => StatusCode::CONFLICT,
        LanError::ScopeDenied(_) => StatusCode::FORBIDDEN,
        LanError::TransferBusy => StatusCode::TOO_MANY_REQUESTS,
        LanError::SourceChanged(_) => StatusCode::CONFLICT,
        LanError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
        LanError::ProtocolIncompatible(_) => StatusCode::BAD_REQUEST,
        LanError::Cancelled => StatusCode::REQUEST_TIMEOUT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let mut resp = error_response(status, err.code(), err.to_string());
    if matches!(err, LanError::Cancelled | LanError::PayloadTooLarge(_)) {
        // Close stalled or oversized-body connections immediately so they
        // cannot hold listener connection slots (`T-04` / `T-11`).
        resp.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
    }
    resp
}

/// Guarantees every response carries `Cache-Control: no-store` and zero CORS
/// headers (`S-5`, `T-04`).
pub fn finalize_response(mut resp: LanResponse) -> LanResponse {
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    let cors_keys: Vec<header::HeaderName> = resp
        .headers()
        .keys()
        .filter(|name| name.as_str().starts_with("access-control-"))
        .cloned()
        .collect();
    for key in cors_keys {
        resp.headers_mut().remove(key);
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::address::{AddressPolicy, InterfaceProvider, PeerPolicy, RawInterface};
    use crate::bind::{BoundListener, bind_auto_for_tests};
    use crate::listener::{
        LanListener, LanListenerHandle, ListenerConfig, ListenerStopReason, TokioMonotonicClock,
    };
    use crate::session::{SessionConfig, SnapshotBook};

    struct StaticInterfaceProvider(Vec<RawInterface>);

    impl InterfaceProvider for StaticInterfaceProvider {
        fn list_interfaces(&self) -> LanResult<Vec<RawInterface>> {
            Ok(self.0.clone())
        }
    }

    struct MockSourceApi {
        catalog_hits: AtomicU64,
    }

    impl MockSourceApi {
        fn new() -> Self {
            Self {
                catalog_hits: AtomicU64::new(0),
            }
        }
    }

    impl SourceApiHandler for MockSourceApi {
        fn catalog(
            &self,
            _auth: AuthorizedContext,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
            let count = self.catalog_hits.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move {
                let mut resp = json_response(
                    StatusCode::OK,
                    &serde_json::json!({ "books": [], "hits": count }),
                );
                // Deliberately insert a CORS header to prove finalize_response strips it.
                resp.headers_mut().insert(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    header::HeaderValue::from_static("*"),
                );
                resp
            })
        }

        fn book_file(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async { no_content_response() })
        }

        fn book_position(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async { no_content_response() })
        }

        fn book_bookmarks(
            &self,
            _auth: AuthorizedContext,
            _sha256: String,
            _session: Arc<SessionManager>,
        ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
            Box::pin(async { no_content_response() })
        }
    }

    fn loopback_raw_iface() -> RawInterface {
        RawInterface {
            name: "lo0".into(),
            ip: Ipv4Addr::LOCALHOST,
            netmask: Ipv4Addr::new(255, 0, 0, 0),
            prefix_len: 8,
            is_up: true,
            is_loopback: true,
            is_broadcast: false,
            is_point_to_point: false,
        }
    }

    fn bind_ephemeral_loopback() -> BoundListener {
        let probe = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("probe port");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);
        bind_auto_for_tests(
            Ipv4Addr::LOCALHOST,
            port..=port.saturating_add(10),
            AddressPolicy::loopback_for_tests(),
        )
        .expect("bind loopback")
    }

    fn start_test_server(
        session_config: SessionConfig,
        http_config: HttpServerConfig,
    ) -> (
        SocketAddrV4,
        Arc<SessionManager>,
        crate::session::PairingCode,
        LanListenerHandle,
    ) {
        let bound = bind_ephemeral_loopback();
        let addr = bound.local_addr;
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            session_config,
            clock.clone(),
            SharePermissions {
                positions: true,
                bookmarks: true,
            },
            vec![SnapshotBook {
                document_id: "doc-1".into(),
                snapshot_file_hash: "a".repeat(64),
            }],
        )
        .expect("session");
        let session = Arc::new(session);
        let api = Arc::new(MockSourceApi::new());
        let handler = Arc::new(LanHttpHandler::new(
            addr,
            Arc::clone(&session),
            api,
            http_config,
        ));
        let handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            Arc::new(StaticInterfaceProvider(vec![loopback_raw_iface()])),
            clock,
            ListenerConfig {
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            handler,
        );
        session.attach_listener(handle.control());
        (addr, session, code, handle)
    }

    async fn send_http_close(addr: SocketAddrV4, raw: &[u8]) -> String {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(raw).await.expect("write");
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    async fn send_raw(addr: SocketAddrV4, raw: &[u8]) -> String {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(raw).await.expect("write");
        let _ = stream.shutdown().await;
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    async fn read_one_http_response(stream: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await.expect("read");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers_str = String::from_utf8_lossy(&buf[..header_end]);
                let content_len = headers_str
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        if k.eq_ignore_ascii_case("content-length") {
                            v.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                if buf.len() >= header_end + 4 + content_len {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    // T-04: Request guards block wrong/duplicate Host, missing protocol header,
    // wrong content-type, oversized POST body, zero CORS headers, always Cache-Control: no-store.
    #[tokio::test]
    async fn t04_request_guards_and_security_headers() {
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), HttpServerConfig::default());

        // 1. Valid GET /v1/hello succeeds with Cache-Control: no-store and no CORS.
        let resp = send_http_close(
            addr,
            format!(
                "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "resp: {resp}");
        assert!(
            resp.to_ascii_lowercase()
                .contains("cache-control: no-store")
        );
        assert!(!resp.to_ascii_lowercase().contains("access-control-"));
        assert!(resp.contains("\"app\":\"synapseread\""));

        // 2. Wrong Host header (DNS rebinding) -> 403.
        let resp = send_http_close(
            addr,
            b"GET /v1/hello HTTP/1.1\r\nHost: evil.example:49319\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 403"), "resp: {resp}");
        assert!(
            resp.to_ascii_lowercase()
                .contains("cache-control: no-store")
        );

        // 3. Duplicate Host header -> 403 or 400 (hyper or guard rejects).
        let resp = send_http_close(
            addr,
            format!(
                "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(
            resp.starts_with("HTTP/1.1 400") || resp.starts_with("HTTP/1.1 403"),
            "resp: {resp}"
        );

        // 4. Missing X-SynapseRead-Protocol -> 400 lan_protocol_incompatible.
        let resp = send_http_close(
            addr,
            format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 400"), "resp: {resp}");
        assert!(resp.contains("lan_protocol_incompatible"));

        // 5. POST /v1/pair with wrong Content-Type -> 415.
        let resp = send_http_close(
            addr,
            format!(
                "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: text/plain\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{{\"code\":\"123456\"}}"
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 415"), "resp: {resp}");

        // 6. POST /v1/pair exceeding 4 KiB -> 413 lan_payload_too_large.
        let big_body = "x".repeat(MAX_POST_BODY_BYTES + 1);
        let resp = send_http_close(
            addr,
            format!(
                "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                big_body.len(),
                big_body
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 413"), "resp: {resp}");
        assert!(resp.contains("lan_payload_too_large"));

        // 7. Unknown route -> 404, wrong method -> 405 (no CORS).
        let resp = send_http_close(
            addr,
            format!(
                "GET /v1/unknown HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 404"), "resp: {resp}");

        let resp = send_http_close(
            addr,
            format!(
                "OPTIONS /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 405"), "resp: {resp}");
        assert!(!resp.to_ascii_lowercase().contains("access-control-"));

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-01, T-03, R3-02: Pair over loopback, reject token in URL, reuse HTTP/1.1
    // keep-alive connection for multiple authenticated requests, and end session.
    #[tokio::test]
    async fn loopback_pair_keep_alive_reuse_token_in_header_only_and_session_end() {
        let (addr, _session, code, mut handle) =
            start_test_server(SessionConfig::default(), HttpServerConfig::default());

        let mut stream = TcpStream::connect(addr).await.expect("connect");

        // 1. Pair over keep-alive connection.
        let pair_body = format!("{{\"code\":\"{}\"}}", code.expose());
        let pair_req = format!(
            "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{pair_body}",
            pair_body.len()
        );
        stream.write_all(pair_req.as_bytes()).await.expect("write");
        let pair_resp = read_one_http_response(&mut stream).await;
        assert!(pair_resp.starts_with("HTTP/1.1 200"), "resp: {pair_resp}");
        let (_, json_str) = pair_resp.split_once("\r\n\r\n").expect("body");
        let parsed: serde_json::Value = serde_json::from_str(json_str).expect("json");
        let token = parsed["token"].as_str().expect("token").to_owned();

        // 2. Token in URL query string is rejected (T-03) on the SAME connection.
        let url_token_req = format!(
            "GET /v1/catalog?token={token} HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\n\r\n"
        );
        stream
            .write_all(url_token_req.as_bytes())
            .await
            .expect("write");
        let resp = read_one_http_response(&mut stream).await;
        assert!(resp.starts_with("HTTP/1.1 400"), "resp: {resp}");
        assert!(!resp.contains(&token));

        // 3. Multiple authenticated requests reuse the SAME keep-alive TCP socket (R3-02)
        //    and finalize_response strips CORS headers emitted by handlers.
        for expected_hit in 1..=3 {
            let cat_req = format!(
                "GET /v1/catalog HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nAuthorization: Bearer {token}\r\n\r\n"
            );
            stream.write_all(cat_req.as_bytes()).await.expect("write");
            let resp = read_one_http_response(&mut stream).await;
            assert!(resp.starts_with("HTTP/1.1 200"), "resp: {resp}");
            assert!(!resp.to_ascii_lowercase().contains("access-control-"));
            assert!(
                resp.to_ascii_lowercase()
                    .contains("cache-control: no-store")
            );
            assert!(resp.contains(&format!("\"hits\":{expected_hit}")));
        }

        // 4. POST /v1/session/end returns 204 and stops the listener cleanly.
        let end_req = format!(
            "POST /v1/session/end HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        stream.write_all(end_req.as_bytes()).await.expect("write");
        let end_resp = read_one_http_response(&mut stream).await;
        assert!(end_resp.starts_with("HTTP/1.1 204"), "resp: {end_resp}");

        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::SessionEnded
        );
    }

    // T-04: Slow header read timeout closes stalled connection cleanly.
    #[tokio::test]
    async fn t04_slow_header_read_times_out() {
        let http_config = HttpServerConfig {
            header_read_timeout: Duration::from_millis(120),
            ..HttpServerConfig::default()
        };
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), http_config);

        let mut slow = TcpStream::connect(addr).await.expect("connect");
        slow.write_all(b"GET /v1/hello HTTP/1.1\r\nHost: ")
            .await
            .expect("partial write");

        let mut buf = [0u8; 64];
        let read_res = tokio::time::timeout(Duration::from_secs(2), slow.read(&mut buf))
            .await
            .expect("must close within timeout");
        assert!(
            matches!(read_res, Ok(0) | Err(_)),
            "slow header connection must be closed by server: {read_res:?}"
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-01 (loopback): 5 failed attempts lock the code while keeping the
    // listener alive (OD-5 / R3-09); regenerate unlocks and pairs; second pair
    // returns 409 lan_session_busy.
    #[tokio::test]
    async fn t01_loopback_five_failures_lock_then_regenerate_and_pair() {
        let session_config = SessionConfig {
            per_ip_max_attempts: 10, // test 5-failure global lock over loopback
            ..SessionConfig::default()
        };
        let (addr, session, code1, mut handle) =
            start_test_server(session_config, HttpServerConfig::default());

        let wrong = if code1.expose() == "000000" {
            "000001"
        } else {
            "000000"
        };

        for attempt in 1..=5 {
            let body = format!("{{\"code\":\"{wrong}\"}}");
            let resp = send_http_close(
                addr,
                format!(
                    "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
            if attempt < 5 {
                assert!(
                    resp.starts_with("HTTP/1.1 401"),
                    "attempt {attempt}: {resp}"
                );
                assert!(resp.contains("lan_auth_invalid"));
            } else {
                assert!(resp.starts_with("HTTP/1.1 429"), "attempt 5: {resp}");
                assert!(resp.contains("lan_attempts_exceeded"));
            }
        }

        // Listener MUST remain alive in CodeLocked (OD-5).
        assert_eq!(session.status(), crate::session::SessionStatus::CodeLocked);
        assert_eq!(handle.stop_reason(), None);

        // Regenerate unlocks and allows pairing.
        let code2 = session.regenerate_code().expect("regenerate");
        let body = format!("{{\"code\":\"{}\"}}", code2.expose());
        let resp = send_http_close(
            addr,
            format!(
                "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "pair after regen: {resp}");

        // Second receiver / reuse returns 409 lan_session_busy.
        let resp = send_http_close(
            addr,
            format!(
                "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 409"), "busy: {resp}");
        assert!(resp.contains("lan_session_busy"));

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-04: Chunked POST body without Content-Length exceeding 4 KiB -> 413.
    #[tokio::test]
    async fn t04_chunked_oversized_post_body_rejected() {
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), HttpServerConfig::default());

        let chunk_payload = "a".repeat(MAX_POST_BODY_BYTES + 16);
        let req = format!(
            "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{chunk_payload}\r\n0\r\n\r\n",
            chunk_payload.len()
        );
        let resp = send_http_close(addr, req.as_bytes()).await;
        assert!(resp.starts_with("HTTP/1.1 413"), "chunked 413: {resp}");
        assert!(resp.contains("lan_payload_too_large"));

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // R3-02: Idle keep-alive connection closes after timeout so it cannot
    // starve the 4-connection cap.
    #[tokio::test]
    async fn r3_02_idle_keep_alive_connection_closes_after_timeout() {
        let http_config = HttpServerConfig {
            header_read_timeout: Duration::from_millis(120),
            ..HttpServerConfig::default()
        };
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), http_config);

        let mut stream = TcpStream::connect(addr).await.expect("connect");
        let req =
            format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\n\r\n");
        stream.write_all(req.as_bytes()).await.expect("write");
        let resp = read_one_http_response(&mut stream).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "resp: {resp}");

        // Now stay completely idle on the keep-alive socket; server must close it.
        let mut buf = [0u8; 64];
        let read_res = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf))
            .await
            .expect("idle keep-alive must close within timeout");
        assert!(
            matches!(read_res, Ok(0) | Err(_)),
            "idle keep-alive connection must close: {read_res:?}"
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-02: Active transfer defers listener idle timeout; revoke() stops listener
    // and aborts the active transfer immediately.
    #[tokio::test(start_paused = true)]
    async fn t02_active_transfer_defers_listener_idle_timeout_and_revoke_stops() {
        let (_addr, session, code, mut handle) =
            start_test_server(SessionConfig::default(), HttpServerConfig::default());

        let _outcome = session
            .pair(Ipv4Addr::LOCALHOST, code.expose())
            .expect("pair");
        tokio::task::yield_now().await;

        let guard = session.acquire_transfer().expect("transfer");
        tokio::task::yield_now().await;

        // Advance well past 10m idle timeout while transfer is active -> stays alive.
        tokio::time::advance(Duration::from_secs(900)).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.stop_reason(), None);
        assert!(!guard.is_aborted());

        // Revoke (source Disconnect) aborts transfer and stops listener cleanly.
        session.revoke();
        assert!(guard.is_aborted());
        drop(guard);

        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::SessionEnded
        );
    }

    // T-03: PairRequest and PairResponse Debug impls must redact raw credentials
    // while PairResponse JSON preserves the /v1/pair wire contract.
    #[test]
    fn t03_pair_http_dtos_redact_credentials_in_debug() {
        let req = PairRequest {
            code: "842913".into(),
        };
        let req_dbg = format!("{req:?}");
        assert!(
            !req_dbg.contains("842913"),
            "leaked code in Debug: {req_dbg}"
        );
        assert!(req_dbg.contains("[REDACTED]"));

        let resp = PairResponse {
            token: "secret-bearer-token-value-1234567890".into(),
            idle_timeout_seconds: 600,
            permissions: SharePermissions {
                positions: true,
                bookmarks: false,
            },
        };
        let resp_dbg = format!("{resp:?}");
        assert!(
            !resp_dbg.contains("secret-bearer-token-value-1234567890"),
            "leaked token in Debug: {resp_dbg}"
        );
        assert!(resp_dbg.contains("[REDACTED]"));

        let json: serde_json::Value = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(json["token"], "secret-bearer-token-value-1234567890");
        assert_eq!(json["idleTimeoutSeconds"], 600);
        assert_eq!(json["permissions"]["positions"], true);
        assert_eq!(json["permissions"]["bookmarks"], false);
    }

    // T-04 / T-11: Slow/incomplete POST bodies time out and release all 4
    // listener connection slots so subsequent requests succeed.
    #[tokio::test]
    async fn t04_slow_post_body_times_out_and_releases_connection_slots() {
        let http_config = HttpServerConfig {
            header_read_timeout: Duration::from_secs(10),
            body_read_timeout: Duration::from_millis(120),
            ..HttpServerConfig::default()
        };
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), http_config);

        // Occupy all 4 connection slots with complete headers + stalled partial
        // POST bodies (within the 4 KiB cap).
        let mut stalled_streams = Vec::with_capacity(4);
        for _ in 0..4 {
            let mut stream = TcpStream::connect(addr).await.expect("connect");
            let partial = format!(
                "POST /v1/pair HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: 32\r\n\r\n{{\"co"
            );
            stream
                .write_all(partial.as_bytes())
                .await
                .expect("write partial post");
            stalled_streams.push(stream);
        }

        // Every stalled POST must time out with 408 and close the connection.
        for mut stream in stalled_streams {
            let mut resp = Vec::new();
            let read_res =
                tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut resp))
                    .await
                    .expect("slow body must time out and close");
            if let Err(err) = read_res {
                assert!(
                    matches!(
                        err.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::UnexpectedEof
                    ),
                    "unexpected read error after 408: {err}"
                );
            }
            let resp_str = String::from_utf8_lossy(&resp);
            assert!(
                resp_str.starts_with("HTTP/1.1 408"),
                "expected 408 Request Timeout, got: {resp_str}"
            );
            assert!(resp_str.contains("lan_cancelled"));
        }

        // Connection slots must now be free for a fresh request.
        let health = send_http_close(
            addr,
            format!(
                "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(health.starts_with("HTTP/1.1 200"), "health: {health}");

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-02: Listener termination via Stop, Shutdown, or NetworkChanged must
    // synchronously revoke SessionManager to Off, abort active transfers, and
    // invalidate previously issued bearer tokens.
    #[tokio::test(start_paused = true)]
    async fn t02_listener_stop_shutdown_and_network_change_revoke_session() {
        struct MutableInterfaceProvider(std::sync::Mutex<Vec<RawInterface>>);
        impl InterfaceProvider for MutableInterfaceProvider {
            fn list_interfaces(&self) -> LanResult<Vec<RawInterface>> {
                Ok(self.0.lock().expect("lock").clone())
            }
        }

        for expected_reason in [
            ListenerStopReason::StoppedByUser,
            ListenerStopReason::Shutdown,
            ListenerStopReason::NetworkChanged,
        ] {
            let bound = bind_ephemeral_loopback();
            let addr = bound.local_addr;
            let clock = Arc::new(TokioMonotonicClock);
            let (session, code) = SessionManager::new(
                SessionConfig::default(),
                clock.clone(),
                SharePermissions {
                    positions: true,
                    bookmarks: true,
                },
                vec![SnapshotBook {
                    document_id: "doc-1".into(),
                    snapshot_file_hash: "a".repeat(64),
                }],
            )
            .expect("session");
            let session = Arc::new(session);
            let handler = Arc::new(LanHttpHandler::new(
                addr,
                Arc::clone(&session),
                Arc::new(MockSourceApi::new()),
                HttpServerConfig::default(),
            ));
            let provider = Arc::new(MutableInterfaceProvider(std::sync::Mutex::new(vec![
                loopback_raw_iface(),
            ])));
            let mut handle = LanListener::start(
                bound,
                PeerPolicy::loopback_for_tests(),
                Arc::clone(&provider) as Arc<dyn InterfaceProvider>,
                clock,
                ListenerConfig {
                    interface_poll_interval: Duration::from_secs(5),
                    enforce_candidate_interface: false,
                    ..ListenerConfig::default()
                },
                handler,
            );
            session.attach_listener(handle.control());

            let outcome = session
                .pair(Ipv4Addr::LOCALHOST, code.expose())
                .expect("pair");
            let raw_token = outcome.token.expose().to_owned();
            let transfer_guard = session.acquire_transfer().expect("active transfer");
            tokio::task::yield_now().await;

            match expected_reason {
                ListenerStopReason::StoppedByUser => handle.stop(),
                ListenerStopReason::Shutdown => handle.shutdown(),
                ListenerStopReason::NetworkChanged => {
                    provider.0.lock().expect("lock").clear();
                    tokio::time::advance(Duration::from_secs(6)).await;
                }
                _ => unreachable!(),
            }

            let actual_reason = handle.wait_stopped().await;
            assert_eq!(actual_reason, expected_reason);
            assert_eq!(
                session.status(),
                crate::session::SessionStatus::Off,
                "session must be Off after {expected_reason:?}"
            );
            assert!(
                transfer_guard.is_aborted(),
                "active transfer must be aborted after {expected_reason:?}"
            );
            let err = session
                .authenticate(Ipv4Addr::LOCALHOST, &raw_token)
                .expect_err("token must be revoked after listener stop");
            assert_eq!(err.code(), "lan_auth_expired");
            drop(transfer_guard);
        }
    }

    // T-04: Exact 8 KiB header boundary on a reused HTTP/1.1 keep-alive
    // connection: exactly 8192 bytes is accepted (200), 8193 bytes returns 431.
    #[tokio::test]
    async fn t04_exact_8kib_header_boundary_on_reused_keep_alive_connection() {
        let (addr, _session, _code, mut handle) =
            start_test_server(SessionConfig::default(), HttpServerConfig::default());

        let mut stream = TcpStream::connect(addr).await.expect("connect");

        // 1. Warm up keep-alive connection with a normal request.
        let warmup =
            format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\n\r\n");
        stream.write_all(warmup.as_bytes()).await.expect("write");
        let resp = read_one_http_response(&mut stream).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "warmup: {resp}");

        let build_exact_len_request = |target_bytes: usize| -> Vec<u8> {
            let prefix = format!(
                "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nX-Pad: "
            );
            let suffix = "\r\n\r\n";
            let pad_len = target_bytes
                .checked_sub(prefix.len() + suffix.len())
                .expect("target_bytes larger than prefix + suffix");
            let mut req = Vec::with_capacity(target_bytes);
            req.extend_from_slice(prefix.as_bytes());
            req.resize(prefix.len() + pad_len, b'a');
            req.extend_from_slice(suffix.as_bytes());
            assert_eq!(req.len(), target_bytes);
            req
        };

        // 2. Exactly 8 KiB (8192 bytes) on the reused connection -> 200 OK.
        let exact_8k = build_exact_len_request(MAX_HEADER_BYTES);
        stream
            .write_all(&exact_8k)
            .await
            .expect("write exact 8 KiB");
        let resp_8k = read_one_http_response(&mut stream).await;
        assert!(
            resp_8k.starts_with("HTTP/1.1 200"),
            "exact 8 KiB header must succeed, got: {resp_8k}"
        );
        assert!(
            resp_8k
                .to_ascii_lowercase()
                .contains("cache-control: no-store")
        );

        // 3. 8 KiB + 1 byte (8193 bytes) on the same reused connection -> 431.
        let over_8k = build_exact_len_request(MAX_HEADER_BYTES + 1);
        stream.write_all(&over_8k).await.expect("write 8 KiB + 1");
        let mut resp_over = Vec::new();
        let read_res =
            tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut resp_over))
                .await
                .expect("431 response and close");
        // On macOS, closing a socket while unread request bytes remain in the
        // kernel buffer sends TCP RST after delivering the 431 response.
        if let Err(err) = read_res {
            assert!(
                matches!(
                    err.kind(),
                    std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::UnexpectedEof
                ),
                "unexpected read error after 431: {err}"
            );
        }
        let resp_over_str = String::from_utf8_lossy(&resp_over);
        assert!(
            resp_over_str.starts_with("HTTP/1.1 431"),
            "8 KiB + 1 byte header must return 431, got: {resp_over_str}"
        );
        assert!(
            !resp_over_str
                .to_ascii_lowercase()
                .contains("access-control-")
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }

    // T-11: Deterministic fuzz/property test driving malformed raw TCP streams
    // and arbitrary HTTP requests through the router with zero panics.
    #[tokio::test]
    async fn t11_malformed_tcp_streams_and_router_fuzz_never_panic() {
        let (addr, session, _code, mut handle) = start_test_server(
            SessionConfig::default(),
            HttpServerConfig {
                header_read_timeout: Duration::from_millis(150),
                ..HttpServerConfig::default()
            },
        );

        // 1. Raw TCP malformed payloads.
        let crafted_payloads: &[&[u8]] = &[
            b"",
            b"\r\n\r\n",
            b"NOT_HTTP_AT_ALL\x00\xff\xfe\r\n\r\n",
            b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
            b"GET /v1/books/../../etc/passwd/file HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            b"POST /v1/pair HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n",
        ];

        for payload in crafted_payloads {
            let _ = send_raw(addr, payload).await;
        }

        // Oversized header > 8 KiB must be explicitly rejected (431) with zero CORS headers.
        let mut oversized_hdr = format!(
            "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nX-Pad: "
        );
        oversized_hdr.push_str(&"A".repeat(MAX_HEADER_BYTES + 1024));
        oversized_hdr.push_str("\r\nConnection: close\r\n\r\n");
        let oversized_resp = send_http_close(addr, oversized_hdr.as_bytes()).await;
        assert!(
            oversized_resp.starts_with("HTTP/1.1 431"),
            "oversized header (> 8 KiB) must be rejected with 431, got: {oversized_resp}"
        );
        assert!(
            !oversized_resp
                .to_ascii_lowercase()
                .contains("access-control-")
        );

        // Deterministic PRNG raw byte streams (64 cases).
        let mut state: u64 = 0x5EED_CAFE_1234_5678;
        for _ in 0..64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let len = (state % 512) as usize;
            let mut bytes = Vec::with_capacity(len);
            for _ in 0..len {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                bytes.push((state & 0xFF) as u8);
            }
            let _ = send_raw(addr, &bytes).await;
        }

        // 2. Direct router fuzzing across methods, paths, headers, and bodies (200 cases).
        let handler = LanHttpHandler::new(
            addr,
            Arc::clone(&session),
            Arc::new(UnimplementedSourceApiHandler),
            HttpServerConfig::default(),
        );
        let methods = [
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
            Method::HEAD,
            Method::PATCH,
        ];
        let paths = [
            "/",
            "/v1/hello",
            "/v1/pair",
            "/v1/session/end",
            "/v1/catalog",
            "/v1/books/not-a-hash/file",
            "/v1/books/../../etc/passwd/file",
            "/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/file",
            "/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/position",
            "/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bookmarks",
            "/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra/path",
            "/v1/pair?token=secret",
        ];

        let stop_flag = AtomicBool::new(false);
        for i in 0..200u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let method = methods[(state as usize) % methods.len()].clone();
            let path = paths[((state >> 8) as usize) % paths.len()];
            let body_len = if i % 10 == 0 {
                MAX_POST_BODY_BYTES + 128
            } else {
                ((state >> 16) % 256) as usize
            };
            let body_bytes: Vec<u8> = (0..body_len)
                .map(|j| ((state.wrapping_add(j as u64)) & 0xFF) as u8)
                .collect();

            let mut builder = Request::builder().method(method).uri(path);
            if i % 3 != 0 {
                builder = builder.header(header::HOST, addr.to_string());
            }
            if i % 4 != 0 {
                builder = builder.header(PROTOCOL_HEADER, "1");
            }
            if i % 5 == 0 {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
            }
            if i % 6 == 0 {
                builder = builder.header(header::AUTHORIZATION, "Bearer invalid-token");
            }

            let req = builder
                .body(full_body(body_bytes))
                .expect("build fuzz request");
            let resp = handler
                .route_request(req, Ipv4Addr::LOCALHOST, &stop_flag)
                .await;
            assert_eq!(
                resp.headers()
                    .get(header::CACHE_CONTROL)
                    .and_then(|v| v.to_str().ok()),
                Some("no-store")
            );
            assert!(
                resp.headers()
                    .keys()
                    .all(|k| !k.as_str().starts_with("access-control-"))
            );
        }

        // Server must still be completely healthy after all malformed traffic.
        let health = send_http_close(
            addr,
            format!(
                "GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nX-SynapseRead-Protocol: 1\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert!(health.starts_with("HTTP/1.1 200"), "health: {health}");

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        assert_eq!(
            handle.panicked_connection_count(),
            0,
            "malformed TCP streams must never panic any connection task"
        );
    }
}
