import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  COMMAND_IDS,
  type CommandDefinition,
  type CommandId,
  commandBindings,
  commandDefinition,
  shortcutMatches,
} from '@/features/commands/commands';
import { detectPlatform, type Platform } from '@/lib/platform';

/**
 * What a component does for a command while it is mounted and active. A command
 * with no handler, or with `enabled: false`, is greyed out in the menu and its
 * shortcut runs nothing; a modified key is still swallowed, so the webview's own
 * browser UI cannot answer it either.
 */
export interface CommandHandler {
  run: () => void;
  enabled?: boolean;
  /** A context title for the menu item, such as "Remove Bookmark". */
  title?: string;
  /**
   * Leaves the command's keyboard-only aliases (Space, Page Up, Page Down) to the
   * browser, for a view that scrolls natively, such as PDF continuous scroll.
   */
  nativeAliases?: boolean;
}

export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>;

export type CommandSource = 'keyboard' | 'menu' | 'toolbar';

export interface CommandState {
  id: CommandId;
  enabled: boolean;
  title: string;
}

interface Registration {
  read: () => CommandHandlers;
}

/** Newest last: the most recently activated owner of a command wins. */
const registrations: Registration[] = [];
const stateListeners = new Set<() => void>();
const runListeners = new Set<(id: CommandId, source: CommandSource) => void>();
/**
 * A menu key equivalent can arrive both as a keydown and as a menu event; the
 * second within this window is the same keypress.
 */
const DUPLICATE_WINDOW_MS = 150;
const isKeyEquivalent = (source: CommandSource) => source === 'keyboard' || source === 'menu';
const lastRun = new Map<CommandId, { at: number; source: CommandSource }>();

function resolve(id: CommandId): CommandHandler | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const handler = registrations[index]?.read()[id];
    if (handler) return handler;
  }
  return null;
}

function notifyStateListeners() {
  for (const listener of stateListeners) listener();
}

export function registerCommands(read: () => CommandHandlers): () => void {
  const registration: Registration = { read };
  registrations.push(registration);
  ensureKeyboardListener();
  notifyStateListeners();
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
    notifyStateListeners();
  };
}

/** Call after a registered handler's `enabled` or `title` changes. */
export function commandStatesChanged() {
  notifyStateListeners();
}

export function commandState(id: CommandId): CommandState {
  const handler = resolve(id);
  return {
    id,
    enabled: handler !== null && handler.enabled !== false,
    title: handler?.title ?? commandDefinition(id).title,
  };
}

export function commandStates(): CommandState[] {
  return COMMAND_IDS.map(commandState);
}

export function onCommandStatesChange(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Observes every command that runs, whatever triggered it. */
export function onCommandRun(listener: (id: CommandId, source: CommandSource) => void) {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

/** Forgets recent runs, so a test's first command is never taken for a repeat. */
export function forgetRecentCommandRuns() {
  lastRun.clear();
}

/** Runs a command if something currently handles it; reports whether it ran. */
export function runCommand(id: CommandId, source: CommandSource): boolean {
  const handler = resolve(id);
  if (!handler || handler.enabled === false) return false;
  const now = performance.now();
  const previous = lastRun.get(id);
  if (
    previous &&
    previous.source !== source &&
    isKeyEquivalent(previous.source) &&
    isKeyEquivalent(source) &&
    now - previous.at < DUPLICATE_WINDOW_MS
  ) {
    return true;
  }
  lastRun.set(id, { at: now, source });
  handler.run();
  for (const listener of runListeners) listener(id, source);
  return true;
}

// ---- Keyboard ----------------------------------------------------------------

/**
 * Text entry owns its keys. Duck-typed rather than `instanceof HTMLElement`, so
 * that keys forwarded from an EPUB chapter's iframe (another realm) are checked too.
 */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target as (Partial<HTMLElement> & { closest?: unknown }) | null;
  if (!element || typeof element.closest !== 'function') return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable) {
    return true;
  }
  return (element as Element).closest('[contenteditable="true"], [role="textbox"]') !== null;
}

/**
 * Widgets that use bare arrow keys (and Home, End, Page Up, Page Down) themselves;
 * `data-arrow-keys` marks the rest (sidebar lists).
 */
const ARROW_KEY_WIDGETS =
  '[role="slider"], [role="separator"], [role="tablist"], [role="radiogroup"], [role="menu"], [role="tree"], [data-arrow-keys], .react-flow';
/** Space presses a focused control, so it turns the page only from the page itself. */
const SPACE_KEY_WIDGETS =
  'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="treeitem"]';

function isSearchField(target: EventTarget | null): boolean {
  const element = target as { dataset?: DOMStringMap } | null;
  return element?.dataset?.commandScope === 'search';
}

function blocksShortcut(event: KeyboardEvent, definition: CommandDefinition): boolean {
  const { target } = event;
  if (isEditableShortcutTarget(target)) {
    return !(definition.allowInSearch && isSearchField(target));
  }
  const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (!unmodified) return false;
  const element = target as { closest?: (selector: string) => Element | null } | null;
  if (typeof element?.closest !== 'function') return false;
  const widgets =
    event.key === ' ' ? `${ARROW_KEY_WIDGETS}, ${SPACE_KEY_WIDGETS}` : ARROW_KEY_WIDGETS;
  return element.closest(widgets) !== null;
}

/**
 * Keys the webview answers as a browser rather than as the app: reload, Find,
 * print, view source, and caret browsing. None of them is an app command, and
 * none is a text-editing key, so they are swallowed wherever the focus is.
 *
 * Written per platform rather than as `CmdOrCtrl` because the app accepts either
 * primary modifier while a browser does not: on macOS `⌃P` and `⌃U` move the
 * caret in a text field, and only `⌘P` and `⌘U` are the browser's.
 */
const BROWSER_ONLY_SHORTCUTS: Record<Platform, readonly string[]> = {
  mac: ['F3', 'Shift+F3', 'F5', 'Cmd+F5', 'Cmd+Shift+R', 'Cmd+P', 'Cmd+U', 'F7'],
  other: ['F3', 'Shift+F3', 'F5', 'Ctrl+F5', 'Ctrl+Shift+R', 'Ctrl+P', 'Ctrl+U', 'F7'],
};

/** Whether the webview would answer this key itself, as a browser rather than as the app. */
export function isBrowserOnlyShortcut(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
): boolean {
  return BROWSER_ONLY_SHORTCUTS[platform].some((shortcut) => shortcutMatches(event, shortcut));
}

/**
 * Keys a text field answers itself: the editing and clipboard keys a field owns even
 * where an app command happens to share one (`edit.undoDelete` owns ⌘Z). Neither the
 * command nor the browser guard may take them away from the field.
 */
const TEXT_FIELD_SHORTCUTS = [
  'CmdOrCtrl+Z',
  'CmdOrCtrl+Y',
  'Shift+CmdOrCtrl+Z',
  'CmdOrCtrl+A',
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+X',
] as const;

/** The modifier a browser's own shortcuts use: ⌘ on macOS, Ctrl elsewhere. */
function hasPrimaryModifier(event: KeyboardEvent, platform: Platform): boolean {
  if (isCharacterInput(event)) return false;
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/**
 * Whether this keydown types a character rather than pressing a shortcut. Windows
 * reports AltGr as Ctrl+Alt, so `AltGr+N` on a Polish layout arrives as the
 * `Ctrl+Alt+N` Add Note binding and must still reach the field; `getModifierState`
 * names the same key directly, for a platform that reports it without Alt.
 */
function isCharacterInput(event: KeyboardEvent): boolean {
  return event.altKey || event.getModifierState('AltGraph');
}

/**
 * Whether the webview, not the app, would act on this key. A text field keeps the
 * key from its command, but the webview must not answer it either: with a note
 * focused, `Ctrl+R` would reload the app and `Ctrl+F` would open Edge's Find bar.
 */
function isBrowserAction(event: KeyboardEvent, platform: Platform): boolean {
  if (isBrowserOnlyShortcut(event, platform)) return true;
  if (TEXT_FIELD_SHORTCUTS.some((shortcut) => shortcutMatches(event, shortcut))) return false;
  return hasPrimaryModifier(event, platform);
}

/** A key that carries a command's modifier, rather than a bare key the page owns. */
function isModified(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * Why a keydown left the command loop. `passed` means a command matched but did
 * not run, and the key has already been dealt with: either the page keeps it (a
 * bare arrow in a text field) or it was swallowed so the webview cannot act on it.
 */
type KeydownResult = 'ran' | 'passed' | 'unclaimed';

/**
 * Matches a keydown to a command and runs it. Viewers whose content lives in an
 * iframe forward the frame's keydowns here. Returns whether a command ran.
 */
export function dispatchCommandKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const result = dispatchToCommand(event);
  if (result !== 'unclaimed') return result === 'ran';
  // Nothing in the app claims this key, so it is the webview's own browser UI
  // (reload, Find, print, view source) or nothing at all.
  if (!isBrowserOnlyShortcut(event)) return false;
  event.preventDefault();
  return false;
}

function dispatchToCommand(event: KeyboardEvent): KeydownResult {
  const platform = detectPlatform();
  for (const id of COMMAND_IDS) {
    const definition = commandDefinition(id, platform);
    const binding = commandBindings(definition).find((candidate) =>
      shortcutMatches(event, candidate),
    );
    if (binding === undefined) continue;
    if (blocksShortcut(event, definition)) {
      // The field owns the key, but it still must not reach the webview: `Ctrl+R`
      // and `Ctrl+F` would reload the app or open Edge's Find bar over the note
      // being edited. Editing and clipboard keys stay the field's.
      if (isBrowserAction(event, platform)) event.preventDefault();
      return 'passed';
    }
    if (binding !== definition.shortcut && resolve(id)?.nativeAliases) return 'passed';
    if (runCommand(id, 'keyboard')) {
      event.preventDefault();
      return 'ran';
    }
    // The command is greyed out here, but a modified key must not fall through to
    // the webview: on Windows, `Ctrl+R` reloads the whole app and `Ctrl+F` opens
    // Edge's Find bar over the reader. A bare key (an arrow, Space) still belongs
    // to the page.
    if (isModified(event)) event.preventDefault();
    return 'passed';
  }
  return 'unclaimed';
}

let keyboardListenerInstalled = false;

/** One window listener for every shortcut, installed when the first command registers. */
function ensureKeyboardListener() {
  if (keyboardListenerInstalled || typeof window === 'undefined') return;
  keyboardListenerInstalled = true;
  window.addEventListener('keydown', (event) => {
    dispatchCommandKeydown(event);
  });
}

// ---- React -------------------------------------------------------------------

/**
 * Registers handlers while `active`. Handlers may be recreated on every render;
 * the registry always calls the latest. The menu updates when one is enabled,
 * disabled, or retitled.
 */
export function useCommands(handlers: CommandHandlers, active = true) {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    if (!active) return;
    return registerCommands(() => latest.current);
  }, [active]);

  const signature = Object.entries(handlers)
    .map(([id, handler]) => `${id}:${handler.enabled !== false}:${handler.title ?? ''}`)
    .join('|');
  useEffect(() => {
    if (active) commandStatesChanged();
  }, [active, signature]);
}
