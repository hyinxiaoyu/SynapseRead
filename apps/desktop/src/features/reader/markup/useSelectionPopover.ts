import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { AnnotationsController } from '@/features/reader/AnnotationsPanel';
import type { ViewportRect } from '@/features/reader/markup/geometry';
import type { ReaderSelection } from '@/types/domain';

/** What the popover is about: the live selection, or a highlight that was clicked. */
export type PopoverTarget =
  { kind: 'selection' } | { kind: 'annotation'; annotationId: string; rect: ViewportRect | null };

/**
 * How long after the pointer is released a selection still counts as made by it.
 * EPUB reports a selection only after epub.js debounces `selectionchange`.
 */
const SETTLE_MS = 800;

export interface SelectionPopoverController {
  target: PopoverTarget | null;
  /** Bumped to move focus into the popover (⇧F10, Add Note). */
  focusRequest: number;
  /** The note field is open: for a new note on the selection, or editing a highlight's. */
  noteOpen: boolean;
  /** The selection's box now, for the popover to sit beside. */
  selectionRect: () => ViewportRect | null;
  openForAnnotation: (annotationId: string, rect: ViewportRect | null) => void;
  /** ⇧F10 or the context-menu key: show the popover and focus its first control. */
  showFromKeyboard: () => void;
  /** Add Note (menu or popover): show the popover with its note field focused. */
  openNote: () => void;
  closeNote: () => void;
  dismiss: () => void;
  /** Readers whose pages live in an iframe report its pointer here. */
  reportPointer: (down: boolean) => void;
}

/**
 * The selection popover's state: shown beside a settled selection, or a clicked
 * highlight, and gone while the pointer is still selecting. In highlight mode a
 * selection made with the pointer is highlighted at once instead.
 */
export function useSelectionPopover({
  isActive,
  selection,
  annotations,
  surfaceRef,
  getSelectionRect,
}: {
  isActive: boolean;
  selection: ReaderSelection | null;
  annotations: AnnotationsController;
  /** Where a press starts a selection: the page, not the toolbar or sidebar. */
  surfaceRef: RefObject<HTMLElement | null>;
  getSelectionRect: () => ViewportRect | null;
}): SelectionPopoverController {
  const [pointerDown, setPointerDown] = useState(false);
  // The latest release's number; null once it is older than `SETTLE_MS`.
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<ReaderSelection | null>(null);
  const [annotationTarget, setAnnotationTarget] = useState<PopoverTarget | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [noteOpen, setNoteOpen] = useState(false);

  const releases = useRef(0);
  const reportPointer = useCallback((down: boolean) => {
    setPointerDown(down);
    if (down) {
      // A new press puts away a highlight's popover; a selection's waits for release.
      setAnnotationTarget(null);
      setNoteOpen(false);
      setSettledAt(null);
    } else {
      releases.current += 1;
      setSettledAt(releases.current);
    }
  }, []);

  const pressedOnSurface = useRef(false);
  useEffect(() => {
    if (!isActive) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const view = surface.ownerDocument.defaultView;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pressedOnSurface.current = true;
      reportPointer(true);
    };
    const onUp = () => {
      if (!pressedOnSurface.current) return;
      pressedOnSurface.current = false;
      reportPointer(false);
    };
    surface.addEventListener('pointerdown', onDown);
    view?.addEventListener('pointerup', onUp);
    view?.addEventListener('pointercancel', onUp);
    return () => {
      surface.removeEventListener('pointerdown', onDown);
      view?.removeEventListener('pointerup', onUp);
      view?.removeEventListener('pointercancel', onUp);
    };
  }, [isActive, surfaceRef, reportPointer]);

  // Highlight mode: a selection the pointer just made becomes a highlight.
  const { highlightMode, createHighlight } = annotations;
  const hasText = selection !== null && selection.text !== null;
  useEffect(() => {
    if (settledAt === null) return;
    const timer = window.setTimeout(() => setSettledAt(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settledAt]);
  const consumedRelease = useRef<number | null>(null);
  useEffect(() => {
    if (!highlightMode || !hasText || pointerDown || settledAt === null) return;
    if (consumedRelease.current === settledAt) return;
    consumedRelease.current = settledAt;
    createHighlight();
  }, [highlightMode, hasText, pointerDown, settledAt, selection, createHighlight]);

  // A new selection replaces a highlight's popover, and the note being typed for the old one.
  const [previousSelection, setPreviousSelection] = useState(selection);
  if (previousSelection !== selection) {
    setPreviousSelection(selection);
    if (selection !== null) setAnnotationTarget(null);
    if (selection === null || annotationTarget === null) setNoteOpen(false);
  }
  // Creating a highlight or an excerpt consumes the selection's popover even when
  // triggered from the toolbar button or a keyboard shortcut.
  const [annotationCount, setAnnotationCount] = useState(annotations.annotations.length);
  if (annotationCount !== annotations.annotations.length) {
    const grew = annotations.annotations.length > annotationCount;
    setAnnotationCount(annotations.annotations.length);
    if (grew && selection !== null) setDismissed(selection);
  }
  const [wasActive, setWasActive] = useState(isActive);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (!isActive) {
      setAnnotationTarget(null);
      setNoteOpen(false);
    }
  }

  // The annotation may be deleted from elsewhere (the sidebar, undo).
  const liveAnnotationTarget =
    annotationTarget?.kind === 'annotation' &&
    annotations.annotations.some((candidate) => candidate.id === annotationTarget.annotationId)
      ? annotationTarget
      : null;

  const selectionShown =
    isActive &&
    hasText &&
    !pointerDown &&
    dismissed !== selection &&
    // In highlight mode the selection is about to become a highlight.
    !(highlightMode && settledAt !== null);

  const target: PopoverTarget | null =
    liveAnnotationTarget ?? (selectionShown ? { kind: 'selection' } : null);

  return {
    target,
    focusRequest,
    noteOpen: noteOpen && target !== null,
    selectionRect: getSelectionRect,
    openForAnnotation: (annotationId, rect) => {
      setAnnotationTarget({ kind: 'annotation', annotationId, rect });
      setNoteOpen(false);
    },
    showFromKeyboard: () => {
      setDismissed(null);
      setFocusRequest((current) => current + 1);
    },
    openNote: () => {
      setDismissed(null);
      setNoteOpen(true);
      setFocusRequest((current) => current + 1);
    },
    closeNote: () => setNoteOpen(false),
    dismiss: () => {
      setAnnotationTarget(null);
      setNoteOpen(false);
      if (selection) setDismissed(selection);
    },
    reportPointer,
  };
}
