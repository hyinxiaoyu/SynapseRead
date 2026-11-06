import { Check, Highlighter, Link2, MessageSquare, Pencil, StickyNote, Undo2 } from 'lucide-react';
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { commandDefinition, formatShortcut } from '@/features/commands/commands';
import {
  formatShortDate,
  NavigatorEmptyState,
  RowDeleteButton,
  rowClassName,
} from '@/features/reader/navigator/parts';
import { isDeleteKey, useRovingList } from '@/features/reader/navigator/useRovingList';
import { collapseClass, ToolbarButton } from '@/features/reader/ReaderToolbar';
import { cn } from '@/lib/utils';
import type { Annotation, AnnotationPatch, ReaderSelection } from '@/types/domain';

export const ANNOTATION_COLORS: readonly { label: string; value: string }[] = [
  { label: 'Yellow', value: '#fde047' },
  { label: 'Green', value: '#86efac' },
  { label: 'Blue', value: '#93c5fd' },
  { label: 'Pink', value: '#f9a8d4' },
];

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
  activeColor: string;
  draftNoteOpen: boolean;
  draftNote: string;
  canUndoDelete: boolean;
  setActiveColor: (color: string) => void;
  setDraftNote: (value: string) => void;
  toggleDraftNote: () => void;
  closeDraftNote: () => void;
  createHighlight: () => void;
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
  onCreateAnnotation?: ((options?: { color?: string; note?: string }) => void) | undefined;
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
  const [activeColor, setActiveColor] = useState<string>(ANNOTATION_COLORS[0]?.value ?? '#fde047');
  const [draftNoteOpen, setDraftNoteOpen] = useState(false);
  const [draftNote, setDraftNote] = useState('');
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>([]);
  const [localDeleted, setLocalDeleted] = useState<Annotation[]>([]);

  const effectiveAnnotations = annotations ?? localAnnotations;
  const effectiveCanUndo =
    canUndoAnnotationDelete !== undefined ? canUndoAnnotationDelete : localDeleted.length > 0;

  const createWithOptions = (options?: { color?: string; note?: string }) => {
    const color = options?.color ?? activeColor;
    const note = options?.note?.trim() || null;
    if (onCreateAnnotation) {
      onCreateAnnotation({ color, ...(note ? { note } : {}) });
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
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const createHighlight = () => {
    createWithOptions({ color: activeColor });
  };

  const submitNoteSelection = () => {
    createWithOptions({ color: activeColor, note: draftNote });
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
    draftNoteOpen,
    draftNote,
    canUndoDelete: effectiveCanUndo,
    setActiveColor,
    setDraftNote,
    toggleDraftNote: () => setDraftNoteOpen((current) => !current),
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

/**
 * The markup group: highlight colors, Highlight, and Add note. Colors fold into
 * the `»` menu's width budget first; the two actions stay.
 */
/** A 28 px target around a 20 px swatch (WCAG 2.2 target size, HIG minimum). */
const COLOR_TARGET_CLASS =
  'flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A highlight color swatch; the check mark shows the choice without relying on hue. */
function ColorDot({ color, selected }: { color: string; selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 items-center justify-center rounded-full border border-black/25 text-black/75',
        selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
      )}
      style={{ backgroundColor: color }}
    >
      {selected && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

export function SelectionAnnotationControls({
  hasSelection,
  disabled = false,
  controller,
}: {
  hasSelection: boolean;
  disabled?: boolean;
  controller: AnnotationsController;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <div
        role="group"
        aria-label="Highlight color"
        className={cn('flex items-center px-0.5', collapseClass('lg'))}
        data-testid="annotation-color-picker"
      >
        {ANNOTATION_COLORS.map(({ label, value }) => {
          const selected = controller.activeColor === value;
          return (
            <button
              key={value}
              type="button"
              aria-label={`Highlight color ${label}`}
              aria-pressed={selected}
              title={`Highlight color ${label}`}
              data-testid={`annotation-color-${label.toLowerCase()}`}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.setActiveColor(value)}
              className={COLOR_TARGET_CLASS}
            >
              <ColorDot color={value} selected={selected} />
            </button>
          );
        })}
      </div>
      <ToolbarButton
        icon={Highlighter}
        label="Highlight selection"
        command="edit.highlight"
        testId="highlight-selection-button"
        disabled={disabled || !hasSelection}
        preserveSelection
        onClick={controller.createHighlight}
      />
      <ToolbarButton
        icon={StickyNote}
        label="Add note to selection"
        command="edit.addNote"
        pressed={controller.draftNoteOpen}
        testId="add-note-selection-button"
        disabled={disabled || !hasSelection}
        preserveSelection
        onClick={controller.toggleDraftNote}
      />
    </div>
  );
}

export function SelectionNoteComposer({
  hasSelection,
  controller,
}: {
  hasSelection: boolean;
  controller: AnnotationsController;
}) {
  if (!controller.draftNoteOpen || !hasSelection) return null;

  return (
    <form
      aria-label="Add note to selection"
      data-testid="selection-note-composer"
      data-reader-popover=""
      className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        controller.submitNoteSelection();
      }}
    >
      <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        aria-label="Selection note"
        data-testid="selection-note-input"
        placeholder="Write a note for this highlight…"
        value={controller.draftNote}
        onChange={(event) => controller.setDraftNote(event.target.value)}
        className="h-6 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button
        type="submit"
        size="sm"
        className="h-6 px-2 text-xs"
        data-testid="save-selection-note-button"
        onMouseDown={(event) => event.preventDefault()}
      >
        Save note
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onMouseDown={(event) => event.preventDefault()}
        onClick={controller.closeDraftNote}
      >
        Cancel
      </Button>
    </form>
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
}

function AnnotationRow({
  annotation,
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
  const [noteDraft, setNoteDraft] = useState(annotation.note ?? '');
  const [prevPropNote, setPrevPropNote] = useState(annotation.note ?? '');
  if ((annotation.note ?? '') !== prevPropNote) {
    setPrevPropNote(annotation.note ?? '');
    setNoteDraft(annotation.note ?? '');
  }

  const commitNote = () => {
    const trimmed = noteDraft.trim();
    const current = annotation.note?.trim() ?? '';
    if (trimmed !== current) {
      onUpdate({ note: trimmed, color: null });
    }
  };

  const locationLabel = formatAnnotationLocation(annotation);
  const date = formatShortDate(annotation.createdAt);

  return (
    <li data-testid="annotation-item" className="group/row flex flex-col">
      <div className="flex items-start gap-0.5">
        <button
          type="button"
          data-roving-row=""
          data-testid="annotation-jump-button"
          tabIndex={tabIndex}
          aria-keyshortcuts="Backspace"
          onFocus={onFocus}
          onKeyDown={onKeyDown}
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
            <span data-testid="annotation-excerpt" className="line-clamp-3 min-w-0 break-words">
              {annotation.excerptText ??
                (annotation.excerptImagePath ? 'Captured image excerpt' : 'Note')}
            </span>
          </span>
          {annotation.note && (
            <span
              data-testid="annotation-note-preview"
              className="ml-4.5 line-clamp-2 border-l-2 pl-2 text-xs break-words text-muted-foreground italic"
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
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Edit note and color at ${locationLabel}`}
            aria-expanded={editing}
            title="Edit note and color"
            data-testid="annotation-edit-button"
            onClick={() => setEditing((current) => !current)}
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
        <div className="mb-1 ml-6 flex items-center gap-1.5 pr-1">
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
          <input
            type="text"
            aria-label={`Note for annotation at ${locationLabel}`}
            data-testid="annotation-note-input"
            placeholder="Add a note…"
            value={noteDraft}
            autoFocus
            onChange={(event) => setNoteDraft(event.target.value)}
            onBlur={commitNote}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitNote();
                setEditing(false);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setNoteDraft(annotation.note ?? '');
                setEditing(false);
              }
            }}
            className="h-6 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      )}
    </li>
  );
}

/**
 * The Navigator's Highlights & Notes tab: grouped by chapter, each row with its
 * color, excerpt, note, and date.
 */
export function AnnotationsList({
  controller,
  filter,
  linkedAnnotationIds,
  placementOf,
  onDeleted,
}: {
  controller: AnnotationsController;
  filter: string;
  linkedAnnotationIds?: ReadonlySet<string>;
  placementOf?: (annotation: Annotation) => AnnotationPlacement;
  /** Told after a row is deleted, so ⌘Z knows what to restore. */
  onDeleted?: () => void;
}) {
  const needle = filter.trim().toLowerCase();
  const placed = controller.annotations
    .filter(
      (annotation) =>
        !needle ||
        (annotation.excerptText ?? '').toLowerCase().includes(needle) ||
        (annotation.note ?? '').toLowerCase().includes(needle),
    )
    .map((annotation, index) => ({
      annotation,
      placement: placementOf?.(annotation) ?? { order: index },
    }))
    .sort((a, b) => a.placement.order - b.placement.order);
  const roving = useRovingList(placed.length);

  const header = (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b px-3 text-[11px] text-muted-foreground">
      <span>
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
        Select text, then press {shortcutOf('edit.highlight')} to highlight it or choose Add Note.
      </NavigatorEmptyState>
    );
  } else if (placed.length === 0) {
    body = <NavigatorEmptyState title="No matching highlights" />;
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
      {body}
    </div>
  );
}
