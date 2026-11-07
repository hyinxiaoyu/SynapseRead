import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { onCommandRun } from '@/features/commands/registry';
import type { ToolbarSlots } from '@/features/reader/ReaderToolbar';
import type { WindowChromeStyle } from '@/lib/backend/types';
import { cn } from '@/lib/utils';
import type { ResolvedReadingTheme } from '@/types/domain';

/** Immersive mode hides the toolbar after this long without pointer or key activity. */
export const AUTO_HIDE_DELAY_MS = 3000;
/** A pointer this close to the top edge brings the toolbar back. */
export const REVEAL_EDGE_PX = 8;
/** Room for the macOS window controls when the toolbar is the title bar. */
const TRAFFIC_LIGHTS_INSET_PX = 84;

/**
 * True while something the reader is working with lives in or under the toolbar:
 * focus in the toolbar, a popover or Find, or a text selection.
 */
function isToolbarPinned(toolbar: HTMLElement | null, hasReaderSelection: boolean): boolean {
  if (hasReaderSelection) return true;
  if (toolbar?.contains(document.activeElement)) return true;
  if (toolbar?.matches(':hover')) return true;
  if (document.querySelector('[data-reader-popover]')) return true;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== '';
}

/**
 * Auto-hide for immersive reading. Any activity restarts the countdown; only the
 * top edge, the toolbar itself, or a command (a toolbar shortcut) reveals it.
 */
export function useAutoHideToolbar(
  enabled: boolean,
  toolbarRef: RefObject<HTMLElement | null>,
  hasReaderSelection: boolean,
) {
  const [hidden, setHidden] = useState(false);
  const pinned = useRef(hasReaderSelection);
  useEffect(() => {
    pinned.current = hasReaderSelection;
  });

  const timer = useRef<number | undefined>(undefined);
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(function hideIfIdle() {
      if (isToolbarPinned(toolbarRef.current, pinned.current)) {
        timer.current = window.setTimeout(hideIfIdle, AUTO_HIDE_DELAY_MS);
        return;
      }
      setHidden(true);
    }, AUTO_HIDE_DELAY_MS);
  }, [toolbarRef]);

  const reveal = useCallback(() => {
    setHidden(false);
    schedule();
  }, [schedule]);

  useEffect(() => {
    if (!enabled) return;
    schedule();
    const onPointerMove = (event: PointerEvent) => {
      const toolbar = toolbarRef.current;
      const overToolbar = event.target instanceof Node && toolbar?.contains(event.target);
      if (event.clientY <= REVEAL_EDGE_PX || overToolbar) reveal();
      else schedule();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) reveal();
    };
    const stopObservingCommands = onCommandRun(() => reveal());
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', schedule);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.clearTimeout(timer.current);
      stopObservingCommands();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', schedule);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [enabled, reveal, schedule, toolbarRef]);

  return { hidden: enabled && hidden, reveal };
}

/**
 * The one band of chrome above the tabs: on macOS it is also the title bar.
 * Leading: sidebar and layout. Center: the document. Trailing: reading tools,
 * then the workspace's own panes. The active reader fills the slots.
 */
export function UnifiedToolbar({
  chromeStyle,
  themeStyle,
  readingTheme = null,
  fullscreen,
  immersive,
  hasReaderSelection,
  fallbackTitle,
  showFallbackTitle,
  workspaceControls,
  onSlotsChange,
}: {
  chromeStyle: WindowChromeStyle;
  /** The active reader's theme tokens; the toolbar is reader chrome, as in Books. */
  themeStyle?: CSSProperties | undefined;
  readingTheme?: ResolvedReadingTheme | null;
  fullscreen: boolean;
  immersive: boolean;
  hasReaderSelection: boolean;
  /** Shown in the center while no document is open. */
  fallbackTitle: ReactNode;
  showFallbackTitle: boolean;
  workspaceControls: ReactNode;
  onSlotsChange: (slots: ToolbarSlots) => void;
}) {
  const toolbarRef = useRef<HTMLElement>(null);
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [trailing, setTrailing] = useState<HTMLElement | null>(null);
  const { hidden, reveal } = useAutoHideToolbar(immersive, toolbarRef, hasReaderSelection);

  useEffect(() => {
    onSlotsChange({ leading, center, trailing });
  }, [center, leading, onSlotsChange, trailing]);

  // Full screen hides the window controls, so the inset goes with them.
  const insetForWindowControls = chromeStyle === 'overlay' && !fullscreen;
  const dragRegion = chromeStyle === 'overlay' ? { 'data-tauri-drag-region': '' } : {};

  return (
    <>
      {hidden && (
        <div
          aria-hidden="true"
          data-testid="toolbar-reveal-edge"
          className="absolute inset-x-0 top-0 z-50"
          style={{ height: REVEAL_EDGE_PX }}
          onPointerEnter={reveal}
        />
      )}
      <header
        ref={toolbarRef}
        data-testid="unified-toolbar"
        data-immersive={immersive || undefined}
        data-hidden={hidden || undefined}
        data-reading-theme={readingTheme ?? undefined}
        inert={hidden}
        aria-label="Toolbar"
        {...dragRegion}
        className={cn(
          '@container/toolbar z-40 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-2 text-foreground select-none',
          immersive && 'absolute inset-x-0 top-0 bg-background/90 shadow-sm backdrop-blur-md',
          hidden && 'pointer-events-none -translate-y-full opacity-0',
          'motion-safe:transition-[opacity,translate] motion-safe:duration-200',
        )}
        style={{
          ...themeStyle,
          ...(insetForWindowControls ? { paddingLeft: TRAFFIC_LIGHTS_INSET_PX } : undefined),
        }}
      >
        <div
          ref={setLeading}
          data-testid="toolbar-leading"
          {...dragRegion}
          className="flex shrink-0 items-center gap-1"
        />
        <div
          {...dragRegion}
          className="flex h-full min-w-0 flex-1 items-center justify-center gap-1"
        >
          <div ref={setCenter} data-testid="toolbar-center" className="contents" />
          {showFallbackTitle && fallbackTitle}
        </div>
        <div {...dragRegion} className="flex shrink-0 items-center gap-1">
          <div
            ref={setTrailing}
            data-testid="toolbar-trailing"
            {...dragRegion}
            className="flex items-center gap-1"
          />
          {workspaceControls}
        </div>
      </header>
    </>
  );
}
