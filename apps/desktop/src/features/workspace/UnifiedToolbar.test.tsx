import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCommands, runCommand } from '@/features/commands/registry';
import { GoToField, useGoToField } from '@/features/reader/GoToField';
import type { WindowChromeStyle } from '@/lib/backend/types';

import {
  AUTO_HIDE_DELAY_MS,
  UnifiedToolbar,
  titleWidth,
  toolbarShowsCommand,
} from './UnifiedToolbar';

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

  it('comes back for Go To, and the box takes the keyboard once it is no longer inert', () => {
    // A browser ignores focus() inside an inert subtree; jsdom does not, so do as it does.
    const focus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (!this.closest('[inert]')) focus.call(this, options);
    });
    let focusGoTo = () => undefined as void;
    function GoTo() {
      const goTo = useGoToField();
      focusGoTo = goTo.focus;
      return (
        <GoToField
          inputRef={goTo.inputRef}
          label="Go to"
          tooltipLabel="Go to"
          placeholder="%"
          onGo={() => true}
          onReturnFocus={() => undefined}
        />
      );
    }
    const stop = registerCommands(() => ({ 'go.page': { run: () => focusGoTo() } }));
    renderToolbar({ workspaceControls: <GoTo /> });
    idle();
    expect(toolbar()).toHaveAttribute('inert');

    act(() => {
      runCommand('go.page', 'keyboard');
    });
    expect(toolbar()).not.toHaveAttribute('inert');
    expect(screen.getByTestId('go-to-input')).toHaveFocus();
    stop();
    spy.mockRestore();
  });

  it('knows which commands it shows, including several on one control', () => {
    const header = document.createElement('header');
    header.innerHTML = `
      <button data-command="view.zoomIn"></button>
      <div data-command="edit.find edit.findNext"></div>
      <button data-command="go.forward"></button>
      <input data-command="go.page">`;
    expect(toolbarShowsCommand(header, 'view.zoomIn')).toBe(true);
    expect(toolbarShowsCommand(header, 'edit.findNext')).toBe(true);
    expect(toolbarShowsCommand(header, 'edit.findPrevious')).toBe(false);
    expect(toolbarShowsCommand(header, 'go.forward')).toBe(false);
    // Go To moves the keyboard into the toolbar, so it is the one `go.*` that shows.
    expect(toolbarShowsCommand(header, 'go.page')).toBe(true);
    expect(toolbarShowsCommand(null, 'view.zoomIn')).toBe(false);
  });

  it('does not count a control collapsed into the overflow menu', () => {
    const header = document.createElement('header');
    // As the container queries leave a collapsed button: in the DOM, not laid out.
    header.innerHTML = `
      <div style="display: none"><button data-command="view.toggleSidebar"></button></div>
      <button data-command="view.zoomIn" style="display: none"></button>
      <button data-command="view.zoomIn"></button>`;
    document.body.append(header);
    expect(toolbarShowsCommand(header, 'view.toggleSidebar')).toBe(false);
    // One visible control for the command is enough.
    expect(toolbarShowsCommand(header, 'view.zoomIn')).toBe(true);
    header.remove();
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
    // The inset lives on the leading column, so it does not offset the centered title.
    expect(screen.getByTestId('toolbar-leading').style.paddingLeft).toBe('84px');
  });

  it('uses a standard frame elsewhere and in full screen', () => {
    renderToolbar({ immersive: false, chromeStyle: 'overlay', fullscreen: true });
    expect(screen.getByTestId('toolbar-leading').style.paddingLeft).toBe('');
    document.body.innerHTML = '';
    renderToolbar({ immersive: false });
    expect(screen.getAllByTestId('unified-toolbar').at(-1)).not.toHaveAttribute(
      'data-tauri-drag-region',
    );
  });

  it('measures vertical stacks, nested flex rows, and pixel max-width caps in the center slot', () => {
    const setScrollWidth = (element: Element, value: number) => {
      Object.defineProperty(element, 'scrollWidth', { configurable: true, value });
    };

    const slot = document.createElement('div');
    slot.style.display = 'flex';
    slot.style.columnGap = '4px';
    expect(titleWidth(slot)).toBe(0);

    // Mirrors PdfViewer's center slot inside a `display: contents` portal wrapper:
    // a vertical stack whose second line is a horizontal form with a capped subtitle.
    slot.innerHTML = `
      <div style="display: contents">
        <div style="display: flex; flex-direction: column">
          <span id="doc-title">a.pdf</span>
          <form id="page-form" style="display: flex; column-gap: 4px; max-width: 100%">
            <span id="chapter" style="max-width: 192px">Long chapter ·</span>
            <label id="page-label">Page</label>
            <input id="page-input" style="border: 1px solid" />
            <span id="page-count">of 300</span>
          </form>
        </div>
      </div>
      <span id="badge">Badge</span>`;
    document.body.append(slot);

    setScrollWidth(slot.querySelector('#doc-title')!, 40);
    // Even if the form shrank to 150px in the narrow fallback layout, its items sum
    // back to their natural row width, and the 400px chapter caps at 192px (`max-w-48`).
    setScrollWidth(slot.querySelector('#page-form')!, 150);
    setScrollWidth(slot.querySelector('#chapter')!, 400);
    setScrollWidth(slot.querySelector('#page-label')!, 28);
    setScrollWidth(slot.querySelector('#page-input')!, 34); // + 2px border = 36
    setScrollWidth(slot.querySelector('#page-count')!, 40);
    setScrollWidth(slot.querySelector('#badge')!, 30);

    // Form row: 192 + 28 + 36 + 40 + 3 * 4 = 308; outer slot row: 308 + 4 + 30 = 342.
    expect(titleWidth(slot)).toBe(342);
    slot.remove();
  });

  it('slides with relative positioning and re-measures when a control animates its width', async () => {
    const observed = new Set<Element>();
    let triggerResize: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () => callback([], this);
        }
        observe(target: Element) {
          observed.add(target);
        }
        unobserve(target: Element) {
          observed.delete(target);
        }
        disconnect() {
          observed.clear();
        }
      },
    );

    const mockBox = (element: Element, left: number, right: number) => {
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            left,
            right,
            top: 0,
            bottom: 48,
            width: right - left,
            height: 48,
            x: left,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      );
    };

    try {
      render(
        <UnifiedToolbar
          chromeStyle="standard"
          fullscreen={false}
          immersive={false}
          hasReaderSelection={false}
          fallbackTitle={<span>My Notebook</span>}
          showFallbackTitle
          workspaceControls={<button type="button">Show MindMap</button>}
          onSlotsChange={() => undefined}
        />,
      );
      const header = toolbar();
      header.style.columnGap = '12px';
      const centerSlot = screen.getByTestId('toolbar-center').parentElement!;
      const fallbackSpan = screen.getByText('My Notebook');
      const trailing = screen.getByTestId('toolbar-trailing');
      const workspaceButton = screen.getByRole('button', { name: 'Show MindMap' });

      // Both `trailing` and the workspace button are direct children of the trailing column.
      expect(observed.has(header)).toBe(true);
      expect(observed.has(trailing)).toBe(true);
      expect(observed.has(workspaceButton)).toBe(true);

      // 1000px toolbar (center 500), 200px title ([400, 600] centered), trailing at 560:
      // with a 12px gap the title must end by 548, so it slides -52px via `left` (no transform).
      mockBox(header, 0, 1000);
      Object.defineProperty(fallbackSpan, 'scrollWidth', { configurable: true, value: 200 });
      let trailingLeft = 560;
      vi.spyOn(trailing, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            left: trailingLeft,
            right: 900,
            top: 0,
            bottom: 28,
            width: 900 - trailingLeft,
            height: 28,
            x: trailingLeft,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      mockBox(workspaceButton, 904, 992);

      act(() => {
        triggerResize?.();
      });
      expect(centerSlot).toHaveClass('relative');
      expect(centerSlot.style.left).toBe('-52px');
      expect(centerSlot.style.transform).toBe('');

      // Simulate the search field finishing its 150ms width transition (widening 80px left)
      // without the toolbar itself changing width: `ResizeObserver` on `trailing` catches it.
      trailingLeft = 480;
      act(() => {
        triggerResize?.();
      });
      expect(centerSlot.style.left).toBe('-132px');

      // Several center mutations in one turn coalesce into one `requestAnimationFrame`.
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      await act(async () => {
        fallbackSpan.textContent = 'First';
        fallbackSpan.textContent = 'Second';
        Object.defineProperty(fallbackSpan, 'scrollWidth', { configurable: true, value: 240 });
        fallbackSpan.textContent = 'Widened Notebook Title';
        await Promise.resolve();
      });
      expect(rafSpy).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(centerSlot.style.left).toBe('-152px');
      rafSpy.mockRestore();

      // Controls mounted inside a `display: contents` wrapper in a group are still
      // observed and measured by their real boxes rather than the 0x0 wrapper.
      const leading = screen.getByTestId('toolbar-leading');
      const contentsCluster = document.createElement('div');
      contentsCluster.style.display = 'contents';
      const leadingControl = document.createElement('button');
      mockBox(leadingControl, 8, 440);
      await act(async () => {
        leading.append(contentsCluster);
        await Promise.resolve();
        contentsCluster.append(leadingControl);
        await Promise.resolve();
      });
      expect(observed.has(contentsCluster)).toBe(false);
      expect(observed.has(leadingControl)).toBe(true);

      // Move trailing clear on the right so the new leading cluster drives a positive shift:
      // 240px title ([380, 620] centered) vs `440 + 12 = 452` on the left -> +72px shift.
      trailingLeft = 800;
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(centerSlot.style.left).toBe('72px');

      // Narrowing into the flex fallback keeps horizontal padding on the side groups
      // rather than `<header>`, so `@container/toolbar` inline size stays invariant.
      trailingLeft = 600;
      act(() => {
        triggerResize?.();
      });
      expect(header.className).toContain('flex ');
      expect(header.className).not.toContain('px-2');
      expect(header.style.paddingLeft).toBe('');
      expect(leading.className).toContain('pl-2');
      expect(trailing.parentElement?.className).toContain('pr-2');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
