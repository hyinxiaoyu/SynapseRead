//! Full loopback end-to-end test suite for the LAN book sync import
//! orchestrator (`L-loop`, ADR 0008, `#148`).
//!
//! Compiled under `#[cfg(test)]` so `cargo test --workspace` executes every
//! scenario automatically on Linux, macOS, and Windows CI without needing
//! `--features test-loopback`.

use std::future::Future;
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::{Response, StatusCode, header};
use sha2::{Digest as _, Sha256};
use synapse_core::db::Database;
use synapse_core::domain::{
    AnchorLocation, CreateBookmarkInput, CreateExcerptInput, Document, DocumentFormat,
    ImportDocumentResult, ImportLimits, NormalizedRect,
};
use synapse_core::library::{ManagedLibrary, StageWriter, StagedFile};

use crate::address::{AddressPolicy, InterfaceProvider, PeerPolicy, RawInterface};
use crate::bind::bind_auto_for_tests;
use crate::client::{CancelHandle, CancelToken, LanClient, LanClientConfig, PairedClient};
use crate::error::{LanError, LanResult};
use crate::http::{
    HttpServerConfig, LanHttpHandler, LanResponse, SourceApiHandler, finalize_response,
    json_response,
};
use crate::listener::{LanListener, LanListenerHandle, ListenerConfig, TokioMonotonicClock};
use crate::orchestrator::{
    BookCommitEvent, BookImportDecision, BookSyncState, BookmarkPlanSkipReason, ComponentOutcome,
    DefaultStageFactory, ExecuteTestHooks, ImportProgress, MAX_PLANNER_CONCURRENCY,
    OrchestratorConfig, PlannedBookmarkStatus, StageFactory, classify_catalog, execute_import,
    execute_import_with_stage_factory, execute_import_with_test_hooks, plan_import,
};
use crate::session::{
    AuthorizedContext, SessionConfig, SessionManager, SharePermissions, SnapshotBook,
};
use crate::source::SqliteSourceApiHandler;

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "synapse-lan-e2e-{label}-{}-{nanos}-{seq}",
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

struct LoopbackInterfaceProvider;

impl InterfaceProvider for LoopbackInterfaceProvider {
    fn list_interfaces(&self) -> LanResult<Vec<RawInterface>> {
        Ok(vec![RawInterface {
            name: "lo0".into(),
            ip: Ipv4Addr::LOCALHOST,
            netmask: Ipv4Addr::new(255, 0, 0, 0),
            prefix_len: 8,
            is_up: true,
            is_loopback: true,
            is_broadcast: false,
            is_point_to_point: false,
        }])
    }
}

fn fixture_doc(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/documents")
        .join(name)
}

fn copy_fixture_to(dir: &Path, fixture_name: &str, dest_name: &str) -> PathBuf {
    let dest = dir.join(dest_name);
    std::fs::copy(fixture_doc(fixture_name), &dest).expect("copy fixture document");
    dest
}

fn write_bytes(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let dest = dir.join(name);
    std::fs::write(&dest, bytes).expect("write test bytes");
    dest
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn txt_anchor(start: u64, end: u64, line: u64) -> AnchorLocation {
    AnchorLocation::Txt {
        start_byte_offset: start,
        end_byte_offset: end,
        line_index: line,
    }
}

fn pdf_anchor(page_index: u32) -> AnchorLocation {
    AnchorLocation::Pdf {
        page_index,
        rects: vec![NormalizedRect {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.1,
        }],
        page_spans: None,
    }
}

fn epub_anchor(chapter: &str, cfi: &str) -> AnchorLocation {
    AnchorLocation::Epub {
        cfi_range: cfi.to_owned(),
        chapter_href: chapter.to_owned(),
    }
}

fn count_staging_entries(library: &ManagedLibrary) -> usize {
    let dir = library.staging_dir();
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(&dir)
        .expect("read staging dir")
        .filter_map(Result::ok)
        .count()
}

struct PeerNode {
    _dir: TempDir,
    files_dir: PathBuf,
    db: Arc<Mutex<Database>>,
    library: ManagedLibrary,
}

impl PeerNode {
    fn new(label: &str) -> Self {
        let dir = TempDir::new(label);
        let files_dir = dir.path().join("external-files");
        std::fs::create_dir_all(&files_dir).expect("create external files dir");
        let db = Database::open(&dir.path().join("synapse.sqlite")).expect("open sqlite db");
        let library = ManagedLibrary::new(dir.path());
        Self {
            _dir: dir,
            files_dir,
            db: Arc::new(Mutex::new(db)),
            library,
        }
    }

    fn register(&self, path: &Path) -> Document {
        self.db
            .lock()
            .expect("lock db")
            .register_document(path)
            .expect("register document")
    }
}

struct RunningSource {
    addr: SocketAddrV4,
    code: String,
    session: Arc<SessionManager>,
    file_bytes_sent: Arc<AtomicU64>,
    _listener: LanListenerHandle,
}

impl RunningSource {
    fn start(
        source_db: Arc<Mutex<Database>>,
        permissions: SharePermissions,
        snapshot_books: Vec<SnapshotBook>,
        chunk_size: Option<usize>,
    ) -> Self {
        let file_bytes_sent = Arc::new(AtomicU64::new(0));
        let mut api = SqliteSourceApiHandler::with_file_bytes_counter(
            source_db,
            Arc::clone(&file_bytes_sent),
        );
        if let Some(cs) = chunk_size {
            api = api.with_chunk_size(cs);
        }
        Self::start_with_api(Arc::new(api), file_bytes_sent, permissions, snapshot_books)
    }

    fn start_with_api<A: SourceApiHandler>(
        api: Arc<A>,
        file_bytes_sent: Arc<AtomicU64>,
        permissions: SharePermissions,
        snapshot_books: Vec<SnapshotBook>,
    ) -> Self {
        let bound = bind_auto_for_tests(
            Ipv4Addr::LOCALHOST,
            0..=0,
            AddressPolicy::loopback_for_tests(),
        )
        .expect("bind loopback listener");
        let addr = bound.local_addr;

        let clock = Arc::new(TokioMonotonicClock);
        let (session, code) = SessionManager::new(
            SessionConfig::default(),
            clock.clone(),
            permissions,
            snapshot_books,
        )
        .expect("create session");
        let session = Arc::new(session);

        let handler = Arc::new(LanHttpHandler::new(
            addr,
            Arc::clone(&session),
            api,
            HttpServerConfig::default(),
        ));

        let peer_policy = PeerPolicy::loopback_for_tests();
        let listener_cfg = ListenerConfig {
            enforce_candidate_interface: false,
            ..ListenerConfig::default()
        };
        let listener = LanListener::start(
            bound,
            peer_policy,
            Arc::new(LoopbackInterfaceProvider),
            clock,
            listener_cfg,
            handler,
        );
        session.attach_listener(listener.control());

        Self {
            addr,
            code: code.expose().to_owned(),
            session,
            file_bytes_sent,
            _listener: listener,
        }
    }

    fn file_bytes_sent(&self) -> u64 {
        self.file_bytes_sent.load(Ordering::Acquire)
    }

    async fn pair_receiver(&self) -> PairedClient {
        let client =
            LanClient::new_loopback_for_tests(&self.addr.to_string(), LanClientConfig::default())
                .expect("loopback client");
        let cancel = CancelToken::never();
        let hello = client.hello(&cancel).await.expect("hello");
        assert_eq!(hello.protocol, 1);
        client.pair(&self.code, &cancel).await.expect("pair")
    }
}

fn snapshot_all(node: &PeerNode) -> Vec<SnapshotBook> {
    node.db
        .lock()
        .expect("lock db")
        .list_documents()
        .expect("list docs")
        .into_iter()
        .map(|d| SnapshotBook {
            document_id: d.id,
            snapshot_file_hash: d.file_hash,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 1. New books across all formats (PDF, EPUB, TXT, .md) + privacy checks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_new_books_all_formats_and_ui_plan_hides_anchor_internals() {
    let source = PeerNode::new("src-all-formats");
    let receiver = PeerNode::new("dst-all-formats");

    let pdf_path = copy_fixture_to(&source.files_dir, "sample.pdf", "paper.pdf");
    let epub_path = copy_fixture_to(&source.files_dir, "sample.epub", "novel.epub");
    let txt_path = copy_fixture_to(&source.files_dir, "sample.txt", "notes.txt");
    let mut md_bytes = std::fs::read(fixture_doc("sample.txt")).expect("read sample.txt");
    md_bytes.extend_from_slice(b"\n# Markdown Addendum\n");
    let md_path = write_bytes(&source.files_dir, "readme.md", &md_bytes);

    let pdf_doc = source.register(&pdf_path);
    let epub_doc = source.register(&epub_path);
    let txt_doc = source.register(&txt_path);
    let md_doc = source.register(&md_path);

    {
        let mut db = source.db.lock().expect("lock source db");
        db.update_document_cursor(&pdf_doc.id, &pdf_anchor(0), Some(0.25))
            .expect("pdf cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: pdf_doc.id.clone(),
            anchor: pdf_anchor(1),
            label: Some("PDF BM".into()),
        })
        .expect("pdf bm");

        db.update_document_cursor(
            &epub_doc.id,
            &epub_anchor("ch1.xhtml", "epubcfi(/6/2!/4/2/1:0)"),
            Some(0.5),
        )
        .expect("epub cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: epub_doc.id.clone(),
            anchor: epub_anchor("ch2.xhtml", "epubcfi(/6/4!/4/2/1:0)"),
            label: Some("EPUB BM".into()),
        })
        .expect("epub bm");

        db.update_document_cursor(&txt_doc.id, &txt_anchor(0, 12, 0), Some(0.1))
            .expect("txt cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: txt_doc.id.clone(),
            anchor: txt_anchor(13, 25, 1),
            label: Some("TXT BM".into()),
        })
        .expect("txt bm");

        db.update_document_cursor(&md_doc.id, &txt_anchor(0, 10, 0), Some(0.75))
            .expect("md cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: md_doc.id.clone(),
            anchor: txt_anchor(20, 35, 2),
            label: Some("MD BM".into()),
        })
        .expect("md bm");
    }

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");
    assert_eq!(catalog.books.len(), 4);

    // Cheap stat-only classification
    let classified = classify_catalog(&receiver.db, &catalog.books, &ImportLimits::default())
        .await
        .expect("classify");
    assert!(classified.iter().all(|c| c.state == BookSyncState::New));

    // Plan import
    let mut plan_progress_events = Vec::new();
    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |p| plan_progress_events.push(p),
    )
    .await
    .expect("plan_import");
    assert_eq!(plan_progress_events.len(), 4);

    // F-20 & R3-07: ImportPlanSummary JSON must never contain anchor internals or file paths.
    let summary_json = serde_json::to_string(&plan.summary()).expect("serialize summary");
    for forbidden in [
        "cfiRange",
        "chapterHref",
        "startByteOffset",
        "pageIndex",
        "expectedCursor",
        "filePath",
    ] {
        assert!(
            !summary_json.contains(forbidden),
            "ImportPlanSummary leaked forbidden field '{forbidden}': {summary_json}"
        );
    }

    let decisions = plan.default_decisions();
    assert_eq!(decisions.len(), 4);

    let mut committed = Vec::new();
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |evt| committed.push(evt),
        |_| {},
    )
    .await;

    assert!(!report.cancelled);
    assert!(report.session_error.is_none());
    assert_eq!(report.books.len(), 4);
    assert_eq!(committed.len(), 4);
    assert!(running.file_bytes_sent() > 0);
    assert_eq!(count_staging_entries(&receiver.library), 0);

    for res in &report.books {
        assert_eq!(res.file, ComponentOutcome::Applied);
        assert_eq!(res.position, ComponentOutcome::Applied);
        assert_eq!(res.bookmarks, ComponentOutcome::Applied);
        assert_eq!(res.bookmark_counts.inserted, 1);
    }

    // Verify all 4 files landed in managed library with preserved extensions (including .md!).
    let rx_docs = receiver
        .db
        .lock()
        .expect("lock rx db")
        .list_documents()
        .expect("list rx docs");
    assert_eq!(rx_docs.len(), 4);
    let mut extensions: Vec<String> = rx_docs
        .iter()
        .map(|d| {
            assert!(
                d.last_opened_at.is_none(),
                "last_opened_at must stay NULL on import"
            );
            assert!(d.last_cursor_anchor.is_some());
            assert!(Path::new(&d.file_path).is_file());
            Path::new(&d.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    extensions.sort();
    assert_eq!(extensions, vec!["epub", "md", "pdf", "txt"]);

    paired.session_end(&cancel).await.expect("session_end");
}

// ---------------------------------------------------------------------------
// 2. Renamed duplicates (0 file bytes via file_bytes_sent, T-34)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_renamed_duplicate_transfers_zero_file_bytes() {
    let source = PeerNode::new("src-dup");
    let receiver = PeerNode::new("dst-dup");

    let src_file = copy_fixture_to(&source.files_dir, "sample.txt", "Source Title.txt");
    let dst_file = copy_fixture_to(&receiver.files_dir, "sample.txt", "My Local Title.txt");

    let src_doc = source.register(&src_file);
    let dst_doc = receiver.register(&dst_file);

    {
        let mut db = source.db.lock().expect("lock src db");
        db.update_document_cursor(&src_doc.id, &txt_anchor(10, 20, 1), Some(0.3))
            .expect("set cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(30, 40, 2),
            label: Some("Synced BM".into()),
        })
        .expect("set bm");
    }

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let book_plan = plan.book_summary(&src_doc.file_hash).expect("book summary");
    assert_eq!(book_plan.state, BookSyncState::AlreadyPresent);
    assert!(!book_plan.needs_file_download);

    let decisions = plan.default_decisions();
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(
        running.file_bytes_sent(),
        0,
        "T-34: 0 file bytes for renamed duplicate"
    );
    assert_eq!(report.books[0].position, ComponentOutcome::Applied);
    assert_eq!(report.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(report.books[0].bookmark_counts.inserted, 1);

    // Local title and original path remain untouched.
    let updated = receiver
        .db
        .lock()
        .expect("lock rx db")
        .get_document(&dst_doc.id)
        .expect("get doc");
    assert_eq!(updated.title, dst_doc.title);
    assert_eq!(updated.file_path, dst_doc.file_path);
    assert_eq!(updated.last_progress, Some(0.3));
}

// ---------------------------------------------------------------------------
// 3. Missing-file restore preserving .md extension + annotations/cards/BMs
//    (T-23, R2-01, R3-08)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_missing_file_restore_preserves_md_extension_and_study_data() {
    let source = PeerNode::new("src-restore");
    let receiver = PeerNode::new("dst-restore");

    let content = b"# Study Notes\nLine two of markdown content.\nLine three.\n";
    // Source has `.txt`, receiver originally had `.md` (both `format: txt`)!
    let src_file = write_bytes(&source.files_dir, "notes.txt", content);
    let dst_file = write_bytes(&receiver.files_dir, "notes.md", content);

    let src_doc = source.register(&src_file);
    let dst_doc = receiver.register(&dst_file);

    // Receiver creates an annotation/card/node, a bookmark, and a cursor.
    let (notebook_id, created_excerpt_id) = {
        let mut db = receiver.db.lock().expect("lock rx db");
        let nb = db.create_notebook("My Study").expect("create notebook");
        let excerpt = db
            .create_excerpt(&CreateExcerptInput {
                document_id: dst_doc.id.clone(),
                notebook_id: nb.id.clone(),
                anchor: txt_anchor(0, 13, 0),
                excerpt_text: Some("# Study Notes".into()),
                excerpt_image_png: None,
                color: "#ffd43b".into(),
                parent_node_id: None,
                pos_x: 10.0,
                pos_y: 20.0,
            })
            .expect("create excerpt");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: dst_doc.id.clone(),
            anchor: txt_anchor(14, 25, 1),
            label: Some("Keep Me".into()),
        })
        .expect("create rx bm");
        db.update_document_cursor(&dst_doc.id, &txt_anchor(14, 25, 1), Some(0.4))
            .expect("set rx cursor");
        (nb.id, excerpt.card.id)
    };

    // Delete the receiver's local `.md` file!
    std::fs::remove_file(&dst_file).expect("remove receiver file");

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let summary = plan.book_summary(&src_doc.file_hash).expect("summary");
    assert_eq!(summary.state, BookSyncState::MissingFile);
    assert!(summary.needs_file_download);

    let decisions = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: true,
        import_position: false,
        import_bookmarks: true,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];

    let mut commits = Vec::new();
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |evt| commits.push(evt),
        |_| {},
    )
    .await;

    assert_eq!(report.books[0].file, ComponentOutcome::Applied);
    assert!(matches!(
        commits[0].file_result,
        Some(ImportDocumentResult::Repaired(_))
    ));

    let db = receiver.db.lock().expect("lock rx db");
    let repaired = db.get_document(&dst_doc.id).expect("repaired doc");
    assert_eq!(
        Path::new(&repaired.file_path)
            .extension()
            .and_then(|e| e.to_str()),
        Some("md"),
        "R2-01/R3-08: restored file must preserve existing record's .md extension"
    );
    assert!(Path::new(&repaired.file_path).is_file());
    assert_eq!(repaired.last_progress, Some(0.4));

    let graph = db
        .load_notebook_graph(&notebook_id)
        .expect("notebook graph");
    assert_eq!(graph.annotations.len(), 1);
    assert_eq!(graph.cards.len(), 1);
    assert_eq!(graph.cards[0].id, created_excerpt_id);
    assert_eq!(graph.nodes.len(), 1);

    let bms = db.list_bookmarks().expect("list bms");
    assert_eq!(bms.len(), 1);
    assert_eq!(bms[0].label, "Keep Me");
}

// ---------------------------------------------------------------------------
// 4. Same-title different version (`SameTitleDifferentVersion`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_same_title_different_version_imports_as_distinct_book() {
    let source = PeerNode::new("src-same-title");
    let receiver = PeerNode::new("dst-same-title");

    let src_file = write_bytes(
        &source.files_dir,
        "Guide.txt",
        b"Version 2 content of Guide\n",
    );
    let dst_file = write_bytes(
        &receiver.files_dir,
        "Guide.txt",
        b"Version 1 content of Guide\n",
    );

    let src_doc = source.register(&src_file);
    let _dst_doc = receiver.register(&dst_file);

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let summary = plan.book_summary(&src_doc.file_hash).expect("summary");
    assert_eq!(summary.state, BookSyncState::SameTitleDifferentVersion);
    assert!(summary.eligible);
    assert!(summary.needs_file_download);

    let decisions = plan.default_decisions();
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(report.books[0].file, ComponentOutcome::Applied);
    let rx_docs = receiver
        .db
        .lock()
        .expect("lock rx db")
        .list_documents()
        .expect("list");
    assert_eq!(rx_docs.len(), 2);
}

// ---------------------------------------------------------------------------
// 5. Changed local file (`LocalFileChanged` — ineligible, never relinked)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_local_file_changed_is_ineligible_at_stat_plan_and_execute() {
    let source = PeerNode::new("src-changed");
    let receiver = PeerNode::new("dst-changed");

    let content_a = b"Book A original bytes\n";
    let content_b = b"Book B original bytes\n";
    let content_c = b"Book C original bytes\n";

    let src_a = write_bytes(&source.files_dir, "a.txt", content_a);
    let src_b = write_bytes(&source.files_dir, "b.txt", content_b);
    let src_c = write_bytes(&source.files_dir, "c.txt", content_c);
    let dst_a = write_bytes(&receiver.files_dir, "a.txt", content_a);
    let dst_b = write_bytes(&receiver.files_dir, "b.txt", content_b);
    let dst_c = write_bytes(&receiver.files_dir, "c.txt", content_c);

    let sa = source.register(&src_a);
    let sb = source.register(&src_b);
    let sc = source.register(&src_c);
    let da = receiver.register(&dst_a);
    let db_doc = receiver.register(&dst_b);
    let dc = receiver.register(&dst_c);

    // Add a remote bookmark on C so execute_import wants to apply it.
    source
        .db
        .lock()
        .expect("lock src")
        .create_bookmark(&CreateBookmarkInput {
            document_id: sc.id.clone(),
            anchor: txt_anchor(0, 6, 0),
            label: Some("Should Not Apply".into()),
        })
        .expect("bm");

    // A: different size (caught cheaply by stat in classify_catalog, F-19)
    std::fs::write(&dst_a, b"Book A modified to a much longer size!!\n").expect("modify A");
    // B: exact same byte length, different content (caught in plan_import)
    std::fs::write(&dst_b, b"Book B MODIFIED bytes\n").expect("modify B");

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let classified = classify_catalog(&receiver.db, &catalog.books, &ImportLimits::default())
        .await
        .expect("classify");
    let ca = classified
        .iter()
        .find(|c| c.book_id == sa.file_hash)
        .expect("ca");
    assert_eq!(ca.state, BookSyncState::LocalFileChanged);
    assert!(!ca.eligible);

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    assert_eq!(
        plan.book_summary(&sa.file_hash).expect("sa").state,
        BookSyncState::LocalFileChanged
    );
    assert_eq!(
        plan.book_summary(&sb.file_hash).expect("sb").state,
        BookSyncState::LocalFileChanged
    );
    assert_eq!(
        plan.book_summary(&sc.file_hash).expect("sc").state,
        BookSyncState::AlreadyPresent
    );

    // Now modify C AFTER plan_import and BEFORE execute_import!
    std::fs::write(&dst_c, b"Book C MODIFIED bytes\n").expect("modify C");

    let decisions = vec![
        BookImportDecision {
            book_id: sa.file_hash.clone(),
            import_file: true,
            import_position: true,
            import_bookmarks: true,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: sc.file_hash.clone(),
            import_file: false,
            import_position: false,
            import_bookmarks: true,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
    ];

    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(running.file_bytes_sent(), 0);
    // A was ineligible at plan time -> skipped
    assert_eq!(report.books[0].state, BookSyncState::LocalFileChanged);
    assert!(matches!(
        report.books[0].file,
        ComponentOutcome::Skipped { .. }
    ));
    // C was caught by unlocked verify_document_file during execute_import -> failed + blocked
    assert_eq!(report.books[1].state, BookSyncState::LocalFileChanged);
    assert!(matches!(
        &report.books[1].file,
        ComponentOutcome::Failed { error } if error.code == "lan_local_file_changed"
    ));
    assert!(matches!(
        report.books[1].bookmarks,
        ComponentOutcome::Blocked { .. }
    ));

    // Verify NONE of the changed documents were relinked in DB.
    let db = receiver.db.lock().expect("lock rx db");
    assert_eq!(db.get_document(&da.id).expect("da").file_hash, da.file_hash);
    assert_eq!(
        db.get_document(&db_doc.id).expect("db").file_hash,
        db_doc.file_hash
    );
    assert_eq!(db.get_document(&dc.id).expect("dc").file_hash, dc.file_hash);
    assert!(db.list_bookmarks().expect("bms").is_empty());
}

// ---------------------------------------------------------------------------
// 6. Bookmark-only & position-only updates (0 file bytes, T-34) +
//    Idempotent repeat bookmarks (T-29) + Receiver BM preservation (T-30)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_bookmark_and_position_only_idempotent_and_preserves_receiver_bookmark() {
    let source = PeerNode::new("src-bm-pos");
    let receiver = PeerNode::new("dst-bm-pos");

    let src_file = copy_fixture_to(&source.files_dir, "sample.txt", "book.txt");
    let dst_file = copy_fixture_to(&receiver.files_dir, "sample.txt", "book.txt");

    let src_doc = source.register(&src_file);
    let dst_doc = receiver.register(&dst_file);

    // Receiver already has a bookmark at offset 0..10 with a custom label.
    let rx_existing_bm = receiver
        .db
        .lock()
        .expect("lock rx")
        .create_bookmark(&CreateBookmarkInput {
            document_id: dst_doc.id.clone(),
            anchor: txt_anchor(0, 10, 0),
            label: Some("Receiver Custom Label".into()),
        })
        .expect("rx bm");

    // Source has a bookmark at the same location (offset 0..10) + a new one at 20..30 + position.
    {
        let mut db = source.db.lock().expect("lock src");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(0, 10, 0),
            label: Some("Source Different Label".into()),
        })
        .expect("src bm 1");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(20, 30, 2),
            label: Some("New Remote BM".into()),
        })
        .expect("src bm 2");
        db.update_document_cursor(&src_doc.id, &txt_anchor(40, 50, 4), Some(0.65))
            .expect("src cursor");
    }

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let summary = plan.book_summary(&src_doc.file_hash).expect("summary");
    assert_eq!(summary.bookmarks.new_count, 1);
    assert_eq!(summary.bookmarks.existing_count, 1);
    assert_eq!(summary.bookmarks.skipped_count, 0);

    // Run 1: bookmark-only (position = false)
    let bm_only = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: false,
        import_bookmarks: true,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];
    let report1 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &bm_only,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(running.file_bytes_sent(), 0);
    assert_eq!(report1.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(report1.books[0].bookmark_counts.inserted, 1);
    assert_eq!(report1.books[0].bookmark_counts.existing, 1);
    assert!(
        receiver
            .db
            .lock()
            .expect("lock")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_cursor_anchor
            .is_none()
    );

    // T-30: Receiver's existing bookmark at same location is preserved untouched!
    let bms = receiver
        .db
        .lock()
        .expect("lock")
        .list_bookmarks()
        .expect("bms");
    assert_eq!(bms.len(), 2);
    let preserved = bms
        .iter()
        .find(|b| b.id == rx_existing_bm.id)
        .expect("preserved bm");
    assert_eq!(preserved.label, "Receiver Custom Label");
    assert_eq!(preserved.created_at, rx_existing_bm.created_at);

    // T-29: Repeating bookmark import is idempotent (0 inserted, 2 existing).
    let report2 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &bm_only,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(report2.books[0].bookmark_counts.inserted, 0);
    assert_eq!(report2.books[0].bookmark_counts.existing, 2);
    assert_eq!(running.file_bytes_sent(), 0);

    // Run 3: position-only (bookmarks = false)
    let pos_only = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: true,
        import_bookmarks: false,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];
    let report3 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &pos_only,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(running.file_bytes_sent(), 0);
    assert_eq!(report3.books[0].position, ComponentOutcome::Applied);
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.65)
    );
}

// ---------------------------------------------------------------------------
// 7. Position conflict (`lan_position_conflict`) & conflict-override
//    re-confirmation (`T-33`, `T-35`, `T-36`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_position_conflict_and_explicit_override_reconfirmation() {
    let source = PeerNode::new("src-conflict");
    let receiver = PeerNode::new("dst-conflict");

    let src_file = copy_fixture_to(&source.files_dir, "sample.txt", "novel.txt");
    let dst_file = copy_fixture_to(&receiver.files_dir, "sample.txt", "novel.txt");

    let src_doc = source.register(&src_file);
    let dst_doc = receiver.register(&dst_file);

    source
        .db
        .lock()
        .expect("lock src")
        .update_document_cursor(&src_doc.id, &txt_anchor(50, 60, 5), Some(0.8))
        .expect("src cursor");
    receiver
        .db
        .lock()
        .expect("lock rx")
        .update_document_cursor(&dst_doc.id, &txt_anchor(0, 10, 0), Some(0.1))
        .expect("rx cursor A");

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: false,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    assert!(
        plan.book_summary(&src_doc.file_hash)
            .expect("s")
            .position
            .differs
    );
    assert_eq!(
        plan.expected_cursor_for_tests(&src_doc.file_hash)
            .expect("expected")
            .progress,
        Some(0.1)
    );

    // Simulate a concurrent local cursor write between plan_import and execute_import (T-33).
    receiver
        .db
        .lock()
        .expect("lock rx")
        .update_document_cursor(&dst_doc.id, &txt_anchor(20, 30, 2), Some(0.45))
        .expect("rx cursor B");

    let decision = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: true,
        import_bookmarks: false,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];
    let report1 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(
        report1.books[0].position,
        ComponentOutcome::Conflict {
            code: "lan_position_conflict".into(),
            has_current_position: true,
            current_progress: Some(0.45),
        }
    );
    assert!(plan.has_pending_position_conflict(&src_doc.file_hash));
    // Local cursor B was NOT overwritten.
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock rx")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.45)
    );

    // User explicitly confirms conflict override (T-35, T-36).
    let override_decision = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: true,
        import_bookmarks: false,
        selected_bookmark_indices: None,
        override_position_conflict: true,
    }];
    let report2 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &override_decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(report2.books[0].position, ComponentOutcome::Applied);
    assert!(!plan.has_pending_position_conflict(&src_doc.file_hash));
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock rx")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.8)
    );
}

// ---------------------------------------------------------------------------
// 8. Mid-transfer cancellation (T-18): keeps book 1 intact, removes .part
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_mid_transfer_cancel_keeps_committed_book_and_cleans_part() {
    let source = PeerNode::new("src-cancel");
    let receiver = PeerNode::new("dst-cancel");

    let f1 = write_bytes(&source.files_dir, "first.txt", b"small first book\n");
    let large_payload = vec![b'x'; 256 * 1024];
    let f2 = write_bytes(&source.files_dir, "second.txt", &large_payload);

    let d1 = source.register(&f1);
    let d2 = source.register(&f2);

    // Small server chunk size so book 2 streams across many frames.
    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        snapshot_all(&source),
        Some(4096),
    );
    let paired = running.pair_receiver().await;
    let catalog = paired
        .catalog(&CancelToken::never())
        .await
        .expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &CancelToken::never(),
        |_| {},
    )
    .await
    .expect("plan");

    let decisions = vec![
        BookImportDecision {
            book_id: d1.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d2.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
    ];

    let (cancel_handle, cancel_token) = CancelHandle::new();
    let d2_hash = d2.file_hash.clone();

    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel_token,
        |_| {},
        |progress| {
            if let ImportProgress::FileTransfer {
                book_id,
                downloaded_bytes,
                ..
            } = progress
                && book_id == d2_hash
                && downloaded_bytes > 0
            {
                cancel_handle.cancel();
            }
        },
    )
    .await;

    assert!(report.cancelled);
    assert_eq!(report.books.len(), 2);
    assert_eq!(report.books[0].file, ComponentOutcome::Applied);
    assert_eq!(report.books[1].file, ComponentOutcome::Cancelled);

    // Book 1 is committed in DB and on disk; book 2 is absent; 0 .part files remain.
    let rx_docs = receiver
        .db
        .lock()
        .expect("lock rx")
        .list_documents()
        .expect("docs");
    assert_eq!(rx_docs.len(), 1);
    assert_eq!(rx_docs[0].file_hash, d1.file_hash);
    assert!(Path::new(&rx_docs[0].file_path).is_file());
    assert_eq!(count_staging_entries(&receiver.library), 0);
}

// ---------------------------------------------------------------------------
// 9. Corrupted hash, length, and magic bytes (`T-16`, `T-20`)
// ---------------------------------------------------------------------------

struct FaultyFileApi {
    catalog_json: serde_json::Value,
    file_bytes: Vec<u8>,
    declared_length: u64,
}

impl SourceApiHandler for FaultyFileApi {
    fn catalog(
        &self,
        _auth: AuthorizedContext,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let json = self.catalog_json.clone();
        Box::pin(async move { json_response(StatusCode::OK, &json) })
    }

    fn book_file(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let bytes = self.file_bytes.clone();
        let len = self.declared_length;
        Box::pin(async move {
            let body = Full::new(Bytes::from(bytes))
                .map_err(|never| match never {})
                .boxed();
            let mut resp = Response::new(body);
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_LENGTH,
                header::HeaderValue::from_str(&len.to_string()).expect("content-length"),
            );
            finalize_response(resp)
        })
    }

    fn book_position(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async move { crate::http::no_content_response() })
    }

    fn book_bookmarks(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(
            async move { json_response(StatusCode::OK, &serde_json::json!({ "bookmarks": [] })) },
        )
    }
}

#[tokio::test]
async fn e2e_corrupted_hash_length_and_magic_rejected_and_block_dependents() {
    let cancel = CancelToken::never();

    // Case 1: Corrupted hash (same length, wrong bytes -> lan_hash_mismatch, T-16)
    {
        let receiver = PeerNode::new("dst-bad-hash");
        let expected_hash = sha256_hex(b"expected content!");
        let corrupted = b"CORRUPTED bytes!!".to_vec();
        let api = Arc::new(FaultyFileApi {
            catalog_json: serde_json::json!({
                "books": [{
                    "id": expected_hash,
                    "title": "Bad Hash",
                    "format": "txt",
                    "extension": "txt",
                    "sizeBytes": corrupted.len(),
                    "fileAvailable": true
                }]
            }),
            declared_length: corrupted.len() as u64,
            file_bytes: corrupted,
        });
        let running = RunningSource::start_with_api(
            api,
            Arc::new(AtomicU64::new(0)),
            SharePermissions {
                positions: true,
                bookmarks: true,
            },
            vec![],
        );
        let paired = running.pair_receiver().await;
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        let mut plan = plan_import(
            &paired,
            &receiver.db,
            &catalog.books,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
        )
        .await
        .expect("plan");

        let decision = vec![BookImportDecision {
            book_id: expected_hash,
            import_file: true,
            import_position: true,
            import_bookmarks: true,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        }];
        let report = execute_import(
            &paired,
            &receiver.db,
            &receiver.library,
            &mut plan,
            &decision,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
            |_| {},
        )
        .await;
        assert!(matches!(
            &report.books[0].file,
            ComponentOutcome::Failed { error } if error.code == "lan_hash_mismatch"
        ));
        assert!(matches!(
            report.books[0].position,
            ComponentOutcome::Blocked { .. }
        ));
        assert!(matches!(
            report.books[0].bookmarks,
            ComponentOutcome::Blocked { .. }
        ));
        assert_eq!(count_staging_entries(&receiver.library), 0);
    }

    // Case 2: Declared Content-Length mismatch (`lan_size_mismatch`, T-16)
    {
        let receiver = PeerNode::new("dst-bad-len");
        let payload = b"actual bytes".to_vec();
        let hash = sha256_hex(&payload);
        let api = Arc::new(FaultyFileApi {
            catalog_json: serde_json::json!({
                "books": [{
                    "id": hash,
                    "title": "Bad Len",
                    "format": "txt",
                    "extension": "txt",
                    "sizeBytes": payload.len() + 10,
                    "fileAvailable": true
                }]
            }),
            declared_length: payload.len() as u64,
            file_bytes: payload,
        });
        let running = RunningSource::start_with_api(
            api,
            Arc::new(AtomicU64::new(0)),
            SharePermissions {
                positions: false,
                bookmarks: false,
            },
            vec![],
        );
        let paired = running.pair_receiver().await;
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        let mut plan = plan_import(
            &paired,
            &receiver.db,
            &catalog.books,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
        )
        .await
        .expect("plan");
        let decisions = plan.default_decisions();
        let report = execute_import(
            &paired,
            &receiver.db,
            &receiver.library,
            &mut plan,
            &decisions,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
            |_| {},
        )
        .await;
        assert!(matches!(
            &report.books[0].file,
            ComponentOutcome::Failed { error } if error.code == "lan_size_mismatch"
        ));
        assert_eq!(count_staging_entries(&receiver.library), 0);
    }

    // Case 3: Corrupt PDF magic bytes (`T-20`, valid SHA-256 of non-PDF bytes)
    {
        let receiver = PeerNode::new("dst-bad-magic");
        let not_a_pdf = b"NOT A REAL PDF FILE".to_vec();
        let hash = sha256_hex(&not_a_pdf);
        let api = Arc::new(FaultyFileApi {
            catalog_json: serde_json::json!({
                "books": [{
                    "id": hash,
                    "title": "Fake PDF",
                    "format": "pdf",
                    "extension": "pdf",
                    "sizeBytes": not_a_pdf.len(),
                    "fileAvailable": true
                }]
            }),
            declared_length: not_a_pdf.len() as u64,
            file_bytes: not_a_pdf,
        });
        let running = RunningSource::start_with_api(
            api,
            Arc::new(AtomicU64::new(0)),
            SharePermissions {
                positions: false,
                bookmarks: false,
            },
            vec![],
        );
        let paired = running.pair_receiver().await;
        let catalog = paired.catalog(&cancel).await.expect("catalog");
        let mut plan = plan_import(
            &paired,
            &receiver.db,
            &catalog.books,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
        )
        .await
        .expect("plan");
        let decisions = plan.default_decisions();
        let report = execute_import(
            &paired,
            &receiver.db,
            &receiver.library,
            &mut plan,
            &decisions,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
            |_| {},
        )
        .await;
        assert!(matches!(
            &report.books[0].file,
            ComponentOutcome::Failed { error } if error.code == "unsupported_format"
        ));
        assert_eq!(count_staging_entries(&receiver.library), 0);
    }
}

// ---------------------------------------------------------------------------
// 10. Injected ENOSPC -> `lan_disk_full` with `.part` cleanup (`T-22`)
// ---------------------------------------------------------------------------

struct DiskFullWriter {
    inner: std::fs::File,
    fail_after: usize,
    written: usize,
}

impl Write for DiskFullWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written >= self.fail_after {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "simulated ENOSPC",
            ));
        }
        let n = self.inner.write(buf)?;
        self.written += n;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl StageWriter for DiskFullWriter {
    fn sync_file(&mut self) -> io::Result<()> {
        self.inner.sync_all()
    }

    #[cfg(unix)]
    fn file_identity(&self) -> Option<synapse_core::library::FileIdentity> {
        self.inner
            .metadata()
            .ok()
            .map(|m| synapse_core::library::FileIdentity::from_metadata(&m))
    }
}

struct DiskFullStageFactory {
    fail_after: usize,
}

impl StageFactory for DiskFullStageFactory {
    fn begin_stage(
        &self,
        library: &ManagedLibrary,
        format: DocumentFormat,
        extension: &str,
        expected_hash: &str,
        expected_len: u64,
    ) -> synapse_core::CoreResult<StagedFile> {
        let fail_after = self.fail_after;
        library.begin_stage_with_writer(format, extension, expected_hash, expected_len, |path| {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            Ok(Box::new(DiskFullWriter {
                inner: file,
                fail_after,
                written: 0,
            }))
        })
    }
}

#[tokio::test]
async fn e2e_injected_enospc_maps_to_lan_disk_full_and_cleans_part() {
    let source = PeerNode::new("src-enospc");
    let receiver = PeerNode::new("dst-enospc");

    let f = copy_fixture_to(&source.files_dir, "sample.txt", "big.txt");
    let doc = source.register(&f);

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        Some(1024),
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let decision = vec![BookImportDecision {
        book_id: doc.file_hash.clone(),
        import_file: true,
        import_position: true,
        import_bookmarks: true,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];

    let report = execute_import_with_stage_factory(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decision,
        &OrchestratorConfig::default(),
        &cancel,
        &DiskFullStageFactory { fail_after: 512 },
        |_| {},
        |_| {},
    )
    .await;

    assert!(matches!(
        &report.books[0].file,
        ComponentOutcome::Failed { error } if error.code == "lan_disk_full"
    ));
    assert!(matches!(
        report.books[0].position,
        ComponentOutcome::Blocked { .. }
    ));
    assert!(matches!(
        report.books[0].bookmarks,
        ComponentOutcome::Blocked { .. }
    ));
    assert_eq!(count_staging_entries(&receiver.library), 0);
    assert!(
        receiver
            .db
            .lock()
            .expect("lock")
            .list_documents()
            .expect("docs")
            .is_empty()
    );
}

// ---------------------------------------------------------------------------
// 11. Source file changed or relinked mid-session -> `409 lan_source_changed`
//     (`T-17`, `R3-03`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_source_changed_or_relinked_mid_session_returns_lan_source_changed() {
    let source = PeerNode::new("src-mutated");
    let receiver = PeerNode::new("dst-mutated");

    let f1 = write_bytes(&source.files_dir, "one.txt", b"original book one\n");
    let f2 = write_bytes(&source.files_dir, "two.txt", b"original book two\n");
    let f3 = write_bytes(&source.files_dir, "three.txt", b"original book three\n");

    let d1 = source.register(&f1);
    let d2 = source.register(&f2);
    let d3 = source.register(&f3);

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    // Mutate book 1 on disk AND relink book 2 in source DB mid-session!
    std::fs::write(&f1, b"mutated book one on disk\n").expect("mutate f1");
    let replacement = write_bytes(&source.files_dir, "two-v2.txt", b"relinked book two\n");
    source
        .db
        .lock()
        .expect("lock src")
        .relink_document(&d2.id, &replacement)
        .expect("relink d2");

    let decisions = vec![
        BookImportDecision {
            book_id: d1.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d2.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d3.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
    ];

    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert!(matches!(
        &report.books[0].file,
        ComponentOutcome::Failed { error } if error.code == "lan_source_changed"
    ));
    assert!(matches!(
        &report.books[1].file,
        ComponentOutcome::Failed { error } if error.code == "lan_source_changed"
    ));
    // Book 3 still succeeds!
    assert_eq!(report.books[2].file, ComponentOutcome::Applied);
    assert!(report.session_error.is_none());
}

// ---------------------------------------------------------------------------
// 12. Expired / revoked session mid-run (`T-02`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_revoked_session_mid_run_aborts_remaining_books_cleanly() {
    let source = PeerNode::new("src-revoke");
    let receiver = PeerNode::new("dst-revoke");

    let f1 = write_bytes(&source.files_dir, "b1.txt", b"book one content\n");
    let f2 = write_bytes(&source.files_dir, "b2.txt", b"book two content\n");
    let f3 = write_bytes(&source.files_dir, "b3.txt", b"book three content\n");

    let d1 = source.register(&f1);
    let d2 = source.register(&f2);
    let d3 = source.register(&f3);

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let decisions = vec![
        BookImportDecision {
            book_id: d1.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d2.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d3.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
    ];

    let session = Arc::clone(&running.session);
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        move |_commit| {
            // Expire/revoke the token locally right after book 1 commits so the
            // HTTP server deterministically returns 410 `lan_auth_expired`.
            session.revoke_local();
        },
        |_| {},
    )
    .await;

    assert_eq!(
        report.books.len(),
        2,
        "book 3 must not be attempted after session revoke"
    );
    assert_eq!(report.books[0].file, ComponentOutcome::Applied);
    assert!(matches!(
        &report.books[1].file,
        ComponentOutcome::Failed { error } if error.code == "lan_auth_expired"
    ));
    assert_eq!(
        report.session_error.as_ref().map(|e| e.code.as_str()),
        Some("lan_auth_expired")
    );
    let rx_docs = receiver
        .db
        .lock()
        .expect("lock")
        .list_documents()
        .expect("docs");
    assert_eq!(rx_docs.len(), 1);
    assert_eq!(rx_docs[0].file_hash, d1.file_hash);

    // Also verify full listener stop (`session.revoke()`) mid-run terminates
    // cleanly with a session-fatal error (`lan_source_stopped` or `lan_auth_expired`).
    let receiver2 = PeerNode::new("dst-revoke-stop");
    let running2 = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        snapshot_all(&source),
        None,
    );
    let paired2 = running2.pair_receiver().await;
    let catalog2 = paired2.catalog(&cancel).await.expect("catalog2");
    let mut plan2 = plan_import(
        &paired2,
        &receiver2.db,
        &catalog2.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan2");
    let session2 = Arc::clone(&running2.session);
    let report2 = execute_import(
        &paired2,
        &receiver2.db,
        &receiver2.library,
        &mut plan2,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        move |_commit| {
            session2.revoke();
        },
        |_| {},
    )
    .await;
    assert_eq!(report2.books.len(), 2);
    assert_eq!(report2.books[0].file, ComponentOutcome::Applied);
    assert!(matches!(
        report2.session_error.as_ref().map(|e| e.code.as_str()),
        Some("lan_source_stopped" | "lan_auth_expired")
    ));
}

// ---------------------------------------------------------------------------
// 13. Forward-compatible protocol skew / unknown wire fields / unknown future
//     anchor format skipping per entry (`T-51`, `T-52`, `R2-05`)
// ---------------------------------------------------------------------------

struct ForwardCompatApi {
    txt_bytes: Vec<u8>,
    txt_hash: String,
    future_hash: String,
}

impl SourceApiHandler for ForwardCompatApi {
    fn catalog(
        &self,
        _auth: AuthorizedContext,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let json = serde_json::json!({
            "books": [
                {
                    "id": self.txt_hash,
                    "title": "Forward Compat TXT",
                    "format": "txt",
                    "extension": "txt",
                    "sizeBytes": self.txt_bytes.len(),
                    "fileAvailable": true,
                    "hasPosition": true,
                    "bookmarkCount": 3,
                    "unknownFutureField": { "nested": true }
                },
                {
                    "id": self.future_hash,
                    "title": "Future Comic Format",
                    "format": "cbz",
                    "extension": "cbz",
                    "sizeBytes": 128,
                    "fileAvailable": true
                }
            ],
            "catalogVersionHint": "v1.2"
        });
        Box::pin(async move { json_response(StatusCode::OK, &json) })
    }

    fn book_file(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let bytes = self.txt_bytes.clone();
        Box::pin(async move {
            let len = bytes.len();
            let body = Full::new(Bytes::from(bytes))
                .map_err(|never| match never {})
                .boxed();
            let mut resp = Response::new(body);
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_LENGTH,
                header::HeaderValue::from_str(&len.to_string()).expect("len"),
            );
            finalize_response(resp)
        })
    }

    fn book_position(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let json = serde_json::json!({
            "anchor": { "format": "future_ast_v9", "nodeId": "n-42" },
            "progress": 0.5,
            "futureMeta": "ignored"
        });
        Box::pin(async move { json_response(StatusCode::OK, &json) })
    }

    fn book_bookmarks(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let json = serde_json::json!({
            "bookmarks": [
                {
                    "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                    "label": "Valid BM",
                    "createdAt": "2026-11-01T00:00:00Z",
                    "extraField": 123
                },
                {
                    "anchor": { "format": "future_ast_v9", "nodeId": "n-99" },
                    "label": "Future Anchor BM",
                    "createdAt": "2026-11-01T00:00:00Z"
                },
                {
                    "anchor": { "format": "pdf", "pageIndex": 0, "rects": [{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}] },
                    "label": "Wrong Format BM",
                    "createdAt": "2026-11-01T00:00:00Z"
                }
            ],
            "extraTopLevel": true
        });
        Box::pin(async move { json_response(StatusCode::OK, &json) })
    }
}

#[tokio::test]
async fn e2e_forward_compat_unknown_fields_and_future_anchors_skip_per_entry() {
    let receiver = PeerNode::new("dst-fwd-compat");
    let txt_bytes = b"Hello forward compatible world\n".to_vec();
    let txt_hash = sha256_hex(&txt_bytes);
    let future_hash = sha256_hex(b"future cbz bytes");

    let api = Arc::new(ForwardCompatApi {
        txt_bytes,
        txt_hash: txt_hash.clone(),
        future_hash: future_hash.clone(),
    });
    let running = RunningSource::start_with_api(
        api,
        Arc::new(AtomicU64::new(0)),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        vec![],
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");
    assert_eq!(catalog.books.len(), 2);

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    // Unknown future book format -> FormatMismatch (ineligible)
    let cbz_plan = plan.book_summary(&future_hash).expect("cbz");
    assert_eq!(cbz_plan.state, BookSyncState::FormatMismatch);
    assert!(!cbz_plan.eligible);

    // Valid TXT book: future position anchor skipped cleanly; 1 valid BM + 2 skipped BMs
    let txt_plan = plan.book_summary(&txt_hash).expect("txt");
    assert_eq!(txt_plan.state, BookSyncState::New);
    assert!(!txt_plan.position.remote_available);
    assert!(txt_plan.position.skipped_reason.is_some());
    assert_eq!(txt_plan.bookmarks.new_count, 1);
    assert_eq!(txt_plan.bookmarks.skipped_count, 2);
    assert!(matches!(
        txt_plan.bookmarks.entries[1].status,
        PlannedBookmarkStatus::Skipped {
            reason: BookmarkPlanSkipReason::UnsupportedAnchor { .. }
        }
    ));
    assert!(matches!(
        txt_plan.bookmarks.entries[2].status,
        PlannedBookmarkStatus::Skipped {
            reason: BookmarkPlanSkipReason::FormatMismatch
        }
    ));

    let decisions = plan.default_decisions();
    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    assert_eq!(report.books.len(), 1);
    assert_eq!(report.books[0].file, ComponentOutcome::Applied);
    assert_eq!(report.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(report.books[0].bookmark_counts.inserted, 1);
    assert_eq!(report.books[0].bookmark_counts.skipped, 1);
}

// ---------------------------------------------------------------------------
// 14. Planner bounded concurrency (`<= 2`) & cancellation (`R3-02`)
// ---------------------------------------------------------------------------

struct ConcurrencyTrackingApi {
    books: Vec<serde_json::Value>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
    delay: Duration,
}

impl SourceApiHandler for ConcurrencyTrackingApi {
    fn catalog(
        &self,
        _auth: AuthorizedContext,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let json = serde_json::json!({ "books": self.books });
        Box::pin(async move { json_response(StatusCode::OK, &json) })
    }

    fn book_file(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        Box::pin(async move { crate::http::no_content_response() })
    }

    fn book_position(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let in_flight = Arc::clone(&self.in_flight);
        let max_in_flight = Arc::clone(&self.max_in_flight);
        let delay = self.delay;
        Box::pin(async move {
            let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            max_in_flight.fetch_max(cur, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            in_flight.fetch_sub(1, Ordering::SeqCst);
            crate::http::no_content_response()
        })
    }

    fn book_bookmarks(
        &self,
        _auth: AuthorizedContext,
        _sha256: String,
        _session: Arc<SessionManager>,
    ) -> Pin<Box<dyn Future<Output = LanResponse> + Send + 'static>> {
        let in_flight = Arc::clone(&self.in_flight);
        let max_in_flight = Arc::clone(&self.max_in_flight);
        let delay = self.delay;
        Box::pin(async move {
            let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            max_in_flight.fetch_max(cur, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            in_flight.fetch_sub(1, Ordering::SeqCst);
            json_response(StatusCode::OK, &serde_json::json!({ "bookmarks": [] }))
        })
    }
}

#[tokio::test]
async fn e2e_planner_bounds_concurrency_to_2_and_supports_cancellation() {
    let receiver = PeerNode::new("dst-concurrency");
    let books: Vec<serde_json::Value> = (0..6)
        .map(|i| {
            let hash = sha256_hex(format!("book-{i}").as_bytes());
            serde_json::json!({
                "id": hash,
                "title": format!("Book {i}"),
                "format": "txt",
                "extension": "txt",
                "sizeBytes": 6,
                "fileAvailable": true,
                "hasPosition": true,
                "bookmarkCount": 1
            })
        })
        .collect();

    let in_flight = Arc::new(AtomicUsize::new(0));
    let max_in_flight = Arc::new(AtomicUsize::new(0));
    let api = Arc::new(ConcurrencyTrackingApi {
        books,
        in_flight: Arc::clone(&in_flight),
        max_in_flight: Arc::clone(&max_in_flight),
        delay: Duration::from_millis(25),
    });

    let running = RunningSource::start_with_api(
        api,
        Arc::new(AtomicU64::new(0)),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        vec![],
    );
    let paired = running.pair_receiver().await;
    let catalog = paired
        .catalog(&CancelToken::never())
        .await
        .expect("catalog");

    // Requesting concurrency 8 must be clamped to MAX_PLANNER_CONCURRENCY (2).
    let cfg = OrchestratorConfig {
        max_planner_concurrency: 8,
        ..OrchestratorConfig::default()
    };
    let plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &cfg,
        &CancelToken::never(),
        |_| {},
    )
    .await
    .expect("plan");
    assert_eq!(plan.summary().books.len(), 6);
    assert!(
        max_in_flight.load(Ordering::SeqCst) <= MAX_PLANNER_CONCURRENCY,
        "R3-02: planner concurrency exceeded 2 (observed {})",
        max_in_flight.load(Ordering::SeqCst)
    );

    // Cancel plan_import mid-flight after the first book finishes.
    let (cancel_handle, cancel_token) = CancelHandle::new();
    let cancelled_res = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &cfg,
        &cancel_token,
        |progress| {
            if progress.completed_books >= 1 {
                cancel_handle.cancel();
            }
        },
    )
    .await;
    assert!(matches!(cancelled_res, Err(LanError::Cancelled)));
}

// ---------------------------------------------------------------------------
// 15. Strict address validation (`T-57`)
// ---------------------------------------------------------------------------

#[test]
fn e2e_strict_address_validation_rejects_non_lan_and_loopback() {
    for invalid in [
        "127.0.0.1:49319",
        "localhost:49319",
        "example.com:49319",
        "8.8.8.8:49319",
        "100.64.0.1:49319",
        "0.0.0.0:49319",
        "224.0.0.1:49319",
        "[::1]:49319",
    ] {
        let err = LanClient::with_defaults(invalid).expect_err(&format!("must reject {invalid}"));
        assert_eq!(
            err.code(),
            "lan_address_invalid",
            "unexpected code for {invalid}"
        );
    }

    for valid in [
        "192.168.1.10",
        "10.0.0.5:49320",
        "172.16.4.8:49319",
        "169.254.1.2:49319",
    ] {
        assert!(
            LanClient::with_defaults(valid).is_ok(),
            "must accept valid LAN literal {valid}"
        );
    }
}

// ---------------------------------------------------------------------------
// 16. Per-book commit callback ordering (`R2-07`): fires BEFORE BookCompleted
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_commit_callback_fires_before_book_completed_progress_event() {
    let source = PeerNode::new("src-order");
    let receiver = PeerNode::new("dst-order");

    let f1 = write_bytes(&source.files_dir, "first.txt", b"first book\n");
    let f2 = write_bytes(&source.files_dir, "second.txt", b"second book\n");
    let d1 = source.register(&f1);
    let d2 = source.register(&f2);

    let running = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        snapshot_all(&source),
        None,
    );
    let paired = running.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let decisions = vec![
        BookImportDecision {
            book_id: d1.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
        BookImportDecision {
            book_id: d2.file_hash.clone(),
            import_file: true,
            import_position: false,
            import_bookmarks: false,
            selected_bookmark_indices: None,
            override_position_conflict: false,
        },
    ];

    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let events_commit = Arc::clone(&events);
    let events_progress = Arc::clone(&events);

    let report = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        move |evt: BookCommitEvent| {
            // File must already exist on disk when on_commit fires (so asset grant succeeds).
            assert!(Path::new(&evt.document.file_path).is_file());
            events_commit
                .lock()
                .expect("lock")
                .push(format!("commit:{}", evt.book_id));
        },
        move |progress| {
            if let ImportProgress::BookCompleted { book_id, .. } = progress {
                events_progress
                    .lock()
                    .expect("lock")
                    .push(format!("completed:{book_id}"));
            }
        },
    )
    .await;

    assert_eq!(report.books.len(), 2);
    let log = events.lock().expect("lock");
    assert_eq!(
        *log,
        vec![
            format!("commit:{}", d1.file_hash),
            format!("completed:{}", d1.file_hash),
            format!("commit:{}", d2.file_hash),
            format!("completed:{}", d2.file_hash),
        ],
        "R2-07: on_commit must fire strictly before BookCompleted for every book"
    );
}

fn count_library_entries(library: &ManagedLibrary) -> usize {
    let dir = library.library_dir();
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(&dir)
        .expect("read library dir")
        .filter_map(Result::ok)
        .count()
}

// ---------------------------------------------------------------------------
// 17. #160 P1 regression: relinking the same document_id to a different file
//     after preview OR between file verification and DB metadata writes must
//     return LocalFileChanged and block both position and bookmark writes.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_relink_after_preview_and_mid_execute_blocks_position_and_bookmarks() {
    let source = PeerNode::new("relink-guard-src");
    let receiver = PeerNode::new("relink-guard-dst");

    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "v1.txt");
    let dst_txt_v1 = copy_fixture_to(&receiver.files_dir, "sample.txt", "v1-local.txt");
    let dst_txt_v2 = receiver.files_dir.join("v2-relinked.txt");
    std::fs::write(
        &dst_txt_v2,
        "Completely different second edition book text for relink identity guard.\n",
    )
    .expect("write v2");

    let src_doc = source.register(&src_txt);
    let dst_doc = receiver.register(&dst_txt_v1);

    let remote_cursor = txt_anchor(30, 50, 1);
    let local_initial = txt_anchor(5, 10, 0);
    {
        let mut db = source.db.lock().expect("lock");
        db.update_document_cursor(&src_doc.id, &remote_cursor, Some(0.85))
            .expect("set remote cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(40, 55, 2),
            label: Some("Source V1 Bookmark".into()),
        })
        .expect("set remote bookmark");
    }
    {
        let db = receiver.db.lock().expect("lock");
        db.update_document_cursor(&dst_doc.id, &local_initial, Some(0.1))
            .expect("set local cursor");
    }

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    // --- Path A: relink AFTER plan_import and BEFORE execute_import ---
    let mut plan_a = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan A");

    {
        let db = receiver.db.lock().expect("lock");
        let relinked = db
            .relink_document(&dst_doc.id, &dst_txt_v2)
            .expect("relink to v2");
        assert_ne!(relinked.document.file_hash, src_doc.file_hash);
    }

    let decision = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: true,
        import_bookmarks: true,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];

    let report_a = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan_a,
        &decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;

    let res_a = &report_a.books[0];
    assert_eq!(res_a.state, BookSyncState::LocalFileChanged);
    assert!(matches!(
        &res_a.file,
        ComponentOutcome::Failed { error } if error.code == "lan_local_file_changed"
    ));
    assert!(matches!(res_a.position, ComponentOutcome::Blocked { .. }));
    assert!(matches!(res_a.bookmarks, ComponentOutcome::Blocked { .. }));

    {
        let db = receiver.db.lock().expect("lock");
        let current = db.get_document(&dst_doc.id).expect("get doc");
        assert_eq!(
            current.last_progress, None,
            "relink cleared v1 cursor and execute_import must not write remote v1 cursor onto v2"
        );
        assert!(db.list_bookmarks().expect("list bms").is_empty());
    }

    // --- Path B: relink in the race window BETWEEN verify_document_file and DB writes ---
    {
        // Restore v1 so preview and file verification both succeed cleanly.
        let db = receiver.db.lock().expect("lock");
        db.relink_document(&dst_doc.id, &dst_txt_v1)
            .expect("relink back to v1");
    }

    let mut plan_b = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan B");

    let db_for_hook = Arc::clone(&receiver.db);
    let v2_for_hook = dst_txt_v2.clone();
    let hooks = ExecuteTestHooks {
        before_metadata_writes: Some(Arc::new(move |_book_id, doc_id| {
            let db = db_for_hook.lock().expect("lock");
            db.relink_document(doc_id, &v2_for_hook)
                .expect("mid-execute relink to v2");
        })),
        ..ExecuteTestHooks::default()
    };

    let report_b = execute_import_with_test_hooks(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan_b,
        &decision,
        &OrchestratorConfig::default(),
        &cancel,
        &DefaultStageFactory,
        &hooks,
        |_| {},
        |_| {},
    )
    .await;

    let res_b = &report_b.books[0];
    assert_eq!(res_b.state, BookSyncState::LocalFileChanged);
    assert!(matches!(
        &res_b.position,
        ComponentOutcome::Failed { error } if error.code == "lan_local_file_changed"
    ));
    assert!(matches!(res_b.bookmarks, ComponentOutcome::Blocked { .. }));

    {
        let db = receiver.db.lock().expect("lock");
        let current = db.get_document(&dst_doc.id).expect("get doc");
        assert_eq!(
            current.last_progress, None,
            "relinked v2 document must not receive remote v1 cursor"
        );
        assert!(
            db.list_bookmarks().expect("list bms").is_empty(),
            "relinked v2 document must receive zero v1 bookmarks"
        );
    }

    assert_eq!(server.file_bytes_sent(), 0);
}

// ---------------------------------------------------------------------------
// 18. #160 P1 regression: first execution with override_position_conflict=true
//     must NOT skip conflict confirmation; subsequent page turns after conflict
//     must trigger a fresh conflict instead of blindly overwriting.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_first_run_override_flag_does_not_skip_conflict_and_recheck_catches_subsequent_turn() {
    let source = PeerNode::new("conflict-strict-src");
    let receiver = PeerNode::new("conflict-strict-dst");

    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "conflict.txt");
    let dst_txt = copy_fixture_to(&receiver.files_dir, "sample.txt", "conflict.txt");
    let src_doc = source.register(&src_txt);
    let dst_doc = receiver.register(&dst_txt);

    let remote_anchor = txt_anchor(80, 100, 3);
    {
        let db = source.db.lock().expect("lock");
        db.update_document_cursor(&src_doc.id, &remote_anchor, Some(0.9))
            .expect("remote cursor");
    }
    {
        let db = receiver.db.lock().expect("lock");
        db.update_document_cursor(&dst_doc.id, &txt_anchor(5, 10, 0), Some(0.1))
            .expect("initial local cursor");
    }

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: false,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    // Advance local cursor after preview: 0.1 -> 0.45.
    {
        let db = receiver.db.lock().expect("lock");
        db.update_document_cursor(&dst_doc.id, &txt_anchor(25, 35, 1), Some(0.45))
            .expect("advance to 0.45");
    }

    let override_decision = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: true,
        import_bookmarks: false,
        selected_bookmark_indices: None,
        override_position_conflict: true,
    }];

    // Path 1: First execution passing override_position_conflict=true MUST
    // still compare against the preview snapshot (0.1) and return Conflict(0.45).
    let run1 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &override_decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert!(matches!(
        &run1.books[0].position,
        ComponentOutcome::Conflict {
            code,
            has_current_position: true,
            current_progress: Some(p),
        } if code == "lan_position_conflict" && (*p - 0.45).abs() < 1e-6
    ));
    assert!(plan.has_pending_position_conflict(&src_doc.file_hash));
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.45)
    );

    // Path 2: User flips another page after seeing the conflict (0.45 -> 0.70);
    // retrying with override_position_conflict=true must detect the fresh change
    // and return a NEW Conflict(0.70) instead of overwriting.
    {
        let db = receiver.db.lock().expect("lock");
        db.update_document_cursor(&dst_doc.id, &txt_anchor(50, 60, 2), Some(0.70))
            .expect("advance to 0.70");
    }

    let run2 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &override_decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert!(matches!(
        &run2.books[0].position,
        ComponentOutcome::Conflict {
            code,
            has_current_position: true,
            current_progress: Some(p),
        } if code == "lan_position_conflict" && (*p - 0.70).abs() < 1e-6
    ));
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.70)
    );

    // Path 3: User confirms without further edits -> succeeds against recorded 0.70 snapshot.
    let run3 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &override_decision,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(run3.books[0].position, ComponentOutcome::Applied);
    assert!(!plan.has_pending_position_conflict(&src_doc.file_hash));
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .get_document(&dst_doc.id)
            .expect("doc")
            .last_progress,
        Some(0.9)
    );

    assert_eq!(server.file_bytes_sent(), 0);
}

// ---------------------------------------------------------------------------
// 19. #160 P2 regression: per-bookmark deselection by preview index, repeat
//     idempotency, delete + re-preview re-selection, invalid index rejection,
//     and 0 file bytes transferred throughout (#146).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_per_bookmark_deselection_repeat_and_repreview_with_zero_file_bytes() {
    let source = PeerNode::new("per-bm-src");
    let receiver = PeerNode::new("per-bm-dst");

    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "bms.txt");
    let dst_txt = copy_fixture_to(&receiver.files_dir, "sample.txt", "bms.txt");
    let src_doc = source.register(&src_txt);
    let _dst_doc = receiver.register(&dst_txt);

    {
        let mut db = source.db.lock().expect("lock");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(10, 20, 0),
            label: Some("First Bookmark".into()),
        })
        .expect("bm 0");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(40, 55, 2),
            label: Some("Second Bookmark".into()),
        })
        .expect("bm 1");
    }

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: true,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");

    let bm_summary = &plan.summary().books[0].bookmarks;
    assert_eq!(bm_summary.new_count, 2);
    assert_eq!(bm_summary.entries.len(), 2);
    let idx0 = bm_summary.entries[0].index;
    let idx1 = bm_summary.entries[1].index;
    let label0 = bm_summary.entries[0].label.clone().expect("label0");

    // Deselect idx1: only idx0 should be imported.
    let select_only_first = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: false,
        import_bookmarks: true,
        selected_bookmark_indices: Some(vec![idx0]),
        override_position_conflict: false,
    }];

    let run1 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &select_only_first,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(run1.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(run1.books[0].bookmark_counts.inserted, 1);
    assert_eq!(run1.books[0].bookmark_counts.existing, 0);

    let bms_after_run1 = receiver
        .db
        .lock()
        .expect("lock")
        .list_bookmarks()
        .expect("bms");
    assert_eq!(bms_after_run1.len(), 1);
    assert_eq!(bms_after_run1[0].label, label0);

    // Repeating the same selection must not insert additional rows.
    let run2 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &select_only_first,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(run2.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(run2.books[0].bookmark_counts.inserted, 0);
    assert_eq!(run2.books[0].bookmark_counts.existing, 1);
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .list_bookmarks()
            .expect("bms")
            .len(),
        1
    );

    // Invalid out-of-plan index must be rejected cleanly without inserting.
    let invalid_selection = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: false,
        import_bookmarks: true,
        selected_bookmark_indices: Some(vec![999]),
        override_position_conflict: false,
    }];
    let run_invalid = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &invalid_selection,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert!(matches!(
        &run_invalid.books[0].bookmarks,
        ComponentOutcome::Failed { error } if error.code == "invalid_bookmark_selection"
    ));

    // Delete the imported bookmark locally and re-preview -> both indices are
    // selectable as New again.
    {
        let db = receiver.db.lock().expect("lock");
        db.delete_bookmark(&bms_after_run1[0].id)
            .expect("delete local bm");
    }
    let mut plan2 = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("re-plan");
    assert_eq!(plan2.summary().books[0].bookmarks.new_count, 2);

    let select_both = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: false,
        import_position: false,
        import_bookmarks: true,
        selected_bookmark_indices: Some(vec![idx0, idx1]),
        override_position_conflict: false,
    }];
    let run3 = execute_import(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan2,
        &select_both,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
        |_| {},
    )
    .await;
    assert_eq!(run3.books[0].bookmarks, ComponentOutcome::Applied);
    assert_eq!(run3.books[0].bookmark_counts.inserted, 2);
    assert_eq!(
        receiver
            .db
            .lock()
            .expect("lock")
            .list_bookmarks()
            .expect("bms")
            .len(),
        2
    );

    assert_eq!(
        server.file_bytes_sent(),
        0,
        "per-bookmark sync on AlreadyPresent book must transfer 0 file bytes"
    );
}

// ---------------------------------------------------------------------------
// 20. #160 P2 regression (T-26): concurrent local registration before transfer
//     AND around publish preserves 1 DB row, original path, and leaves zero
//     orphan copies in managed library or staging directories.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_t26_concurrent_local_registration_before_transfer_and_around_publish_leaves_no_orphans()
 {
    let source = PeerNode::new("t26-src");
    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "t26-book.txt");
    let src_doc = source.register(&src_txt);

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    // --- Case A: local registration happens AFTER preview and BEFORE download ---
    {
        let receiver = PeerNode::new("t26-before-dl");
        let external_copy =
            copy_fixture_to(&receiver.files_dir, "sample.txt", "external-before.txt");
        let mut plan = plan_import(
            &paired,
            &receiver.db,
            &catalog.books,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
        )
        .await
        .expect("plan A");
        assert_eq!(plan.summary().books[0].state, BookSyncState::New);

        let db_hook = Arc::clone(&receiver.db);
        let ext_for_hook = external_copy.clone();
        let hooks = ExecuteTestHooks {
            before_file_download: Some(Arc::new(move |_book_id| {
                db_hook
                    .lock()
                    .expect("lock")
                    .register_document(&ext_for_hook)
                    .expect("concurrent local register before download");
            })),
            ..ExecuteTestHooks::default()
        };

        let decisions = plan.default_decisions();
        let report = execute_import_with_test_hooks(
            &paired,
            &receiver.db,
            &receiver.library,
            &mut plan,
            &decisions,
            &OrchestratorConfig::default(),
            &cancel,
            &DefaultStageFactory,
            &hooks,
            |_| {},
            |_| {},
        )
        .await;

        assert!(matches!(
            report.books[0].file,
            ComponentOutcome::Skipped { .. }
        ));
        assert_eq!(
            server.file_bytes_sent(),
            0,
            "pre-transfer dedup must skip downloading when healthy local copy already exists"
        );
        let docs = receiver
            .db
            .lock()
            .expect("lock")
            .list_documents()
            .expect("docs");
        assert_eq!(docs.len(), 1);
        assert_eq!(
            std::fs::canonicalize(&docs[0].file_path).expect("canon doc"),
            std::fs::canonicalize(&external_copy).expect("canon ext")
        );
        assert_eq!(count_library_entries(&receiver.library), 0);
        assert_eq!(count_staging_entries(&receiver.library), 0);
    }

    // --- Case B: local registration races AFTER StagedFile::finish and BEFORE import_document ---
    {
        let receiver = PeerNode::new("t26-after-publish");
        let external_copy = copy_fixture_to(&receiver.files_dir, "sample.txt", "external-race.txt");
        let mut plan = plan_import(
            &paired,
            &receiver.db,
            &catalog.books,
            &OrchestratorConfig::default(),
            &cancel,
            |_| {},
        )
        .await
        .expect("plan B");
        assert_eq!(plan.summary().books[0].state, BookSyncState::New);

        let db_hook = Arc::clone(&receiver.db);
        let ext_for_hook = external_copy.clone();
        let hooks = ExecuteTestHooks {
            before_import_document: Some(Arc::new(move |_book_id, published_path| {
                // Confirm the staged file was published into library/ right before
                // the racing local registration wins.
                assert!(published_path.is_file());
                db_hook
                    .lock()
                    .expect("lock")
                    .register_document(&ext_for_hook)
                    .expect("concurrent local register after publish");
            })),
            ..ExecuteTestHooks::default()
        };

        let decisions = plan.default_decisions();
        let report = execute_import_with_test_hooks(
            &paired,
            &receiver.db,
            &receiver.library,
            &mut plan,
            &decisions,
            &OrchestratorConfig::default(),
            &cancel,
            &DefaultStageFactory,
            &hooks,
            |_| {},
            |_| {},
        )
        .await;

        assert!(
            matches!(report.books[0].file, ComponentOutcome::Skipped { .. }),
            "T-26: AlreadyPresent race outcome must report Skipped, not Applied"
        );
        let docs = receiver
            .db
            .lock()
            .expect("lock")
            .list_documents()
            .expect("docs");
        assert_eq!(docs.len(), 1);
        assert_eq!(
            std::fs::canonicalize(&docs[0].file_path).expect("canon doc"),
            std::fs::canonicalize(&external_copy).expect("canon ext"),
            "original external path must be preserved"
        );
        assert_eq!(
            count_library_entries(&receiver.library),
            0,
            "newly created redundant managed copy must be cleaned up"
        );
        assert_eq!(count_staging_entries(&receiver.library), 0);
    }
}

// ---------------------------------------------------------------------------
// 21. P1 regression: post-publish `AlreadyPresent` must verify actual on-disk
//     content of the winning local copy outside Mutex<Database>; if modified,
//     return LocalFileChanged, block position & bookmarks, and never overwrite
//     the local file.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_post_publish_already_present_modified_on_disk_blocks_metadata_and_preserves_local_file()
 {
    let source = PeerNode::new("post-pub-mod-src");
    let receiver = PeerNode::new("post-pub-mod-dst");

    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "post-pub-book.txt");
    let src_doc = source.register(&src_txt);

    {
        let mut db = source.db.lock().expect("lock");
        db.update_document_cursor(&src_doc.id, &txt_anchor(20, 40, 1), Some(0.85))
            .expect("remote cursor");
        db.create_bookmark(&CreateBookmarkInput {
            document_id: src_doc.id.clone(),
            anchor: txt_anchor(30, 45, 2),
            label: Some("Remote Bookmark".into()),
        })
        .expect("remote bookmark");
    }

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: true,
            bookmarks: true,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan");
    assert_eq!(plan.summary().books[0].state, BookSyncState::New);

    let external_copy = copy_fixture_to(&receiver.files_dir, "sample.txt", "external-mod.txt");
    let modified_contents = b"USER EDITED LOCAL COPY AFTER REGISTRATION\n";

    let db_hook = Arc::clone(&receiver.db);
    let ext_for_hook = external_copy.clone();
    let hooks = ExecuteTestHooks {
        before_import_document: Some(Arc::new(move |_book_id, _published_path| {
            // Register identical-hash external copy, then immediately mutate it
            // on disk so DB hash still matches while disk content diverges.
            db_hook
                .lock()
                .expect("lock")
                .register_document(&ext_for_hook)
                .expect("register external copy");
            std::fs::write(&ext_for_hook, modified_contents).expect("modify external copy on disk");
        })),
        ..ExecuteTestHooks::default()
    };

    let decisions = vec![BookImportDecision {
        book_id: src_doc.file_hash.clone(),
        import_file: true,
        import_position: true,
        import_bookmarks: true,
        selected_bookmark_indices: None,
        override_position_conflict: false,
    }];

    let report = execute_import_with_test_hooks(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan,
        &decisions,
        &OrchestratorConfig::default(),
        &cancel,
        &DefaultStageFactory,
        &hooks,
        |_| {},
        |_| {},
    )
    .await;

    let res = &report.books[0];
    assert_eq!(res.state, BookSyncState::LocalFileChanged);
    assert!(matches!(
        &res.file,
        ComponentOutcome::Failed { error } if error.code == "lan_local_file_changed"
    ));
    assert!(matches!(res.position, ComponentOutcome::Blocked { .. }));
    assert!(matches!(res.bookmarks, ComponentOutcome::Blocked { .. }));

    {
        let db = receiver.db.lock().expect("lock");
        let docs = db.list_documents().expect("docs");
        assert_eq!(docs.len(), 1);
        assert_eq!(
            docs[0].last_progress, None,
            "remote position must not be written to a modified local copy"
        );
        assert!(
            db.list_bookmarks().expect("bms").is_empty(),
            "remote bookmarks must not be written to a modified local copy"
        );
    }

    assert_eq!(
        std::fs::read(&external_copy).expect("read external copy"),
        modified_contents,
        "local modified file must never be overwritten"
    );
    assert_eq!(count_library_entries(&receiver.library), 0);
    assert_eq!(count_staging_entries(&receiver.library), 0);
}

// ---------------------------------------------------------------------------
// 22. P1 regression: two interleaved imports sharing a managed library target
//     must coordinate via the cross-process publish lease so importer A cannot
//     delete a file reused in-flight by importer B, and `import_document` must
//     reject missing/invalidated published paths.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn e2e_interleaved_two_imports_protect_reused_managed_file_and_reject_missing_target() {
    let source = PeerNode::new("interleave-src");
    let receiver = PeerNode::new("interleave-dst");

    let src_txt = copy_fixture_to(&source.files_dir, "sample.txt", "shared-book.txt");
    let expected_bytes = std::fs::read(&src_txt).expect("read fixture bytes");
    let src_doc = source.register(&src_txt);

    let server = RunningSource::start(
        Arc::clone(&source.db),
        SharePermissions {
            positions: false,
            bookmarks: false,
        },
        vec![SnapshotBook {
            document_id: src_doc.id.clone(),
            snapshot_file_hash: src_doc.file_hash.clone(),
        }],
        None,
    );
    let paired = server.pair_receiver().await;
    let cancel = CancelToken::never();
    let catalog = paired.catalog(&cancel).await.expect("catalog");

    let mut plan_a = plan_import(
        &paired,
        &receiver.db,
        &catalog.books,
        &OrchestratorConfig::default(),
        &cancel,
        |_| {},
    )
    .await
    .expect("plan A");

    let external_copy = copy_fixture_to(&receiver.files_dir, "sample.txt", "external-win.txt");

    // Hold importer B's in-flight `PublishedFile` lease across importer A's
    // commit and cleanup attempt.
    let published_b_slot: Arc<Mutex<Option<synapse_core::library::PublishedFile>>> =
        Arc::new(Mutex::new(None));
    let published_b_for_hook = Arc::clone(&published_b_slot);
    let library_for_b = ManagedLibrary::new(receiver._dir.path());
    let db_for_hook = Arc::clone(&receiver.db);
    let ext_for_hook = external_copy.clone();
    let bytes_for_b = expected_bytes.clone();
    let hash_for_b = src_doc.file_hash.clone();

    let hooks = ExecuteTestHooks {
        before_import_document: Some(Arc::new(move |_book_id, published_a_path| {
            // 1. Importer B finishes staging and reuses the exact managed path
            //    that importer A just published, acquiring its own shared lease.
            let mut staged_b = library_for_b
                .begin_stage(
                    DocumentFormat::Txt,
                    "txt",
                    &hash_for_b,
                    bytes_for_b.len() as u64,
                )
                .expect("stage B");
            staged_b.write_chunk(&bytes_for_b).expect("write B");
            let published_b = staged_b.finish_published().expect("publish B");
            assert!(
                !published_b.created(),
                "importer B must reuse importer A's published managed file"
            );
            assert_eq!(published_b.path(), published_a_path);
            *published_b_for_hook.lock().expect("lock") = Some(published_b);

            // 2. External copy wins registration before importer A commits.
            db_for_hook
                .lock()
                .expect("lock")
                .register_document(&ext_for_hook)
                .expect("register external copy");
        })),
        ..ExecuteTestHooks::default()
    };

    let decisions_a = plan_a.default_decisions();
    let report_a = execute_import_with_test_hooks(
        &paired,
        &receiver.db,
        &receiver.library,
        &mut plan_a,
        &decisions_a,
        &OrchestratorConfig::default(),
        &cancel,
        &DefaultStageFactory,
        &hooks,
        |_| {},
        |_| {},
    )
    .await;

    // Importer A saw AlreadyPresent(external_copy) and preserved the external
    // path, AND could NOT delete the managed file because importer B holds an
    // active shared publish lease.
    assert!(matches!(
        report_a.books[0].file,
        ComponentOutcome::Skipped { .. }
    ));
    let published_b = published_b_slot
        .lock()
        .expect("lock")
        .take()
        .expect("importer B lease");
    assert!(
        published_b.path().is_file(),
        "in-flight reused managed file must NOT be deleted while importer B holds a lease"
    );
    assert_eq!(
        std::fs::read(&external_copy).expect("read external"),
        expected_bytes,
        "external file must remain intact"
    );

    // External copy now disappears; importer B commits and repairs the record
    // pointing to its protected, readable managed file.
    std::fs::remove_file(&external_copy).expect("remove external copy");
    let repaired = receiver
        .db
        .lock()
        .expect("lock")
        .import_document(
            published_b.path(),
            &src_doc.file_hash,
            "Shared Book",
            DocumentFormat::Txt,
        )
        .expect("importer B repair must succeed");
    assert!(matches!(repaired, ImportDocumentResult::Repaired(_)));
    let repaired_path = PathBuf::from(&repaired.document().file_path);
    assert!(
        repaired_path.is_file(),
        "committed repaired document must point to a readable file"
    );
    assert_eq!(
        std::fs::read(&repaired_path).expect("read repaired"),
        expected_bytes
    );
    drop(published_b);

    // Also verify `import_document` rejects a missing/invalidated published
    // path for both new creation and missing-file repair.
    let missing_target = receiver.library.library_dir().join("nonexistent.txt");
    let err_create = receiver
        .db
        .lock()
        .expect("lock")
        .import_document(
            &missing_target,
            &"f".repeat(64),
            "Missing New",
            DocumentFormat::Txt,
        )
        .expect_err("import_document must reject missing target on create");
    assert_eq!(err_create.code(), "io");

    std::fs::remove_file(&repaired_path).expect("remove repaired file");
    let err_repair = receiver
        .db
        .lock()
        .expect("lock")
        .import_document(
            &missing_target,
            &src_doc.file_hash,
            "Missing Repair",
            DocumentFormat::Txt,
        )
        .expect_err("import_document must reject missing target on repair");
    assert_eq!(err_repair.code(), "io");
}
