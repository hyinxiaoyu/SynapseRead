import { Check, ChevronDown, Link2, Pencil, StickyNote, Undo2 } from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { commandDefinition, formatShortcut } from '@/features/commands/commands';
import {
  formatShortDate,
  NavigatorEmptyState,
  RowDeleteButton,
  rowClassName,
} from '@/features/reader/navigator/parts';
import { isDeleteKey, useRovingList } from '@/features/reader/navigator/useRovingList';
import { useMarkupDefaults, writeMarkupDefaults } from '@/features/reader/markup/markupDefaults';
import { NoteEditor } from '@/features/reader/markup/NoteEditor';
import { cn } from '@/lib/utils';
import {
  type Annotation,
  annotationHasNote,
  type AnnotationPatch,
  type AnnotationStyle,
  type CreateAnnotationOptions,
  type ReaderHighlight,
  type ReaderSelection,
} from '@/types/domain';

export const ANNOTATION_COLORS: readonly { label: string; value: string }[] = [
  { label: 'Yellow', value: '#fde047' },
  { label: 'Green', value: '#86efac' },
  { label: 'Blue', value: '#93c5fd' },
  { label: 'Pink', value: '#f9a8d4' },
  { label: 'Purple', value: '#c4b5fd' },
];

/** `Yellow`, or the hex value for a color outside the palette (an imported note). */
export function annotationColorName(color: string): string {
  return ANNOTATION_COLORS.find(({ value }) => value === color)?.label ?? color;
}

export function formatAnnotationLocation(annotation: Annotation): string {
  const { anchor } = annotation;
  switch (anchor.format) {
    case 'pdf': {
      const spans = anchor.pageSpans;
      if (spans && spans.length > 1) {
        const firstPage = (spans[0]?.pageIndex ?? anchor.pageIndex) + 1;
        const lastPage = (spans.at(-1)?.pageIndex ?? anchor.pageIndex) + 1;
        return `Pages ${firstPage}–${lastPage}`;
      }
      return `Page ${anchor.pageIndex + 1}`;
    }
    case 'epub':
      return anchor.chapterHref;
    case 'txt':
      return `Line ${anchor.lineIndex + 1}`;
    case 'md':
      return anchor.astNodeId;
  }
}

export interface AnnotationsController {
  annotations: readonly Annotation[];
  /** The last color used, which ⇧⌘H and highlight mode apply. */
  activeColor: string;
  activeStyle: AnnotationStyle;
  /** Preview's sticky highlight mode: every new selection is highlighted. */
  highlightMode: boolean;
  draftNoteOpen: boolean;
  draftNote: string;
  canUndoDelete: boolean;
  setActiveColor: (color: string) => void;
  setActiveStyle: (style: AnnotationStyle) => void;
  toggleHighlightMode: () => void;
  setDraftNote: (value: string) => void;
  toggleDraftNote: () => void;
  openDraftNote: () => void;
  closeDraftNote: () => void;
  /** Marks the selection; the color and style become the new defaults. */
  createHighlight: (options?: { color?: string; style?: AnnotationStyle }) => void;
  submitNoteSelection: () => void;
  selectAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (annotationId: string, patch: AnnotationPatch) => void;
  deleteAnnotation: (annotationId: string) => void;
  undoDelete: () => void;
  isAnnotationStale: (annotation: Annotation) => boolean;
}

export interface UseAnnotationsOptions {
  documentId: string;
  selection?: ReaderSelection | null | undefined;
  annotations?: readonly Annotation[] | undefined;
  onCreateAnnotation?: ((options?: CreateAnnotationOptions) => void) | undefined;
  onUpdateAnnotation?: ((annotationId: string, patch: AnnotationPatch) => void) | undefined;
  onDeleteAnnotation?: ((annotationId: string) => void) | undefined;
  canUndoAnnotationDelete?: boolean | undefined;
  onUndoAnnotationDelete?: (() => void) | undefined;
  isStaleAnnotation?: (annotation: Annotation) => boolean;
  onSelectAnnotation: (annotation: Annotation) => void;
}

export function useAnnotationsController({
  documentId,
  selection,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  canUndoAnnotationDelete,
  onUndoAnnotationDelete,
  isStaleAnnotation,
  onSelectAnnotation,
}: UseAnnotationsOptions): AnnotationsController {
  // The last color and style carry over between documents, open tabs, and launches.
  const { color: activeColor, style: activeStyle } = useMarkupDefaults();
  const setActiveColor = (color: string) => writeMarkupDefaults({ color });
  const setActiveStyle = (style: AnnotationStyle) => writeMarkupDefaults({ style });
  const [highlightMode, setHighlightMode] = useState(false);
  const [draftNoteOpen, setDraftNoteOpen] = useState(false);
  const [draftNote, setDraftNote] = useState('');
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>([]);
  const [localDeleted, setLocalDeleted] = useState<Annotation[]>([]);

  const effectiveAnnotations = annotations ?? localAnnotations;
  const effectiveCanUndo =
    canUndoAnnotationDelete !== undefined ? canUndoAnnotationDelete : localDeleted.length > 0;

  const createWithOptions = (
    options: Required<Pick<CreateAnnotationOptions, 'color' | 'style'>> & {
      note?: string;
    },
  ) => {
    const { color, style } = options;
    const note = options.note?.trim() || null;
    if (onCreateAnnotation) {
      onCreateAnnotation({ color, style, ...(note ? { note } : {}) });
      return;
    }
    if (!selection || selection.documentId !== documentId) return;
    setLocalAnnotations((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        documentId,
        notebookId: 'local-notebook',
        anchor: selection.anchor,
        excerptText: selection.text,
        excerptImagePath: null,
        note,
        color,
        style,
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const createHighlight = (options?: { color?: string; style?: AnnotationStyle }) => {
    const color = options?.color ?? activeColor;
    const style = options?.style ?? activeStyle;
    setActiveColor(color);
    setActiveStyle(style);
    setDraftNoteOpen(false);
    createWithOptions({ color, style });
  };

  const submitNoteSelection = () => {
    createWithOptions({ color: activeColor, style: activeStyle, note: draftNote });
    setDraftNote('');
    setDraftNoteOpen(false);
  };

  const updateAnnotation = (annotationId: string, patch: AnnotationPatch) => {
    if (onUpdateAnnotation) {
      onUpdateAnnotation(annotationId, patch);
      return;
    }
    setLocalAnnotations((prev) =>
      prev.map((candidate) =>
        candidate.id === annotationId
          ? {
              ...candidate,
              note: patch.note !== null ? patch.note.trim() || null : (candidate.note ?? null),
              color: patch.color !== null ? patch.color : candidate.color,
              style: patch.style ?? candidate.style,
            }
          : candidate,
      ),
    );
  };

  const deleteAnnotation = (annotationId: string) => {
    if (onDeleteAnnotation) {
      onDeleteAnnotation(annotationId);
      return;
    }
    const target = localAnnotations.find((candidate) => candidate.id === annotationId);
    if (!target) return;
    setLocalAnnotations((prev) => prev.filter((candidate) => candidate.id !== annotationId));
    setLocalDeleted((prev) => [...prev, target]);
  };

  const undoDelete = () => {
    if (onUndoAnnotationDelete) {
      onUndoAnnotationDelete();
      return;
    }
    const last = localDeleted.at(-1);
    if (!last) return;
    setLocalDeleted((prev) => prev.slice(0, -1));
    setLocalAnnotations((prev) => [...prev, last]);
  };

  return {
    annotations: effectiveAnnotations,
    activeColor,
    activeStyle,
    highlightMode,
    draftNoteOpen,
    draftNote,
    canUndoDelete: effectiveCanUndo,
    setActiveColor,
    setActiveStyle,
    toggleHighlightMode: () => setHighlightMode((current) => !current),
    setDraftNote,
    toggleDraftNote: () => setDraftNoteOpen((current) => !current),
    openDraftNote: () => setDraftNoteOpen(true),
    closeDraftNote: () => setDraftNoteOpen(false),
    createHighlight,
    submitNoteSelection,
    selectAnnotation: onSelectAnnotation,
    updateAnnotation,
    deleteAnnotation,
    undoDelete,
    isAnnotationStale: (annotation) => (isStaleAnnotation ? isStaleAnnotation(annotation) : false),
  };
}

/** The highlights an annotation list paints, for a viewer with no store behind it. */
export function localHighlights(annotations: readonly Annotation[]): ReaderHighlight[] {
  return annotations.map((annotation) => ({
    annotationId: annotation.id,
    anchor: annotation.anchor,
    color: annotation.color,
    style: annotation.style,
    hasNote: annotationHasNote(annotation),
  }));
}

/** A 28 px target around a 20 px swatch (WCAG 2.2 target size, HIG minimum). */
export const COLOR_TARGET_CLASS =
  'flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A highlight color swatch; the check mark shows the choice without relying on hue. */
export function ColorDot({
  color,
  selected,
  className,
}: {
  color: string;
  selected: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 items-center justify-center rounded-full border border-black/25 text-black/75',
        selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {selected && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function shortcutOf(id: 'edit.highlight' | 'edit.undoDelete'): string {
  const { shortcut } = commandDefinition(id);
  return shortcut ? formatShortcut(shortcut) : '';
}

/** Where an annotation sits, for grouping and ordering the list. */
export interface AnnotationPlacement {
  /** The chapter or section heading; omitted for formats without chapters. */
  group?: string;
  /** Document order; lower comes first. */
  order: number;
  /** What the row names its place as, in place of the format's default (a file name). */
  label?: string;
}

/** Whether an element's text is cut off by its line clamp. */
function isClamped(element: HTMLElement | null): boolean {
  return element !== null && element.scrollHeight > element.clientHeight + 1;
}

function AnnotationRow({
  annotation,
  locationLabel,
  linkedToCard,
  stale,
  tabIndex,
  onFocus,
  onKeyDown,
  onSelect,
  onUpdate,
  onDelete,
}: {
  annotation: Annotation;
  locationLabel: string;
  linkedToCard: boolean;
  stale: boolean;
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
  onUpdate: (patch: AnnotationPatch) => void;
  onDelete: (from: HTMLElement) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [noteDraft, setNoteDraft] = useState(annotation.note ?? '');
  const [prevPropNote, setPrevPropNote] = useState(annotation.note ?? '');
  if ((annotation.note ?? '') !== prevPropNote) {
    setPrevPropNote(annotation.note ?? '');
    setNoteDraft(annotation.note ?? '');
  }

  // Offer More only where the clamp actually hides text, at the sidebar's width.
  const excerptRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (expanded) return;
    const measure = () => setClamped(isClamped(excerptRef.current) || isClamped(noteRef.current));
    measure();
    if (typeof ResizeObserver === 'undefined' || !excerptRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(excerptRef.current);
    return () => observer.disconnect();
  }, [expanded, annotation.excerptText, annotation.note]);

  // Set by Esc and Cancel, so a blur as the field goes away cannot save the draft.
  const discarding = useRef(false);
  const commitNote = () => {
    if (discarding.current) return;
    const trimmed = noteDraft.trim();
    const current = annotation.note?.trim() ?? '';
    if (trimmed !== current) {
      onUpdate({ note: trimmed, color: null });
    }
  };
  const cancelEdit = () => {
    discarding.current = true;
    setNoteDraft(annotation.note ?? '');
    setEditing(false);
  };

  const date = formatShortDate(annotation.createdAt);
  const canExpand = expanded || clamped;

  return (
    <li
      data-testid="annotation-item"
      data-expanded={expanded ? 'true' : undefined}
      className="group/row flex flex-col"
    >
      <div className="flex items-start gap-0.5">
        <button
          type="button"
          data-roving-row=""
          data-testid="annotation-jump-button"
          tabIndex={tabIndex}
          aria-keyshortcuts={canExpand ? 'Backspace ArrowRight ArrowLeft' : 'Backspace'}
          onFocus={onFocus}
          onKeyDown={(event) => {
            // → and ← open and close a long row in place, as in a disclosure tree.
            if (canExpand && !event.metaKey && !event.ctrlKey && !event.altKey) {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                setExpanded(event.key === 'ArrowRight');
                return;
              }
            }
            onKeyDown(event);
          }}
          onClick={onSelect}
          className={rowClassName(false)}
        >
          <span className="flex items-start gap-2">
            <span
              aria-hidden="true"
              data-testid="annotation-color-chip"
              className="mt-1 inline-block size-2.5 shrink-0 rounded-full border border-black/20"
              style={{ backgroundColor: annotation.color }}
            />
            <span
              ref={excerptRef}
              data-testid="annotation-excerpt"
              className={cn('min-w-0 break-words', !expanded && 'line-clamp-3')}
            >
              {annotation.excerptText ??
                (annotation.excerptImagePath ? 'Captured image excerpt' : 'Note')}
            </span>
          </span>
          {annotation.note && !editing && (
            <span
              ref={noteRef}
              data-testid="annotation-note-preview"
              className={cn(
                'ml-4.5 border-l-2 pl-2 text-xs break-words whitespace-pre-wrap text-muted-foreground italic',
                !expanded && 'line-clamp-2',
              )}
            >
              {annotation.note}
            </span>
          )}
          <span className="ml-4.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span data-testid="annotation-location">{locationLabel}</span>
            {date && (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="annotation-date">{date}</span>
              </>
            )}
            {linkedToCard && (
              <span
                data-testid="annotation-card-badge"
                className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
              >
                <Link2 className="size-2.5" />
                In MindMap
              </span>
            )}
            {stale && (
              <span
                data-testid="annotation-stale"
                className="rounded bg-destructive/15 px-1.5 text-[10px] font-medium text-destructive"
              >
                Stale
              </span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center pt-1">
          {canExpand && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={expanded ? 'Show less' : 'Show more'}
              aria-expanded={expanded}
              title={expanded ? 'Show less (←)' : 'Show more (→)'}
              data-testid="annotation-expand-button"
              onClick={() => setExpanded((current) => !current)}
              className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform motion-reduce:transition-none',
                  expanded && 'rotate-180',
                )}
              />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Edit note and color at ${locationLabel}`}
            aria-expanded={editing}
            title="Edit note and color"
            data-testid="annotation-edit-button"
            onClick={() => {
              discarding.current = false;
              setEditing((current) => !current);
            }}
            className={cn(
              'flex size-6 items-center justify-center rounded text-muted-foreground transition-opacity outline-none group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-background hover:text-foreground motion-reduce:transition-none',
              editing ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Pencil className="size-3.5" />
          </button>
          <RowDeleteButton
            label={`Delete annotation at ${locationLabel}`}
            testId="annotation-delete-button"
            onDelete={onDelete}
          />
        </div>
      </div>
      {editing && (
        <div className="mb-1 ml-6 flex flex-col gap-1 pr-1">
          <div role="group" aria-label="Change highlight color" className="flex items-center">
            {ANNOTATION_COLORS.map(({ label, value }) => {
              const active = annotation.color === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-label={`Set highlight color ${label}`}
                  aria-pressed={active}
                  data-testid={`annotation-item-color-${label.toLowerCase()}`}
                  onClick={() => onUpdate({ note: null, color: value })}
                  className={COLOR_TARGET_CLASS}
                >
                  <ColorDot color={value} selected={active} />
                </button>
              );
            })}
          </div>
          <NoteEditor
            value={noteDraft}
            label={`Note for annotation at ${locationLabel}`}
            formLabel="Edit note"
            testId="annotation-note-input"
            formTestId="annotation-note-form"
            saveTestId="annotation-note-save"
            autoFocus
            onChange={setNoteDraft}
            onSave={() => {
              commitNote();
              setEditing(false);
            }}
            onCancel={cancelEdit}
            // Leaving the field keeps what was typed, so a click elsewhere loses nothing.
            onBlur={commitNote}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelEdit();
              }
            }}
          />
        </div>
      )}
    </li>
  );
}

/** Which rows the list shows, beyond the text filter. */
export interface AnnotationFilters {
  /** Empty shows every color. */
  colors: ReadonlySet<string>;
  noteOnly: boolean;
}

/** The annotations matching the text filter, the chosen colors, and Has Note. */
export function filterAnnotations(
  annotations: readonly Annotation[],
  text: string,
  filters: AnnotationFilters,
): Annotation[] {
  const needle = text.trim().toLowerCase();
  return annotations.filter(
    (annotation) =>
      (filters.colors.size === 0 || filters.colors.has(annotation.color)) &&
      (!filters.noteOnly || annotationHasNote(annotation)) &&
      (!needle ||
        (annotation.excerptText ?? '').toLowerCase().includes(needle) ||
        (annotation.note ?? '').toLowerCase().includes(needle)),
  );
}

function AnnotationFilterBar({
  filters,
  onChange,
}: {
  filters: AnnotationFilters;
  onChange: (filters: AnnotationFilters) => void;
}) {
  const toggleColor = (color: string) => {
    const colors = new Set(filters.colors);
    if (colors.has(color)) colors.delete(color);
    else colors.add(color);
    onChange({ ...filters, colors });
  };
  return (
    <div
      role="group"
      aria-label="Show only"
      data-testid="annotation-filters"
      className="flex shrink-0 items-center gap-0.5 border-b px-2 py-0.5"
    >
      {ANNOTATION_COLORS.map(({ label, value }) => {
        const pressed = filters.colors.has(value);
        return (
          <button
            key={value}
            type="button"
            aria-label={`Show ${label} highlights`}
            aria-pressed={pressed}
            title={`Show ${label} highlights`}
            data-testid={`annotation-filter-color-${label.toLowerCase()}`}
            onClick={() => toggleColor(value)}
            className={COLOR_TARGET_CLASS}
          >
            <ColorDot color={value} selected={pressed} className="size-4" />
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={filters.noteOnly}
        title="Show only highlights with a note"
        data-testid="annotation-filter-has-note"
        onClick={() => onChange({ ...filters, noteOnly: !filters.noteOnly })}
        className={cn(
          'ml-auto flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          filters.noteOnly && 'bg-accent text-foreground',
        )}
      >
        <StickyNote aria-hidden="true" className="size-3" />
        Has Note
      </button>
    </div>
  );
}

const NO_FILTERS: AnnotationFilters = { colors: new Set(), noteOnly: false };

/**
 * The Navigator's Highlights & Notes tab: grouped by chapter, each row with its
 * color, excerpt, note, and date.
 */
export function AnnotationsList({
  controller,
  filter,
  linkedAnnotationIds,
  placementOf,
  compareWithinOrder,
  onDeleted,
}: {
  controller: AnnotationsController;
  filter: string;
  linkedAnnotationIds?: ReadonlySet<string>;
  placementOf?: (annotation: Annotation) => AnnotationPlacement;
  /**
   * Orders annotations that share a placement order, such as two in one EPUB
   * chapter. Without it they keep the order they were made in.
   */
  compareWithinOrder?: (a: Annotation, b: Annotation) => number;
  /** Told after a row is deleted, so ⌘Z knows what to restore. */
  onDeleted?: () => void;
}) {
  const [filters, setFilters] = useState<AnnotationFilters>(NO_FILTERS);
  const placed = filterAnnotations(controller.annotations, filter, filters)
    .map((annotation, index) => ({
      annotation,
      placement: placementOf?.(annotation) ?? { order: index },
    }))
    .sort(
      (a, b) =>
        a.placement.order - b.placement.order ||
        (compareWithinOrder?.(a.annotation, b.annotation) ?? 0),
    );
  const roving = useRovingList(placed.length);
  const filtering = filters.colors.size > 0 || filters.noteOnly;

  const header = (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b px-3 text-[11px] text-muted-foreground">
      <span data-testid="annotations-count">
        {filtering || filter.trim() ? `${placed.length} of ` : ''}
        {controller.annotations.length}{' '}
        {controller.annotations.length === 1 ? 'highlight' : 'highlights'}
      </span>
      {controller.canUndoDelete && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          aria-label="Undo annotation deletion"
          title={`Undo annotation deletion (${shortcutOf('edit.undoDelete')})`}
          data-testid="undo-delete-annotation-button"
          onClick={controller.undoDelete}
        >
          <Undo2 className="size-3" />
          Undo
        </Button>
      )}
    </div>
  );

  let body;
  if (controller.annotations.length === 0) {
    body = (
      <NavigatorEmptyState testId="annotations-empty" title="No highlights or notes yet">
        Select text, then choose a color in the popover above it, or press{' '}
        {shortcutOf('edit.highlight')} to highlight it.
      </NavigatorEmptyState>
    );
  } else if (placed.length === 0) {
    body = <NavigatorEmptyState testId="annotations-no-match" title="No matching highlights" />;
  } else {
    body = (
      <ol
        {...roving.listProps}
        aria-label="Highlights and notes"
        data-testid="annotations-list"
        data-arrow-keys=""
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
      >
        {placed.map(({ annotation, placement }, index) => {
          const groupStart =
            placement.group !== undefined && placed[index - 1]?.placement.group !== placement.group;
          const remove = (from: HTMLElement) => {
            roving.refocusAfterRemoval(from, index);
            controller.deleteAnnotation(annotation.id);
            onDeleted?.();
          };
          return (
            <Fragment key={annotation.id}>
              {groupStart && (
                <li
                  role="presentation"
                  data-testid="annotation-group"
                  className="sticky top-0 z-10 truncate bg-background/95 px-2 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground backdrop-blur-sm"
                >
                  {placement.group}
                </li>
              )}
              <AnnotationRow
                annotation={annotation}
                locationLabel={placement.label ?? formatAnnotationLocation(annotation)}
                linkedToCard={linkedAnnotationIds?.has(annotation.id) ?? false}
                stale={controller.isAnnotationStale(annotation)}
                tabIndex={roving.tabIndexFor(index)}
                onFocus={() => roving.onRowFocus(index)}
                onKeyDown={(event) => {
                  if (roving.onRowKeyDown(event, index)) return;
                  if (isDeleteKey(event)) {
                    event.preventDefault();
                    remove(event.currentTarget);
                  }
                }}
                onSelect={() => controller.selectAnnotation(annotation)}
                onUpdate={(patch) => controller.updateAnnotation(annotation.id, patch)}
                onDelete={remove}
              />
            </Fragment>
          );
        })}
      </ol>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="annotations-panel">
      {header}
      {controller.annotations.length > 0 && (
        <AnnotationFilterBar filters={filters} onChange={setFilters} />
      )}
      {body}
    </div>
  );
}
