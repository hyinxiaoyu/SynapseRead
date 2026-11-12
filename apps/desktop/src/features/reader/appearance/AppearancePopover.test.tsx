import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_READING_PREFERENCES, type ReadingPreferences } from '@/types/domain';

import { AppearanceMenu, steppedFontSize, useAppearancePanel } from './AppearancePopover';
import { fontStack } from './themes';

function Harness({
  initial = DEFAULT_READING_PREFERENCES,
  format = 'epub',
}: {
  initial?: ReadingPreferences;
  format?: 'epub' | 'txt' | 'pdf';
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

  it('keeps the appearance choices within the viewport near either toolbar edge', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ right: 220 } as DOMRect);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(288);
    try {
      render(<Harness />);
      fireEvent.click(trigger());
      expect(popover()).toHaveClass('animate-in', 'animation-duration-150');
      expect(popover()).not.toHaveClass('duration-150');
      expect(popover()?.style.translate).toBe('76px');
      rect.mockReturnValue({ right: window.innerWidth + 20 } as DOMRect);
      fireEvent(window, new Event('resize'));
      expect(popover()?.style.translate).toBe('-28px');
    } finally {
      rect.mockRestore();
      width.mockRestore();
    }
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

  it('offers a PDF only the controls that apply, with the tint switch off by default', () => {
    render(<Harness format="pdf" />);
    fireEvent.click(trigger());
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Page turn' })).toBeInTheDocument();
    const tint = screen.getByTestId('tint-pdf-switch');
    expect(tint).toHaveAttribute('aria-checked', 'false');
    // A bitmap has no text size, page width, or publisher font to change.
    expect(screen.queryByTestId('reading-font-size')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Page width' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Font' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();

    fireEvent.click(tint);
    expect(current().tintPdfPages).toBe(true);
    expect(tint).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Fade' }));
    expect(current().pageTransition).toBe('fade');
    fireEvent.click(screen.getByTestId('theme-swatch-dark'));
    expect(current().theme).toBe('dark');
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

  it.each(['txt', 'epub'] as const)(
    'adjusts page width by keyboard in %s without changing margins',
    (format) => {
      render(<Harness format={format} />);
      fireEvent.click(trigger());
      const widths = within(screen.getByRole('radiogroup', { name: 'Page width' }));
      const standard = widths.getByRole('radio', { name: 'Standard' });
      expect(standard).toHaveAttribute('aria-checked', 'true');
      fireEvent.keyDown(standard, { key: 'ArrowRight' });
      expect(current().pageWidth).toBe('wide');
      expect(widths.getByRole('radio', { name: 'Wide' })).toHaveFocus();
      fireEvent.keyDown(widths.getByRole('radio', { name: 'Wide' }), { key: 'End' });
      expect(current().pageWidth).toBe('full');
      expect(current().margins).toBe('normal');
      expect(widths.getByRole('radio', { name: 'Full width' })).toHaveFocus();
    },
  );

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

  it.each(['epub', 'txt', 'pdf'] as const)(
    'offers "Focus mode uses full screen" in %s, off by default',
    (format) => {
      render(<Harness format={format} />);
      fireEvent.click(trigger());
      // EPUB and TXT keep it behind Customize; the PDF panel has no disclosure.
      if (format !== 'pdf') fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      const toggle = screen.getByRole('switch', { name: 'Focus mode uses full screen' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(toggle);
      expect(current().focusModeFullScreen).toBe(true);
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    },
  );

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

  it('offers every page-turn mode and reports the one chosen', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const turns = within(screen.getByRole('radiogroup', { name: 'Page turn' }));
    expect(turns.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      'None',
      'Slide',
      'Fade',
      'Flip',
      'Stack',
    ]);
    expect(turns.getByRole('radio', { name: 'Slide' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(turns.getByRole('radio', { name: 'Flip' }));
    expect(current().pageTransition).toBe('flip');
    fireEvent.click(turns.getByRole('radio', { name: 'Stack' }));
    expect(current().pageTransition).toBe('stack');
  });

  it('keeps the Customize disclosure mounted but inert while it is closed', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const customize = screen.getByRole('button', { name: 'Customize' });
    const disclosure = document.getElementById(customize.getAttribute('aria-controls') ?? '');
    // Mounted, so `grid-template-rows` has something to grow into...
    expect(disclosure).not.toBeNull();
    // ...but out of the tab order and the accessibility tree.
    expect(disclosure).toHaveAttribute('inert');
    expect(disclosure).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('radiogroup', { name: 'Margins' })).not.toBeInTheDocument();

    fireEvent.click(customize);
    expect(disclosure).not.toHaveAttribute('inert');
    expect(disclosure).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByRole('radiogroup', { name: 'Margins' })).toBeInTheDocument();
  });
});
