import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchEscape, ESCAPE_LAYER, registerEscapeLayer } from '@/features/commands/escape';
import { PAGE_PALETTES } from '@/features/reader/appearance/themes';
import { contrastRatio } from '@/lib/contrast';
import type { ResolvedReadingTheme } from '@/types/domain';

import {
  CodeBlockOverlay,
  type CodeBlockOverlayProps,
  copyPlainText,
  type ExpandedCodeBlock,
  type HoveredCodeBlock,
} from './CodeBlockOverlay';

function mockBox(
  el: HTMLElement,
  box: { left: number; top: number; width: number; height: number },
) {
  const rect = {
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect);
}

function mockOffsetSize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

function makeHovered(overrides: Partial<HoveredCodeBlock> = {}): HoveredCodeBlock {
  return {
    id: 'block-1',
    rect: { top: 200, left: 120, right: 620, bottom: 320 },
    getText: () => 'const x = 1;\n\treturn x;',
    ...overrides,
  };
}

function setupOverlay(overrides: Partial<CodeBlockOverlayProps> = {}) {
  const boundsRef = createRef<HTMLDivElement>();
  const onExpand = vi.fn<(block: ExpandedCodeBlock) => void>();
  const onCloseExpanded = vi.fn();
  const onReturnFocus = vi.fn();
  const onParentWheel = vi.fn();

  const props: CodeBlockOverlayProps = {
    hoveredBlock: null,
    expandedBlock: null,
    onExpand,
    onCloseExpanded,
    boundsRef,
    suppressed: false,
    invalidationKey: 'k1',
    theme: 'light',
    fontSizePercent: 100,
    onReturnFocus,
    ...overrides,
  };

  const view = render(
    <div ref={boundsRef} data-testid="reader-area" onWheel={onParentWheel}>
      <button type="button" data-testid="page-focus-target">
        page
      </button>
      <CodeBlockOverlay {...props} />
    </div>,
  );

  const rerenderOverlay = (next: Partial<CodeBlockOverlayProps>) =>
    view.rerender(
      <div ref={boundsRef} data-testid="reader-area" onWheel={onParentWheel}>
        <button type="button" data-testid="page-focus-target">
          page
        </button>
        <CodeBlockOverlay {...props} {...next} />
      </div>,
    );

  return {
    ...view,
    boundsRef,
    onExpand,
    onCloseExpanded,
    onReturnFocus,
    onParentWheel,
    rerenderOverlay,
  };
}

describe('copyPlainText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const text = '  def fn():\n\treturn "$ok"';
    await expect(copyPlainText(text)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it('falls back to a hidden readonly textarea and execCommand when clipboard API fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    let capturedReadonly: boolean | null = null;
    let capturedCopyBuffer: string | null = null;
    let capturedValue: string | null = null;
    execCommand.mockImplementation(() => {
      const active = document.querySelector('textarea');
      if (active instanceof HTMLTextAreaElement) {
        capturedReadonly = active.hasAttribute('readonly');
        capturedCopyBuffer = active.getAttribute('data-synapse-copy-buffer');
        capturedValue = active.value;
      }
      return true;
    });

    const button = document.createElement('button');
    document.body.append(button);
    button.focus();

    await expect(copyPlainText('line 1\n  line 2')).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(capturedReadonly).toBe(true);
    expect(capturedCopyBuffer).toBe('true');
    expect(capturedValue).toBe('line 1\n  line 2');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('returns false when clipboard API fails and execCommand returns false, throws, or is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    await expect(copyPlainText('code')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('blocked');
      }),
    });
    await expect(copyPlainText('code')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: undefined,
    });
    await expect(copyPlainText('code')).resolves.toBe(false);
  });
});

describe('CodeBlockOverlay action pill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows Copy and Expand on hover and clears after 120ms leave grace', () => {
    const block = makeHovered();
    const { rerenderOverlay } = setupOverlay({ hoveredBlock: block });

    const pill = screen.getByTestId('epub-code-action-pill');
    expect(pill).toHaveClass('transition-none');
    expect(screen.getByTestId('epub-code-copy')).toHaveAttribute('aria-label', 'Copy code block');
    expect(screen.getByTestId('epub-code-expand')).toHaveAttribute(
      'aria-label',
      'Expand code block',
    );
    expect(pill.textContent).toBe('CopyExpand');

    rerenderOverlay({ hoveredBlock: null });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();
  });

  it('cancels leave grace while pointer is inside the pill and resumes on pointer leave', () => {
    const block = makeHovered();
    const { rerenderOverlay } = setupOverlay({ hoveredBlock: block });
    const pill = screen.getByTestId('epub-code-action-pill');

    rerenderOverlay({ hoveredBlock: null });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    fireEvent.pointerEnter(pill);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    fireEvent.pointerLeave(pill);
    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();
  });

  it('clears immediately without grace when suppressed or invalidationKey changes', () => {
    const block = makeHovered();
    const { rerenderOverlay } = setupOverlay({ hoveredBlock: block, invalidationKey: 'page-1' });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    // During leave grace, invalidationKey clears immediately.
    rerenderOverlay({ hoveredBlock: null, invalidationKey: 'page-1' });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();
    rerenderOverlay({ hoveredBlock: null, invalidationKey: 'page-2' });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();

    // Even if parent still holds the stale block reference, invalidationKey clears immediately.
    rerenderOverlay({ hoveredBlock: block, invalidationKey: 'page-2' });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();
    rerenderOverlay({ hoveredBlock: block, invalidationKey: 'page-3' });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();

    // Fresh hover after invalidation renders again, and suppressed clears immediately.
    const fresh = makeHovered({ id: 'block-2' });
    rerenderOverlay({ hoveredBlock: fresh, invalidationKey: 'page-3', suppressed: false });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();
    rerenderOverlay({ hoveredBlock: fresh, invalidationKey: 'page-3', suppressed: true });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();
  });

  it('places above with pb-1.5 bridge when >= 34px clearance exists, else tucks inside and clamps horizontally', () => {
    const blockAbove = makeHovered({
      rect: { top: 200, left: 100, right: 700, bottom: 260 },
    });
    const { boundsRef, rerenderOverlay } = setupOverlay({ hoveredBlock: blockAbove });
    const area = boundsRef.current as HTMLDivElement;
    mockBox(area, { left: 50, top: 100, width: 800, height: 600 });
    const pill = screen.getByTestId('epub-code-action-pill');
    const card = pill.firstElementChild as HTMLElement;
    mockOffsetSize(card, 140, 32);

    // Trigger resize measurement with mocked geometry.
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // offsetTop = 200 - 100 = 100 >= 34 => above: top = 100 - 32 - 4 = 64, left = (700 - 50) - 140 = 510
    expect(pill).toHaveAttribute('data-placement', 'above');
    expect(pill).toHaveClass('pb-1.5');
    expect(pill.style.top).toBe('64px');
    expect(pill.style.left).toBe('510px');

    // Near top edge (< 34px clearance) and overflowing right edge -> inside & clamped to 8px from right.
    const blockTopRight = makeHovered({
      id: 'block-top',
      rect: { top: 120, left: 600, right: 900, bottom: 220 },
    });
    rerenderOverlay({ hoveredBlock: blockTopRight });
    // offsetTop = 120 - 100 = 20 < 34 => inside: top = 20 + 6 = 26, maxLeft = 800 - 140 - 8 = 652
    expect(pill).toHaveAttribute('data-placement', 'inside');
    expect(pill).not.toHaveClass('pb-1.5');
    expect(pill.style.top).toBe('26px');
    expect(pill.style.left).toBe('652px');

    // Narrow block near left edge -> clamped to 8px from left.
    const blockFarLeft = makeHovered({
      id: 'block-left',
      rect: { top: 180, left: 52, right: 110, bottom: 240 },
    });
    rerenderOverlay({ hoveredBlock: blockFarLeft });
    expect(pill.style.left).toBe('8px');
  });

  it('copies text with 1500ms Copied feedback and triggers onExpand', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const block = makeHovered({ getText: () => '  echo "$PATH"' });
    const { onExpand } = setupOverlay({ hoveredBlock: block });

    const copyBtn = screen.getByTestId('epub-code-copy');
    expect(copyBtn).toHaveTextContent('Copy');
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeText).toHaveBeenCalledWith('  echo "$PATH"');
    expect(copyBtn).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copyBtn).toHaveTextContent('Copy');

    fireEvent.click(screen.getByTestId('epub-code-expand'));
    expect(onExpand).toHaveBeenCalledWith({ id: 'block-1', text: '  echo "$PATH"' });
  });

  it('waits for clipboard resolution before showing Copied and keeps Copy on failure', async () => {
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeText = vi.fn(() => pendingWrite);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    setupOverlay({ hoveredBlock: makeHovered({ getText: () => 'ok' }) });
    const copyBtn = screen.getByTestId('epub-code-copy');
    fireEvent.click(copyBtn);
    expect(copyBtn).toHaveTextContent('Copy');

    await act(async () => {
      resolveWrite();
      await pendingWrite;
    });
    expect(copyBtn).toHaveTextContent('Copied');

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });

    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(copyBtn).toHaveTextContent('Copy');
  });

  it('supports Tab/Shift+Tab between pill controls and holds pill open while focused', () => {
    const focusBlock = vi.fn(() => true);
    const focusAfterBlock = vi.fn(() => true);
    const block = makeHovered({ focusBlock, focusAfterBlock });
    const { rerenderOverlay } = setupOverlay({ hoveredBlock: block });

    const copyBtn = screen.getByTestId('epub-code-copy');
    const expandBtn = screen.getByTestId('epub-code-expand');
    copyBtn.focus();
    expect(copyBtn).toHaveFocus();

    // Focus keeps the pill open even after hoveredBlock clears and 120ms grace elapses.
    rerenderOverlay({ hoveredBlock: null });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('epub-code-action-pill')).toBeInTheDocument();

    // Tab moves Copy -> Expand; Shift+Tab moves Expand -> Copy.
    fireEvent.keyDown(copyBtn, { key: 'Tab' });
    expect(expandBtn).toHaveFocus();
    fireEvent.keyDown(expandBtn, { key: 'Tab', shiftKey: true });
    expect(copyBtn).toHaveFocus();

    // Shift+Tab on Copy invokes focusBlock; Tab on Expand invokes focusAfterBlock.
    const backTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    copyBtn.dispatchEvent(backTab);
    expect(focusBlock).toHaveBeenCalledTimes(1);
    expect(backTab.defaultPrevented).toBe(true);

    expandBtn.focus();
    const fwdTab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    expandBtn.dispatchEvent(fwdTab);
    expect(focusAfterBlock).toHaveBeenCalledTimes(1);
    expect(fwdTab.defaultPrevented).toBe(true);

    // Blurring out of the pill dismisses it when hoveredBlock is null.
    fireEvent.blur(expandBtn, { relatedTarget: screen.getByTestId('page-focus-target') });
    expect(screen.queryByTestId('epub-code-action-pill')).toBeNull();
  });
});

describe('CodeBlockOverlay expanded dialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders plain text inertly (ADR 0005), auto-focuses viewport, and displays line count', () => {
    const malicious = '<img src=x onerror="window.__codeRan=1"><script>alert(1)</script>\n  line 2';
    setupOverlay({
      expandedBlock: { id: 'b1', text: malicious },
      fontSizePercent: 150,
    });

    const dialog = screen.getByTestId('epub-code-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Expanded code block');
    expect(dialog).toHaveAttribute('data-arrow-keys', '');
    expect(screen.getByTestId('epub-code-line-count')).toHaveTextContent('2 lines');

    const scroll = screen.getByTestId('epub-code-dialog-scroll');
    expect(scroll).toHaveAttribute('tabindex', '0');
    expect(scroll).toHaveFocus();

    const pre = screen.getByTestId('epub-code-dialog-pre');
    expect(pre.querySelector('script, img')).toBeNull();
    expect(pre.querySelector('code')?.textContent).toBe(malicious);
    expect(pre.style.fontSize).toMatch(/rem$/);
    expect(Number.parseFloat(pre.style.fontSize)).toBeCloseTo((0.92 * 150) / 100, 3);
    expect(pre.style.lineHeight).toBe('1.5');
    expect((window as unknown as { __codeRan?: number }).__codeRan).toBeUndefined();
  });

  it('uses singular line label for single-line blocks and toggles Wrap mode cleanly', () => {
    const { rerenderOverlay } = setupOverlay({
      expandedBlock: { id: 'b1', text: 'single_very_long_line_of_code()' },
    });

    expect(screen.getByTestId('epub-code-line-count')).toHaveTextContent('1 line');
    rerenderOverlay({ expandedBlock: { id: 'b2', text: 'a\nb\n' } });
    expect(screen.getByTestId('epub-code-line-count')).toHaveTextContent('2 lines');
    rerenderOverlay({ expandedBlock: { id: 'b3', text: '\na\nb\n' } });
    expect(screen.getByTestId('epub-code-line-count')).toHaveTextContent('3 lines');
    rerenderOverlay({ expandedBlock: { id: 'b4', text: 'a\nb\n\n' } });
    expect(screen.getByTestId('epub-code-line-count')).toHaveTextContent('3 lines');
    rerenderOverlay({
      expandedBlock: { id: 'b1', text: 'single_very_long_line_of_code()' },
    });
    const toggle = screen.getByTestId('epub-code-wrap-toggle');
    const scroll = screen.getByTestId('epub-code-dialog-scroll');
    const pre = screen.getByTestId('epub-code-dialog-pre');

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(pre.style.whiteSpace).toBe('pre');
    expect(pre.style.tabSize).toBe('4');
    expect(scroll.style.overflowX).toBe('auto');
    expect(scroll.style.overflowY).toBe('auto');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(pre.style.whiteSpace).toBe('pre-wrap');
    expect(pre.style.overflowWrap).toBe('anywhere');
    expect(pre.style.wordBreak).toBe('normal');
    expect(pre.style.textIndent).toBe('2ch hanging each-line');
    expect(pre.style.tabSize).toBe('4');
    expect(scroll.style.overflowX).toBe('hidden');
    expect(scroll.style.overflowY).toBe('auto');
  });

  it('copies expanded text with Copied feedback and stops wheel propagation', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { onParentWheel } = setupOverlay({
      expandedBlock: { id: 'b1', text: 'alpha\nbeta\ngamma' },
    });

    const copyBtn = screen.getByTestId('epub-code-dialog-copy');
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeText).toHaveBeenCalledWith('alpha\nbeta\ngamma');
    expect(copyBtn).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copyBtn).toHaveTextContent('Copy');

    fireEvent.wheel(screen.getByTestId('epub-code-dialog-scroll'), { deltaY: 120 });
    expect(onParentWheel).not.toHaveBeenCalled();
  });

  it('does not show Copied in expanded dialog while writeText is pending or when copy fails', async () => {
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => pendingWrite) },
    });
    setupOverlay({
      expandedBlock: { id: 'b1', text: 'alpha' },
    });
    const copyBtn = screen.getByTestId('epub-code-dialog-copy');
    fireEvent.click(copyBtn);
    expect(copyBtn).toHaveTextContent('Copy');

    await act(async () => {
      resolveWrite();
      await pendingWrite;
    });
    expect(copyBtn).toHaveTextContent('Copied');

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(copyBtn).toHaveTextContent('Copy');
  });

  it('closes and returns focus on Close button, backdrop click, and Escape above noteField', () => {
    const noteFieldEscape = vi.fn(() => true);
    const stopNoteLayer = registerEscapeLayer(ESCAPE_LAYER.noteField, () => noteFieldEscape);
    try {
      const { onCloseExpanded, onReturnFocus } = setupOverlay({
        expandedBlock: { id: 'b1', text: 'code' },
      });

      // Clicking inside dialog card does not close.
      fireEvent.click(screen.getByTestId('epub-code-dialog'));
      expect(onCloseExpanded).not.toHaveBeenCalled();

      // Clicking backdrop closes and returns focus.
      fireEvent.click(screen.getByTestId('epub-code-dialog-backdrop'));
      expect(onCloseExpanded).toHaveBeenCalledTimes(1);
      expect(onReturnFocus).toHaveBeenCalledTimes(1);

      // Close button closes and returns focus.
      fireEvent.click(screen.getByTestId('epub-code-dialog-close'));
      expect(onCloseExpanded).toHaveBeenCalledTimes(2);
      expect(onReturnFocus).toHaveBeenCalledTimes(2);

      // Escape hits codeView (45) before noteField (40).
      const handled = dispatchEscape(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(handled).toBe(true);
      expect(noteFieldEscape).not.toHaveBeenCalled();
      expect(onCloseExpanded).toHaveBeenCalledTimes(3);
      expect(onReturnFocus).toHaveBeenCalledTimes(3);
    } finally {
      stopNoteLayer();
    }
  });

  it('meets WCAG AA contrast across Light, Sepia, and Dark themes', () => {
    const themes: ResolvedReadingTheme[] = ['light', 'sepia', 'dark'];
    for (const theme of themes) {
      const { unmount } = setupOverlay({
        theme,
        expandedBlock: { id: `b-${theme}`, text: 'line 1\nline 2' },
      });
      const pre = screen.getByTestId('epub-code-dialog-pre');
      const scroll = screen.getByTestId('epub-code-dialog-scroll');
      expect(scroll.style.backgroundColor).toBeTruthy();
      expect(scroll.style.color).toBeTruthy();
      expect(
        contrastRatio(PAGE_PALETTES[theme].text, PAGE_PALETTES[theme].background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(pre).toHaveTextContent('line 1');
      unmount();
    }
  });
});
