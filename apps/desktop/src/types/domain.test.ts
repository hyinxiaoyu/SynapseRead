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
