import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { colorForDigit, dispatchColorShortcut, useColorShortcut } from './colorShortcut';
import { ANNOTATION_COLORS } from './palette';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('color shortcut', () => {
  it('maps 1–5 to the palette, and nothing else to a color', () => {
    expect(colorForDigit('1')).toBe(ANNOTATION_COLORS[0].value);
    expect(colorForDigit('3')).toBe(ANNOTATION_COLORS[2].value);
    expect(colorForDigit('5')).toBe(ANNOTATION_COLORS[4].value);
    for (const key of ['0', '6', 'a', 'F1', '']) expect(colorForDigit(key)).toBeNull();
  });

  it('picks a color while the popover is open, and stops once it closes', () => {
    const pick = vi.fn();
    const popover = renderHook(() => useColorShortcut(pick));

    // A caller forwarding a chapter iframe's key (EPUB) goes through this itself.
    const frameKey = new KeyboardEvent('keydown', { key: '2', cancelable: true });
    expect(dispatchColorShortcut(frameKey)).toBe(true);
    expect(pick).toHaveBeenCalledWith('#86efac');

    popover.rerender();
    popover.unmount();
    expect(dispatchColorShortcut(new KeyboardEvent('keydown', { key: '2' }))).toBe(false);
  });

  it('leaves modified keys to commands and digits typed into fields to the field', () => {
    const pick = vi.fn();
    renderHook(() => useColorShortcut(pick));

    for (const init of [
      { key: '1', metaKey: true },
      { key: '1', ctrlKey: true },
      { key: '1', altKey: true },
      { key: '1', shiftKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
      expect(dispatchColorShortcut(event)).toBe(false);
    }

    document.body.innerHTML = '<textarea id="note"></textarea>';
    const field = document.getElementById('note') as HTMLTextAreaElement;
    field.focus();
    // Not handled: the field keeps its digit and the event is not consumed.
    expect(fireEvent.keyDown(field, { key: '1' })).toBe(true);
    expect(pick).not.toHaveBeenCalled();

    // A digit on the page itself is handled, wherever focus is.
    expect(fireEvent.keyDown(document.body, { key: '1' })).toBe(false);
    expect(pick).toHaveBeenCalledWith(ANNOTATION_COLORS[0].value);
  });
});
