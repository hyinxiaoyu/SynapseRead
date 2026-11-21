//! Dedicated `/v1` LAN sync wire DTOs (ADR 0008, `OD-9`, `T-14`).
//!
//! These types are intentionally decoupled from `synapse_core::domain::Document`
//! so local filesystem paths, `last_opened_at`, usage timestamps, annotations,
//! MindMap data, reading preferences, and OS device/host names can never be
//! serialized over the wire.
//!
//! Compatibility rule: within `/v1`, fields are only added and receivers ignore
//! unknown fields, so none of these DTOs use `deny_unknown_fields`.

use std::fmt;

use serde::{Deserialize, Serialize};
use synapse_core::domain::{AnchorLocation, DocumentFormat};

pub use crate::http::ErrorResponseBody;
use crate::session::SharePermissions;

/// `GET /v1/hello` response payload (unauthenticated; never includes OS
/// device/host names per `OD-9`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub protocol: u32,
    pub min_protocol: u32,
    pub app: String,
}

/// `POST /v1/pair` request payload.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
}

impl fmt::Debug for PairRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairRequest")
            .field("code", &"[REDACTED]")
            .finish()
    }
}

/// `POST /v1/pair` success response payload.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub token: String,
    pub idle_timeout_seconds: u64,
    pub permissions: SharePermissions,
}

impl fmt::Debug for PairResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairResponse")
            .field("token", &"[REDACTED]")
            .field("idle_timeout_seconds", &self.idle_timeout_seconds)
            .field("permissions", &self.permissions)
            .finish()
    }
}

/// `GET /v1/catalog` response payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub books: Vec<CatalogBook>,
}

/// Privacy-filtered book entry in `GET /v1/catalog` (ADR 0008).
///
/// `has_position` is included only when `permissions.positions` is enabled;
/// `bookmark_count` is included only when `permissions.bookmarks` is enabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBook {
    pub id: String,
    pub title: String,
    pub format: DocumentFormat,
    pub extension: String,
    pub size_bytes: u64,
    pub file_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_count: Option<u64>,
}

/// `GET /v1/books/{sha256}/position` response payload (`200 OK`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionResponse {
    pub anchor: AnchorLocation,
    #[serde(default)]
    pub progress: Option<f64>,
}

/// `GET /v1/books/{sha256}/bookmarks` response payload (`200 OK`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarksResponse {
    pub bookmarks: Vec<WireBookmark>,
}

/// Privacy-filtered bookmark entry in `GET /v1/books/{sha256}/bookmarks`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBookmark {
    pub anchor: AnchorLocation,
    pub label: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;

    const FORBIDDEN_KEYS: &[&str] = &[
        "filePath",
        "file_path",
        "path",
        "localPath",
        "lastOpenedAt",
        "last_opened_at",
        "deviceName",
        "device_name",
        "hostname",
        "hostName",
        "host_name",
        "computerName",
        "annotations",
        "highlights",
        "notes",
        "captures",
        "cards",
        "edges",
        "readingPreferences",
        "pdfLayout",
    ];

    const FORBIDDEN_VALUE_SUBSTRINGS: &[&str] = &[
        "/Users/",
        "/home/",
        "C:\\",
        "\\Users\\",
        "/var/",
        "/tmp/",
        ".local",
    ];

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PairFixture {
        request: PairRequest,
        response: PairResponse,
    }

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract/lan-sync-v1")
    }

    fn load_fixture_value(name: &str) -> Value {
        let path = fixture_dir().join(name);
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|err| {
            panic!("failed to read golden fixture {}: {err}", path.display())
        });
        serde_json::from_str(&raw).unwrap_or_else(|err| {
            panic!("failed to parse golden fixture {}: {err}", path.display())
        })
    }

    fn assert_no_forbidden_fields(value: &Value, context: &str) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    assert!(
                        !FORBIDDEN_KEYS.contains(&key.as_str()),
                        "forbidden wire key '{key}' found in {context}"
                    );
                    assert_no_forbidden_fields(child, context);
                }
            }
            Value::Array(items) => {
                for item in items {
                    assert_no_forbidden_fields(item, context);
                }
            }
            Value::String(text) => {
                for needle in FORBIDDEN_VALUE_SUBSTRINGS {
                    assert!(
                        !text.contains(needle),
                        "forbidden path/host substring '{needle}' found in {context}: {text}"
                    );
                }
            }
            _ => {}
        }
    }

    fn assert_round_trip<T>(fixture_name: &str) -> T
    where
        T: Serialize + DeserializeOwned,
    {
        let original = load_fixture_value(fixture_name);
        assert_no_forbidden_fields(&original, fixture_name);

        let typed: T = serde_json::from_value(original.clone())
            .unwrap_or_else(|err| panic!("failed to deserialize {fixture_name}: {err}"));
        let reserialized = serde_json::to_value(&typed)
            .unwrap_or_else(|err| panic!("failed to reserialize {fixture_name}: {err}"));
        assert_eq!(
            reserialized, original,
            "golden fixture {fixture_name} must round-trip without drift"
        );
        assert_no_forbidden_fields(&reserialized, fixture_name);
        typed
    }

    #[test]
    fn golden_fixtures_round_trip_and_pass_t14_privacy_checks() {
        let hello: HelloResponse = assert_round_trip("hello.json");
        assert_eq!(hello.protocol, 1);
        assert_eq!(hello.min_protocol, 1);
        assert_eq!(hello.app, "synapseread");

        let pair: PairFixture = assert_round_trip("pair.json");
        assert_eq!(pair.request.code.len(), 6);
        assert!(!format!("{:?}", pair.request).contains(&pair.request.code));
        assert!(!format!("{:?}", pair.response).contains(&pair.response.token));

        let catalog: CatalogResponse = assert_round_trip("catalog.json");
        assert_eq!(catalog.books.len(), 3);
        // R2-01: Markdown-as-TXT book preserves `.md` extension under `txt` format.
        assert_eq!(catalog.books[1].format, DocumentFormat::Txt);
        assert_eq!(catalog.books[1].extension, "md");
        assert!(
            synapse_core::library::validate_extension(
                catalog.books[1].format,
                &catalog.books[1].extension
            )
            .is_ok()
        );

        let position: PositionResponse = assert_round_trip("position.json");
        assert_eq!(position.progress, Some(0.42));

        let bookmarks: BookmarksResponse = assert_round_trip("bookmarks.json");
        assert_eq!(bookmarks.bookmarks.len(), 2);

        let error: ErrorResponseBody = assert_round_trip("error.json");
        assert_eq!(error.code, "lan_source_changed");
    }

    #[test]
    fn catalog_book_omits_optional_permission_fields_when_none() {
        let book = CatalogBook {
            id: "a".repeat(64),
            title: "Scoped Book".into(),
            format: DocumentFormat::Pdf,
            extension: "pdf".into(),
            size_bytes: 1234,
            file_available: true,
            has_position: None,
            bookmark_count: None,
        };
        let value = serde_json::to_value(&book).expect("serialize");
        let obj = value.as_object().expect("json object");
        assert!(!obj.contains_key("hasPosition"));
        assert!(!obj.contains_key("bookmarkCount"));
        assert_no_forbidden_fields(&value, "scoped CatalogBook");
    }

    #[test]
    fn wire_dtos_ignore_unknown_future_v1_fields() {
        let hello: HelloResponse = serde_json::from_str(
            r#"{"protocol":1,"minProtocol":1,"app":"synapseread","futureField":true}"#,
        )
        .expect("hello ignores unknown field");
        assert_eq!(hello.protocol, 1);

        let catalog: CatalogResponse = serde_json::from_str(
            r#"{"books":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"T","format":"pdf","extension":"pdf","sizeBytes":10,"fileAvailable":true,"futureField":"ok"}],"extra":123}"#,
        )
        .expect("catalog ignores unknown fields");
        assert_eq!(catalog.books.len(), 1);
        assert_eq!(catalog.books[0].has_position, None);
        assert_eq!(catalog.books[0].bookmark_count, None);

        let pos: PositionResponse = serde_json::from_str(
            r#"{"anchor":{"format":"txt","startByteOffset":0,"endByteOffset":10,"lineIndex":0},"progress":null,"futureField":42}"#,
        )
        .expect("position ignores unknown fields");
        assert_eq!(pos.progress, None);

        let bms: BookmarksResponse = serde_json::from_str(
            r#"{"bookmarks":[{"anchor":{"format":"txt","startByteOffset":0,"endByteOffset":10,"lineIndex":0},"label":"L","createdAt":"2026-05-01T00:00:00Z","futureField":1}],"extra":[]}"#,
        )
        .expect("bookmarks ignores unknown fields");
        assert_eq!(bms.bookmarks.len(), 1);
    }
}
