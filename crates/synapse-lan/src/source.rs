//! SQLite-backed `/v1` LAN sync source endpoints (`#141`, ADR 0008).
//!
//! All database reads run inside short `tokio::task::spawn_blocking` scopes so
//! `Mutex<Database>` is never held during `fs::metadata`, SHA-256 hashing, or
//! chunked file streaming.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::future::Future;
use std::io::{self, Read as _, Seek as _, SeekFrom};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::SystemTime;

use bytes::Bytes;
use http_body_util::BodyExt as _;
use hyper::body::{Body, Frame, SizeHint};
use hyper::{Response, StatusCode, header};
use sha2::{Digest as _, Sha256};
use synapse_core::CoreError;
use synapse_core::db::Database;
use synapse_core::domain::{
    DocumentFormat, ImportLimits, sanitize_bookmark_label, sanitize_import_title,
};
use synapse_core::library::validate_extension;
use tokio::sync::mpsc;

use crate::error::LanError;
use crate::http::{
    LanResponse, SourceApiHandler, error_response, finalize_response, json_response,
    lan_error_response, no_content_response,
};
use crate::session::{AuthorizedContext, SessionManager, SnapshotBook, TransferGuard};
use crate::wire::{
    BookmarksResponse, CatalogBook, CatalogResponse, PositionResponse, WireBookmark,
};

const DEFAULT_STREAM_CHUNK_BYTES: usize = 64 * 1024;
const STREAM_CHANNEL_CAPACITY: usize = 4;

/// SQLite-backed implementation of [`SourceApiHandler`] serving `/v1/catalog`
/// and `/v1/books/{sha256}/{file,position,bookmarks}` (ADR 0008).
pub struct SqliteSourceApiHandler {
    db: Arc<Mutex<Database>>,
    file_bytes_sent: Arc<AtomicU64>,
    limits: ImportLimits,
    chunk_size: usize,
    #[cfg(test)]
    on_after_chunk_read: Option<Arc<dyn Fn(u64) + Send + Sync>>,
}

impl std::fmt::Debug for SqliteSourceApiHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteSourceApiHandler")
            .field("file_bytes_sent", &self.file_bytes_sent())
            .field("limits", &self.limits)
            .finish()
    }
}

impl SqliteSourceApiHandler {
    /// Creates a handler backed by `db` with a fresh file-bytes-sent counter.
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self::with_file_bytes_counter(db, Arc::new(AtomicU64::new(0)))
    }

    /// Creates a handler backed by `db` and an externally observable byte
    /// counter incremented only when `/v1/books/{sha256}/file` streams bytes
    /// (`T-34`).
    pub fn with_file_bytes_counter(
        db: Arc<Mutex<Database>>,
        file_bytes_sent: Arc<AtomicU64>,
    ) -> Self {
        Self {
            db,
            file_bytes_sent,
            limits: ImportLimits::default(),
            chunk_size: DEFAULT_STREAM_CHUNK_BYTES,
            #[cfg(test)]
            on_after_chunk_read: None,
        }
    }

    /// Overrides field/collection limits (primarily for testing).
    pub fn with_limits(mut self, limits: ImportLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Returns the total number of file payload bytes streamed by
    /// `GET /v1/books/{sha256}/file` so far (`T-34`).
    pub fn file_bytes_sent(&self) -> u64 {
        self.file_bytes_sent.load(Ordering::Acquire)
    }

    /// Returns a handle to the shared file-bytes-sent counter (`T-34`).
    pub fn file_bytes_counter(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.file_bytes_sent)
    }

    #[cfg(test)]
    pub(crate) fn with_chunk_size(mut self, chunk_size: usize) -> Self {
        self.chunk_size = chunk_size.max(1);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_after_chunk_read_hook(
        mut self,
        hook: Arc<dyn Fn(u64) + Send + Sync>,
    ) -> Self {
        self.on_after_chunk_read = Some(hook);
        self
    }
}

struct CatalogCandidate {
    snapshot_hash: String,
    title: String,
    format: DocumentFormat,
    extension: String,
    has_position: bool,
    bookmark_count: u64,
    path_to_stat: Option<PathBuf>,
}

enum EndpointError {
    Lan(LanError),
    Internal(&'static str),
}

impl EndpointError {
    fn into_response(self) -> LanResponse {
        match self {
            Self::Lan(err) => lan_error_response(&err),
            Self::Internal(message) => error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "lan_internal_error",
                message,
            ),
        }
    }
}

impl From<LanError> for EndpointError {
    fn from(err: LanError) -> Self {
        Self::Lan(err)
    }
}

impl From<CoreError> for EndpointError {
    fn from(err: CoreError) -> Self {
        Self::Lan(LanError::Core(err))
    }
}

struct PreparedFile {
    file: File,
    len: u64,
    mtime: Option<SystemTime>,
}

struct ChannelBody {
    rx: mpsc::Receiver<Result<Frame<Bytes>, io::Error>>,
    remaining: u64,
    transfer_guard: Arc<TransferGuard>,
}

impl Body for ChannelBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if self.transfer_guard.is_aborted() {
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "LAN sharing session revoked mid-transfer",
            ))));
        }
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.remaining = self.remaining.saturating_sub(data.len() as u64);
                }
                Poll::Ready(Some(Ok(frame)))
            }
            other => other,
        }
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

impl SourceApiHandler for SqliteSourceApiHandler {
    fn catalog(
        &self,
        auth: AuthorizedContext,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let db = Arc::clone(&self.db);
        let limits = self.limits.clone();

        Box::pin(async move {
            let snapshot_books: Vec<SnapshotBook> = session.snapshot_books().to_vec();
            let permissions = auth.permissions;

            let result =
                tokio::task::spawn_blocking(move || -> Result<CatalogResponse, EndpointError> {
                    let snapshot_by_doc: HashMap<&str, &SnapshotBook> = snapshot_books
                        .iter()
                        .map(|book| (book.document_id.as_str(), book))
                        .collect();

                    // Hold the DB mutex only for the SQLite reads, then drop it
                    // before touching the filesystem (`fs::metadata`).
                    let candidates = {
                        let db_guard = db
                            .lock()
                            .map_err(|_| EndpointError::Internal("database unavailable"))?;
                        let exported = db_guard.export_catalog_books()?;

                        let mut candidates =
                            Vec::with_capacity(exported.len().min(limits.max_catalog_books));
                        for row in exported {
                            if candidates.len() >= limits.max_catalog_books {
                                break;
                            }
                            let Some(snapshot) = snapshot_by_doc.get(row.document_id.as_str())
                            else {
                                continue;
                            };
                            let Ok(extension) = validate_extension(row.format, &row.extension)
                            else {
                                continue;
                            };
                            let path_to_stat = if row.file_hash == snapshot.snapshot_file_hash {
                                db_guard.document_path(&row.document_id).ok()
                            } else {
                                // Document was relinked mid-session (`R3-03`); do
                                // not stat or advertise the replacement file.
                                None
                            };
                            candidates.push(CatalogCandidate {
                                snapshot_hash: snapshot.snapshot_file_hash.clone(),
                                title: sanitize_import_title(&row.title, &limits),
                                format: row.format,
                                extension,
                                has_position: row.has_position,
                                bookmark_count: row.bookmark_count,
                                path_to_stat,
                            });
                        }
                        candidates
                    };

                    let mut books = Vec::with_capacity(candidates.len());
                    for candidate in candidates {
                        let (file_available, size_bytes) = match candidate.path_to_stat {
                            Some(path) => match std::fs::metadata(&path) {
                                Ok(meta) if meta.is_file() => (true, meta.len()),
                                _ => (false, 0),
                            },
                            None => (false, 0),
                        };
                        books.push(CatalogBook {
                            id: candidate.snapshot_hash,
                            title: candidate.title,
                            format: candidate.format,
                            extension: candidate.extension,
                            size_bytes,
                            file_available,
                            has_position: permissions.positions.then_some(candidate.has_position),
                            bookmark_count: permissions
                                .bookmarks
                                .then_some(candidate.bookmark_count),
                        });
                    }

                    Ok(CatalogResponse { books })
                })
                .await;

            match result {
                Ok(Ok(catalog)) => json_response(StatusCode::OK, &catalog),
                Ok(Err(err)) => err.into_response(),
                Err(_) => error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "lan_internal_error",
                    "catalog task failed",
                ),
            }
        })
    }

    fn book_file(
        &self,
        _auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let db = Arc::clone(&self.db);
        let file_bytes_sent = Arc::clone(&self.file_bytes_sent);
        let chunk_size = self.chunk_size;
        #[cfg(test)]
        let on_after_chunk_read = self.on_after_chunk_read.clone();

        Box::pin(async move {
            let Some(snapshot) = session.find_snapshot_book(&sha256).cloned() else {
                return error_response(
                    StatusCode::NOT_FOUND,
                    "lan_not_found",
                    "book is not in the active sharing session",
                );
            };

            let transfer_guard = match session.acquire_transfer() {
                Ok(guard) => Arc::new(guard),
                Err(err) => return lan_error_response(&err),
            };

            let prep_guard = Arc::clone(&transfer_guard);
            let prepared =
                tokio::task::spawn_blocking(move || -> Result<PreparedFile, EndpointError> {
                    // Short DB lock: resolve `(file_path, file_hash)` and verify
                    // snapshot hash before dropping the lock.
                    let file_path = {
                        let db_guard = db
                            .lock()
                            .map_err(|_| EndpointError::Internal("database unavailable"))?;
                        match db_guard.get_document(&snapshot.document_id) {
                            Ok(doc) => {
                                if doc.file_hash != snapshot.snapshot_file_hash {
                                    return Err(LanError::SourceChanged(
                                        "document was relinked during the sharing session".into(),
                                    )
                                    .into());
                                }
                                PathBuf::from(doc.file_path)
                            }
                            Err(CoreError::NotFound { .. }) => {
                                return Err(LanError::SourceChanged(
                                    "document is no longer available in the library".into(),
                                )
                                .into());
                            }
                            Err(err) => return Err(err.into()),
                        }
                    };

                    // Single-fd TOCTOU-free verification (`F-15`, `R3-03`, `T-17`):
                    // open once outside DB lock, capture pre-hash fstat, hash from
                    // that fd, verify post-hash fstat matches, seek(0), and later
                    // stream from that exact fd.
                    let mut file = File::open(&file_path).map_err(|_| {
                        LanError::SourceChanged("source file is missing or unreadable".into())
                    })?;

                    let pre_meta = file.metadata().map_err(|_| {
                        LanError::SourceChanged("failed to inspect source file metadata".into())
                    })?;
                    if !pre_meta.is_file() {
                        return Err(LanError::SourceChanged(
                            "source file is not a regular file".into(),
                        )
                        .into());
                    }
                    let pre_len = pre_meta.len();
                    let pre_mtime = pre_meta.modified().ok();

                    let mut hasher = Sha256::new();
                    let mut buf = vec![0u8; chunk_size];
                    let mut hashed_bytes: u64 = 0;

                    loop {
                        if prep_guard.is_aborted() {
                            return Err(LanError::AuthExpired.into());
                        }
                        let n = file.read(&mut buf).map_err(|_| {
                            LanError::SourceChanged("failed to read source file".into())
                        })?;
                        if n == 0 {
                            break;
                        }
                        hasher.update(&buf[..n]);
                        hashed_bytes = hashed_bytes.saturating_add(n as u64);
                        prep_guard.record_activity();
                    }

                    let actual_hash = encode_hex_lower(&hasher.finalize());
                    if actual_hash != snapshot.snapshot_file_hash {
                        return Err(LanError::SourceChanged(
                            "source file hash no longer matches session snapshot".into(),
                        )
                        .into());
                    }

                    let post_meta = file.metadata().map_err(|_| {
                        LanError::SourceChanged("failed to inspect source file metadata".into())
                    })?;
                    if !post_meta.is_file()
                        || post_meta.len() != hashed_bytes
                        || post_meta.len() != pre_len
                        || post_meta.modified().ok() != pre_mtime
                    {
                        return Err(LanError::SourceChanged(
                            "source file changed during verification".into(),
                        )
                        .into());
                    }
                    let expected_len = post_meta.len();
                    let expected_mtime = post_meta.modified().ok();

                    file.seek(SeekFrom::Start(0)).map_err(|_| {
                        LanError::SourceChanged("failed to rewind verified source file".into())
                    })?;

                    Ok(PreparedFile {
                        file,
                        len: expected_len,
                        mtime: expected_mtime,
                    })
                })
                .await;

            let prepared = match prepared {
                Ok(Ok(prepared)) => prepared,
                Ok(Err(err)) => return err.into_response(),
                Err(_) => {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "lan_internal_error",
                        "file preparation task failed",
                    );
                }
            };

            if transfer_guard.is_aborted() {
                return lan_error_response(&LanError::AuthExpired);
            }

            let expected_len = prepared.len;
            let (tx, rx) =
                mpsc::channel::<Result<Frame<Bytes>, io::Error>>(STREAM_CHANNEL_CAPACITY);

            let stream_guard = Arc::clone(&transfer_guard);
            tokio::task::spawn_blocking(move || {
                stream_verified_file(
                    prepared,
                    chunk_size,
                    stream_guard,
                    file_bytes_sent,
                    tx,
                    #[cfg(test)]
                    on_after_chunk_read,
                );
            });

            let body = ChannelBody {
                rx,
                remaining: expected_len,
                transfer_guard,
            }
            .boxed();

            let mut resp = Response::new(body);
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/octet-stream"),
            );
            if let Ok(len_val) = header::HeaderValue::from_str(&expected_len.to_string()) {
                resp.headers_mut().insert(header::CONTENT_LENGTH, len_val);
            }
            finalize_response(resp)
        })
    }

    fn book_position(
        &self,
        auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let db = Arc::clone(&self.db);

        Box::pin(async move {
            if !auth.permissions.positions {
                return lan_error_response(&LanError::ScopeDenied(
                    "reading positions are not shared in this session".into(),
                ));
            }
            let Some(snapshot) = session.find_snapshot_book(&sha256).cloned() else {
                return error_response(
                    StatusCode::NOT_FOUND,
                    "lan_not_found",
                    "book is not in the active sharing session",
                );
            };

            let result = tokio::task::spawn_blocking(
                move || -> Result<Option<PositionResponse>, EndpointError> {
                    let db_guard = db
                        .lock()
                        .map_err(|_| EndpointError::Internal("database unavailable"))?;
                    verify_snapshot_hash_locked(&db_guard, &snapshot)?;
                    let exported = db_guard.export_document_position(&snapshot.document_id)?;
                    Ok(exported.map(|pos| PositionResponse {
                        anchor: pos.anchor,
                        progress: pos.progress,
                    }))
                },
            )
            .await;

            match result {
                Ok(Ok(Some(position))) => json_response(StatusCode::OK, &position),
                Ok(Ok(None)) => no_content_response(),
                Ok(Err(err)) => err.into_response(),
                Err(_) => error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "lan_internal_error",
                    "position export task failed",
                ),
            }
        })
    }

    fn book_bookmarks(
        &self,
        auth: AuthorizedContext,
        sha256: String,
        session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let db = Arc::clone(&self.db);
        let limits = self.limits.clone();

        Box::pin(async move {
            if !auth.permissions.bookmarks {
                return lan_error_response(&LanError::ScopeDenied(
                    "bookmarks are not shared in this session".into(),
                ));
            }
            let Some(snapshot) = session.find_snapshot_book(&sha256).cloned() else {
                return error_response(
                    StatusCode::NOT_FOUND,
                    "lan_not_found",
                    "book is not in the active sharing session",
                );
            };

            let result =
                tokio::task::spawn_blocking(move || -> Result<BookmarksResponse, EndpointError> {
                    let db_guard = db
                        .lock()
                        .map_err(|_| EndpointError::Internal("database unavailable"))?;
                    verify_snapshot_hash_locked(&db_guard, &snapshot)?;
                    let exported = db_guard.export_document_bookmarks(&snapshot.document_id)?;
                    let bookmarks = exported
                        .into_iter()
                        .take(limits.max_bookmarks_per_book)
                        .map(|bm| {
                            let label =
                                sanitize_bookmark_label(Some(&bm.label), &bm.anchor, &limits);
                            WireBookmark {
                                anchor: bm.anchor,
                                label,
                                created_at: bm.created_at,
                            }
                        })
                        .collect();
                    Ok(BookmarksResponse { bookmarks })
                })
                .await;

            match result {
                Ok(Ok(bookmarks)) => json_response(StatusCode::OK, &bookmarks),
                Ok(Err(err)) => err.into_response(),
                Err(_) => error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "lan_internal_error",
                    "bookmarks export task failed",
                ),
            }
        })
    }
}

fn verify_snapshot_hash_locked(
    db: &Database,
    snapshot: &SnapshotBook,
) -> Result<(), EndpointError> {
    match db.get_document(&snapshot.document_id) {
        Ok(doc) => {
            if doc.file_hash != snapshot.snapshot_file_hash {
                Err(LanError::SourceChanged(
                    "document was relinked during the sharing session".into(),
                )
                .into())
            } else {
                Ok(())
            }
        }
        Err(CoreError::NotFound { .. }) => Err(LanError::SourceChanged(
            "document is no longer available in the library".into(),
        )
        .into()),
        Err(err) => Err(err.into()),
    }
}

fn stream_verified_file(
    mut prepared: PreparedFile,
    chunk_size: usize,
    transfer_guard: Arc<TransferGuard>,
    file_bytes_sent: Arc<AtomicU64>,
    tx: mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    #[cfg(test)] on_after_chunk_read: Option<Arc<dyn Fn(u64) + Send + Sync>>,
) {
    let mut total_sent: u64 = 0;

    while total_sent < prepared.len {
        if transfer_guard.is_aborted() {
            let _ = tx.blocking_send(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "LAN sharing session revoked mid-transfer",
            )));
            return;
        }

        if !fstat_matches(&prepared.file, prepared.len, prepared.mtime) {
            let _ = tx.blocking_send(Err(io::Error::other("source file changed during transfer")));
            return;
        }

        let remaining = (prepared.len - total_sent) as usize;
        let to_read = remaining.min(chunk_size);
        let mut chunk = vec![0u8; to_read];

        match prepared.file.read(&mut chunk) {
            Ok(0) => {
                let _ = tx.blocking_send(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "source file truncated during transfer",
                )));
                return;
            }
            Ok(n) => {
                chunk.truncate(n);
                let next_total = total_sent.saturating_add(n as u64);

                #[cfg(test)]
                if let Some(hook) = &on_after_chunk_read {
                    hook(next_total);
                }

                // Re-check revocation and same-fd metadata AFTER reading the
                // chunk and BEFORE delivering it to hyper — critically before
                // the final chunk completes the fixed Content-Length response.
                if transfer_guard.is_aborted() {
                    let _ = tx.blocking_send(Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "LAN sharing session revoked mid-transfer",
                    )));
                    return;
                }
                if !fstat_matches(&prepared.file, prepared.len, prepared.mtime) {
                    let _ = tx.blocking_send(Err(io::Error::other(
                        "source file changed during transfer",
                    )));
                    return;
                }

                total_sent = next_total;
                transfer_guard.record_activity();
                file_bytes_sent.fetch_add(n as u64, Ordering::Release);
                if tx
                    .blocking_send(Ok(Frame::data(Bytes::from(chunk))))
                    .is_err()
                {
                    // Receiver disconnected; stop immediately and release guard.
                    return;
                }
            }
            Err(err) => {
                let _ = tx.blocking_send(Err(err));
                return;
            }
        }
    }
}

fn fstat_matches(file: &File, expected_len: u64, expected_mtime: Option<SystemTime>) -> bool {
    match file.metadata() {
        Ok(meta) => {
            meta.is_file() && meta.len() == expected_len && meta.modified().ok() == expected_mtime
        }
        Err(_) => false,
    }
}

fn encode_hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddrV4};
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    use hyper::{Method, Request};
    use serde_json::Value;
    use synapse_core::domain::{AnchorLocation, CreateBookmarkInput, Document};

    use super::*;
    use crate::http::{
        ErrorResponseBody, HttpServerConfig, LanHttpHandler, PROTOCOL_HEADER, empty_body,
    };
    use crate::listener::TokioMonotonicClock;
    use crate::session::{SessionConfig, SharePermissions};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "synapse-lan-source-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write test file");
        path
    }

    fn setup_db(dir: &Path) -> Arc<Mutex<Database>> {
        let db = Database::open(&dir.join("test.sqlite")).expect("open sqlite db");
        Arc::new(Mutex::new(db))
    }

    fn register_doc(db: &Arc<Mutex<Database>>, path: &Path) -> Document {
        let guard = db.lock().expect("lock db");
        guard.register_document(path).expect("register document")
    }

    fn txt_anchor(start: u64, end: u64, line: u64) -> AnchorLocation {
        AnchorLocation::Txt {
            start_byte_offset: start,
            end_byte_offset: end,
            line_index: line,
        }
    }

    fn build_paired_handler(
        db: Arc<Mutex<Database>>,
        permissions: SharePermissions,
        snapshot_books: Vec<SnapshotBook>,
    ) -> (
        LanHttpHandler<SqliteSourceApiHandler>,
        Arc<SessionManager>,
        Arc<AtomicU64>,
        String,
        SocketAddrV4,
        Ipv4Addr,
    ) {
        let bound = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 10), 49319);
        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) =
            SessionManager::new(SessionConfig::default(), clock, permissions, snapshot_books)
                .expect("create session");
        let session = Arc::new(session);
        let pair = session.pair(peer, code.expose()).expect("pair peer");
        let counter = Arc::new(AtomicU64::new(0));
        let api = Arc::new(SqliteSourceApiHandler::with_file_bytes_counter(
            db,
            Arc::clone(&counter),
        ));
        let handler = LanHttpHandler::new(
            bound,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        );
        (
            handler,
            session,
            counter,
            pair.token.expose().to_owned(),
            bound,
            peer,
        )
    }

    fn authed_get(
        bound: SocketAddrV4,
        token: &str,
        path: &str,
    ) -> Request<crate::http::LanBoxBody> {
        Request::builder()
            .method(Method::GET)
            .uri(path)
            .header(header::HOST, bound.to_string())
            .header(PROTOCOL_HEADER, "1")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(empty_body())
            .expect("build GET request")
    }

    async fn read_body_bytes(resp: LanResponse) -> Vec<u8> {
        resp.into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes()
            .to_vec()
    }

    async fn read_json<T: serde::de::DeserializeOwned>(resp: LanResponse) -> T {
        let bytes = read_body_bytes(resp).await;
        serde_json::from_slice(&bytes).expect("deserialize JSON response")
    }

    // T-13: Out-of-snapshot 404 and unauthorized position/bookmarks 403 lan_scope_denied.
    #[tokio::test]
    async fn t13_scope_enforcement_and_snapshot_isolation() {
        let dir = TempDir::new("t13");
        let db = setup_db(dir.path());
        let shared_path = write_file(dir.path(), "shared.txt", b"shared content");
        let unshared_path = write_file(dir.path(), "secret.txt", b"not shared");
        let shared_doc = register_doc(&db, &shared_path);
        let unshared_doc = register_doc(&db, &unshared_path);

        {
            let mut guard = db.lock().expect("lock db");
            guard
                .update_document_cursor(&shared_doc.id, &txt_anchor(0, 6, 0), Some(0.5))
                .expect("set cursor");
            guard
                .create_bookmark(&CreateBookmarkInput {
                    document_id: shared_doc.id.clone(),
                    anchor: txt_anchor(0, 6, 0),
                    label: Some("Start".into()),
                })
                .expect("create bookmark");
        }

        let snapshot = vec![SnapshotBook {
            document_id: shared_doc.id.clone(),
            snapshot_file_hash: shared_doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: false,
            bookmarks: false,
        };
        let (handler, _session, counter, token, bound, peer) =
            build_paired_handler(Arc::clone(&db), perms, snapshot);
        let stop = AtomicBool::new(false);

        // /v1/catalog excludes unshared_doc and omits hasPosition / bookmarkCount.
        let resp = handler
            .route_request(authed_get(bound, &token, "/v1/catalog"), peer, &stop)
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let raw_catalog: Value = read_json(resp).await;
        let books = raw_catalog["books"].as_array().expect("books array");
        assert_eq!(books.len(), 1);
        assert_eq!(books[0]["id"], shared_doc.file_hash);
        assert!(books[0].get("hasPosition").is_none());
        assert!(books[0].get("bookmarkCount").is_none());

        // Out-of-snapshot book returns 404 on /file.
        let resp = handler
            .route_request(
                authed_get(
                    bound,
                    &token,
                    &format!("/v1/books/{}/file", unshared_doc.file_hash),
                ),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let err: ErrorResponseBody = read_json(resp).await;
        assert_eq!(err.code, "lan_not_found");

        // Unauthorized /position and /bookmarks return 403 lan_scope_denied.
        for suffix in ["position", "bookmarks"] {
            let resp = handler
                .route_request(
                    authed_get(
                        bound,
                        &token,
                        &format!("/v1/books/{}/{suffix}", shared_doc.file_hash),
                    ),
                    peer,
                    &stop,
                )
                .await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            let err: ErrorResponseBody = read_json(resp).await;
            assert_eq!(err.code, "lan_scope_denied");
        }

        // Also test out-of-snapshot 404 on /position and /bookmarks when permissions are enabled.
        let snapshot = vec![SnapshotBook {
            document_id: shared_doc.id.clone(),
            snapshot_file_hash: shared_doc.file_hash.clone(),
        }];
        let all_perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let (handler2, _session2, _counter2, token2, bound2, peer2) =
            build_paired_handler(Arc::clone(&db), all_perms, snapshot);
        for suffix in ["position", "bookmarks"] {
            let resp = handler2
                .route_request(
                    authed_get(
                        bound2,
                        &token2,
                        &format!("/v1/books/{}/{suffix}", unshared_doc.file_hash),
                    ),
                    peer2,
                    &stop,
                )
                .await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND);
            let err: ErrorResponseBody = read_json(resp).await;
            assert_eq!(err.code, "lan_not_found");
        }

        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    // T-14 & R2-01: Live wire payloads never leak local paths, lastOpenedAt, or
    // device names, sanitize titles/labels, and preserve `.md` under `txt`.
    #[tokio::test]
    async fn t14_live_responses_never_leak_private_fields_and_preserve_md_extension() {
        let dir = TempDir::new("t14");
        let db = setup_db(dir.path());
        let md_path = write_file(dir.path(), "Line 1\u{202E}Evil.md", b"# Heading\nBody text");
        let doc = register_doc(&db, &md_path);

        {
            let mut guard = db.lock().expect("lock db");
            guard
                .update_document_cursor(&doc.id, &txt_anchor(0, 9, 0), Some(0.25))
                .expect("set cursor");
            guard
                .create_bookmark(&CreateBookmarkInput {
                    document_id: doc.id.clone(),
                    anchor: txt_anchor(0, 9, 0),
                    label: Some("Intro\u{0007}\u{202E}\nSecond line".into()),
                })
                .expect("create bookmark");
        }

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let (handler, _session, counter, token, bound, peer) =
            build_paired_handler(Arc::clone(&db), perms, snapshot);
        let stop = AtomicBool::new(false);
        let temp_dir_str = dir.path().to_string_lossy().to_string();

        // /v1/catalog
        let resp = handler
            .route_request(authed_get(bound, &token, "/v1/catalog"), peer, &stop)
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let catalog_bytes = read_body_bytes(resp).await;
        let catalog_text = String::from_utf8(catalog_bytes.clone()).expect("utf8");
        assert!(!catalog_text.contains(&temp_dir_str));
        assert!(!catalog_text.contains("filePath"));
        assert!(!catalog_text.contains("file_path"));
        assert!(!catalog_text.contains("lastOpenedAt"));
        assert!(!catalog_text.contains("last_opened_at"));
        assert!(!catalog_text.contains("deviceName"));

        let catalog: CatalogResponse = serde_json::from_slice(&catalog_bytes).expect("catalog");
        assert_eq!(catalog.books.len(), 1);
        assert_eq!(catalog.books[0].title, "Line 1Evil");
        assert_eq!(catalog.books[0].format, DocumentFormat::Txt);
        assert_eq!(catalog.books[0].extension, "md");
        assert_eq!(catalog.books[0].size_bytes, 19);
        assert!(catalog.books[0].file_available);
        assert_eq!(catalog.books[0].has_position, Some(true));
        assert_eq!(catalog.books[0].bookmark_count, Some(1));

        // /v1/books/{sha256}/position
        let resp = handler
            .route_request(
                authed_get(
                    bound,
                    &token,
                    &format!("/v1/books/{}/position", doc.file_hash),
                ),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let pos_bytes = read_body_bytes(resp).await;
        let pos_text = String::from_utf8(pos_bytes.clone()).expect("utf8");
        assert!(!pos_text.contains(&temp_dir_str));
        assert!(!pos_text.contains("lastOpenedAt"));
        let pos: PositionResponse = serde_json::from_slice(&pos_bytes).expect("position");
        assert_eq!(pos.progress, Some(0.25));

        // /v1/books/{sha256}/bookmarks
        let resp = handler
            .route_request(
                authed_get(
                    bound,
                    &token,
                    &format!("/v1/books/{}/bookmarks", doc.file_hash),
                ),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bm_bytes = read_body_bytes(resp).await;
        let bm_text = String::from_utf8(bm_bytes.clone()).expect("utf8");
        assert!(!bm_text.contains(&temp_dir_str));
        assert!(!bm_text.contains("lastOpenedAt"));
        let bms: BookmarksResponse = serde_json::from_slice(&bm_bytes).expect("bookmarks");
        assert_eq!(bms.bookmarks.len(), 1);
        assert_eq!(bms.bookmarks[0].label, "Intro");

        // T-34: Zero file bytes sent when /file has not been requested.
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    // T-17: Single-fd hash mismatch returns 409 lan_source_changed with 0 file bytes sent.
    #[tokio::test]
    async fn t17_single_fd_hash_mismatch_returns_409_with_zero_file_bytes() {
        let dir = TempDir::new("t17");
        let db = setup_db(dir.path());
        let file_path = write_file(dir.path(), "book.txt", b"original contents");
        let doc = register_doc(&db, &file_path);

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let (handler, _session, counter, token, bound, peer) =
            build_paired_handler(Arc::clone(&db), perms, snapshot);
        let stop = AtomicBool::new(false);

        // Mutate the file on disk after the session snapshot was captured.
        std::fs::write(&file_path, b"tampered contents!!").expect("overwrite file");

        let resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let body_bytes = read_body_bytes(resp).await;
        let body_text = String::from_utf8(body_bytes.clone()).expect("utf8");
        assert!(!body_text.contains(&file_path.to_string_lossy().to_string()));
        let err: ErrorResponseBody = serde_json::from_slice(&body_bytes).expect("error body");
        assert_eq!(err.code, "lan_source_changed");
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    // T-25 & lock-free streaming: Concurrent /file transfer returns 429
    // lan_transfer_busy, and Mutex<Database> is not held during streaming.
    #[tokio::test]
    async fn t25_concurrent_transfer_busy_and_db_lock_not_held_during_stream() {
        let dir = TempDir::new("t25");
        let db = setup_db(dir.path());
        let payload = vec![b'X'; 4096];
        let file_path = write_file(dir.path(), "large.txt", &payload);
        let doc = register_doc(&db, &file_path);

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let bound = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 10), 49319);
        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) =
            SessionManager::new(SessionConfig::default(), clock, perms, snapshot).expect("session");
        let session = Arc::new(session);
        let pair = session.pair(peer, code.expose()).expect("pair");
        let token = pair.token.expose().to_owned();
        let counter = Arc::new(AtomicU64::new(0));
        let api = Arc::new(
            SqliteSourceApiHandler::with_file_bytes_counter(Arc::clone(&db), Arc::clone(&counter))
                .with_chunk_size(512),
        );
        let handler = LanHttpHandler::new(
            bound,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        );
        let stop = AtomicBool::new(false);

        // Start first transfer and keep its response body alive (unconsumed).
        let first_resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(first_resp.status(), StatusCode::OK);
        assert_eq!(
            first_resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/octet-stream")
        );
        assert_eq!(
            first_resp
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()),
            Some("4096")
        );

        // While the stream is open, Mutex<Database> must NOT be held.
        assert!(
            db.try_lock().is_ok(),
            "Mutex<Database> must not be held while streaming a file"
        );

        // A second concurrent /file request must receive 429 lan_transfer_busy.
        let second_resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(second_resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let err: ErrorResponseBody = read_json(second_resp).await;
        assert_eq!(err.code, "lan_transfer_busy");

        // Drain the first response and verify exact payload + T-34 byte counter.
        let received = read_body_bytes(first_resp).await;
        assert_eq!(received, payload);
        assert_eq!(counter.load(Ordering::Acquire), payload.len() as u64);

        // Once the first transfer finishes, a subsequent transfer succeeds.
        let third_resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(third_resp.status(), StatusCode::OK);
        let received_again = read_body_bytes(third_resp).await;
        assert_eq!(received_again, payload);
        assert_eq!(counter.load(Ordering::Acquire), (payload.len() * 2) as u64);
    }

    // R3-03: Mid-session relink changing doc.file_hash returns 409
    // lan_source_changed on /file, /position, and /bookmarks.
    #[tokio::test]
    async fn r3_03_mid_session_relink_returns_409_across_file_position_and_bookmarks() {
        let dir = TempDir::new("r303");
        let db = setup_db(dir.path());
        let original_path = write_file(dir.path(), "v1.txt", b"version 1");
        let replacement_path = write_file(dir.path(), "v2.txt", b"version 2 updated");
        let doc = register_doc(&db, &original_path);

        {
            let mut guard = db.lock().expect("lock db");
            guard
                .update_document_cursor(&doc.id, &txt_anchor(0, 5, 0), Some(0.3))
                .expect("set cursor");
            guard
                .create_bookmark(&CreateBookmarkInput {
                    document_id: doc.id.clone(),
                    anchor: txt_anchor(0, 5, 0),
                    label: Some("Mark".into()),
                })
                .expect("create bookmark");
        }

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let (handler, _session, counter, token, bound, peer) =
            build_paired_handler(Arc::clone(&db), perms, snapshot);
        let stop = AtomicBool::new(false);

        // Relink the document mid-session so `doc.file_hash != snapshot_file_hash`.
        {
            let guard = db.lock().expect("lock db");
            let relinked = guard
                .relink_document(&doc.id, &replacement_path)
                .expect("relink document");
            assert_ne!(relinked.document.file_hash, doc.file_hash);
        }

        for suffix in ["file", "position", "bookmarks"] {
            let resp = handler
                .route_request(
                    authed_get(
                        bound,
                        &token,
                        &format!("/v1/books/{}/{suffix}", doc.file_hash),
                    ),
                    peer,
                    &stop,
                )
                .await;
            assert_eq!(resp.status(), StatusCode::CONFLICT, "endpoint {suffix}");
            let err: ErrorResponseBody = read_json(resp).await;
            assert_eq!(err.code, "lan_source_changed", "endpoint {suffix}");
        }

        // /v1/catalog marks the relinked snapshot book unavailable.
        let resp = handler
            .route_request(authed_get(bound, &token, "/v1/catalog"), peer, &stop)
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let catalog: CatalogResponse = read_json(resp).await;
        assert_eq!(catalog.books.len(), 1);
        assert!(!catalog.books[0].file_available);
        assert_eq!(catalog.books[0].size_bytes, 0);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn position_returns_204_when_unset_and_bookmarks_enforces_cap() {
        let dir = TempDir::new("pos204");
        let db = setup_db(dir.path());
        let file_path = write_file(dir.path(), "book.txt", b"hello world");
        let doc = register_doc(&db, &file_path);

        {
            let mut guard = db.lock().expect("lock db");
            for idx in 0..5u64 {
                guard
                    .create_bookmark(&CreateBookmarkInput {
                        document_id: doc.id.clone(),
                        anchor: txt_anchor(idx, idx + 1, 0),
                        label: Some(format!("BM {idx}")),
                    })
                    .expect("create bookmark");
            }
        }

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let bound = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 10), 49319);
        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) =
            SessionManager::new(SessionConfig::default(), clock, perms, snapshot).expect("session");
        let session = Arc::new(session);
        let pair = session.pair(peer, code.expose()).expect("pair");
        let token = pair.token.expose().to_owned();
        let limits = ImportLimits {
            max_bookmarks_per_book: 3,
            ..ImportLimits::default()
        };
        let api = Arc::new(SqliteSourceApiHandler::new(Arc::clone(&db)).with_limits(limits));
        let handler = LanHttpHandler::new(bound, session, api, HttpServerConfig::default());
        let stop = AtomicBool::new(false);

        // No saved position -> 204 No Content.
        let resp = handler
            .route_request(
                authed_get(
                    bound,
                    &token,
                    &format!("/v1/books/{}/position", doc.file_hash),
                ),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(read_body_bytes(resp).await.is_empty());

        // Bookmarks capped at limits.max_bookmarks_per_book (3).
        let resp = handler
            .route_request(
                authed_get(
                    bound,
                    &token,
                    &format!("/v1/books/{}/bookmarks", doc.file_hash),
                ),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bms: BookmarksResponse = read_json(resp).await;
        assert_eq!(bms.bookmarks.len(), 3);
    }

    #[tokio::test]
    async fn session_revocation_aborts_active_file_stream() {
        let dir = TempDir::new("revoke");
        let db = setup_db(dir.path());
        let payload = vec![b'Z'; 8192];
        let file_path = write_file(dir.path(), "stream.txt", &payload);
        let doc = register_doc(&db, &file_path);

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let bound = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 10), 49319);
        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) =
            SessionManager::new(SessionConfig::default(), clock, perms, snapshot).expect("session");
        let session = Arc::new(session);
        let pair = session.pair(peer, code.expose()).expect("pair");
        let token = pair.token.expose().to_owned();
        let api = Arc::new(SqliteSourceApiHandler::new(Arc::clone(&db)).with_chunk_size(512));
        let handler = LanHttpHandler::new(
            bound,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        );
        let stop = AtomicBool::new(false);

        let resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Revoke the session before draining the body.
        session.revoke();

        let err = resp
            .into_body()
            .collect()
            .await
            .expect_err("revoked stream must abort with error");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
    }

    #[tokio::test]
    async fn in_place_modification_during_final_chunk_read_aborts_before_delivery() {
        let dir = TempDir::new("final-chunk-modify");
        let db = setup_db(dir.path());
        let payload = vec![b'A'; 1024];
        let file_path = write_file(dir.path(), "in-place.txt", &payload);
        let doc = register_doc(&db, &file_path);

        let snapshot = vec![SnapshotBook {
            document_id: doc.id.clone(),
            snapshot_file_hash: doc.file_hash.clone(),
        }];
        let perms = SharePermissions {
            positions: true,
            bookmarks: true,
        };
        let bound = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 10), 49319);
        let peer = Ipv4Addr::new(192, 168, 1, 20);
        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) =
            SessionManager::new(SessionConfig::default(), clock, perms, snapshot).expect("session");
        let session = Arc::new(session);
        let pair = session.pair(peer, code.expose()).expect("pair");
        let token = pair.token.expose().to_owned();

        // Trigger an in-place file modification (extending length so fstat
        // deterministically detects the change regardless of coarse FS mtime
        // granularity) right after reading the final chunk, BEFORE that chunk
        // is delivered to the HTTP layer.
        let path_for_hook = file_path.clone();
        let total_len = payload.len() as u64;
        let hook: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(move |bytes_read| {
            if bytes_read == total_len {
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path_for_hook)
                    .expect("open for in-place append");
                io::Write::write_all(&mut f, b"MUTATED").expect("append mutation");
                f.sync_all().expect("sync mutation");
            }
        });

        let counter = Arc::new(AtomicU64::new(0));
        let api = Arc::new(
            SqliteSourceApiHandler::with_file_bytes_counter(Arc::clone(&db), Arc::clone(&counter))
                .with_chunk_size(512)
                .with_after_chunk_read_hook(hook),
        );
        let handler = LanHttpHandler::new(
            bound,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        );
        let stop = AtomicBool::new(false);

        let resp = handler
            .route_request(
                authed_get(bound, &token, &format!("/v1/books/{}/file", doc.file_hash)),
                peer,
                &stop,
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The final chunk must NEVER be delivered to the HTTP layer; collecting
        // the response body must fail rather than completing cleanly.
        let err = resp
            .into_body()
            .collect()
            .await
            .expect_err("in-place mutation before final chunk delivery must abort stream");
        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert!(
            counter.load(Ordering::Acquire) < total_len,
            "final mutated chunk must not be counted or handed to HTTP layer"
        );
    }
}
