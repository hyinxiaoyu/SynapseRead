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
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use crate::state::AppState;

/// Where bundled app content is served from on the mock runtime.
const LOCAL_ORIGIN: &str = "tauri://localhost";

struct Harness {
    _app: App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    dir: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(&dir.path().join("test.sqlite3")).unwrap();
        let app = crate::with_commands(mock_builder())
            .manage(state)
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            _app: app,
            window,
            dir,
        }
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
        self.ok("register_document", json!({ "path": path }))
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
    let path = h.dir.path().join("note.txt");
    std::fs::write(&path, "héllo\nwörld").unwrap();
    // A frontend `Channel` serializes to this form.
    let delivered = h.ok(
        "read_text_stream",
        json!({ "path": path, "encoding": null, "onChunk": "__CHANNEL__:1" }),
    );
    assert_eq!(delivered, 1);
}

#[test]
fn read_text_stream_rejects_unsupported_encoding() {
    let h = Harness::new();
    let path = h.dir.path().join("note.txt");
    std::fs::write(&path, "data").unwrap();
    let error = h
        .call(
            "read_text_stream",
            json!({ "path": path, "encoding": "gbk", "onChunk": "__CHANNEL__:1" }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "unsupported_encoding");
}

/// Remote content must never reach the database or the filesystem.
#[test]
fn commands_are_unreachable_from_remote_origins() {
    let h = Harness::new();
    let result = h.call_from("https://example.com", "list_documents", json!({}));
    assert!(result.is_err());
}
