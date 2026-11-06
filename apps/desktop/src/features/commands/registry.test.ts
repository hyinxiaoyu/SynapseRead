import { afterEach, describe, expect, it, vi } from 'vitest';

import contract from '../../../../../fixtures/contract/commands.json';

import {
  COMMAND_IDS,
  commandDefinition,
  commandTooltip,
  formatShortcut,
  MENUS,
  parseShortcut,
  shortcutMatches,
} from '@/features/commands/commands';
import {
  commandState,
  dispatchCommandKeydown,
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
    expect(mac('view.sidebarContents')).toBe('⌥⌘1');
    expect(mac('view.zoomIn')).toBe('⌘+');
    expect(mac('view.rotateLeft')).toBe('⌘L');
    expect(mac('go.page')).toBe('⌥⌘G');
    expect(mac('edit.findPrevious')).toBe('⇧⌘G');
    expect(mac('bookmarks.toggle')).toBe('⌘D');
    expect(mac('edit.highlight')).toBe('⌃⌘H');
    expect(mac('view.markup')).toBe('⇧⌘A');
    expect(mac('view.fullScreen')).toBe('⌃⌘F');
    expect(mac('go.back')).toBe('⌘[');
    expect(mac('go.forward')).toBe('⌘]');
  });

  it('swaps ⌘ for Ctrl off macOS, with standard replacements where Ctrl would double up', () => {
    expect(formatShortcut('Shift+CmdOrCtrl+G', 'other')).toBe('Ctrl+Shift+G');
    expect(commandDefinition('view.fullScreen', 'other').shortcut).toBe('F11');
    expect(
      formatShortcut(commandDefinition('edit.highlight', 'other').shortcut ?? '', 'other'),
    ).toBe('Ctrl+Alt+H');
    expect(commandTooltip('Add Bookmark', 'bookmarks.toggle', 'mac')).toBe('Add Bookmark (⌘D)');
    expect(commandTooltip('Add Bookmark', 'bookmarks.toggle', 'other')).toBe(
      'Add Bookmark (Ctrl+D)',
    );
    expect(commandTooltip('Capture', 'edit.addNote', 'mac')).toBe('Capture');
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

  it('does nothing for a disabled command and lets the key through', () => {
    const run = vi.fn();
    register(() => ({ 'view.rotateLeft': { run, enabled: false } }));
    const event = key({ key: 'l', code: 'KeyL', metaKey: true });
    expect(dispatchCommandKeydown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(commandState('view.rotateLeft').enabled).toBe(false);
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
