import { Minus, Plus, Type } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ToolbarButton } from '@/features/reader/ReaderToolbar';
import { cn } from '@/lib/utils';
import type {
  ReadingFontFamily,
  ReadingPreferences,
  ReadingTheme,
  ReadingWidth,
} from '@/types/domain';

export const THEME_SURFACE_CLASSES: Record<ReadingTheme, string> = {
  light: 'bg-[#fbfaf7] text-[#1c1917]',
  sepia: 'bg-[#f4ecd8] text-[#433422]',
  dark: 'bg-[#18181b] text-[#e4e4e7]',
};

export const FONT_FAMILY_CSS: Record<ReadingFontFamily, string> = {
  serif:
    "Charter, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', 'PingFang SC', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'PingFang SC', monospace",
};

export const READING_WIDTH_CLASSES: Record<ReadingWidth, string> = {
  narrow: 'max-w-2xl',
  medium: 'max-w-6xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

const THEMES: readonly { value: ReadingTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
];

const FONT_FAMILIES: readonly { value: ReadingFontFamily; label: string }[] = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' },
  { value: 'mono', label: 'Mono' },
];

const LINE_SPACINGS: readonly { value: number; label: string }[] = [
  { value: 1.4, label: 'Compact' },
  { value: 1.75, label: 'Normal' },
  { value: 2.1, label: 'Relaxed' },
];

const READING_WIDTHS: readonly { value: ReadingWidth; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'medium', label: 'Medium' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
];

const FONT_SIZE_STEP = 10;
const MIN_FONT_SIZE = 75;
const MAX_FONT_SIZE = 200;
export const DEFAULT_FONT_SIZE = 100;

/** The font size one step bigger (`1`) or smaller (`-1`), clamped to the allowed range. */
export function steppedFontSize(fontSize: number, direction: 1 | -1): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize + direction * FONT_SIZE_STEP));
}

export interface ReadingPreferencesToolbarProps {
  preferences: ReadingPreferences;
  disabled?: boolean;
  onChange: (patch: Partial<ReadingPreferences>) => void;
}

export function ReadingPreferencesToggleButton({
  open,
  disabled = false,
  onToggle,
}: {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <ToolbarButton
      icon={Type}
      label="Reading appearance"
      command="view.appearance"
      pressed={open}
      disabled={disabled}
      onClick={onToggle}
    />
  );
}

export function ReadingPreferencesBar({
  preferences,
  disabled = false,
  onChange,
}: ReadingPreferencesToolbarProps) {
  const canDecreaseFont = preferences.fontSize > MIN_FONT_SIZE;
  const canIncreaseFont = preferences.fontSize < MAX_FONT_SIZE;

  const stepFontSize = (delta: number) => {
    const next = steppedFontSize(preferences.fontSize, delta > 0 ? 1 : -1);
    if (next !== preferences.fontSize) {
      onChange({ fontSize: next });
    }
  };

  return (
    <div
      role="region"
      aria-label="Appearance settings"
      data-testid="reading-preferences-bar"
      data-reader-popover=""
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b bg-background px-3 py-1.5 text-xs text-foreground"
    >
      <div role="group" aria-label="Theme" className="flex items-center gap-1">
        <span className="text-muted-foreground">Theme</span>
        {THEMES.map(({ value, label }) => {
          const active = preferences.theme === value;
          return (
            <Button
              key={value}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={active}
              disabled={disabled}
              className="h-7 px-2"
              onClick={() => onChange({ theme: value })}
            >
              {label}
            </Button>
          );
        })}
      </div>

      <div role="group" aria-label="Font family" className="flex items-center gap-1">
        <span className="text-muted-foreground">Font</span>
        {FONT_FAMILIES.map(({ value, label }) => {
          const active = preferences.fontFamily === value;
          return (
            <Button
              key={value}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={active}
              disabled={disabled}
              className="h-7 px-2"
              onClick={() => onChange({ fontFamily: value })}
            >
              {label}
            </Button>
          );
        })}
      </div>

      <div role="group" aria-label="Font size" className="flex items-center gap-1">
        <span className="text-muted-foreground">Size</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Decrease font size"
          disabled={disabled || !canDecreaseFont}
          className="size-7"
          onClick={() => stepFontSize(-FONT_SIZE_STEP)}
        >
          <Minus />
        </Button>
        <span
          data-testid="reading-font-size"
          className="min-w-10 text-center font-medium tabular-nums"
        >
          {preferences.fontSize}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Increase font size"
          disabled={disabled || !canIncreaseFont}
          className="size-7"
          onClick={() => stepFontSize(FONT_SIZE_STEP)}
        >
          <Plus />
        </Button>
      </div>

      <div role="group" aria-label="Line spacing" className="flex items-center gap-1">
        <span className="text-muted-foreground">Spacing</span>
        {LINE_SPACINGS.map(({ value, label }) => {
          const active = Math.abs(preferences.lineSpacing - value) < 0.05;
          return (
            <Button
              key={value}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={active}
              disabled={disabled}
              className="h-7 px-2"
              onClick={() => onChange({ lineSpacing: value })}
            >
              {label}
            </Button>
          );
        })}
      </div>

      <div role="group" aria-label="Reading width" className="flex items-center gap-1">
        <span className="text-muted-foreground">Width</span>
        {READING_WIDTHS.map(({ value, label }) => {
          const active = preferences.readingWidth === value;
          return (
            <Button
              key={value}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={active}
              disabled={disabled}
              className={cn('h-7 px-2', active && 'font-medium')}
              onClick={() => onChange({ readingWidth: value })}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function useReadingPreferencesPanel() {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
  };
}
