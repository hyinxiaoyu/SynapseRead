import type { AriaLabelConfig } from '@xyflow/react';

import { commandBindings, commandDefinition, parseShortcut } from '@/features/commands/commands';
import { summarizeMarkdownNotes } from '@/features/mindmap/CardNode';
import { detectPlatform, type Platform } from '@/lib/platform';
import type { NoteCard } from '@/types/domain';

const MAX_ARIA_TITLE_CHARS = 80;

const MAC_SPOKEN_KEYS: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'Delete',
  Delete: 'Forward Delete',
  Space: 'Space',
  ArrowLeft: 'Left Arrow',
  ArrowRight: 'Right Arrow',
  ArrowUp: 'Up Arrow',
  ArrowDown: 'Down Arrow',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Plus: 'Plus',
};

const OTHER_SPOKEN_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: 'Space',
  ArrowLeft: 'Left Arrow',
  ArrowRight: 'Right Arrow',
  ArrowUp: 'Up Arrow',
  ArrowDown: 'Down Arrow',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Plus: 'Plus',
};

function normalizeAriaTitle(raw: string | null | undefined): string {
  const collapsed = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!collapsed) return 'Untitled card';
  const chars = Array.from(collapsed);
  if (chars.length <= MAX_ARIA_TITLE_CHARS) return collapsed;
  return `${chars.slice(0, MAX_ARIA_TITLE_CHARS - 1).join('')}…`;
}

function spokenAccelerator(accelerator: string, platform: Platform): string {
  const parsed = parseShortcut(accelerator);
  const keyMap = platform === 'mac' ? MAC_SPOKEN_KEYS : OTHER_SPOKEN_KEYS;
  const key =
    keyMap[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  const parts: string[] = [];
  if (platform === 'mac') {
    if (parsed.ctrl) parts.push('Control');
    if (parsed.alt) parts.push('Option');
    if (parsed.shift) parts.push('Shift');
    if (parsed.meta || parsed.primary) parts.push('Command');
  } else {
    if (parsed.ctrl || parsed.primary) parts.push('Control');
    if (parsed.meta) parts.push('Meta');
    if (parsed.alt) parts.push('Alt');
    if (parsed.shift) parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}

function spokenBindings(bindings: readonly string[], platform: Platform): string {
  const spoken = [...new Set(bindings.map((binding) => spokenAccelerator(binding, platform)))];
  return spoken.join(' or ');
}

export interface CardAriaInput {
  card: Pick<NoteCard, 'title' | 'markdownNotes' | 'tags' | 'annotationIds'> | undefined;
  parentTitle?: string | null;
  sourceLabel?: string | null;
}

/**
 * Accessible name for a focusable MindMap card wrapper, built from the card's
 * title and context rather than internal IDs (#185).
 */
export function cardAriaLabel({ card, parentTitle, sourceLabel }: CardAriaInput): string {
  const parts: string[] = [`Card: ${normalizeAriaTitle(card?.title)}`];
  const cleanSource = sourceLabel?.trim();
  if (cleanSource) {
    parts.push(`from ${cleanSource}`);
  } else if (card && card.annotationIds.length === 0) {
    parts.push('source removed');
  }
  if (parentTitle?.trim()) {
    parts.push(`nested under ‘${normalizeAriaTitle(parentTitle)}’`);
  }
  if (card && summarizeMarkdownNotes(card.markdownNotes).length > 0) {
    parts.push('has notes');
  }
  if (card && card.tags.length > 0) {
    parts.push(`${card.tags.length} ${card.tags.length === 1 ? 'tag' : 'tags'}`);
  }
  return parts.join(', ');
}

export interface EdgeAriaInput {
  sourceTitle: string | null | undefined;
  targetTitle: string | null | undefined;
  isNesting: boolean;
  label?: string | null;
}

/**
 * Accessible name for a MindMap link, built from card titles rather than React
 * Flow's default `"Edge from <id> to <id>"` (#185).
 */
export function edgeAriaLabel({
  sourceTitle,
  targetTitle,
  isNesting,
  label,
}: EdgeAriaInput): string {
  const source = normalizeAriaTitle(sourceTitle);
  const target = normalizeAriaTitle(targetTitle);
  const cleanLabel = label?.trim() ?? '';
  if (isNesting) {
    const base = `‘${target}’ nested under ‘${source}’`;
    return cleanLabel ? `${base} (${cleanLabel})` : base;
  }
  const base = `Link from ‘${source}’ to ‘${target}’`;
  return cleanLabel ? `${base}: ${cleanLabel}` : base;
}

/**
 * React Flow `ariaLabelConfig` aligned with SynapseRead's actual shortcuts from
 * `fixtures/contract/commands.json` (ADR 0006, #185).
 */
export function mindMapAriaLabelConfig(
  platform: Platform = detectPlatform(),
): Partial<AriaLabelConfig> {
  const editKeys = spokenBindings(
    commandBindings(commandDefinition('edit.editCard', platform)),
    platform,
  );
  const deleteKeys = spokenBindings(
    commandBindings(commandDefinition('edit.deleteCard', platform)),
    platform,
  );
  const undoKeys = spokenBindings(
    commandBindings(commandDefinition('edit.undoDelete', platform)),
    platform,
  );

  const nodeDescription = `Press ${editKeys} to edit card. Press Space to make it the target for the next excerpt. Use the arrow keys to move it, or hold Shift for larger steps. Press ${deleteKeys} to delete it (${undoKeys} to undo), or Escape to clear selection.`;
  const edgeDescription = `Press ${editKeys} or Space to select this link. Press ${deleteKeys} to remove it, or Escape to deselect.`;

  return {
    // `@xyflow/react` 12.12 renders `keyboardDisabled` while keyboard a11y is enabled
    // and `default` when disabled; set both so the active description always matches.
    'node.a11yDescription.default': nodeDescription,
    'node.a11yDescription.keyboardDisabled': nodeDescription,
    'node.a11yDescription.ariaLiveMessage': ({ direction }) => `Moved selected card ${direction}.`,
    'edge.a11yDescription.default': edgeDescription,
  };
}
