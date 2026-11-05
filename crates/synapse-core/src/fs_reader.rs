//! File I/O and the modular text-decoding pipeline.
//!
//! Every text file reaches the frontend as UTF-8 chunks. Two traits are the
//! V1.1 extension points:
//!
//! - [`EncodingDetector`] guesses an encoding from a byte sample
//!   (`chardetng` plugs in here).
//! - [`TextDecoderService`] builds a stateful decoder for an encoding
//!   (`encoding_rs` plugs in here).
//!
//! Adding a character set means registering an implementation in
//! [`DecoderRegistry`]; [`stream_text`] and the Tauri command stay unchanged.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{CoreError, CoreResult};

pub const UTF8_LABEL: &str = "utf-8";
pub const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// A place where decoded text is not byte-identical to the source file. Text
/// outside every span is, so a span list fully maps text positions to source
/// offsets: see `docs/adr/0002-txt-anchor-drift.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    /// UTF-8 bytes into the chunk's text where the span begins.
    pub text_offset: usize,
    /// Decoded UTF-8 bytes in the span; zero for a stripped BOM.
    pub text_len: usize,
    /// Source bytes those decoded bytes stand for.
    pub source_len: usize,
}

/// Stateful decoder for one stream; it owns any bytes split across reads.
pub trait StreamDecoder: Send {
    /// Decodes `input`. With `is_last` set, trailing incomplete sequences are
    /// resolved rather than held.
    fn decode(&mut self, input: &[u8], is_last: bool) -> DecodedText;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    /// Source bytes represented by `text`, excluding bytes held for the next call.
    pub consumed_bytes: usize,
    /// True when malformed input was replaced with U+FFFD.
    pub had_replacements: bool,
    /// Ascending and non-overlapping. Every decoder must report each place its
    /// output differs from its input, or anchors drift.
    pub source_spans: Vec<SourceSpan>,
}

/// Factory for stream decoders of one encoding.
pub trait TextDecoderService: Send + Sync {
    /// Canonical lowercase label, e.g. `utf-8`.
    fn label(&self) -> &'static str;
    /// True if this service handles `label` (already lowercased and trimmed).
    fn accepts(&self, label: &str) -> bool;
    fn new_stream(&self) -> Box<dyn StreamDecoder>;
}

/// Guesses the encoding of a file from its leading bytes.
pub trait EncodingDetector: Send + Sync {
    /// Returns a label resolvable through a [`DecoderRegistry`].
    fn detect(&self, sample: &[u8]) -> &'static str;
}

/// V1 detector: every file is treated as UTF-8.
#[derive(Debug, Default, Clone, Copy)]
pub struct Utf8OnlyDetector;

impl EncodingDetector for Utf8OnlyDetector {
    fn detect(&self, _sample: &[u8]) -> &'static str {
        UTF8_LABEL
    }
}

/// UTF-8 with lossy fallback: malformed bytes become U+FFFD rather than errors.
#[derive(Debug, Default, Clone, Copy)]
pub struct Utf8LossyDecoderService;

impl TextDecoderService for Utf8LossyDecoderService {
    fn label(&self) -> &'static str {
        UTF8_LABEL
    }

    fn accepts(&self, label: &str) -> bool {
        matches!(label, "utf-8" | "utf8")
    }

    fn new_stream(&self) -> Box<dyn StreamDecoder> {
        Box::<Utf8LossyStream>::default()
    }
}

#[derive(Debug, Default)]
struct Utf8LossyStream {
    /// At most 3 bytes: the start of a code point cut off by the previous read.
    pending: Vec<u8>,
}

impl StreamDecoder for Utf8LossyStream {
    fn decode(&mut self, input: &[u8], is_last: bool) -> DecodedText {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(input);

        if !is_last {
            let held_from = incomplete_tail_start(&bytes);
            self.pending = bytes.split_off(held_from);
        }

        // Equivalent to `String::from_utf8_lossy`, which walks the same chunks,
        // but this keeps what each replacement stood for.
        let mut text = String::with_capacity(bytes.len());
        let mut source_spans = Vec::new();
        for chunk in bytes.utf8_chunks() {
            text.push_str(chunk.valid());
            if !chunk.invalid().is_empty() {
                source_spans.push(SourceSpan {
                    text_offset: text.len(),
                    text_len: char::REPLACEMENT_CHARACTER.len_utf8(),
                    source_len: chunk.invalid().len(),
                });
                text.push(char::REPLACEMENT_CHARACTER);
            }
        }
        DecodedText {
            text,
            consumed_bytes: bytes.len(),
            had_replacements: !source_spans.is_empty(),
            source_spans,
        }
    }
}

/// Index where a trailing, so-far-valid, incomplete UTF-8 sequence begins, or
/// `bytes.len()` if there is none. Only that tail is held back: `error_len() ==
/// None` is std's guarantee that more input could still complete it.
fn incomplete_tail_start(bytes: &[u8]) -> usize {
    // A UTF-8 sequence is at most 4 bytes, so an incomplete one starts within
    // the last 3. Earlier malformed bytes must not influence the answer.
    let search_from = bytes.len().saturating_sub(3);
    for start in search_from..bytes.len() {
        if let Err(error) = std::str::from_utf8(&bytes[start..])
            && error.valid_up_to() == 0
            && error.error_len().is_none()
        {
            return start;
        }
    }
    bytes.len()
}

/// Resolves encoding labels to decoders. V1 registers UTF-8 only.
pub struct DecoderRegistry {
    services: Vec<Box<dyn TextDecoderService>>,
    detector: Box<dyn EncodingDetector>,
}

impl Default for DecoderRegistry {
    fn default() -> Self {
        Self {
            services: vec![Box::new(Utf8LossyDecoderService)],
            detector: Box::new(Utf8OnlyDetector),
        }
    }
}

impl DecoderRegistry {
    pub fn new(
        services: Vec<Box<dyn TextDecoderService>>,
        detector: Box<dyn EncodingDetector>,
    ) -> Self {
        Self { services, detector }
    }

    /// Finds the decoder for an explicit label, or asks the detector when
    /// there is none. An explicit label that nothing handles is an error:
    /// silently reading GBK as UTF-8 would show garbage and corrupt offsets.
    pub fn resolve(
        &self,
        requested: Option<&str>,
        sample: &[u8],
    ) -> CoreResult<&dyn TextDecoderService> {
        let label = requested
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_else(|| self.detector.detect(sample).to_owned());
        self.services
            .iter()
            .find(|service| service.accepts(&label))
            .map(Box::as_ref)
            .ok_or(CoreError::UnsupportedEncoding(label))
    }
}

/// One decoded piece of a file.
///
/// Byte offsets refer to the **source file**, so a TXT anchor stays valid
/// regardless of how the file was chunked or which encoding it uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChunk {
    pub seq: u64,
    pub encoding: &'static str,
    pub start_byte_offset: u64,
    pub end_byte_offset: u64,
    /// Zero-based index of the line that `text` begins on.
    pub start_line_index: u64,
    pub text: String,
    pub had_replacements: bool,
    /// Where `text` differs from the source. The frontend's offset arithmetic
    /// is only correct with these applied.
    pub source_spans: Vec<SourceSpan>,
    pub is_last: bool,
}

/// Decodes `reader` into UTF-8 chunks, passing each to `sink` in order.
///
/// `sink` returning [`CoreError::StreamCancelled`] stops reading and is reported
/// as a normal end of stream. Returns the number of chunks delivered.
pub fn stream_text<R, F>(
    mut reader: R,
    requested_encoding: Option<&str>,
    registry: &DecoderRegistry,
    chunk_bytes: usize,
    mut sink: F,
) -> CoreResult<u64>
where
    R: Read,
    F: FnMut(TextChunk) -> CoreResult<()>,
{
    let chunk_bytes = chunk_bytes.max(4);
    let mut buffer = vec![0_u8; chunk_bytes];
    let mut filled = read_full(&mut reader, &mut buffer)?;
    let service = registry.resolve(requested_encoding, &buffer[..filled])?;
    let encoding = service.label();
    let mut decoder = service.new_stream();

    let mut seq = 0_u64;
    let mut offset = 0_u64;
    let mut line_index = 0_u64;
    let mut at_start = true;

    loop {
        // The chunk is the last one only once a further read comes back empty,
        // so read ahead rather than guessing from a short read.
        let mut next = vec![0_u8; chunk_bytes];
        let next_filled = if filled == chunk_bytes {
            read_full(&mut reader, &mut next)?
        } else {
            0
        };
        let is_last = next_filled == 0;

        let mut decoded = decoder.decode(&buffer[..filled], is_last);
        let start_offset = offset;
        offset += decoded.consumed_bytes as u64;

        if at_start && decoded.consumed_bytes > 0 {
            at_start = false;
            if encoding == UTF8_LABEL && buffer[..filled].starts_with(UTF8_BOM) {
                // The offsets still count the BOM: they address the source file.
                let bom_len = "\u{FEFF}".len();
                decoded.text.drain(..bom_len);
                for span in &mut decoded.source_spans {
                    span.text_offset -= bom_len;
                }
                decoded.source_spans.insert(
                    0,
                    SourceSpan {
                        text_offset: 0,
                        text_len: 0,
                        source_len: bom_len,
                    },
                );
            }
        }

        let start_line_index = line_index;
        line_index += decoded.text.bytes().filter(|byte| *byte == b'\n').count() as u64;

        let chunk = TextChunk {
            seq,
            encoding,
            start_byte_offset: start_offset,
            end_byte_offset: offset,
            start_line_index,
            text: decoded.text,
            had_replacements: decoded.had_replacements,
            source_spans: decoded.source_spans,
            is_last,
        };
        // A chunk of only held-back bytes carries nothing; the empty last chunk
        // is still sent so consumers always see `is_last`.
        if chunk.end_byte_offset > chunk.start_byte_offset || is_last {
            match sink(chunk) {
                Ok(()) => seq += 1,
                Err(CoreError::StreamCancelled) => return Ok(seq),
                Err(error) => return Err(error),
            }
        }

        if is_last {
            return Ok(seq);
        }
        buffer = next;
        filled = next_filled;
    }
}

/// Opens `path` and streams it through [`stream_text`].
pub fn stream_text_file<F>(
    path: &Path,
    requested_encoding: Option<&str>,
    registry: &DecoderRegistry,
    sink: F,
) -> CoreResult<u64>
where
    F: FnMut(TextChunk) -> CoreResult<()>,
{
    let file = File::open(path)?;
    stream_text(
        file,
        requested_encoding,
        registry,
        DEFAULT_CHUNK_BYTES,
        sink,
    )
}

/// Fills `buffer` unless EOF comes first; `Read::read` may return short reads.
fn read_full<R: Read>(reader: &mut R, buffer: &mut [u8]) -> CoreResult<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(filled)
}

/// SHA-256 of a file's content as lowercase hex; read incrementally so hashing
/// a large document does not load it into memory.
pub fn hash_file(path: &Path) -> CoreResult<String> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; DEFAULT_CHUNK_BYTES];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(bytes: &[u8], chunk_bytes: usize) -> Vec<TextChunk> {
        let mut chunks = Vec::new();
        stream_text(
            bytes,
            None,
            &DecoderRegistry::default(),
            chunk_bytes,
            |chunk| {
                chunks.push(chunk);
                Ok(())
            },
        )
        .unwrap();
        chunks
    }

    fn joined(chunks: &[TextChunk]) -> String {
        chunks.iter().map(|chunk| chunk.text.as_str()).collect()
    }

    #[test]
    fn multibyte_characters_survive_every_chunk_boundary() {
        let source = "a€b😀c汉字\nd€e😀f汉字\n".repeat(5);
        for chunk_bytes in 4..=23 {
            let chunks = collect(source.as_bytes(), chunk_bytes);
            assert_eq!(joined(&chunks), source, "chunk size {chunk_bytes}");
            assert!(chunks.iter().all(|chunk| !chunk.had_replacements));
        }
    }

    #[test]
    fn offsets_are_contiguous_and_address_source_bytes() {
        let source = "first €uro\nsecond 😀\nthird";
        let chunks = collect(source.as_bytes(), 5);
        let mut expected_start = 0;
        for chunk in &chunks {
            assert_eq!(chunk.start_byte_offset, expected_start);
            let (start, end) = (
                chunk.start_byte_offset as usize,
                chunk.end_byte_offset as usize,
            );
            assert_eq!(&source[start..end], chunk.text);
            expected_start = chunk.end_byte_offset;
        }
        assert_eq!(expected_start as usize, source.len());
        assert!(chunks.last().unwrap().is_last);
        assert_eq!(chunks.iter().filter(|chunk| chunk.is_last).count(), 1);
    }

    #[test]
    fn line_indexes_count_preceding_newlines() {
        let chunks = collect(b"aa\nbb\ncc\ndd", 4);
        for chunk in &chunks {
            let preceding = &b"aa\nbb\ncc\ndd"[..chunk.start_byte_offset as usize];
            let newlines = preceding.iter().filter(|byte| **byte == b'\n').count() as u64;
            assert_eq!(chunk.start_line_index, newlines);
        }
    }

    #[test]
    fn invalid_bytes_fall_back_to_replacement_characters() {
        let chunks = collect(b"ok \xFF\xFE end", 64);
        assert_eq!(joined(&chunks), "ok \u{FFFD}\u{FFFD} end");
        assert!(chunks[0].had_replacements);
        assert_eq!(chunks[0].end_byte_offset, 9);
    }

    #[test]
    fn invalid_byte_at_chunk_end_is_not_held_forever() {
        // 0xFF can never start a sequence, so nothing should wait for more input.
        let mut decoder = Utf8LossyDecoderService.new_stream();
        let decoded = decoder.decode(b"abc\xFF", false);
        assert_eq!(decoded.text, "abc\u{FFFD}");
        assert_eq!(decoded.consumed_bytes, 4);
    }

    #[test]
    fn truncated_sequence_at_end_of_file_is_replaced() {
        // First two of the three bytes of '€'.
        let chunks = collect(b"cost \xE2\x82", 64);
        assert_eq!(joined(&chunks), "cost \u{FFFD}");
        assert_eq!(chunks.last().unwrap().end_byte_offset, 7);
    }

    #[test]
    fn exact_multiple_of_chunk_size_marks_only_final_chunk_last() {
        let chunks = collect(b"abcdefgh", 4);
        assert_eq!(joined(&chunks), "abcdefgh");
        assert_eq!(
            chunks.iter().map(|chunk| chunk.is_last).collect::<Vec<_>>(),
            [false, true]
        );
    }

    #[test]
    fn empty_input_produces_one_terminal_chunk() {
        let chunks = collect(b"", 64);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].is_last);
        assert_eq!(chunks[0].text, "");
    }

    #[test]
    fn bom_is_stripped_but_still_counted_in_offsets() {
        let chunks = collect(b"\xEF\xBB\xBFhello", 64);
        assert_eq!(joined(&chunks), "hello");
        assert_eq!(chunks[0].start_byte_offset, 0);
        assert_eq!(chunks[0].end_byte_offset, 8);
    }

    #[test]
    fn bom_only_file_is_empty_text() {
        assert_eq!(joined(&collect(b"\xEF\xBB\xBF", 64)), "");
    }

    #[test]
    fn explicit_labels_are_normalized() {
        let registry = DecoderRegistry::default();
        for label in ["UTF-8", " utf8 ", "utf-8"] {
            assert_eq!(registry.resolve(Some(label), b"").unwrap().label(), "utf-8");
        }
    }

    #[test]
    fn unknown_explicit_encoding_is_an_error() {
        let result = stream_text(
            &b"data"[..],
            Some("gbk"),
            &DecoderRegistry::default(),
            64,
            |_| Ok(()),
        );
        assert!(matches!(result, Err(CoreError::UnsupportedEncoding(label)) if label == "gbk"));
    }

    #[test]
    fn cancelling_stops_reading_without_error() {
        let source = [b'x'; 100];
        let mut received = 0;
        let delivered = stream_text(
            &source[..],
            None,
            &DecoderRegistry::default(),
            10,
            |_chunk| {
                received += 1;
                if received == 2 {
                    Err(CoreError::StreamCancelled)
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(received, 2);
        assert_eq!(delivered, 1);
    }

    #[test]
    fn sink_errors_propagate() {
        let result = stream_text(
            &b"data"[..],
            None,
            &DecoderRegistry::default(),
            64,
            |_chunk| Err(CoreError::InvalidGraph("boom".into())),
        );
        assert!(matches!(result, Err(CoreError::InvalidGraph(_))));
    }

    /// A pluggable decoder must work without touching the pipeline: this is the
    /// V1.1 extension contract.
    #[test]
    fn registered_decoder_and_detector_are_used() {
        struct Latin1;
        struct Latin1Stream;
        impl StreamDecoder for Latin1Stream {
            fn decode(&mut self, input: &[u8], _is_last: bool) -> DecodedText {
                let mut text = String::new();
                let mut source_spans = Vec::new();
                for byte in input {
                    let decoded = char::from(*byte);
                    if decoded.len_utf8() != 1 {
                        source_spans.push(SourceSpan {
                            text_offset: text.len(),
                            text_len: decoded.len_utf8(),
                            source_len: 1,
                        });
                    }
                    text.push(decoded);
                }
                DecodedText {
                    text,
                    consumed_bytes: input.len(),
                    had_replacements: false,
                    source_spans,
                }
            }
        }
        impl TextDecoderService for Latin1 {
            fn label(&self) -> &'static str {
                "iso-8859-1"
            }
            fn accepts(&self, label: &str) -> bool {
                label == "iso-8859-1"
            }
            fn new_stream(&self) -> Box<dyn StreamDecoder> {
                Box::new(Latin1Stream)
            }
        }
        struct AlwaysLatin1;
        impl EncodingDetector for AlwaysLatin1 {
            fn detect(&self, _sample: &[u8]) -> &'static str {
                "iso-8859-1"
            }
        }

        let registry = DecoderRegistry::new(vec![Box::new(Latin1)], Box::new(AlwaysLatin1));
        let mut chunks = Vec::new();
        stream_text(&b"caf\xE9"[..], None, &registry, 64, |chunk| {
            chunks.push(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(joined(&chunks), "café");
        assert_eq!(chunks[0].encoding, "iso-8859-1");
        assert_reconciles(&chunks);
    }

    /// ADR 0002 invariant 1: what the frontend's offset arithmetic depends on.
    fn assert_reconciles(chunks: &[TextChunk]) {
        for chunk in chunks {
            let adjustment: i64 = chunk
                .source_spans
                .iter()
                .map(|span| span.source_len as i64 - span.text_len as i64)
                .sum();
            assert_eq!(
                chunk.start_byte_offset as i64 + chunk.text.len() as i64 + adjustment,
                chunk.end_byte_offset as i64,
                "{chunk:?}"
            );
            for pair in chunk.source_spans.windows(2) {
                assert!(pair[0].text_offset + pair[0].text_len <= pair[1].text_offset);
            }
        }
    }

    #[test]
    fn spans_reconcile_at_every_chunk_size() {
        let mut source =
            b"\xEF\xBB\xBFok \xFF\xFE \xE2\x82 mid \xF0\x9F\x98 caf\xC3\xA9\r\n".to_vec();
        source.extend_from_slice("literal \u{FFFD} here 😀\n".as_bytes());
        source.extend_from_slice(b"tail \xE2\x82");
        for chunk_bytes in 4..=40 {
            let chunks = collect(&source, chunk_bytes);
            assert_reconciles(&chunks);
            assert_eq!(
                chunks.last().unwrap().end_byte_offset as usize,
                source.len()
            );
        }
    }

    #[test]
    fn spans_identify_only_what_was_replaced() {
        // The literal U+FFFD is valid UTF-8 in the source: scanning the text for
        // U+FFFD could not tell these two apart.
        let chunks = collect(b"\xEF\xBF\xBD|\xFF|", 64);
        assert_eq!(joined(&chunks), "\u{FFFD}|\u{FFFD}|");
        assert_eq!(
            chunks[0].source_spans,
            [SourceSpan {
                text_offset: 4,
                text_len: 3,
                source_len: 1
            }]
        );
    }

    #[test]
    fn a_bom_is_a_span_even_though_nothing_was_replaced() {
        let chunks = collect(b"\xEF\xBB\xBFa\xFFb", 64);
        assert_eq!(
            chunks[0].source_spans,
            [
                SourceSpan {
                    text_offset: 0,
                    text_len: 0,
                    source_len: 3
                },
                SourceSpan {
                    text_offset: 1,
                    text_len: 3,
                    source_len: 1
                },
            ]
        );
        let clean = collect(b"\xEF\xBB\xBFabc", 64);
        assert!(!clean[0].had_replacements);
        assert_eq!(clean[0].source_spans.len(), 1);
    }

    #[test]
    fn clean_text_has_no_spans() {
        let chunks = collect("héllo 😀\n".as_bytes(), 64);
        assert!(chunks[0].source_spans.is_empty());
    }

    /// The fixture is checked by TypeScript too, so both sides share one truth.
    #[test]
    fn contract_fixture_matches_the_pipeline() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/contract/text-chunks.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let source = decode_hex(case["sourceHex"].as_str().unwrap());
            let chunk_bytes = case["chunkBytes"].as_u64().unwrap() as usize;
            let chunks = collect(&source, chunk_bytes);
            assert_eq!(
                serde_json::to_value(&chunks).unwrap(),
                case["chunks"],
                "{name}"
            );

            let text = joined(&chunks);
            for position in case["positions"].as_array().unwrap() {
                let unit = position["unit"].as_u64().unwrap() as usize;
                let expected = position["byte"].as_u64().unwrap();
                assert_eq!(
                    source_offset_at(&chunks, &text, unit),
                    expected,
                    "{name} at unit {unit}"
                );
            }
        }
    }

    fn decode_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    /// Test-only reference for the mapping the frontend performs on UTF-16 units.
    fn source_offset_at(chunks: &[TextChunk], text: &str, unit: usize) -> u64 {
        let mut decoded = 0;
        let mut units = 0;
        for character in text.chars() {
            if units >= unit {
                break;
            }
            units += character.len_utf16();
            decoded += character.len_utf8();
        }
        let mut chunk_start = 0;
        let mut found = None;
        for chunk in chunks {
            if chunk_start <= decoded {
                found = Some((chunk, chunk_start));
            }
            chunk_start += chunk.text.len();
        }
        let (chunk, start) = found.unwrap();
        let prefix = decoded - start;
        let adjustment: i64 = chunk
            .source_spans
            .iter()
            .filter(|span| span.text_offset + span.text_len <= prefix)
            .map(|span| span.source_len as i64 - span.text_len as i64)
            .sum();
        (chunk.start_byte_offset as i64 + prefix as i64 + adjustment) as u64
    }

    #[test]
    fn hash_matches_known_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            hash_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn streams_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.txt");
        std::fs::write(&path, "hello\nworld").unwrap();
        let mut text = String::new();
        stream_text_file(&path, None, &DecoderRegistry::default(), |chunk| {
            text.push_str(&chunk.text);
            Ok(())
        })
        .unwrap();
        assert_eq!(text, "hello\nworld");
    }

    #[test]
    fn missing_file_is_an_io_error() {
        let result = stream_text_file(
            Path::new("/no/such/file.txt"),
            None,
            &Default::default(),
            |_| Ok(()),
        );
        assert!(matches!(result, Err(CoreError::Io(_))));
    }
}
