# ADR 0002: TXT anchors in lossy chunks

**Status:** Accepted for M2.

## Context

`TextChunk` offsets are exact only at chunk boundaries. Deriving an interior offset
from decoded UTF-8 length drifts wherever text is not byte-identical to the source:

- U+FFFD is 3 bytes, but it may replace 1 to 3 malformed bytes.
- **A stripped BOM drifts every offset in the first chunk by 3, with
  `hadReplacements` false.** Gating a fix on that flag would miss this case.
- A source file may contain a literal, valid U+FFFD (`EF BF BD`). Scanning the text
  for U+FFFD cannot tell it apart from a replacement.
- V1.1 decoders have no fixed relation between decoded and source length.

## Decision

**Send a replacement map: every chunk lists its non-identity spans.**

```ts
interface SourceSpan {
  textOffset: number; // UTF-8 bytes into chunk.text
  textLen: number; // decoded UTF-8 bytes; 0 for a stripped BOM
  sourceLen: number; // source bytes those decoded bytes stand for
}
// TextChunk gains: sourceSpans: SourceSpan[]  (ascending, non-overlapping)
```

Text outside a span is byte-identical to the source. `StreamDecoder` reports spans, and
that is the V1.1 contract for new encodings. The BOM is a span added by the pipeline.

### The invariant the frontend relies on

1. **Reconciliation.** For every chunk:
   `startByteOffset + utf8Len(text) + Σ(sourceLen − textLen) == endByteOffset`.
2. **One mapping.** Text positions convert to bytes only through the TXT text model
   (`sourceOffsetAt` and its inverse). No other frontend code does offset arithmetic
   on decoded text.
3. **Spans are atomic.** An anchor never lands inside a span. A selection touching a
   replacement covers all of its source bytes, and a source offset that lands inside
   a span rounds outward.
4. **Bytes are authoritative.** `TxtAnchor.startByteOffset` and `endByteOffset` locate
   the text. `lineIndex` is a hint only.

`fixtures/contract/text-chunks.json` holds source bytes, expected spans, and position
tables. Rust and TypeScript both test it, so the two sides cannot drift apart.

## Tradeoffs

- Accepted: a larger payload for badly damaged files. A binary file renamed `.txt` can
  produce one span per byte, roughly 3 MB of JSON per 64 KiB chunk. Clean UTF-8 costs
  an empty array.
- Accepted: an IPC contract change, and every decoder must report spans correctly.
  Reconciliation is tested so that a wrong decoder fails.

**Alternative rejected: boundary-anchoring lossy chunks.** One bad byte would make a
whole 64 KiB chunk unaddressable, so highlights would cover pages. Anchors would also
depend on the chunk size, which breaks the AGENTS.md rule that they survive
re-chunking. It also would not fix the BOM unless BOM chunks were treated as lossy too.

## What would reverse this

- A V1.1 multi-byte decoder making per-character spans too costly: keep the invariant
  and move to a run-length or per-line encoding of the same map.
- Measured stalls on real damaged files: merge adjacent spans, giving up exact
  addressing inside a run of replacements.
