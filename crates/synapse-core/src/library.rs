//! Managed library storage, atomic staging, format magic validation, and
//! sole-connection startup reconciliation (ADR 0008, LS-05).
//!
//! Files imported over LAN are staged in `<app-data>/sync-staging/` and
//! atomically published into `<app-data>/library/<sha256>.<ext>`. Neither
//! directory lives inside `captures/`, and neither is directory-granted to
//! the webview asset scope (ADR 0001).

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::domain::DocumentFormat;
use crate::fs_reader::hash_file;
use crate::{CoreError, CoreResult};

const SYNC_STAGING_DIR: &str = "sync-staging";
const LIBRARY_DIR: &str = "library";

const PDF_MAGIC: &[u8] = b"%PDF-";
const ZIP_LOCAL_HEADER_SIG: &[u8] = b"PK\x03\x04";
const ZIP_CENTRAL_DIR_SIG: &[u8] = b"PK\x01\x02";
const ZIP_EOCD_SIG: &[u8] = b"PK\x05\x06";
const EPUB_MIMETYPE_ENTRY: &[u8] = b"mimetype";
const EPUB_MIMETYPE_VALUE: &[u8] = b"application/epub+zip";
const EPUB_CONTAINER_ENTRY: &[u8] = b"META-INF/container.xml";

const MAX_ZIP_TAIL_BYTES: u64 = 22 + 65_535;
const MAX_CENTRAL_DIR_BYTES: usize = 16 * 1024 * 1024;
const MAX_MIMETYPE_BYTES: usize = 256;

/// Summary of files cleaned up by [`ManagedLibrary::reconcile`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileReport {
    pub removed_staging_entries: usize,
    pub removed_library_files: usize,
}

/// Sink used by [`StagedFile`] while streaming bytes to disk.
///
/// Production code uses [`std::fs::File`]; tests can inject a writer that
/// simulates `ENOSPC` / `EDQUOT` deterministically.
pub trait StageWriter: Write {
    fn sync_file(&mut self) -> io::Result<()>;
}

impl StageWriter for File {
    fn sync_file(&mut self) -> io::Result<()> {
        self.sync_all()
    }
}

/// Owns `<app-data>/sync-staging/` and `<app-data>/library/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedLibrary {
    data_dir: PathBuf,
}

impl ManagedLibrary {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }

    pub fn library_dir(&self) -> PathBuf {
        self.data_dir.join(LIBRARY_DIR)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.data_dir.join(SYNC_STAGING_DIR)
    }

    /// Computes the validated content-addressed target path
    /// `<app-data>/library/<sha256>.<ext>`.
    pub fn target_path(
        &self,
        format: DocumentFormat,
        file_hash: &str,
        extension: &str,
    ) -> CoreResult<PathBuf> {
        validate_file_hash(file_hash)?;
        let ext = validate_extension(format, extension)?;
        Ok(self.library_dir().join(format!("{file_hash}.{ext}")))
    }

    /// Creates a new `.part` file in `<app-data>/sync-staging/` with `create_new`
    /// semantics so an existing staged file is never overwritten.
    pub fn begin_stage(
        &self,
        format: DocumentFormat,
        extension: &str,
        expected_hash: &str,
        expected_len: u64,
    ) -> CoreResult<StagedFile> {
        self.begin_stage_with_writer(format, extension, expected_hash, expected_len, |path| {
            let file = OpenOptions::new().write(true).create_new(true).open(path)?;
            Ok(Box::new(file))
        })
    }

    /// Same as [`Self::begin_stage`] with an injectable writer factory for
    /// deterministic `ENOSPC` / `EDQUOT` testing.
    pub fn begin_stage_with_writer<F>(
        &self,
        format: DocumentFormat,
        extension: &str,
        expected_hash: &str,
        expected_len: u64,
        writer_factory: F,
    ) -> CoreResult<StagedFile>
    where
        F: FnOnce(&Path) -> io::Result<Box<dyn StageWriter>>,
    {
        validate_file_hash(expected_hash)?;
        let validated_ext = validate_extension(format, extension)?;

        let staging_dir = ensure_safe_managed_dir(&self.data_dir, SYNC_STAGING_DIR)?;

        let part_name = format!("{expected_hash}-{}.part", Uuid::new_v4());
        let part_path = staging_dir.join(part_name);
        let writer = writer_factory(&part_path).map_err(|err| {
            let _ = fs::remove_file(&part_path);
            map_storage_io_error(err)
        })?;

        Ok(StagedFile {
            writer: Some(writer),
            part_path,
            data_dir: self.data_dir.clone(),
            format,
            extension: validated_ext,
            expected_hash: expected_hash.to_owned(),
            expected_len,
            written_len: 0,
            hasher: Sha256::new(),
            finished: false,
        })
    }

    /// Resolves `<data_dir>/<subdir>` only if it is a real (non-symlink)
    /// directory whose canonical path is strictly `<canonical_data_dir>/<subdir>`.
    /// Returns `Ok(None)` if missing, a symlink, not a directory, or escaped.
    fn resolve_safe_managed_dir(&self, subdir: &str) -> CoreResult<Option<PathBuf>> {
        let candidate = self.data_dir.join(subdir);
        let meta = match fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Ok(None);
        }
        let canonical_data_dir = fs::canonicalize(&self.data_dir)?;
        let canonical_candidate = fs::canonicalize(&candidate)?;
        if canonical_candidate != canonical_data_dir.join(subdir) {
            return Ok(None);
        }
        Ok(Some(canonical_candidate))
    }

    /// Removes leftover files in `sync-staging/` and unreferenced files in
    /// `library/` only, comparing canonicalized full paths (never hash prefixes,
    /// so `<sha256>.md` and `<sha256>.txt` remain distinct: R3-08).
    ///
    /// Never follows symlinked managed roots or symlinked child directories
    /// outside `<app-data>` (T-19).
    ///
    /// Must only be called while holding the sole-connection database lock
    /// (R3-01) so a second concurrent SynapseRead process never deletes an
    /// active transfer's `.part` or freshly published library file.
    pub fn reconcile(&self, referenced_paths: &[PathBuf]) -> CoreResult<ReconcileReport> {
        let mut report = ReconcileReport::default();

        if let Some(canonical_staging_dir) = self.resolve_safe_managed_dir(SYNC_STAGING_DIR)? {
            for entry in fs::read_dir(&canonical_staging_dir)? {
                let entry = entry?;
                let path = entry.path();
                let meta = fs::symlink_metadata(&path)?;
                if meta.file_type().is_symlink() {
                    fs::remove_file(&path)?;
                } else if meta.file_type().is_dir() {
                    let canonical_child = fs::canonicalize(&path)?;
                    if !canonical_child.starts_with(&canonical_staging_dir) {
                        continue;
                    }
                    fs::remove_dir_all(&path)?;
                } else {
                    fs::remove_file(&path)?;
                }
                report.removed_staging_entries += 1;
            }
        }

        let Some(canonical_library_dir) = self.resolve_safe_managed_dir(LIBRARY_DIR)? else {
            return Ok(report);
        };

        let referenced_canonical: HashSet<PathBuf> = referenced_paths
            .iter()
            .filter_map(|path| fs::canonicalize(path).ok())
            .collect();

        for entry in fs::read_dir(&canonical_library_dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                // Never follow symlinks outside `library/`; remove unreferenced links only.
                let keep = fs::canonicalize(&path)
                    .ok()
                    .is_some_and(|canon| referenced_canonical.contains(&canon));
                if !keep {
                    fs::remove_file(&path)?;
                    report.removed_library_files += 1;
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let canonical_entry = fs::canonicalize(&path)?;
            if !canonical_entry.starts_with(&canonical_library_dir) {
                continue;
            }
            if !referenced_canonical.contains(&canonical_entry) {
                fs::remove_file(&path)?;
                report.removed_library_files += 1;
            }
        }

        Ok(report)
    }
}

/// An in-flight file transfer staged inside `<app-data>/sync-staging/`.
///
/// Dropping or cancelling before [`Self::finish`] succeeds deletes the `.part`
/// file automatically.
pub struct StagedFile {
    writer: Option<Box<dyn StageWriter>>,
    part_path: PathBuf,
    data_dir: PathBuf,
    format: DocumentFormat,
    extension: String,
    expected_hash: String,
    expected_len: u64,
    written_len: u64,
    hasher: Sha256,
    finished: bool,
}

impl StagedFile {
    pub fn written_bytes(&self) -> u64 {
        self.written_len
    }

    pub fn expected_bytes(&self) -> u64 {
        self.expected_len
    }

    pub fn part_path(&self) -> &Path {
        &self.part_path
    }

    /// Streams `bytes` into the `.part` file, enforcing the declared byte length
    /// and updating the incremental SHA-256 digest.
    pub fn write_chunk(&mut self, bytes: &[u8]) -> CoreResult<()> {
        let next_len = self.written_len.checked_add(bytes.len() as u64);
        if next_len.is_none_or(|len| len > self.expected_len) {
            self.cleanup_part();
            return Err(CoreError::LanSizeMismatch(format!(
                "transfer exceeded declared size of {} bytes",
                self.expected_len
            )));
        }

        let Some(writer) = self.writer.as_mut() else {
            return Err(CoreError::Io(io::Error::other(
                "staged file writer is already closed",
            )));
        };

        if let Err(err) = writer.write_all(bytes) {
            self.cleanup_part();
            return Err(map_storage_io_error(err));
        }

        self.hasher.update(bytes);
        self.written_len += bytes.len() as u64;
        Ok(())
    }

    /// Explicitly cancels the staged transfer and deletes its `.part` file.
    pub fn cancel(mut self) {
        self.cleanup_part();
    }

    /// Verifies exact length, SHA-256 hash, and format magic bytes, fsyncs the
    /// `.part` file, and atomically publishes it into
    /// `<app-data>/library/<sha256>.<ext>` (reusing an existing verified target).
    pub fn finish(mut self) -> CoreResult<PathBuf> {
        if self.written_len != self.expected_len {
            self.cleanup_part();
            return Err(CoreError::LanSizeMismatch(format!(
                "expected {} bytes, received {}",
                self.expected_len, self.written_len
            )));
        }

        let digest = self.hasher.clone().finalize();
        let actual_hash = hex_lower(&digest);
        if actual_hash != self.expected_hash {
            self.cleanup_part();
            return Err(CoreError::LanHashMismatch(format!(
                "expected SHA-256 {}, got {actual_hash}",
                self.expected_hash
            )));
        }

        if let Some(mut writer) = self.writer.take()
            && let Err(err) = writer.flush().and_then(|()| writer.sync_file())
        {
            drop(writer);
            self.cleanup_part();
            return Err(map_storage_io_error(err));
        }

        if let Err(err) = validate_magic_bytes(&self.part_path, self.format) {
            self.cleanup_part();
            return Err(err);
        }

        let library_dir = match ensure_safe_managed_dir(&self.data_dir, LIBRARY_DIR) {
            Ok(dir) => dir,
            Err(err) => {
                self.cleanup_part();
                return Err(err);
            }
        };

        let target = library_dir.join(format!("{}.{}", self.expected_hash, self.extension));

        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    self.cleanup_part();
                    return Err(CoreError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "managed library target must be a regular file, not a symlink",
                    )));
                }
                if hash_file(&target).is_ok_and(|existing| existing == self.expected_hash)
                    && validate_magic_bytes(&target, self.format).is_ok()
                {
                    self.cleanup_part();
                    return Ok(target);
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                self.cleanup_part();
                return Err(map_storage_io_error(err));
            }
        }

        if let Err(err) = replace_file(&self.part_path, &target) {
            self.cleanup_part();
            return Err(map_storage_io_error(err));
        }

        self.finished = true;
        Ok(target)
    }

    fn cleanup_part(&mut self) {
        // Close the file handle before removing on Windows.
        self.writer.take();
        if !self.finished {
            let _ = fs::remove_file(&self.part_path);
            self.finished = true;
        }
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.cleanup_part();
    }
}

/// Ensures `<data_dir>/<subdir>` exists as a real (non-symlink) directory whose
/// canonical path is strictly `<canonical_data_dir>/<subdir>`. Rejects symlinks
/// or non-directories without creating or touching anything inside their target.
fn ensure_safe_managed_dir(data_dir: &Path, subdir: &str) -> CoreResult<PathBuf> {
    let candidate = data_dir.join(subdir);
    match fs::symlink_metadata(&candidate) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(CoreError::Io(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("managed directory '{subdir}' must be a regular directory"),
                )));
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(data_dir).map_err(map_storage_io_error)?;
            match fs::create_dir(&candidate) {
                Ok(()) => {}
                Err(create_err) if create_err.kind() == io::ErrorKind::AlreadyExists => {}
                Err(create_err) => return Err(map_storage_io_error(create_err)),
            }
        }
        Err(err) => return Err(map_storage_io_error(err)),
    }

    let meta = fs::symlink_metadata(&candidate).map_err(map_storage_io_error)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(CoreError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("managed directory '{subdir}' must be a regular directory"),
        )));
    }
    let canonical_data_dir = fs::canonicalize(data_dir).map_err(map_storage_io_error)?;
    let canonical_candidate = fs::canonicalize(&candidate).map_err(map_storage_io_error)?;
    if canonical_candidate != canonical_data_dir.join(subdir) {
        return Err(CoreError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("managed directory '{subdir}' escapes the application data directory"),
        )));
    }
    Ok(candidate)
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(to)?;
            fs::rename(from, to)
        }
        Err(err) => Err(err),
    }
}

/// Validates that `file_hash` is exactly 64 lowercase hexadecimal characters.
pub fn validate_file_hash(file_hash: &str) -> CoreResult<()> {
    if file_hash.len() == 64
        && file_hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(CoreError::LanHashMismatch(
            "file hash must be 64 lowercase hexadecimal characters".to_owned(),
        ))
    }
}

/// Validates `extension` strictly against `DocumentFormat::extensions(format)`
/// and returns its normalized lowercase form (preserving `.md` / `.markdown`
/// under `DocumentFormat::Txt`: R2-01).
pub fn validate_extension(format: DocumentFormat, extension: &str) -> CoreResult<String> {
    let normalized = extension.to_ascii_lowercase();
    if format.extensions().contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(CoreError::UnsupportedFormat(format!(
            "extension '{extension}' is not valid for format '{}'",
            format.as_str()
        )))
    }
}

/// Derives a validated lowercase extension for `format` from a stored file path,
/// falling back to the format's primary extension if the stored path lacks one.
pub(crate) fn validated_extension_for_export(format: DocumentFormat, path: &Path) -> String {
    if let Some(ext) = path.extension().and_then(|value| value.to_str())
        && let Ok(valid) = validate_extension(format, ext)
    {
        return valid;
    }
    format
        .extensions()
        .first()
        .copied()
        .unwrap_or(format.as_str())
        .to_owned()
}

/// Returns `true` when `err` indicates an out-of-space or disk-quota failure
/// (`ENOSPC`, `EDQUOT`, or `ErrorKind::StorageFull`).
pub fn is_disk_full_error(err: &io::Error) -> bool {
    if err.kind() == io::ErrorKind::StorageFull {
        return true;
    }
    match err.raw_os_error() {
        #[cfg(target_os = "macos")]
        Some(28 | 69) => true,
        #[cfg(target_os = "linux")]
        Some(28 | 122) => true,
        #[cfg(target_os = "windows")]
        Some(39 | 112) => true,
        _ => false,
    }
}

fn map_storage_io_error(err: io::Error) -> CoreError {
    if is_disk_full_error(&err) {
        CoreError::LanDiskFull(err.to_string())
    } else {
        CoreError::Io(err)
    }
}

/// Verifies format-specific magic bytes on `path`.
///
/// - PDF: requires `%PDF-` prefix.
/// - EPUB: bounded pure-Rust ZIP header + Central Directory check verifying
///   a `mimetype` entry containing `application/epub+zip` (at any entry index,
///   stored or deflated) and a `META-INF/container.xml` entry (R2-04).
/// - TXT / MD: plain text has no mandatory magic prefix.
pub fn validate_magic_bytes(path: &Path, format: DocumentFormat) -> CoreResult<()> {
    match format {
        DocumentFormat::Pdf => validate_pdf_magic(path),
        DocumentFormat::Epub => validate_epub_magic(path),
        DocumentFormat::Txt | DocumentFormat::Md => Ok(()),
    }
}

fn validate_pdf_magic(path: &Path) -> CoreResult<()> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 5];
    let n = file.read(&mut header)?;
    if n == PDF_MAGIC.len() && header == PDF_MAGIC {
        Ok(())
    } else {
        Err(CoreError::UnsupportedFormat(
            "file does not start with a valid %PDF- header".to_owned(),
        ))
    }
}

struct ZipMimetypeLoc {
    compression_method: u16,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

fn validate_epub_magic(path: &Path) -> CoreResult<()> {
    let invalid = |msg: &str| CoreError::UnsupportedFormat(format!("invalid EPUB archive: {msg}"));
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < 30 {
        return Err(invalid("file is too small to be a ZIP archive"));
    }

    let mut sig = [0_u8; 4];
    file.read_exact(&mut sig)?;
    if sig != ZIP_LOCAL_HEADER_SIG {
        return Err(invalid("missing ZIP local file header signature"));
    }

    let tail_len = file_len.min(MAX_ZIP_TAIL_BYTES) as usize;
    let tail_start = file_len - tail_len as u64;
    file.seek(SeekFrom::Start(tail_start))?;
    let mut tail = vec![0_u8; tail_len];
    file.read_exact(&mut tail)?;

    let eocd_pos =
        find_eocd(&tail).ok_or_else(|| invalid("missing ZIP end of central directory"))?;
    let cd_size = read_u32_le(&tail, eocd_pos + 12).ok_or_else(|| invalid("truncated EOCD"))?;
    let cd_offset = read_u32_le(&tail, eocd_pos + 16).ok_or_else(|| invalid("truncated EOCD"))?;

    let cd_size_usize =
        usize::try_from(cd_size).map_err(|_| invalid("central directory too large"))?;
    if cd_size_usize > MAX_CENTRAL_DIR_BYTES {
        return Err(CoreError::LanPayloadTooLarge(
            "EPUB central directory exceeds maximum allowed size".to_owned(),
        ));
    }
    let cd_end = u64::from(cd_offset)
        .checked_add(u64::from(cd_size))
        .ok_or_else(|| invalid("central directory offset overflow"))?;
    if cd_end > file_len {
        return Err(invalid("central directory extends past end of file"));
    }

    file.seek(SeekFrom::Start(u64::from(cd_offset)))?;
    let mut cd = vec![0_u8; cd_size_usize];
    file.read_exact(&mut cd)?;

    let mut mimetype_loc: Option<ZipMimetypeLoc> = None;
    let mut has_container_xml = false;
    let mut offset = 0_usize;

    while offset < cd.len() {
        if cd.get(offset..offset + 4) != Some(ZIP_CENTRAL_DIR_SIG) {
            return Err(invalid("malformed central directory header"));
        }
        if offset + 46 > cd.len() {
            return Err(invalid("truncated central directory header"));
        }
        let compression_method = read_u16_le(&cd, offset + 10).ok_or_else(|| invalid("bad CD"))?;
        let compressed_size =
            u64::from(read_u32_le(&cd, offset + 20).ok_or_else(|| invalid("bad CD"))?);
        let uncompressed_size =
            u64::from(read_u32_le(&cd, offset + 24).ok_or_else(|| invalid("bad CD"))?);
        let name_len = usize::from(read_u16_le(&cd, offset + 28).ok_or_else(|| invalid("bad CD"))?);
        let extra_len =
            usize::from(read_u16_le(&cd, offset + 30).ok_or_else(|| invalid("bad CD"))?);
        let comment_len =
            usize::from(read_u16_le(&cd, offset + 32).ok_or_else(|| invalid("bad CD"))?);
        let local_header_offset =
            u64::from(read_u32_le(&cd, offset + 42).ok_or_else(|| invalid("bad CD"))?);

        let name_start = offset + 46;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or_else(|| invalid("CD filename overflow"))?;
        let next_offset = name_end
            .checked_add(extra_len)
            .and_then(|v| v.checked_add(comment_len))
            .ok_or_else(|| invalid("CD entry length overflow"))?;
        if next_offset > cd.len() {
            return Err(invalid("central directory entry extends past CD bounds"));
        }

        let name = &cd[name_start..name_end];
        if name == EPUB_MIMETYPE_ENTRY && mimetype_loc.is_none() {
            mimetype_loc = Some(ZipMimetypeLoc {
                compression_method,
                compressed_size,
                uncompressed_size,
                local_header_offset,
            });
        } else if name == EPUB_CONTAINER_ENTRY {
            has_container_xml = true;
        }

        if mimetype_loc.is_some() && has_container_xml {
            break;
        }
        offset = next_offset;
    }

    if !has_container_xml {
        return Err(invalid("missing META-INF/container.xml entry"));
    }
    let loc = mimetype_loc.ok_or_else(|| invalid("missing mimetype entry"))?;
    if loc.compressed_size > MAX_MIMETYPE_BYTES as u64
        || loc.uncompressed_size > MAX_MIMETYPE_BYTES as u64
    {
        return Err(invalid("mimetype entry is unexpectedly large"));
    }

    let local_header_end = loc
        .local_header_offset
        .checked_add(30)
        .ok_or_else(|| invalid("local header offset overflow"))?;
    if local_header_end > file_len {
        return Err(invalid("mimetype local header extends past end of file"));
    }

    file.seek(SeekFrom::Start(loc.local_header_offset))?;
    let mut local_header = [0_u8; 30];
    file.read_exact(&mut local_header)?;
    if &local_header[0..4] != ZIP_LOCAL_HEADER_SIG {
        return Err(invalid("invalid local header signature for mimetype entry"));
    }
    let local_name_len = u64::from(u16::from_le_bytes([local_header[26], local_header[27]]));
    let local_extra_len = u64::from(u16::from_le_bytes([local_header[28], local_header[29]]));
    let data_offset = local_header_end
        .checked_add(local_name_len)
        .and_then(|v| v.checked_add(local_extra_len))
        .ok_or_else(|| invalid("mimetype data offset overflow"))?;
    let data_end = data_offset
        .checked_add(loc.compressed_size)
        .ok_or_else(|| invalid("mimetype data end overflow"))?;
    if data_end > file_len {
        return Err(invalid("mimetype entry data extends past end of file"));
    }

    file.seek(SeekFrom::Start(data_offset))?;
    let mut raw_data = vec![0_u8; loc.compressed_size as usize];
    file.read_exact(&mut raw_data)?;

    let payload = match loc.compression_method {
        0 => raw_data,
        8 => inflate_raw_bounded(&raw_data, MAX_MIMETYPE_BYTES)
            .ok_or_else(|| invalid("failed to decompress deflated mimetype entry"))?,
        _ => return Err(invalid("unsupported compression method for mimetype entry")),
    };

    if payload.trim_ascii() == EPUB_MIMETYPE_VALUE {
        Ok(())
    } else {
        Err(invalid(
            "mimetype entry does not contain application/epub+zip",
        ))
    }
}

fn find_eocd(tail: &[u8]) -> Option<usize> {
    if tail.len() < 22 {
        return None;
    }
    for pos in (0..=tail.len() - 22).rev() {
        if tail.get(pos..pos + 4) == Some(ZIP_EOCD_SIG) {
            let comment_len = usize::from(read_u16_le(tail, pos + 20)?);
            if pos + 22 + comment_len == tail.len() {
                return Some(pos);
            }
        }
    }
    None
}

fn read_u16_le(buf: &[u8], offset: usize) -> Option<u16> {
    let slice = buf.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(buf: &[u8], offset: usize) -> Option<u32> {
    let slice = buf.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

// ---- Bounded RFC 1951 raw DEFLATE decoder (for deflated EPUB `mimetype`) ----

struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    bit_buf: u32,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn read_bits(&mut self, count: u8) -> Option<u32> {
        while self.bit_count < count {
            let next_byte = *self.data.get(self.byte_pos)?;
            self.byte_pos += 1;
            self.bit_buf |= u32::from(next_byte) << self.bit_count;
            self.bit_count += 8;
        }
        let mask = (1_u32 << count) - 1;
        let value = self.bit_buf & mask;
        self.bit_buf >>= count;
        self.bit_count -= count;
        Some(value)
    }

    fn align_to_byte(&mut self) {
        let discard = self.bit_count % 8;
        self.bit_buf >>= discard;
        self.bit_count -= discard;
    }

    fn read_aligned_u16(&mut self) -> Option<u16> {
        let lo = self.read_bits(8)? as u8;
        let hi = self.read_bits(8)? as u8;
        Some(u16::from_le_bytes([lo, hi]))
    }
}

struct HuffmanTable {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl HuffmanTable {
    fn from_lengths(lengths: &[u8]) -> Option<Self> {
        let mut counts = [0_u16; 16];
        for &len in lengths {
            if usize::from(len) >= counts.len() {
                return None;
            }
            if len > 0 {
                counts[usize::from(len)] = counts[usize::from(len)].checked_add(1)?;
            }
        }

        let mut offsets = [0_usize; 16];
        let mut total = 0_usize;
        for bits in 1..=15 {
            offsets[bits] = total;
            total += usize::from(counts[bits]);
        }

        let mut symbols = vec![0_u16; total];
        for (symbol, &len) in lengths.iter().enumerate() {
            if len > 0 {
                let idx = offsets[usize::from(len)];
                *symbols.get_mut(idx)? = u16::try_from(symbol).ok()?;
                offsets[usize::from(len)] += 1;
            }
        }

        Some(Self { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Option<u16> {
        let mut code = 0_i32;
        let mut first = 0_i32;
        let mut index = 0_usize;
        for bits in 1..=15 {
            code |= reader.read_bits(1)? as i32;
            let count = i32::from(self.counts[bits]);
            if code - count < first {
                let sym_idx = index.checked_add((code - first) as usize)?;
                return self.symbols.get(sym_idx).copied();
            }
            index += count as usize;
            first = (first + count) << 1;
            code <<= 1;
        }
        None
    }
}

fn inflate_raw_bounded(input: &[u8], max_output: usize) -> Option<Vec<u8>> {
    const LENGTH_BASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DIST_BASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DIST_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    const CODE_LENGTH_ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];

    let mut reader = BitReader::new(input);
    let mut output = Vec::new();

    loop {
        let bfinal = reader.read_bits(1)?;
        let btype = reader.read_bits(2)?;
        match btype {
            0 => {
                reader.align_to_byte();
                let len = reader.read_aligned_u16()?;
                let nlen = reader.read_aligned_u16()?;
                if len != !nlen {
                    return None;
                }
                let len_usize = usize::from(len);
                if output.len().checked_add(len_usize)? > max_output {
                    return None;
                }
                for _ in 0..len_usize {
                    output.push(reader.read_bits(8)? as u8);
                }
            }
            1 | 2 => {
                let (lit_table, dist_table) = if btype == 1 {
                    let mut lit_lengths = [0_u8; 288];
                    lit_lengths[0..=143].fill(8);
                    lit_lengths[144..=255].fill(9);
                    lit_lengths[256..=279].fill(7);
                    lit_lengths[280..=287].fill(8);
                    let dist_lengths = [5_u8; 32];
                    (
                        HuffmanTable::from_lengths(&lit_lengths)?,
                        HuffmanTable::from_lengths(&dist_lengths)?,
                    )
                } else {
                    let hlit = reader.read_bits(5)? as usize + 257;
                    let hdist = reader.read_bits(5)? as usize + 1;
                    let hclen = reader.read_bits(4)? as usize + 4;
                    if hlit > 286 || hdist > 30 {
                        return None;
                    }
                    let mut cl_lengths = [0_u8; 19];
                    for &idx in CODE_LENGTH_ORDER.iter().take(hclen) {
                        cl_lengths[idx] = reader.read_bits(3)? as u8;
                    }
                    let cl_table = HuffmanTable::from_lengths(&cl_lengths)?;
                    let total = hlit + hdist;
                    let mut lengths = Vec::with_capacity(total);
                    while lengths.len() < total {
                        let sym = cl_table.decode(&mut reader)?;
                        match sym {
                            0..=15 => lengths.push(sym as u8),
                            16 => {
                                let prev = *lengths.last()?;
                                let repeat = reader.read_bits(2)? as usize + 3;
                                if lengths.len() + repeat > total {
                                    return None;
                                }
                                lengths.resize(lengths.len() + repeat, prev);
                            }
                            17 => {
                                let repeat = reader.read_bits(3)? as usize + 3;
                                if lengths.len() + repeat > total {
                                    return None;
                                }
                                lengths.resize(lengths.len() + repeat, 0);
                            }
                            18 => {
                                let repeat = reader.read_bits(7)? as usize + 11;
                                if lengths.len() + repeat > total {
                                    return None;
                                }
                                lengths.resize(lengths.len() + repeat, 0);
                            }
                            _ => return None,
                        }
                    }
                    (
                        HuffmanTable::from_lengths(&lengths[..hlit])?,
                        HuffmanTable::from_lengths(&lengths[hlit..])?,
                    )
                };

                loop {
                    let sym = lit_table.decode(&mut reader)?;
                    match sym {
                        0..=255 => {
                            if output.len() >= max_output {
                                return None;
                            }
                            output.push(sym as u8);
                        }
                        256 => break,
                        257..=285 => {
                            let len_idx = usize::from(sym - 257);
                            let length = usize::from(*LENGTH_BASE.get(len_idx)?)
                                + reader.read_bits(*LENGTH_EXTRA.get(len_idx)?)? as usize;
                            let dist_sym = usize::from(dist_table.decode(&mut reader)?);
                            let dist = usize::from(*DIST_BASE.get(dist_sym)?)
                                + reader.read_bits(*DIST_EXTRA.get(dist_sym)?)? as usize;
                            if dist == 0
                                || dist > output.len()
                                || output.len().checked_add(length)? > max_output
                            {
                                return None;
                            }
                            for _ in 0..length {
                                let byte = *output.get(output.len() - dist)?;
                                output.push(byte);
                            }
                        }
                        _ => return None,
                    }
                }
            }
            _ => return None,
        }
        if bfinal == 1 {
            break;
        }
    }

    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256_hex(bytes: &[u8]) -> String {
        hex_lower(&Sha256::digest(bytes))
    }

    /// Builds a minimal valid ZIP archive from `(name, compression_method, raw_data, uncompressed_len)`.
    fn build_zip(entries: &[(&[u8], u16, &[u8], u32)]) -> Vec<u8> {
        let mut archive = Vec::new();
        let mut cd = Vec::new();

        for &(name, method, data, uncompressed_len) in entries {
            let local_offset = archive.len() as u32;
            // Local file header (30 bytes + name)
            archive.extend_from_slice(ZIP_LOCAL_HEADER_SIG);
            archive.extend_from_slice(&20_u16.to_le_bytes()); // version needed
            archive.extend_from_slice(&0_u16.to_le_bytes()); // flags
            archive.extend_from_slice(&method.to_le_bytes());
            archive.extend_from_slice(&0_u16.to_le_bytes()); // mod time
            archive.extend_from_slice(&0_u16.to_le_bytes()); // mod date
            archive.extend_from_slice(&0_u32.to_le_bytes()); // crc32 (unused by magic check)
            archive.extend_from_slice(&(data.len() as u32).to_le_bytes());
            archive.extend_from_slice(&uncompressed_len.to_le_bytes());
            archive.extend_from_slice(&(name.len() as u16).to_le_bytes());
            archive.extend_from_slice(&0_u16.to_le_bytes()); // extra len
            archive.extend_from_slice(name);
            archive.extend_from_slice(data);

            // Central directory header (46 bytes + name)
            cd.extend_from_slice(ZIP_CENTRAL_DIR_SIG);
            cd.extend_from_slice(&20_u16.to_le_bytes()); // version made by
            cd.extend_from_slice(&20_u16.to_le_bytes()); // version needed
            cd.extend_from_slice(&0_u16.to_le_bytes()); // flags
            cd.extend_from_slice(&method.to_le_bytes());
            cd.extend_from_slice(&0_u16.to_le_bytes()); // mod time
            cd.extend_from_slice(&0_u16.to_le_bytes()); // mod date
            cd.extend_from_slice(&0_u32.to_le_bytes()); // crc32
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&uncompressed_len.to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&0_u16.to_le_bytes()); // extra len
            cd.extend_from_slice(&0_u16.to_le_bytes()); // comment len
            cd.extend_from_slice(&0_u16.to_le_bytes()); // disk start
            cd.extend_from_slice(&0_u16.to_le_bytes()); // internal attrs
            cd.extend_from_slice(&0_u32.to_le_bytes()); // external attrs
            cd.extend_from_slice(&local_offset.to_le_bytes());
            cd.extend_from_slice(name);
        }

        let cd_offset = archive.len() as u32;
        let cd_size = cd.len() as u32;
        archive.extend_from_slice(&cd);

        // EOCD (22 bytes)
        archive.extend_from_slice(ZIP_EOCD_SIG);
        archive.extend_from_slice(&0_u16.to_le_bytes());
        archive.extend_from_slice(&0_u16.to_le_bytes());
        archive.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        archive.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        archive.extend_from_slice(&cd_size.to_le_bytes());
        archive.extend_from_slice(&cd_offset.to_le_bytes());
        archive.extend_from_slice(&0_u16.to_le_bytes()); // comment len
        archive
    }

    fn minimal_epub_stored() -> Vec<u8> {
        let mimetype = EPUB_MIMETYPE_VALUE;
        let container = b"<container/>";
        build_zip(&[
            (b"mimetype", 0, mimetype, mimetype.len() as u32),
            (
                b"META-INF/container.xml",
                0,
                container,
                container.len() as u32,
            ),
        ])
    }

    /// Raw DEFLATE (fixed Huffman, RFC 1951) of `b"application/epub+zip"`.
    /// Generated with Python `zlib.compressobj(wbits=-15).compress(b"application/epub+zip")`.
    const DEFLATED_EPUB_MIMETYPE: &[u8] = &[
        0x4b, 0x2c, 0x28, 0xc8, 0xc9, 0x4c, 0x4e, 0x2c, 0xc9, 0xcc, 0xcf, 0xd3, 0x4f, 0x2d, 0x28,
        0x4d, 0xd2, 0xae, 0xca, 0x2c, 0x00, 0x00,
    ];

    struct FailingWriter {
        inner: File,
        fail_after: usize,
        written: usize,
        err_factory: Box<dyn Fn() -> io::Error>,
    }

    impl Write for FailingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.written + buf.len() > self.fail_after {
                return Err((self.err_factory)());
            }
            let n = self.inner.write(buf)?;
            self.written += n;
            Ok(n)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }

    impl StageWriter for FailingWriter {
        fn sync_file(&mut self) -> io::Result<()> {
            self.inner.sync_all()
        }
    }

    #[test]
    fn directories_sit_outside_captures() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        assert_eq!(lib.staging_dir(), dir.path().join("sync-staging"));
        assert_eq!(lib.library_dir(), dir.path().join("library"));
        assert!(!lib.staging_dir().starts_with(dir.path().join("captures")));
        assert!(!lib.library_dir().starts_with(dir.path().join("captures")));
    }

    #[test]
    fn validates_hash_and_extensions_preserving_markdown_r2_01() {
        let valid_hash = "a".repeat(64);
        assert!(validate_file_hash(&valid_hash).is_ok());
        for bad in [
            "",
            "abc",
            &"A".repeat(64), // uppercase rejected
            &"g".repeat(64), // non-hex rejected
            &"a".repeat(63),
            &"a".repeat(65),
        ] {
            assert!(matches!(
                validate_file_hash(bad),
                Err(CoreError::LanHashMismatch(_))
            ));
        }

        // Markdown extensions preserved under Txt (R2-01)
        assert_eq!(validate_extension(DocumentFormat::Txt, "md").unwrap(), "md");
        assert_eq!(
            validate_extension(DocumentFormat::Txt, "MARKDOWN").unwrap(),
            "markdown"
        );
        assert_eq!(
            validate_extension(DocumentFormat::Pdf, "pdf").unwrap(),
            "pdf"
        );
        assert_eq!(
            validate_extension(DocumentFormat::Epub, "epub").unwrap(),
            "epub"
        );

        // Traversal, dot-prefixed, and cross-format extensions rejected (S-10)
        for (fmt, bad_ext) in [
            (DocumentFormat::Pdf, "txt"),
            (DocumentFormat::Pdf, ".pdf"),
            (DocumentFormat::Pdf, "../pdf"),
            (DocumentFormat::Txt, "pdf"),
            (DocumentFormat::Txt, "exe"),
            (DocumentFormat::Epub, "zip"),
            (DocumentFormat::Md, "md"),
        ] {
            assert!(matches!(
                validate_extension(fmt, bad_ext),
                Err(CoreError::UnsupportedFormat(_))
            ));
        }
    }

    #[test]
    fn stage_publish_and_reuse_identical_verified_target() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        let bytes = b"%PDF-1.7\nhello world\n";
        let hash = sha256_hex(bytes);

        let mut staged = lib
            .begin_stage(DocumentFormat::Pdf, "pdf", &hash, bytes.len() as u64)
            .unwrap();
        let part_path = staged.part_path().to_path_buf();
        assert!(part_path.starts_with(lib.staging_dir()));
        assert!(part_path.exists());

        staged.write_chunk(&bytes[..6]).unwrap();
        staged.write_chunk(&bytes[6..]).unwrap();
        let published = staged.finish().unwrap();

        assert_eq!(published, lib.library_dir().join(format!("{hash}.pdf")));
        assert_eq!(fs::read(&published).unwrap(), bytes);
        assert!(!part_path.exists());

        // Staging the same file again reuses the existing verified target and cleans up `.part`.
        let mut staged2 = lib
            .begin_stage(DocumentFormat::Pdf, "pdf", &hash, bytes.len() as u64)
            .unwrap();
        staged2.write_chunk(bytes).unwrap();
        let published2 = staged2.finish().unwrap();
        assert_eq!(published2, published);
        assert_eq!(fs::read_dir(lib.staging_dir()).unwrap().count(), 0);
    }

    #[test]
    fn length_and_hash_mismatches_fail_with_staging_cleanup_t16() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        let bytes = b"hello markdown";
        let hash = sha256_hex(bytes);

        // Overflow declared length during write_chunk
        let mut staged = lib
            .begin_stage(DocumentFormat::Txt, "md", &hash, 5)
            .unwrap();
        let part = staged.part_path().to_path_buf();
        let err = staged.write_chunk(bytes).unwrap_err();
        assert_eq!(err.code(), "lan_size_mismatch");
        assert!(!part.exists());

        // Underflow declared length at finish
        let mut staged = lib
            .begin_stage(DocumentFormat::Txt, "md", &hash, (bytes.len() + 10) as u64)
            .unwrap();
        let part = staged.part_path().to_path_buf();
        staged.write_chunk(bytes).unwrap();
        let err = staged.finish().unwrap_err();
        assert_eq!(err.code(), "lan_size_mismatch");
        assert!(!part.exists());

        // Hash mismatch at finish
        let wrong_hash = "0".repeat(64);
        let mut staged = lib
            .begin_stage(DocumentFormat::Txt, "md", &wrong_hash, bytes.len() as u64)
            .unwrap();
        let part = staged.part_path().to_path_buf();
        staged.write_chunk(bytes).unwrap();
        let err = staged.finish().unwrap_err();
        assert_eq!(err.code(), "lan_hash_mismatch");
        assert!(!part.exists());
    }

    #[test]
    fn drop_and_cancel_delete_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        let hash = sha256_hex(b"partial");

        let part1 = {
            let mut staged = lib
                .begin_stage(DocumentFormat::Txt, "txt", &hash, 7)
                .unwrap();
            staged.write_chunk(b"par").unwrap();
            let p = staged.part_path().to_path_buf();
            assert!(p.exists());
            p
        };
        assert!(!part1.exists());

        let staged2 = lib
            .begin_stage(DocumentFormat::Txt, "txt", &hash, 7)
            .unwrap();
        let part2 = staged2.part_path().to_path_buf();
        assert!(part2.exists());
        staged2.cancel();
        assert!(!part2.exists());
    }

    #[test]
    fn injected_enospc_and_edquot_map_to_lan_disk_full_with_cleanup_t20() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        let bytes = b"some book payload bytes";
        let hash = sha256_hex(bytes);

        let disk_full_errors: Vec<Box<dyn Fn() -> io::Error>> = vec![
            Box::new(|| io::Error::new(io::ErrorKind::StorageFull, "no space left on device")),
            #[cfg(target_os = "macos")]
            Box::new(|| io::Error::from_raw_os_error(28)), // ENOSPC
            #[cfg(target_os = "macos")]
            Box::new(|| io::Error::from_raw_os_error(69)), // EDQUOT
            #[cfg(target_os = "linux")]
            Box::new(|| io::Error::from_raw_os_error(28)), // ENOSPC
            #[cfg(target_os = "linux")]
            Box::new(|| io::Error::from_raw_os_error(122)), // EDQUOT
        ];

        for err_factory in disk_full_errors {
            let mut staged = lib
                .begin_stage_with_writer(
                    DocumentFormat::Txt,
                    "txt",
                    &hash,
                    bytes.len() as u64,
                    |path| {
                        let inner = OpenOptions::new().write(true).create_new(true).open(path)?;
                        Ok(Box::new(FailingWriter {
                            inner,
                            fail_after: 4,
                            written: 0,
                            err_factory,
                        }))
                    },
                )
                .unwrap();
            let part = staged.part_path().to_path_buf();
            let err = staged.write_chunk(bytes).unwrap_err();
            assert_eq!(err.code(), "lan_disk_full");
            assert!(!part.exists());
        }
    }

    #[test]
    fn magic_checks_accept_valid_and_reject_invalid_pdf_and_epub_t18_r2_04() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());

        // Invalid PDF magic
        let fake_pdf = b"NOT A PDF FILE";
        let mut staged = lib
            .begin_stage(
                DocumentFormat::Pdf,
                "pdf",
                &sha256_hex(fake_pdf),
                fake_pdf.len() as u64,
            )
            .unwrap();
        let part = staged.part_path().to_path_buf();
        staged.write_chunk(fake_pdf).unwrap();
        let err = staged.finish().unwrap_err();
        assert_eq!(err.code(), "unsupported_format");
        assert!(!part.exists());

        // Valid EPUB (stored mimetype at entry 0)
        let valid_epub = minimal_epub_stored();
        let mut staged = lib
            .begin_stage(
                DocumentFormat::Epub,
                "epub",
                &sha256_hex(&valid_epub),
                valid_epub.len() as u64,
            )
            .unwrap();
        staged.write_chunk(&valid_epub).unwrap();
        assert!(staged.finish().is_ok());

        // Valid EPUB where mimetype is NOT entry 0 AND is deflated (R2-04)
        let container = b"<container/>";
        let reordered_deflated_epub = build_zip(&[
            (
                b"META-INF/container.xml",
                0,
                container,
                container.len() as u32,
            ),
            (
                b"mimetype",
                8,
                DEFLATED_EPUB_MIMETYPE,
                EPUB_MIMETYPE_VALUE.len() as u32,
            ),
        ]);
        let mut staged = lib
            .begin_stage(
                DocumentFormat::Epub,
                "epub",
                &sha256_hex(&reordered_deflated_epub),
                reordered_deflated_epub.len() as u64,
            )
            .unwrap();
        staged.write_chunk(&reordered_deflated_epub).unwrap();
        assert!(staged.finish().is_ok());

        // Invalid EPUB: plain ZIP without META-INF/container.xml
        let no_container = build_zip(&[(
            b"mimetype",
            0,
            EPUB_MIMETYPE_VALUE,
            EPUB_MIMETYPE_VALUE.len() as u32,
        )]);
        let mut staged = lib
            .begin_stage(
                DocumentFormat::Epub,
                "epub",
                &sha256_hex(&no_container),
                no_container.len() as u64,
            )
            .unwrap();
        staged.write_chunk(&no_container).unwrap();
        assert_eq!(staged.finish().unwrap_err().code(), "unsupported_format");

        // Invalid EPUB: wrong mimetype value
        let wrong_mime = build_zip(&[
            (b"mimetype", 0, b"text/plain", 10),
            (
                b"META-INF/container.xml",
                0,
                container,
                container.len() as u32,
            ),
        ]);
        let mut staged = lib
            .begin_stage(
                DocumentFormat::Epub,
                "epub",
                &sha256_hex(&wrong_mime),
                wrong_mime.len() as u64,
            )
            .unwrap();
        staged.write_chunk(&wrong_mime).unwrap();
        assert_eq!(staged.finish().unwrap_err().code(), "unsupported_format");
    }

    #[test]
    fn reconcile_removes_staging_and_unreferenced_library_files_only_t19_r3_08() {
        let dir = tempfile::tempdir().unwrap();
        let lib = ManagedLibrary::new(dir.path());
        fs::create_dir_all(lib.staging_dir()).unwrap();
        fs::create_dir_all(lib.library_dir()).unwrap();
        fs::create_dir_all(dir.path().join("captures")).unwrap();

        let leftover_part = lib.staging_dir().join("orphan.part");
        fs::write(&leftover_part, b"partial").unwrap();

        let hash = sha256_hex(b"# Markdown book");
        let kept_md = lib.library_dir().join(format!("{hash}.md"));
        let unreferenced_txt = lib.library_dir().join(format!("{hash}.txt"));
        fs::write(&kept_md, b"# Markdown book").unwrap();
        fs::write(&unreferenced_txt, b"# Markdown book").unwrap();

        // Untouched files outside managed dirs
        let capture_file = dir.path().join("captures").join("cap.png");
        fs::write(&capture_file, b"png").unwrap();
        let outside_file = dir.path().join("external.pdf");
        fs::write(&outside_file, b"%PDF-1.7").unwrap();

        let report = lib.reconcile(std::slice::from_ref(&kept_md)).unwrap();
        assert_eq!(report.removed_staging_entries, 1);
        assert_eq!(report.removed_library_files, 1);

        assert!(!leftover_part.exists());
        assert!(kept_md.exists());
        // Same hash prefix with different extension MUST be deleted when unreferenced (R3-08)
        assert!(!unreferenced_txt.exists());
        assert!(capture_file.exists());
        assert!(outside_file.exists());
    }

    #[cfg(unix)]
    #[test]
    fn begin_stage_rejects_symlinked_sync_staging_directory() {
        let app_data = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), app_data.path().join("sync-staging")).unwrap();

        let lib = ManagedLibrary::new(app_data.path());
        let bytes = b"should not escape";
        let hash = sha256_hex(bytes);

        let err = lib
            .begin_stage(DocumentFormat::Txt, "txt", &hash, bytes.len() as u64)
            .err()
            .expect("begin_stage must reject symlinked sync-staging");
        assert_eq!(err.code(), "io");
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn finish_rejects_symlinked_library_directory_and_preserves_external_file() {
        let app_data = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), app_data.path().join("library")).unwrap();

        let bytes = b"%PDF-1.7\nnew content\n";
        let hash = sha256_hex(bytes);
        let sentinel = b"EXTERNAL SENTINEL DO NOT OVERWRITE";
        let external_target = external.path().join(format!("{hash}.pdf"));
        fs::write(&external_target, sentinel).unwrap();

        let lib = ManagedLibrary::new(app_data.path());
        let mut staged = lib
            .begin_stage(DocumentFormat::Pdf, "pdf", &hash, bytes.len() as u64)
            .unwrap();
        let part_path = staged.part_path().to_path_buf();
        staged.write_chunk(bytes).unwrap();

        let err = staged.finish().unwrap_err();
        assert_eq!(err.code(), "io");
        assert!(!part_path.exists());
        assert_eq!(fs::read(&external_target).unwrap(), sentinel);
    }

    #[cfg(unix)]
    #[test]
    fn finish_rejects_symlinked_target_file_inside_library() {
        let app_data = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let sentinel = b"EXTERNAL FILE SENTINEL";
        let external_file = external.path().join("victim.pdf");
        fs::write(&external_file, sentinel).unwrap();

        let lib = ManagedLibrary::new(app_data.path());
        fs::create_dir_all(lib.library_dir()).unwrap();

        let bytes = b"%PDF-1.7\nvalid pdf payload\n";
        let hash = sha256_hex(bytes);
        let symlink_target = lib.library_dir().join(format!("{hash}.pdf"));
        std::os::unix::fs::symlink(&external_file, &symlink_target).unwrap();

        let mut staged = lib
            .begin_stage(DocumentFormat::Pdf, "pdf", &hash, bytes.len() as u64)
            .unwrap();
        let part_path = staged.part_path().to_path_buf();
        staged.write_chunk(bytes).unwrap();

        let err = staged.finish().unwrap_err();
        assert_eq!(err.code(), "io");
        assert!(!part_path.exists());
        assert_eq!(fs::read(&external_file).unwrap(), sentinel);
    }
}
