import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LanSyncDialog } from '@/features/lanSync/LanSyncDialog';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('LanSyncDialog', () => {
  it('captures initial focus, restores it on close, and closes on Escape or backdrop click', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <LanSyncDialog
            open={open}
            title="Test Modal"
            description="Modal description"
            onClose={() => setOpen(false)}
            testId="test-modal"
            footer={
              <button type="button" onClick={() => setOpen(false)}>
                Confirm
              </button>
            }
          >
            <input aria-label="First input" />
            <button type="button">Middle action</button>
          </LanSyncDialog>
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const dialog = screen.getByTestId('test-modal');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Close button in header is the first focusable element when initialFocusRef is omitted.
    expect(screen.getByRole('button', { name: 'Close Test Modal' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('test-modal')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    // Reopen and close via backdrop mousedown.
    fireEvent.click(trigger);
    expect(screen.getByTestId('test-modal')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('test-modal-backdrop'));
    expect(screen.queryByTestId('test-modal')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('respects initialFocusRef and traps Tab and Shift+Tab focus within the modal', () => {
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <div>
          <button type="button">Outside button</button>
          <LanSyncDialog
            open
            title="Trapped Modal"
            onClose={() => undefined}
            initialFocusRef={inputRef}
            testId="trapped-modal"
            footer={<button type="button">Finish</button>}
          >
            <input ref={inputRef} aria-label="Target input" />
          </LanSyncDialog>
        </div>
      );
    }

    render(<Harness />);
    const closeBtn = screen.getByRole('button', { name: 'Close Trapped Modal' });
    const input = screen.getByLabelText('Target input');
    const finishBtn = screen.getByRole('button', { name: 'Finish' });
    const outsideBtn = screen.getByRole('button', { name: 'Outside button' });

    expect(input).toHaveFocus();

    // Shift+Tab from first focusable element wraps to last.
    closeBtn.focus();
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(finishBtn).toHaveFocus();

    // Tab from last focusable element wraps to first.
    const forwardTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(closeBtn).toHaveFocus();

    // Focus that somehow escaped outside is pulled back inside on Tab.
    outsideBtn.focus();
    expect(outsideBtn).toHaveFocus();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true }),
    );
    expect(closeBtn).toHaveFocus();
  });

  it('blocks Escape, backdrop click, and close button when dismissible is false', () => {
    const onClose = vi.fn();
    render(
      <LanSyncDialog
        open
        title="Locked Modal"
        onClose={onClose}
        dismissible={false}
        dismissBlockedHint="Cancel the active transfer before closing."
        testId="locked-modal"
      >
        <p>Transferring…</p>
      </LanSyncDialog>,
    );

    const closeBtn = screen.getByRole('button', { name: 'Close Locked Modal' });
    expect(closeBtn).toBeDisabled();
    expect(closeBtn).toHaveAttribute('title', 'Cancel the active transfer before closing.');

    const esc = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);

    fireEvent.mouseDown(screen.getByTestId('locked-modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
