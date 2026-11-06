import { describe, expect, it } from 'vitest';

import { annotationAtPoint, markViewportRect, placePopover } from './geometry';

const bounds = { top: 100, left: 0, bottom: 700, right: 800 };
const size = { width: 200, height: 40 };

describe('placePopover', () => {
  it('centers above the target when there is room', () => {
    expect(placePopover({ top: 300, left: 300, bottom: 320, right: 500 }, size, bounds)).toEqual({
      top: 252,
      left: 300,
      placement: 'above',
    });
  });

  it('goes below a target at the top of the reader, never over the toolbar', () => {
    const placed = placePopover({ top: 110, left: 300, bottom: 130, right: 500 }, size, bounds);
    expect(placed).toEqual({ top: 138, left: 300, placement: 'below' });
  });

  it('stays inside the reader at its edges', () => {
    expect(placePopover({ top: 300, left: 0, bottom: 320, right: 20 }, size, bounds).left).toBe(8);
    expect(placePopover({ top: 300, left: 780, bottom: 320, right: 800 }, size, bounds).left).toBe(
      592,
    );
  });

  it('sits at the top of the reader with nothing to point at', () => {
    expect(placePopover(null, size, bounds)).toEqual({ top: 116, left: 300, placement: 'below' });
  });
});

function mark(id: string, box: { left: number; top: number; width: number; height: number }) {
  const element = document.createElement('div');
  element.dataset.annotationId = id;
  element.getBoundingClientRect = () =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    }) as DOMRect;
  return element;
}

describe('annotationAtPoint', () => {
  it('finds a mark that lets clicks through by its box, and skips search marks', () => {
    const page = document.createElement('div');
    const text = document.createElement('span');
    page.append(
      mark('__search_active__', { left: 0, top: 0, width: 100, height: 20 }),
      mark('a', { left: 0, top: 0, width: 100, height: 20 }),
      mark('a', { left: 0, top: 20, width: 50, height: 20 }),
      text,
    );
    expect(annotationAtPoint({ target: text, clientX: 10, clientY: 10 }, page)).toEqual({
      annotationId: 'a',
      rect: { top: 0, left: 0, bottom: 40, right: 100 },
    });
    expect(annotationAtPoint({ target: text, clientX: 300, clientY: 10 }, page)).toBeNull();
  });

  it('prefers the clicked mark itself', () => {
    const page = document.createElement('div');
    const clicked = mark('b', { left: 0, top: 0, width: 0, height: 0 });
    page.append(clicked);
    expect(annotationAtPoint({ target: clicked, clientX: 0, clientY: 0 }, page)?.annotationId).toBe(
      'b',
    );
    expect(markViewportRect([clicked], 'b')).toBeNull();
  });
});
