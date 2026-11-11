import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCommands, runCommand } from '@/features/commands/registry';
import type { WindowChromeStyle } from '@/lib/backend/types';

import { AUTO_HIDE_DELAY_MS, UnifiedToolbar, toolbarShowsCommand } from './UnifiedToolbar';

function renderToolbar({
  immersive = true,
  hasReaderSelection = false,
  chromeStyle = 'standard',
  fullscreen = false,
  workspaceControls = <button type="button">Show MindMap</button>,
}: {
  immersive?: boolean;
  hasReaderSelection?: boolean;
  chromeStyle?: WindowChromeStyle;
  fullscreen?: boolean;
  workspaceControls?: ReactNode;
} = {}) {
  return render(
    <UnifiedToolbar
      chromeStyle={chromeStyle}
      fullscreen={fullscreen}
      immersive={immersive}
      hasReaderSelection={hasReaderSelection}
      fallbackTitle="My Notebook"
      showFallbackTitle
      workspaceControls={workspaceControls}
      onSlotsChange={() => undefined}
    />,
  );
}

const toolbar = () => screen.getByTestId('unified-toolbar');
const idle = () => act(() => vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS + 10));

describe('UnifiedToolbar', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('never hides outside focus mode', () => {
    renderToolbar({ immersive: false });
    idle();
    expect(toolbar()).not.toHaveAttribute('data-hidden');
  });

  it('hides after 3 s idle in focus mode and returns at the top edge', () => {
    renderToolbar();
    act(() => vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS - 100));
    expect(toolbar()).not.toHaveAttribute('data-hidden');
    idle();
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');
    expect(toolbar()).toHaveAttribute('inert');

    // Movement elsewhere does not bring it back.
    fireEvent.pointerMove(window, { clientY: 400 });
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');
    fireEvent.pointerMove(window, { clientY: 4 });
    expect(toolbar()).not.toHaveAttribute('data-hidden');

    idle();
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');
    // Over an iframe the window sees no pointer events, so an edge strip catches them.
    fireEvent.pointerEnter(screen.getByTestId('toolbar-reveal-edge'));
    expect(toolbar()).not.toHaveAttribute('data-hidden');
  });

  it('keeps counting down while there is activity, and a command it shows reveals it', () => {
    const stop = registerCommands(() => ({ 'bookmarks.toggle': { run: () => undefined } }));
    renderToolbar({
      workspaceControls: (
        <button type="button" data-command="bookmarks.toggle">
          Bookmark
        </button>
      ),
    });
    act(() => vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS - 500));
    fireEvent.keyDown(window, { key: 'j' });
    act(() => vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS - 500));
    expect(toolbar()).not.toHaveAttribute('data-hidden');
    idle();
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');

    act(() => {
      runCommand('bookmarks.toggle', 'keyboard');
    });
    expect(toolbar()).not.toHaveAttribute('data-hidden');
    stop();
  });

  it('stays hidden for page turns and commands it does not show (#45)', () => {
    const stop = registerCommands(() => ({
      'go.nextPage': { run: () => undefined },
      'go.back': { run: () => undefined },
      'edit.highlight': { run: () => undefined },
    }));
    renderToolbar({
      // Back has a toolbar button, but a jump shows on the page.
      workspaceControls: (
        <button type="button" data-command="go.back">
          Back
        </button>
      ),
    });
    idle();
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');
    for (const id of ['go.nextPage', 'go.back', 'edit.highlight'] as const) {
      act(() => {
        runCommand(id, 'keyboard');
      });
      expect(toolbar(), id).toHaveAttribute('data-hidden', 'true');
    }
    stop();
  });

  it('knows which commands it shows, including several on one control', () => {
    const header = document.createElement('header');
    header.innerHTML = `
      <button data-command="view.zoomIn"></button>
      <div data-command="edit.find edit.findNext"></div>
      <button data-command="go.forward"></button>`;
    expect(toolbarShowsCommand(header, 'view.zoomIn')).toBe(true);
    expect(toolbarShowsCommand(header, 'edit.findNext')).toBe(true);
    expect(toolbarShowsCommand(header, 'edit.findPrevious')).toBe(false);
    expect(toolbarShowsCommand(header, 'go.forward')).toBe(false);
    expect(toolbarShowsCommand(null, 'view.zoomIn')).toBe(false);
  });

  it('is 48 px tall, the band a paged reader keeps clear in focus mode', () => {
    renderToolbar();
    expect(toolbar().style.height).toBe('48px');
  });

  it('stays while a popover is open or text is selected', () => {
    const { rerender } = renderToolbar({ hasReaderSelection: true });
    idle();
    idle();
    expect(toolbar()).not.toHaveAttribute('data-hidden');

    rerender(
      <UnifiedToolbar
        chromeStyle="standard"
        fullscreen={false}
        immersive
        hasReaderSelection={false}
        fallbackTitle="My Notebook"
        showFallbackTitle
        workspaceControls={null}
        onSlotsChange={() => undefined}
      />,
    );
    const popover = document.createElement('div');
    popover.dataset.readerPopover = '';
    document.body.append(popover);
    idle();
    expect(toolbar()).not.toHaveAttribute('data-hidden');
    popover.remove();
    idle();
    expect(toolbar()).toHaveAttribute('data-hidden', 'true');
  });

  it('skips the fade for reduced motion and leaves room for macOS window controls', () => {
    renderToolbar({ immersive: false, chromeStyle: 'overlay' });
    const header = toolbar();
    expect(header.className).toContain('motion-safe:transition-[opacity,translate]');
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header.style.paddingLeft).toBe('84px');
  });

  it('uses a standard frame elsewhere and in full screen', () => {
    renderToolbar({ immersive: false, chromeStyle: 'overlay', fullscreen: true });
    expect(toolbar().style.paddingLeft).toBe('');
    document.body.innerHTML = '';
    renderToolbar({ immersive: false });
    expect(screen.getAllByTestId('unified-toolbar').at(-1)).not.toHaveAttribute(
      'data-tauri-drag-region',
    );
  });
});
