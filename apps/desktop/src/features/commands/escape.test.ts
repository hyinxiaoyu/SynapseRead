import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchEscape, ESCAPE_LAYER, type EscapeHandler, registerEscapeLayer } from './escape';

const escape = (init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });

describe('the Esc order', () => {
  const stops: (() => void)[] = [];
  const layer = (priority: number, handler: EscapeHandler | null) => {
    stops.push(registerEscapeLayer(priority, () => handler));
  };
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it('closes the note, then the popover, then Find, then focus mode', () => {
    const closed: string[] = [];
    const open = new Set(['note', 'popover', 'find', 'focus']);
    const closing = (name: string) => () => {
      if (!open.has(name)) return false;
      open.delete(name);
      closed.push(name);
      return true;
    };
    // Registered out of order: priority decides, not mount order.
    layer(ESCAPE_LAYER.focusMode, closing('focus'));
    layer(ESCAPE_LAYER.find, closing('find'));
    layer(ESCAPE_LAYER.noteField, closing('note'));
    layer(ESCAPE_LAYER.selectionPopover, closing('popover'));

    for (let press = 0; press < 5; press += 1) dispatchEscape(escape());
    expect(closed).toEqual(['note', 'popover', 'find', 'focus']);
  });

  it('skips a closed layer and one that declines the key', () => {
    const focus = vi.fn(() => true);
    layer(ESCAPE_LAYER.selectionPopover, null);
    layer(ESCAPE_LAYER.find, () => false);
    layer(ESCAPE_LAYER.focusMode, focus);

    const event = escape();
    expect(dispatchEscape(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a key something else already handled, and modified Esc', () => {
    const focus = vi.fn(() => true);
    layer(ESCAPE_LAYER.focusMode, focus);

    const handled = escape();
    handled.preventDefault();
    expect(dispatchEscape(handled)).toBe(false);
    expect(dispatchEscape(escape({ metaKey: true }))).toBe(false);
    expect(dispatchEscape(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('answers Esc pressed in the window', () => {
    const focus = vi.fn(() => true);
    layer(ESCAPE_LAYER.focusMode, focus);
    window.dispatchEvent(escape());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('forgets a layer once it unregisters', () => {
    const focus = vi.fn(() => true);
    const stop = registerEscapeLayer(ESCAPE_LAYER.focusMode, () => focus);
    stop();
    expect(dispatchEscape(escape())).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
