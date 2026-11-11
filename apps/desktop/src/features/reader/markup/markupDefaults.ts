import { useSyncExternalStore } from 'react';

import type { AnnotationStyle } from '@/types/domain';

const STORAGE_KEY = 'synapseread.markup.v1';

export interface MarkupDefaults {
  color: string;
  style: AnnotationStyle;
}

export const DEFAULT_MARKUP: MarkupDefaults = { color: '#fde047', style: 'highlight' };

const isStyle = (value: unknown): value is AnnotationStyle =>
  value === 'highlight' || value === 'underline';

/** A hex color, so a corrupted entry can never reach an inline style. */
const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);

/**
 * The color and style new highlights use, as last chosen in any document. A
 * preference like the sidebar's: it stays in this webview's storage and never
 * reaches the database or the network.
 */
export function readMarkupDefaults(): MarkupDefaults {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const stored = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    return {
      color: isColor(stored.color) ? stored.color : DEFAULT_MARKUP.color,
      style: isStyle(stored.style) ? stored.style : DEFAULT_MARKUP.style,
    };
  } catch {
    return DEFAULT_MARKUP;
  }
}

const listeners = new Set<() => void>();
/** What was chosen this session when storage refused it, so the choice still holds. */
let unsaved: MarkupDefaults | null = null;
let lastRaw: string | null | undefined;
let lastValue: MarkupDefaults = DEFAULT_MARKUP;

/** The current defaults, as one object per stored value so React can compare it. */
function snapshot(): MarkupDefaults {
  if (unsaved) return unsaved;
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = readMarkupDefaults();
  }
  return lastValue;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records a choice and tells every open reader, so each tab offers the same one. */
export function writeMarkupDefaults(patch: Partial<MarkupDefaults>): void {
  const next = { ...snapshot(), ...patch };
  try {
    if (!globalThis.localStorage) throw new Error('no storage');
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    unsaved = null;
  } catch {
    // Storage can be full or disabled; the choice still holds for this session.
    unsaved = next;
  }
  for (const listener of listeners) listener();
}

/** The last color and style, kept current across every reader that shows them. */
export function useMarkupDefaults(): MarkupDefaults {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
