import { afterEach, describe, expect, it, vi } from 'vitest';

import contract from '../../../../../fixtures/contract/commands.json';

import {
  COMMAND_IDS,
  commandBindings,
  commandDefinition,
  commandTooltip,
  formatKeyAlias,
  formatShortcut,
  MENUS,
  parseShortcut,
  shortcutMatches,
} from '@/features/commands/commands';
import {
  commandState,
  dispatchCommandKeydown,
  isBrowserOnlyShortcut,
  onCommandRun,
  registerCommands,
  runCommand,
} from '@/features/commands/registry';

const key = (init: KeyboardEventInit & { key: string }) =>
  new KeyboardEvent('keydown', { cancelable: true, ...init });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = '';
});

function register(handlers: Parameters<typeof registerCommands>[0]) {
  cleanups.push(registerCommands(handlers));
}

describe('command contract', () => {
  it('lists every command in exactly one menu', () => {
    const inMenus = MENUS.flatMap((menu) => menu.items).filter((item) => item !== 'separator');
    expect(new Set(inMenus).size).toBe(inMenus.length);
    expect([...inMenus].sort()).toEqual([...COMMAND_IDS].sort());
    expect(MENUS.map((menu) => menu.title)).toEqual([
      'File',
      'Edit',
      'View',
      'Go',
      'Bookmarks',
      'Window',
      'Help',
    ]);
  });

  it('parses every shortcut and alias, and no two commands share a binding', () => {
    for (const platform of ['mac', 'other'] as const) {
      const seen = new Map<string, string>();
      for (const id of COMMAND_IDS) {
        const { shortcut, aliases } = commandDefinition(id, platform);
        for (const binding of [shortcut, ...aliases]) {
          if (!binding) continue;
          expect(() => parseShortcut(binding)).not.toThrow();
          const shown = formatShortcut(binding, platform);
          const owner = seen.get(shown) ?? id;
          expect(owner, `${id} and ${owner} share ${shown}`).toBe(id);
          seen.set(shown, id);
        }
      }
    }
  });

  it('uses the key equivalents macOS readers expect', () => {
    const mac = (id: (typeof COMMAND_IDS)[number]) =>
      formatShortcut(commandDefinition(id, 'mac').shortcut ?? '', 'mac');
    expect(mac('view.toggleSidebar')).toBe('⌥⌘S');
    // Preview's sidebar mapping.
    expect(mac('view.hideSidebar')).toBe('⌥⌘1');
    expect(mac('view.sidebarThumbnails')).toBe('⌥⌘2');
    expect(mac('view.sidebarContents')).toBe('⌥⌘3');
    expect(mac('view.sidebarAnnotations')).toBe('⌥⌘4');
    expect(mac('view.sidebarBookmarks')).toBe('⌥⌘5');
    expect(mac('edit.useSelectionForFind')).toBe('⌘E');
    expect(mac('view.zoomIn')).toBe('⌘+');
    expect(mac('view.rotateLeft')).toBe('⌘L');
    expect(mac('go.page')).toBe('⌥⌘G');
    expect(mac('edit.findPrevious')).toBe('⇧⌘G');
    expect(mac('bookmarks.toggle')).toBe('⌘D');
    expect(mac('edit.highlight')).toBe('⇧⌘H');
    expect(mac('edit.highlightMode')).toBe('⌃⌘H');
    expect(mac('view.markup')).toBe('⇧⌘A');
    expect(mac('view.fullScreen')).toBe('⌃⌘F');
    expect(mac('go.back')).toBe('⌘[');
    expect(mac('go.forward')).toBe('⌘]');
    // Tab navigation and the tab that was closed (#50).
    expect(mac('window.previousTab')).toBe('⇧⌘[');
    expect(mac('window.nextTab')).toBe('⇧⌘]');
    expect(mac('file.reopenClosedTab')).toBe('⇧⌘T');
    // The selection and markup keys, and Preview's three layouts.
    expect(mac('edit.addNote')).toBe('⌃⌘N');
    expect(mac('edit.captureArea')).toBe('⇧⌘C');
    expect(mac('view.layoutSingle')).toBe('⌘1');
    expect(mac('view.layoutTwoPage')).toBe('⌘2');
    expect(mac('view.layoutScroll')).toBe('⌘3');
  });

  it('offers Ctrl+Tab and Ctrl+Shift+Tab, the conventional tab switches off macOS', () => {
    expect(commandBindings(commandDefinition('window.nextTab', 'other'))).toContain('Ctrl+Tab');
    expect(commandBindings(commandDefinition('window.previousTab', 'other'))).toContain(
      'Ctrl+Shift+Tab',
    );
    expect(shortcutMatches(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'Ctrl+Tab')).toBe(true);
    expect(
      shortcutMatches(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), 'Ctrl+Tab'),
    ).toBe(false);
    expect(formatKeyAlias('Ctrl+Tab', 'other')).toBe('Ctrl+Tab');
  });

  it('names keyboard-only aliases as a reader would say them', () => {
    expect(formatKeyAlias('Space', 'mac')).toBe('Space');
    expect(formatKeyAlias('PageUp', 'mac')).toBe('Page Up');
    expect(formatKeyAlias('PageDown', 'other')).toBe('Page Down');
    expect(formatKeyAlias('Home', 'mac')).toBe('Home');
    expect(formatKeyAlias('ContextMenu', 'mac')).toBe('Menu Key');
    // A modified alias keeps its platform's symbols.
    expect(formatKeyAlias('Shift+Space', 'mac')).toBe('⇧Space');
    expect(formatKeyAlias('CmdOrCtrl+Plus', 'other')).toBe('Ctrl++');
  });

  it('swaps ⌘ for Ctrl off macOS, with standard replacements where Ctrl would double up', () => {
    expect(formatShortcut('Shift+CmdOrCtrl+G', 'other')).toBe('Ctrl+Shift+G');
    expect(commandDefinition('view.fullScreen', 'other').shortcut).toBe('F11');
    expect(
      formatShortcut(commandDefinition('edit.highlightMode', 'other').shortcut ?? '', 'other'),
    ).toBe('Ctrl+Alt+H');
    expect(commandTooltip('Add Bookmark', 'bookmarks.toggle', 'mac')).toBe('Add Bookmark (⌘D)');
    expect(commandTooltip('Add Bookmark', 'bookmarks.toggle', 'other')).toBe(
      'Add Bookmark (Ctrl+D)',
    );
    // Add Note has a key equivalent now; Capture was the old unsuffixed tooltip.
    expect(commandTooltip('Capture', 'edit.addNote', 'mac')).toBe('Capture (⌃⌘N)');
  });

  it('keeps bare keys out of the native menu', () => {
    const specs = contract.commands as Record<string, { accelerator?: boolean; shortcut?: string }>;
    for (const [id, spec] of Object.entries(specs)) {
      if (spec.shortcut && !/(CmdOrCtrl|Cmd|Ctrl|Alt|^F\d+$)/.test(spec.shortcut)) {
        expect(spec.accelerator, id).toBe(false);
      }
    }
  });
});

describe('selection commands', () => {
  it('opens the selection popover with Shift+F10 or the context-menu key, outside the menu', () => {
    const definition = commandDefinition('edit.selectionActions', 'mac');
    expect(definition.shortcut).toBe('Shift+F10');
    expect(commandBindings(definition)).toContain('ContextMenu');
    expect(shortcutMatches(key({ key: 'F10', code: 'F10', shiftKey: true }), 'Shift+F10')).toBe(
      true,
    );
    expect(shortcutMatches(key({ key: 'ContextMenu', code: 'ContextMenu' }), 'ContextMenu')).toBe(
      true,
    );
    const specs = contract.commands as Record<string, { accelerator?: boolean }>;
    expect(specs['edit.selectionActions']?.accelerator).toBe(false);
  });
});

describe('shortcut matching', () => {
  it('matches the physical key, so Option does not turn S into ß', () => {
    expect(
      shortcutMatches(
        key({ key: 'ß', code: 'KeyS', altKey: true, metaKey: true }),
        'Alt+CmdOrCtrl+S',
      ),
    ).toBe(true);
    expect(shortcutMatches(key({ key: 's', code: 'KeyS', metaKey: true }), 'Alt+CmdOrCtrl+S')).toBe(
      false,
    );
  });

  it('accepts ⌘ or Ctrl for CmdOrCtrl, but not both, and requires both for ⌃⌘', () => {
    expect(shortcutMatches(key({ key: 'd', metaKey: true }), 'CmdOrCtrl+D')).toBe(true);
    expect(shortcutMatches(key({ key: 'd', ctrlKey: true }), 'CmdOrCtrl+D')).toBe(true);
    expect(shortcutMatches(key({ key: 'd', ctrlKey: true, metaKey: true }), 'CmdOrCtrl+D')).toBe(
      false,
    );
    expect(shortcutMatches(key({ key: 'f', ctrlKey: true, metaKey: true }), 'Ctrl+Cmd+F')).toBe(
      true,
    );
    expect(shortcutMatches(key({ key: 'f', metaKey: true }), 'Ctrl+Cmd+F')).toBe(false);
    expect(shortcutMatches(key({ key: 'd', metaKey: true, shiftKey: true }), 'CmdOrCtrl+D')).toBe(
      false,
    );
  });

  it('treats + as Zoom In with or without Shift', () => {
    expect(shortcutMatches(key({ key: '+', metaKey: true }), 'CmdOrCtrl+Plus')).toBe(true);
    expect(
      shortcutMatches(key({ key: '+', metaKey: true, shiftKey: true }), 'CmdOrCtrl+Plus'),
    ).toBe(true);
    expect(shortcutMatches(key({ key: 'ArrowLeft' }), 'ArrowLeft')).toBe(true);
    expect(shortcutMatches(key({ key: 'ArrowLeft', metaKey: true }), 'ArrowLeft')).toBe(false);
  });
});

describe('command registry', () => {
  it('runs the newest active handler and reports state for the menu', () => {
    const older = vi.fn();
    const newer = vi.fn();
    expect(commandState('bookmarks.toggle')).toEqual({
      id: 'bookmarks.toggle',
      enabled: false,
      title: 'Add Bookmark',
    });

    register(() => ({ 'bookmarks.toggle': { run: older } }));
    const unregisterNewer = registerCommands(() => ({
      'bookmarks.toggle': { run: newer, title: 'Remove Bookmark' },
    }));
    expect(commandState('bookmarks.toggle')).toMatchObject({
      enabled: true,
      title: 'Remove Bookmark',
    });
    expect(runCommand('bookmarks.toggle', 'toolbar')).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();

    unregisterNewer();
    runCommand('bookmarks.toggle', 'toolbar');
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('runs nothing for a disabled command, and still takes its modified key', () => {
    const run = vi.fn();
    register(() => ({ 'view.rotateLeft': { run, enabled: false } }));
    // Rotate Left on a PDF tab; on a TXT tab the key has no handler, and left alone
    // WebView2 would reload the whole app with it.
    const event = key({ key: 'l', code: 'KeyL', metaKey: true });
    expect(dispatchCommandKeydown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(commandState('view.rotateLeft').enabled).toBe(false);
  });

  it('leaves a bare key to the page when its command is disabled', () => {
    const next = vi.fn();
    register(() => ({ 'go.nextPage': { run: next, enabled: false } }));
    const arrow = key({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(dispatchCommandKeydown(arrow)).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps browser actions out of a text field, and its editing keys in it', () => {
    const rotate = vi.fn();
    const find = vi.fn();
    register(() => ({
      'view.rotateRight': { run: rotate, enabled: false },
      'edit.find': { run: find },
    }));
    document.body.innerHTML = `<textarea id="note"></textarea>`;
    const note = document.getElementById('note');

    // A note has the focus, so the command is blocked — but reloading the app or
    // opening Edge's Find bar over the note is worse than doing nothing.
    for (const init of [
      { key: 'r', code: 'KeyR', ctrlKey: true },
      { key: 'f', code: 'KeyF', ctrlKey: true },
      { key: 'F5', code: 'F5' },
    ]) {
      const event = key({ ...init, bubbles: true });
      note?.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(true);
    }
    expect(rotate).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();

    // The field keeps its own keys: editing, clipboard, and the caret keys.
    for (const init of [
      { key: 'z', code: 'KeyZ', ctrlKey: true },
      { key: 'a', code: 'KeyA', ctrlKey: true },
      { key: 'c', code: 'KeyC', ctrlKey: true },
      { key: 'v', code: 'KeyV', ctrlKey: true },
      { key: 'x', code: 'KeyX', ctrlKey: true },
      { key: 'ArrowRight', code: 'ArrowRight' },
      // ⌥↑ moves the caret by paragraph on macOS; it is not the browser's.
      { key: 'ArrowUp', code: 'ArrowUp', altKey: true },
    ]) {
      const event = key({ ...init, bubbles: true });
      note?.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
  });

  it('leaves AltGr characters to the field, which Windows reports as Ctrl+Alt', () => {
    const addNote = vi.fn();
    const sidebar = vi.fn();
    const rotate = vi.fn();
    register(() => ({
      'edit.addNote': { run: addNote },
      'view.toggleSidebar': { run: sidebar },
      'view.rotateRight': { run: rotate },
    }));
    document.body.innerHTML = `<textarea id="note"></textarea>`;
    const note = document.getElementById('note');

    // A Polish layout types `ń` with AltGr+N and `ś` with AltGr+S; both arrive as
    // the Ctrl+Alt bindings of Add Note and Toggle Sidebar.
    for (const init of [
      { key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true },
      { key: 'ś', code: 'KeyS', ctrlKey: true, altKey: true },
    ]) {
      const event = key({ ...init, bubbles: true });
      note?.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(addNote).not.toHaveBeenCalled();
    expect(sidebar).not.toHaveBeenCalled();

    // `getModifierState` names AltGr directly, for a platform that reports it alone.
    const altGraph = key({ key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true });
    Object.defineProperty(altGraph, 'getModifierState', {
      value: (modifier: string) => modifier === 'AltGraph',
    });
    note?.dispatchEvent(altGraph);
    expect(altGraph.defaultPrevented).toBe(false);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('dispatches window keydowns, preventing the default', () => {
    const run = vi.fn();
    register(() => ({ 'bookmarks.toggle': { run } }));
    const event = key({ key: 'd', code: 'KeyD', metaKey: true });
    window.dispatchEvent(event);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('never fires while focus is in an editable field, except Find in the find field', () => {
    const bookmark = vi.fn();
    const findNext = vi.fn();
    register(() => ({
      'bookmarks.toggle': { run: bookmark },
      'edit.findNext': { run: findNext },
      'go.nextPage': { run: vi.fn() },
    }));
    document.body.innerHTML = `
      <input id="note" />
      <textarea id="area"></textarea>
      <div contenteditable="true" id="rich"></div>
      <input id="find" data-command-scope="search" />
      <div role="radiogroup"><button id="segment"></button></div>`;
    for (const id of ['note', 'area', 'rich', 'find']) {
      const target = document.getElementById(id);
      target?.dispatchEvent(key({ key: 'd', code: 'KeyD', metaKey: true, bubbles: true }));
    }
    expect(bookmark).not.toHaveBeenCalled();

    document
      .getElementById('find')
      ?.dispatchEvent(key({ key: 'g', code: 'KeyG', metaKey: true, bubbles: true }));
    expect(findNext).toHaveBeenCalledTimes(1);
    document
      .getElementById('note')
      ?.dispatchEvent(key({ key: 'g', code: 'KeyG', metaKey: true, bubbles: true }));
    expect(findNext).toHaveBeenCalledTimes(1);

    // Bare arrows belong to widgets that use them.
    const arrow = key({ key: 'ArrowRight', bubbles: true });
    document.getElementById('segment')?.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
  });

  it('turns pages with Space and Page keys, leaving Space to a focused control', () => {
    const next = vi.fn();
    const previous = vi.fn();
    register(() => ({
      'go.nextPage': { run: next },
      'go.previousPage': { run: previous },
    }));
    document.body.innerHTML = `<button id="button"></button><div id="page" tabindex="-1"></div>`;
    const page = document.getElementById('page');
    page?.dispatchEvent(key({ key: ' ', code: 'Space', bubbles: true }));
    page?.dispatchEvent(key({ key: 'PageDown', code: 'PageDown', bubbles: true }));
    page?.dispatchEvent(key({ key: ' ', code: 'Space', shiftKey: true, bubbles: true }));
    page?.dispatchEvent(key({ key: 'PageUp', code: 'PageUp', bubbles: true }));
    expect(next).toHaveBeenCalledTimes(2);
    expect(previous).toHaveBeenCalledTimes(2);

    const space = key({ key: ' ', code: 'Space', bubbles: true });
    document.getElementById('button')?.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('leaves keyboard-only aliases to a view that scrolls natively', () => {
    const next = vi.fn();
    register(() => ({ 'go.nextPage': { run: next, nativeAliases: true } }));
    const space = key({ key: ' ', code: 'Space' });
    expect(dispatchCommandKeydown(space)).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    expect(dispatchCommandKeydown(key({ key: 'ArrowRight' }))).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it('formats the page and chapter keys for each platform', () => {
    expect(formatShortcut('Alt+ArrowDown', 'mac')).toBe('⌥↓');
    expect(formatShortcut('Home', 'mac')).toBe('↖');
    expect(formatShortcut('PageDown', 'other')).toBe('PgDn');
    expect(shortcutMatches(key({ key: 'Home', code: 'Home' }), 'Home')).toBe(true);
    expect(shortcutMatches(key({ key: ' ' }), 'Space')).toBe(true);
    expect(shortcutMatches(key({ key: ' ', shiftKey: true }), 'Space')).toBe(false);
  });

  it('leaves arrows to the outline tree and sidebar lists, and ⌘Z to text fields', () => {
    const nextPage = vi.fn();
    const undoDelete = vi.fn();
    register(() => ({
      'go.nextPage': { run: nextPage },
      'edit.undoDelete': { run: undoDelete },
    }));
    document.body.innerHTML = `
      <ul role="tree"><li role="treeitem" id="item" tabindex="0"></li></ul>
      <ol data-arrow-keys=""><li><button id="row"></button></li></ol>
      <input id="note" />`;
    for (const id of ['item', 'row']) {
      const arrow = key({ key: 'ArrowRight', bubbles: true });
      document.getElementById(id)?.dispatchEvent(arrow);
      expect(arrow.defaultPrevented).toBe(false);
    }
    expect(nextPage).not.toHaveBeenCalled();

    const undoInField = key({ key: 'z', code: 'KeyZ', metaKey: true, bubbles: true });
    document.getElementById('note')?.dispatchEvent(undoInField);
    expect(undoDelete).not.toHaveBeenCalled();
    document
      .getElementById('row')
      ?.dispatchEvent(key({ key: 'z', code: 'KeyZ', metaKey: true, bubbles: true }));
    expect(undoDelete).toHaveBeenCalledTimes(1);
  });

  it('runs a key equivalent once when the menu also reports it', () => {
    const run = vi.fn();
    const observed = vi.fn();
    register(() => ({ 'go.back': { run } }));
    cleanups.push(onCommandRun(observed));
    window.dispatchEvent(key({ key: '[', code: 'BracketLeft', metaKey: true }));
    runCommand('go.back', 'menu');
    expect(run).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith('go.back', 'keyboard');
  });
});

describe('the webview browser keys', () => {
  it('names the keys a browser answers, per platform', () => {
    // Windows and Linux: WebView2's reload, Find, print, view source, and caret browsing.
    for (const init of [
      { key: 'F3', code: 'F3' },
      { key: 'F3', code: 'F3', shiftKey: true },
      { key: 'F5', code: 'F5' },
      { key: 'F5', code: 'F5', ctrlKey: true },
      { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true },
      { key: 'p', code: 'KeyP', ctrlKey: true },
      { key: 'u', code: 'KeyU', ctrlKey: true },
      { key: 'F7', code: 'F7' },
    ]) {
      expect(isBrowserOnlyShortcut(key(init), 'other'), JSON.stringify(init)).toBe(true);
    }

    // macOS: the browser's are the ⌘ keys. ⌃P and ⌃U move the caret in a text field.
    expect(isBrowserOnlyShortcut(key({ key: 'p', code: 'KeyP', metaKey: true }), 'mac')).toBe(true);
    expect(isBrowserOnlyShortcut(key({ key: 'p', code: 'KeyP', ctrlKey: true }), 'mac')).toBe(
      false,
    );
    expect(isBrowserOnlyShortcut(key({ key: 'u', code: 'KeyU', ctrlKey: true }), 'mac')).toBe(
      false,
    );

    // Neither platform's browser owns these, and the editing keys stay the field's.
    for (const platform of ['mac', 'other'] as const) {
      for (const init of [
        { key: 'k', code: 'KeyK', ctrlKey: true },
        { key: 'F9', code: 'F9' },
        { key: 'c', code: 'KeyC', metaKey: true },
        { key: 'v', code: 'KeyV', ctrlKey: true },
      ]) {
        expect(isBrowserOnlyShortcut(key(init), platform), JSON.stringify(init)).toBe(false);
      }
    }
  });

  it('swallows them with nothing registered, and leaves every other key alone', () => {
    for (const init of [
      { key: 'F3', code: 'F3' },
      { key: 'F5', code: 'F5' },
      { key: 'F7', code: 'F7' },
    ]) {
      const event = key(init);
      expect(dispatchCommandKeydown(event), JSON.stringify(init)).toBe(false);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(true);
    }

    const unrelated = key({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(dispatchCommandKeydown(unrelated)).toBe(false);
    expect(unrelated.defaultPrevented).toBe(false);
  });
});
