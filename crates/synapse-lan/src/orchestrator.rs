//! Two-phase LAN book import orchestrator (`plan_import` / `execute_import`)
//! (ADR 0008, `#148`, LS-13).
//!
//! - Phase 1 ([`classify_catalog`] / [`plan_import`]): evaluates local DB
//!   hashes plus cheap `fs::metadata` (`stat`) checks (`F-19`), fetches
//!   authorized `/position` and `/bookmarks` over [`PairedClient`]'s reused
//!   HTTP/1.1 keep-alive connection with bounded concurrency (`<= 2`, `R3-02`),
//!   classifies bookmarks, and retains `expected: CursorSnapshot` strictly in
//!   Rust session state (`R3-07`).
//! - Phase 2 ([`execute_import`]): processes selected books sequentially (1
//!   file transfer at a time), resolves missing-record extensions before
//!   [`StagedFile::finish`] (`R2-01`, `R3-08`), re-verifies local healthy files
//!   outside `Mutex<Database>`, commits `file -> position -> bookmarks`, and
//!   invokes the per-book commit callback **before** emitting that book's
//!   completion progress event (`R2-07`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use synapse_core::CoreError;
use synapse_core::db::{Database, verify_document_file};
use synapse_core::domain::{
    AnchorLocation, Bookmark, CursorSnapshot, Document, DocumentFormat, DocumentSourceState,
    ImportBookmarkEntry, ImportDocumentResult, ImportLimits, ReplaceCursorResult,
    sanitize_bookmark_label, sanitize_import_title,
};
use synapse_core::library::{ManagedLibrary, StagedFile, is_disk_full_error, validate_extension};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::client::{
    CancelToken, CatalogBook as RemoteCatalogBook, PairedClient, ParsedBookmark, ParsedPosition,
};
use crate::error::{LanError, LanResult};
use crate::http::is_valid_sha256_hex;

/// Hard upper bound on concurrent `/position` + `/bookmarks` metadata fetches
/// during [`plan_import`] so large selections never saturate the source's
/// 4-connection cap (`R3-02`).
pub const MAX_PLANNER_CONCURRENCY: usize = 2;

/// Configuration for [`plan_import`] and [`execute_import`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorConfig {
    pub limits: ImportLimits,
    /// Clamped to `1..=MAX_PLANNER_CONCURRENCY` (`1..=2`).
    pub max_planner_concurrency: usize,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            limits: ImportLimits::default(),
            max_planner_concurrency: MAX_PLANNER_CONCURRENCY,
        }
    }
}

impl OrchestratorConfig {
    pub const fn effective_planner_concurrency(&self) -> usize {
        if self.max_planner_concurrency < 1 {
            1
        } else if self.max_planner_concurrency > MAX_PLANNER_CONCURRENCY {
            MAX_PLANNER_CONCURRENCY
        } else {
            self.max_planner_concurrency
        }
    }
}

/// Classification of a remote catalog book against the receiver's local library
/// (ADR 0008 §2.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookSyncState {
    /// Not present locally; eligible for file + metadata import.
    New,
    /// Same SHA-256 exists locally and its file is present on disk; eligible
    /// for 0-byte position/bookmark sync.
    AlreadyPresent,
    /// Same SHA-256 exists locally but its file is missing on disk; eligible
    /// for missing-file restore (preserving existing record and extension).
    MissingFile,
    /// Same SHA-256 exists locally but the on-disk file has been modified;
    /// ineligible and never routed to `relink_document`.
    LocalFileChanged,
    /// Different SHA-256, but a local book shares the same title; eligible to
    /// import as a distinct version.
    SameTitleDifferentVersion,
    /// Remote source cannot supply the required file.
    SourceUnavailable,
    /// Unsupported format/extension or local DB format disagrees with remote.
    FormatMismatch,
}

impl BookSyncState {
    /// Returns `true` when this book may participate in import planning and
    /// execution.
    pub const fn is_eligible(self) -> bool {
        matches!(
            self,
            Self::New | Self::AlreadyPresent | Self::MissingFile | Self::SameTitleDifferentVersion
        )
    }

    /// Returns `true` when importing this book requires transferring its file
    /// bytes from the source.
    pub const fn needs_file_download(self) -> bool {
        matches!(
            self,
            Self::New | Self::MissingFile | Self::SameTitleDifferentVersion
        )
    }
}

/// Cheap `stat`-only classification of a catalog entry (`F-19`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBookClassification {
    pub book_id: String,
    pub title: String,
    pub format: Option<DocumentFormat>,
    pub raw_format: String,
    pub extension: String,
    pub size_bytes: u64,
    pub file_available: bool,
    pub has_position: Option<bool>,
    pub bookmark_count: Option<u64>,
    pub state: BookSyncState,
    pub eligible: bool,
    pub needs_file_download: bool,
    pub local_document_id: Option<String>,
    pub local_title: Option<String>,
}

/// Progress update emitted by [`plan_import`] as each selected book finishes
/// planning (`R3-02`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub completed_books: usize,
    pub total_books: usize,
    pub book_id: String,
}

/// Machine-readable error details suitable for IPC/UI display (`IpcError` shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportErrorInfo {
    pub code: String,
    pub message: String,
}

impl ImportErrorInfo {
    pub fn from_lan_error(err: &LanError) -> Self {
        Self {
            code: err.code().to_owned(),
            message: err.to_string(),
        }
    }

    pub fn from_core_error(err: &CoreError) -> Self {
        Self {
            code: err.code().to_owned(),
            message: err.to_string(),
        }
    }

    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// UI-safe reading position comparison metadata (`F-20`, `R3-07`).
///
/// Intentionally omits raw `AnchorLocation` internals and `CursorSnapshot`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionPlanSummary {
    pub remote_available: bool,
    pub remote_progress: Option<f64>,
    pub local_has_position: bool,
    pub local_progress: Option<f64>,
    pub differs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
    pub default_adopt: bool,
}

/// Reason a remote bookmark was classified as skipped during [`plan_import`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BookmarkPlanSkipReason {
    InvalidAnchor,
    FormatMismatch,
    AnchorLimitExceeded,
    BookmarkCapExceeded,
    UnsupportedAnchor { reason: String },
}

/// Classification of an individual remote bookmark during [`plan_import`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PlannedBookmarkStatus {
    New,
    Existing,
    Skipped { reason: BookmarkPlanSkipReason },
}

/// UI-safe preview of a single planned bookmark (zero anchor internals).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedBookmarkPreview {
    pub index: usize,
    pub label: Option<String>,
    pub created_at: Option<String>,
    pub status: PlannedBookmarkStatus,
}

/// UI-safe bookmark summary for a planned book.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkPlanSummary {
    pub new_count: usize,
    pub existing_count: usize,
    pub skipped_count: usize,
    pub entries: Vec<PlannedBookmarkPreview>,
    pub default_import: bool,
}

/// UI-safe summary for a single planned book (`F-20`, `R3-07`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPlanSummary {
    pub book_id: String,
    pub title: String,
    pub format: Option<DocumentFormat>,
    pub extension: String,
    pub size_bytes: u64,
    pub state: BookSyncState,
    pub eligible: bool,
    pub needs_file_download: bool,
    pub local_document_id: Option<String>,
    pub local_title: Option<String>,
    pub position: PositionPlanSummary,
    pub bookmarks: BookmarkPlanSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_error: Option<ImportErrorInfo>,
}

/// UI-safe serializable summary of an [`ImportPlan`] (`R3-07`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlanSummary {
    pub books: Vec<BookPlanSummary>,
}

/// Internal per-book plan state held exclusively in Rust (`R3-07`).
///
/// Intentionally does not implement `Serialize` so `expected_cursor` and
/// `conflict_cursor` can never be serialized across WebView JSON.
#[derive(Debug, Clone)]
struct PlannedBook {
    summary: BookPlanSummary,
    resolved_format: Option<DocumentFormat>,
    validated_remote_extension: Option<String>,
    local_extension: Option<String>,
    expected_cursor: CursorSnapshot,
    conflict_cursor: Option<CursorSnapshot>,
    remote_cursor: Option<CursorSnapshot>,
    /// Preview `index` -> valid importable bookmark entry mapping (`#146`).
    remote_bookmarks: BTreeMap<usize, ImportBookmarkEntry>,
    wire_skipped_bookmarks: usize,
}

/// Rust-owned session import plan produced by [`plan_import`] and consumed by
/// [`execute_import`].
///
/// Intentionally does **not** derive `Serialize` so `expected: CursorSnapshot`
/// never round-trips through WebView JSON (`R3-07`). Call [`Self::summary`] to
/// obtain the UI-safe [`ImportPlanSummary`].
#[derive(Debug, Clone)]
pub struct ImportPlan {
    books: Vec<PlannedBook>,
}

impl ImportPlan {
    /// Returns the UI-safe serializable plan summary (no `CursorSnapshot` or
    /// `AnchorLocation` internals, `F-20`, `R3-07`).
    pub fn summary(&self) -> ImportPlanSummary {
        ImportPlanSummary {
            books: self.books.iter().map(|b| b.summary.clone()).collect(),
        }
    }

    /// Looks up the UI-safe summary for a single planned book by SHA-256 ID.
    pub fn book_summary(&self, book_id: &str) -> Option<&BookPlanSummary> {
        self.books
            .iter()
            .find(|b| b.summary.book_id == book_id)
            .map(|b| &b.summary)
    }

    /// Returns `true` if `book_id` previously encountered a `lan_position_conflict`
    /// and holds a fresh Rust-side conflict cursor snapshot awaiting user
    /// re-confirmation (`T-35`, `T-36`).
    pub fn has_pending_position_conflict(&self, book_id: &str) -> bool {
        self.books
            .iter()
            .find(|b| b.summary.book_id == book_id)
            .is_some_and(|b| b.conflict_cursor.is_some())
    }

    /// Builds default per-book import decisions following ADR 0008 defaults
    /// (`OD-8`: bookmarks default ON for healthy eligible books; positions
    /// adopt by default for new books or when local has no position).
    pub fn default_decisions(&self) -> Vec<BookImportDecision> {
        self.books
            .iter()
            .filter(|b| b.summary.eligible)
            .map(|b| BookImportDecision {
                book_id: b.summary.book_id.clone(),
                import_file: b.summary.needs_file_download,
                import_position: b.summary.position.default_adopt,
                import_bookmarks: b.summary.bookmarks.default_import,
                selected_bookmark_indices: None,
                override_position_conflict: false,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn expected_cursor_for_tests(&self, book_id: &str) -> Option<&CursorSnapshot> {
        self.books
            .iter()
            .find(|b| b.summary.book_id == book_id)
            .map(|b| &b.expected_cursor)
    }

    fn find_mut(&mut self, book_id: &str) -> Option<&mut PlannedBook> {
        self.books.iter_mut().find(|b| b.summary.book_id == book_id)
    }
}

/// Per-book user selection passed to [`execute_import`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportDecision {
    pub book_id: String,
    pub import_file: bool,
    pub import_position: bool,
    pub import_bookmarks: bool,
    /// Optional per-bookmark selection by preview `index` from
    /// [`BookmarkPlanSummary::entries`] (`#146`).
    ///
    /// - `None`: import all eligible bookmarks in the plan when
    ///   `import_bookmarks` is `true`.
    /// - `Some(indices)`: validate that every index belongs to this book's
    ///   plan and is selectable, then import only those entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_bookmark_indices: Option<Vec<usize>>,
    /// Explicit per-book user re-confirmation after a `lan_position_conflict`
    /// (`T-35`, `T-36`). Only applies when this [`ImportPlan`] already holds a
    /// recorded conflict snapshot for this book; never bypasses the first CAS
    /// check against the preview snapshot.
    #[serde(default)]
    pub override_position_conflict: bool,
}

/// Injectable staging factory for [`execute_import_with_stage_factory`].
///
/// Production code uses [`DefaultStageFactory`]; tests can inject a writer
/// backed by [`ManagedLibrary::begin_stage_with_writer`] to trigger `ENOSPC`
/// deterministically (`T-22`).
pub trait StageFactory: Send + Sync {
    fn begin_stage(
        &self,
        library: &ManagedLibrary,
        format: DocumentFormat,
        extension: &str,
        expected_hash: &str,
        expected_len: u64,
    ) -> synapse_core::CoreResult<StagedFile>;
}

/// Production [`StageFactory`] delegating directly to [`ManagedLibrary::begin_stage`].
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultStageFactory;

impl StageFactory for DefaultStageFactory {
    fn begin_stage(
        &self,
        library: &ManagedLibrary,
        format: DocumentFormat,
        extension: &str,
        expected_hash: &str,
        expected_len: u64,
    ) -> synapse_core::CoreResult<StagedFile> {
        library.begin_stage(format, extension, expected_hash, expected_len)
    }
}

/// Per-book commit payload delivered to the commit callback **before** emitting
/// [`ImportProgress::BookCompleted`] so the Tauri adapter can call
/// `access::grant_documents` before notifying the UI (`R2-07`).
#[derive(Debug, Clone, PartialEq)]
pub struct BookCommitEvent {
    pub book_id: String,
    pub document: Document,
    pub file_result: Option<ImportDocumentResult>,
    pub position_replaced: bool,
    pub inserted_bookmarks: Vec<Bookmark>,
}

/// Outcome of an individual component (`file`, `position`, or `bookmarks`) for
/// a book during [`execute_import`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ComponentOutcome {
    Applied,
    Skipped {
        #[serde(default, skip_serializing_if = "Option::is_none")]
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

/// Bookmark counts recorded for a book during [`execute_import`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkExecutionSummary {
    pub inserted: usize,
    pub existing: usize,
    pub skipped: usize,
}

/// Execution outcome for a single book in [`ImportExecutionReport`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportResult {
    pub book_id: String,
    pub document_id: Option<String>,
    pub state: BookSyncState,
    pub file: ComponentOutcome,
    pub position: ComponentOutcome,
    pub bookmarks: ComponentOutcome,
    pub bookmark_counts: BookmarkExecutionSummary,
}

/// Streaming progress events emitted during [`execute_import`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum ImportProgress {
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
        result: Box<BookImportResult>,
    },
}

/// Aggregated result of [`execute_import`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExecutionReport {
    pub books: Vec<BookImportResult>,
    pub cancelled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_error: Option<ImportErrorInfo>,
}

type LocalBookmarksByDoc = HashMap<String, Vec<Bookmark>>;

struct LocalLibraryIndex {
    by_hash: HashMap<String, Document>,
    by_normalized_title: HashMap<String, Vec<String>>,
}

impl LocalLibraryIndex {
    fn from_documents(documents: Vec<Document>) -> Self {
        let mut by_hash = HashMap::with_capacity(documents.len());
        let mut by_normalized_title: HashMap<String, Vec<String>> = HashMap::new();
        for doc in documents {
            let key = normalize_title_for_match(&doc.title);
            by_normalized_title
                .entry(key)
                .or_default()
                .push(doc.id.clone());
            by_hash.insert(doc.file_hash.clone(), doc);
        }
        Self {
            by_hash,
            by_normalized_title,
        }
    }

    fn has_same_title_other_hash(&self, sanitized_remote_title: &str) -> bool {
        let key = normalize_title_for_match(sanitized_remote_title);
        self.by_normalized_title
            .get(&key)
            .is_some_and(|ids| !ids.is_empty())
    }
}

fn normalize_title_for_match(title: &str) -> String {
    title.trim().to_lowercase()
}

struct ClassifiedCandidate {
    remote: RemoteCatalogBook,
    sanitized_title: String,
    resolved_format: Option<DocumentFormat>,
    validated_remote_extension: Option<String>,
    state: BookSyncState,
    local_doc: Option<Document>,
    local_extension: Option<String>,
}

/// Classifies every catalog book against the local database using ONLY DB hash
/// lookups and cheap `fs::metadata` (`stat`) checks — never re-hashing the
/// local library (`F-19`).
pub async fn classify_catalog(
    db: &Arc<Mutex<Database>>,
    catalog_books: &[RemoteCatalogBook],
    limits: &ImportLimits,
) -> LanResult<Vec<CatalogBookClassification>> {
    let db = Arc::clone(db);
    let books = catalog_books.to_vec();
    let limits = limits.clone();

    tokio::task::spawn_blocking(move || -> LanResult<Vec<CatalogBookClassification>> {
        let local_docs = {
            let guard = db.lock().map_err(|_| {
                LanError::Core(CoreError::Io(std::io::Error::other(
                    "database lock poisoned",
                )))
            })?;
            guard.list_documents()?
        };
        let index = LocalLibraryIndex::from_documents(local_docs);

        let classified = books
            .into_iter()
            .map(|remote| {
                let c = classify_single_stat_only(remote, &index, &limits);
                CatalogBookClassification {
                    book_id: c.remote.id,
                    title: c.sanitized_title,
                    format: c.resolved_format,
                    raw_format: c.remote.format,
                    extension: c.validated_remote_extension.unwrap_or(c.remote.extension),
                    size_bytes: c.remote.size_bytes,
                    file_available: c.remote.file_available,
                    has_position: c.remote.has_position,
                    bookmark_count: c.remote.bookmark_count,
                    state: c.state,
                    eligible: c.state.is_eligible(),
                    needs_file_download: c.state.needs_file_download(),
                    local_document_id: c.local_doc.as_ref().map(|d| d.id.clone()),
                    local_title: c.local_doc.as_ref().map(|d| d.title.clone()),
                }
            })
            .collect();
        Ok(classified)
    })
    .await
    .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))))?
}

fn classify_single_stat_only(
    remote: RemoteCatalogBook,
    index: &LocalLibraryIndex,
    limits: &ImportLimits,
) -> ClassifiedCandidate {
    let sanitized_title = sanitize_import_title(&remote.title, limits);
    let valid_hash = is_valid_sha256_hex(&remote.id);
    let resolved_format = remote.parsed_format().filter(|f| *f != DocumentFormat::Md);
    let validated_remote_extension =
        resolved_format.and_then(|fmt| validate_extension(fmt, &remote.extension).ok());

    let local_doc = if valid_hash {
        index.by_hash.get(&remote.id).cloned()
    } else {
        None
    };

    let local_extension = local_doc.as_ref().and_then(|doc| {
        Path::new(&doc.file_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(|ext| validate_extension(doc.format, ext).ok())
    });

    let state = if !valid_hash {
        BookSyncState::FormatMismatch
    } else if let Some(ref local) = local_doc {
        match resolved_format {
            Some(fmt) if fmt == local.format => match std::fs::metadata(&local.file_path) {
                Ok(meta) if meta.is_file() => {
                    if remote.file_available && meta.len() != remote.size_bytes {
                        BookSyncState::LocalFileChanged
                    } else {
                        BookSyncState::AlreadyPresent
                    }
                }
                _ => {
                    if remote.file_available {
                        BookSyncState::MissingFile
                    } else {
                        BookSyncState::SourceUnavailable
                    }
                }
            },
            _ => BookSyncState::FormatMismatch,
        }
    } else {
        match (resolved_format, validated_remote_extension.as_ref()) {
            (Some(_), Some(_)) => {
                if !remote.file_available {
                    BookSyncState::SourceUnavailable
                } else if index.has_same_title_other_hash(&sanitized_title) {
                    BookSyncState::SameTitleDifferentVersion
                } else {
                    BookSyncState::New
                }
            }
            _ => BookSyncState::FormatMismatch,
        }
    };

    ClassifiedCandidate {
        remote,
        sanitized_title,
        resolved_format,
        validated_remote_extension,
        state,
        local_doc,
        local_extension,
    }
}

/// Phase 1: builds an [`ImportPlan`] for the user-selected catalog books.
///
/// - Classifies each book using local DB hashes + `fs::metadata` (`F-19`), and
///   verifies selected `AlreadyPresent` copies outside `Mutex<Database>` so
///   same-size local modifications are caught as [`BookSyncState::LocalFileChanged`].
/// - Fetches `/position` and `/bookmarks` over `client`'s reused HTTP/1.1
///   keep-alive connection with bounded concurrency (`<= 2`, `R3-02`).
/// - Retains `expected: CursorSnapshot` strictly inside the returned
///   [`ImportPlan`] (`R3-07`).
pub async fn plan_import<F>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    selected_books: &[RemoteCatalogBook],
    config: &OrchestratorConfig,
    cancel: &CancelToken,
    mut on_progress: F,
) -> LanResult<ImportPlan>
where
    F: FnMut(PlanProgress),
{
    if cancel.is_cancelled() {
        return Err(LanError::Cancelled);
    }

    let total_books = selected_books.len();
    if total_books == 0 {
        return Ok(ImportPlan { books: Vec::new() });
    }

    // Step 1: Load local documents and bookmarks once inside a short DB lock,
    // then drop the lock before any filesystem stat/hash or network I/O.
    let db_clone = Arc::clone(db);
    let selected_owned = selected_books.to_vec();
    let limits_clone = config.limits.clone();

    let (candidates, local_bookmarks_by_doc) = tokio::task::spawn_blocking(
        move || -> LanResult<(Vec<ClassifiedCandidate>, LocalBookmarksByDoc)> {
            let (local_docs, all_bookmarks) = {
                let guard = db_clone.lock().map_err(|_| {
                    LanError::Core(CoreError::Io(std::io::Error::other(
                        "database lock poisoned",
                    )))
                })?;
                (guard.list_documents()?, guard.list_bookmarks()?)
            };

            let index = LocalLibraryIndex::from_documents(local_docs);
            let mut bookmarks_by_doc: HashMap<String, Vec<Bookmark>> = HashMap::new();
            for bm in all_bookmarks {
                bookmarks_by_doc
                    .entry(bm.document_id.clone())
                    .or_default()
                    .push(bm);
            }

            let mut candidates = Vec::with_capacity(selected_owned.len());
            for remote in selected_owned {
                let mut candidate = classify_single_stat_only(remote, &index, &limits_clone);
                // Verify selected AlreadyPresent books outside the DB lock so
                // same-size on-disk modifications are classified accurately as
                // LocalFileChanged (never full-library re-hash: F-19).
                if candidate.state == BookSyncState::AlreadyPresent
                    && let Some(ref local) = candidate.local_doc
                    && let Ok(status) = verify_document_file(local)
                {
                    match status.state {
                        DocumentSourceState::Ok => {}
                        DocumentSourceState::Changed => {
                            candidate.state = BookSyncState::LocalFileChanged;
                        }
                        DocumentSourceState::Missing => {
                            candidate.state = if candidate.remote.file_available {
                                BookSyncState::MissingFile
                            } else {
                                BookSyncState::SourceUnavailable
                            };
                        }
                    }
                }
                candidates.push(candidate);
            }

            Ok((candidates, bookmarks_by_doc))
        },
    )
    .await
    .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))))??;

    if cancel.is_cancelled() {
        return Err(LanError::Cancelled);
    }

    // Step 2: Bounded-concurrency (`<= 2`) metadata fetches over PairedClient's
    // reused keep-alive connection pool (`R3-02`).
    let concurrency = config.effective_planner_concurrency();
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let permissions = client.permissions();
    let local_bookmarks_by_doc = Arc::new(local_bookmarks_by_doc);

    let mut join_set: JoinSet<(usize, LanResult<PlannedBook>)> = JoinSet::new();

    for (idx, candidate) in candidates.into_iter().enumerate() {
        let sem = Arc::clone(&semaphore);
        let client = client.clone();
        let cancel = cancel.clone();
        let limits = config.limits.clone();
        let local_bms = Arc::clone(&local_bookmarks_by_doc);

        join_set.spawn(async move {
            let result = plan_single_book(
                candidate,
                &client,
                permissions,
                sem,
                &local_bms,
                &limits,
                &cancel,
            )
            .await;
            (idx, result)
        });
    }

    let mut slots: Vec<Option<PlannedBook>> = (0..total_books).map(|_| None).collect();
    let mut completed_books = 0usize;

    while let Some(joined) = join_set.join_next().await {
        if cancel.is_cancelled() {
            join_set.abort_all();
            return Err(LanError::Cancelled);
        }

        let (idx, outcome) = match joined {
            Ok(pair) => pair,
            Err(err) => {
                join_set.abort_all();
                return Err(LanError::Core(CoreError::Io(std::io::Error::other(
                    format!("planner task failed: {err}"),
                ))));
            }
        };

        match outcome {
            Ok(planned) => {
                let book_id = planned.summary.book_id.clone();
                if let Some(slot) = slots.get_mut(idx) {
                    *slot = Some(planned);
                }
                completed_books += 1;
                on_progress(PlanProgress {
                    completed_books,
                    total_books,
                    book_id,
                });
            }
            Err(err) => {
                join_set.abort_all();
                return Err(err);
            }
        }
    }

    if cancel.is_cancelled() {
        return Err(LanError::Cancelled);
    }

    let books = slots.into_iter().flatten().collect();
    Ok(ImportPlan { books })
}

async fn plan_single_book(
    candidate: ClassifiedCandidate,
    client: &PairedClient,
    permissions: crate::session::SharePermissions,
    semaphore: Arc<Semaphore>,
    local_bookmarks_by_doc: &HashMap<String, Vec<Bookmark>>,
    limits: &ImportLimits,
    cancel: &CancelToken,
) -> LanResult<PlannedBook> {
    if cancel.is_cancelled() {
        return Err(LanError::Cancelled);
    }

    let expected_cursor = candidate
        .local_doc
        .as_ref()
        .map(|doc| CursorSnapshot {
            anchor: doc.last_cursor_anchor.clone(),
            progress: doc.last_progress,
        })
        .unwrap_or_default();

    let display_extension = candidate
        .validated_remote_extension
        .clone()
        .unwrap_or_else(|| candidate.remote.extension.clone());

    if !candidate.state.is_eligible() {
        return Ok(PlannedBook {
            summary: BookPlanSummary {
                book_id: candidate.remote.id,
                title: candidate.sanitized_title,
                format: candidate.resolved_format,
                extension: display_extension,
                size_bytes: candidate.remote.size_bytes,
                state: candidate.state,
                eligible: false,
                needs_file_download: false,
                local_document_id: candidate.local_doc.as_ref().map(|d| d.id.clone()),
                local_title: candidate.local_doc.as_ref().map(|d| d.title.clone()),
                position: PositionPlanSummary {
                    local_has_position: expected_cursor.anchor.is_some(),
                    local_progress: expected_cursor.progress,
                    ..PositionPlanSummary::default()
                },
                bookmarks: BookmarkPlanSummary::default(),
                plan_error: None,
            },
            resolved_format: candidate.resolved_format,
            validated_remote_extension: candidate.validated_remote_extension,
            local_extension: candidate.local_extension,
            expected_cursor,
            conflict_cursor: None,
            remote_cursor: None,
            remote_bookmarks: BTreeMap::new(),
            wire_skipped_bookmarks: 0,
        });
    }

    let should_fetch_position =
        permissions.positions && candidate.remote.has_position != Some(false);
    let should_fetch_bookmarks =
        permissions.bookmarks && candidate.remote.bookmark_count != Some(0);

    let mut fetched_position: Option<ParsedPosition> = None;
    let mut fetched_bookmarks: Option<Vec<ParsedBookmark>> = None;
    let mut plan_error: Option<ImportErrorInfo> = None;
    let mut effective_state = candidate.state;

    if should_fetch_position || should_fetch_bookmarks {
        let _permit = semaphore
            .acquire_owned()
            .await
            .map_err(|_| LanError::Cancelled)?;

        if cancel.is_cancelled() {
            return Err(LanError::Cancelled);
        }

        if should_fetch_position {
            match client.book_position(&candidate.remote.id, cancel).await {
                Ok(pos) => fetched_position = Some(pos),
                Err(err) if is_session_fatal(&err) => return Err(err),
                Err(err) => {
                    plan_error = Some(ImportErrorInfo::from_lan_error(&err));
                    if matches!(err, LanError::SourceChanged(_)) {
                        effective_state = BookSyncState::SourceUnavailable;
                    }
                }
            }
        }

        if plan_error.is_none() && should_fetch_bookmarks {
            if cancel.is_cancelled() {
                return Err(LanError::Cancelled);
            }
            match client.book_bookmarks(&candidate.remote.id, cancel).await {
                Ok(bms) => fetched_bookmarks = Some(bms),
                Err(err) if is_session_fatal(&err) => return Err(err),
                Err(err) => {
                    plan_error = Some(ImportErrorInfo::from_lan_error(&err));
                    if matches!(err, LanError::SourceChanged(_)) {
                        effective_state = BookSyncState::SourceUnavailable;
                    }
                }
            }
        }
    }

    let book_format = candidate.resolved_format;
    let (position_summary, remote_cursor) = build_position_plan(
        fetched_position,
        &expected_cursor,
        book_format,
        effective_state,
        limits,
    );

    let existing_local_bms = candidate
        .local_doc
        .as_ref()
        .and_then(|d| local_bookmarks_by_doc.get(&d.id))
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let (bookmarks_summary, remote_bookmarks, wire_skipped_bookmarks) = build_bookmarks_plan(
        fetched_bookmarks,
        existing_local_bms,
        book_format,
        effective_state,
        limits,
    );

    Ok(PlannedBook {
        summary: BookPlanSummary {
            book_id: candidate.remote.id,
            title: candidate.sanitized_title,
            format: candidate.resolved_format,
            extension: display_extension,
            size_bytes: candidate.remote.size_bytes,
            state: effective_state,
            eligible: effective_state.is_eligible(),
            needs_file_download: effective_state.needs_file_download(),
            local_document_id: candidate.local_doc.as_ref().map(|d| d.id.clone()),
            local_title: candidate.local_doc.as_ref().map(|d| d.title.clone()),
            position: position_summary,
            bookmarks: bookmarks_summary,
            plan_error,
        },
        resolved_format: candidate.resolved_format,
        validated_remote_extension: candidate.validated_remote_extension,
        local_extension: candidate.local_extension,
        expected_cursor,
        conflict_cursor: None,
        remote_cursor,
        remote_bookmarks,
        wire_skipped_bookmarks,
    })
}

fn build_position_plan(
    fetched: Option<ParsedPosition>,
    expected_cursor: &CursorSnapshot,
    book_format: Option<DocumentFormat>,
    state: BookSyncState,
    limits: &ImportLimits,
) -> (PositionPlanSummary, Option<CursorSnapshot>) {
    let local_has_position = expected_cursor.anchor.is_some();
    let local_progress = expected_cursor.progress;

    let Some(parsed) = fetched else {
        return (
            PositionPlanSummary {
                remote_available: false,
                remote_progress: None,
                local_has_position,
                local_progress,
                differs: false,
                skipped_reason: None,
                default_adopt: false,
            },
            None,
        );
    };

    match parsed {
        ParsedPosition::None => (
            PositionPlanSummary {
                remote_available: false,
                remote_progress: None,
                local_has_position,
                local_progress,
                differs: false,
                skipped_reason: None,
                default_adopt: false,
            },
            None,
        ),
        ParsedPosition::Skipped { reason } => (
            PositionPlanSummary {
                remote_available: false,
                remote_progress: None,
                local_has_position,
                local_progress,
                differs: false,
                skipped_reason: Some(reason),
                default_adopt: false,
            },
            None,
        ),
        ParsedPosition::Valid { anchor, progress } => {
            if let Err(err) = anchor.validate() {
                return (
                    PositionPlanSummary {
                        remote_available: false,
                        remote_progress: None,
                        local_has_position,
                        local_progress,
                        differs: false,
                        skipped_reason: Some(err.to_string()),
                        default_adopt: false,
                    },
                    None,
                );
            }
            if book_format.is_some_and(|fmt| anchor.format() != fmt) {
                return (
                    PositionPlanSummary {
                        remote_available: false,
                        remote_progress: None,
                        local_has_position,
                        local_progress,
                        differs: false,
                        skipped_reason: Some(
                            "position anchor format does not match book format".into(),
                        ),
                        default_adopt: false,
                    },
                    None,
                );
            }
            if !check_anchor_limits(&anchor, limits) {
                return (
                    PositionPlanSummary {
                        remote_available: false,
                        remote_progress: None,
                        local_has_position,
                        local_progress,
                        differs: false,
                        skipped_reason: Some("position anchor exceeded size limits".into()),
                        default_adopt: false,
                    },
                    None,
                );
            }

            let sanitized_progress = progress.filter(|p| p.is_finite() && (0.0..=1.0).contains(p));
            let remote_snapshot = CursorSnapshot {
                anchor: Some(anchor),
                progress: sanitized_progress,
            };
            let differs = !remote_snapshot.matches(expected_cursor);
            let default_adopt = state.is_eligible()
                && differs
                && (matches!(
                    state,
                    BookSyncState::New | BookSyncState::SameTitleDifferentVersion
                ) || !local_has_position);

            (
                PositionPlanSummary {
                    remote_available: true,
                    remote_progress: sanitized_progress,
                    local_has_position,
                    local_progress,
                    differs,
                    skipped_reason: None,
                    default_adopt,
                },
                Some(remote_snapshot),
            )
        }
    }
}

fn build_bookmarks_plan(
    fetched: Option<Vec<ParsedBookmark>>,
    existing_local: &[Bookmark],
    book_format: Option<DocumentFormat>,
    state: BookSyncState,
    limits: &ImportLimits,
) -> (
    BookmarkPlanSummary,
    BTreeMap<usize, ImportBookmarkEntry>,
    usize,
) {
    let Some(parsed_list) = fetched else {
        return (BookmarkPlanSummary::default(), BTreeMap::new(), 0);
    };

    let existing_keys: HashSet<String> = existing_local
        .iter()
        .map(|bm| bm.anchor.location_key())
        .collect();
    let existing_count = existing_local.len();

    let mut seen_new_keys: HashSet<String> = HashSet::new();
    let mut planned_new = 0usize;
    let mut planned_existing = 0usize;
    let mut planned_skipped = 0usize;
    let mut wire_skipped = 0usize;
    let mut previews = Vec::with_capacity(parsed_list.len());
    let mut valid_entries = BTreeMap::new();

    for (index, item) in parsed_list.into_iter().enumerate() {
        match item {
            ParsedBookmark::Skipped { reason, .. } => {
                planned_skipped += 1;
                wire_skipped += 1;
                previews.push(PlannedBookmarkPreview {
                    index,
                    label: None,
                    created_at: None,
                    status: PlannedBookmarkStatus::Skipped {
                        reason: BookmarkPlanSkipReason::UnsupportedAnchor { reason },
                    },
                });
            }
            ParsedBookmark::Valid(wire) => {
                if wire.anchor.validate().is_err() {
                    planned_skipped += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: wire.label,
                        created_at: wire.created_at,
                        status: PlannedBookmarkStatus::Skipped {
                            reason: BookmarkPlanSkipReason::InvalidAnchor,
                        },
                    });
                    continue;
                }
                if book_format.is_some_and(|fmt| wire.anchor.format() != fmt) {
                    planned_skipped += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: wire.label,
                        created_at: wire.created_at,
                        status: PlannedBookmarkStatus::Skipped {
                            reason: BookmarkPlanSkipReason::FormatMismatch,
                        },
                    });
                    continue;
                }
                if !check_anchor_limits(&wire.anchor, limits) {
                    planned_skipped += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: wire.label,
                        created_at: wire.created_at,
                        status: PlannedBookmarkStatus::Skipped {
                            reason: BookmarkPlanSkipReason::AnchorLimitExceeded,
                        },
                    });
                    continue;
                }

                let sanitized_label =
                    sanitize_bookmark_label(wire.label.as_deref(), &wire.anchor, limits);
                let key = wire.anchor.location_key();

                if existing_keys.contains(&key) || seen_new_keys.contains(&key) {
                    planned_existing += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: Some(sanitized_label),
                        created_at: wire.created_at.clone(),
                        status: PlannedBookmarkStatus::Existing,
                    });
                    // Keep valid entries keyed by preview index so
                    // Database::import_bookmarks reports accurate `existing`
                    // counts and stays idempotent.
                    valid_entries.insert(
                        index,
                        ImportBookmarkEntry {
                            anchor: wire.anchor,
                            label: wire.label,
                            created_at: wire.created_at,
                        },
                    );
                } else if existing_count.saturating_add(planned_new)
                    >= limits.max_bookmarks_per_book
                {
                    planned_skipped += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: Some(sanitized_label),
                        created_at: wire.created_at.clone(),
                        status: PlannedBookmarkStatus::Skipped {
                            reason: BookmarkPlanSkipReason::BookmarkCapExceeded,
                        },
                    });
                    valid_entries.insert(
                        index,
                        ImportBookmarkEntry {
                            anchor: wire.anchor,
                            label: wire.label,
                            created_at: wire.created_at,
                        },
                    );
                } else {
                    seen_new_keys.insert(key);
                    planned_new += 1;
                    previews.push(PlannedBookmarkPreview {
                        index,
                        label: Some(sanitized_label),
                        created_at: wire.created_at.clone(),
                        status: PlannedBookmarkStatus::New,
                    });
                    valid_entries.insert(
                        index,
                        ImportBookmarkEntry {
                            anchor: wire.anchor,
                            label: wire.label,
                            created_at: wire.created_at,
                        },
                    );
                }
            }
        }
    }

    // OD-8: bookmarks default ON for healthy eligible books when there are new bookmarks.
    let default_import = state.is_eligible() && planned_new > 0;

    (
        BookmarkPlanSummary {
            new_count: planned_new,
            existing_count: planned_existing,
            skipped_count: planned_skipped,
            entries: previews,
            default_import,
        },
        valid_entries,
        wire_skipped,
    )
}

/// Phase 2: executes selected imports sequentially (1 file transfer at a time),
/// committing per book in order: `file -> position -> bookmarks`.
///
/// Invokes `on_commit` with the committed/repaired [`Document`] and newly
/// inserted [`Bookmark`]s **before** invoking `on_progress` with
/// [`ImportProgress::BookCompleted`] (`R2-07`).
#[allow(clippy::too_many_arguments)]
pub async fn execute_import<FC, FP>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    library: &ManagedLibrary,
    plan: &mut ImportPlan,
    decisions: &[BookImportDecision],
    config: &OrchestratorConfig,
    cancel: &CancelToken,
    on_commit: FC,
    on_progress: FP,
) -> ImportExecutionReport
where
    FC: FnMut(BookCommitEvent),
    FP: FnMut(ImportProgress),
{
    execute_import_with_stage_factory(
        client,
        db,
        library,
        plan,
        decisions,
        config,
        cancel,
        &DefaultStageFactory,
        on_commit,
        on_progress,
    )
    .await
}

#[cfg(test)]
pub(crate) type BeforeFileDownloadHook = Arc<dyn Fn(&str) + Send + Sync>;
#[cfg(test)]
pub(crate) type BeforeImportDocumentHook = Arc<dyn Fn(&str, &Path) + Send + Sync>;
#[cfg(test)]
pub(crate) type BeforeMetadataWritesHook = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Test-only deterministic synchronization hooks for exercising race windows
/// between pre-checks, staging, DB commits, and metadata writes.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct ExecuteTestHooks {
    pub before_file_download: Option<BeforeFileDownloadHook>,
    pub before_import_document: Option<BeforeImportDocumentHook>,
    pub before_metadata_writes: Option<BeforeMetadataWritesHook>,
}

/// Same as [`execute_import`] with an injectable [`StageFactory`] for
/// deterministic `ENOSPC` / `EDQUOT` testing (`T-22`).
#[allow(clippy::too_many_arguments)]
pub async fn execute_import_with_stage_factory<FC, FP>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    library: &ManagedLibrary,
    plan: &mut ImportPlan,
    decisions: &[BookImportDecision],
    config: &OrchestratorConfig,
    cancel: &CancelToken,
    stage_factory: &dyn StageFactory,
    on_commit: FC,
    on_progress: FP,
) -> ImportExecutionReport
where
    FC: FnMut(BookCommitEvent),
    FP: FnMut(ImportProgress),
{
    execute_import_inner(
        client,
        db,
        library,
        plan,
        decisions,
        config,
        cancel,
        stage_factory,
        #[cfg(test)]
        &ExecuteTestHooks::default(),
        on_commit,
        on_progress,
    )
    .await
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_import_with_test_hooks<FC, FP>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    library: &ManagedLibrary,
    plan: &mut ImportPlan,
    decisions: &[BookImportDecision],
    config: &OrchestratorConfig,
    cancel: &CancelToken,
    stage_factory: &dyn StageFactory,
    hooks: &ExecuteTestHooks,
    on_commit: FC,
    on_progress: FP,
) -> ImportExecutionReport
where
    FC: FnMut(BookCommitEvent),
    FP: FnMut(ImportProgress),
{
    execute_import_inner(
        client,
        db,
        library,
        plan,
        decisions,
        config,
        cancel,
        stage_factory,
        hooks,
        on_commit,
        on_progress,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_import_inner<FC, FP>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    library: &ManagedLibrary,
    plan: &mut ImportPlan,
    decisions: &[BookImportDecision],
    config: &OrchestratorConfig,
    cancel: &CancelToken,
    stage_factory: &dyn StageFactory,
    #[cfg(test)] hooks: &ExecuteTestHooks,
    mut on_commit: FC,
    mut on_progress: FP,
) -> ImportExecutionReport
where
    FC: FnMut(BookCommitEvent),
    FP: FnMut(ImportProgress),
{
    let total_books = decisions.len();
    let mut results = Vec::with_capacity(total_books);
    let mut cancelled = false;
    let mut session_error: Option<ImportErrorInfo> = None;

    for (book_index, decision) in decisions.iter().enumerate() {
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }

        let Some(planned) = plan.find_mut(&decision.book_id) else {
            let result = BookImportResult {
                book_id: decision.book_id.clone(),
                document_id: None,
                state: BookSyncState::SourceUnavailable,
                file: ComponentOutcome::Failed {
                    error: ImportErrorInfo::new(
                        "not_found",
                        "book is not present in the active import plan",
                    ),
                },
                position: ComponentOutcome::Blocked {
                    reason: "book is not present in the active import plan".into(),
                },
                bookmarks: ComponentOutcome::Blocked {
                    reason: "book is not present in the active import plan".into(),
                },
                bookmark_counts: BookmarkExecutionSummary::default(),
            };
            on_progress(ImportProgress::BookCompleted {
                book_id: decision.book_id.clone(),
                book_index,
                total_books,
                result: Box::new(result.clone()),
            });
            results.push(result);
            continue;
        };

        on_progress(ImportProgress::BookStarted {
            book_id: decision.book_id.clone(),
            book_index,
            total_books,
        });

        let (result, book_cancelled, book_session_error) = execute_single_book(
            client,
            db,
            library,
            planned,
            decision,
            &config.limits,
            cancel,
            stage_factory,
            #[cfg(test)]
            hooks,
            &mut on_commit,
            &mut on_progress,
            book_index,
            total_books,
        )
        .await;

        results.push(result);

        if book_cancelled {
            cancelled = true;
            break;
        }
        if let Some(fatal) = book_session_error {
            session_error = Some(fatal);
            break;
        }
    }

    ImportExecutionReport {
        books: results,
        cancelled,
        session_error,
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_single_book<FC, FP>(
    client: &PairedClient,
    db: &Arc<Mutex<Database>>,
    library: &ManagedLibrary,
    planned: &mut PlannedBook,
    decision: &BookImportDecision,
    limits: &ImportLimits,
    cancel: &CancelToken,
    stage_factory: &dyn StageFactory,
    #[cfg(test)] hooks: &ExecuteTestHooks,
    on_commit: &mut FC,
    on_progress: &mut FP,
    book_index: usize,
    total_books: usize,
) -> (BookImportResult, bool, Option<ImportErrorInfo>)
where
    FC: FnMut(BookCommitEvent),
    FP: FnMut(ImportProgress),
{
    let book_id = planned.summary.book_id.clone();

    if !planned.summary.eligible {
        let reason = format!("book is ineligible ({:?})", planned.summary.state);
        let result = BookImportResult {
            book_id: book_id.clone(),
            document_id: planned.summary.local_document_id.clone(),
            state: planned.summary.state,
            file: ComponentOutcome::Skipped {
                reason: Some(reason.clone()),
            },
            position: ComponentOutcome::Skipped {
                reason: Some(reason.clone()),
            },
            bookmarks: ComponentOutcome::Skipped {
                reason: Some(reason),
            },
            bookmark_counts: BookmarkExecutionSummary::default(),
        };
        on_progress(ImportProgress::BookCompleted {
            book_id,
            book_index,
            total_books,
            result: Box::new(result.clone()),
        });
        return (result, false, None);
    }

    let Some(book_format) = planned.resolved_format else {
        let result = BookImportResult {
            book_id: book_id.clone(),
            document_id: planned.summary.local_document_id.clone(),
            state: BookSyncState::FormatMismatch,
            file: ComponentOutcome::Failed {
                error: ImportErrorInfo::new("unsupported_format", "unsupported document format"),
            },
            position: ComponentOutcome::Blocked {
                reason: "unsupported document format".into(),
            },
            bookmarks: ComponentOutcome::Blocked {
                reason: "unsupported document format".into(),
            },
            bookmark_counts: BookmarkExecutionSummary::default(),
        };
        on_progress(ImportProgress::BookCompleted {
            book_id,
            book_index,
            total_books,
            result: Box::new(result.clone()),
        });
        return (result, false, None);
    };

    // ---- Step 1: File transfer / local re-verification --------------------
    let file_outcome;
    let mut file_commit_result: Option<ImportDocumentResult> = None;
    let target_doc: Document;

    if planned.summary.needs_file_download {
        if !decision.import_file {
            let reason = "file import was not selected".to_owned();
            let result = BookImportResult {
                book_id: book_id.clone(),
                document_id: planned.summary.local_document_id.clone(),
                state: planned.summary.state,
                file: ComponentOutcome::Skipped {
                    reason: Some(reason.clone()),
                },
                position: if decision.import_position {
                    ComponentOutcome::Blocked {
                        reason: reason.clone(),
                    }
                } else {
                    ComponentOutcome::Skipped { reason: None }
                },
                bookmarks: if decision.import_bookmarks {
                    ComponentOutcome::Blocked { reason }
                } else {
                    ComponentOutcome::Skipped { reason: None }
                },
                bookmark_counts: BookmarkExecutionSummary::default(),
            };
            on_progress(ImportProgress::BookCompleted {
                book_id,
                book_index,
                total_books,
                result: Box::new(result.clone()),
            });
            return (result, false, None);
        }

        #[cfg(test)]
        if let Some(hook) = &hooks.before_file_download {
            hook(&book_id);
        }

        // Pre-transfer dedup check (`T-26`): if a healthy local copy with the
        // same SHA-256 was registered after `plan_import`, reuse it directly
        // without transferring any file bytes.
        let precheck = find_and_verify_local_by_hash(db, &book_id).await;
        match precheck {
            Ok(Some((existing_doc, DocumentSourceState::Ok))) => {
                target_doc = existing_doc;
                file_outcome = ComponentOutcome::Skipped {
                    reason: Some("already present locally".into()),
                };
                planned.summary.local_document_id = Some(target_doc.id.clone());
                planned.summary.state = BookSyncState::AlreadyPresent;
                planned.summary.needs_file_download = false;
            }
            Ok(Some((existing_doc, DocumentSourceState::Changed))) => {
                planned.summary.state = BookSyncState::LocalFileChanged;
                planned.summary.eligible = false;
                let reason = "local file changed on disk; book is ineligible".to_owned();
                let result = local_file_changed_result(
                    book_id.clone(),
                    Some(existing_doc.id),
                    reason,
                    decision,
                );
                on_progress(ImportProgress::BookCompleted {
                    book_id,
                    book_index,
                    total_books,
                    result: Box::new(result.clone()),
                });
                return (result, false, None);
            }
            Ok(None) | Ok(Some((_, DocumentSourceState::Missing))) => {
                // Pre-publish extension resolution (`R2-01`, `R3-08`):
                // Check DB before calling `StagedFile::finish()` to preserve any
                // existing missing local record's original valid extension (e.g. `.md`
                // under `format: "txt"`).
                let remote_ext = planned
                    .validated_remote_extension
                    .clone()
                    .unwrap_or_else(|| planned.summary.extension.clone());
                let resolved_ext = match resolve_pre_publish_extension(
                    db,
                    &book_id,
                    book_format,
                    &remote_ext,
                    planned.local_extension.as_deref(),
                )
                .await
                {
                    Ok(ext) => ext,
                    Err(err) => {
                        let err_info = ImportErrorInfo::from_lan_error(&err);
                        let result = failed_file_result(
                            book_id.clone(),
                            planned.summary.local_document_id.clone(),
                            planned.summary.state,
                            err_info,
                            decision,
                        );
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, None);
                    }
                };

                let staged = match stage_factory.begin_stage(
                    library,
                    book_format,
                    &resolved_ext,
                    &book_id,
                    planned.summary.size_bytes,
                ) {
                    Ok(staged) => staged,
                    Err(err) => {
                        let lan_err = map_core_storage_error(err, planned.summary.size_bytes, 0);
                        let err_info = ImportErrorInfo::from_lan_error(&lan_err);
                        let result = failed_file_result(
                            book_id.clone(),
                            planned.summary.local_document_id.clone(),
                            planned.summary.state,
                            err_info,
                            decision,
                        );
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, None);
                    }
                };

                let progress_book_id = book_id.clone();
                let download_res = client
                    .download_book_into_published(&book_id, staged, cancel, |downloaded, total| {
                        on_progress(ImportProgress::FileTransfer {
                            book_id: progress_book_id.clone(),
                            downloaded_bytes: downloaded,
                            total_bytes: total,
                        });
                    })
                    .await;

                let published = match download_res {
                    Ok(published) => published,
                    Err(LanError::Cancelled) => {
                        let result = BookImportResult {
                            book_id: book_id.clone(),
                            document_id: planned.summary.local_document_id.clone(),
                            state: planned.summary.state,
                            file: ComponentOutcome::Cancelled,
                            position: if decision.import_position {
                                ComponentOutcome::Cancelled
                            } else {
                                ComponentOutcome::Skipped { reason: None }
                            },
                            bookmarks: if decision.import_bookmarks {
                                ComponentOutcome::Cancelled
                            } else {
                                ComponentOutcome::Skipped { reason: None }
                            },
                            bookmark_counts: BookmarkExecutionSummary::default(),
                        };
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, true, None);
                    }
                    Err(err) => {
                        let fatal =
                            is_session_fatal(&err).then(|| ImportErrorInfo::from_lan_error(&err));
                        let err_info = ImportErrorInfo::from_lan_error(&err);
                        let result = failed_file_result(
                            book_id.clone(),
                            planned.summary.local_document_id.clone(),
                            planned.summary.state,
                            err_info,
                            decision,
                        );
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, fatal);
                    }
                };

                #[cfg(test)]
                if let Some(hook) = &hooks.before_import_document {
                    hook(&book_id, published.path());
                }

                // Commit imported/repaired document row inside a short DB lock
                // while holding `published`'s cross-process shared lease.
                //
                // - If a concurrent local registration won (`AlreadyPresent`):
                //   release our shared lease and remove the managed copy ONLY
                //   if we created it, can acquire the exclusive coordination
                //   lock (proving no other importer is reusing it in-flight),
                //   and confirm no DB row references it (`T-26`). Then verify
                //   the winning local copy's actual on-disk content outside
                //   `Mutex<Database>` before allowing position/bookmark writes.
                let db_clone = Arc::clone(db);
                let library_clone = library.clone();
                let hash_clone = book_id.clone();
                let title_clone = planned.summary.title.clone();
                let import_res = tokio::task::spawn_blocking(
                    move || -> LanResult<(ImportDocumentResult, Option<DocumentSourceState>)> {
                        let first_attempt = {
                            let mut guard = db_clone.lock().map_err(|_| {
                                LanError::Core(CoreError::Io(std::io::Error::other(
                                    "database lock poisoned",
                                )))
                            })?;
                            match guard.import_document(
                                published.path(),
                                &hash_clone,
                                &title_clone,
                                book_format,
                            ) {
                                Ok(res) => Ok(res),
                                Err(CoreError::UnsupportedFormat(_)) => {
                                    // A missing local record with a different
                                    // validated extension (e.g. `.md` / `.markdown`
                                    // under `format: "txt"`) appeared after
                                    // pre-publish extension selection. Read its
                                    // required extension under the short lock,
                                    // then re-publish outside `Mutex<Database>`.
                                    let required_ext = missing_local_extension_locked(
                                        &guard,
                                        &hash_clone,
                                        book_format,
                                    )?;
                                    Err(required_ext)
                                }
                                Err(err) => {
                                    let _ = published.cleanup_if_unreferenced(|path| {
                                        is_path_referenced_by_db(&guard, path)
                                    });
                                    return Err(err.into());
                                }
                            }
                        };

                        let doc_res = match first_attempt {
                            Ok(res) => {
                                if matches!(res, ImportDocumentResult::AlreadyPresent(_)) {
                                    let guard = db_clone.lock().map_err(|_| {
                                        LanError::Core(CoreError::Io(std::io::Error::other(
                                            "database lock poisoned",
                                        )))
                                    })?;
                                    let _ = published.cleanup_if_unreferenced(|path| {
                                        is_path_referenced_by_db(&guard, path)
                                    });
                                } else {
                                    drop(published);
                                }
                                res
                            }
                            Err(Some(required_ext)) => {
                                // Republish verified bytes under `required_ext`
                                // outside `Mutex<Database>` while `published`'s
                                // shared lease protects the source file.
                                let republished = match republish_with_extension(
                                    &library_clone,
                                    published.path(),
                                    book_format,
                                    &required_ext,
                                    &hash_clone,
                                ) {
                                    Ok(repub) => repub,
                                    Err(err) => {
                                        if let Ok(guard) = db_clone.lock() {
                                            let _ = published.cleanup_if_unreferenced(|path| {
                                                is_path_referenced_by_db(&guard, path)
                                            });
                                        }
                                        return Err(err);
                                    }
                                };

                                let mut guard = db_clone.lock().map_err(|_| {
                                    LanError::Core(CoreError::Io(std::io::Error::other(
                                        "database lock poisoned",
                                    )))
                                })?;
                                match guard.import_document(
                                    republished.path(),
                                    &hash_clone,
                                    &title_clone,
                                    book_format,
                                ) {
                                    Ok(res) => {
                                        if matches!(res, ImportDocumentResult::AlreadyPresent(_)) {
                                            let _ = republished.cleanup_if_unreferenced(|path| {
                                                is_path_referenced_by_db(&guard, path)
                                            });
                                        } else {
                                            drop(republished);
                                        }
                                        // Clean up the unused original extension
                                        // copy now that `republished` is dropped.
                                        let _ = published.cleanup_if_unreferenced(|path| {
                                            is_path_referenced_by_db(&guard, path)
                                        });
                                        res
                                    }
                                    Err(err) => {
                                        let _ = republished.cleanup_if_unreferenced(|path| {
                                            is_path_referenced_by_db(&guard, path)
                                        });
                                        let _ = published.cleanup_if_unreferenced(|path| {
                                            is_path_referenced_by_db(&guard, path)
                                        });
                                        return Err(err.into());
                                    }
                                }
                            }
                            Err(None) => {
                                if let Ok(guard) = db_clone.lock() {
                                    let _ = published.cleanup_if_unreferenced(|path| {
                                        is_path_referenced_by_db(&guard, path)
                                    });
                                }
                                return Err(LanError::Core(CoreError::UnsupportedFormat(
                                    "document extension changed concurrently during repair".into(),
                                )));
                            }
                        };

                        // Unlocked content verification for post-publish
                        // `AlreadyPresent` reuse (identical safety guarantee to
                        // pre-transfer reuse).
                        let verified_state =
                            if let ImportDocumentResult::AlreadyPresent(ref existing_doc) = doc_res
                            {
                                let status = verify_document_file(existing_doc)?;
                                Some(status.state)
                            } else {
                                None
                            };

                        Ok((doc_res, verified_state))
                    },
                )
                .await
                .map_err(|err| {
                    LanError::Core(CoreError::Io(std::io::Error::other(err.to_string())))
                });

                match import_res {
                    Ok(Ok((
                        ImportDocumentResult::AlreadyPresent(existing_doc),
                        Some(DocumentSourceState::Ok),
                    ))) => {
                        target_doc = existing_doc;
                        file_outcome = ComponentOutcome::Skipped {
                            reason: Some("already present locally".into()),
                        };
                        planned.summary.local_document_id = Some(target_doc.id.clone());
                        planned.summary.state = BookSyncState::AlreadyPresent;
                        planned.summary.needs_file_download = false;
                    }
                    Ok(Ok((
                        ImportDocumentResult::AlreadyPresent(existing_doc),
                        Some(DocumentSourceState::Changed),
                    ))) => {
                        planned.summary.local_document_id = Some(existing_doc.id.clone());
                        planned.summary.state = BookSyncState::LocalFileChanged;
                        planned.summary.eligible = false;
                        planned.summary.needs_file_download = false;
                        let reason = "local file changed on disk; book is ineligible".to_owned();
                        let result = local_file_changed_result(
                            book_id.clone(),
                            Some(existing_doc.id),
                            reason,
                            decision,
                        );
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, None);
                    }
                    Ok(Ok((
                        ImportDocumentResult::AlreadyPresent(existing_doc),
                        Some(DocumentSourceState::Missing) | None,
                    ))) => {
                        planned.summary.local_document_id = Some(existing_doc.id.clone());
                        planned.summary.state = BookSyncState::MissingFile;
                        planned.summary.needs_file_download = true;
                        let reason = "local file is missing on disk".to_owned();
                        let result = BookImportResult {
                            book_id: book_id.clone(),
                            document_id: Some(existing_doc.id),
                            state: BookSyncState::MissingFile,
                            file: ComponentOutcome::Failed {
                                error: ImportErrorInfo::new("not_found", reason.clone()),
                            },
                            position: if decision.import_position {
                                ComponentOutcome::Blocked {
                                    reason: reason.clone(),
                                }
                            } else {
                                ComponentOutcome::Skipped { reason: None }
                            },
                            bookmarks: if decision.import_bookmarks {
                                ComponentOutcome::Blocked { reason }
                            } else {
                                ComponentOutcome::Skipped { reason: None }
                            },
                            bookmark_counts: BookmarkExecutionSummary::default(),
                        };
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, None);
                    }
                    Ok(Ok((doc_res, _))) => {
                        target_doc = doc_res.document().clone();
                        file_commit_result = Some(doc_res);
                        file_outcome = ComponentOutcome::Applied;
                        planned.summary.local_document_id = Some(target_doc.id.clone());
                        planned.summary.state = BookSyncState::AlreadyPresent;
                        planned.summary.needs_file_download = false;
                    }
                    Ok(Err(err)) | Err(err) => {
                        let err_info = ImportErrorInfo::from_lan_error(&err);
                        let result = failed_file_result(
                            book_id.clone(),
                            planned.summary.local_document_id.clone(),
                            planned.summary.state,
                            err_info,
                            decision,
                        );
                        on_progress(ImportProgress::BookCompleted {
                            book_id,
                            book_index,
                            total_books,
                            result: Box::new(result.clone()),
                        });
                        return (result, false, None);
                    }
                }
            }
            Err(err) => {
                let err_info = ImportErrorInfo::from_lan_error(&err);
                let result = failed_file_result(
                    book_id.clone(),
                    planned.summary.local_document_id.clone(),
                    planned.summary.state,
                    err_info,
                    decision,
                );
                on_progress(ImportProgress::BookCompleted {
                    book_id,
                    book_index,
                    total_books,
                    result: Box::new(result.clone()),
                });
                return (result, false, None);
            }
        }
    } else {
        // AlreadyPresent: 0 file bytes transferred (`T-34`).
        // Verify that the target DB record still carries the planned SHA-256
        // hash (catching relinks after preview) AND re-verify the local file
        // via unlocked `verify_document_file` outside `Mutex<Database>`.
        let db_clone = Arc::clone(db);
        let doc_id_hint = planned.summary.local_document_id.clone();
        let hash_clone = book_id.clone();

        let verified = tokio::task::spawn_blocking(
            move || -> LanResult<(Document, DocumentSourceState, bool)> {
                let doc = {
                    let guard = db_clone.lock().map_err(|_| {
                        LanError::Core(CoreError::Io(std::io::Error::other(
                            "database lock poisoned",
                        )))
                    })?;
                    if let Some(id) = doc_id_hint {
                        guard.get_document(&id)?
                    } else {
                        guard
                            .list_documents()?
                            .into_iter()
                            .find(|d| d.file_hash == hash_clone)
                            .ok_or_else(|| CoreError::NotFound {
                                entity: "document",
                                id: hash_clone.clone(),
                            })?
                    }
                };
                if doc.file_hash != hash_clone {
                    return Ok((doc, DocumentSourceState::Changed, true));
                }
                // Unlocked hash verification outside Mutex<Database>.
                let status = verify_document_file(&doc)?;
                Ok((doc, status.state, false))
            },
        )
        .await
        .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))));

        match verified {
            Ok(Ok((doc, DocumentSourceState::Ok, false))) => {
                target_doc = doc;
                file_outcome = ComponentOutcome::Skipped {
                    reason: Some("already present locally".into()),
                };
            }
            Ok(Ok((doc, DocumentSourceState::Changed, relinked)))
            | Ok(Ok((doc, _, relinked @ true))) => {
                planned.summary.state = BookSyncState::LocalFileChanged;
                planned.summary.eligible = false;
                let reason = if relinked {
                    "local document was relinked to a different file after preview; book is ineligible"
                        .to_owned()
                } else {
                    "local file changed on disk; book is ineligible".to_owned()
                };
                let result =
                    local_file_changed_result(book_id.clone(), Some(doc.id), reason, decision);
                on_progress(ImportProgress::BookCompleted {
                    book_id,
                    book_index,
                    total_books,
                    result: Box::new(result.clone()),
                });
                return (result, false, None);
            }
            Ok(Ok((doc, DocumentSourceState::Missing, false))) => {
                planned.summary.state = BookSyncState::MissingFile;
                planned.summary.needs_file_download = true;
                let reason = "local file is missing on disk".to_owned();
                let result = BookImportResult {
                    book_id: book_id.clone(),
                    document_id: Some(doc.id),
                    state: BookSyncState::MissingFile,
                    file: ComponentOutcome::Failed {
                        error: ImportErrorInfo::new("not_found", reason.clone()),
                    },
                    position: if decision.import_position {
                        ComponentOutcome::Blocked {
                            reason: reason.clone(),
                        }
                    } else {
                        ComponentOutcome::Skipped { reason: None }
                    },
                    bookmarks: if decision.import_bookmarks {
                        ComponentOutcome::Blocked { reason }
                    } else {
                        ComponentOutcome::Skipped { reason: None }
                    },
                    bookmark_counts: BookmarkExecutionSummary::default(),
                };
                on_progress(ImportProgress::BookCompleted {
                    book_id,
                    book_index,
                    total_books,
                    result: Box::new(result.clone()),
                });
                return (result, false, None);
            }
            Ok(Err(err)) | Err(err) => {
                let err_info = ImportErrorInfo::from_lan_error(&err);
                let result = failed_file_result(
                    book_id.clone(),
                    planned.summary.local_document_id.clone(),
                    planned.summary.state,
                    err_info,
                    decision,
                );
                on_progress(ImportProgress::BookCompleted {
                    book_id,
                    book_index,
                    total_books,
                    result: Box::new(result.clone()),
                });
                return (result, false, None);
            }
        }
    }

    #[cfg(test)]
    if let Some(hook) = &hooks.before_metadata_writes {
        hook(&book_id, &target_doc.id);
    }

    // ---- Step 2: Position (`Database::replace_cursor_if_for_hash`) --------
    let mut position_replaced = false;
    let mut target_relinked = false;
    let position_outcome = if !decision.import_position {
        ComponentOutcome::Skipped { reason: None }
    } else if let Some(next_cursor) = planned.remote_cursor.clone() {
        // First execution ALWAYS uses the preview `expected_cursor` snapshot
        // even if `override_position_conflict` is set. Re-confirmation only
        // applies to a conflict snapshot already recorded on this plan for
        // this book; if the cursor changes again after conflict, CAS returns
        // a fresh conflict.
        let expected_for_cas = if decision.override_position_conflict {
            planned
                .conflict_cursor
                .clone()
                .unwrap_or_else(|| planned.expected_cursor.clone())
        } else {
            planned.expected_cursor.clone()
        };

        let db_clone = Arc::clone(db);
        let doc_id = target_doc.id.clone();
        let expected_hash = book_id.clone();
        let expected_path = target_doc.file_path.clone();
        let cas_res = tokio::task::spawn_blocking(move || -> LanResult<ReplaceCursorResult> {
            let mut guard = db_clone.lock().map_err(|_| {
                LanError::Core(CoreError::Io(std::io::Error::other(
                    "database lock poisoned",
                )))
            })?;
            Ok(guard.replace_cursor_if_for_target(
                &doc_id,
                &expected_hash,
                &expected_path,
                &expected_for_cas,
                &next_cursor,
            )?)
        })
        .await
        .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))));

        match cas_res {
            Ok(Ok(ReplaceCursorResult::Replaced)) => {
                position_replaced = true;
                if let Some(ref applied) = planned.remote_cursor {
                    planned.expected_cursor = applied.clone();
                }
                planned.conflict_cursor = None;
                ComponentOutcome::Applied
            }
            Ok(Ok(ReplaceCursorResult::Conflict { current })) => {
                let has_current_position = current.anchor.is_some();
                let current_progress = current.progress;
                // Hold the conflicting cursor strictly in Rust for explicit
                // per-book re-confirmation (`R3-07`, `T-35`, `T-36`).
                planned.conflict_cursor = Some(current);
                ComponentOutcome::Conflict {
                    code: "lan_position_conflict".to_owned(),
                    has_current_position,
                    current_progress,
                }
            }
            Ok(Err(LanError::Core(CoreError::LanHashMismatch(_)))) => {
                target_relinked = true;
                planned.summary.state = BookSyncState::LocalFileChanged;
                planned.summary.eligible = false;
                ComponentOutcome::Failed {
                    error: ImportErrorInfo::new(
                        "lan_local_file_changed",
                        "local document was relinked to a different file before position update",
                    ),
                }
            }
            Ok(Err(err)) | Err(err) => ComponentOutcome::Failed {
                error: ImportErrorInfo::from_lan_error(&err),
            },
        }
    } else {
        ComponentOutcome::Skipped {
            reason: planned
                .summary
                .position
                .skipped_reason
                .clone()
                .or_else(|| Some("no remote position available".into())),
        }
    };

    // ---- Step 3: Bookmarks (`Database::import_bookmarks_for_hash`) --------
    let mut inserted_bookmarks = Vec::new();
    let mut bookmark_counts = BookmarkExecutionSummary::default();

    let bookmarks_outcome = if !decision.import_bookmarks {
        ComponentOutcome::Skipped { reason: None }
    } else if target_relinked {
        ComponentOutcome::Blocked {
            reason: "local document was relinked to a different file".into(),
        }
    } else {
        match select_planned_bookmarks(planned, decision.selected_bookmark_indices.as_deref()) {
            Ok(SelectedBookmarks::Skip(reason)) => ComponentOutcome::Skipped {
                reason: Some(reason),
            },
            Err(err_info) => ComponentOutcome::Failed { error: err_info },
            Ok(SelectedBookmarks::Entries {
                entries,
                include_wire_skipped,
            }) => {
                let db_clone = Arc::clone(db);
                let doc_id = target_doc.id.clone();
                let expected_hash = book_id.clone();
                let expected_path = target_doc.file_path.clone();
                let limits_clone = limits.clone();
                let wire_skipped = if include_wire_skipped {
                    planned.wire_skipped_bookmarks
                } else {
                    0
                };

                let bm_res = tokio::task::spawn_blocking(move || -> LanResult<_> {
                    let mut guard = db_clone.lock().map_err(|_| {
                        LanError::Core(CoreError::Io(std::io::Error::other(
                            "database lock poisoned",
                        )))
                    })?;
                    Ok(guard.import_bookmarks_for_target(
                        &doc_id,
                        &expected_hash,
                        &expected_path,
                        &entries,
                        &limits_clone,
                    )?)
                })
                .await
                .map_err(|err| {
                    LanError::Core(CoreError::Io(std::io::Error::other(err.to_string())))
                });

                match bm_res {
                    Ok(Ok(report)) => {
                        bookmark_counts = BookmarkExecutionSummary {
                            inserted: report.inserted,
                            existing: report.existing,
                            skipped: report.skipped.saturating_add(wire_skipped),
                        };
                        inserted_bookmarks = report.inserted_bookmarks;
                        ComponentOutcome::Applied
                    }
                    Ok(Err(LanError::Core(CoreError::LanHashMismatch(_)))) => {
                        planned.summary.state = BookSyncState::LocalFileChanged;
                        planned.summary.eligible = false;
                        ComponentOutcome::Failed {
                            error: ImportErrorInfo::new(
                                "lan_local_file_changed",
                                "local document was relinked to a different file before bookmark import",
                            ),
                        }
                    }
                    Ok(Err(err)) | Err(err) => ComponentOutcome::Failed {
                        error: ImportErrorInfo::from_lan_error(&err),
                    },
                }
            }
        }
    };

    // ---- Step 4: Per-book commit callback BEFORE completion event (`R2-07`)
    let committed_anything =
        file_commit_result.is_some() || position_replaced || !inserted_bookmarks.is_empty();

    if committed_anything {
        let refreshed_doc = {
            let db_clone = Arc::clone(db);
            let doc_id = target_doc.id.clone();
            tokio::task::spawn_blocking(move || {
                db_clone
                    .lock()
                    .ok()
                    .and_then(|guard| guard.get_document(&doc_id).ok())
            })
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| target_doc.clone())
        };

        on_commit(BookCommitEvent {
            book_id: book_id.clone(),
            document: refreshed_doc,
            file_result: file_commit_result,
            position_replaced,
            inserted_bookmarks,
        });
    }

    let result = BookImportResult {
        book_id: book_id.clone(),
        document_id: Some(target_doc.id),
        state: planned.summary.state,
        file: file_outcome,
        position: position_outcome,
        bookmarks: bookmarks_outcome,
        bookmark_counts,
    };

    on_progress(ImportProgress::BookCompleted {
        book_id,
        book_index,
        total_books,
        result: Box::new(result.clone()),
    });

    (result, false, None)
}

async fn resolve_pre_publish_extension(
    db: &Arc<Mutex<Database>>,
    file_hash: &str,
    format: DocumentFormat,
    remote_extension: &str,
    planned_local_extension: Option<&str>,
) -> LanResult<String> {
    let db_clone = Arc::clone(db);
    let hash_clone = file_hash.to_owned();
    let fallback_local = planned_local_extension.map(str::to_owned);
    let remote_ext = remote_extension.to_owned();

    tokio::task::spawn_blocking(move || -> LanResult<String> {
        let live_local_ext = {
            let guard = db_clone.lock().map_err(|_| {
                LanError::Core(CoreError::Io(std::io::Error::other(
                    "database lock poisoned",
                )))
            })?;
            guard
                .list_documents()?
                .into_iter()
                .find(|doc| doc.file_hash == hash_clone && doc.format == format)
                .and_then(|doc| {
                    Path::new(&doc.file_path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .and_then(|e| validate_extension(format, e).ok())
                })
        };

        if let Some(ext) = live_local_ext {
            return Ok(ext);
        }
        if let Some(ext) = fallback_local
            && let Ok(valid) = validate_extension(format, &ext)
        {
            return Ok(valid);
        }
        Ok(validate_extension(format, &remote_ext)?)
    })
    .await
    .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))))?
}

async fn find_and_verify_local_by_hash(
    db: &Arc<Mutex<Database>>,
    file_hash: &str,
) -> LanResult<Option<(Document, DocumentSourceState)>> {
    let db_clone = Arc::clone(db);
    let hash_clone = file_hash.to_owned();
    tokio::task::spawn_blocking(
        move || -> LanResult<Option<(Document, DocumentSourceState)>> {
            let existing = {
                let guard = db_clone.lock().map_err(|_| {
                    LanError::Core(CoreError::Io(std::io::Error::other(
                        "database lock poisoned",
                    )))
                })?;
                guard
                    .list_documents()?
                    .into_iter()
                    .find(|doc| doc.file_hash == hash_clone)
            };
            let Some(doc) = existing else {
                return Ok(None);
            };
            // Unlocked file verification outside Mutex<Database>.
            let status = verify_document_file(&doc)?;
            Ok(Some((doc, status.state)))
        },
    )
    .await
    .map_err(|err| LanError::Core(CoreError::Io(std::io::Error::other(err.to_string()))))?
}

/// Returns `true` if any row in `documents` references `published_path`
/// (comparing canonicalized paths so symlinks/aliases do not diverge).
fn is_path_referenced_by_db(db: &Database, published_path: &Path) -> bool {
    let Ok(canonical_published) = std::fs::canonicalize(published_path) else {
        return true;
    };
    let Ok(docs) = db.list_documents() else {
        return true;
    };
    docs.iter().any(|doc| {
        let doc_path = Path::new(&doc.file_path);
        doc_path == published_path
            || std::fs::canonicalize(doc_path)
                .ok()
                .is_some_and(|canon| canon == canonical_published)
    })
}

fn missing_local_extension_locked(
    db: &Database,
    file_hash: &str,
    format: DocumentFormat,
) -> LanResult<Option<String>> {
    let docs = db.list_documents()?;
    let ext = docs
        .into_iter()
        .find(|doc| doc.file_hash == file_hash && !Path::new(&doc.file_path).is_file())
        .and_then(|doc| {
            Path::new(&doc.file_path)
                .extension()
                .and_then(|s| s.to_str())
                .and_then(|s| validate_extension(format, s).ok())
        });
    Ok(ext)
}

fn republish_with_extension(
    library: &ManagedLibrary,
    source_path: &Path,
    format: DocumentFormat,
    required_ext: &str,
    expected_hash: &str,
) -> LanResult<synapse_core::library::PublishedFile> {
    use std::io::Read as _;

    let mut file =
        std::fs::File::open(source_path).map_err(|err| LanError::Core(CoreError::Io(err)))?;
    let expected_len = file
        .metadata()
        .map_err(|err| LanError::Core(CoreError::Io(err)))?
        .len();
    let mut staged = library
        .begin_stage(format, required_ext, expected_hash, expected_len)
        .map_err(|err| map_core_storage_error(err, expected_len, 0))?;
    let mut buf = [0u8; 64 * 1024];
    let mut copied = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|err| LanError::Core(CoreError::Io(err)))?;
        if n == 0 {
            break;
        }
        staged
            .write_chunk(&buf[..n])
            .map_err(|err| map_core_storage_error(err, expected_len, copied))?;
        copied = copied.saturating_add(n as u64);
    }
    staged
        .finish_published()
        .map_err(|err| map_core_storage_error(err, expected_len, copied))
}

enum SelectedBookmarks {
    Skip(String),
    Entries {
        entries: Vec<ImportBookmarkEntry>,
        include_wire_skipped: bool,
    },
}

fn select_planned_bookmarks(
    planned: &PlannedBook,
    selected_indices: Option<&[usize]>,
) -> Result<SelectedBookmarks, ImportErrorInfo> {
    let Some(indices) = selected_indices else {
        return Ok(SelectedBookmarks::Entries {
            entries: planned.remote_bookmarks.values().cloned().collect(),
            include_wire_skipped: true,
        });
    };

    if indices.is_empty() {
        return Ok(SelectedBookmarks::Skip("no bookmarks selected".into()));
    }

    let mut seen = HashSet::with_capacity(indices.len());
    let mut entries = Vec::with_capacity(indices.len());
    for &idx in indices {
        let Some(entry) = planned.remote_bookmarks.get(&idx) else {
            return Err(ImportErrorInfo::new(
                "invalid_bookmark_selection",
                format!("bookmark index {idx} is not a selectable entry in this plan"),
            ));
        };
        if seen.insert(idx) {
            entries.push(entry.clone());
        }
    }

    Ok(SelectedBookmarks::Entries {
        entries,
        include_wire_skipped: false,
    })
}

fn local_file_changed_result(
    book_id: String,
    document_id: Option<String>,
    reason: String,
    decision: &BookImportDecision,
) -> BookImportResult {
    BookImportResult {
        book_id,
        document_id,
        state: BookSyncState::LocalFileChanged,
        file: ComponentOutcome::Failed {
            error: ImportErrorInfo::new("lan_local_file_changed", reason.clone()),
        },
        position: if decision.import_position {
            ComponentOutcome::Blocked {
                reason: reason.clone(),
            }
        } else {
            ComponentOutcome::Skipped { reason: None }
        },
        bookmarks: if decision.import_bookmarks {
            ComponentOutcome::Blocked { reason }
        } else {
            ComponentOutcome::Skipped { reason: None }
        },
        bookmark_counts: BookmarkExecutionSummary::default(),
    }
}

fn failed_file_result(
    book_id: String,
    document_id: Option<String>,
    state: BookSyncState,
    error: ImportErrorInfo,
    decision: &BookImportDecision,
) -> BookImportResult {
    let block_reason = format!("file transfer failed ({})", error.code);
    BookImportResult {
        book_id,
        document_id,
        state,
        file: ComponentOutcome::Failed { error },
        position: if decision.import_position {
            ComponentOutcome::Blocked {
                reason: block_reason.clone(),
            }
        } else {
            ComponentOutcome::Skipped { reason: None }
        },
        bookmarks: if decision.import_bookmarks {
            ComponentOutcome::Blocked {
                reason: block_reason,
            }
        } else {
            ComponentOutcome::Skipped { reason: None }
        },
        bookmark_counts: BookmarkExecutionSummary::default(),
    }
}

fn is_session_fatal(err: &LanError) -> bool {
    matches!(
        err,
        LanError::AuthExpired
            | LanError::AuthInvalid
            | LanError::SourceStopped(_)
            | LanError::Cancelled
            | LanError::ProtocolIncompatible(_)
    )
}

fn map_core_storage_error(err: CoreError, expected: u64, actual: u64) -> LanError {
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

fn check_anchor_limits(anchor: &AnchorLocation, limits: &ImportLimits) -> bool {
    match anchor {
        AnchorLocation::Pdf {
            rects, page_spans, ..
        } => {
            if rects.len() > limits.max_rects {
                return false;
            }
            if let Some(spans) = page_spans {
                if spans.len() > limits.max_page_spans {
                    return false;
                }
                if spans.iter().any(|span| span.rects.len() > limits.max_rects) {
                    return false;
                }
            }
            true
        }
        AnchorLocation::Epub {
            cfi_range,
            chapter_href,
        } => cfi_range.len() <= limits.max_cfi_bytes && chapter_href.len() <= limits.max_href_bytes,
        AnchorLocation::Txt { .. } | AnchorLocation::Md { .. } => true,
    }
}
