import { describe, expect, it } from 'vitest';

import { availableReadout, nextReadout } from './useFooterReadout';

describe('footer readouts', () => {
  const all = { remaining: '3 pages left in chapter', position: 'Page 2 of 4', percent: '40%' };
  const plain = { position: 'Line 3 of 90', percent: '4%' };

  it('cycles through the readouts a document offers', () => {
    expect(nextReadout('remaining', all)).toBe('position');
    expect(nextReadout('percent', all)).toBe('remaining');
    expect(nextReadout('percent', plain)).toBe('position');
    expect(nextReadout('percent', { percent: '1%' })).toBe('percent');
  });

  it('offers minutes left only where a reader measured the chapter', () => {
    const measured = { ...all, minutes: 'About 4 minutes left in chapter' };
    expect(nextReadout('remaining', measured)).toBe('minutes');
    expect(nextReadout('minutes', measured)).toBe('position');
    expect(nextReadout('remaining', all)).toBe('position');
    expect(availableReadout('minutes', all)).toBe('position');
  });

  it('falls back to the next available readout without forgetting the choice', () => {
    expect(availableReadout('remaining', plain)).toBe('position');
    expect(availableReadout('percent', plain)).toBe('percent');
    expect(availableReadout('remaining', {})).toBeNull();
  });
});
