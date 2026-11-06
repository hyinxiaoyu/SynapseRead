import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  COMMAND_IDS,
  type CommandDefinition,
  type CommandId,
  commandBindings,
  commandDefinition,
  shortcutMatches,
} from '@/features/commands/commands';

/**
 * What a component does for a command while it is mounted and active. A command
 * with no handler, or with `enabled: false`, is greyed out in the menu and its
 * shortcut does nothing (the key reaches the page as usual).
 */
export interface CommandHandler {
  run: () => void;
  enabled?: boolean;
  /** A context title for the menu item, such as "Remove Bookmark". */
  title?: string;
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

/** Widgets that use bare arrow keys themselves. */
const ARROW_KEY_WIDGETS =
  '[role="slider"], [role="separator"], [role="tablist"], [role="radiogroup"], [role="menu"], .react-flow';

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
  return typeof element?.closest === 'function' && element.closest(ARROW_KEY_WIDGETS) !== null;
}

/**
 * Matches a keydown to a command and runs it. Viewers whose content lives in an
 * iframe forward the frame's keydowns here. Returns whether a command ran.
 */
export function dispatchCommandKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  for (const id of COMMAND_IDS) {
    const definition = commandDefinition(id);
    if (!commandBindings(definition).some((binding) => shortcutMatches(event, binding))) {
      continue;
    }
    if (blocksShortcut(event, definition)) return false;
    if (!runCommand(id, 'keyboard')) return false;
    event.preventDefault();
    return true;
  }
  return false;
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
