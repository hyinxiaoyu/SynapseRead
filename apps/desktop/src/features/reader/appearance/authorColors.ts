import { contrastRatio } from '@/lib/contrast';
import type { ReadingTheme } from '@/types/domain';

import { PAGE_PALETTES, resolveReadingTheme } from './themes';

/** WCAG AA for body text, which is what a chapter's prose is. */
const AA_TEXT = 4.5;
/** Marks an element whose color this module replaced, so a later theme can restore it. */
const OVERRIDDEN = 'data-synapse-readable-color';
/** Records the theme a chapter's colors were settled for, so a later identical pass is free. */
const SETTLED_THEME = 'data-synapse-color-theme';
/** The inline color each element had before this module replaced it. */
const originalInline = new WeakMap<Element, { value: string; priority: string }>();

function contrastOnPage(color: string, background: string): number {
  try {
    return contrastRatio(color, background);
  } catch {
    // A computed color with alpha, or in a syntax the WCAG helper does not parse,
    // has an indeterminate contrast. Replacing it is safe; leaving it is not.
    return 0;
  }
}

/**
 * An element's own background when it is opaque, as the paper its text sits on.
 * A translucent or absent background leaves the parent's paper in charge.
 */
function opaqueBackground(value: string): string | null {
  const rgb = /^rgba?[(\s]*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]*([\d.]+%?))?/.exec(
    value.trim().toLowerCase(),
  );
  if (!rgb) return null;
  const alpha = rgb[4];
  if (alpha === undefined) return value;
  const fraction = alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
  return fraction >= 0.95 ? value : null;
}

function restoreInlineColor(element: Element): void {
  const saved = originalInline.get(element);
  if (!saved) return;
  const style = (element as HTMLElement).style;
  if (saved.value) style.setProperty('color', saved.value, saved.priority);
  else style.removeProperty('color');
  originalInline.delete(element);
}

export function revertAuthorColors(doc: Document): void {
  for (const element of doc.querySelectorAll(`[${OVERRIDDEN}]`)) {
    restoreInlineColor(element);
    element.removeAttribute(OVERRIDDEN);
  }
}

/**
 * Dark and Sepia put the theme's text color on `html` and `body` only, so a color
 * the book sets on a heading, a paragraph, or a class survives the theme and can
 * be unreadable on the tinted page. Replace only author colors that fall below
 * WCAG AA on the paper they actually sit on: the book's own opaque background
 * when it has one, otherwise the page. A textbook's meaningful colors survive.
 *
 * An element whose computed color differs from its parent's is the one that
 * declared a color; an equal one is inherited from a parent already handled.
 * The replacement is an inline `!important`, which beats both a stylesheet
 * declaration and the book's own inline one.
 */
export function applyReadableAuthorColors(doc: Document, theme: ReadingTheme): void {
  const root = doc.documentElement;
  // `auto` settles to Light here, as the chapter's own CSS does.
  const resolved = resolveReadingTheme(theme, false);
  if (!root || root.getAttribute(SETTLED_THEME) === resolved) return;
  revertAuthorColors(doc);
  root.setAttribute(SETTLED_THEME, resolved);
  // Light keeps the publisher's colors; only the tinted pages need rescuing.
  if (resolved === 'light') return;
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view) return;
  const palette = PAGE_PALETTES[resolved];
  const page = { color: palette.text, background: palette.background };
  // Parents are visited before their children, so the map already holds what
  // this pass left on the parent: its color and the paper behind its text.
  const settled = new WeakMap<Element, { color: string; background: string }>();
  settled.set(body, page);
  for (const element of body.querySelectorAll('*')) {
    const parent = element.parentElement;
    const inherited = (parent && settled.get(parent)) || page;
    const computed = view.getComputedStyle(element as HTMLElement);
    const color = computed.color;
    // A dark paragraph on the book's own white callout box is readable there,
    // even though it would vanish on the Dark page; compare with that paper.
    const background = opaqueBackground(computed.backgroundColor) ?? inherited.background;
    if (inherited.color === color || contrastOnPage(color, background) >= AA_TEXT) {
      settled.set(element, { color, background });
      continue;
    }
    const style = (element as HTMLElement).style;
    originalInline.set(element, {
      value: style.getPropertyValue('color'),
      priority: style.getPropertyPriority('color'),
    });
    style.setProperty('color', palette.text, 'important');
    element.setAttribute(OVERRIDDEN, resolved);
    settled.set(element, { color: palette.text, background });
  }
}
