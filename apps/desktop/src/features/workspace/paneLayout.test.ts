import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSPECTOR_SIZE,
  DEFAULT_MIND_MAP_SIZE,
  MAX_INSPECTOR_SIZE,
  MAX_MIND_MAP_SIZE,
  MIN_READER_PERCENT,
  MIN_READER_PX,
  RESIZE_HANDLE_TOTAL_PX,
  clampInspectorSize,
  clampMindMapSize,
  computePanelLayout,
  effectiveMinReaderPercent,
} from './paneLayout';

describe('paneLayout (#180)', () => {
  it('computes a pixel-floored minimum reader percentage when container width is known', () => {
    expect(effectiveMinReaderPercent(0)).toBe(MIN_READER_PERCENT);
    expect(effectiveMinReaderPercent(undefined)).toBe(MIN_READER_PERCENT);

    const at960 = effectiveMinReaderPercent(960);
    expect((at960 / 100) * (960 - RESIZE_HANDLE_TOTAL_PX)).toBeGreaterThanOrEqual(MIN_READER_PX);
    // Leaves room for default MindMap (35%) + Inspector (20%) = 55%.
    expect(100 - at960).toBeGreaterThanOrEqual(DEFAULT_MIND_MAP_SIZE + DEFAULT_INSPECTOR_SIZE);

    const at1440 = effectiveMinReaderPercent(1440);
    expect((at1440 / 100) * (1440 - RESIZE_HANDLE_TOTAL_PX)).toBeGreaterThanOrEqual(MIN_READER_PX);
  });

  it('gives a hidden side pane width back to the reader without changing the sibling pane', () => {
    const base = {
      mindMapOpen: true,
      inspectorOpen: true,
      mindMapSize: 42,
      inspectorSize: 24,
    };
    const allOpen = computePanelLayout(base, false, 1440);
    expect(allOpen).toEqual({ reader: 34, mindmap: 42, inspector: 24 });

    const mindMapHidden = computePanelLayout({ ...base, mindMapOpen: false }, false, 1440);
    expect(mindMapHidden).toEqual({ reader: 76, mindmap: 0, inspector: 24 });
    expect(mindMapHidden.reader - allOpen.reader).toBeCloseTo(allOpen.mindmap, 1);

    const inspectorHidden = computePanelLayout({ ...base, inspectorOpen: false }, false, 1440);
    expect(inspectorHidden).toEqual({ reader: 58, mindmap: 42, inspector: 0 });
    expect(inspectorHidden.reader - allOpen.reader).toBeCloseTo(allOpen.inspector, 1);
  });

  it('clamps inflated persisted widths so stale saved layouts cannot squeeze the reader', () => {
    expect(clampMindMapSize(75)).toBe(MAX_MIND_MAP_SIZE);
    expect(clampMindMapSize(10)).toBe(DEFAULT_MIND_MAP_SIZE);
    expect(clampInspectorSize(55)).toBe(MAX_INSPECTOR_SIZE);
    expect(clampInspectorSize(5)).toBe(DEFAULT_INSPECTOR_SIZE);

    const at960 = computePanelLayout(
      {
        mindMapOpen: true,
        inspectorOpen: true,
        mindMapSize: 55,
        inspectorSize: 55,
      },
      false,
      960,
    );
    expect(at960.reader + at960.mindmap + at960.inspector).toBeCloseTo(100, 1);
    expect((at960.reader / 100) * (960 - RESIZE_HANDLE_TOTAL_PX)).toBeGreaterThanOrEqual(
      MIN_READER_PX,
    );
    expect(at960.mindmap).toBeGreaterThanOrEqual(DEFAULT_MIND_MAP_SIZE);
    expect(at960.inspector).toBeGreaterThanOrEqual(DEFAULT_INSPECTOR_SIZE);
  });

  it('collapses Inspector first when the container cannot fit all three panes above the reader floor', () => {
    // At 750px: reader needs >= 420px (~56.2%), leaving ~43.8% (< 35% + 20% = 55%).
    const narrowDefault = computePanelLayout(
      {
        mindMapOpen: true,
        inspectorOpen: true,
        mindMapSize: null,
        inspectorSize: null,
      },
      false,
      750,
    );
    expect(narrowDefault).toEqual({ reader: 65, mindmap: 35, inspector: 0 });

    // Explicitly opening Inspector in a narrow window keeps Inspector and collapses MindMap.
    const narrowKeepInspector = computePanelLayout(
      {
        mindMapOpen: true,
        inspectorOpen: true,
        mindMapSize: null,
        inspectorSize: null,
      },
      false,
      750,
      'inspector',
    );
    expect(narrowKeepInspector).toEqual({ reader: 80, mindmap: 0, inspector: 20 });

    // Too narrow for even one side pane: reader takes 100%.
    const veryNarrow = computePanelLayout(
      {
        mindMapOpen: true,
        inspectorOpen: true,
        mindMapSize: null,
        inspectorSize: null,
      },
      false,
      500,
    );
    expect(veryNarrow).toEqual({ reader: 100, mindmap: 0, inspector: 0 });
  });

  it('collapses both side panes in focus mode', () => {
    expect(
      computePanelLayout(
        {
          mindMapOpen: true,
          inspectorOpen: true,
          mindMapSize: 45,
          inspectorSize: 25,
        },
        true,
        1440,
      ),
    ).toEqual({ reader: 100, mindmap: 0, inspector: 0 });
  });
});
