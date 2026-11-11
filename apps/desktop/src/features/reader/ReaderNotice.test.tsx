import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INFO_NOTICE_MS, NOTICE_FADE_MS, ReaderNotice, ReaderPopoverLayer } from './ReaderNotice';

describe('ReaderNotice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes from its button', () => {
    const onDismiss = vi.fn();
    render(
      <ReaderNotice tone="warning" onDismiss={onDismiss}>
        Bytes are not valid UTF-8.
      </ReaderNotice>,
    );
    expect(screen.getByText(/not valid UTF-8/)).toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fades an info notice after a few seconds', () => {
    const onDismiss = vi.fn();
    render(
      <ReaderNotice tone="info" testId="notice" onDismiss={onDismiss}>
        Some annotations are not shown.
      </ReaderNotice>,
    );
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS - 1));
    expect(screen.getByTestId('notice')).not.toHaveAttribute('data-fading');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('notice')).toHaveAttribute('data-fading', 'true');
    expect(screen.getByTestId('notice').className).toContain('opacity-0');
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(NOTICE_FADE_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds an info notice while the pointer or focus is on it', () => {
    const onDismiss = vi.fn();
    render(
      <ReaderNotice tone="info" testId="notice" onDismiss={onDismiss}>
        Some annotations are not shown.
      </ReaderNotice>,
    );
    const notice = screen.getByTestId('notice');
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS));
    expect(notice).toHaveAttribute('data-fading', 'true');
    // Reaching for it mid-fade brings it back.
    fireEvent.pointerEnter(notice);
    expect(notice).not.toHaveAttribute('data-fading');
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerLeave(notice);
    act(() => screen.getByRole('button', { name: 'Close notice' }).focus());
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => screen.getByRole('button', { name: 'Close notice' }).blur());
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS));
    act(() => vi.advanceTimersByTime(NOTICE_FADE_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps a warning until it is closed', () => {
    const onDismiss = vi.fn();
    render(
      <ReaderNotice tone="warning" testId="notice" onDismiss={onDismiss}>
        That excerpt could not be found.
      </ReaderNotice>,
    );
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS * 10));
    expect(screen.getByTestId('notice')).not.toHaveAttribute('data-fading');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('waits out focus mode, then starts its timer afresh', () => {
    const onDismiss = vi.fn();
    const notice = (
      <ReaderNotice tone="info" onDismiss={onDismiss}>
        Some annotations are not shown.
      </ReaderNotice>
    );
    const { rerender } = render(<ReaderPopoverLayer hidden>{notice}</ReaderPopoverLayer>);
    expect(screen.queryByText(/not shown/)).toBeNull();
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<ReaderPopoverLayer hidden={false}>{notice}</ReaderPopoverLayer>);
    expect(screen.getByText(/not shown/)).toBeVisible();
    act(() => vi.advanceTimersByTime(INFO_NOTICE_MS));
    act(() => vi.advanceTimersByTime(NOTICE_FADE_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
