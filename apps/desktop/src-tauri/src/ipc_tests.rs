//! Drives the real commands through Tauri's IPC layer on the mock runtime.
//!
//! The JSON here is written exactly as `src/lib/backend/tauriBackend.ts` sends
//! it, so a renamed argument or changed field casing fails these tests. Unit
//! tests in `synapse-core` cannot see that class of bug.

use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::access::{
    grant_all, register_and_grant, register_and_grant_with_hasher, register_dropped_paths,
    relink_and_grant, relink_and_grant_with_hasher,
};
use crate::close_flush::{CloseDecision, CloseFlushCoordinator};
use crate::commands::db::verify_document_source_with_hasher;
use crate::state::AppState;

/// Where bundled app content is served from on the mock runtime.
const LOCAL_ORIGIN: &str = if cfg!(any(windows, target_os = "android")) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

struct Harness {
    app: App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    dir: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        Self::in_dir(tempfile::tempdir().unwrap())
    }

    /// Opens the app over `dir`'s database, as a later launch would.
    fn in_dir(dir: tempfile::TempDir) -> Self {
        Self::in_dir_with_lan(dir, crate::commands::lan::LanState::new())
    }

    fn in_dir_with_lan(dir: tempfile::TempDir, lan: crate::commands::lan::LanState) -> Self {
        let state = AppState::open_with_lan(&dir.path().join("test.sqlite3"), lan).unwrap();
        let app = crate::with_commands(mock_builder())
            .manage(state)
            .manage(CloseFlushCoordinator::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self { app, window, dir }
    }

    fn call(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.call_from(LOCAL_ORIGIN, cmd, args)
    }

    fn call_from(&self, origin: &str, cmd: &str, args: Value) -> Result<Value, Value> {
        get_ipc_response(
            &self.window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: origin.parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args)
            .unwrap_or_else(|error| panic!("{cmd} failed: {error}"))
    }

    fn register(&self, name: &str, content: &str) -> Value {
        let path = self.dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        // `pick_document` needs a native dialog; this is what it does with the result.
        let document = register_and_grant(self.app.handle(), &path).unwrap();
        serde_json::to_value(document).unwrap()
    }

    fn asset_allowed(&self, path: &std::path::Path) -> bool {
        self.app.asset_protocol_scope().is_allowed(path)
    }

    fn excerpt(&self, document: &Value, notebook: &Value, parent: Option<&Value>) -> Value {
        self.ok(
            "create_excerpt",
            json!({ "input": {
                "documentId": document["id"],
                "notebookId": notebook["id"],
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                "excerptText": "hello",
                "excerptImagePng": null,
                "color": "#fde047",
                "parentNodeId": parent.map(|node| node["id"].clone()),
                "posX": 1.5,
                "posY": 2.5,
            }}),
        )
    }
}

#[test]
fn documents_round_trip() {
    let h = Harness::new();
    let document = h.register("book.txt", "hello world");
    assert_eq!(document["title"], "book");
    assert_eq!(document["format"], "txt");
    assert_eq!(document["encoding"], "utf-8");
    assert_eq!(document["lastCursorAnchor"], Value::Null);

    let anchor =
        json!({ "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 });
    h.ok(
        "update_document_cursor",
        json!({ "documentId": document["id"], "anchor": anchor }),
    );
    let listed = h.ok("list_documents", json!({}));
    assert_eq!(listed[0]["lastCursorAnchor"], anchor);
    // Without a measured fraction the list shows no percentage.
    assert_eq!(listed[0]["lastProgress"], Value::Null);

    h.ok(
        "update_document_cursor",
        json!({ "documentId": document["id"], "anchor": anchor, "progress": 0.375 }),
    );
    let listed = h.ok("list_documents", json!({}));
    assert_eq!(listed[0]["lastProgress"], 0.375);

    let error = h
        .call(
            "update_document_cursor",
            json!({ "documentId": document["id"], "anchor": anchor, "progress": 1.5 }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "invalid_progress");
}

#[test]
fn excerpt_flow_round_trips_through_every_graph_command() {
    let h = Harness::new();
    let document = h.register("book.txt", "hello world");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    assert_eq!(h.ok("list_notebooks", json!({}))[0]["id"], notebook["id"]);

    let root = h.excerpt(&document, &notebook, None);
    assert_eq!(root["card"]["title"], "hello");
    assert_eq!(root["node"]["posX"], 1.5);
    assert_eq!(root["node"]["isCollapsed"], false);
    assert_eq!(root["edge"], Value::Null);

    let child = h.excerpt(&document, &notebook, Some(&root["node"]));
    assert_eq!(child["edge"]["sourceNodeId"], root["node"]["id"]);

    let card = h.ok(
        "update_card",
        json!({
            "cardId": root["card"]["id"],
            "patch": { "title": null, "markdownNotes": "note", "tags": ["a"] },
        }),
    );
    assert_eq!(card["markdownNotes"], "note");
    assert_eq!(card["tags"], json!(["a"]));
    assert_eq!(card["annotationIds"][0], root["annotation"]["id"]);

    h.ok(
        "update_node_layout",
        json!({
            "nodeId": root["node"]["id"],
            "patch": { "posX": 9.0, "posY": 8.0, "isCollapsed": true },
        }),
    );
    let viewport = json!({ "x": 1.0, "y": 2.0, "zoom": 0.5 });
    h.ok(
        "save_notebook_viewport",
        json!({ "notebookId": notebook["id"], "viewport": viewport }),
    );

    // Cross-link in the direction not already taken by the parent edge.
    let link = h.ok(
        "create_edge",
        json!({
            "notebookId": notebook["id"],
            "sourceNodeId": child["node"]["id"],
            "targetNodeId": root["node"]["id"],
            "label": "see also",
        }),
    );
    assert_eq!(link["label"], "see also");

    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    assert_eq!(graph["notebook"]["viewport"], viewport);
    assert_eq!(graph["annotations"].as_array().unwrap().len(), 2);
    assert_eq!(graph["cards"].as_array().unwrap().len(), 2);
    assert_eq!(graph["nodes"][0]["posX"], 9.0);
    assert_eq!(graph["nodes"][0]["isCollapsed"], true);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 2);

    h.ok("delete_edge", json!({ "edgeId": link["id"] }));
    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
}

#[test]
fn errors_reach_the_frontend_as_code_and_message() {
    let h = Harness::new();
    let error = h
        .call("load_notebook_graph", json!({ "notebookId": "missing" }))
        .unwrap_err();
    assert_eq!(error["code"], "not_found");
    assert!(error["message"].as_str().unwrap().contains("missing"));
}

#[test]
fn read_text_stream_reports_chunk_count() {
    let h = Harness::new();
    let document = h.register("note.txt", "héllo\nwörld");
    // A frontend `Channel` serializes to this form.
    let delivered = h.ok(
        "read_text_stream",
        json!({ "documentId": document["id"], "encoding": null, "onChunk": "__CHANNEL__:1" }),
    );
    assert_eq!(delivered, 1);
}

#[test]
fn read_text_stream_rejects_unsupported_encoding() {
    let h = Harness::new();
    let document = h.register("note.txt", "data");
    let error = h
        .call(
            "read_text_stream",
            json!({ "documentId": document["id"], "encoding": "gbk", "onChunk": "__CHANNEL__:1" }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "unsupported_encoding");
}

#[test]
fn read_text_stream_reads_only_registered_documents() {
    let h = Harness::new();
    let secret = h.dir.path().join("secret.txt");
    std::fs::write(&secret, "private").unwrap();

    // A path is not an id, even for a file that exists.
    let error = h
        .call(
            "read_text_stream",
            json!({ "documentId": secret, "encoding": null, "onChunk": "__CHANNEL__:1" }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "not_found");

    // The M1 argument is gone, so an old-style call cannot be satisfied.
    assert!(
        h.call(
            "read_text_stream",
            json!({ "path": secret, "encoding": null, "onChunk": "__CHANNEL__:1" }),
        )
        .is_err()
    );
}

#[test]
fn cancel_text_stream_halts_closed_tab_stream_over_ipc() {
    let h = Harness::new();
    let large_text = "line of text\n".repeat(20_000);
    let document = h.register("large.txt", &large_text);

    // Pre-cancelling a closed tab's streamId prevents `read_text_stream` from reading chunks.
    let cancelled = h.ok("cancel_text_stream", json!({ "streamId": "tab-closed-1" }));
    assert_eq!(cancelled, false);

    let delivered = h.ok(
        "read_text_stream",
        json!({
            "documentId": document["id"],
            "encoding": null,
            "streamId": "tab-closed-1",
            "onChunk": "__CHANNEL__:1"
        }),
    );
    assert_eq!(delivered, 0);
}

#[test]
fn the_webview_cannot_register_a_path() {
    let h = Harness::new();
    let secret = h.dir.path().join("secret.txt");
    std::fs::write(&secret, "private").unwrap();
    assert!(
        h.call("register_document", json!({ "path": secret }))
            .is_err()
    );
    assert_eq!(h.ok("list_documents", json!({})), json!([]));
    assert!(!h.asset_allowed(&secret));
}

#[test]
fn asset_scope_is_exactly_the_registered_documents() {
    let h = Harness::new();
    h.register("book.pdf", "pdf bytes");
    let sibling = h.dir.path().join("sibling.pdf");
    std::fs::write(&sibling, "other").unwrap();

    assert!(h.asset_allowed(&h.dir.path().join("book.pdf")));
    assert!(!h.asset_allowed(&sibling));
    assert!(!h.asset_allowed(&h.dir.path().join("test.sqlite3")));
}

#[test]
fn dropped_paths_register_supported_files_and_report_errors() {
    let h = Harness::new();
    let pdf = h.dir.path().join("dropped.pdf");
    let txt = h.dir.path().join("notes.txt");
    let bad = h.dir.path().join("archive.zip");
    std::fs::write(&pdf, "pdf bytes").unwrap();
    std::fs::write(&txt, "plain text").unwrap();
    std::fs::write(&bad, "zip bytes").unwrap();

    let payload = serde_json::to_value(register_dropped_paths(
        h.app.handle(),
        &[pdf.clone(), bad.clone(), txt.clone()],
    ))
    .unwrap();

    let documents = payload["documents"].as_array().unwrap();
    assert_eq!(documents.len(), 2);
    assert_eq!(documents[0]["title"], "dropped");
    assert_eq!(documents[1]["title"], "notes");
    assert_eq!(payload["error"]["code"], "unsupported_format");

    assert!(h.asset_allowed(&pdf));
    assert!(h.asset_allowed(&txt));
    assert!(!h.asset_allowed(&bad));
    assert_eq!(
        h.ok("list_documents", json!({})).as_array().unwrap().len(),
        2
    );
}

#[test]
fn asset_grants_treat_paths_as_literals() {
    let h = Harness::new();
    let hidden = h.dir.path().join(".hidden");
    std::fs::create_dir(&hidden).unwrap();
    let wildcard = hidden.join(if cfg!(windows) { "[a].pdf" } else { "[a]*.pdf" });
    std::fs::write(&wildcard, "wild").unwrap();
    let matched_by_glob = hidden.join(if cfg!(windows) {
        "a.pdf"
    } else {
        "a-other.pdf"
    });
    std::fs::write(&matched_by_glob, "other").unwrap();
    let unicode = h.dir.path().join("汉字 notes.txt");
    std::fs::write(&unicode, "text").unwrap();

    register_and_grant(h.app.handle(), &wildcard).unwrap();
    register_and_grant(h.app.handle(), &unicode).unwrap();

    assert!(
        h.asset_allowed(&wildcard),
        "dot directories must still load"
    );
    assert!(h.asset_allowed(&unicode));
    assert!(!h.asset_allowed(&matched_by_glob), "a grant is not a glob");
}

#[test]
fn asset_scope_is_rebuilt_from_the_database_on_the_next_launch() {
    let first = Harness::new();
    first.register("book.pdf", "pdf bytes");
    let Harness { dir, app, .. } = first;
    drop(app);

    let next = Harness::in_dir(dir);
    let book = next.dir.path().join("book.pdf");
    assert!(!next.asset_allowed(&book), "scopes do not persist");

    grant_all(next.app.handle(), &next.app.state::<AppState>()).unwrap();
    assert!(next.asset_allowed(&book));
}

const PNG_BASE64: &str = "iVBORw0KGgo=";

impl Harness {
    fn capture(&self, document: &Value, notebook: &Value, extra: Value) -> Result<Value, Value> {
        let mut input = json!({
            "documentId": document["id"],
            "notebookId": notebook["id"],
            "anchor": { "format": "pdf", "pageIndex": 0,
                "rects": [{ "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5 }] },
            "excerptText": null,
            "excerptImagePng": PNG_BASE64,
            "color": "#fde047",
            "parentNodeId": null,
            "posX": 0.0,
            "posY": 0.0,
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.call("create_excerpt", json!({ "input": input }))
    }
}

#[test]
fn a_capture_round_trips_and_is_loadable() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    let created = h.capture(&document, &notebook, json!({})).unwrap();

    let annotation = &created["annotation"];
    let id = annotation["id"].as_str().unwrap();
    assert_eq!(annotation["excerptImagePath"], format!("captures/{id}.png"));

    let path = h.ok("capture_path", json!({ "annotationId": id }));
    let path = std::path::PathBuf::from(path.as_str().unwrap());
    assert!(path.exists());

    grant_all(h.app.handle(), &h.app.state::<AppState>()).unwrap();
    assert!(h.asset_allowed(&path));
    // The grant covers captures only, not the data directory they sit in.
    assert!(!h.asset_allowed(&h.dir.path().join("test.sqlite3")));
    let nested = path.parent().unwrap().join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("x.png"), "x").unwrap();
    assert!(!h.asset_allowed(&nested.join("x.png")));
}

/// Undo Delete brings back the same annotation, its card link, and its capture (#97).
#[test]
fn a_deleted_capture_is_restored_with_its_card_and_image() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    let created = h.capture(&document, &notebook, json!({})).unwrap();
    let id = created["annotation"]["id"].clone();
    let path = h.ok("capture_path", json!({ "annotationId": id }));
    let path = std::path::PathBuf::from(path.as_str().unwrap());

    h.ok("delete_annotation", json!({ "annotationId": id }));
    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    assert_eq!(graph["annotations"].as_array().unwrap().len(), 0);
    assert_eq!(graph["cards"][0]["annotationIds"], json!([]));
    assert!(
        path.exists(),
        "the capture outlives the delete so Undo can restore it"
    );

    let restored = h.ok("restore_annotation", json!({ "annotationId": id }));
    assert_eq!(restored["annotation"], created["annotation"]);
    assert_eq!(restored["cards"][0]["id"], created["card"]["id"]);
    assert_eq!(restored["cards"][0]["annotationIds"], json!([id]));
    assert_eq!(
        h.ok("capture_path", json!({ "annotationId": id })),
        json!(path.to_str().unwrap())
    );

    let error = h
        .call("restore_annotation", json!({ "annotationId": id }))
        .unwrap_err();
    assert_eq!(error["code"], "not_found");
}

#[test]
fn a_capture_needs_a_real_png() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    let error = h
        .capture(
            &document,
            &notebook,
            json!({ "excerptImagePng": "R0lGODlh" }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "invalid_capture");
}

/// A webview must not be able to point an annotation at a file of its choosing.
#[test]
fn the_webview_cannot_set_a_capture_path() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    let created = h
        .capture(
            &document,
            &notebook,
            json!({
                "excerptImagePng": null,
                "excerptText": "text",
                "excerptImagePath": "/etc/passwd",
            }),
        )
        .unwrap();
    assert_eq!(created["annotation"]["excerptImagePath"], Value::Null);
    let id = &created["annotation"]["id"];
    assert_eq!(
        h.ok("capture_path", json!({ "annotationId": id })),
        Value::Null
    );
}

/// The CSP is compile-time configuration that no other test executes. Its values
/// come from the spike in `docs/adr/0004-pdfjs-worker-csp.md`.
#[test]
fn shipped_security_config_matches_the_decisions() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let security = &config["app"]["security"];
    assert_eq!(security["assetProtocol"]["enable"], true);
    assert_eq!(
        security["assetProtocol"]["scope"],
        json!([]),
        "the scope is derived from the documents table, never declared"
    );

    let csp = security["csp"].as_str().unwrap();
    let directive = |name: &str| {
        csp.split(';')
            .map(str::trim)
            .find_map(|part| part.strip_prefix(name))
            .unwrap_or_else(|| panic!("CSP has no {name}"))
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let connect = directive("connect-src");
    for source in ["asset:", "http://asset.localhost"] {
        assert!(connect.iter().any(|s| s == source), "connect-src: {source}");
    }
    assert_eq!(directive("worker-src"), ["'self'"]);

    // Book scripts are refused only because no directive names a way to run them:
    // see `docs/adr/0005-epub-sandbox.md`. This must stay absent or untouched.
    assert!(
        !csp.contains("script-src") && !csp.contains("unsafe-eval"),
        "script-src falls back to default-src 'self'"
    );
    assert_eq!(directive("default-src"), ["'self'"]);
    for (name, source) in [("style-src", "blob:"), ("font-src", "blob:")] {
        assert!(
            directive(name).iter().any(|s| s == source),
            "{name}: {source}"
        );
    }

    let capability: Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    // Window permissions are listed one by one: the unified title bar drags the
    // window, and full screen is a toolbar command. Nothing that opens a dialog or
    // touches the filesystem: the JS dialog API widens the asset scope by itself.
    assert_eq!(
        capability["permissions"],
        json!([
            "core:default",
            "core:window:allow-start-dragging",
            "core:window:allow-set-fullscreen",
            "core:window:allow-is-fullscreen"
        ]),
        "the JS dialog API widens the asset scope by itself"
    );
}

/// Remote content must never reach the database or the filesystem.
#[test]
fn commands_are_unreachable_from_remote_origins() {
    let h = Harness::new();
    let result = h.call_from("https://example.com", "list_documents", json!({}));
    assert!(result.is_err());
}

#[test]
fn reading_preferences_round_trip_and_reject_invalid_values() {
    let h = Harness::new();
    let initial = h.ok("get_reading_preferences", json!({}));
    assert_eq!(
        initial,
        json!({
            "theme": "auto",
            "fontFamily": "original",
            "fontSize": 100,
            "lineSpacing": 1.75,
            "margins": "normal",
            "pageWidth": "standard",
            "justify": true,
            "dimImages": false,
            "epubReadingMode": "spread",
            "pageTransition": "slide",
            "scrollPageTransition": null,
            "tintPdfPages": false,
            "focusModeFullScreen": false,
            "wheelSensitivity": 3,
        })
    );

    let updated = json!({
        "theme": "dark",
        "fontFamily": "new-york",
        "fontSize": 125,
        "lineSpacing": 1.9,
        "margins": "wide",
        "pageWidth": "full",
        "justify": false,
        "dimImages": true,
        "epubReadingMode": "paged",
        "pageTransition": "fade",
        "scrollPageTransition": "none",
        "tintPdfPages": true,
        "focusModeFullScreen": true,
        "wheelSensitivity": 4,
    });
    let saved = h.ok(
        "save_reading_preferences",
        json!({ "preferences": updated }),
    );
    assert_eq!(saved, updated);
    assert_eq!(h.ok("get_reading_preferences", json!({})), updated);

    for sensitivity in 1..=5 {
        let mut with_sensitivity = updated.clone();
        with_sensitivity["wheelSensitivity"] = json!(sensitivity);
        assert_eq!(
            h.ok(
                "save_reading_preferences",
                json!({ "preferences": with_sensitivity })
            ),
            with_sensitivity
        );
        assert_eq!(h.ok("get_reading_preferences", json!({})), with_sensitivity);
    }
    for invalid_sensitivity in [0, 6] {
        let mut bad_sensitivity = updated.clone();
        bad_sensitivity["wheelSensitivity"] = json!(invalid_sensitivity);
        let error = h
            .call(
                "save_reading_preferences",
                json!({ "preferences": bad_sensitivity }),
            )
            .unwrap_err();
        assert_eq!(error["code"], "invalid_preferences");
    }

    // The newer modes survive the wire in both directions.
    for mode in ["curl", "stack"] {
        let mut with_mode = updated.clone();
        with_mode["pageTransition"] = json!(mode);
        assert_eq!(
            h.ok(
                "save_reading_preferences",
                json!({ "preferences": with_mode })
            ),
            with_mode
        );
        assert_eq!(h.ok("get_reading_preferences", json!({})), with_mode);
    }

    // Scrolling transitions accept `none`, `fade`, and `null` (follow paged),
    // while paginated-only or unknown modes are rejected on the wire.
    for mode in [json!(null), json!("none"), json!("fade")] {
        let mut with_scroll = updated.clone();
        with_scroll["scrollPageTransition"] = mode;
        assert_eq!(
            h.ok(
                "save_reading_preferences",
                json!({ "preferences": with_scroll })
            ),
            with_scroll
        );
        assert_eq!(h.ok("get_reading_preferences", json!({})), with_scroll);
    }
    for invalid_scroll in ["slide", "curl", "stack", "peel"] {
        let mut bad_scroll = updated.clone();
        bad_scroll["scrollPageTransition"] = json!(invalid_scroll);
        assert!(
            h.call(
                "save_reading_preferences",
                json!({ "preferences": bad_scroll })
            )
            .is_err()
        );
    }

    // The wire enum stays strict: an unknown mode is a rejected argument, not a
    // silently stored default. Only a stored row written by a newer build is
    // tolerated, and that leniency lives in `get_reading_preferences`.
    let mut unknown_mode = updated.clone();
    unknown_mode["pageTransition"] = json!("peel");
    assert!(
        h.call(
            "save_reading_preferences",
            json!({ "preferences": unknown_mode })
        )
        .is_err()
    );

    let mut invalid_width = updated.clone();
    invalid_width["pageWidth"] = json!("invalid");
    assert!(
        h.call(
            "save_reading_preferences",
            json!({ "preferences": invalid_width })
        )
        .is_err()
    );

    let mut legacy = updated.clone();
    legacy.as_object_mut().unwrap().remove("pageWidth");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("scrollPageTransition");
    // Preferences saved before the appearance switches existed have no such
    // keys, and their absence is the off default rather than an error.
    legacy.as_object_mut().unwrap().remove("tintPdfPages");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("focusModeFullScreen");
    legacy.as_object_mut().unwrap().remove("wheelSensitivity");
    let saved_legacy = h.ok("save_reading_preferences", json!({ "preferences": legacy }));
    assert_eq!(saved_legacy["pageWidth"], "standard");
    assert_eq!(saved_legacy["scrollPageTransition"], json!(null));
    assert_eq!(saved_legacy["tintPdfPages"], false);
    assert_eq!(saved_legacy["focusModeFullScreen"], false);
    assert_eq!(saved_legacy["wheelSensitivity"], 3);

    let bad = h
        .call(
            "save_reading_preferences",
            json!({
                "preferences": {
                    "theme": "dark",
                    "fontFamily": "sf-pro",
                    "fontSize": 40,
                    "lineSpacing": 1.9,
                    "margins": "wide",
                    "pageWidth": "full",
                    "justify": true,
                    "dimImages": false,
                    "epubReadingMode": "paged",
                    "pageTransition": "none",
                }
            }),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "invalid_preferences");
}

#[test]
fn pdf_layout_round_trips_is_inherited_and_persists_across_relaunch() {
    let h = Harness::new();
    let first = h.register("first.pdf", "first pdf bytes");
    let fresh = h.register("fresh.pdf", "fresh pdf bytes");
    let text = h.register("notes.txt", "plain text");
    let default_layout = json!({
        "displayMode": "continuous",
        "zoomMode": "fit-width",
        "scale": 1.0,
        "rotation": 0,
        "coverPageAlone": false,
    });
    assert_eq!(
        h.ok("get_pdf_layout", json!({ "documentId": first["id"] })),
        default_layout
    );

    let layout = json!({
        "displayMode": "two-page",
        "zoomMode": "custom",
        "scale": 1.75,
        "rotation": 90,
        "coverPageAlone": true,
    });
    let saved = h.ok(
        "save_pdf_layout",
        json!({ "documentId": first["id"], "layout": layout }),
    );
    assert_eq!(saved, layout);
    assert_eq!(
        h.ok("get_pdf_layout", json!({ "documentId": first["id"] })),
        layout
    );
    // A PDF with no layout of its own takes the last display and zoom, not the
    // rotation or cover page.
    let inherited = json!({
        "displayMode": "two-page",
        "zoomMode": "custom",
        "scale": 1.75,
        "rotation": 0,
        "coverPageAlone": false,
    });
    assert_eq!(
        h.ok("get_pdf_layout", json!({ "documentId": fresh["id"] })),
        inherited
    );
    // That first read pins it: a later change to another PDF leaves it alone.
    let mut continuous = layout.clone();
    continuous["displayMode"] = json!("continuous");
    h.ok(
        "save_pdf_layout",
        json!({ "documentId": first["id"], "layout": continuous }),
    );
    assert_eq!(
        h.ok("get_pdf_layout", json!({ "documentId": fresh["id"] })),
        inherited
    );
    h.ok(
        "save_pdf_layout",
        json!({ "documentId": first["id"], "layout": layout }),
    );

    let rejected = |document: &Value, layout: Value| {
        h.call(
            "save_pdf_layout",
            json!({ "documentId": document["id"], "layout": layout }),
        )
        .unwrap_err()
    };
    let mut tilted = layout.clone();
    tilted["rotation"] = json!(45);
    assert_eq!(rejected(&first, tilted)["code"], "invalid_layout");
    let mut huge = layout.clone();
    huge["scale"] = json!(9);
    assert_eq!(rejected(&first, huge)["code"], "invalid_layout");
    assert_eq!(rejected(&text, layout.clone())["code"], "invalid_layout");
    // The layout travels whole, and the wire enums are strict.
    let mut partial = layout.clone();
    partial.as_object_mut().unwrap().remove("coverPageAlone");
    let mut unknown = layout.clone();
    unknown["displayMode"] = json!("spread");
    for malformed in [partial, unknown] {
        assert!(
            h.call(
                "save_pdf_layout",
                json!({ "documentId": first["id"], "layout": malformed }),
            )
            .is_err()
        );
    }
    assert_eq!(
        h.call("get_pdf_layout", json!({ "documentId": "missing" }))
            .unwrap_err()["code"],
        "not_found"
    );

    // The next launch reads the same layout from the database.
    let Harness { dir, app, .. } = h;
    drop(app);
    let next = Harness::in_dir(dir);
    assert_eq!(
        next.ok("get_pdf_layout", json!({ "documentId": first["id"] })),
        layout
    );
    assert_eq!(
        next.ok("get_pdf_layout", json!({ "documentId": fresh["id"] })),
        inherited
    );
}

#[test]
fn bookmarks_round_trip_deduplicate_and_persist_across_relaunch() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    assert_eq!(h.ok("list_bookmarks", json!({})), json!([]));

    let created = h.ok(
        "create_bookmark",
        json!({
            "input": {
                "documentId": document["id"],
                "anchor": {
                    "format": "pdf",
                    "pageIndex": 1,
                    "rects": [{ "x": 0.0, "y": 0.1, "width": 1.0, "height": 0.001 }],
                },
                "label": "Page 2",
            }
        }),
    );
    assert_eq!(created["documentId"], document["id"]);
    assert_eq!(created["label"], "Page 2");
    assert_eq!(created["anchor"]["pageIndex"], 1);

    // Deduplicate same PDF page location while updating its stored anchor/label.
    let updated = h.ok(
        "create_bookmark",
        json!({
            "input": {
                "documentId": document["id"],
                "anchor": {
                    "format": "pdf",
                    "pageIndex": 1,
                    "rects": [{ "x": 0.0, "y": 0.4, "width": 1.0, "height": 0.001 }],
                },
                "label": "Page 2 (updated)",
            }
        }),
    );
    assert_eq!(updated["id"], created["id"]);
    assert_eq!(updated["label"], "Page 2 (updated)");
    assert_eq!(
        h.ok("list_bookmarks", json!({})).as_array().unwrap().len(),
        1
    );

    // Rejects mismatched anchor format.
    let mismatch = h
        .call(
            "create_bookmark",
            json!({
                "input": {
                    "documentId": document["id"],
                    "anchor": {
                        "format": "txt",
                        "startByteOffset": 0,
                        "endByteOffset": 4,
                        "lineIndex": 0,
                    },
                    "label": null,
                }
            }),
        )
        .unwrap_err();
    assert_eq!(mismatch["code"], "invalid_anchor");

    // Reopen database on next launch and verify bookmark persists, then delete it.
    let bookmark_id = created["id"].clone();
    let Harness { dir, app, .. } = h;
    drop(app);

    let next = Harness::in_dir(dir);
    let listed = next.ok("list_bookmarks", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], bookmark_id);

    next.ok("delete_bookmark", json!({ "bookmarkId": bookmark_id }));
    assert_eq!(next.ok("list_bookmarks", json!({})), json!([]));

    let missing = next
        .call("delete_bookmark", json!({ "bookmarkId": bookmark_id }))
        .unwrap_err();
    assert_eq!(missing["code"], "not_found");
}

#[test]
fn independent_annotations_round_trip_and_preserve_shared_cards() {
    let h = Harness::new();
    let document = h.register("book.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));

    // Cross-page PDF anchor on an independent annotation.
    let cross_page_anchor = json!({
        "format": "pdf",
        "pageIndex": 0,
        "rects": [{ "x": 0.1, "y": 0.85, "width": 0.8, "height": 0.08 }],
        "pageSpans": [
            {
                "pageIndex": 0,
                "rects": [{ "x": 0.1, "y": 0.85, "width": 0.8, "height": 0.08 }]
            },
            {
                "pageIndex": 1,
                "rects": [{ "x": 0.1, "y": 0.05, "width": 0.7, "height": 0.06 }]
            }
        ]
    });

    let created = h.ok(
        "create_annotation",
        json!({
            "input": {
                "documentId": document["id"],
                "notebookId": notebook["id"],
                "anchor": cross_page_anchor,
                "excerptText": "cross page text",
                "excerptImagePng": null,
                "note": "inline commentary",
                "color": "#fde047",
                "style": "underline",
            }
        }),
    );
    assert_eq!(created["excerptText"], "cross page text");
    assert_eq!(created["style"], "underline");
    assert_eq!(created["note"], "inline commentary");
    assert_eq!(created["color"], "#fde047");
    assert_eq!(created["anchor"], cross_page_anchor);

    let updated = h.ok(
        "update_annotation",
        json!({
            "annotationId": created["id"],
            "patch": {
                "note": "edited commentary",
                "color": "#93c5fd",
                "style": "highlight",
            }
        }),
    );
    assert_eq!(updated["note"], "edited commentary");
    assert_eq!(updated["style"], "highlight");
    assert_eq!(updated["color"], "#93c5fd");

    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    assert_eq!(graph["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(graph["cards"].as_array().unwrap().len(), 0);
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 0);

    h.ok(
        "delete_annotation",
        json!({ "annotationId": created["id"] }),
    );
    let graph_after = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    assert_eq!(graph_after["annotations"].as_array().unwrap().len(), 0);
}

#[test]
fn annotation_style_defaults_to_highlight_and_rejects_unknown_styles() {
    let h = Harness::new();
    let document = h.register("notes.txt", "some text");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));
    let input = |style: Option<&str>| {
        let mut input = json!({
            "documentId": document["id"],
            "notebookId": notebook["id"],
            "anchor": {
                "format": "txt",
                "startByteOffset": 0,
                "endByteOffset": 4,
                "lineIndex": 0,
            },
            "excerptText": "some",
            "excerptImagePng": null,
            "note": null,
            "color": "#fde047",
        });
        if let Some(style) = style {
            input["style"] = json!(style);
        }
        json!({ "input": input })
    };

    // A caller that predates styles still creates a highlight.
    let created = h.ok("create_annotation", input(None));
    assert_eq!(created["style"], "highlight");

    let error = h
        .call("create_annotation", input(Some("strikethrough")))
        .unwrap_err();
    assert!(error.to_string().contains("strikethrough"), "{error}");

    // A patch without `style` keeps it.
    let updated = h.ok(
        "update_annotation",
        json!({
            "annotationId": created["id"],
            "patch": { "note": null, "color": "#86efac" }
        }),
    );
    assert_eq!(updated["style"], "highlight");
}

#[test]
fn workspace_session_and_touch_document_opened_persist_across_relaunch() {
    let h = Harness::new();
    let first = h.register("first.pdf", "pdf bytes 1");
    let second = h.register("second.txt", "txt bytes 2");
    assert!(first["lastOpenedAt"].is_string());

    let touched = h.ok(
        "touch_document_opened",
        json!({ "documentId": first["id"] }),
    );
    assert!(touched["lastOpenedAt"].is_string());

    let saved = h.ok(
        "save_workspace_session",
        json!({
            "session": {
                "openDocumentIds": [first["id"], second["id"]],
                "activeDocumentId": second["id"],
                "immersive": true,
            }
        }),
    );
    assert_eq!(
        saved,
        json!({
            "openDocumentIds": [first["id"], second["id"]],
            "activeDocumentId": second["id"],
            "immersive": true,
            "paneLayout": {
                "mindMapOpen": false,
                "inspectorOpen": false,
                "mindMapSize": null,
                "inspectorSize": null,
            },
        })
    );

    let first_id = first["id"].clone();
    let second_id = second["id"].clone();
    let Harness { dir, app, .. } = h;
    drop(app);

    let next = Harness::in_dir(dir);
    assert_eq!(
        next.ok("get_workspace_session", json!({})),
        json!({
            "openDocumentIds": [first_id, second_id.clone()],
            "activeDocumentId": second_id,
            "immersive": true,
            "paneLayout": {
                "mindMapOpen": false,
                "inspectorOpen": false,
                "mindMapSize": null,
                "inspectorSize": null,
            },
        })
    );

    // A session saved without the flag, as an older frontend sends it, is not immersive.
    let legacy = next.ok(
        "save_workspace_session",
        json!({ "session": { "openDocumentIds": [first_id], "activeDocumentId": null } }),
    );
    assert_eq!(legacy["immersive"], false);
}

#[test]
fn hide_document_from_recent_persists_across_relaunch_and_reopening_clears_it() {
    let h = Harness::new();
    let doc = h.register("recent.txt", "recent content");
    assert_eq!(doc["hiddenFromRecentAt"], Value::Null);

    let hidden = h.ok(
        "hide_document_from_recent",
        json!({ "documentId": doc["id"] }),
    );
    assert!(hidden["hiddenFromRecentAt"].is_string());

    let listed = h.ok("list_documents", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(
        listed[0]["hiddenFromRecentAt"],
        hidden["hiddenFromRecentAt"]
    );

    let doc_id = doc["id"].clone();
    let hidden_at = hidden["hiddenFromRecentAt"].clone();
    let Harness { dir, app, .. } = h;
    drop(app);

    let next = Harness::in_dir(dir);
    let listed_after_relaunch = next.ok("list_documents", json!({}));
    assert_eq!(listed_after_relaunch.as_array().unwrap().len(), 1);
    assert_eq!(listed_after_relaunch[0]["hiddenFromRecentAt"], hidden_at);

    let touched = next.ok("touch_document_opened", json!({ "documentId": doc_id }));
    assert_eq!(touched["hiddenFromRecentAt"], Value::Null);
}

#[test]
fn set_document_display_title_sanitizes_persists_and_clears_over_ipc() {
    let h = Harness::new();
    let doc = h.register("pg1342.txt", "pride and prejudice");
    assert_eq!(doc["displayTitle"], Value::Null);

    let updated = h.ok(
        "set_document_display_title",
        json!({
            "documentId": doc["id"],
            "displayTitle": "  Pride and\nPrejudice ",
            "expectedFileHash": doc["fileHash"],
        }),
    );
    assert_eq!(updated["title"], "pg1342");
    assert_eq!(updated["displayTitle"], "Pride and");

    // Wrong expectedFileHash is a no-op returning null and leaves the record unchanged.
    let mismatched = h.ok(
        "set_document_display_title",
        json!({
            "documentId": doc["id"],
            "displayTitle": "Stale Source Title",
            "expectedFileHash": "wrong-hash",
        }),
    );
    assert_eq!(mismatched, Value::Null);

    let doc_id = doc["id"].clone();
    let doc_hash = doc["fileHash"].clone();
    let Harness { dir, app, .. } = h;
    drop(app);

    let next = Harness::in_dir(dir);
    let listed = next.ok("list_documents", json!({}));
    assert_eq!(listed[0]["title"], "pg1342");
    assert_eq!(listed[0]["displayTitle"], "Pride and");

    let cleared = next.ok(
        "set_document_display_title",
        json!({
            "documentId": doc_id,
            "displayTitle": null,
            "expectedFileHash": doc_hash,
        }),
    );
    assert_eq!(cleared["displayTitle"], Value::Null);
}

#[test]
fn annotation_location_label_round_trips_and_names_capture_cards_over_ipc() {
    let h = Harness::new();
    let txt = h.register("book.txt", "hello world");
    let pdf = h.register("slides.pdf", "pdf bytes");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));

    // Excerpt with locationLabel sanitizes, persists, and reloads through load_notebook_graph.
    let created = h.ok(
        "create_excerpt",
        json!({
            "input": {
                "documentId": txt["id"],
                "notebookId": notebook["id"],
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                "excerptText": "hello",
                "excerptImagePng": null,
                "color": "#fde047",
                "parentNodeId": null,
                "posX": 10.0,
                "posY": 20.0,
                "locationLabel": "  Chapter 1 · Line 1 \nignored ",
            }
        }),
    );
    assert_eq!(created["annotation"]["locationLabel"], "Chapter 1 · Line 1");
    assert_eq!(created["card"]["title"], "hello");

    // Capture excerpt with locationLabel gets a descriptive default title ("Figure · ...").
    let capture = h
        .capture(&pdf, &notebook, json!({ "locationLabel": "Ch. 3 · p. 12" }))
        .unwrap();
    assert_eq!(capture["annotation"]["locationLabel"], "Ch. 3 · p. 12");
    assert_eq!(capture["card"]["title"], "Figure · Ch. 3 · p. 12");

    // Independent annotation also persists locationLabel, and omitting it stays valid.
    let annotated = h.ok(
        "create_annotation",
        json!({
            "input": {
                "documentId": txt["id"],
                "notebookId": notebook["id"],
                "anchor": { "format": "txt", "startByteOffset": 6, "endByteOffset": 11, "lineIndex": 0 },
                "excerptText": "world",
                "excerptImagePng": null,
                "note": "key term",
                "color": "#fde047",
                "style": "highlight",
                "locationLabel": "Line 1",
            }
        }),
    );
    assert_eq!(annotated["locationLabel"], "Line 1");

    let omitted = h.ok(
        "create_annotation",
        json!({
            "input": {
                "documentId": txt["id"],
                "notebookId": notebook["id"],
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                "excerptText": "hello",
                "excerptImagePng": null,
                "note": null,
                "color": "#fde047",
                "style": "highlight",
            }
        }),
    );
    assert_eq!(omitted["locationLabel"], Value::Null);

    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    let annotations = graph["annotations"].as_array().unwrap();
    assert_eq!(annotations.len(), 4);
    assert!(
        annotations
            .iter()
            .any(|a| a["id"] == created["annotation"]["id"]
                && a["locationLabel"] == "Chapter 1 · Line 1")
    );
    assert!(
        annotations.iter().any(
            |a| a["id"] == capture["annotation"]["id"] && a["locationLabel"] == "Ch. 3 · p. 12"
        )
    );
    assert!(
        annotations
            .iter()
            .any(|a| a["id"] == annotated["id"] && a["locationLabel"] == "Line 1")
    );
    assert!(
        annotations
            .iter()
            .any(|a| a["id"] == omitted["id"] && a["locationLabel"] == Value::Null)
    );

    // Content-changing relink over IPC clears locationLabel for active and soft-deleted annotations.
    h.ok(
        "delete_annotation",
        json!({ "annotationId": annotated["id"] }),
    );
    std::fs::write(h.dir.path().join("book.txt"), "completely revised text").unwrap();
    let relinked = h.ok(
        "relink_document",
        json!({ "documentId": txt["id"], "confirmInPlace": true }),
    );
    assert_eq!(relinked["contentChanged"], true);

    let after_relink = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    let after_annotations = after_relink["annotations"].as_array().unwrap();
    assert!(
        after_annotations
            .iter()
            .any(|a| a["id"] == created["annotation"]["id"] && a["locationLabel"] == Value::Null)
    );
    assert!(
        after_annotations.iter().any(
            |a| a["id"] == capture["annotation"]["id"] && a["locationLabel"] == "Ch. 3 · p. 12"
        )
    );
    let restored = h.ok(
        "restore_annotation",
        json!({ "annotationId": annotated["id"] }),
    );
    assert_eq!(restored["annotation"]["locationLabel"], Value::Null);

    // Stale expectedFileHash from before relink is rejected on create_excerpt and create_annotation.
    let stale_excerpt_err = h
        .call(
            "create_excerpt",
            json!({
                "input": {
                    "documentId": txt["id"],
                    "notebookId": notebook["id"],
                    "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                    "excerptText": "hello",
                    "excerptImagePng": null,
                    "color": "#fde047",
                    "parentNodeId": null,
                    "posX": 0.0,
                    "posY": 0.0,
                    "locationLabel": "Old chapter · Line 1",
                    "expectedFileHash": txt["fileHash"],
                }
            }),
        )
        .unwrap_err();
    assert_eq!(stale_excerpt_err["code"], "invalid_anchor");

    let stale_ann_err = h
        .call(
            "create_annotation",
            json!({
                "input": {
                    "documentId": txt["id"],
                    "notebookId": notebook["id"],
                    "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 5, "lineIndex": 0 },
                    "excerptText": "hello",
                    "excerptImagePng": null,
                    "note": null,
                    "color": "#fde047",
                    "style": "highlight",
                    "locationLabel": "Old chapter · Line 1",
                    "expectedFileHash": txt["fileHash"],
                }
            }),
        )
        .unwrap_err();
    assert_eq!(stale_ann_err["code"], "invalid_anchor");
}

#[test]
fn menu_item_states_accept_exactly_what_the_frontend_sends() {
    let h = Harness::new();
    // The mock runtime cannot build a native menu, so this checks the wire format and
    // that a window without a menu (tests, or a platform without one) is not an error.
    // `menu::tests` checks the menu contract itself.
    h.ok(
        "set_menu_item_states",
        json!({
            "states": [
                { "id": "bookmarks.toggle", "enabled": true, "title": "Remove Bookmark" },
                { "id": "view.rotateLeft", "enabled": false },
                { "id": "not.a.command", "enabled": true },
            ]
        }),
    );
    assert!(
        h.call(
            "set_menu_item_states",
            json!({ "states": [{ "id": "file.open", "enabled": true, "checked": true }] }),
        )
        .is_err()
    );
    assert!(
        h.call(
            "set_menu_item_states",
            json!({ "states": [{ "id": "file.open" }] })
        )
        .is_err()
    );
}

#[test]
fn verify_and_relink_document_source_grants_asset_scope_and_preserves_annotations() {
    let h = Harness::new();
    let doc = h.register("source.txt", "original text");
    let doc_id = doc["id"].as_str().unwrap();

    let status = h.ok("verify_document_source", json!({ "documentId": doc_id }));
    assert_eq!(status["state"], "ok");
    assert_eq!(status["currentFileHash"], doc["fileHash"]);

    // Modify file in-place: `verify_document_source` reports `changed`, and `relink_document`
    // with `confirmInPlace: true` updates the hash without needing a native picker.
    let source_path = h.dir.path().join("source.txt");
    std::fs::write(&source_path, "updated text content").unwrap();
    let changed = h.ok("verify_document_source", json!({ "documentId": doc_id }));
    assert_eq!(changed["state"], "changed");

    let confirmed = h.ok(
        "relink_document",
        json!({ "documentId": doc_id, "confirmInPlace": true }),
    );
    assert_eq!(confirmed["contentChanged"], true);
    assert_eq!(confirmed["previousFileHash"], doc["fileHash"]);
    assert_eq!(
        confirmed["document"]["fileHash"],
        changed["currentFileHash"]
    );

    // Move file to a new path and relink via `relink_and_grant`: asset scope is granted to new path.
    let moved_path = h.dir.path().join("relocated.txt");
    std::fs::rename(&source_path, &moved_path).unwrap();
    let missing = h.ok("verify_document_source", json!({ "documentId": doc_id }));
    assert_eq!(missing["state"], "missing");

    let relinked =
        serde_json::to_value(relink_and_grant(h.app.handle(), doc_id, &moved_path).unwrap())
            .unwrap();
    assert_eq!(relinked["contentChanged"], false);
    assert_eq!(relinked["document"]["title"], "relocated");
    assert!(h.asset_allowed(&moved_path));
}

#[test]
fn delete_card_and_restore_card_round_trip_over_ipc() {
    let h = Harness::new();
    let doc = h.register("notes.txt", "parent child");
    let notebook = h.ok("create_notebook", json!({ "title": "Study" }));

    let parent = h.excerpt(&doc, &notebook, None);
    let child = h.excerpt(&doc, &notebook, Some(&parent["node"]));

    h.ok(
        "update_card",
        json!({
            "cardId": parent["card"]["id"],
            "patch": { "title": "Parent", "markdownNotes": "Saved note", "tags": ["t1", "t2"] },
        }),
    );

    let deleted = h.ok("delete_card", json!({ "cardId": parent["card"]["id"] }));
    assert_eq!(deleted["cardId"], parent["card"]["id"]);
    assert_eq!(deleted["nodeIds"], json!([parent["node"]["id"]]));
    assert_eq!(
        deleted["rerootedChildNodeIds"],
        json!([child["node"]["id"]])
    );
    assert_eq!(deleted["edgeIds"].as_array().unwrap().len(), 1);

    let graph = h.ok(
        "load_notebook_graph",
        json!({ "notebookId": notebook["id"] }),
    );
    // Highlight stays in reader; child is re-rooted, not deleted.
    assert_eq!(graph["annotations"].as_array().unwrap().len(), 2);
    assert_eq!(graph["cards"].as_array().unwrap().len(), 1);
    assert_eq!(graph["nodes"][0]["id"], child["node"]["id"]);
    assert_eq!(graph["nodes"][0]["parentNodeId"], Value::Null);
    assert!(graph["edges"].as_array().unwrap().is_empty());

    let missing = h
        .call("delete_card", json!({ "cardId": parent["card"]["id"] }))
        .unwrap_err();
    assert_eq!(missing["code"], "not_found");

    let restored = h.ok("restore_card", json!({ "cardId": parent["card"]["id"] }));
    assert_eq!(restored["card"]["title"], "Parent");
    assert_eq!(restored["card"]["markdownNotes"], "Saved note");
    assert_eq!(restored["card"]["tags"], json!(["t1", "t2"]));
    assert_eq!(restored["nodes"][0]["id"], parent["node"]["id"]);
    assert_eq!(restored["edges"].as_array().unwrap().len(), 1);
    assert_eq!(
        restored["reparentedChildren"][0]["parentNodeId"],
        parent["node"]["id"]
    );

    // "Source removed" cards can also be deleted cleanly.
    h.ok(
        "delete_annotation",
        json!({ "annotationId": child["annotation"]["id"] }),
    );
    let deleted_orphan = h.ok("delete_card", json!({ "cardId": child["card"]["id"] }));
    assert_eq!(deleted_orphan["cardId"], child["card"]["id"]);
}

#[test]
fn workspace_session_round_trips_pane_layout_and_defaults_without_it() {
    let h = Harness::new();
    let initial = h.ok("get_workspace_session", json!({}));
    assert_eq!(
        initial["paneLayout"],
        json!({
            "mindMapOpen": false,
            "inspectorOpen": false,
            "mindMapSize": null,
            "inspectorSize": null,
        })
    );

    let saved = h.ok(
        "save_workspace_session",
        json!({
            "session": {
                "openDocumentIds": [],
                "activeDocumentId": null,
                "immersive": false,
                "paneLayout": {
                    "mindMapOpen": true,
                    "inspectorOpen": true,
                    "mindMapSize": 40.0,
                    "inspectorSize": 25.0,
                }
            }
        }),
    );
    assert_eq!(saved["paneLayout"]["mindMapOpen"], true);
    assert_eq!(saved["paneLayout"]["inspectorOpen"], true);
    assert_eq!(saved["paneLayout"]["mindMapSize"], 40.0);
    assert_eq!(saved["paneLayout"]["inspectorSize"], 25.0);

    // Older payload omitting `paneLayout` still deserializes via `#[serde(default)]`.
    let legacy = h.ok(
        "save_workspace_session",
        json!({
            "session": {
                "openDocumentIds": [],
                "activeDocumentId": null,
                "immersive": true,
            }
        }),
    );
    assert_eq!(legacy["immersive"], true);
    assert_eq!(legacy["paneLayout"]["mindMapOpen"], false);
}

#[test]
fn confirm_flush_before_close_acknowledges_pending_token() {
    let h = Harness::new();
    let coordinator = h.app.state::<CloseFlushCoordinator>();
    let token = match coordinator.begin_close() {
        CloseDecision::StartFlush(token) => token,
        other => panic!("expected StartFlush, got {other:?}"),
    };
    h.ok("confirm_flush_before_close", json!({ "token": token }));
    assert!(coordinator.wait_for_flush(token, std::time::Duration::from_millis(50)));
}

/// T-27: Hashing a large/slow file during `register_and_grant`, `relink_and_grant`,
/// or `verify_document_source` must never hold `Mutex<Database>`, so concurrent
/// database commands (such as debounced cursor saves) complete immediately.
#[test]
fn database_commands_complete_while_file_hashing_is_in_progress() {
    use std::sync::mpsc;
    use std::time::Duration;
    use synapse_core::db::{hash_document_for_registration, hash_document_for_relink};
    use synapse_core::domain::DocumentSourceState;
    use synapse_core::fs_reader::hash_file;

    let h = Harness::new();
    let existing = h.register("existing.txt", "initial content");
    let existing_id = existing["id"].as_str().unwrap().to_owned();
    let timeout = Duration::from_secs(5);

    // 1. `register_and_grant` releases DB lock (never holds it) during hashing.
    let slow_register_path = h.dir.path().join("slow-register.txt");
    std::fs::write(&slow_register_path, "large book bytes").unwrap();
    {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let app = h.app.handle().clone();
        let path = slow_register_path.clone();

        let worker = std::thread::spawn(move || {
            register_and_grant_with_hasher(&app, &path, |p| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(timeout)
                    .expect("main thread should complete DB command and release hasher");
                hash_document_for_registration(p)
            })
        });

        entered_rx
            .recv_timeout(timeout)
            .expect("register hasher should start");
        // If the DB lock were held during hashing, this IPC write would deadlock.
        h.ok(
            "update_document_cursor",
            json!({
                "documentId": existing_id,
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 7, "lineIndex": 0 },
                "progress": 0.25,
            }),
        );
        release_tx.send(()).unwrap();

        let registered = worker
            .join()
            .expect("register worker should not panic")
            .expect("register_and_grant should succeed");
        assert_eq!(registered.title, "slow-register");
        assert!(h.asset_allowed(&slow_register_path));
    }

    // 2. `verify_document_source` drops DB lock before `fs::metadata` and `hash_file`.
    {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let app = h.app.handle().clone();
        let doc_id = existing_id.clone();

        let worker = std::thread::spawn(move || {
            verify_document_source_with_hasher(&app, &doc_id, |p| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(timeout)
                    .expect("main thread should complete DB command and release hasher");
                hash_file(p)
            })
        });

        entered_rx
            .recv_timeout(timeout)
            .expect("verify hasher should start");
        h.ok(
            "update_document_cursor",
            json!({
                "documentId": existing_id,
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 7, "lineIndex": 0 },
                "progress": 0.5,
            }),
        );
        release_tx.send(()).unwrap();

        let status = worker
            .join()
            .expect("verify worker should not panic")
            .expect("verify_document_source should succeed");
        assert_eq!(status.state, DocumentSourceState::Ok);
    }

    // 3. `relink_and_grant` drops DB lock before hashing, then rechecks invariants on commit.
    let slow_relink_path = h.dir.path().join("slow-relink.txt");
    std::fs::write(&slow_relink_path, "revised book bytes").unwrap();
    {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let app = h.app.handle().clone();
        let doc_id = existing_id.clone();
        let path = slow_relink_path.clone();

        let worker = std::thread::spawn(move || {
            relink_and_grant_with_hasher(&app, &doc_id, &path, |format, p| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(timeout)
                    .expect("main thread should complete DB command and release hasher");
                hash_document_for_relink(format, p)
            })
        });

        entered_rx
            .recv_timeout(timeout)
            .expect("relink hasher should start");
        h.ok(
            "update_document_cursor",
            json!({
                "documentId": existing_id,
                "anchor": { "format": "txt", "startByteOffset": 0, "endByteOffset": 7, "lineIndex": 0 },
                "progress": 0.75,
            }),
        );
        release_tx.send(()).unwrap();

        let relinked = worker
            .join()
            .expect("relink worker should not panic")
            .expect("relink_and_grant should succeed");
        assert!(relinked.content_changed);
        assert_eq!(relinked.document.title, "slow-relink");
        assert!(h.asset_allowed(&slow_relink_path));
    }

    // 4. Concurrent registration of the same file while `relink_and_grant` is hashing
    // is caught by the commit transaction's `file_hash` uniqueness recheck.
    let colliding_path = h.dir.path().join("colliding.txt");
    std::fs::write(&colliding_path, "colliding content").unwrap();
    {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let app = h.app.handle().clone();
        let doc_id = existing_id.clone();
        let path = colliding_path.clone();

        let worker = std::thread::spawn(move || {
            relink_and_grant_with_hasher(&app, &doc_id, &path, |format, p| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(timeout)
                    .expect("main thread should register colliding doc and release hasher");
                hash_document_for_relink(format, p)
            })
        });

        entered_rx
            .recv_timeout(timeout)
            .expect("relink collision hasher should start");
        register_and_grant(h.app.handle(), &colliding_path).unwrap();
        release_tx.send(()).unwrap();

        let err = worker
            .join()
            .expect("relink collision worker should not panic")
            .expect_err("commit should reject hash collision introduced during hashing");
        assert_eq!(serde_json::to_value(err).unwrap()["code"], "invalid_graph");
    }
}

/// If a document is relinked while `verify_document_source` is hashing the old
/// file outside `Mutex<Database>`, verification must detect the changed record
/// and retry against the relinked file instead of returning a stale `Changed`.
#[test]
fn verify_document_source_rechecks_after_concurrent_relink() {
    use std::sync::mpsc;
    use std::time::Duration;
    use synapse_core::domain::DocumentSourceState;
    use synapse_core::fs_reader::hash_file;

    let h = Harness::new();
    let doc = h.register("original.txt", "original content");
    let doc_id = doc["id"].as_str().unwrap().to_owned();
    let original_path = h.dir.path().join("original.txt");
    std::fs::write(&original_path, "modified original content").unwrap();

    let relinked_path = h.dir.path().join("relinked.txt");
    std::fs::write(&relinked_path, "relinked valid content").unwrap();

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let timeout = Duration::from_secs(5);
    let app = h.app.handle().clone();
    let worker_doc_id = doc_id.clone();

    let worker = std::thread::spawn(move || {
        let mut attempts = 0usize;
        let status = verify_document_source_with_hasher(&app, &worker_doc_id, |p| {
            attempts += 1;
            if attempts == 1 {
                entered_tx.send(p.to_path_buf()).unwrap();
                release_rx
                    .recv_timeout(timeout)
                    .expect("main thread should relink document and release hasher");
            }
            hash_file(p)
        })?;
        Ok::<_, crate::error::IpcError>((status, attempts))
    });

    let first_hashed_path = entered_rx
        .recv_timeout(timeout)
        .expect("verify hasher should start on original file");
    assert_eq!(first_hashed_path, original_path);

    let relinked = relink_and_grant(h.app.handle(), &doc_id, &relinked_path)
        .expect("relink_and_grant should succeed while verify is paused");
    release_tx.send(()).unwrap();

    let (status, attempts) = worker
        .join()
        .expect("verify worker should not panic")
        .expect("verify_document_source should succeed after retry");
    assert_eq!(attempts, 2);
    assert_eq!(status.state, DocumentSourceState::Ok);
    assert_eq!(status.current_file_hash, Some(relinked.document.file_hash));
}

// ---------------------------------------------------------------------------
// LAN Book Sync IPC, Confirmation, Lifecycle & Info.plist Tests (#143)
// ---------------------------------------------------------------------------

struct StaticInterfaceProvider(Vec<synapse_lan::RawInterface>);

impl synapse_lan::InterfaceProvider for StaticInterfaceProvider {
    fn list_interfaces(&self) -> synapse_lan::LanResult<Vec<synapse_lan::RawInterface>> {
        Ok(self.0.clone())
    }
}

fn fake_lan_interface_provider() -> std::sync::Arc<dyn synapse_lan::InterfaceProvider> {
    std::sync::Arc::new(StaticInterfaceProvider(vec![synapse_lan::RawInterface {
        name: "en0".into(),
        ip: std::net::Ipv4Addr::new(192, 168, 42, 10),
        netmask: std::net::Ipv4Addr::new(255, 255, 255, 0),
        prefix_len: 24,
        is_up: true,
        is_loopback: false,
        is_broadcast: true,
        is_point_to_point: false,
    }]))
}

#[test]
fn lan_share_start_declined_confirmation_starts_no_listener() {
    use std::sync::{Arc, Mutex};

    use crate::commands::lan::{LanState, ShareConfirmPrompt};

    let captured_prompt: Arc<Mutex<Option<ShareConfirmPrompt>>> = Arc::new(Mutex::new(None));
    let prompt_sink = Arc::clone(&captured_prompt);
    let lan = LanState::with_overrides(
        Some(Arc::new(move |prompt: &ShareConfirmPrompt| {
            *prompt_sink.lock().unwrap() = Some(prompt.clone());
            false
        })),
        fake_lan_interface_provider(),
    );
    let h = Harness::in_dir_with_lan(tempfile::tempdir().unwrap(), lan);
    let doc = h.register("novel.txt", "chapter one");

    let interfaces = h.ok("lan_list_interfaces", json!({}));
    assert_eq!(interfaces.as_array().unwrap().len(), 1);
    assert_eq!(interfaces[0]["name"], "en0");
    assert_eq!(interfaces[0]["subnet"]["ip"], "192.168.42.10");

    let started = h.ok(
        "lan_share_start",
        json!({
            "input": {
                "documentIds": [doc["id"]],
                "positions": true,
                "bookmarks": false,
                "interfaceIp": null
            }
        }),
    );
    assert_eq!(
        started,
        Value::Null,
        "declining native confirmation must return null and start no listener (T-12)"
    );

    let prompt = captured_prompt.lock().unwrap().clone().unwrap();
    assert_eq!(prompt.book_count, 1);
    assert!(prompt.positions);
    assert!(!prompt.bookmarks);
    assert!(prompt.message().contains("Transfers are not encrypted."));

    let status = h.ok("lan_share_status", json!({}));
    assert_eq!(status["status"]["state"], "off");
    assert_eq!(status["address"], Value::Null);
    assert_eq!(status["pairingCode"], Value::Null);
}

#[test]
fn lan_ipc_rejects_loopback_hostnames_and_preserves_ipc_error_shape() {
    let h = Harness::new();

    // Production IPC must never allow loopback, hostnames, or public IPs (T-57).
    for address in [
        "127.0.0.1:49319",
        "localhost:49319",
        "example.com:49319",
        "8.8.8.8:49319",
    ] {
        let err = h
            .call(
                "lan_import_connect",
                json!({
                    "input": {
                        "address": address,
                        "code": "123456",
                        "operationId": "op-connect-1"
                    }
                }),
            )
            .unwrap_err();
        assert_eq!(err["code"], "lan_address_invalid", "address: {address}");
        assert_eq!(
            err.as_object().unwrap().len(),
            2,
            "IpcError must stay strictly {{ code, message }} (R3-07)"
        );
    }

    // Malformed pairing codes are rejected before any network call.
    let bad_code = h
        .call(
            "lan_import_connect",
            json!({
                "input": {
                    "address": "192.168.1.50:49319",
                    "code": "12ab56",
                    "operationId": null
                }
            }),
        )
        .unwrap_err();
    assert_eq!(bad_code["code"], "lan_auth_invalid");
    assert_eq!(bad_code.as_object().unwrap().len(), 2);

    // Every LAN command exercises the exact camelCase IPC payload contract.
    assert_eq!(
        h.ok("lan_share_status", json!({}))["status"]["state"],
        "off"
    );
    assert_eq!(
        h.call("lan_share_regenerate_code", json!({})).unwrap_err()["code"],
        "lan_auth_expired"
    );
    assert_eq!(h.ok("lan_share_stop", json!({}))["status"]["state"], "off");
    assert_eq!(
        h.ok("lan_share_disconnect_peer", json!({}))["status"]["state"],
        "off"
    );

    assert_eq!(
        h.call(
            "lan_import_catalog",
            json!({ "sessionId": "missing-session" })
        )
        .unwrap_err()["code"],
        "lan_auth_expired"
    );
    assert_eq!(
        h.call(
            "lan_import_plan",
            json!({
                "input": {
                    "sessionId": "missing-session",
                    "bookIds": ["a".repeat(64)],
                    "operationId": "op-plan-1"
                },
                "onProgress": "__CHANNEL__:1"
            }),
        )
        .unwrap_err()["code"],
        "lan_auth_expired"
    );
    assert_eq!(
        h.call(
            "lan_import_execute",
            json!({
                "input": {
                    "sessionId": "missing-session",
                    "planId": "missing-plan",
                    "decisions": [],
                    "operationId": "op-exec-1"
                },
                "onProgress": "__CHANNEL__:2"
            }),
        )
        .unwrap_err()["code"],
        "lan_auth_expired"
    );
    assert_eq!(
        h.ok("lan_import_cancel", json!({ "operationId": "unknown-op" })),
        false
    );
    assert_eq!(
        h.ok(
            "lan_import_disconnect",
            json!({ "sessionId": "missing-session" })
        ),
        Value::Null
    );
}

#[test]
fn lan_shutdown_all_cancels_active_receiver_operations() {
    let h = Harness::new();
    let lan = &h.app.state::<AppState>().lan;

    let (_guard_a, token_a) = lan.register_operation_for_tests("op-cancel-direct");
    let (_guard_b, token_b) = lan.register_operation_for_tests("op-cancel-shutdown");
    assert!(!token_a.is_cancelled());
    assert!(!token_b.is_cancelled());

    assert_eq!(
        h.ok(
            "lan_import_cancel",
            json!({ "operationId": "op-cancel-direct" })
        ),
        true
    );
    assert!(token_a.is_cancelled());
    assert!(!token_b.is_cancelled());

    // Simulates CloseRequested / ExitRequested / RunEvent::Exit teardown (`R3-05`).
    lan.shutdown_all();
    assert!(token_b.is_cancelled());
}

#[test]
fn lan_reused_operation_id_old_guard_drop_does_not_clear_new_operation() {
    let h = Harness::new();
    let lan = &h.app.state::<AppState>().lan;

    let (old_guard, old_token) = lan.register_operation_for_tests("shared-op-id");
    let (_new_guard, new_token) = lan.register_operation_for_tests("shared-op-id");
    assert!(
        old_token.is_cancelled(),
        "replacing an active operationId cancels the previous registration"
    );
    assert!(!new_token.is_cancelled());

    // Dropping the stale guard must NOT delete the newer registration.
    drop(old_guard);
    assert_eq!(
        h.ok(
            "lan_import_cancel",
            json!({ "operationId": "shared-op-id" })
        ),
        true
    );
    assert!(new_token.is_cancelled());
}

#[test]
fn lan_share_start_invalidated_by_shutdown_during_confirmation_binds_no_listener() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    use crate::commands::lan::{LanState, ShareConfirmPrompt};

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = std::sync::Mutex::new(release_rx);
    let bind_calls = Arc::new(AtomicUsize::new(0));
    let bind_calls_for_hook = Arc::clone(&bind_calls);

    let lan = LanState::with_test_hooks(
        Some(Arc::new(move |_prompt: &ShareConfirmPrompt| {
            entered_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release blocked confirmer");
            true
        })),
        fake_lan_interface_provider(),
        Some(Arc::new(move |_ip| {
            bind_calls_for_hook.fetch_add(1, Ordering::SeqCst);
            Err(synapse_lan::LanError::BindFailed(
                "binder must not be called after shutdown".into(),
            ))
        })),
    );
    let h = Harness::in_dir_with_lan(tempfile::tempdir().unwrap(), lan);
    let doc = h.register("novel.txt", "chapter one");
    let doc_id = doc["id"].as_str().unwrap().to_owned();

    let window = h.window.clone();
    let worker = std::thread::spawn(move || {
        get_ipc_response(
            &window,
            InvokeRequest {
                cmd: "lan_share_start".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().unwrap(),
                body: InvokeBody::Json(json!({
                    "input": {
                        "documentIds": [doc_id],
                        "positions": true,
                        "bookmarks": true,
                        "interfaceIp": null
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    });

    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("confirmer should be entered");

    // Simulate window close / app quit while confirmation dialog is open.
    h.app.state::<AppState>().lan.shutdown_all();
    release_tx.send(()).unwrap();

    let err = worker
        .join()
        .expect("start thread should not panic")
        .unwrap_err();
    assert_eq!(err["code"], "lan_cancelled");
    assert_eq!(
        bind_calls.load(Ordering::SeqCst),
        0,
        "bind_listener must not run once confirmation was invalidated by shutdown"
    );
    assert_eq!(
        h.ok("lan_share_status", json!({}))["status"]["state"],
        "off"
    );
}

#[test]
fn lan_share_start_rejects_concurrent_start_while_confirmation_is_pending() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    use crate::commands::lan::{LanState, ShareConfirmPrompt};

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = std::sync::Mutex::new(release_rx);
    let confirm_entries = Arc::new(AtomicUsize::new(0));
    let confirm_entries_hook = Arc::clone(&confirm_entries);

    let lan = LanState::with_overrides(
        Some(Arc::new(move |_prompt: &ShareConfirmPrompt| {
            confirm_entries_hook.fetch_add(1, Ordering::SeqCst);
            let _ = entered_tx.send(());
            let _ = release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5));
            false
        })),
        fake_lan_interface_provider(),
    );
    let h = Harness::in_dir_with_lan(tempfile::tempdir().unwrap(), lan);
    let doc = h.register("novel.txt", "chapter one");
    let doc_id = doc["id"].as_str().unwrap().to_owned();

    let window = h.window.clone();
    let doc_id_clone = doc_id.clone();
    let worker = std::thread::spawn(move || {
        get_ipc_response(
            &window,
            InvokeRequest {
                cmd: "lan_share_start".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().unwrap(),
                body: InvokeBody::Json(json!({
                    "input": {
                        "documentIds": [doc_id_clone],
                        "positions": true,
                        "bookmarks": false,
                        "interfaceIp": null
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    });

    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first start should enter confirmation");

    // Second concurrent Start must fail immediately without entering confirmer.
    let second_err = h
        .call(
            "lan_share_start",
            json!({
                "input": {
                    "documentIds": [doc_id],
                    "positions": true,
                    "bookmarks": false,
                    "interfaceIp": null
                }
            }),
        )
        .unwrap_err();
    assert_eq!(second_err["code"], "lan_session_busy");

    release_tx.send(()).unwrap();
    let first_res = worker.join().unwrap().unwrap();
    assert_eq!(first_res, Value::Null);
    assert_eq!(
        confirm_entries.load(Ordering::SeqCst),
        1,
        "only the first concurrent Start may enter native confirmation"
    );
}

#[test]
fn lan_share_stop_reports_stopped_by_user_blocks_start_while_stopping_and_releases_port() {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
    use std::sync::Arc;

    use crate::commands::lan::{LanState, ShareConfirmPrompt};

    let lan = LanState::with_test_hooks(
        Some(Arc::new(|_prompt: &ShareConfirmPrompt| true)),
        fake_lan_interface_provider(),
        Some(Arc::new(|_ip| {
            let std_listener = std::net::TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::LOCALHOST,
                0,
            )))
            .map_err(|err| synapse_lan::LanError::BindFailed(err.to_string()))?;
            std_listener
                .set_nonblocking(true)
                .map_err(|err| synapse_lan::LanError::BindFailed(err.to_string()))?;
            let SocketAddr::V4(local_addr) = std_listener
                .local_addr()
                .map_err(|err| synapse_lan::LanError::BindFailed(err.to_string()))?
            else {
                return Err(synapse_lan::LanError::BindFailed("expected ipv4".into()));
            };
            let listener = tokio::net::TcpListener::from_std(std_listener)
                .map_err(|err| synapse_lan::LanError::BindFailed(err.to_string()))?;
            Ok(synapse_lan::BoundListener {
                listener,
                local_addr,
            })
        })),
    );
    let h = Harness::in_dir_with_lan(tempfile::tempdir().unwrap(), lan);
    let doc = h.register("novel.txt", "chapter one");

    let started = h.ok(
        "lan_share_start",
        json!({
            "input": {
                "documentIds": [doc["id"]],
                "positions": true,
                "bookmarks": true,
                "interfaceIp": null
            }
        }),
    );
    assert_eq!(started["status"]["state"], "listening");
    let bound_addr: SocketAddrV4 = started["address"].as_str().unwrap().parse().unwrap();

    // Stop must report `stoppedByUser` (not `sessionEnded`) and release the socket.
    let stopped = h.ok("lan_share_stop", json!({}));
    assert_eq!(stopped["status"]["state"], "off");
    assert_eq!(stopped["lastStopReason"], "stoppedByUser");

    // Port must be immediately rebindable once `lan_share_stop` returns.
    let rebound = std::net::TcpListener::bind(SocketAddr::V4(bound_addr))
        .expect("port should be released after lan_share_stop returns");
    drop(rebound);

    // While in `Stopping` phase, a new `lan_share_start` must be rejected with `lan_session_busy`.
    h.app.state::<AppState>().lan.set_stopping_for_tests();
    let during_stop = h
        .call(
            "lan_share_start",
            json!({
                "input": {
                    "documentIds": [doc["id"]],
                    "positions": true,
                    "bookmarks": true,
                    "interfaceIp": null
                }
            }),
        )
        .unwrap_err();
    assert_eq!(during_stop["code"], "lan_session_busy");
    h.app.state::<AppState>().lan.clear_stopping_for_tests();
}

#[test]
fn lan_closing_rejects_late_share_start_and_import_connect_during_close_flush() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::commands::lan::{LanState, ShareConfirmPrompt};

    let confirm_calls = Arc::new(AtomicUsize::new(0));
    let confirm_calls_hook = Arc::clone(&confirm_calls);
    let bind_calls = Arc::new(AtomicUsize::new(0));
    let bind_calls_hook = Arc::clone(&bind_calls);

    let lan = LanState::with_test_hooks(
        Some(Arc::new(move |_prompt: &ShareConfirmPrompt| {
            confirm_calls_hook.fetch_add(1, Ordering::SeqCst);
            true
        })),
        fake_lan_interface_provider(),
        Some(Arc::new(move |_ip| {
            bind_calls_hook.fetch_add(1, Ordering::SeqCst);
            Err(synapse_lan::LanError::BindFailed(
                "must never bind once window is closing".into(),
            ))
        })),
    );
    let h = Harness::in_dir_with_lan(tempfile::tempdir().unwrap(), lan);
    let doc = h.register("novel.txt", "chapter one");

    // Simulate `WindowEvent::CloseRequested`: start close flush and latch LAN closing.
    let coordinator = h.app.state::<CloseFlushCoordinator>();
    assert!(matches!(
        coordinator.begin_close(),
        CloseDecision::StartFlush(_)
    ));
    h.app.state::<AppState>().lan.shutdown_all();

    // Late `lan_share_start` during close-flush must fail immediately without
    // opening the native confirmation dialog or binding any socket.
    let start_err = h
        .call(
            "lan_share_start",
            json!({
                "input": {
                    "documentIds": [doc["id"]],
                    "positions": true,
                    "bookmarks": true,
                    "interfaceIp": null
                }
            }),
        )
        .unwrap_err();
    assert_eq!(start_err["code"], "lan_cancelled");
    assert_eq!(confirm_calls.load(Ordering::SeqCst), 0);
    assert_eq!(bind_calls.load(Ordering::SeqCst), 0);

    // Late `lan_import_connect` during close-flush must also fail immediately
    // with `lan_cancelled` before attempting any TCP connect / pair.
    let connect_err = h
        .call(
            "lan_import_connect",
            json!({
                "input": {
                    "address": "192.168.42.99:49319",
                    "code": "123456",
                    "operationId": "late-connect-op"
                }
            }),
        )
        .unwrap_err();
    assert_eq!(connect_err["code"], "lan_cancelled");

    // Cleanup commands (`lan_share_stop`, `lan_import_cancel`, `lan_import_disconnect`)
    // remain callable during closing.
    assert_eq!(h.ok("lan_share_stop", json!({}))["status"]["state"], "off");
    assert_eq!(
        h.ok(
            "lan_import_cancel",
            json!({ "operationId": "late-connect-op" })
        ),
        false
    );
    assert_eq!(
        h.ok(
            "lan_import_disconnect",
            json!({ "sessionId": "any-session" })
        ),
        Value::Null
    );
}

#[test]
fn lan_per_book_commit_grants_book1_before_book2_and_keeps_part_out_of_scope() {
    use synapse_core::domain::DocumentFormat;
    use synapse_core::fs_reader::hash_file;

    use crate::commands::lan::grant_committed_book;

    let h = Harness::new();
    let library = h
        .app
        .state::<AppState>()
        .database()
        .unwrap()
        .managed_library()
        .cloned()
        .unwrap();

    // Prepare two books' bytes and hashes.
    let b1_src = h.dir.path().join("src1.txt");
    let b2_src = h.dir.path().join("src2.txt");
    std::fs::write(&b1_src, b"First synced book content").unwrap();
    std::fs::write(&b2_src, b"Second synced book content").unwrap();
    let h1 = hash_file(&b1_src).unwrap();
    let h2 = hash_file(&b2_src).unwrap();

    // Stage and publish Book 1, then commit it into SQLite.
    let mut staged1 = library
        .begin_stage(DocumentFormat::Txt, "txt", &h1, 25)
        .unwrap();
    let part1 = staged1.part_path().to_path_buf();
    assert!(
        !h.asset_allowed(&part1),
        ".part file must never be in asset scope"
    );
    staged1.write_chunk(b"First synced book content").unwrap();
    let published1 = staged1.finish().unwrap();

    let import1 = h
        .app
        .state::<AppState>()
        .database()
        .unwrap()
        .import_document(&published1, &h1, "Book One", DocumentFormat::Txt)
        .unwrap();
    let doc1 = import1.document().clone();

    // Book 2 is still in-flight in `sync-staging/` as a `.part` file.
    let mut staged2 = library
        .begin_stage(DocumentFormat::Txt, "txt", &h2, 26)
        .unwrap();
    let part2 = staged2.part_path().to_path_buf();
    staged2.write_chunk(b"Second synced").unwrap();

    // Before commit callback runs, Book 1's published file is not yet granted.
    assert!(!h.asset_allowed(&published1));

    // Commit callback runs BEFORE `BookCompleted` emits (`R2-07`).
    grant_committed_book(
        h.app.handle(),
        &synapse_lan::BookCommitEvent {
            book_id: h1.clone(),
            document: doc1,
            file_result: Some(import1),
            position_replaced: false,
            inserted_bookmarks: Vec::new(),
        },
    );

    // At the moment Book 1's `BookCompleted` is emitted (while Book 2 is still
    // downloading into `part2`), Book 1 has exact-file grant and Book 2's `.part`
    // remains outside the asset scope (`R2-07`, `S-11`).
    assert!(
        h.asset_allowed(&published1),
        "Book 1 must be granted before BookCompleted while Book 2 is still in flight"
    );
    assert!(
        !h.asset_allowed(&part2),
        "Book 2's in-flight .part file must stay outside asset scope"
    );
    assert!(
        !h.asset_allowed(&library.staging_dir()),
        "sync-staging directory must never be in asset scope"
    );

    staged2.cancel();
}

#[test]
fn startup_reconcile_runs_only_under_sole_connection_lock() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite3");
    let staging = dir.path().join("sync-staging");
    std::fs::create_dir_all(&staging).unwrap();

    // First launch is sole connection -> cleans up stale `.part` file.
    let stale_part = staging.join("stale.part");
    std::fs::write(&stale_part, b"orphan").unwrap();
    let first = AppState::open(&db_path).unwrap();
    assert!(first.database().unwrap().is_sole_connection());
    assert!(!stale_part.exists());

    // While first instance is alive, another `.part` appears; second concurrent
    // instance must NOT acquire sole-connection reconcile (`R3-01`, `T-19`).
    let live_part = staging.join("in-progress.part");
    std::fs::write(&live_part, b"active-download").unwrap();
    let second = AppState::open(&db_path).unwrap();
    assert!(!second.database().unwrap().is_sole_connection());
    assert!(live_part.exists());

    // Once both instances exit, the next sole launch reconciles the orphan.
    drop(second);
    drop(first);
    let third = AppState::open(&db_path).unwrap();
    assert!(third.database().unwrap().is_sole_connection());
    assert!(!live_part.exists());
}

#[test]
fn macos_info_plist_declares_local_network_usage_without_bonjour() {
    let plist = include_str!("../Info.plist");
    assert!(
        plist.contains("<key>NSLocalNetworkUsageDescription</key>"),
        "Info.plist must declare NSLocalNetworkUsageDescription (T-44, UA-6)"
    );
    assert!(
        !plist.contains("NSBonjourServices"),
        "V1 uses no mDNS/Bonjour discovery; Info.plist must not declare NSBonjourServices"
    );
}

#[test]
fn macos_bundle_config_enforces_hardened_runtime_without_personal_identity() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let bundle = &config["bundle"];
    assert_eq!(bundle["targets"], json!(["app", "dmg"]));
    let macos = &bundle["macOS"];
    assert_eq!(macos["hardenedRuntime"], Value::Bool(true));
    assert!(
        matches!(macos.get("signingIdentity"), None | Some(Value::Null)),
        "signingIdentity must come from APPLE_SIGNING_IDENTITY or APPLE_CERTIFICATE, not a hardcoded personal identity"
    );
    assert!(
        matches!(macos.get("entitlements"), None | Some(Value::Null)),
        "hardenedRuntime should run without custom exception entitlements unless proven necessary"
    );
}
