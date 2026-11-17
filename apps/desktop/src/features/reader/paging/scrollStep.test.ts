import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeScrollPageStep, type ScrollLineRect, type ScrollViewport } from './scrollStep';

function makeViewport({
  scrollTop = 0,
  clientHeight = 600,
  scrollHeight = 2400,
  top = 0,
}: {
  scrollTop?: number;
  clientHeight?: number;
  scrollHeight?: number;
  top?: number;
} = {}): ScrollViewport {
  return {
    scrollTop,
    clientHeight,
    scrollHeight,
    ownerDocument: document,
    getBoundingClientRect: () => ({ top, bottom: top + clientHeight }),
  };
}

describe('computeScrollPageStep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('returns null at document boundaries and when viewport cannot scroll', () => {
    expect(computeScrollPageStep({ scroller: null, direction: 1 })).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ clientHeight: 0, scrollHeight: 1000 }),
        direction: 1,
      }),
    ).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ clientHeight: 600, scrollHeight: 601 }),
        direction: 1,
      }),
    ).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 0 }),
        direction: -1,
      }),
    ).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1 }),
        direction: -1,
      }),
    ).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1799, clientHeight: 600, scrollHeight: 2400 }),
        direction: 1,
      }),
    ).toBeNull();
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1800, clientHeight: 600, scrollHeight: 2400 }),
        direction: 1,
      }),
    ).toBeNull();
  });

  it('advances forward to show a bottom-straddling line wholly near the top with contextPad', () => {
    const lineRects: ScrollLineRect[] = [
      { top: 550, bottom: 574 },
      { top: 588, bottom: 612 }, // straddles H - 1 = 599
      { top: 592, bottom: 616 }, // lower straddling fragment (e.g. second column)
    ];

    const nextTop = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 300, clientHeight: 600, scrollHeight: 3000 }),
      direction: 1,
      lineRects,
      lineHeightPx: 24,
    });

    // Topmost straddling line at 588 moves to y = 24 (contextPad = min(24, 24) = 24).
    // Step = 588 - 24 = 564, nextTop = 300 + 564 = 864.
    expect(nextTop).toBe(864);
  });

  it('respects smaller and capped lineHeightPx values for contextPad', () => {
    const lineRects: ScrollLineRect[] = [{ top: 580, bottom: 596 }];

    // lineHeightPx = 16 -> contextPad = 16, step = 580 - 16 = 564
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 0, clientHeight: 600, scrollHeight: 2000 }),
        direction: 1,
        lineRects,
        lineHeightPx: 16,
      }),
    ).toBe(564);

    // lineHeightPx = 40 -> contextPad capped at 24, step = 580 - 24 = 556
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 0, clientHeight: 600, scrollHeight: 2000 }),
        direction: 1,
        lineRects: [{ top: 580, bottom: 620 }],
        lineHeightPx: 40,
      }),
    ).toBe(556);
  });

  it('uses the bottom-most wholly visible line within fallbackOverlap when none straddles forward', () => {
    const lineRects: ScrollLineRect[] = [
      { top: 500, bottom: 524 },
      { top: 540, bottom: 564 },
      { top: 570, bottom: 594 }, // wholly visible within 72px of 600
      { top: 605, bottom: 629 }, // entirely below viewport
    ];

    const nextTop = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 100, clientHeight: 600, scrollHeight: 2400 }),
      direction: 1,
      lineRects,
      lineHeightPx: 24,
    });

    // Line at 570..594 moves to 24..48 -> step = 570 - 24 = 546, nextTop = 646.
    expect(nextTop).toBe(646);
  });

  it('steps backward to keep a top-straddling line wholly near the bottom with contextPad', () => {
    const lineRects: ScrollLineRect[] = [
      { top: -18, bottom: 6 },
      { top: -10, bottom: 14 }, // bottom-most straddling top = 1
      { top: 20, bottom: 44 },
    ];

    const nextTop = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 1000, clientHeight: 600, scrollHeight: 3000 }),
      direction: -1,
      lineRects,
      lineHeightPx: 24,
    });

    // Bottom-most straddling line bottom = 14 moves to 600 - 24 = 576 -> step = 600 - (14 + 24) = 562.
    expect(nextTop).toBe(1000 - 562);
  });

  it('uses the topmost wholly visible line within fallbackOverlap when none straddles backward', () => {
    const lineRects: ScrollLineRect[] = [
      { top: -30, bottom: -6 }, // entirely above viewport
      { top: 12, bottom: 36 }, // topmost wholly visible within 72px of 0
      { top: 44, bottom: 68 },
    ];

    const nextTop = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 1000, clientHeight: 600, scrollHeight: 3000 }),
      direction: -1,
      lineRects,
      lineHeightPx: 24,
    });

    // Line bottom 36 moves to 600 - 24 = 576 -> step = 600 - (36 + 24) = 540.
    expect(nextTop).toBe(1000 - 540);
  });

  it('caps maximum step at H - minOverlap so edge lines never cause skipped gaps', () => {
    // Line sits right against the bottom edge with tiny line height (10px -> minOverlap = 16px).
    // Candidate step would be 597 - 10 = 587 > 600 - 16 = 584.
    const nextFwd = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 0, clientHeight: 600, scrollHeight: 2000 }),
      direction: 1,
      lineRects: [{ top: 597, bottom: 607 }],
      lineHeightPx: 10,
    });
    expect(nextFwd).toBe(584);

    // Symmetrically backward: line barely peeks 3px into top with tiny line height (10px -> minOverlap = 16px).
    // Candidate step would be 600 - (3 + 10) = 587 > 584.
    const nextBwd = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 1000, clientHeight: 600, scrollHeight: 2000 }),
      direction: -1,
      lineRects: [{ top: -7, bottom: 3 }],
      lineHeightPx: 10,
    });
    expect(nextBwd).toBe(1000 - 584);
  });

  it('guarantees minStep progress via fallbackStep on tall images or oversized blocks', () => {
    const H = 600;
    // Tall block starting near top and straddling bottom: candidateStep = 40 - 24 = 16 < minStep (150).
    const nextFwd = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 200, clientHeight: H, scrollHeight: 3000 }),
      direction: 1,
      lineRects: [{ top: 40, bottom: 720 }],
      lineHeightPx: 24,
    });
    // fallbackOverlap = max(72, 36, 32) = 72 -> fallbackStep = 528.
    expect(nextFwd).toBe(200 + 528);

    // Backward tall block straddling top and filling almost the whole viewport.
    const nextBwd = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 1000, clientHeight: H, scrollHeight: 3000 }),
      direction: -1,
      lineRects: [{ top: -120, bottom: 540 }],
      lineHeightPx: 24,
    });
    expect(nextBwd).toBe(1000 - 528);

    // Prefers a normal straddling text line when an oversized float sits alongside it.
    const withNormalLine = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 0, clientHeight: H, scrollHeight: 3000 }),
      direction: 1,
      lineRects: [
        { top: 20, bottom: 680 },
        { top: 586, bottom: 610 },
      ],
      lineHeightPx: 24,
    });
    expect(withNormalLine).toBe(586 - 24);
  });

  it('uses calibrated fallbackStep when no line rects exist (e.g. scanned PDF)', () => {
    // H = 800, lineHeight = 24 -> fallbackOverlap = max(96, 36, 32) = 96 -> fallbackStep = 704.
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 100, clientHeight: 800, scrollHeight: 4000 }),
        direction: 1,
        lineRects: [],
      }),
    ).toBe(100 + 704);

    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1000, clientHeight: 800, scrollHeight: 4000 }),
        direction: -1,
        lineRects: [],
      }),
    ).toBe(1000 - 704);

    // Without contentRoot or lineRects, falls back cleanly as well.
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 0, clientHeight: 500, scrollHeight: 2000 }),
        direction: 1,
      }),
    ).toBe(440); // fallbackOverlap = round(500 * 0.12) = 60 -> 500 - 60 = 440
  });

  it('handles tiny viewports without stalling or exceeding viewport bounds', () => {
    // H = 40: minStep = 20, contextPad = 6, minOverlap = 10, maxStep = 30, fallbackOverlap = 14, fallbackStep = 26.
    const nextSmall = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 0, clientHeight: 40, scrollHeight: 400 }),
      direction: 1,
      lineRects: [{ top: 30, bottom: 50 }],
      lineHeightPx: 20,
    });
    // candidateStep = 30 - 6 = 24 (within [20, 30]).
    expect(nextSmall).toBe(24);

    // Very tiny H = 20 with empty rects still moves forward cleanly.
    const nextTiny = computeScrollPageStep({
      scroller: makeViewport({ scrollTop: 0, clientHeight: 20, scrollHeight: 200 }),
      direction: 1,
      lineRects: [],
    });
    expect(nextTiny).toBeGreaterThanOrEqual(10);
    expect(nextTiny).toBeLessThanOrEqual(20);
  });

  it('snaps to maxScrollTop and 0 when within 2px of a boundary', () => {
    // maxScrollTop = 1000 - 600 = 400. With scrollTop = 0 and line at top = 422, contextPad = 24 -> step = 398.
    // maxScrollTop - 398 = 2 <= 2 -> snaps to 400.
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 0, clientHeight: 600, scrollHeight: 1000 }),
        direction: 1,
        lineRects: [{ top: 422, bottom: 446 }],
        lineHeightPx: 24,
      }),
    ).toBe(400);

    // Backward: scrollTop = 530, empty rects -> fallbackStep = 528 -> nextTop = 2 <= 2 -> snaps to 0.
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 530, clientHeight: 600, scrollHeight: 2000 }),
        direction: -1,
        lineRects: [],
      }),
    ).toBe(0);
  });

  it('inspects normal DOM text nodes (TXT), ignoring whitespace and hidden nodes', () => {
    const scroller = document.createElement('div');
    const contentRoot = document.createElement('div');
    const row1 = document.createElement('div');
    row1.textContent = 'First line';
    const hidden = document.createElement('div');
    hidden.setAttribute('hidden', '');
    hidden.textContent = 'Hidden text';
    const styleEl = document.createElement('style');
    styleEl.textContent = 'body { color: red; }';
    const whitespace = document.createTextNode('   \n  ');
    const row2 = document.createElement('div');
    row2.textContent = 'Straddling line';
    contentRoot.append(row1, hidden, styleEl, whitespace, row2);
    scroller.append(contentRoot);
    document.body.append(scroller);

    Object.defineProperty(scroller, 'scrollTop', { value: 200, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 800, 600));

    Range.prototype.getClientRects = function (this: Range) {
      const text = this.startContainer.nodeValue ?? '';
      if (text === 'First line') {
        return [new DOMRect(40, 50 + 100, 300, 24)] as unknown as DOMRectList;
      }
      if (text === 'Straddling line') {
        return [new DOMRect(40, 50 + 586, 300, 24)] as unknown as DOMRectList;
      }
      if (text === 'Hidden text' || text.includes('color: red')) {
        return [new DOMRect(40, 50 + 500, 300, 24)] as unknown as DOMRectList;
      }
      return [] as unknown as DOMRectList;
    };

    const nextTop = computeScrollPageStep({
      scroller,
      contentRoot,
      direction: 1,
    });
    // Straddling line is at viewport y = 586, median line height = 24 -> 200 + (586 - 24) = 762.
    expect(nextTop).toBe(762);
  });

  it('uses fallbackStep when clean lines lie outside fallbackOverlap or getComputedStyle provides lineHeight', () => {
    const scroller = document.createElement('div');
    const contentRoot = document.createElement('div');
    contentRoot.style.lineHeight = '20px';
    scroller.append(contentRoot);
    document.body.append(scroller);

    Object.defineProperty(scroller, 'scrollTop', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 3000, configurable: true });

    // Clean lines sit far from both edges (outside fallbackOverlap = 72px), so fallbackStep (528) applies.
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1000, clientHeight: 600, scrollHeight: 3000 }),
        direction: 1,
        lineRects: [{ top: 200, bottom: 224 }],
        lineHeightPx: 24,
      }),
    ).toBe(1528);
    expect(
      computeScrollPageStep({
        scroller: makeViewport({ scrollTop: 1000, clientHeight: 600, scrollHeight: 3000 }),
        direction: -1,
        lineRects: [{ top: 200, bottom: 224 }],
        lineHeightPx: 24,
      }),
    ).toBe(472);

    // No text nodes, lineHeight resolved from getComputedStyle(contentRoot) = 20px.
    // fallbackOverlap = max(round(600*0.12)=72, 30, 32) = 72 -> 1000 + 528 = 1528.
    expect(
      computeScrollPageStep({
        scroller,
        contentRoot,
        direction: 1,
      }),
    ).toBe(1528);
  });

  it('discovers child iframes when a container element is passed as contentRoot', () => {
    const scroller = document.createElement('div');
    const iframe = document.createElement('iframe');
    scroller.append(iframe);
    document.body.append(scroller);

    const chapterDoc = document.implementation.createHTMLDocument('chapter');
    const paragraph = chapterDoc.createElement('p');
    paragraph.textContent = 'Nested iframe text';
    chapterDoc.body.append(paragraph);

    const fakeView = { frameElement: iframe } as unknown as Window;
    Object.defineProperty(chapterDoc, 'defaultView', { value: fakeView, configurable: true });
    Object.defineProperty(iframe, 'contentDocument', { value: chapterDoc, configurable: true });

    Object.defineProperty(scroller, 'scrollTop', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -500, 800, 2400));

    const origCreateRange = chapterDoc.createRange.bind(chapterDoc);
    vi.spyOn(chapterDoc, 'createRange').mockImplementation(() => {
      const range = origCreateRange();
      // 480 + (-500) = -20 -> straddles viewport top=1 with bottom = 4.
      range.getClientRects = () => [new DOMRect(20, 480, 300, 24)] as unknown as DOMRectList;
      return range;
    });

    const nextTop = computeScrollPageStep({
      scroller,
      contentRoot: scroller,
      direction: -1,
    });
    // Bottom at viewport y = 4, contextPad = 24 -> step = 600 - (4 + 24) = 572 -> 500 - 572 = 0 (clamped/snapped).
    expect(nextTop).toBe(0);
  });

  it('inspects cross-iframe contentDocument body safely without cross-realm instanceof', () => {
    const scroller = document.createElement('div');
    const iframe = document.createElement('iframe');
    scroller.append(iframe);
    document.body.append(scroller);

    // Construct a distinct Document instance (cross-realm style) attached to a fake frameElement view.
    const chapterDoc = document.implementation.createHTMLDocument('chapter');
    const paragraph = chapterDoc.createElement('p');
    const text = chapterDoc.createTextNode('Cross-frame straddling text');
    paragraph.append(text);
    chapterDoc.body.append(paragraph);

    const fakeView = { frameElement: iframe } as unknown as Window;
    Object.defineProperty(chapterDoc, 'defaultView', { value: fakeView, configurable: true });

    Object.defineProperty(scroller, 'scrollTop', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 800, 600));
    // Iframe scrolled 400px up inside scroller: frame top in outer doc is 80 - 400 = -320.
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -320, 800, 2400));

    const origCreateRange = chapterDoc.createRange.bind(chapterDoc);
    vi.spyOn(chapterDoc, 'createRange').mockImplementation(() => {
      const range = origCreateRange();
      // Line sits at y = 986 inside chapterDoc -> 986 + (-320) - 80 = 586 in scroller viewport.
      range.getClientRects = () => [new DOMRect(20, 986, 300, 24)] as unknown as DOMRectList;
      return range;
    });

    const nextTop = computeScrollPageStep({
      scroller,
      contentRoot: chapterDoc.body,
      direction: 1,
    });
    expect(nextTop).toBe(400 + 586 - 24);
  });

  it('inspects PDF .textLayer spans and skips .endOfContent and .sr-only', () => {
    const scroller = document.createElement('div');
    const contentRoot = document.createElement('div');
    const srOnly = document.createElement('span');
    srOnly.className = 'sr-only';
    srOnly.textContent = 'Screen reader note';

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const span1 = document.createElement('span');
    span1.textContent = 'PDF line one';
    const span2 = document.createElement('span');
    span2.textContent = 'PDF straddling top';
    const endOfContent = document.createElement('div');
    endOfContent.className = 'endOfContent';
    endOfContent.textContent = 'ignored';
    textLayer.append(span1, span2, endOfContent);
    contentRoot.append(srOnly, textLayer);
    scroller.append(contentRoot);
    document.body.append(scroller);

    Object.defineProperty(scroller, 'scrollTop', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 3000, configurable: true });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 800, 600));

    // Simulate JSDOM where Range.prototype.getClientRects is absent and spans report bounding rects.
    const originalGetClientRects = Range.prototype.getClientRects;
    // @ts-expect-error test absence of Range.prototype.getClientRects
    delete Range.prototype.getClientRects;
    try {
      vi.spyOn(srOnly, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40 - 2, 10, 10));
      vi.spyOn(span1, 'getBoundingClientRect').mockReturnValue(new DOMRect(60, 40 + 40, 200, 20));
      vi.spyOn(span2, 'getBoundingClientRect').mockReturnValue(new DOMRect(60, 40 - 8, 200, 20));
      vi.spyOn(endOfContent, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 40 + 5, 800, 20),
      );

      const nextTop = computeScrollPageStep({
        scroller,
        contentRoot,
        direction: -1,
      });
      // span2 viewport rect: top = -8, bottom = 12, height = 20 -> contextPad = 20.
      // step = 600 - (12 + 20) = 568 -> nextTop = 1000 - 568 = 432.
      expect(nextTop).toBe(432);
    } finally {
      Range.prototype.getClientRects = originalGetClientRects;
    }
  });

  it('never skips any line when stepping sequentially forward and backward through prose', () => {
    const lineHeight = 24;
    const lineGap = 6;
    const totalLines = 120;
    const docLines = Array.from({ length: totalLines }, (_, index) => {
      const top = 20 + index * (lineHeight + lineGap);
      return { top, bottom: top + lineHeight };
    });
    const scrollHeight = (docLines.at(-1)?.bottom ?? 0) + 40;
    const clientHeight = 600;

    let scrollTop = 0;
    const seenForward = new Set<number>();
    const markVisible = (top: number) => {
      docLines.forEach((line, index) => {
        if (line.top >= top - 0.5 && line.bottom <= top + clientHeight + 0.5) {
          seenForward.add(index);
        }
      });
    };

    markVisible(scrollTop);
    for (let step = 0; step < 30; step += 1) {
      const visibleRects = docLines
        .map((line) => ({ top: line.top - scrollTop, bottom: line.bottom - scrollTop }))
        .filter((rect) => rect.bottom > -40 && rect.top < clientHeight + 40);
      const next = computeScrollPageStep({
        scroller: makeViewport({ scrollTop, clientHeight, scrollHeight }),
        direction: 1,
        lineRects: visibleRects,
        lineHeightPx: lineHeight,
      });
      if (next === null) break;
      expect(next).toBeGreaterThan(scrollTop);
      scrollTop = next;
      markVisible(scrollTop);
    }
    expect(scrollTop).toBe(scrollHeight - clientHeight);
    expect(seenForward.size).toBe(totalLines);

    const seenBackward = new Set<number>();
    const markVisibleBack = (top: number) => {
      docLines.forEach((line, index) => {
        if (line.top >= top - 0.5 && line.bottom <= top + clientHeight + 0.5) {
          seenBackward.add(index);
        }
      });
    };
    markVisibleBack(scrollTop);
    for (let step = 0; step < 30; step += 1) {
      const visibleRects = docLines
        .map((line) => ({ top: line.top - scrollTop, bottom: line.bottom - scrollTop }))
        .filter((rect) => rect.bottom > -40 && rect.top < clientHeight + 40);
      const next = computeScrollPageStep({
        scroller: makeViewport({ scrollTop, clientHeight, scrollHeight }),
        direction: -1,
        lineRects: visibleRects,
        lineHeightPx: lineHeight,
      });
      if (next === null) break;
      expect(next).toBeLessThan(scrollTop);
      scrollTop = next;
      markVisibleBack(scrollTop);
    }
    expect(scrollTop).toBe(0);
    expect(seenBackward.size).toBe(totalLines);
  });
});
