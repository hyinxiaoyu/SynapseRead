import { describe, expect, it } from 'vitest';

import { streamUtf8Lossy } from '@/lib/backend/memoryTextStream';
import { documentFixture } from '@/test/fixtures';

import { HeadingScanner, isCapsHeading, matchNumberedHeading } from './headings';
import { MAX_ROW_UNITS, TxtTextModel } from './textModel';

const encoder = new TextEncoder();

const modelOf = (source: string | Uint8Array, chunkBytes = 64 * 1024) => {
  const bytes = typeof source === 'string' ? encoder.encode(source) : source;
  const model = new TxtTextModel();
  streamUtf8Lossy(bytes, chunkBytes, (chunk) => model.append(chunk));
  return model;
};

const labelsOf = (text: string) => modelOf(text).headings.map((heading) => heading.label);

const scan = (lines: readonly string[]) => {
  const scanner = new HeadingScanner();
  lines.forEach((text, row) => scanner.push({ row, text, wholeLine: true }));
  scanner.finish();
  return scanner.headings;
};

const prose = 'It was a dark and stormy night, and the rain fell in torrents.';

describe('matchNumberedHeading', () => {
  it.each([
    ['Chapter 12', 1],
    ['CHAPTER XII', 1],
    ['Chapter Twelve', 1],
    ['Chapter twenty-one', 1],
    ['Chapter 3. The Storm', 1],
    ['Chapter 3: The Storm', 1],
    ['Chapter 3 — The Storm', 1],
    ['Chapter 3 The Storm', 1],
    ['CHAP. IV.', 1],
    ['Part II', 0],
    ['PART ONE', 0],
    ['Book the First', null],
    ['Book 2', 0],
    ['Volume III: The Return', 0],
    ['Prologue', 1],
    ['Epilogue: Ten Years Later', 1],
    ['  Chapter 7  ', 1],
  ])('%j is level %j', (line, level) => {
    expect(matchNumberedHeading(line)?.level ?? null).toBe(level);
  });

  it.each([
    ['第十二章', 1],
    ['第一章 风起', 1],
    ['第一章：风起', 1],
    ['第 3 回', 1],
    ['第１２章　归来', 1],
    ['第一百零八回 忠义堂', 1],
    ['第二卷', 0],
    ['第三部 终章', 0],
    ['楔子', 1],
    ['序章 开端', 1],
    ['尾声', 1],
  ])('Chinese %j is level %j', (line, level) => {
    expect(matchNumberedHeading(line)?.level ?? null).toBe(level);
  });

  it.each([
    'Chapter 12 was the longest in the book.',
    'chapter 12',
    'In Chapter 12 the hero returns.',
    'Part of the problem was the weather.',
    'Book lovers, all of them,',
    'Introduction to the theory of everything was a class she hated',
    '第一章的内容很长。',
    '他翻到第十二章看了起来。',
    '第十二章节选',
    `Chapter 1 ${'and a very long title that goes on '.repeat(3)}`,
  ])('%j is prose', (line) => {
    expect(matchNumberedHeading(line)).toBeNull();
  });

  it('collapses inner whitespace, including the ideographic space', () => {
    expect(matchNumberedHeading('第一章　　风起')?.label).toBe('第一章 风起');
    expect(matchNumberedHeading('Chapter   3.   The Storm')?.label).toBe('Chapter 3. The Storm');
  });
});

describe('isCapsHeading', () => {
  it.each(['THE STORM', 'LOOMINGS', 'A NEW BEGINNING', 'THE END'])('%j is a heading', (line) => {
    expect(isCapsHeading(line)).toBe(true);
  });

  it.each(['I', 'OK', '* * *', '1984', 'STOP!', 'WHAT?', 'HELLO, WORLD,', 'The Storm', '风起'])(
    '%j is not',
    (line) => {
      expect(isCapsHeading(line)).toBe(false);
    },
  );
});

describe('HeadingScanner', () => {
  it('needs a blank line on both sides of an all-caps line', () => {
    expect(scan(['', 'THE STORM', '', prose])).toMatchObject([{ row: 1, label: 'THE STORM' }]);
    expect(scan([prose, 'THE STORM', '', prose])).toEqual([]);
    expect(scan(['', 'THE STORM', prose])).toEqual([]);
    // The file's start and end count as blank lines.
    expect(scan(['THE STORM'])).toMatchObject([{ label: 'THE STORM' }]);
  });

  it('takes an all-caps title under a numbered heading as its title', () => {
    expect(scan(['CHAPTER I', '', 'THE STORM', '', prose])).toEqual([
      { row: 0, label: 'CHAPTER I: THE STORM', level: 1, joined: false },
    ]);
    // A heading that already has a title keeps it; the caps line is still absorbed.
    expect(scan(['Chapter 1. Loomings', '', 'CALL ME ISHMAEL', '', prose])).toEqual([
      { row: 0, label: 'Chapter 1. Loomings', level: 1, joined: false },
    ]);
  });

  it('skips a table of contents and keeps the chapters it lists', () => {
    const headings = scan([
      'Contents',
      '',
      'Chapter 1. Loomings',
      'Chapter 2. The Carpet-Bag',
      'Chapter 3. The Spouter-Inn',
      '',
      '',
      'Chapter 1. Loomings',
      '',
      prose,
      '',
      'Chapter 2. The Carpet-Bag',
      prose,
    ]);
    expect(headings).toEqual([
      { row: 7, label: 'Chapter 1. Loomings', level: 1, joined: false },
      { row: 11, label: 'Chapter 2. The Carpet-Bag', level: 1, joined: false },
    ]);
  });

  it('keeps a part and its first chapter, which repeat no level, joined', () => {
    expect(scan(['Part One', '', 'Chapter 1', '', prose, 'Chapter 2', prose])).toEqual([
      { row: 0, label: 'Part One', level: 0, joined: false },
      { row: 2, label: 'Chapter 1', level: 1, joined: true },
      { row: 5, label: 'Chapter 2', level: 1, joined: false },
    ]);
  });

  it('never takes a piece of a split line', () => {
    const scanner = new HeadingScanner();
    scanner.push({ row: 0, text: 'Chapter 1', wholeLine: false });
    scanner.push({ row: 1, text: prose, wholeLine: true });
    scanner.finish();
    expect(scanner.headings).toEqual([]);
  });
});

describe('TxtTextModel headings', () => {
  const english = [
    'A Tale of Two Ports',
    '',
    'PART ONE',
    '',
    'CHAPTER I',
    '',
    'THE STORM',
    '',
    prose,
    prose,
    '',
    'Chapter 2. Café Society',
    '',
    prose,
    '',
    'Chapter 3 — 😀 Days',
    prose,
    '',
    'Part II',
    '',
    'Chapter 4',
    prose,
    '',
  ].join('\n');

  it('finds English headings and nests nothing itself', () => {
    expect(modelOf(english).headings.map(({ label, level }) => [label, level])).toEqual([
      ['PART ONE', 0],
      ['CHAPTER I: THE STORM', 1],
      ['Chapter 2. Café Society', 1],
      ['Chapter 3 — 😀 Days', 1],
      ['Part II', 0],
      ['Chapter 4', 1],
    ]);
  });

  it('finds Chinese headings', () => {
    const chinese = [
      '风起之时',
      '',
      '第一卷 潜龙',
      '',
      '第一章 少年',
      '　　天色渐暗，城门将闭。他背着书箱，快步走过长街。',
      '　　他翻到第十二章看了起来。',
      '',
      '第二章：远行',
      '　　次日清晨，他告别了母亲。',
      '',
      '第3章 风雨',
      '　　雨下了三天三夜。',
      '',
      '尾声',
      '　　多年以后，他回到了故乡。',
    ].join('\n');
    expect(labelsOf(chinese)).toEqual([
      '第一卷 潜龙',
      '第一章 少年',
      '第二章：远行',
      '第3章 风雨',
      '尾声',
    ]);
  });

  it('places every heading on the source byte its line starts at', () => {
    const bytes = encoder.encode(english);
    for (const heading of modelOf(bytes).headings) {
      const line = new TextDecoder().decode(bytes.subarray(heading.startByte)).split('\n')[0];
      expect(line?.startsWith(heading.label.split(':')[0] as string)).toBe(true);
    }
  });

  it('reports the same bytes whatever the chunking', () => {
    const bytes = encoder.encode(english);
    const reference = modelOf(bytes).headings;
    expect(reference.length).toBeGreaterThan(0);
    for (const chunkBytes of [4, 5, 7, 16, 61, 128]) {
      expect(modelOf(bytes, chunkBytes).headings).toEqual(reference);
    }
  });

  it('counts a BOM and CRLF line ends in the bytes, not the text', () => {
    const lf = modelOf(english).headings;
    const crlf = encoder.encode(english.replaceAll('\n', '\r\n'));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...crlf]);
    const headings = modelOf(withBom, 9).headings;
    expect(headings.map((heading) => heading.label)).toEqual(lf.map((heading) => heading.label));
    for (const [index, heading] of headings.entries()) {
      const row = lf[index]?.row as number;
      // Each earlier line gained a CR, and the file a three-byte BOM.
      expect(heading.startByte).toBe((lf[index]?.startByte as number) + row + 3);
      expect(heading.row).toBe(row);
    }
  });

  it('maps a heading byte back to its row, once that byte has loaded', () => {
    const model = modelOf(english);
    for (const heading of model.headings) {
      expect(model.rowAtSourceOffset(heading.startByte)).toBe(heading.row);
    }
    expect(model.rowAtSourceOffset(model.loadedBytes + 1)).toBeNull();
  });

  it('finds headings as the text streams, holding back only the unfinished row', () => {
    const bytes = encoder.encode(english);
    const model = new TxtTextModel();
    const seen: number[] = [];
    streamUtf8Lossy(bytes, 16, (chunk) => {
      model.append(chunk);
      seen.push(model.headings.length);
    });
    expect(seen.at(-1)).toBe(6);
    // Some arrive before the end: the scan follows the stream.
    expect(seen.some((count) => count > 0 && count < 6)).toBe(true);
    // And the list only grows.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('ignores a heading-shaped tail of a line split for length', () => {
    const long = `${'x'.repeat(MAX_ROW_UNITS)}Chapter 9`;
    const model = modelOf(`${long}\n\n${prose}\n`);
    expect(model.rowCount).toBeGreaterThan(2);
    expect(model.headings).toEqual([]);
  });

  it('finds nothing in prose', () => {
    expect(labelsOf([prose, '', prose, 'Chapter 12 was long.', ''].join('\n'))).toEqual([]);
  });

  it('reads the preview fixture as the e2e flow expects', () => {
    const bytes = documentFixture('sample-chapters.txt');
    const model = modelOf(bytes, 1024);
    expect(model.headings.map(({ label, level }) => [label, level])).toEqual([
      ['PART ONE', 0],
      ['CHAPTER I: ARRIVAL', 1],
      ['Chapter 2. The Lighthouse', 1],
      ['Part Two', 0],
      ['第三章 归途', 1],
      ['第四章：灯塔', 1],
      ['Epilogue', 1],
    ]);
    const decoded = new TextDecoder();
    for (const heading of model.headings) {
      const line = decoded.decode(bytes.subarray(heading.startByte)).split('\n')[0] as string;
      expect(heading.label.startsWith(line)).toBe(true);
    }
  });
});
