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

use crate::access::{grant_documents, register_and_grant};
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
                "excerptImagePath": null,
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

    let documents = next
        .app
        .state::<AppState>()
        .database()
        .unwrap()
        .list_documents()
        .unwrap();
    grant_documents(next.app.handle(), &documents).unwrap();
    assert!(next.asset_allowed(&book));
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

    let capability: Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    assert_eq!(
        capability["permissions"],
        json!(["core:default"]),
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
