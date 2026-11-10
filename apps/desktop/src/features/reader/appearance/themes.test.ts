import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastRatio } from '@/lib/contrast';
import type { ResolvedReadingTheme } from '@/types/domain';

import {
  CHROME_PALETTES,
  type ChromePalette,
  fontStack,
  FONT_FACES,
  PAGE_PALETTES,
  pdfCanvasFilter,
  readerChromeStyle,
  resolveReadingTheme,
} from './themes';

/** WCAG AA: body text, and the non-text contrast a focus ring needs. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const indexCss = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');

/** The system tokens `index.css` declares for light (`:root`) and dark (the media query). */
function systemTokens(scheme: 'light' | 'dark'): Record<string, string> {
  const darkStart = indexCss.indexOf('@media (prefers-color-scheme: dark)');
  const block = scheme === 'light' ? indexCss.slice(0, darkStart) : indexCss.slice(darkStart);
  const rootBlock = /:root\s*{([^}]*)}/.exec(block)?.[1] ?? '';
  const tokens: Record<string, string> = {};
  for (const match of rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (match[1] && match[2]) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function fromSystem(scheme: 'light' | 'dark'): ChromePalette {
  const tokens = systemTokens(scheme);
  const token = (name: string) => {
    const value = tokens[name];
    if (!value) throw new Error(`index.css has no --${name} for ${scheme}`);
    return value;
  };
  return {
    background: token('background'),
    foreground: token('foreground'),
    card: token('card'),
    cardForeground: token('card-foreground'),
    primary: token('primary'),
    primaryForeground: token('primary-foreground'),
    secondary: token('secondary'),
    secondaryForeground: token('secondary-foreground'),
    muted: token('muted'),
    mutedForeground: token('muted-foreground'),
    accent: token('accent'),
    accentForeground: token('accent-foreground'),
    border: token('border'),
    input: token('input'),
    ring: token('ring'),
  };
}

/**
 * The chrome each theme shows. Light is the system's chrome, in either system
 * appearance; Sepia and Dark are their own.
 */
const CHROME_UNDER_TEST: readonly [string, ChromePalette][] = [
  ['light (system light)', fromSystem('light')],
  ['light (system dark)', fromSystem('dark')],
  ...Object.entries(CHROME_PALETTES).map(([theme, palette]): [string, ChromePalette] => [
    theme,
    palette,
  ]),
];

describe('reading theme contrast (WCAG AA)', () => {
  it.each(Object.entries(PAGE_PALETTES))('%s page text', (_theme, palette) => {
    expect(contrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(palette.secondaryText, palette.background)).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });

  it.each(CHROME_UNDER_TEST)('%s chrome text', (_theme, chrome) => {
    const pairs: [string, string, string][] = [
      ['foreground on background', chrome.foreground, chrome.background],
      ['secondary text on background', chrome.mutedForeground, chrome.background],
      ['secondary text on muted', chrome.mutedForeground, chrome.muted],
      ['secondary text on accent (hover)', chrome.mutedForeground, chrome.accent],
      ['card text', chrome.cardForeground, chrome.card],
      ['selected segment', chrome.primaryForeground, chrome.primary],
      ['secondary button', chrome.secondaryForeground, chrome.secondary],
      ['accent text', chrome.accentForeground, chrome.accent],
    ];
    for (const [name, foreground, background] of pairs) {
      expect.soft(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(CHROME_UNDER_TEST)('%s focus ring', (_theme, chrome) => {
    expect(contrastRatio(chrome.ring, chrome.background)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(chrome.ring, chrome.muted)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('reading themes', () => {
  it('settles Auto against the system appearance', () => {
    expect(resolveReadingTheme('auto', false)).toBe('light');
    expect(resolveReadingTheme('auto', true)).toBe('dark');
    for (const theme of ['light', 'sepia', 'dark'] as const) {
      expect(resolveReadingTheme(theme, true)).toBe(theme);
      expect(resolveReadingTheme(theme, false)).toBe(theme);
    }
  });

  it('tints chrome for Sepia and Dark, and leaves Light to the system', () => {
    expect(readerChromeStyle('light')).toBeUndefined();
    for (const theme of ['sepia', 'dark'] as const satisfies ResolvedReadingTheme[]) {
      const style = readerChromeStyle(theme) as Record<string, string>;
      expect(style['--background']).toBe(CHROME_PALETTES[theme]?.background);
      expect(style['--muted-foreground']).toBe(CHROME_PALETTES[theme]?.mutedForeground);
      expect(style.colorScheme).toBe(PAGE_PALETTES[theme].colorScheme);
    }
  });

  it('tints PDF canvases for Dark and Sepia, and leaves Light paper alone', () => {
    expect(pdfCanvasFilter('light')).toBeUndefined();
    expect(pdfCanvasFilter('dark')).toContain('invert');
    expect(pdfCanvasFilter('sepia')).toContain('sepia');
  });

  it('keeps publisher fonts for Original and gives every other face fallbacks', () => {
    expect(fontStack('original')).toBeNull();
    for (const face of FONT_FACES.filter((candidate) => candidate.value !== 'original')) {
      expect(face.stack).toMatch(/(serif|sans-serif|monospace)$/);
    }
  });
});
