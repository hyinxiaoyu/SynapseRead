import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GoToField, parseGoToInput, useGoToField } from './GoToField';

describe('parseGoToInput', () => {
  it.each([
    ['42', 'line', { kind: 'line', line: 42 }],
    [' 7 ', 'line', { kind: 'line', line: 7 }],
    ['42', 'percent', { kind: 'percent', percent: 42 }],
    ['50%', 'line', { kind: 'percent', percent: 50 }],
    ['12.5 %', 'line', { kind: 'percent', percent: 12.5 }],
    ['12,5%', 'percent', { kind: 'percent', percent: 12.5 }],
    ['３０％', 'line', null],
    ['30％', 'line', { kind: 'percent', percent: 30 }],
    ['0%', 'line', { kind: 'percent', percent: 0 }],
    ['100%', 'percent', { kind: 'percent', percent: 100 }],
  ] as const)('%j as %s is %j', (text, bare, expected) => {
    expect(parseGoToInput(text, bare)).toEqual(expected);
  });

  it.each([
    ['', 'line'],
    ['0', 'line'],
    ['101%', 'line'],
    ['101', 'percent'],
    ['-3', 'line'],
    ['abc', 'line'],
    ['4 5', 'line'],
    ['1e3', 'line'],
  ] as const)('%j as %s is refused', (text, bare) => {
    expect(parseGoToInput(text, bare)).toBeNull();
  });
});

function Field({
  onGo,
  onReturnFocus,
}: {
  onGo: (text: string) => boolean;
  onReturnFocus: () => void;
}) {
  const goTo = useGoToField();
  return (
    <>
      <button type="button" onClick={goTo.focus}>
        go.page
      </button>
      <GoToField
        inputRef={goTo.inputRef}
        label="Go to line or percentage"
        tooltipLabel="Go to line"
        placeholder="Line or %"
        onGo={onGo}
        onReturnFocus={onReturnFocus}
      />
    </>
  );
}

describe('GoToField', () => {
  it('goes on Return, refuses what names nowhere, and leaves on Esc', () => {
    const onGo = vi.fn((text: string) => text !== '999');
    const onReturnFocus = vi.fn();
    render(<Field onGo={onGo} onReturnFocus={onReturnFocus} />);
    const input = screen.getByRole('textbox', { name: 'Go to line or percentage' });

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'go.page' }));
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionEnd).toBe(2);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onGo).toHaveBeenLastCalledWith('12');
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('999');
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
    // Editing clears the mark.
    fireEvent.change(input, { target: { value: '99' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');

    const esc = fireEvent.keyDown(input, { key: 'Escape' });
    expect(esc).toBe(false);
    expect(onReturnFocus).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue('');
    expect(onGo).toHaveBeenCalledTimes(2);
  });

  it('only gives the keyboard back for an empty Return, and ignores an IME commit', () => {
    const onGo = vi.fn(() => true);
    const onReturnFocus = vi.fn();
    render(<Field onGo={onGo} onReturnFocus={onReturnFocus} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onGo).not.toHaveBeenCalled();
    expect(onReturnFocus).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onGo).not.toHaveBeenCalled();
  });
});
