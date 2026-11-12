import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { dispatchEscape } from '@/features/commands/escape';

import { LinkPeek, type LinkPeekTarget } from './LinkPeek';

function setup(peek: LinkPeekTarget | null) {
  const boundsRef = createRef<HTMLDivElement>();
  const onGo = vi.fn();
  const onDismiss = vi.fn();
  const onReturnFocus = vi.fn();
  const view = render(
    <div ref={boundsRef}>
      <button type="button">outside</button>
      <LinkPeek
        peek={peek}
        boundsRef={boundsRef}
        onGo={onGo}
        onDismiss={onDismiss}
        onReturnFocus={onReturnFocus}
      />
    </div>,
  );
  return { ...view, onGo, onDismiss, onReturnFocus };
}

describe('LinkPeek', () => {
  it('shows nothing without a target', () => {
    setup(null);
    expect(screen.queryByTestId('link-peek')).toBeNull();
  });

  it('renders the text as text, so markup in a book or PDF stays inert', () => {
    const text =
      '<img src=x onerror="window.__linkPeekRan=1"><script>window.__linkPeekRan=1</script>';
    setup({ text, rect: null });
    const body = screen.getByTestId('link-peek-text');
    expect(body.textContent).toBe(text);
    expect(body.children).toHaveLength(0);
    expect(screen.getByTestId('link-peek').querySelector('img, script')).toBeNull();
    expect((window as unknown as { __linkPeekRan?: number }).__linkPeekRan).toBeUndefined();
  });

  it('is a labelled dialog with the keyboard on Go to Note', () => {
    const { onGo, onDismiss } = setup({ text: 'A note.', rect: null });
    expect(screen.getByRole('dialog', { name: 'Note' })).toHaveAccessibleDescription('A note.');
    const go = screen.getByRole('button', { name: 'Go to Note' });
    expect(go).toHaveFocus();
    fireEvent.click(go);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onGo).toHaveBeenCalledOnce();
  });

  it('goes away on Esc, here or forwarded from a chapter, a press outside, or a scroll', () => {
    const { onDismiss, onReturnFocus } = setup({ text: 'A note.', rect: null });
    fireEvent.keyDown(screen.getByTestId('link-peek-go'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReturnFocus).toHaveBeenCalledTimes(1);

    // An EPUB chapter forwards its Esc to the layers, not to the window.
    expect(dispatchEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(screen.getByTestId('link-peek-text'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onDismiss).toHaveBeenCalledTimes(3);

    // Scrolling a long note keeps the card; scrolling the page does not.
    fireEvent.scroll(screen.getByTestId('link-peek-text'));
    expect(onDismiss).toHaveBeenCalledTimes(3);
    fireEvent.scroll(window);
    expect(onDismiss).toHaveBeenCalledTimes(4);
  });
});
