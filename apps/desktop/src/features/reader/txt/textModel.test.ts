import { describe, expect, it } from 'vitest';

import { streamUtf8Lossy } from '@/lib/backend/memoryTextStream';
import type { TextChunk } from '@/types/domain';

import cases from '../../../../../../fixtures/contract/text-chunks.json';
import { MAX_ROW_UNITS, TxtTextModel } from './textModel';

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const modelOf = (source: string | Uint8Array, chunkBytes = 64 * 1024) => {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const model = new TxtTextModel();
  streamUtf8Lossy(bytes, chunkBytes, (chunk) => model.append(chunk));
  return model;
};

describe.each(cases)('contract fixture shared with Rust: $name', (testCase) => {
  const source = fromHex(testCase.sourceHex);

  it('the memory backend streams exactly what the Rust pipeline does', () => {
    const chunks: TextChunk[] = [];
    streamUtf8Lossy(source, testCase.chunkBytes, (chunk) => chunks.push(chunk));
    expect(chunks).toEqual(testCase.chunks);
  });

  it('maps every position to its source byte and back', () => {
    const model = new TxtTextModel();
    for (const chunk of testCase.chunks) model.append(chunk);
    for (const { unit, byte } of testCase.positions) {
      expect(model.sourceOffsetAt(unit)).toBe(byte);
      expect(model.unitAtSourceOffset(byte, 'down')).toBe(unit);
      expect(model.unitAtSourceOffset(byte, 'up')).toBe(unit);
    }
  });
});

describe('TxtTextModel', () => {
  it('addresses the source through a BOM that decoded length cannot see', () => {
    const model = modelOf(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]));
    const selection = model.selectionFor(1, 3);
    expect(selection?.text).toBe('bc');
    expect(selection?.anchor).toMatchObject({ startByteOffset: 4, endByteOffset: 6 });
  });

  it('does not drift past replacements of different source lengths', () => {
    // "a", 2 malformed bytes -> 2 U+FFFD, a truncated 2-byte sequence -> 1 U+FFFD, "bc"
    const bytes = new Uint8Array([0x61, 0xff, 0xfe, 0xe2, 0x82, 0x62, 0x63]);
    const model = modelOf(bytes);
    expect(model.slice(0, 6)).toBe('a���bc');
    expect(model.hadReplacements).toBe(true);
    const selection = model.selectionFor(4, 6);
    expect(selection?.text).toBe('bc');
    expect(selection?.anchor).toMatchObject({ startByteOffset: 5, endByteOffset: 7 });
  });

  it('keeps a replacement atomic in both directions', () => {
    // U+FFFD at unit 1 stands for bytes 1..3.
    const model = modelOf(new Uint8Array([0x61, 0xe2, 0x82, 0x62]));
    const covering = model.selectionFor(1, 2);
    expect(covering?.anchor).toMatchObject({ startByteOffset: 1, endByteOffset: 3 });
    // An offset inside the span rounds outward.
    expect(model.unitAtSourceOffset(2, 'down')).toBe(1);
    expect(model.unitAtSourceOffset(2, 'up')).toBe(2);
  });

  it('does not mistake a literal U+FFFD for a replacement', () => {
    const model = modelOf(new Uint8Array([0xef, 0xbf, 0xbd, 0x7c, 0xff, 0x7c]));
    expect(model.sourceOffsetAt(1)).toBe(3);
    expect(model.sourceOffsetAt(3)).toBe(5);
  });

  it.each([4, 5, 7, 16, 64])('gives the same anchors at chunk size %i', (chunkBytes) => {
    const source = '第一行 line\r\n😀 second line\n\nfourth € line\n';
    const reference = modelOf(source);
    const model = modelOf(source, chunkBytes);
    expect(model.rowCount).toBe(reference.rowCount);
    const end = model.rowStart(model.rowCount);
    expect(model.selectionFor(0, end)).toEqual(reference.selectionFor(0, end));
    expect(model.selectionFor(6, 20)).toEqual(reference.selectionFor(6, 20));
  });

  it('round-trips an anchor through the source file', () => {
    const source = '第一行\n😀 target text here\nlast';
    const model = modelOf(source);
    const start = source.indexOf('target');
    const selection = model.selectionFor(start, start + 'target text'.length);
    const anchor = selection?.anchor;
    if (!anchor) throw new Error('expected a selection');

    const bytes = new TextEncoder().encode(source);
    const decoded = new TextDecoder().decode(
      bytes.slice(anchor.startByteOffset, anchor.endByteOffset),
    );
    expect(decoded).toBe('target text');
    expect(anchor.lineIndex).toBe(1);
    expect(model.rangeFor(anchor)).toEqual({
      startUnit: start,
      endUnit: start + 'target text'.length,
    });
  });

  it('never splits a surrogate pair with a selection', () => {
    const model = modelOf('a😀b');
    // Unit 2 is the low surrogate of the emoji.
    expect(model.selectionFor(2, 3)?.text).toBe('😀');
    expect(model.selectionFor(1, 2)?.text).toBe('😀');
  });

  it('drops line breaks at the edges of a selection', () => {
    const model = modelOf('first\r\nsecond\nthird');
    expect(model.selectionFor(0, 7)?.text).toBe('first');
    expect(model.selectionFor(0, 7)?.anchor).toMatchObject({ endByteOffset: 5 });
    expect(model.selectionFor(5, 13)?.text).toBe('second');
  });

  it('treats a whitespace-only selection as no selection', () => {
    expect(modelOf('a   \n\n  b').selectionFor(1, 8)).toBeNull();
  });

  it('strips line terminators from rows, but not from the text', () => {
    const model = modelOf('one\r\ntwo\nthree');
    expect([model.rowText(0), model.rowText(1), model.rowText(2)]).toEqual(['one', 'two', 'three']);
    expect(model.slice(0, 9)).toBe('one\r\ntwo\n');
  });

  it('counts a final newline as an empty last row and reports the row before it', () => {
    const model = modelOf('a\nb\n');
    expect(model.rowCount).toBe(3);
    expect(model.rowText(2)).toBe('');
    expect(model.cursorAnchorForRow(2)).toMatchObject({ startByteOffset: 2, endByteOffset: 4 });
  });

  it('has no cursor anchor for an empty document', () => {
    expect(modelOf('').cursorAnchorForRow(0)).toBeNull();
    expect(modelOf(new Uint8Array([0xef, 0xbb, 0xbf])).cursorAnchorForRow(0)).toBeNull();
  });

  it('splits an enormous line into rows, keeping the logical line index', () => {
    const line = 'x'.repeat(MAX_ROW_UNITS * 2 + 10);
    const model = modelOf(`${line}\nnext`, 1024);
    expect(model.rowCount).toBe(4);
    expect(model.rowText(0)).toHaveLength(MAX_ROW_UNITS);
    expect(model.rowText(2)).toHaveLength(10);
    expect(model.rowText(3)).toBe('next');
    expect(model.cursorAnchorForRow(1)).toMatchObject({ lineIndex: 0 });
    expect(model.cursorAnchorForRow(3)).toMatchObject({ lineIndex: 1 });
  });

  it('never splits a surrogate pair across forced rows', () => {
    const model = modelOf(`${'x'.repeat(MAX_ROW_UNITS - 1)}😀${'y'.repeat(10)}`, 512);
    expect(model.rowText(0)).toHaveLength(MAX_ROW_UNITS - 1);
    expect(model.rowText(1).startsWith('😀')).toBe(true);
  });

  it('reports anchors beyond what has loaded as pending', () => {
    const model = new TxtTextModel();
    const [first] = collect('hello world', 5);
    if (!first) throw new Error('expected a chunk');
    model.append(first);
    expect(model.complete).toBe(false);
    expect(
      model.rangeFor({ format: 'txt', startByteOffset: 6, endByteOffset: 11, lineIndex: 0 }),
    ).toBeNull();
  });

  it('refuses a gap in the stream rather than drifting silently', () => {
    const model = new TxtTextModel();
    const chunks = collect('hello world', 5);
    expect(() => model.append(chunks[1] as TextChunk)).toThrow(/gap/);
  });

  it('searches across chunks with case-sensitivity options and retains source-byte mapping', () => {
    // BOM (3 bytes) + "第一行 Fox\n" + invalid byte 0xff (1 byte -> U+FFFD) + " fox € target"
    const prefix = new Uint8Array([0xef, 0xbb, 0xbf]);
    const part1 = new TextEncoder().encode('第一行 Fox\n');
    const bad = new Uint8Array([0xff]);
    const part2 = new TextEncoder().encode(' fox € target');
    const source = new Uint8Array(prefix.length + part1.length + bad.length + part2.length);
    source.set(prefix, 0);
    source.set(part1, prefix.length);
    source.set(bad, prefix.length + part1.length);
    source.set(part2, prefix.length + part1.length + bad.length);

    const model = modelOf(source, 7);
    expect(model.search('   ')).toEqual([]);
    expect(model.search('nonexistent')).toEqual([]);

    const insensitive = model.search('fox');
    expect(insensitive).toHaveLength(2);
    expect(insensitive[0]?.matchText).toBe('Fox');
    expect(insensitive[0]?.locationLabel).toBe('Line 1');
    expect(insensitive[1]?.matchText).toBe('fox');
    expect(insensitive[1]?.locationLabel).toBe('Line 2');

    // Every match's TxtAnchor must slice the exact source bytes in `source`.
    for (const match of insensitive) {
      const slice = source.slice(match.anchor.startByteOffset, match.anchor.endByteOffset);
      expect(new TextDecoder().decode(slice)).toBe(match.matchText);
      expect(model.rangeFor(match.anchor)).toEqual({
        startUnit: match.startUnit,
        endUnit: match.endUnit,
      });
    }

    const sensitive = model.search('fox', { caseSensitive: true });
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0]?.matchText).toBe('fox');
    expect(sensitive[0]?.lineNumber).toBe(2);
  });

  it('finds folded matches across a break and an accent without moving byte anchors', () => {
    const source = new TextEncoder().encode('The lazy dog.\nPack my box. A café.');
    const model = modelOf(source, 16);

    const [wrapped] = model.search('dog. Pack');
    expect(wrapped).toBeDefined();
    expect(wrapped?.matchText).toBe('dog. Pack');
    const wrappedBytes = source.slice(
      wrapped!.anchor.startByteOffset,
      wrapped!.anchor.endByteOffset,
    );
    expect(new TextDecoder().decode(wrappedBytes)).toBe('dog.\nPack');

    const [accented] = model.search('cafe');
    expect(accented).toBeDefined();
    expect(accented?.matchText).toBe('café');
    const accentedBytes = source.slice(
      accented!.anchor.startByteOffset,
      accented!.anchor.endByteOffset,
    );
    expect(new TextDecoder().decode(accentedBytes)).toBe('café');

    expect(model.search('cafe', { matchDiacritics: true })).toEqual([]);
    expect(model.search('dog', { wholeWord: true })).toHaveLength(1);

    const decomposed = new TextEncoder().encode('A cafe\u0301.\n');
    const nfdModel = modelOf(decomposed, 8);
    const [decomposedMatch] = nfdModel.search('café');
    expect(decomposedMatch).toBeDefined();
    expect(
      new TextDecoder().decode(
        decomposed.slice(
          decomposedMatch!.anchor.startByteOffset,
          decomposedMatch!.anchor.endByteOffset,
        ),
      ),
    ).toBe('cafe\u0301');
    expect(nfdModel.search('café', { matchDiacritics: true })).toHaveLength(1);
  });
});

function collect(source: string, chunkBytes: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  streamUtf8Lossy(new TextEncoder().encode(source), chunkBytes, (chunk) => chunks.push(chunk));
  return chunks;
}
