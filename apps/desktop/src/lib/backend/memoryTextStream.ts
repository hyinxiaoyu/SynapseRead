import type { SourceSpan, TextChunk } from '@/types/domain';

const BOM = [0xef, 0xbb, 0xbf];
const REPLACEMENT_UTF8_LEN = 3;

export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Length of the UTF-8 sequence at `index`, following the Unicode table of
 * well-formed sequences. `valid: false` covers its maximal ill-formed subpart,
 * which is what one U+FFFD replaces. `truncated` means input ran out while the
 * sequence was still valid so far.
 */
function scanSequence(
  bytes: Uint8Array,
  index: number,
): { length: number; valid: boolean; truncated: boolean } {
  const lead = bytes[index] as number;
  if (lead < 0x80) return { length: 1, valid: true, truncated: false };

  let continuation: number;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) continuation = 1;
  else if (lead >= 0xe0 && lead <= 0xef) {
    continuation = 2;
    if (lead === 0xe0) low = 0xa0;
    if (lead === 0xed) high = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    continuation = 3;
    if (lead === 0xf0) low = 0x90;
    if (lead === 0xf4) high = 0x8f;
  } else return { length: 1, valid: false, truncated: false };

  for (let offset = 1; offset <= continuation; offset += 1) {
    const next = bytes[index + offset];
    if (next === undefined) return { length: offset, valid: false, truncated: true };
    if (next < low || next > high) return { length: offset, valid: false, truncated: false };
    low = 0x80;
    high = 0xbf;
  }
  return { length: continuation + 1, valid: true, truncated: false };
}

/**
 * The browser-side twin of `stream_text` in `synapse-core`, so tests and the
 * preview see the same chunks as the app. `fixtures/contract/text-chunks.json`
 * checks both against one expected output.
 */
export function streamUtf8Lossy(
  source: Uint8Array,
  chunkBytes: number,
  onChunk: (chunk: TextChunk) => void,
): number {
  const size = Math.max(chunkBytes, 4);
  const hasBom = BOM.every((byte, index) => source[index] === byte);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

  let seq = 0;
  let offset = 0;
  let line = 0;
  let read = 0;
  let bomPending = hasBom;

  for (;;) {
    read = Math.min(read + size, source.length);
    const isLast = read >= source.length;
    const available = source.subarray(offset, read);

    let text = '';
    let textLength = 0;
    const spans: SourceSpan[] = [];
    let hadReplacements = false;
    let index = 0;
    let validFrom = 0;
    const flushValid = (end: number) => {
      if (end > validFrom) {
        const valid = available.subarray(validFrom, end);
        text += decoder.decode(valid);
        textLength += valid.length;
      }
    };

    while (index < available.length) {
      const sequence = scanSequence(available, index);
      if (sequence.truncated && !isLast) break;
      if (!sequence.valid) {
        flushValid(index);
        spans.push({
          textOffset: textLength,
          textLen: REPLACEMENT_UTF8_LEN,
          sourceLen: sequence.length,
        });
        text += '�';
        textLength += REPLACEMENT_UTF8_LEN;
        hadReplacements = true;
        validFrom = index + sequence.length;
      }
      index += sequence.length;
    }
    flushValid(index);

    const start = offset;
    offset += index;

    if (bomPending && index > 0) {
      bomPending = false;
      text = text.slice(1);
      for (const span of spans) span.textOffset -= BOM.length;
      spans.unshift({ textOffset: 0, textLen: 0, sourceLen: BOM.length });
    }

    if (offset > start || isLast) {
      onChunk({
        seq,
        encoding: 'utf-8',
        startByteOffset: start,
        endByteOffset: offset,
        startLineIndex: line,
        text,
        hadReplacements,
        sourceSpans: spans,
        isLast,
      });
      seq += 1;
    }
    line += text.split('\n').length - 1;
    if (isLast) return seq;
  }
}
