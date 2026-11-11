import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDismissOnOutside } from './useDismissOnOutside';

function Popover({
  open,
  onClose,
  withRoot = true,
  stopPropagation = false,
}: {
  open: boolean;
  onClose: () => void;
  withRoot?: boolean;
  stopPropagation?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, onClose, withRoot ? { rootRef, stopPropagation } : {});
  return (
    <>
      <div ref={rootRef}>
        <button type="button">inside</button>
      </div>
      <button type="button">outside</button>
    </>
  );
}

describe('useDismissOnOutside', () => {
  afterEach(() => {
    for (const frame of document.querySelectorAll('iframe')) frame.remove();
  });

  it('closes on Esc in the capture phase, before the focused element sees it', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} stopPropagation />);
    const inside = screen.getByRole('button', { name: 'inside' });
    const reachedTarget = vi.fn();
    inside.addEventListener('keydown', reachedTarget);
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reachedTarget).not.toHaveBeenCalled();
  });

  it('leaves an Esc another handler already took alone', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a press outside its root, not inside it', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'inside' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores presses when it has no root', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} withRoot={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the window blurs into an iframe, not when it blurs to another app', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new FocusEvent('blur'));
    });
    expect(onClose).not.toHaveBeenCalled();

    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.focus();
    act(() => {
      window.dispatchEvent(new FocusEvent('blur'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does nothing while closed', () => {
    const onClose = vi.fn();
    render(<Popover open={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
