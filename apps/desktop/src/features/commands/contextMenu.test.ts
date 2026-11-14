import { afterEach, describe, expect, it } from 'vitest';

import {
  keepsNativeContextMenu,
  suppressDefaultContextMenu,
} from '@/features/commands/contextMenu';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = '';
});

/** Dispatches a right click at `target`, and reports whether the webview would open its menu. */
function rightClick(target: EventTarget): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
}

describe('the webview context menu', () => {
  it('stays out of the reader and the app chrome', () => {
    cleanups.push(suppressDefaultContextMenu());
    document.body.innerHTML = `<div id="page"><p id="text">A paragraph</p></div>`;
    expect(rightClick(document.getElementById('text') ?? document.body)).toBe(false);
    expect(rightClick(document.body)).toBe(false);
    expect(rightClick(window)).toBe(false);
  });

  it('keeps the text field menu, where Cut, Copy, Paste, and spelling are', () => {
    cleanups.push(suppressDefaultContextMenu());
    document.body.innerHTML = `
      <input id="note" />
      <textarea id="area"></textarea>
      <div contenteditable="true" id="rich"></div>
      <div role="textbox" id="role"></div>
      <div id="page"></div>`;
    for (const id of ['note', 'area', 'rich', 'role']) {
      const target = document.getElementById(id);
      if (!target) throw new Error(`missing #${id}`);
      expect(rightClick(target), id).toBe(true);
    }
    expect(rightClick(document.getElementById('page') ?? document.body)).toBe(false);
  });

  it('stops listening once the guard is removed', () => {
    const stop = suppressDefaultContextMenu();
    stop();
    document.body.innerHTML = `<div id="page"></div>`;
    expect(rightClick(document.getElementById('page') ?? document.body)).toBe(true);
  });

  it('names a text field as the one place the native menu belongs', () => {
    document.body.innerHTML = `<input id="note" /><div id="page"></div>`;
    expect(keepsNativeContextMenu(document.getElementById('note'))).toBe(true);
    expect(keepsNativeContextMenu(document.getElementById('page'))).toBe(false);
    expect(keepsNativeContextMenu(null)).toBe(false);
  });
});
