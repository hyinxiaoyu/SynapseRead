import { AArrowDown, AArrowUp, ALargeSmall, Check, ChevronRight } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_SERIF_STACK,
  FONT_FACES,
  PAGE_PALETTES,
} from '@/features/reader/appearance/themes';
import { ToolbarButton } from '@/features/reader/ReaderToolbar';
import { cn } from '@/lib/utils';
import type {
  PageTransition,
  ReadingMargins,
  ReadingPageWidth,
  ReadingPreferences,
  ReadingTheme,
} from '@/types/domain';

const FONT_SIZE_STEP = 10;
const MIN_FONT_SIZE = 75;
const MAX_FONT_SIZE = 200;
export const DEFAULT_FONT_SIZE = 100;

/** The font size one step bigger (`1`) or smaller (`-1`), clamped to the allowed range. */
export function steppedFontSize(fontSize: number, direction: 1 | -1): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize + direction * FONT_SIZE_STEP));
}

const THEMES: readonly { value: ReadingTheme; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
];

const LINE_SPACINGS: readonly { value: number; label: string }[] = [
  { value: 1.4, label: 'Compact' },
  { value: 1.75, label: 'Normal' },
  { value: 2.1, label: 'Relaxed' },
];

const MARGINS: readonly { value: ReadingMargins; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
];

const PAGE_WIDTHS: readonly { value: ReadingPageWidth; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full width' },
];

const PAGE_TRANSITIONS: readonly { value: PageTransition; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'slide', label: 'Slide' },
  { value: 'fade', label: 'Fade' },
  { value: 'flip', label: 'Flip' },
  { value: 'stack', label: 'Stack' },
];

export function useAppearancePanel() {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: useCallback(() => setOpen((current) => !current), []),
    close: useCallback(() => setOpen(false), []),
  };
}

/**
 * Radio semantics for a row of choices: one tab stop on the checked option, and
 * the arrow keys, Home, and End move and select.
 */
function useRadioGroup<T>(
  values: readonly T[],
  checkedIndex: number,
  onSelect: (value: T) => void,
) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIndex = Math.max(0, checkedIndex);
  return (index: number) => ({
    ref: (element: HTMLButtonElement | null) => {
      buttons.current[index] = element;
    },
    type: 'button' as const,
    role: 'radio',
    'aria-checked': index === checkedIndex,
    tabIndex: index === focusIndex ? 0 : -1,
    onClick: () => {
      const value = values[index];
      if (value !== undefined) onSelect(value);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = values.length - 1;
      if (next === null) return;
      event.preventDefault();
      const wrapped = (next + values.length) % values.length;
      const value = values[wrapped];
      if (value === undefined) return;
      onSelect(value);
      buttons.current[wrapped]?.focus();
    },
  });
}

function SectionLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mb-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

/** Text segments in a pill, the selected one solid (macOS segmented control). */
function TextChoices<T>({
  label,
  options,
  checkedIndex,
  onSelect,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  checkedIndex: number;
  onSelect: (value: T) => void;
}) {
  const id = useId();
  const radio = useRadioGroup(
    options.map((option) => option.value),
    checkedIndex,
    onSelect,
  );
  return (
    <div>
      <SectionLabel id={id}>{label}</SectionLabel>
      <div role="radiogroup" aria-labelledby={id} className="flex rounded-md bg-muted p-0.5">
        {options.map((option, index) => (
          <button
            key={option.label}
            {...radio(index)}
            className={cn(
              'h-7 flex-1 rounded-[5px] text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              index === checkedIndex
                ? 'bg-primary font-semibold text-primary-foreground shadow-xs'
                : 'text-foreground hover:bg-background/70',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className="flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex flex-col">
        <span className="font-medium text-foreground">{label}</span>
        {description && (
          <span id={descriptionId} className="text-[11px] text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
          checked ? 'border-primary bg-primary' : 'border-input bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute size-4 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}

/** A swatch in the theme's page colors; Auto shows Light and Dark halves. */
function swatchBackground(theme: ReadingTheme): string {
  if (theme === 'auto') {
    return `linear-gradient(135deg, ${PAGE_PALETTES.light.background} 50%, ${PAGE_PALETTES.dark.background} 50%)`;
  }
  return PAGE_PALETTES[theme].background;
}

function AppearancePanel({
  preferences,
  format,
  onChange,
}: {
  preferences: ReadingPreferences;
  format: 'epub' | 'txt';
  onChange: (patch: Partial<ReadingPreferences>) => void;
}) {
  const ids = { theme: useId(), font: useId(), customize: useId() };
  const [customizing, setCustomizing] = useState(false);
  const canDecrease = preferences.fontSize > MIN_FONT_SIZE;
  const canIncrease = preferences.fontSize < MAX_FONT_SIZE;
  const stepFontSize = (direction: 1 | -1) => {
    const next = steppedFontSize(preferences.fontSize, direction);
    if (next !== preferences.fontSize) onChange({ fontSize: next });
  };

  const themeIndex = THEMES.findIndex((theme) => theme.value === preferences.theme);
  const themeRadio = useRadioGroup(
    THEMES.map((theme) => theme.value),
    themeIndex,
    (theme) => onChange({ theme }),
  );
  const fontIndex = FONT_FACES.findIndex((face) => face.value === preferences.fontFamily);
  const fontRadio = useRadioGroup(
    FONT_FACES.map((face) => face.value),
    fontIndex,
    (fontFamily) => onChange({ fontFamily }),
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div role="group" aria-label="Text size" className="flex items-center rounded-md bg-muted">
        <button
          type="button"
          aria-label="Decrease font size"
          title="Smaller text (⌘−)"
          disabled={!canDecrease}
          onClick={() => stepFontSize(-1)}
          className="flex h-9 flex-1 items-center justify-center rounded-l-md text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-40 [&_svg]:size-4"
        >
          <AArrowDown aria-hidden="true" />
        </button>
        <span
          data-testid="reading-font-size"
          aria-live="polite"
          className="min-w-12 text-center text-xs font-medium text-foreground tabular-nums"
        >
          {preferences.fontSize}%
        </span>
        <button
          type="button"
          aria-label="Increase font size"
          title="Bigger text (⌘+)"
          disabled={!canIncrease}
          onClick={() => stepFontSize(1)}
          className="flex h-9 flex-1 items-center justify-center rounded-r-md text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-40 [&_svg]:size-5"
        >
          <AArrowUp aria-hidden="true" />
        </button>
      </div>

      <div>
        <SectionLabel id={ids.theme}>Theme</SectionLabel>
        <div role="radiogroup" aria-labelledby={ids.theme} className="flex justify-between px-1">
          {THEMES.map((theme, index) => {
            const checked = index === themeIndex;
            return (
              <button
                key={theme.value}
                {...themeRadio(index)}
                aria-label={theme.label}
                data-testid={`theme-swatch-${theme.value}`}
                className="group flex w-14 flex-col items-center gap-1 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-8 items-center justify-center rounded-full border border-black/20 shadow-xs',
                    checked && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                  )}
                  style={{
                    background: swatchBackground(theme.value),
                    color:
                      theme.value === 'auto'
                        ? PAGE_PALETTES.light.text
                        : PAGE_PALETTES[theme.value].text,
                  }}
                >
                  {checked && (
                    <Check
                      className="size-4"
                      strokeWidth={3}
                      style={
                        theme.value === 'auto'
                          ? { color: '#fff', mixBlendMode: 'difference' }
                          : undefined
                      }
                    />
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'text-[11px] text-muted-foreground',
                    checked && 'font-semibold text-foreground',
                  )}
                >
                  {theme.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <TextChoices
        label="Page width"
        options={PAGE_WIDTHS}
        checkedIndex={PAGE_WIDTHS.findIndex((width) => width.value === preferences.pageWidth)}
        onSelect={(pageWidth) => onChange({ pageWidth })}
      />

      <div>
        <SectionLabel id={ids.font}>Font</SectionLabel>
        <div
          role="radiogroup"
          aria-labelledby={ids.font}
          className="flex flex-col overflow-hidden rounded-md border"
        >
          {FONT_FACES.map((face, index) => {
            const checked = index === fontIndex;
            // TXT has no publisher fonts: `original` is the default serif.
            const label = face.value === 'original' && format === 'txt' ? 'Default' : face.label;
            return (
              <button
                key={face.value}
                {...fontRadio(index)}
                aria-label={label}
                data-testid={`font-option-${face.value}`}
                className={cn(
                  'flex h-8 items-center justify-between gap-2 px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  checked ? 'bg-accent font-semibold text-accent-foreground' : 'hover:bg-accent/60',
                )}
                style={{ fontFamily: face.stack ?? DEFAULT_SERIF_STACK }}
              >
                {label}
                {checked && <Check aria-hidden="true" className="size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={customizing}
          aria-controls={ids.customize}
          onClick={() => setCustomizing((current) => !current)}
          className="flex h-8 w-full items-center gap-1 rounded-md px-1 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              customizing && 'rotate-90',
            )}
          />
          Customize
        </button>
        {/*
          The disclosure stays mounted so `grid-template-rows` can transition
          between `0fr` and `1fr`: no JS measures it, and the WebKit we target
          has no `interpolate-size`. `inert` keeps the collapsed controls out of
          the tab order and the accessibility tree.
        */}
        <div
          id={ids.customize}
          inert={!customizing}
          aria-hidden={!customizing}
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
            customizing ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className="mt-2 flex flex-col gap-3">
              <TextChoices
                label="Line spacing"
                options={LINE_SPACINGS}
                checkedIndex={LINE_SPACINGS.findIndex(
                  (spacing) => Math.abs(preferences.lineSpacing - spacing.value) < 0.05,
                )}
                onSelect={(lineSpacing) => onChange({ lineSpacing })}
              />
              <TextChoices
                label="Margins"
                options={MARGINS}
                checkedIndex={MARGINS.findIndex((margin) => margin.value === preferences.margins)}
                onSelect={(margins) => onChange({ margins })}
              />
              <TextChoices
                label="Page turn"
                options={PAGE_TRANSITIONS}
                checkedIndex={PAGE_TRANSITIONS.findIndex(
                  (transition) => transition.value === preferences.pageTransition,
                )}
                onSelect={(pageTransition) => onChange({ pageTransition })}
              />
              <div className="flex flex-col gap-1">
                <Switch
                  label="Justify"
                  description="Even edges, hyphenated in the book's language"
                  checked={preferences.justify}
                  testId="justify-switch"
                  onChange={(justify) => onChange({ justify })}
                />
                {format === 'epub' && (
                  <Switch
                    label="Dim images in Dark theme"
                    checked={preferences.dimImages}
                    testId="dim-images-switch"
                    onChange={(dimImages) => onChange({ dimImages })}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The toolbar's "Aa" button and the popover it anchors (Books' typography
 * popover). Esc, a click outside, or the button again closes it, and focus
 * goes back to the button.
 */
export function AppearanceMenu({
  open,
  onToggle,
  onClose,
  preferences,
  onChange,
  format,
  disabled = false,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  preferences: ReadingPreferences;
  onChange: (patch: Partial<ReadingPreferences>) => void;
  format: 'epub' | 'txt';
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      onClose();
    };
    // A click into a chapter's iframe never reaches this window; it blurs it.
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) onClose();
    };
    // Capture, so Esc closes the popover before focus mode sees it.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, onClose]);

  // Toolbar compression can place Aa near either edge of the viewport.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!open || !panel || !root) return;
    const keepInViewport = () => {
      const right = root.getBoundingClientRect().right;
      const shift = Math.max(
        8 - right + panel.offsetWidth,
        Math.min(0, window.innerWidth - 8 - right),
      );
      panel.style.translate = `${shift}px`;
    };
    keepInViewport();
    window.addEventListener('resize', keepInViewport);
    return () => window.removeEventListener('resize', keepInViewport);
  }, [open]);

  // Opening moves focus into the popover; closing returns it to the button, unless
  // the click that closed it put focus somewhere else on purpose.
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) {
      panelRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    } else if (
      document.activeElement === null ||
      document.activeElement === document.body ||
      rootRef.current?.contains(document.activeElement)
    ) {
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <ToolbarButton
        icon={ALargeSmall}
        label="Reading appearance"
        command="view.appearance"
        pressed={open}
        disabled={disabled}
        onClick={onToggle}
        ariaHasPopup="dialog"
        ariaExpanded={open}
      />
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Appearance"
          data-testid="appearance-popover"
          data-reader-popover=""
          className="absolute top-full right-0 z-50 mt-2 max-h-[min(75vh,640px)] w-72 origin-top-right animate-in overflow-y-auto rounded-xl border bg-background p-3 text-foreground shadow-xl duration-150 fade-in-0 slide-in-from-top-1 select-none zoom-in-[0.96] motion-reduce:animate-none"
        >
          <AppearancePanel preferences={preferences} format={format} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
