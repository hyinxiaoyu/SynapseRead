import { Check, Copy, Maximize2, WrapText, X } from 'lucide-react';
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { fontStack, PAGE_PALETTES } from '@/features/reader/appearance/themes';
import type { ViewportRect } from '@/features/reader/markup/geometry';
import { cn } from '@/lib/utils';
import type { ResolvedReadingTheme } from '@/types/domain';

const LEAVE_GRACE_MS = 120;
const COPIED_FEEDBACK_MS = 1500;
const PILL_EDGE_PADDING_PX = 8;
const ABOVE_THRESHOLD_PX = 34;
const ABOVE_GAP_PX = 4;
const INSIDE_TOP_OFFSET_PX = 6;
const CODE_FONT_STACK =
  fontStack('mono') ?? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export interface HoveredCodeBlock {
  id: string;
  rect: ViewportRect;
  getText: () => string;
}

export interface ExpandedCodeBlock {
  id: string;
  text: string;
}

export interface CodeBlockOverlayProps {
  hoveredBlock: HoveredCodeBlock | null;
  expandedBlock: ExpandedCodeBlock | null;
  onExpand: (block: ExpandedCodeBlock) => void;
  onCloseExpanded: () => void;
  boundsRef: RefObject<HTMLElement | null>;
  suppressed: boolean;
  invalidationKey: string;
  theme: ResolvedReadingTheme;
  fontSizePercent: number;
  onReturnFocus: () => void;
}

interface OverlayPalette {
  pillBg: string;
  pillBorder: string;
  dialogBg: string;
  headerBg: string;
  codeBg: string;
  border: string;
  text: string;
  mutedText: string;
  controlBg: string;
  controlHoverBg: string;
  controlActiveBg: string;
  controlActiveText: string;
  colorScheme: 'light' | 'dark';
}

function overlayPalette(theme: ResolvedReadingTheme): OverlayPalette {
  const page = PAGE_PALETTES[theme];
  switch (theme) {
    case 'sepia':
      return {
        pillBg: '#faf4e6',
        pillBorder: '#cbb996',
        dialogBg: page.background,
        headerBg: '#ebe1c8',
        codeBg: page.background,
        border: '#cbb996',
        text: page.text,
        mutedText: '#65512f',
        controlBg: '#e2d4b6',
        controlHoverBg: '#d8c7a3',
        controlActiveBg: page.text,
        controlActiveText: '#fbf6ea',
        colorScheme: page.colorScheme,
      };
    case 'dark':
      return {
        pillBg: '#27272d',
        pillBorder: '#3f3f46',
        dialogBg: '#1d1d21',
        headerBg: '#25252b',
        codeBg: page.background,
        border: '#3a3a41',
        text: page.text,
        mutedText: '#a9a9b2',
        controlBg: '#2e2e35',
        controlHoverBg: '#3a3a43',
        controlActiveBg: page.text,
        controlActiveText: page.background,
        colorScheme: page.colorScheme,
      };
    case 'light':
      return {
        pillBg: '#ffffff',
        pillBorder: '#d6d1c7',
        dialogBg: '#ffffff',
        headerBg: '#f6f4ef',
        codeBg: page.background,
        border: '#d6d1c7',
        text: page.text,
        mutedText: '#5c564f',
        controlBg: '#efece4',
        controlHoverBg: '#e4dfd4',
        controlActiveBg: page.text,
        controlActiveText: page.background,
        colorScheme: page.colorScheme,
      };
  }
}

/**
 * Copies plain text to the system clipboard, falling back to a hidden readonly
 * textarea when the async Clipboard API is unavailable or denied.
 */
export async function copyPlainText(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back to execCommand when Clipboard API rejects or is unavailable.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '-9999px';
  field.style.opacity = '0';
  field.style.pointerEvents = 'none';
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    if (typeof document.execCommand === 'function') {
      document.execCommand('copy');
    }
  } finally {
    field.remove();
    if (
      previousFocus &&
      previousFocus !== document.body &&
      previousFocus !== document.documentElement
    ) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function useCopiedFeedback(resetKey?: string) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const key = resetKey ?? '__active__';

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  const markCopied = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setCopiedKey(key);
    timerRef.current = window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, COPIED_FEEDBACK_MS);
  }, [key]);

  return { copied: copiedKey === key, markCopied };
}

function CodeBlockActionPill({
  block,
  boundsRef,
  theme,
  onExpand,
  onPointerInsideChange,
}: {
  block: HoveredCodeBlock;
  boundsRef: RefObject<HTMLElement | null>;
  theme: ResolvedReadingTheme;
  onExpand: (block: ExpandedCodeBlock) => void;
  onPointerInsideChange: (inside: boolean) => void;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: 'above' | 'inside';
  } | null>(null);
  const { copied, markCopied } = useCopiedFeedback(block.id);
  const palette = overlayPalette(theme);

  useLayoutEffect(() => {
    const place = () => {
      const boundsEl = boundsRef.current;
      const pillEl = pillRef.current;
      if (!boundsEl || !pillEl) return;
      const bounds = boundsEl.getBoundingClientRect();
      const boundsWidth = bounds.right - bounds.left;
      const pillWidth = pillEl.offsetWidth;
      const pillHeight = pillEl.offsetHeight;

      const desiredLeft = block.rect.right - bounds.left - pillWidth;
      const maxLeft = Math.max(
        PILL_EDGE_PADDING_PX,
        boundsWidth - pillWidth - PILL_EDGE_PADDING_PX,
      );
      const left = Math.max(PILL_EDGE_PADDING_PX, Math.min(desiredLeft, maxLeft));

      const offsetTop = block.rect.top - bounds.top;
      const placement = offsetTop >= ABOVE_THRESHOLD_PX ? 'above' : 'inside';
      const top =
        placement === 'above'
          ? Math.max(0, offsetTop - pillHeight - ABOVE_GAP_PX)
          : Math.max(0, offsetTop + INSIDE_TOP_OFFSET_PX);

      setPosition((current) =>
        current && current.top === top && current.left === left && current.placement === placement
          ? current
          : { top, left, placement },
      );
    };
    place();
    const view = pillRef.current?.ownerDocument.defaultView;
    view?.addEventListener('resize', place);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    if (pillRef.current) observer?.observe(pillRef.current);
    if (boundsRef.current) observer?.observe(boundsRef.current);
    return () => {
      view?.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [block, boundsRef]);

  const placement = position?.placement ?? 'above';
  const keepPageFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  const buttonStyle = {
    '--code-pill-btn-bg': palette.pillBg,
    '--code-pill-btn-hover': palette.controlHoverBg,
    color: palette.text,
  } as CSSProperties;

  return (
    <div
      data-testid="epub-code-action-pill"
      data-placement={placement}
      onPointerEnter={() => onPointerInsideChange(true)}
      onPointerLeave={() => onPointerInsideChange(false)}
      className={cn('absolute z-30 transition-none', placement === 'above' && 'pb-1.5')}
      style={
        position
          ? { top: position.top, left: position.left, colorScheme: palette.colorScheme }
          : { top: 0, left: 0, visibility: 'hidden', colorScheme: palette.colorScheme }
      }
    >
      <div
        ref={pillRef}
        className="flex items-center gap-0.5 rounded-lg border p-0.5 shadow-md transition-none"
        style={{
          backgroundColor: palette.pillBg,
          borderColor: palette.pillBorder,
          color: palette.text,
        }}
      >
        <button
          type="button"
          data-testid="epub-code-copy"
          aria-label="Copy code block"
          title="Copy code block"
          onMouseDown={keepPageFocus}
          onClick={() => {
            void copyPlainText(block.getText());
            markCopied();
          }}
          style={buttonStyle}
          className="flex h-7 items-center gap-1 rounded-md bg-[var(--code-pill-btn-bg)] px-2 text-xs font-medium transition-none outline-none hover:bg-[var(--code-pill-btn-hover)] focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <Check className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button
          type="button"
          data-testid="epub-code-expand"
          aria-label="Expand code block"
          title="Expand code block"
          onMouseDown={keepPageFocus}
          onClick={() => onExpand({ id: block.id, text: block.getText() })}
          style={buttonStyle}
          className="flex h-7 items-center gap-1 rounded-md bg-[var(--code-pill-btn-bg)] px-2 text-xs font-medium transition-none outline-none hover:bg-[var(--code-pill-btn-hover)] focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Maximize2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span>Expand</span>
        </button>
      </div>
    </div>
  );
}

function ExpandedCodeDialog({
  block,
  theme,
  fontSizePercent,
  onClose,
  onReturnFocus,
}: {
  block: ExpandedCodeBlock;
  theme: ResolvedReadingTheme;
  fontSizePercent: number;
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const [wrap, setWrap] = useState(false);
  const { copied, markCopied } = useCopiedFeedback(block.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedInsideCardRef = useRef(false);
  const palette = overlayPalette(theme);

  const dismiss = useCallback(() => {
    onClose();
    onReturnFocus();
  }, [onClose, onReturnFocus]);

  useEscapeLayer(ESCAPE_LAYER.codeView, () => {
    dismiss();
    return true;
  });

  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, [block.id]);

  const lineCount = countLines(block.text);
  const lineLabel = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;
  const fontSizeRem = `${((0.92 * fontSizePercent) / 100).toFixed(3)}rem`;

  const headerButtonVars = {
    '--code-dlg-btn-bg': palette.controlBg,
    '--code-dlg-btn-hover': palette.controlHoverBg,
    color: palette.text,
  } as CSSProperties;

  const wrapButtonStyle = wrap
    ? {
        backgroundColor: palette.controlActiveBg,
        color: palette.controlActiveText,
      }
    : headerButtonVars;

  const viewportStyle: CSSProperties = {
    backgroundColor: palette.codeBg,
    color: palette.text,
    overflowX: wrap ? 'hidden' : 'auto',
    overflowY: 'auto',
  };

  const preStyle: CSSProperties = {
    margin: 0,
    padding: '1rem',
    fontFamily: CODE_FONT_STACK,
    fontSize: fontSizeRem,
    lineHeight: 1.5,
    tabSize: 4,
    whiteSpace: wrap ? 'pre-wrap' : 'pre',
    ...(wrap
      ? {
          overflowWrap: 'anywhere',
          wordBreak: 'normal',
          textIndent: '2ch hanging each-line',
        }
      : {
          minWidth: '100%',
          width: 'max-content',
        }),
  };

  return (
    <div
      data-testid="epub-code-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) startedInsideCardRef.current = false;
      }}
      onClick={(event) => {
        const startedInside = startedInsideCardRef.current;
        startedInsideCardRef.current = false;
        if (event.target === event.currentTarget && !startedInside) dismiss();
      }}
      onWheel={(event) => event.stopPropagation()}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/35 p-4 transition-none sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Expanded code block"
        data-testid="epub-code-dialog"
        data-reader-popover=""
        data-arrow-keys=""
        onMouseDown={() => {
          startedInsideCardRef.current = true;
        }}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-2xl transition-none"
        style={{
          backgroundColor: palette.dialogBg,
          borderColor: palette.border,
          color: palette.text,
          colorScheme: palette.colorScheme,
        }}
      >
        <header
          className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2"
          style={{
            backgroundColor: palette.headerBg,
            borderColor: palette.border,
          }}
        >
          <span
            data-testid="epub-code-line-count"
            className="text-xs font-medium tabular-nums"
            style={{ color: palette.mutedText }}
          >
            {lineLabel}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="epub-code-wrap-toggle"
              aria-pressed={wrap}
              onClick={() => setWrap((current) => !current)}
              style={wrapButtonStyle}
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
                !wrap && 'bg-[var(--code-dlg-btn-bg)] hover:bg-[var(--code-dlg-btn-hover)]',
              )}
            >
              <WrapText className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Wrap</span>
            </button>
            <button
              type="button"
              data-testid="epub-code-dialog-copy"
              aria-label="Copy code block"
              onClick={() => {
                void copyPlainText(block.text);
                markCopied();
              }}
              style={headerButtonVars}
              className="flex h-7 items-center gap-1 rounded-md bg-[var(--code-dlg-btn-bg)] px-2.5 text-xs font-medium transition-none outline-none hover:bg-[var(--code-dlg-btn-hover)] focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button
              type="button"
              data-testid="epub-code-dialog-close"
              aria-label="Close expanded code"
              title="Close expanded code"
              onClick={dismiss}
              style={headerButtonVars}
              className="flex size-7 items-center justify-center rounded-md bg-[var(--code-dlg-btn-bg)] transition-none outline-none hover:bg-[var(--code-dlg-btn-hover)] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div
          ref={scrollRef}
          data-testid="epub-code-dialog-scroll"
          tabIndex={0}
          style={viewportStyle}
          className="min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <pre data-testid="epub-code-dialog-pre" style={preStyle}>
            <code>{block.text}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

/**
 * Floating copy/expand action pill and modal plain-text viewer for EPUB code blocks.
 * Only plain text and numeric viewport bounds cross from the chapter iframe (ADR 0005).
 */
export function CodeBlockOverlay({
  hoveredBlock,
  expandedBlock,
  onExpand,
  onCloseExpanded,
  boundsRef,
  suppressed,
  invalidationKey,
  theme,
  fontSizePercent,
  onReturnFocus,
}: CodeBlockOverlayProps) {
  const [seenInvalidationKey, setSeenInvalidationKey] = useState(invalidationKey);
  const [invalidatedBlock, setInvalidatedBlock] = useState<HoveredCodeBlock | null>(null);
  const [graceBlock, setGraceBlock] = useState<HoveredCodeBlock | null>(null);
  const [pointerInPill, setPointerInPill] = useState(false);

  if (seenInvalidationKey !== invalidationKey) {
    setSeenInvalidationKey(invalidationKey);
    setInvalidatedBlock(hoveredBlock);
    setGraceBlock(null);
    setPointerInPill(false);
  } else if (invalidatedBlock !== null && hoveredBlock !== invalidatedBlock) {
    setInvalidatedBlock(null);
  }

  const activeHovered = suppressed || hoveredBlock === invalidatedBlock ? null : hoveredBlock;

  const [prevActiveHovered, setPrevActiveHovered] = useState<HoveredCodeBlock | null>(null);
  if (prevActiveHovered !== activeHovered) {
    setPrevActiveHovered(activeHovered);
    if (activeHovered !== null) {
      setGraceBlock(activeHovered);
    } else if (suppressed) {
      setGraceBlock(null);
      setPointerInPill(false);
    }
  }
  if (suppressed && (graceBlock !== null || pointerInPill)) {
    setGraceBlock(null);
    setPointerInPill(false);
  }

  useEffect(() => {
    if (suppressed || activeHovered !== null || graceBlock === null || pointerInPill) return;
    const timer = window.setTimeout(() => {
      setGraceBlock(null);
    }, LEAVE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [suppressed, activeHovered, graceBlock, pointerInPill]);

  const pillBlock = suppressed ? null : (activeHovered ?? graceBlock);

  return (
    <>
      {pillBlock && (
        <CodeBlockActionPill
          block={pillBlock}
          boundsRef={boundsRef}
          theme={theme}
          onExpand={onExpand}
          onPointerInsideChange={setPointerInPill}
        />
      )}
      {expandedBlock && (
        <ExpandedCodeDialog
          key={expandedBlock.id}
          block={expandedBlock}
          theme={theme}
          fontSizePercent={fontSizePercent}
          onClose={onCloseExpanded}
          onReturnFocus={onReturnFocus}
        />
      )}
    </>
  );
}
