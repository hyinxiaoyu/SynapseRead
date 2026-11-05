//! Rectangle captures on disk: see `docs/adr/0003-rectangle-captures.md`.
//!
//! Core is the only writer. Files live at `<data dir>/captures/<annotation id>.png`,
//! and the database stores the path relative to the data directory.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::{CoreError, CoreResult};

const CAPTURES_DIR: &str = "captures";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Far above a page-sized capture; this guards against a misbehaving webview.
pub const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStore {
    data_dir: PathBuf,
}

impl CaptureStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }

    /// The directory the asset protocol scope grants, non-recursively.
    pub fn directory(&self) -> PathBuf {
        self.data_dir.join(CAPTURES_DIR)
    }

    /// Writes a capture, returning the path to store. The rename means a reader
    /// never sees a partial file.
    pub(crate) fn write(&self, annotation_id: &str, png: &[u8]) -> CoreResult<String> {
        let directory = self.directory();
        fs::create_dir_all(&directory)?;
        let file_name = format!("{annotation_id}.png");
        let temporary = directory.join(format!(".{file_name}.tmp"));
        let result = fs::write(&temporary, png)
            .and_then(|()| fs::rename(&temporary, directory.join(&file_name)));
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(format!("{CAPTURES_DIR}/{file_name}"))
    }

    pub(crate) fn remove(&self, relative_path: &str) {
        // Best effort: this runs while another error is already being returned,
        // and an orphan file is harmless.
        let _ = fs::remove_file(self.resolve(relative_path));
    }

    /// Absolute path for a stored relative path.
    pub fn resolve(&self, relative_path: &str) -> PathBuf {
        // The stored form always uses `/`, whatever the platform's separator.
        relative_path
            .split('/')
            .fold(self.data_dir.clone(), |path, part| path.join(part))
    }
}

/// Decodes a capture from the wire, rejecting anything that is not a PNG.
pub(crate) fn decode_capture(encoded: &str) -> CoreResult<Vec<u8>> {
    let invalid = |message: &str| CoreError::InvalidCapture(message.to_owned());
    // Base64 is 4/3 the size of its content, so this bounds the work below.
    if encoded.len() / 4 * 3 > MAX_CAPTURE_BYTES + 3 {
        return Err(invalid("the image is too large"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("the image is not valid base64"))?;
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(invalid("the image is too large"));
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(invalid("the image is not a PNG"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_resolve_agree_and_leave_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = CaptureStore::new(dir.path());
        let relative = store.write("abc", PNG_SIGNATURE).unwrap();
        assert_eq!(relative, "captures/abc.png");
        assert_eq!(fs::read(store.resolve(&relative)).unwrap(), PNG_SIGNATURE);
        assert_eq!(fs::read_dir(store.directory()).unwrap().count(), 1);

        store.remove(&relative);
        assert!(!store.resolve(&relative).exists());
    }

    #[test]
    fn decode_accepts_only_png() {
        let png = STANDARD.encode(PNG_SIGNATURE);
        assert_eq!(decode_capture(&png).unwrap(), PNG_SIGNATURE);
        for bad in [
            "not base64!".to_owned(),
            STANDARD.encode(b"GIF89a-not-a-png"),
            String::new(),
        ] {
            assert!(matches!(
                decode_capture(&bad),
                Err(CoreError::InvalidCapture(_))
            ));
        }
    }

    #[test]
    fn decode_rejects_oversized_input_before_decoding_it() {
        let huge = "A".repeat((MAX_CAPTURE_BYTES / 3 + 2) * 4);
        assert!(matches!(
            decode_capture(&huge),
            Err(CoreError::InvalidCapture(message)) if message.contains("large")
        ));
    }
}
