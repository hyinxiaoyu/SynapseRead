import contract from '../../../../../fixtures/contract/commands.json';

import { detectPlatform, type Platform } from '@/lib/platform';

/**
 * Every app command, read from the contract the native menu is built from
 * (`fixtures/contract/commands.json`), so a title or key equivalent is defined
 * once for the menu, the keyboard, and toolbar tooltips.
 */
export type CommandId = keyof typeof contract.commands;

interface CommandSpec {
  title: string;
  shortcut?: string;
  shortcutOther?: string;
  aliases?: readonly string[];
  accelerator?: boolean;
  allowInSearch?: boolean;
}

export interface CommandDefinition {
  id: CommandId;
  title: string;
  /** The key equivalent on this platform, in accelerator syntax. */
  shortcut: string | null;
  /** Keyboard-only alternatives, such as `+` for Zoom In. */
  aliases: readonly string[];
  /** Runs while the find field has focus (Find Next from inside the field, for one). */
  allowInSearch: boolean;
}

export interface MenuDefinition {
  id: string;
  title: string;
  items: readonly (CommandId | 'separator')[];
}

const specs = contract.commands as Record<CommandId, CommandSpec>;

export const COMMAND_IDS = Object.keys(specs) as CommandId[];

export const MENUS = contract.menus as readonly MenuDefinition[];

export function isCommandId(value: string): value is CommandId {
  return Object.hasOwn(specs, value);
}

export function commandDefinition(
  id: CommandId,
  platform: Platform = detectPlatform(),
): CommandDefinition {
  const spec = specs[id];
  const shortcut =
    platform === 'mac' ? (spec.shortcut ?? null) : (spec.shortcutOther ?? spec.shortcut ?? null);
  return {
    id,
    title: spec.title,
    shortcut,
    aliases: spec.aliases ?? [],
    allowInSearch: spec.allowInSearch === true,
  };
}

// ---- Shortcuts ---------------------------------------------------------------

export interface ParsedShortcut {
  /** `CmdOrCtrl`: ⌘ on macOS and Ctrl elsewhere. */
  primary: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The key token as written: `D`, `=`, `[`, `ArrowLeft`, `F11`, `Plus`. */
  key: string;
}

export function parseShortcut(accelerator: string): ParsedShortcut {
  // Split on `+` separators but keep a trailing `+` key; the contract writes it as
  // `Plus`, so this only guards against a hand-written accelerator.
  const tokens = accelerator.split(/\+(?!$)/);
  const parsed: ParsedShortcut = {
    primary: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: tokens.at(-1) ?? '',
  };
  for (const token of tokens.slice(0, -1)) {
    switch (token.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        parsed.primary = true;
        break;
      case 'cmd':
      case 'command':
      case 'super':
      case 'meta':
        parsed.meta = true;
        break;
      case 'ctrl':
      case 'control':
        parsed.ctrl = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      default:
        throw new Error(`Unknown modifier ${token} in ${accelerator}`);
    }
  }
  return parsed;
}

const KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Plus: '+',
  '=': '+',
};

const OTHER_KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Plus: '+',
  '=': '+',
};

/** `⌃⌘F` on macOS, `Ctrl+Shift+G` elsewhere, in the order each platform's menus use. */
export function formatShortcut(accelerator: string, platform: Platform = detectPlatform()): string {
  const shortcut = parseShortcut(accelerator);
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  if (platform === 'mac') {
    return [
      shortcut.ctrl ? '⌃' : '',
      shortcut.alt ? '⌥' : '',
      shortcut.shift ? '⇧' : '',
      shortcut.meta || shortcut.primary ? '⌘' : '',
      KEY_SYMBOLS[shortcut.key] ?? key,
    ].join('');
  }
  return [
    shortcut.ctrl || shortcut.primary ? 'Ctrl' : '',
    shortcut.meta ? 'Win' : '',
    shortcut.alt ? 'Alt' : '',
    shortcut.shift ? 'Shift' : '',
    OTHER_KEY_NAMES[shortcut.key] ?? key,
  ]
    .filter(Boolean)
    .join('+');
}

/** `Add Bookmark (⌘D)`: a tooltip naming a control and its key equivalent. */
export function commandTooltip(
  label: string,
  id: CommandId,
  platform: Platform = detectPlatform(),
): string {
  const { shortcut } = commandDefinition(id, platform);
  return shortcut ? `${label} (${formatShortcut(shortcut, platform)})` : label;
}

/** The physical key for a token. Matching on `code` survives ⌥ turning `S` into `ß`. */
function keyCode(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  switch (key) {
    case '=':
      return 'Equal';
    case '-':
      return 'Minus';
    case '[':
      return 'BracketLeft';
    case ']':
      return 'BracketRight';
    case '/':
      return 'Slash';
    case 'Plus':
      return 'NumpadAdd';
    default:
      return /^(Arrow\w+|F\d+|Page(Up|Down)|Home|End|Space)$/.test(key) ? key : null;
  }
}

function keyMatches(event: KeyboardEvent, key: string): boolean {
  if (key === 'Plus') return event.key === '+' || event.code === 'NumpadAdd';
  if (key === 'Space') return event.key === ' ' || event.code === 'Space';
  const code = keyCode(key);
  if (code !== null && event.code === code) return true;
  // Layouts that move a key keep its character; tests often send `key` alone.
  if (event.altKey && key.length === 1) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}

export function shortcutMatches(event: KeyboardEvent, accelerator: string): boolean {
  const shortcut = parseShortcut(accelerator);
  if (!keyMatches(event, shortcut.key)) return false;
  if (event.altKey !== shortcut.alt) return false;
  // `+` is a shifted key on most layouts, so Plus matches with or without Shift.
  if (shortcut.key !== 'Plus' && event.shiftKey !== shortcut.shift) return false;
  if (shortcut.primary && !shortcut.meta && !shortcut.ctrl) {
    // ⌘ or Ctrl, but not both: the app accepts either on any platform, as it always has.
    return event.metaKey !== event.ctrlKey;
  }
  return event.metaKey === shortcut.meta && event.ctrlKey === shortcut.ctrl;
}

/** Every binding for a command: its shortcut first, then keyboard-only aliases. */
export function commandBindings(definition: CommandDefinition): readonly string[] {
  return definition.shortcut ? [definition.shortcut, ...definition.aliases] : definition.aliases;
}
