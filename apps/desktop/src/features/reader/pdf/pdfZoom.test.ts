import { describe, expect, it } from 'vitest';

import { pagesInSpread, spreadCount, spreadOfPage } from './pdfPages';
import {
  anchoredScroll,
  clampZoomRatio,
  clampZoomScale,
  locateInRow,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  pageLefts,
  type Point,
  previewStyle,
  unscalePoint,
  wheelZoomFactor,
} from './pdfZoom';

describe('clampZoomScale', () => {
  it('rounds to whole percent and stays within the zoom range', () => {
    expect(clampZoomScale(1.234)).toBe(1.23);
    expect(clampZoomScale(0.1)).toBe(MIN_ZOOM_SCALE);
    expect(clampZoomScale(9)).toBe(MAX_ZOOM_SCALE);
    expect(clampZoomScale(Number.NaN)).toBe(1);
  });
});

describe('clampZoomRatio', () => {
  it('bounds the preview so base × ratio stays within the zoom range', () => {
    expect(clampZoomRatio(2, 3)).toBe(2);
    expect(clampZoomRatio(1, 0.1)).toBe(0.25);
    expect(clampZoomRatio(1, 1.5)).toBe(1.5);
  });

  it('treats a nonsensical ratio or base as no zoom', () => {
    expect(clampZoomRatio(1, 0)).toBe(1);
    expect(clampZoomRatio(1, Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoomRatio(0, 2)).toBe(1);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in for wheel up and out for wheel down, by inverse amounts', () => {
    const zoomIn = wheelZoomFactor(-5, 0, 600);
    const zoomOut = wheelZoomFactor(5, 0, 600);
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomOut).toBeLessThan(1);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 10);
  });

  it('caps a mouse-wheel notch, in pixels, lines, or pages, to the same step', () => {
    const notch = wheelZoomFactor(-100, 0, 600);
    expect(notch).toBeCloseTo(Math.exp(0.2), 10);
    expect(wheelZoomFactor(-3, 1, 600)).toBeCloseTo(notch, 10);
    expect(wheelZoomFactor(-1, 2, 600)).toBeCloseTo(notch, 10);
  });

  it('does not zoom without vertical travel', () => {
    expect(wheelZoomFactor(0, 0, 600)).toBe(1);
  });
});

describe('preview transform', () => {
  it('scales about the origin, and unscalePoint inverts it', () => {
    const origin = { x: 300, y: 1200 };
    const ratio = 1.6;
    const content = { x: 250, y: 1100 };
    // What a transform `scale(ratio)` about `origin` does to a point.
    const seen = {
      x: origin.x + (content.x - origin.x) * ratio,
      y: origin.y + (content.y - origin.y) * ratio,
    };
    const back = unscalePoint(seen, origin, ratio);
    expect(back.x).toBeCloseTo(content.x, 10);
    expect(back.y).toBeCloseTo(content.y, 10);
    // The origin itself does not move.
    expect(unscalePoint(origin, origin, ratio)).toEqual(origin);
  });

  it('writes the transform as CSS, and none at all for no zoom', () => {
    expect(previewStyle({ x: 10, y: 20.5 }, 2)).toEqual({
      transform: 'scale(2)',
      transformOrigin: '10px 20.5px',
    });
    expect(previewStyle({ x: 0, y: 0 }, 1).transform).toBe('');
  });
});

describe('locateInRow', () => {
  it('finds the fraction across a single page, clamped to its edges', () => {
    expect(locateInRow(112, 12, [400], 12)).toEqual({ slot: 0, fraction: 0.25 });
    expect(locateInRow(0, 12, [400], 12)).toEqual({ slot: 0, fraction: 0 });
    expect(locateInRow(900, 12, [400], 12)).toEqual({ slot: 0, fraction: 1 });
  });

  it('splits facing pages at the middle of the gap between them', () => {
    // Pages at 12–312 and 324–624.
    expect(pageLefts(12, [300, 300], 12)).toEqual([12, 324]);
    expect(locateInRow(162, 12, [300, 300], 12)).toEqual({ slot: 0, fraction: 0.5 });
    expect(locateInRow(317, 12, [300, 300], 12)).toEqual({ slot: 0, fraction: 1 });
    expect(locateInRow(318, 12, [300, 300], 12)).toEqual({ slot: 1, fraction: 0 });
    expect(locateInRow(474, 12, [300, 300], 12)).toEqual({ slot: 1, fraction: 0.5 });
  });

  it('handles pages of different widths in one spread', () => {
    const { slot, fraction } = locateInRow(12 + 200 + 12 + 50, 12, [200, 100], 12);
    expect(slot).toBe(1);
    expect(fraction).toBeCloseTo(0.5, 10);
  });

  it('has nothing to find in an empty row', () => {
    expect(locateInRow(50, 12, [], 12)).toEqual({ slot: 0, fraction: 0 });
  });
});

describe('anchoredScroll', () => {
  it('puts the content point under the pointer, never scrolling before the start', () => {
    expect(anchoredScroll({ x: 500, y: 2000 }, { x: 200, y: 300 })).toEqual({
      left: 300,
      top: 1700,
    });
    expect(anchoredScroll({ x: 100, y: 50 }, { x: 200, y: 300 })).toEqual({ left: 0, top: 0 });
  });
});

/**
 * A model of the viewer's layout, built from the same pieces: rows stacked with a
 * fixed gap, centred but never closer to the edge than the padding, and pages side
 * by side within a row. Sizes are in the displayed frame, so a rotated page is
 * just a page whose width and height swap.
 */
const GAP = 12;
const PADDING = 12;
const PANE = 900;

interface Layout {
  rows: (scale: number) => { pages: number[]; top: number; left: number; height: number }[];
  size: (pageIndex: number, scale: number) => { width: number; height: number };
}

const layoutOf = (
  pageSizes: readonly { width: number; height: number }[],
  rowsOfPages: readonly (readonly number[])[],
): Layout => {
  const size = (pageIndex: number, scale: number) => {
    const raw = pageSizes[pageIndex] ?? { width: 0, height: 0 };
    return { width: raw.width * scale, height: raw.height * scale };
  };
  return {
    size,
    rows: (scale) => {
      let top = 0;
      return rowsOfPages.map((pages) => {
        const widths = pages.map((p) => size(p, scale).width);
        const width = widths.reduce((sum, w) => sum + w, 0) + (pages.length - 1) * GAP;
        const height = Math.max(...pages.map((p) => size(p, scale).height));
        const row = { pages: [...pages], top, left: Math.max(PADDING, (PANE - width) / 2), height };
        top += height + GAP;
        return row;
      });
    },
  };
};

/** The page and fractions under a content point, as the viewer finds them. */
const pagePointAt = (layout: Layout, scale: number, point: Point) => {
  const rows = layout.rows(scale);
  const row =
    rows.find((candidate) => point.y < candidate.top + candidate.height + GAP) ?? rows.at(-1);
  if (!row) throw new Error('no rows');
  const widths = row.pages.map((p) => layout.size(p, scale).width);
  const { slot, fraction } = locateInRow(point.x, row.left, widths, GAP);
  const pageIndex = row.pages[slot] ?? 0;
  const fractionY = (point.y - row.top) / layout.size(pageIndex, scale).height;
  return { pageIndex, fractionX: fraction, fractionY };
};

/** Where that page point sits in the content at another scale. */
const contentPointOf = (
  layout: Layout,
  scale: number,
  at: { pageIndex: number; fractionX: number; fractionY: number },
): Point => {
  const row = layout.rows(scale).find((candidate) => candidate.pages.includes(at.pageIndex));
  if (!row) throw new Error('page not laid out');
  const widths = row.pages.map((p) => layout.size(p, scale).width);
  const left = pageLefts(row.left, widths, GAP)[row.pages.indexOf(at.pageIndex)] ?? 0;
  const size = layout.size(at.pageIndex, scale);
  return { x: left + at.fractionX * size.width, y: row.top + at.fractionY * size.height };
};

/**
 * A whole pinch: preview about `pointer`, release, re-lay out at the new scale, and
 * scroll. Returns the page point under the pointer before and after.
 */
const pinch = (
  layout: Layout,
  from: number,
  ratio: number,
  scroll: { left: number; top: number },
  pointer: Point,
) => {
  const origin = { x: scroll.left + pointer.x, y: scroll.top + pointer.y };
  const before = pagePointAt(layout, from, origin);
  // The hook clamps the ratio while previewing, so release sees the clamped one.
  const shown = clampZoomRatio(from, ratio);
  const to = clampZoomScale(from * shown);
  const under = pagePointAt(
    layout,
    from,
    unscalePoint({ x: scroll.left + pointer.x, y: scroll.top + pointer.y }, origin, shown),
  );
  const next = anchoredScroll(contentPointOf(layout, to, under), pointer);
  const after = pagePointAt(layout, to, { x: next.left + pointer.x, y: next.top + pointer.y });
  return { before, after, scale: to };
};

const LETTER = { width: 612, height: 792 };
const ROTATED = { width: 792, height: 612 };
const FIVE_PAGES = [LETTER, LETTER, { width: 306, height: 400 }, LETTER, LETTER];

describe('a pinch keeps the point under the pointer fixed', () => {
  const expectSamePoint = (result: ReturnType<typeof pinch>) => {
    expect(result.after.pageIndex).toBe(result.before.pageIndex);
    expect(result.after.fractionX).toBeCloseTo(result.before.fractionX, 6);
    expect(result.after.fractionY).toBeCloseTo(result.before.fractionY, 6);
  };

  it('in continuous pages of mixed sizes, zooming in and out', () => {
    const layout = layoutOf(
      FIVE_PAGES,
      FIVE_PAGES.map((_, index) => [index]),
    );
    expectSamePoint(pinch(layout, 1, 1.8, { left: 0, top: 1500 }, { x: 450, y: 300 }));
    expectSamePoint(pinch(layout, 2, 0.6, { left: 400, top: 4000 }, { x: 300, y: 200 }));
  });

  it('in single-page view', () => {
    const layout = layoutOf([LETTER], [[0]]);
    expectSamePoint(pinch(layout, 1.25, 2, { left: 0, top: 200 }, { x: 420, y: 350 }));
  });

  it('in two-page view with the cover alone, on either page of a spread', () => {
    const rows = Array.from({ length: spreadCount(FIVE_PAGES.length, true) }, (_, spread) =>
      pagesInSpread(spread, FIVE_PAGES.length, true),
    );
    expect(rows[0]).toEqual([0]);
    expect(rows[spreadOfPage(1, true)]).toEqual([1, 2]);
    const layout = layoutOf(FIVE_PAGES, rows);
    // At 120% pages 2–3 are wider than the pane, so the view can scroll sideways.
    const second = layout.rows(1.2)[1];
    if (!second) throw new Error('no second spread');
    const scroll = { left: 100, top: second.top - 50 };
    // Over the left page of pages 2–3, then over the right one.
    const left = pinch(layout, 1.2, 1.5, scroll, { x: 300, y: 200 });
    expect(left.before.pageIndex).toBe(1);
    expectSamePoint(left);
    const right = pinch(layout, 1.2, 1.5, scroll, { x: 750, y: 120 });
    expect(right.before.pageIndex).toBe(2);
    expectSamePoint(right);
  });

  it('with pages rotated 90, 180, and 270 degrees', () => {
    // 90 and 270 swap a page's displayed width and height; 180 keeps them.
    for (const size of [ROTATED, LETTER, ROTATED]) {
      const pages = [size, size, size];
      const layout = layoutOf(
        pages,
        pages.map((_, index) => [index]),
      );
      expectSamePoint(pinch(layout, 1, 1.4, { left: 0, top: 700 }, { x: 500, y: 250 }));
    }
  });

  it('when the pointer moved during the pinch, keeps the point it ends over', () => {
    const layout = layoutOf([LETTER, LETTER], [[0], [1]]);
    const scroll = { left: 200, top: 300 };
    const start = { x: 400, y: 200 };
    const end = { x: 450, y: 260 };
    const ratio = 1.5;
    const origin = { x: scroll.left + start.x, y: scroll.top + start.y };
    const under = pagePointAt(
      layout,
      2,
      unscalePoint({ x: scroll.left + end.x, y: scroll.top + end.y }, origin, ratio),
    );
    const next = anchoredScroll(contentPointOf(layout, 3, under), end);
    const after = pagePointAt(layout, 3, { x: next.left + end.x, y: next.top + end.y });
    expect(after.pageIndex).toBe(under.pageIndex);
    expect(after.fractionX).toBeCloseTo(under.fractionX, 6);
    expect(after.fractionY).toBeCloseTo(under.fractionY, 6);
  });

  it('keeps the height exact when a page centred in the pane cannot scroll sideways', () => {
    // At 100% and 120% a letter page fits the 900 px pane, so it stays centred.
    const layout = layoutOf([LETTER, LETTER], [[0], [1]]);
    const result = pinch(layout, 1, 1.2, { left: 0, top: 900 }, { x: 300, y: 300 });
    expect(result.after.pageIndex).toBe(result.before.pageIndex);
    expect(result.after.fractionY).toBeCloseTo(result.before.fractionY, 6);
    expect(result.after.fractionX).not.toBeCloseTo(result.before.fractionX, 2);
  });

  it('stops at the zoom limit, still anchored', () => {
    const layout = layoutOf([LETTER, LETTER], [[0], [1]]);
    const result = pinch(layout, 3, 5, { left: 600, top: 900 }, { x: 300, y: 300 });
    expect(result.scale).toBe(MAX_ZOOM_SCALE);
    expectSamePoint(result);
  });
});
