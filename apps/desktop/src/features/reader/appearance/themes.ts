import type { CSSProperties } from 'react';

import type { ReadingFontFamily, ReadingTheme, ResolvedReadingTheme } from '@/types/domain';

/** What a reflowable page looks like in each theme. */
export interface PagePalette {
  background: string;
  text: string;
  /** Quiet text on the page, such as the progress footer. Meets AA on `background`. */
  secondaryText: string;
  /** Rules inside the page, such as a blockquote's left border. */
  border: string;
  /** The shadow along the spine between two pages. */
  spine: string;
  colorScheme: 'light' | 'dark';
}

export const PAGE_PALETTES: Record<ResolvedReadingTheme, PagePalette> = {
  light: {
    background: '#fbfaf7',
    text: '#1c1917',
    secondaryText: '#6b645c',
    border: 'rgba(28, 25, 23, 0.2)',
    spine: 'rgba(28, 25, 23, 0.08)',
    colorScheme: 'light',
  },
  sepia: {
    background: '#f4ecd8',
    text: '#433422',
    secondaryText: '#6e5737',
    border: 'rgba(67, 52, 34, 0.25)',
    spine: 'rgba(67, 52, 34, 0.12)',
    colorScheme: 'light',
  },
  dark: {
    background: '#18181b',
    text: '#e4e4e7',
    secondaryText: '#a1a1aa',
    border: 'rgba(228, 228, 231, 0.25)',
    spine: 'rgba(0, 0, 0, 0.55)',
    colorScheme: 'dark',
  },
};

/** The design tokens `index.css` defines, which reader chrome overrides per theme. */
export interface ChromePalette {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
}

/**
 * Chrome for the themes that tint the window, as Books does. Light has none: its
 * chrome is the system's, so it matches every other app in light or dark mode.
 */
export const CHROME_PALETTES: Readonly<Partial<Record<ResolvedReadingTheme, ChromePalette>>> = {
  sepia: {
    background: '#efe6d1',
    foreground: '#36291a',
    card: '#f4ecd8',
    cardForeground: '#36291a',
    primary: '#5a4327',
    primaryForeground: '#fbf6ea',
    secondary: '#e6dabf',
    secondaryForeground: '#36291a',
    muted: '#e6dabf',
    mutedForeground: '#65512f',
    accent: '#e2d4b6',
    accentForeground: '#36291a',
    border: '#d5c5a3',
    input: '#cdbb96',
    ring: '#7d6440',
  },
  dark: {
    background: '#1f1f22',
    foreground: '#e7e7ea',
    card: '#18181b',
    cardForeground: '#e7e7ea',
    primary: '#e4e4e7',
    primaryForeground: '#18181b',
    secondary: '#2c2c31',
    secondaryForeground: '#f4f4f5',
    muted: '#2c2c31',
    mutedForeground: '#a9a9b2',
    accent: '#34343a',
    accentForeground: '#f4f4f5',
    border: '#3a3a41',
    input: '#4a4a52',
    ring: '#9d9da6',
  },
};

const TOKEN_NAMES: Record<keyof ChromePalette, string> = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  cardForeground: '--card-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
};

export function resolveReadingTheme(
  theme: ReadingTheme,
  prefersDark: boolean,
): ResolvedReadingTheme {
  if (theme === 'auto') return prefersDark ? 'dark' : 'light';
  return theme;
}

/**
 * Overrides the design tokens for everything inside the element, so the toolbar,
 * tabs, and sidebar take the reading theme. Undefined keeps the system chrome.
 */
export function readerChromeStyle(theme: ResolvedReadingTheme): CSSProperties | undefined {
  const palette = CHROME_PALETTES[theme];
  if (!palette) return undefined;
  const style: Record<string, string> = { colorScheme: PAGE_PALETTES[theme].colorScheme };
  for (const [key, token] of Object.entries(TOKEN_NAMES)) {
    style[token] = palette[key as keyof ChromePalette];
  }
  return style as CSSProperties;
}

/** The progress footer under a reflowable page: the page's paper, quieter text. */
export function pageFooterStyle(theme: ResolvedReadingTheme): CSSProperties {
  const palette = PAGE_PALETTES[theme];
  return {
    backgroundColor: palette.background,
    color: palette.secondaryText,
    colorScheme: palette.colorScheme,
  };
}

/** The page's own colors, for the page and the margins around it. */
export function pageSurfaceStyle(theme: ResolvedReadingTheme): CSSProperties {
  const palette = PAGE_PALETTES[theme];
  return {
    backgroundColor: palette.background,
    color: palette.text,
    colorScheme: palette.colorScheme,
  };
}

/**
 * The CSS filter that tints a rendered PDF page canvas for a theme. Light keeps
 * the page's own paper, so it has none. The filter sits on the canvas element and
 * leaves the bitmap alone, so a rectangle capture still saves the original colors.
 */
export function pdfCanvasFilter(theme: ResolvedReadingTheme): string | undefined {
  switch (theme) {
    case 'dark':
      // Invert the paper to near-black and the ink to near-white, then put the
      // hues back so figures and photographs do not read as negatives.
      return 'invert(0.91) hue-rotate(180deg)';
    case 'sepia':
      return 'sepia(0.9) brightness(0.94)';
    default:
      return undefined;
  }
}

// CJK faces follow each Latin stack, so mixed text keeps a matching style.
const SERIF_FALLBACK = "Georgia, 'Songti SC', 'PingFang SC', serif";
const SANS_FALLBACK = "system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', 'PingFang SC', sans-serif";

/** The face TXT uses for `original`, and EPUB chapters that set none. */
export const DEFAULT_SERIF_STACK = `Charter, 'Iowan Old Style', 'Palatino Linotype', Palatino, ${SERIF_FALLBACK}`;

export interface FontFace {
  value: ReadingFontFamily;
  label: string;
  /** Null keeps the publisher's fonts. */
  stack: string | null;
}

/**
 * The faces Books offers that ship with macOS, each followed by a near match on
 * other platforms.
 */
export const FONT_FACES: readonly FontFace[] = [
  { value: 'original', label: 'Original', stack: null },
  { value: 'charter', label: 'Charter', stack: `Charter, 'Bitstream Charter', ${SERIF_FALLBACK}` },
  {
    value: 'iowan',
    label: 'Iowan Old Style',
    stack: `'Iowan Old Style', 'Palatino Linotype', ${SERIF_FALLBACK}`,
  },
  {
    value: 'palatino',
    label: 'Palatino',
    stack: `Palatino, 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', ${SERIF_FALLBACK}`,
  },
  { value: 'athelas', label: 'Athelas', stack: `Athelas, Charter, ${SERIF_FALLBACK}` },
  {
    value: 'new-york',
    label: 'New York',
    stack: `'New York', ui-serif, 'Iowan Old Style', ${SERIF_FALLBACK}`,
  },
  {
    value: 'seravek',
    label: 'Seravek',
    stack: `Seravek, 'Gill Sans Nova', Ubuntu, Calibri, ${SANS_FALLBACK}`,
  },
  {
    value: 'sf-pro',
    label: 'San Francisco',
    stack: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', ${SANS_FALLBACK}`,
  },
  {
    value: 'mono',
    label: 'Monospace',
    stack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'PingFang SC', monospace",
  },
];

/** The CSS stack for a face, or null to keep the publisher's. */
export function fontStack(family: ReadingFontFamily): string | null {
  return FONT_FACES.find((face) => face.value === family)?.stack ?? null;
}
