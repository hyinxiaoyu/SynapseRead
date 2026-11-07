import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_READING_PREFERENCES, type ReadingPreferences } from '@/types/domain';

import { AppearanceMenu, steppedFontSize, useAppearancePanel } from './AppearancePopover';
import { fontStack } from './themes';

function Harness({
  initial = DEFAULT_READING_PREFERENCES,
  format = 'epub',
}: {
  initial?: ReadingPreferences;
  format?: 'epub' | 'txt';
}) {
  const panel = useAppearancePanel();
  const [preferences, setPreferences] = useState(initial);
  return (
    <div>
      <button type="button">Elsewhere</button>
      <AppearanceMenu
        open={panel.open}
        onToggle={panel.toggle}
        onClose={panel.close}
        preferences={preferences}
        onChange={(patch) => setPreferences((current) => ({ ...current, ...patch }))}
        format={format}
      />
      <output data-testid="preferences">{JSON.stringify(preferences)}</output>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Reading appearance' });
const popover = () => screen.queryByRole('dialog', { name: 'Appearance' });
const current = (): ReadingPreferences =>
  JSON.parse(screen.getByTestId('preferences').textContent ?? '{}') as ReadingPreferences;

describe('AppearanceMenu', () => {
  it('opens from the Aa button as a popover, and toggles closed', () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('title', 'Reading appearance');

    fireEvent.click(trigger());
    expect(popover()).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // Focus moves into the popover, onto the checked theme.
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveFocus();

    fireEvent.click(trigger());
    expect(popover()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes on Esc and returns focus to the button', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole('radio', { name: 'Auto' }).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(popover()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes on a click outside, and stays open for clicks inside', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole('radio', { name: 'Sepia' }));
    expect(popover()).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(popover()).not.toBeInTheDocument();
  });

  it('offers themes as labelled swatches with a selected state that is not color alone', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const themes = screen.getByRole('radiogroup', { name: 'Theme' });
    const swatches = within(themes).getAllByRole('radio');
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
      'Auto',
      'Light',
      'Sepia',
      'Dark',
    ]);
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');

    // Arrow keys move and select, as in any radio group.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Auto' }), { key: 'ArrowRight' });
    expect(current().theme).toBe('light');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'End' });
    expect(current().theme).toBe('dark');

    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect(dark).toHaveAttribute('aria-checked', 'true');
    // A check mark, not only a ring color.
    expect(dark.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Light' }).querySelector('svg')).toBeNull();
  });

  it('lists each font in its own face, with Original as the EPUB default', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const fonts = within(screen.getByRole('radiogroup', { name: 'Font' })).getAllByRole('radio');
    expect(fonts[0]).toHaveAccessibleName('Original');
    expect(fonts[0]).toHaveAttribute('aria-checked', 'true');
    const palatino = screen.getByRole('radio', { name: 'Palatino' });
    // The style serializes font names with double quotes.
    expect(palatino.style.fontFamily).toBe(fontStack('palatino')?.replaceAll("'", '"'));

    fireEvent.click(palatino);
    expect(current().fontFamily).toBe('palatino');
    expect(palatino).toHaveAttribute('aria-checked', 'true');
  });

  it('calls Original the default face in TXT, which has no publisher fonts', () => {
    render(<Harness format="txt" />);
    fireEvent.click(trigger());
    expect(screen.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'Original' })).not.toBeInTheDocument();
  });

  it('steps the text size with small and large A buttons, within bounds', () => {
    render(<Harness initial={{ ...DEFAULT_READING_PREFERENCES, fontSize: 190 }} />);
    fireEvent.click(trigger());
    const bigger = screen.getByRole('button', { name: 'Increase font size' });
    fireEvent.click(bigger);
    expect(current().fontSize).toBe(200);
    expect(bigger).toBeDisabled();
    expect(screen.getByTestId('reading-font-size')).toHaveTextContent('200%');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }));
    expect(current().fontSize).toBe(190);
    expect(steppedFontSize(75, -1)).toBe(75);
  });

  it('keeps line spacing, margins, and justification behind Customize', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const customize = screen.getByRole('button', { name: 'Customize' });
    expect(customize).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('radiogroup', { name: 'Margins' })).not.toBeInTheDocument();

    fireEvent.click(customize);
    expect(customize).toHaveAttribute('aria-expanded', 'true');
    const margins = screen.getByRole('radiogroup', { name: 'Margins' });
    expect(within(margins).getByRole('radio', { name: 'Normal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(within(margins).getByRole('radio', { name: 'Wide' }));
    expect(current().margins).toBe('wide');

    const spacing = screen.getByRole('radiogroup', { name: 'Line spacing' });
    fireEvent.click(within(spacing).getByRole('radio', { name: 'Compact' }));
    expect(current().lineSpacing).toBe(1.4);

    const justify = screen.getByRole('switch', { name: 'Justify' });
    expect(justify).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(justify);
    expect(current().justify).toBe(false);
    expect(justify).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('switch', { name: 'Dim images in Dark theme' }));
    expect(current().dimImages).toBe(true);
  });
});
