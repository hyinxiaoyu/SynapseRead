import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KeyboardShortcutsDialog } from '@/features/commands/KeyboardShortcutsDialog';

describe('KeyboardShortcutsDialog', () => {
  it('lists a command’s key equivalent and its keyboard-only aliases', () => {
    render(<KeyboardShortcutsDialog onClose={() => undefined} />);

    // Space, Page Up, and Page Down were never shown before (#50).
    const nextPage = screen.getByText('Next Page').closest('div');
    expect(nextPage).toHaveTextContent('Space');
    expect(nextPage).toHaveTextContent('Page Down');
    const previousPage = screen.getByText('Previous Page').closest('div');
    expect(previousPage).toHaveTextContent('Page Up');

    // The new commands are discoverable, and so is the selection actions key.
    expect(screen.getByText('Reopen Closed Tab')).toBeInTheDocument();
    expect(screen.getByText('Add Note to Selection')).toBeInTheDocument();
    expect(screen.getByText('Capture Area')).toBeInTheDocument();
    expect(screen.getByText('Table of Contents')).toBeInTheDocument();
  });

  it('closes on Esc', () => {
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    render(<KeyboardShortcutsDialog onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(true);
  });
});
