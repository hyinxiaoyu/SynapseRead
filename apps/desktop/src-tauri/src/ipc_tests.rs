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

use crate::access::{grant_all, register_and_grant, register_dropped_paths, relink_and_grant};
use crate::state::AppState;

/// Where bundled app content is served from on the mock runtime.
const LOCAL_ORIGIN: &str = "tauri://localhost";

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
        let state = AppState::open(&dir.path().join("test.sqlite3")).unwrap();
        let app = crate::with_commands(mock_builder())
            .manage(state)
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
    let wildcard = hidden.join("[a]*.pdf");
    std::fs::write(&wildcard, "wild").unwrap();
    let matched_by_glob = hidden.join("a-other.pdf");
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
            "theme": "light",
            "fontFamily": "serif",
            "fontSize": 100,
            "lineSpacing": 1.75,
            "readingWidth": "medium",
            "epubReadingMode": "spread",
        })
    );

    let updated = json!({
        "theme": "dark",
        "fontFamily": "sans",
        "fontSize": 125,
        "lineSpacing": 1.9,
        "readingWidth": "wide",
        "epubReadingMode": "paged",
    });
    let saved = h.ok(
        "save_reading_preferences",
        json!({ "preferences": updated }),
    );
    assert_eq!(saved, updated);
    assert_eq!(h.ok("get_reading_preferences", json!({})), updated);

    let bad = h
        .call(
            "save_reading_preferences",
            json!({
                "preferences": {
                    "theme": "dark",
                    "fontFamily": "sans",
                    "fontSize": 40,
                    "lineSpacing": 1.9,
                    "readingWidth": "wide",
                    "epubReadingMode": "paged",
                }
            }),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "invalid_preferences");
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
            }
        }),
    );
    assert_eq!(created["excerptText"], "cross page text");
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
            }
        }),
    );
    assert_eq!(updated["note"], "edited commentary");
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
