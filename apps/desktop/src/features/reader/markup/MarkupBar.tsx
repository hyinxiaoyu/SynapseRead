import { Highlighter, Underline, X } from 'lucide-react';

import { commandTooltip } from '@/features/commands/commands';
import {
  ANNOTATION_COLORS,
  type AnnotationsController,
  COLOR_TARGET_CLASS,
  ColorDot,
} from '@/features/reader/AnnotationsPanel';
import { ToolbarButton } from '@/features/reader/ReaderToolbar';
import { cn } from '@/lib/utils';
import type { AnnotationStyle } from '@/types/domain';

const STYLES: readonly { style: AnnotationStyle; label: string; icon: typeof Highlighter }[] = [
  { style: 'highlight', label: 'Highlight', icon: Highlighter },
  { style: 'underline', label: 'Underline', icon: Underline },
];

/** The Markup toolbar button (⇧⌘A), which shows the markup bar under the toolbar. */
export function MarkupToggleButton({
  visible,
  highlightMode,
  onToggle,
}: {
  visible: boolean;
  highlightMode: boolean;
  onToggle: () => void;
}) {
  return (
    <ToolbarButton
      icon={Highlighter}
      label={highlightMode ? 'Markup (highlight mode on)' : 'Markup'}
      command="view.markup"
      pressed={visible}
      testId="markup-toggle"
      preserveSelection
      onClick={onToggle}
      // Highlight mode stays armed with the bar put away; the dot says so.
      className={cn(
        highlightMode &&
          'after:absolute after:right-1 after:bottom-1 after:size-1.5 after:rounded-full after:bg-primary',
      )}
    />
  );
}

/**
 * Preview's markup toolbar: the color and style new highlights use, and a sticky
 * highlight mode that marks every selection as soon as it is made.
 */
export function MarkupBar({
  controller,
  onClose,
}: {
  controller: AnnotationsController;
  onClose: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Markup"
      data-testid="markup-bar"
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-2 text-xs"
    >
      <div role="group" aria-label="Highlight color" className="flex items-center">
        {ANNOTATION_COLORS.map(({ label, value }) => {
          const selected = controller.activeColor === value;
          return (
            <button
              key={value}
              type="button"
              aria-label={`${label} highlight`}
              aria-pressed={selected}
              title={`${label} highlight`}
              data-testid={`markup-color-${label.toLowerCase()}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.setActiveColor(value)}
              className={COLOR_TARGET_CLASS}
            >
              <ColorDot color={value} selected={selected} />
            </button>
          );
        })}
      </div>
      <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-border" />
      <div role="group" aria-label="Markup style" className="flex items-center gap-0.5">
        {STYLES.map(({ style, label, icon: Icon }) => {
          const selected = controller.activeStyle === style;
          return (
            <button
              key={style}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              title={label}
              data-testid={`markup-style-${style}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.setActiveStyle(style)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
                selected && 'bg-accent text-accent-foreground',
              )}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-border" />
      <button
        type="button"
        role="switch"
        aria-checked={controller.highlightMode}
        title={commandTooltip('Highlight Mode', 'edit.highlightMode')}
        data-testid="markup-highlight-mode"
        onMouseDown={(event) => event.preventDefault()}
        onClick={controller.toggleHighlightMode}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          controller.highlightMode && 'bg-primary text-primary-foreground hover:bg-primary/90',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-2 rounded-full border',
            controller.highlightMode ? 'border-current bg-current' : 'border-muted-foreground',
          )}
        />
        Highlight Mode
      </button>
      <p role="status" className="min-w-0 flex-1 truncate text-muted-foreground">
        {controller.highlightMode
          ? `Every selection gets a ${controller.activeStyle}.`
          : 'Select text to mark it.'}
      </p>
      <ToolbarButton icon={X} label="Hide Markup Toolbar" command="view.markup" onClick={onClose} />
    </div>
  );
}
