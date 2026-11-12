import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { CommandId } from '@/features/commands/commands';
import { onCommandRun } from '@/features/commands/registry';
import { TOOLBAR_HEIGHT_PX, type ToolbarSlots } from '@/features/reader/ReaderToolbar';
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
 * Whether running `id` changes something drawn in the toolbar: a button, a
 * segment, or the Find field that declares the command. Page turns and other
 * `go.*` moves show on the page, so they leave a hidden toolbar hidden (#45); Go To
 * is the exception, because it puts the keyboard in a toolbar field.
 * Controls collapsed into `»` stay in the DOM under `display: none`, and do not count.
 */
export function toolbarShowsCommand(toolbar: HTMLElement | null, id: CommandId): boolean {
  if (!toolbar || (id.startsWith('go.') && id !== 'go.page')) return false;
  return [...toolbar.querySelectorAll<HTMLElement>(`[data-command~="${id}"]`)].some((control) =>
    isLaidOutWithin(control, toolbar),
  );
}

/**
 * No `display: none` between `element` and `root`. The auto-hidden toolbar itself
 * only slides and fades, so this still holds for its controls while it is hidden.
 * Checked through computed style rather than layout boxes so it does not depend on
 * `checkVisibility` (WebKit 17.4+).
 */
function isLaidOutWithin(element: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node && node !== root; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/**
 * Auto-hide for immersive reading. Any activity restarts the countdown; only the
 * top edge, the toolbar itself, or a command whose result the toolbar shows
 * reveals it.
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
    const stopObservingCommands = onCommandRun((id) => {
      if (toolbarShowsCommand(toolbarRef.current, id)) reveal();
    });
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
 * The width the center slot's text would take without being truncated. `scrollWidth`
 * keeps the full text on the element that truncates, and the slot's own wrapper can
 * be as wide as the toolbar, so only the descendants are measured.
 */
function titleWidth(element: HTMLElement): number {
  let width = 0;
  for (const child of element.children) {
    if (!(child instanceof HTMLElement)) continue;
    width = Math.max(width, child.scrollWidth, titleWidth(child));
  }
  return width;
}

/** The outer edges of a group's visible controls; null when it has none to measure. */
function contentBounds(element: HTMLElement | null): { left: number; right: number } | null {
  if (!element) return null;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const child of element.children) {
    const box = child.getBoundingClientRect();
    // Hidden toolbar items collapse to nothing, and a zero box would drag the edges to 0.
    if (box.width === 0 && box.height === 0) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
  }
  return Number.isFinite(left) ? { left, right } : null;
}

interface TitleLayout {
  /** Whether the title can sit at the toolbar's center at all. */
  centered: boolean;
  /** How far it has to slide from there to clear a control group. */
  shift: number;
}

/**
 * Where the title can sit. The groups keep their places whatever the title does, so
 * measuring their edges against the toolbar's center says how much room the title
 * has: enough, and it is centered; not enough, and it slides just far enough to clear
 * the wider group, which is still all the centering the toolbar allows. A title that
 * cannot fit between the groups at all keeps the old layout, centered in the space
 * they leave, so it truncates instead of covering a control. Both branches meet at
 * that width, so the title never jumps as the window is resized.
 */
function useTitleLayout(
  toolbarRef: RefObject<HTMLElement | null>,
  leading: HTMLElement | null,
  center: HTMLElement | null,
  trailing: HTMLElement | null,
): TitleLayout {
  const [layout, setLayout] = useState<TitleLayout>({ centered: true, shift: 0 });

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !leading || !center || !trailing) return;

    const measure = () => {
      const slot = center.parentElement;
      if (!slot) return;
      const viewport = toolbar.getBoundingClientRect();
      // A group with no controls (before a document opens) still pins its edge.
      const group = contentBounds(leading) ?? { left: viewport.left, right: viewport.left };
      const controls = contentBounds(trailing.parentElement) ?? {
        left: viewport.right,
        right: viewport.right,
      };
      const gap = Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0;
      const middle = (viewport.left + viewport.right) / 2;
      const width = titleWidth(slot);
      const left = group.right + gap;
      const right = controls.left - gap;
      const centered = right - left >= width;
      // The distance the title has to move so its edges land inside the room.
      const low = left - (middle - width / 2);
      const high = right - (middle + width / 2);
      const shift = centered ? Math.round(Math.min(Math.max(0, low), high) * 10) / 10 : 0;
      setLayout((current) =>
        current.centered === centered && current.shift === shift ? current : { centered, shift },
      );
    };
    measure();

    // Resizing is not the only thing that changes the answer: the reader fills the
    // slots, and the title changes with the document.
    const resize = new ResizeObserver(measure);
    resize.observe(toolbar);
    const mutations = new MutationObserver(measure);
    for (const element of [leading, center, trailing.parentElement]) {
      if (!element) continue;
      // A class change is how the search field widens and a control appears, which
      // moves a group's edge without touching the DOM tree.
      mutations.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [center, leading, toolbarRef, trailing]);

  return layout;
}

/**
 * The one band of chrome above the tabs: on macOS it is also the title bar.
 * Leading: sidebar and layout. Center: the document. Trailing: reading tools,
 * then the workspace's own panes. The active reader fills the slots.
 *
 * The title sits in the middle of three columns whose sides share the width equally,
 * so it is centered on the toolbar itself; centering it in the space the two control
 * groups leave would move it left whenever the right group is the wider one.
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

  // The title only takes the toolbar's center when its own width leaves room for
  // both control groups; otherwise it stays centered between them, as it did before.
  const titleLayout = useTitleLayout(toolbarRef, leading, center, trailing);
  const centeredTitle = titleLayout.centered;

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
          '@container/toolbar z-40 shrink-0 border-b bg-background text-foreground select-none',
          centeredTitle
            ? 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3'
            : 'flex items-center gap-3 px-2',
          immersive && 'absolute inset-x-0 top-0 bg-background/90 shadow-sm backdrop-blur-md',
          hidden && 'pointer-events-none -translate-y-full opacity-0',
          'motion-safe:transition-[opacity,translate] motion-safe:duration-200',
        )}
        style={{
          height: TOOLBAR_HEIGHT_PX,
          ...themeStyle,
          // The centered layout insets the leading column instead, so both side
          // columns stay equal and the title stays on the toolbar's center.
          ...(!centeredTitle && insetForWindowControls
            ? { paddingLeft: TRAFFIC_LIGHTS_INSET_PX }
            : undefined),
        }}
      >
        <div
          ref={setLeading}
          data-testid="toolbar-leading"
          {...dragRegion}
          className={cn(
            'flex items-center gap-1',
            // Keeping the controls their own size lets the title measure them and give
            // way, rather than squeezing a label into two lines.
            centeredTitle ? 'min-w-0 pl-2 [&>*]:shrink-0' : 'shrink-0',
          )}
          style={
            centeredTitle && insetForWindowControls
              ? { paddingLeft: TRAFFIC_LIGHTS_INSET_PX }
              : undefined
          }
        />
        <div
          {...dragRegion}
          className={cn(
            'flex min-w-0 items-center justify-center gap-1',
            !centeredTitle && 'flex-1',
          )}
          style={
            titleLayout.shift === 0
              ? undefined
              : { transform: `translateX(${titleLayout.shift}px)` }
          }
        >
          <div ref={setCenter} data-testid="toolbar-center" className="contents" />
          {showFallbackTitle && fallbackTitle}
        </div>
        <div
          {...dragRegion}
          className={cn(
            'flex items-center gap-1',
            centeredTitle ? 'min-w-0 justify-end pr-2 [&>*]:shrink-0' : 'shrink-0',
          )}
        >
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
