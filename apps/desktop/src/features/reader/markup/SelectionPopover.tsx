import { Copy, Network, Pencil, Quote, StickyNote, Trash2, Underline, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { commandTooltip } from '@/features/commands/commands';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { useCommands } from '@/features/commands/registry';
import { excerptActionLabel } from '@/features/mindmap/nestingLabel';
import {
  type AnnotationsController,
  COLOR_TARGET_CLASS,
  ColorDot,
} from '@/features/reader/AnnotationsPanel';
import { CardSourceDeleteConfirm } from '@/features/reader/CardSourceDeleteConfirm';
import { useColorShortcut } from '@/features/reader/markup/colorShortcut';
import { ANNOTATION_COLORS } from '@/features/reader/markup/palette';
import { NoteEditor } from '@/features/reader/markup/NoteEditor';
import { placePopover, toViewportRect, type ViewportRect } from '@/features/reader/markup/geometry';
import type { SelectionPopoverController } from '@/features/reader/markup/useSelectionPopover';
import { cn } from '@/lib/utils';
import { type Annotation, annotationHasNote, type ReaderSelection } from '@/types/domain';

/** Copies text, falling back to the editing command where the async API is refused. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
}

/** Keeps the reader's text selection alive through a press on a popover control. */
const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function PopoverAction({
  icon: Icon,
  label,
  title,
  pressed,
  disabled = false,
  testId,
  onClick,
  children,
}: {
  icon: typeof Copy;
  label: string;
  title?: string;
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
  testId: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      data-testid={testId}
      data-popover-control=""
      tabIndex={-1}
      onMouseDown={keepSelection}
      onClick={onClick}
      className={cn(
        'flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4',
        pressed && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * Apple Books' selection callout: colors, Underline, Note, Excerpt to MindMap,
 * and Copy beside the selection, or, for a highlight that was clicked, its color,
 * style, note, and Delete. Lives in reader code and acts only through the
 * annotations controller and the viewer's callbacks.
 */
export function SelectionPopover({
  popover,
  annotations,
  selection,
  boundsRef,
  onExcerpt,
  canExcerpt = true,
  excerptTargetTitle,
  onClearExcerptTarget,
  onReturnFocus,
}: {
  popover: SelectionPopoverController;
  annotations: AnnotationsController;
  selection: ReaderSelection | null;
  /** The reader's area: the popover stays inside it. */
  boundsRef: RefObject<HTMLElement | null>;
  onExcerpt?: (() => void) | undefined;
  canExcerpt?: boolean | undefined;
  /** Title of the MindMap card new excerpts will nest under, or `null` for a new root (#127). */
  excerptTargetTitle?: string | null | undefined;
  /** Clears the active nesting target without leaving the reader (#127). */
  onClearExcerptTarget?: (() => void) | undefined;
  /** Where focus goes when the popover is put away with Esc. */
  onReturnFocus: () => void;
}) {
  const { target } = popover;
  const annotation: Annotation | null =
    target?.kind === 'annotation'
      ? (annotations.annotations.find((candidate) => candidate.id === target.annotationId) ?? null)
      : null;
  const editing = annotation !== null;
  const isCardSource = annotation !== null && (annotations.isCardSource?.(annotation.id) ?? false);
  const isExcerptingAnnotation =
    annotation !== null && (annotations.isExcerptingAnnotation?.(annotation.id) ?? false);
  const canExcerptTarget = editing
    ? !isCardSource && annotations.excerptAnnotation !== undefined
    : onExcerpt !== undefined;
  const canShowCard = editing && isCardSource && annotations.showAnnotationCard !== undefined;
  const normalizedTargetTitle = excerptTargetTitle?.trim() || null;
  const excerptLabel = excerptActionLabel(normalizedTargetTitle);
  // A whitespace-only note (imported, or saved before notes were trimmed) counts as none.
  const hasNote = annotation !== null && annotationHasNote(annotation);

  const chooseColor = (color: string) => {
    // Recoloring a highlight changes that highlight, not the default for new ones.
    if (annotation) {
      annotations.updateAnnotation(annotation.id, { note: null, color, style: null });
      return;
    }
    annotations.createHighlight({ color, style: 'highlight' });
  };

  // 1–5 pick a color while this popover is open, wherever the focus is: the page,
  // a chapter's iframe, or one of its own controls (#50).
  const shown = target !== null;
  useColorShortcut(shown ? chooseColor : null);

  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');

  // ---- Placement: beside the selection, inside the reader, following scrolls --

  const annotationRect = target?.kind === 'annotation' ? target.rect : null;
  const { selectionRect } = popover;
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const root = rootRef.current;
      const boundsElement = boundsRef.current;
      if (!root || !boundsElement) return;
      const bounds: ViewportRect = toViewportRect(boundsElement.getBoundingClientRect());
      const anchor = editing ? annotationRect : selectionRect();
      const next = placePopover(
        anchor,
        { width: root.offsetWidth, height: root.offsetHeight },
        bounds,
      );
      setPosition((current) =>
        current && current.top === next.top && current.left === next.left
          ? current
          : { top: next.top, left: next.left },
      );
      setPlacement(next.placement);
    };
    place();
    const view = rootRef.current?.ownerDocument.defaultView;
    view?.addEventListener('scroll', place, true);
    view?.addEventListener('resize', place);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    if (rootRef.current) observer?.observe(rootRef.current);
    return () => {
      view?.removeEventListener('scroll', place, true);
      view?.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [shown, editing, annotationRect, selectionRect, selection, boundsRef, popover.noteOpen]);

  // ---- A highlight's popover closes on a press anywhere else ---------------

  const { dismiss } = popover;
  useEffect(() => {
    if (!editing) return;
    const view = rootRef.current?.ownerDocument.defaultView;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    view?.addEventListener('pointerdown', onPointerDown, true);
    return () => view?.removeEventListener('pointerdown', onPointerDown, true);
  }, [editing, dismiss]);

  // ---- Focus: ⇧F10 and Add Note move into the popover ----------------------

  const noteFieldRef = useRef<HTMLTextAreaElement>(null);
  const handledFocusRequest = useRef(popover.focusRequest);
  useEffect(() => {
    if (!shown || handledFocusRequest.current === popover.focusRequest) return;
    handledFocusRequest.current = popover.focusRequest;
    if (popover.noteOpen) noteFieldRef.current?.focus();
    else rootRef.current?.querySelector<HTMLElement>('[data-popover-control]')?.focus();
  }, [shown, popover.focusRequest, popover.noteOpen]);

  // ---- The note being written or edited ------------------------------------

  const [editNote, setEditNote] = useState('');
  const [editNoteFor, setEditNoteFor] = useState<string | null>(null);
  const [editNoteDirty, setEditNoteDirty] = useState(false);
  const [prevAnnotationNote, setPrevAnnotationNote] = useState<string | null>(null);
  if (editing && popover.noteOpen && editNoteFor !== annotation.id) {
    setEditNoteFor(annotation.id);
    setEditNote(annotation.note ?? '');
    setEditNoteDirty(false);
    setPrevAnnotationNote(annotation.note ?? '');
  }
  if (!popover.noteOpen && editNoteFor !== null) {
    setEditNoteFor(null);
    setEditNoteDirty(false);
    setPrevAnnotationNote(null);
  }

  // Track an in-flight note save so the editor closes only once persistence confirms,
  // preserving the draft on failure and letting immediate Excerpt/Show wait on the result (#124).
  const [savingNote, setSavingNote] = useState<{ annotationId: string; draft: string } | null>(
    null,
  );
  const [queuedActionWhileSaving, setQueuedActionWhileSaving] = useState(false);
  const pendingNoteSaveRef = useRef<{
    seq: number;
    annotationId: string;
    draft: string;
    queuedAction: 'excerpt' | 'show' | null;
  } | null>(null);
  const saveSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const latestEditNoteRef = useRef(editNote);
  const activeAnnotationIdRef = useRef<string | null>(annotation?.id ?? null);
  const latestCallbacksRef = useRef({
    closeNote: popover.closeNote,
    dismiss,
    onReturnFocus,
    excerptAnnotation: annotations.excerptAnnotation,
    showAnnotationCard: annotations.showAnnotationCard,
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    latestEditNoteRef.current = editNote;
    activeAnnotationIdRef.current = annotation?.id ?? null;
    latestCallbacksRef.current = {
      closeNote: popover.closeNote,
      dismiss,
      onReturnFocus,
      excerptAnnotation: annotations.excerptAnnotation,
      showAnnotationCard: annotations.showAnnotationCard,
    };
  });

  if (
    savingNote !== null &&
    (!editing || !popover.noteOpen || savingNote.annotationId !== annotation.id)
  ) {
    setSavingNote(null);
    setQueuedActionWhileSaving(false);
  }
  if (
    editing &&
    popover.noteOpen &&
    editNoteFor === annotation.id &&
    (annotation.note ?? '') !== prevAnnotationNote
  ) {
    setPrevAnnotationNote(annotation.note ?? '');
    if (!editNoteDirty && savingNote === null) {
      setEditNote(annotation.note ?? '');
    }
  }
  useEffect(() => {
    const pending = pendingNoteSaveRef.current;
    if (pending && (!editing || !popover.noteOpen || pending.annotationId !== annotation.id)) {
      pendingNoteSaveRef.current = null;
    }
  }, [editing, popover.noteOpen, annotation?.id]);

  // Deleting a card's source asks first; the question goes with the popover.
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null);
  if (
    (!editing || popover.noteOpen || isExcerptingAnnotation || queuedActionWhileSaving) &&
    confirmDeleteFor !== null
  ) {
    setConfirmDeleteFor(null);
  }
  const confirmingDelete = editing && confirmDeleteFor === annotation.id;
  const noteValue = editing ? editNote : annotations.draftNote;

  // Guard MindMap actions while an existing highlight has unsaved note edits so
  // clicking Excerpt/Show (or using ⇧⌘E / the Edit menu) never drops the draft (#124).
  // While a save is still in flight, compare against that submitted draft rather than
  // the stale `annotation.note` so reverting back to the old value cannot bypass the guard.
  const savingForActive =
    editing && savingNote !== null && savingNote.annotationId === annotation.id ? savingNote : null;
  const isSavingCurrentDraft =
    savingForActive !== null && savingForActive.draft.trim() === editNote.trim();
  const committedNote = savingForActive ? savingForActive.draft : (annotation?.note ?? '');
  const hasUnsavedNoteChanges =
    editing &&
    popover.noteOpen &&
    !isSavingCurrentDraft &&
    editNote.trim() !== committedNote.trim();
  const [unsavedNotePromptFor, setUnsavedNotePromptFor] = useState<string | null>(null);
  if ((!editing || !hasUnsavedNoteChanges) && unsavedNotePromptFor !== null) {
    setUnsavedNotePromptFor(null);
  }
  const showingUnsavedNotePrompt = editing && unsavedNotePromptFor === annotation.id;

  const close = () => {
    pendingNoteSaveRef.current = null;
    setSavingNote(null);
    setQueuedActionWhileSaving(false);
    dismiss();
    onReturnFocus();
  };

  const guardUnsavedNote = (): boolean => {
    if (!editing || !popover.noteOpen) return false;
    const draft = latestEditNoteRef.current.trim();
    const pending = pendingNoteSaveRef.current;
    const committed =
      pending && pending.annotationId === annotation.id
        ? pending.draft.trim()
        : (annotation.note ?? '').trim();
    if (draft === committed) return false;
    setUnsavedNotePromptFor(annotation.id);
    noteFieldRef.current?.focus();
    return true;
  };

  const triggerExcerpt = () => {
    if (!canExcerpt) return;
    if (guardUnsavedNote()) return;
    if (annotation) {
      const pending = pendingNoteSaveRef.current;
      if (
        pending &&
        pending.annotationId === annotation.id &&
        pending.draft.trim() === latestEditNoteRef.current.trim()
      ) {
        pending.queuedAction = 'excerpt';
        setQueuedActionWhileSaving(true);
        return;
      }
      annotations.excerptAnnotation?.(annotation.id);
    } else {
      onExcerpt?.();
    }
    close();
  };

  const triggerShowCard = () => {
    if (!annotation) return;
    if (guardUnsavedNote()) return;
    const pending = pendingNoteSaveRef.current;
    if (
      pending &&
      pending.annotationId === annotation.id &&
      pending.draft.trim() === latestEditNoteRef.current.trim()
    ) {
      pending.queuedAction = 'show';
      setQueuedActionWhileSaving(true);
      return;
    }
    annotations.showAnnotationCard?.(annotation.id);
    close();
  };

  const cancelDelete = () => {
    setConfirmDeleteFor(null);
    rootRef.current?.querySelector<HTMLElement>('[data-testid="popover-delete"]')?.focus();
  };

  // Esc from the page, or forwarded from an EPUB chapter, while focus is not in
  // the popover: the note or delete confirmation closes first, then the popover.
  // Inside the popover its own key handler does the same.
  const { closeNote } = popover;
  useEscapeLayer(
    ESCAPE_LAYER.noteField,
    shown && popover.noteOpen
      ? () => {
          closeNote();
          return true;
        }
      : null,
  );
  useEscapeLayer(
    ESCAPE_LAYER.selectionPopover,
    shown
      ? () => {
          if (confirmingDelete) {
            setConfirmDeleteFor(null);
            return true;
          }
          dismiss();
          onReturnFocus();
          return true;
        }
      : null,
  );
  // While an existing highlight's popover is open, ⇧⌘E sends it to the MindMap
  // (or reveals its card if already linked), sharing the unsaved-note guard (#124).
  useCommands(
    {
      'edit.excerpt': {
        run: () => {
          if (canShowCard) triggerShowCard();
          else if (canExcerptTarget) triggerExcerpt();
        },
        enabled: canShowCard || (canExcerpt && canExcerptTarget),
        title: canShowCard ? 'Show in MindMap' : excerptLabel,
      },
    },
    shown && editing && (canExcerptTarget || canShowCard),
  );

  if (!shown) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (popover.noteOpen) {
        popover.closeNote();
        rootRef.current?.querySelector<HTMLElement>('[data-testid="popover-note"]')?.focus();
        return;
      }
      if (confirmingDelete) {
        cancelDelete();
        return;
      }
      close();
      return;
    }
    if (event.target instanceof HTMLTextAreaElement) return;
    // A toolbar: arrows move between controls, so only one is in the Tab order.
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const controls = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[data-popover-control]:not(:disabled)') ?? [],
    );
    const index = controls.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? controls.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  };

  const toggleUnderline = () => {
    if (annotation) {
      const style = annotation.style === 'underline' ? 'highlight' : 'underline';
      annotations.updateAnnotation(annotation.id, { note: null, color: null, style });
      return;
    }
    annotations.createHighlight({ style: 'underline' });
  };

  const toggleNote = () => {
    if (popover.noteOpen) popover.closeNote();
    else popover.openNote();
  };

  const saveNote = () => {
    if (annotation) {
      const draft = latestEditNoteRef.current;
      const existing = pendingNoteSaveRef.current;
      if (
        existing &&
        existing.annotationId === annotation.id &&
        existing.draft.trim() === draft.trim()
      ) {
        return;
      }
      const result = annotations.updateAnnotation(annotation.id, { note: draft, color: null });
      if (!isPromiseLike<boolean>(result)) {
        setEditNoteDirty(false);
        popover.closeNote();
        return;
      }
      const seq = (saveSeqRef.current += 1);
      const entry = {
        seq,
        annotationId: annotation.id,
        draft,
        queuedAction: null as 'excerpt' | 'show' | null,
      };
      pendingNoteSaveRef.current = entry;
      setSavingNote({ annotationId: annotation.id, draft });
      setQueuedActionWhileSaving(false);
      void result.then(
        (saved) => {
          if (!mountedRef.current) return;
          const isCurrent = pendingNoteSaveRef.current?.seq === seq;
          if (isCurrent) {
            pendingNoteSaveRef.current = null;
            setSavingNote(null);
            setQueuedActionWhileSaving(false);
          }
          if (!isCurrent || activeAnnotationIdRef.current !== annotation.id) return;
          if (saved) {
            if (latestEditNoteRef.current.trim() === draft.trim()) {
              setEditNoteDirty(false);
              const callbacks = latestCallbacksRef.current;
              callbacks.closeNote();
              if (entry.queuedAction === 'excerpt') {
                callbacks.excerptAnnotation?.(annotation.id);
                callbacks.dismiss();
                callbacks.onReturnFocus();
              } else if (entry.queuedAction === 'show') {
                callbacks.showAnnotationCard?.(annotation.id);
                callbacks.dismiss();
                callbacks.onReturnFocus();
              }
            }
            return;
          }
          // Save failed: keep the editor and draft intact so the user can retry (#124).
          noteFieldRef.current?.focus();
        },
        () => {
          if (!mountedRef.current) return;
          if (pendingNoteSaveRef.current?.seq === seq) {
            pendingNoteSaveRef.current = null;
            setSavingNote(null);
            setQueuedActionWhileSaving(false);
            noteFieldRef.current?.focus();
          }
        },
      );
      return;
    }
    annotations.submitNoteSelection();
  };

  const copy = () => {
    const text = annotation ? annotation.excerptText : selection?.text;
    if (text) void copyText(text);
    close();
  };

  const currentColor = annotation ? annotation.color : annotations.activeColor;
  const label = editing ? 'Highlight actions' : 'Selection actions';

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={label}
      data-testid="selection-popover"
      data-popover-mode={editing ? 'edit' : 'create'}
      data-placement={placement}
      data-reader-popover=""
      onKeyDown={onKeyDown}
      // `animation-duration-150` times only the `@keyframes` entrance without setting
      // `transition-duration`, keeping `top`, `left`, and `transform-origin` pinned during
      // scroll and inline note growth (#40).
      className={cn(
        'fixed z-40 flex w-max max-w-[min(26rem,calc(100vw-1rem))] animate-in flex-col rounded-xl border bg-background p-1 text-foreground shadow-lg animation-duration-150 fade-in-0 zoom-in-[0.96] motion-reduce:animate-none',
        // It grows away from the anchor, so it appears to unfold from the text.
        placement === 'above' ? 'origin-bottom' : 'origin-top',
      )}
      style={
        position
          ? { top: position.top, left: position.left }
          : // Measured before it is placed, so it does not flash at the corner.
            { top: 0, left: 0, visibility: 'hidden' }
      }
    >
      <div
        role="toolbar"
        aria-label={label}
        aria-orientation="horizontal"
        // Arrow keys move between controls here; they must not turn the page.
        data-arrow-keys=""
        className="flex items-center gap-0.5"
      >
        <div role="group" aria-label="Highlight color" className="flex items-center">
          {ANNOTATION_COLORS.map(({ label: name, value }, index) => {
            const selected = currentColor === value;
            return (
              <button
                key={value}
                type="button"
                aria-label={`${name} highlight`}
                aria-pressed={selected}
                title={
                  editing
                    ? `${name} highlight`
                    : index === 0
                      ? commandTooltip(`${name} highlight`, 'edit.highlight')
                      : `${name} highlight`
                }
                data-testid={`popover-color-${name.toLowerCase()}`}
                data-popover-control=""
                tabIndex={index === 0 ? 0 : -1}
                onMouseDown={keepSelection}
                onClick={() => chooseColor(value)}
                className={COLOR_TARGET_CLASS}
              >
                <ColorDot color={value} selected={selected} className="size-6" />
              </button>
            );
          })}
        </div>
        <div role="separator" aria-orientation="vertical" className="mx-0.5 h-5 w-px bg-border" />
        <PopoverAction
          icon={Underline}
          label="Underline"
          pressed={annotation ? annotation.style === 'underline' : undefined}
          testId="popover-underline"
          onClick={toggleUnderline}
        />
        <PopoverAction
          icon={StickyNote}
          label={hasNote ? 'Edit Note' : 'Add Note'}
          title={
            editing
              ? hasNote
                ? 'Edit Note'
                : 'Add Note'
              : commandTooltip('Add Note', 'edit.addNote')
          }
          pressed={popover.noteOpen}
          testId="popover-note"
          onClick={toggleNote}
        />
        {canExcerptTarget && (
          <PopoverAction
            icon={Quote}
            label={excerptLabel}
            title={
              canExcerpt ? commandTooltip(excerptLabel, 'edit.excerpt') : 'Saving the last excerpt…'
            }
            testId="popover-excerpt"
            onClick={triggerExcerpt}
          />
        )}
        {canShowCard && (
          <PopoverAction
            icon={Network}
            label="Show in MindMap"
            title="Show in MindMap"
            testId="popover-show-in-mindmap"
            onClick={triggerShowCard}
          />
        )}
        <PopoverAction icon={Copy} label="Copy" testId="popover-copy" onClick={copy} />
        {annotation && (
          <PopoverAction
            icon={Trash2}
            label="Delete Highlight"
            title={
              isExcerptingAnnotation || queuedActionWhileSaving
                ? 'Sending to MindMap…'
                : 'Delete Highlight'
            }
            disabled={isExcerptingAnnotation || queuedActionWhileSaving}
            testId="popover-delete"
            onClick={() => {
              if (isExcerptingAnnotation || queuedActionWhileSaving) return;
              if (annotations.isCardSource?.(annotation.id)) {
                if (popover.noteOpen) popover.closeNote();
                setConfirmDeleteFor(annotation.id);
                rootRef.current
                  ?.querySelector<HTMLElement>('[data-testid="card-source-delete-confirm-button"]')
                  ?.focus();
                return;
              }
              annotations.deleteAnnotation(annotation.id);
              close();
            }}
          />
        )}
      </div>
      {canExcerptTarget && normalizedTargetTitle && (
        <div
          data-testid="popover-nesting-target"
          className="flex w-0 min-w-full items-center gap-1.5 border-t px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate" title={excerptLabel}>
            Under <span className="font-medium text-foreground">‘{normalizedTargetTitle}’</span>
          </span>
          {onClearExcerptTarget && (
            <button
              type="button"
              aria-label={`Clear nesting target ‘${normalizedTargetTitle}’`}
              title={`Clear nesting target ‘${normalizedTargetTitle}’ — next excerpt will be a new root`}
              data-testid="popover-clear-nesting-target"
              data-popover-control=""
              tabIndex={-1}
              onMouseDown={keepSelection}
              onClick={onClearExcerptTarget}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>
      )}
      {annotation && confirmingDelete && (
        <CardSourceDeleteConfirm
          className="px-2 pt-1.5 pb-1"
          keepSelection={keepSelection}
          onCancel={cancelDelete}
          onConfirm={() => {
            annotations.deleteAnnotation(annotation.id);
            close();
          }}
        />
      )}
      {annotation && hasNote && !popover.noteOpen && (
        // A clicked highlight opens with its note showing, as written.
        <div data-testid="popover-note-view" className="flex flex-col gap-1 px-2 pt-1.5 pb-1">
          <p
            data-testid="popover-note-text"
            className="max-h-40 max-w-[24rem] overflow-y-auto text-xs whitespace-pre-wrap break-words"
          >
            {annotation.note}
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="popover-note-edit"
              onMouseDown={keepSelection}
              onClick={popover.openNote}
            >
              <Pencil aria-hidden="true" className="size-3" />
              Edit
            </Button>
          </div>
        </div>
      )}
      {showingUnsavedNotePrompt && (
        <p
          role="alert"
          data-testid="popover-unsaved-note-warning"
          className="px-2 pt-1 text-xs font-medium text-destructive"
        >
          Save or cancel your note changes first.
        </p>
      )}
      {/*
        The note stays mounted so `grid-template-rows` can transition between
        `0fr` and `1fr`, the same disclosure the appearance panel uses. `inert`
        keeps the collapsed field out of the tab order and the accessibility
        tree, and `pt-1.5` replaces the gap the container no longer needs.
      */}
      <div
        inert={!popover.noteOpen}
        aria-hidden={!popover.noteOpen}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          popover.noteOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <NoteEditor
            value={noteValue}
            label={editing ? 'Highlight note' : 'Selection note'}
            formLabel={editing ? 'Edit note' : 'Add note to selection'}
            testId="popover-note-input"
            formTestId="popover-note-form"
            saveTestId="popover-note-save"
            fieldRef={noteFieldRef}
            className="px-1 pt-1.5 pb-1"
            // `0fr` collapses height only, so the width floor is claimed only
            // while the field is open. The mounted form still adds its own
            // intrinsic width (the textarea's default `cols`), so the closed
            // popover matches the one that unmounted it only while the toolbar
            // is the wider of the two — which it is today.
            fieldClassName={cn(popover.noteOpen && 'min-w-64')}
            onChange={(value) => {
              if (editing) {
                latestEditNoteRef.current = value;
                setEditNote(value);
                setEditNoteDirty(true);
                if (pendingNoteSaveRef.current) {
                  pendingNoteSaveRef.current.queuedAction = null;
                  setQueuedActionWhileSaving(false);
                }
              } else {
                annotations.setDraftNote(value);
              }
            }}
            onSave={saveNote}
            onCancel={() => {
              pendingNoteSaveRef.current = null;
              setSavingNote(null);
              setQueuedActionWhileSaving(false);
              popover.closeNote();
            }}
          />
        </div>
      </div>
    </div>
  );
}
