import { describe, expect, it } from 'vitest';

import {
  canvasRegion,
  mergeLineRects,
  normalizeBoxes,
  noteMarkerPoint,
  rotateNormalizedRect,
  unrotateNormalizedRect,
} from './pdfGeometry';

const page = { left: 100, top: 50, width: 200, height: 400 };

describe('normalizeBoxes', () => {
  it('expresses boxes as fractions of the page', () => {
    expect(normalizeBoxes([{ left: 120, top: 90, width: 100, height: 40 }], page)).toEqual([
      { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
    ]);
  });

  it('is unchanged by zoom', () => {
    const zoomed = { left: 0, top: 0, width: 600, height: 1200 };
    const box = { left: 60, top: 120, width: 300, height: 120 };
    expect(normalizeBoxes([box], zoomed)).toEqual([{ x: 0.1, y: 0.1, width: 0.5, height: 0.1 }]);
  });

  it('clips to the page and drops what falls outside', () => {
    expect(normalizeBoxes([{ left: 50, top: 50, width: 100, height: 40 }], page)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 0.1 },
    ]);
    expect(normalizeBoxes([{ left: 400, top: 50, width: 10, height: 10 }], page)).toEqual([]);
    expect(normalizeBoxes([{ left: 120, top: 90, width: 0, height: 10 }], page)).toEqual([]);
  });

  it('never rounds past the page edge, which core would reject', () => {
    const [rect] = normalizeBoxes(
      [{ left: 100 + 200 / 3, top: 50 + 400 / 3, width: (200 * 2) / 3, height: (400 * 2) / 3 }],
      page,
    );
    if (!rect) throw new Error('expected a rectangle');
    expect(rect.x + rect.width).toBeLessThanOrEqual(1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1);
  });
});

describe('mergeLineRects', () => {
  it('joins runs on one line, and keeps lines apart', () => {
    expect(
      mergeLineRects([
        { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
        { x: 0.3, y: 0.1, width: 0.2, height: 0.02 },
        { x: 0.1, y: 0.13, width: 0.4, height: 0.02 },
      ]),
    ).toEqual([
      { x: 0.1, y: 0.1, width: 0.4, height: 0.02 },
      { x: 0.1, y: 0.13, width: 0.4, height: 0.02 },
    ]);
  });
});

describe('canvasRegion', () => {
  it('maps to device pixels, whatever the canvas scale', () => {
    expect(
      canvasRegion({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, { width: 800, height: 400 }),
    ).toEqual({ x: 200, y: 200, width: 400, height: 100 });
  });

  it('never produces an empty image', () => {
    const region = canvasRegion(
      { x: 0, y: 0, width: 0.0001, height: 0.0001 },
      { width: 100, height: 100 },
    );
    expect(region).toMatchObject({ width: 1, height: 1 });
  });
});

describe('rotateNormalizedRect / unrotateNormalizedRect', () => {
  const canonical = { x: 0.1, y: 0.2, width: 0.3, height: 0.15 };

  it('rotates clockwise through 90, 180, and 270 degrees and round-trips back to canonical', () => {
    expect(rotateNormalizedRect(canonical, 0)).toEqual(canonical);
    expect(rotateNormalizedRect(canonical, 90)).toEqual({
      x: 0.65,
      y: 0.1,
      width: 0.15,
      height: 0.3,
    });
    expect(rotateNormalizedRect(canonical, 180)).toEqual({
      x: 0.6,
      y: 0.65,
      width: 0.3,
      height: 0.15,
    });
    expect(rotateNormalizedRect(canonical, 270)).toEqual({
      x: 0.2,
      y: 0.6,
      width: 0.15,
      height: 0.3,
    });

    for (const rotation of [0, 90, 180, 270] as const) {
      const rotated = rotateNormalizedRect(canonical, rotation);
      expect(unrotateNormalizedRect(rotated, rotation)).toEqual(canonical);
    }
  });
});

describe('noteMarkerPoint', () => {
  const rects = [
    { x: 0.1, y: 0.2, width: 0.6, height: 0.02 },
    { x: 0.1, y: 0.25, width: 0.3, height: 0.02 },
  ];

  it('sits at the top right of the last line', () => {
    expect(noteMarkerPoint(rects, 0)).toEqual({ x: 0.4, y: 0.25 });
  });

  it('follows the page as it is turned', () => {
    // A quarter turn clockwise carries (x, y) to (1 - y, x).
    expect(noteMarkerPoint(rects, 90)).toEqual({ x: 0.75, y: 0.4 });
    expect(noteMarkerPoint(rects, 180)).toEqual({ x: 0.6, y: 0.75 });
    expect(noteMarkerPoint(rects, 270)).toEqual({ x: 0.25, y: 0.6 });
  });

  it('has nowhere to go without a line', () => {
    expect(noteMarkerPoint([], 0)).toBeNull();
  });
});
