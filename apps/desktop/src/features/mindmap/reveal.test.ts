import { describe, expect, it } from 'vitest';

import { MIN_REVEAL_ZOOM, REVEAL_MARGIN, viewportRevealing } from './reveal';

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

  it('keeps high zoom when the card still fits inside the margin', () => {
    const zoom = 2;
    const next = viewportRevealing({ x: 2000, y: 1500, ...card }, { x: 0, y: 0, zoom }, pane);
    expect(next).toEqual({
      x: pane.width / 2 - (2000 + card.width / 2) * zoom,
      y: pane.height / 2 - (1500 + card.height / 2) * zoom,
      zoom,
    });
  });

  it('zooms out just enough when a zoomed card is wider or taller than the pane', () => {
    const narrowPane = { width: 384, height: 700 };
    const next = viewportRevealing(
      { x: 40, y: 40, ...card },
      { x: 0, y: 0, zoom: 2.0736 },
      narrowPane,
    );
    expect(next).not.toBeNull();
    const revealed = next!;
    const expectedZoom = (narrowPane.width - REVEAL_MARGIN * 2) / card.width;
    expect(revealed.zoom).toBeCloseTo(expectedZoom);
    expect(40 * revealed.zoom + revealed.x).toBeCloseTo(REVEAL_MARGIN);
    expect((40 + card.width) * revealed.zoom + revealed.x).toBeCloseTo(
      narrowPane.width - REVEAL_MARGIN,
    );

    const shortPane = { width: 800, height: 180 };
    const tallCard = { x: 40, y: 40, width: 240, height: 240 };
    const shortNext = viewportRevealing(tallCard, { x: 0, y: 0, zoom: 1.5 }, shortPane)!;
    const expectedHeightZoom = (shortPane.height - REVEAL_MARGIN * 2) / tallCard.height;
    expect(shortNext.zoom).toBeCloseTo(expectedHeightZoom);
  });

  it('never drops below MIN_REVEAL_ZOOM or zooms in when clamping', () => {
    const tinyPane = { width: 80, height: 80 };
    const hugeCard = { x: 0, y: 0, width: 1000, height: 1000 };
    const next = viewportRevealing(hugeCard, { x: -500, y: 0, zoom: 1 }, tinyPane)!;
    expect(next.zoom).toBe(MIN_REVEAL_ZOOM);

    const alreadyMin = viewportRevealing(hugeCard, { x: -500, y: 0, zoom: 0.05 }, tinyPane)!;
    expect(alreadyMin.zoom).toBe(0.05);
  });
});
