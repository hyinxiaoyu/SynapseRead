import { describe, expect, it } from 'vitest';

import anchors from '../../../../fixtures/contract/anchors.json';
import { isAnchorLocation } from './domain';

describe('isAnchorLocation', () => {
  it('accepts every anchor in the fixture shared with Rust', () => {
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(isAnchorLocation(anchor)).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['unknown format', { format: 'docx' }],
    ['pdf without rects', { format: 'pdf', pageIndex: 0 }],
    ['pdf with bad rect', { format: 'pdf', pageIndex: 0, rects: [{ x: 0 }] }],
    [
      'pdf with empty pageSpans',
      {
        format: 'pdf',
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [],
      },
    ],
    [
      'pdf with mismatched first pageSpan pageIndex',
      {
        format: 'pdf',
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [{ pageIndex: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] }],
      },
    ],
    [
      'pdf with non-ascending pageSpans',
      {
        format: 'pdf',
        pageIndex: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [
          { pageIndex: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] },
          { pageIndex: 1, rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }] },
        ],
      },
    ],
    ['epub without href', { format: 'epub', cfiRange: 'x' }],
    [
      'txt with string offset',
      { format: 'txt', startByteOffset: '0', endByteOffset: 1, lineIndex: 0 },
    ],
    ['md without node', { format: 'md', offset: 0 }],
  ])('rejects %s', (_name, value) => {
    expect(isAnchorLocation(value)).toBe(false);
  });
});
