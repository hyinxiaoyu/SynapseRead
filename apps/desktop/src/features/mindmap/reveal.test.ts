import { describe, expect, it } from 'vitest';

import { REVEAL_MARGIN, viewportRevealing } from './reveal';

const pane = { width: 800, height: 600 };
const card = { width: 240, height: 96 };

describe('viewportRevealing', () => {
  it('leaves a card that is fully in view where it is', () => {
    expect(viewportRevealing({ x: 100, y: 100, ...card }, { x: 0, y: 0, zoom: 1 }, pane)).toBe(
      null,
    );
  });

  it('centers a card that is off-screen, keeping the zoom', () => {
    const next = viewportRevealing({ x: 2000, y: 1500, ...card }, { x: 0, y: 0, zoom: 0.5 }, pane);
    expect(next).toEqual({ x: 400 - 2120 * 0.5, y: 300 - 1548 * 0.5, zoom: 0.5 });
  });

  it('treats a card cut off by the edge, or inside the margin, as not in view', () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    // Half past the right edge.
    expect(viewportRevealing({ x: 700, y: 100, ...card }, viewport, pane)).not.toBeNull();
    // Touching the top edge, within the margin.
    expect(viewportRevealing({ x: 100, y: REVEAL_MARGIN - 1, ...card }, viewport, pane)).not.toBe(
      null,
    );
  });

  it('accounts for the pan', () => {
    // On-screen at the origin, but the canvas has been panned away from it.
    expect(
      viewportRevealing({ x: 40, y: 40, ...card }, { x: -1000, y: 0, zoom: 1 }, pane),
    ).not.toBeNull();
  });
});
