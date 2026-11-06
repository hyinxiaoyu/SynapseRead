import {
  Highlighter,
  Link2,
  MessageSquare,
  NotebookPen,
  StickyNote,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  collapseClass,
  type ToolbarCollapse,
  ToolbarButton,
} from '@/features/reader/ReaderToolbar';
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
  open: boolean;
  annotations: readonly Annotation[];
  activeColor: string;
  draftNoteOpen: boolean;
  draftNote: string;
  canUndoDelete: boolean;
  setActiveColor: (color: string) => void;
  setDraftNote: (value: string) => void;
  toggleDraftNote: () => void;
  closeDraftNote: () => void;
  togglePanel: () => void;
  closePanel: () => void;
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
  const [open, setOpen] = useState(false);
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
    open,
    annotations: effectiveAnnotations,
    activeColor,
    draftNoteOpen,
    draftNote,
    canUndoDelete: effectiveCanUndo,
    setActiveColor,
    setDraftNote,
    toggleDraftNote: () => setDraftNoteOpen((current) => !current),
    closeDraftNote: () => setDraftNoteOpen(false),
    togglePanel: () => setOpen((current) => !current),
    closePanel: () => setOpen(false),
    createHighlight,
    submitNoteSelection,
    selectAnnotation: onSelectAnnotation,
    updateAnnotation,
    deleteAnnotation,
    undoDelete,
    isAnnotationStale: (annotation) => (isStaleAnnotation ? isStaleAnnotation(annotation) : false),
  };
}

export function AnnotationsListToggleButton({
  open,
  count,
  disabled = false,
  collapse,
  onToggle,
}: {
  open: boolean;
  count: number;
  disabled?: boolean;
  collapse?: ToolbarCollapse;
  onToggle: () => void;
}) {
  return (
    <ToolbarButton
      icon={NotebookPen}
      label="Annotations"
      command="view.sidebarAnnotations"
      pressed={open}
      testId="annotations-toggle-button"
      badge={count}
      badgeTestId="annotations-count"
      disabled={disabled}
      {...(collapse ? { collapse } : {})}
      onClick={onToggle}
    />
  );
}

/**
 * The markup group: highlight colors, Highlight, and Add note. Colors fold into
 * the `»` menu's width budget first; the two actions stay.
 */
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
        className={cn('flex items-center gap-1 px-1', collapseClass('lg'))}
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
              className={cn(
                'size-3.5 rounded-full border border-black/25 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'scale-115 ring-2 ring-foreground',
              )}
              style={{ backgroundColor: value }}
            />
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

function AnnotationListItem({
  annotation,
  linkedToCard,
  stale,
  onSelect,
  onUpdate,
  onDelete,
}: {
  annotation: Annotation;
  linkedToCard: boolean;
  stale: boolean;
  onSelect: () => void;
  onUpdate: (patch: AnnotationPatch) => void;
  onDelete: () => void;
}) {
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

  return (
    <li data-testid="annotation-item" className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          data-testid="annotation-jump-button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded px-1.5 py-0.5 text-left text-xs transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className="inline-block size-2.5 shrink-0 rounded-full border border-black/20"
              style={{ backgroundColor: annotation.color }}
            />
            <span data-testid="annotation-location">{locationLabel}</span>
            {linkedToCard && (
              <span
                data-testid="annotation-card-badge"
                className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.2 text-[10px] font-medium text-secondary-foreground"
              >
                <Link2 className="size-2.5" />
                In MindMap
              </span>
            )}
            {stale && (
              <span
                data-testid="annotation-stale"
                className="rounded bg-destructive/15 px-1.5 py-0.2 text-[10px] font-medium text-destructive"
              >
                Stale
              </span>
            )}
          </div>
          <p data-testid="annotation-excerpt" className="line-clamp-2 text-xs text-foreground">
            {annotation.excerptText ??
              (annotation.excerptImagePath ? 'Captured image excerpt' : 'Note')}
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <div role="group" aria-label="Change highlight color" className="flex items-center gap-1">
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
                  className={cn(
                    'size-3 rounded-full border border-black/25 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'scale-115 ring-1 ring-foreground',
                  )}
                  style={{ backgroundColor: value }}
                />
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Delete annotation at ${locationLabel}`}
            data-testid="annotation-delete-button"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 pl-1.5">
        <input
          type="text"
          aria-label={`Note for annotation at ${locationLabel}`}
          data-testid="annotation-note-input"
          placeholder="Add a note…"
          value={noteDraft}
          onChange={(event) => setNoteDraft(event.target.value)}
          onBlur={commitNote}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitNote();
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </li>
  );
}

export function AnnotationsPanel({
  controller,
  linkedAnnotationIds,
}: {
  controller: AnnotationsController;
  linkedAnnotationIds?: ReadonlySet<string>;
}) {
  if (!controller.open) return null;

  return (
    <div
      role="region"
      aria-label="Annotations"
      data-testid="annotations-panel"
      data-reader-popover=""
      className="shrink-0 border-b bg-background text-xs text-foreground"
    >
      <div className="flex items-center justify-between border-b px-3 py-1">
        <span className="font-medium text-muted-foreground">
          Document highlights & notes ({controller.annotations.length})
        </span>
        {controller.canUndoDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            aria-label="Undo annotation deletion"
            data-testid="undo-delete-annotation-button"
            onClick={controller.undoDelete}
          >
            <Undo2 className="size-3.5" />
            Undo delete
          </Button>
        )}
      </div>
      {controller.annotations.length === 0 ? (
        <p data-testid="annotations-empty" className="px-3 py-2 text-xs text-muted-foreground">
          No highlights or notes in this document.
        </p>
      ) : (
        <ol
          aria-label="Annotation list"
          data-testid="annotations-list"
          className="max-h-48 divide-y overflow-y-auto bg-muted/20"
        >
          {controller.annotations.map((annotation) => (
            <AnnotationListItem
              key={annotation.id}
              annotation={annotation}
              linkedToCard={linkedAnnotationIds?.has(annotation.id) ?? false}
              stale={controller.isAnnotationStale(annotation)}
              onSelect={() => controller.selectAnnotation(annotation)}
              onUpdate={(patch) => controller.updateAnnotation(annotation.id, patch)}
              onDelete={() => controller.deleteAnnotation(annotation.id)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
