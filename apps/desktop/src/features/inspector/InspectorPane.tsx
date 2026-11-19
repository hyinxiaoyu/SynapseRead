import { Link2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { commandTooltip } from '@/features/commands/commands';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { runCommand } from '@/features/commands/registry';
import { registerBeforeCloseFlush } from '@/lib/flushBeforeClose';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { Annotation, CardPatch, NoteCard } from '@/types/domain';

/** Idle delay before typing in the Inspector persists without a blur (#117). */
export const CARD_SAVE_DEBOUNCE_MS = 600;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function findCardNodeElement(nodeId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    if (element.dataset.id === nodeId) return element;
  }
  return null;
}

export function InspectorPane({ open = true }: { open?: boolean }) {
  const selectedNodeId = useStudySyncStore((state) => state.selectedNodeId);
  const node = useStudySyncStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
  const card = useStudySyncStore((state) =>
    node ? state.cards.find((c) => c.id === node.cardId) : undefined,
  );

  const sectionRef = useRef<HTMLElement>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [statusCardId, setStatusCardId] = useState<string | null>(null);
  const visibleSaveStatus: SaveStatus = card && statusCardId === card.id ? saveStatus : 'idle';

  const handleSaveStatus = useCallback((cardId: string, next: SaveStatus) => {
    setStatusCardId(cardId);
    setSaveStatus(next);
  }, []);

  // Esc inside the Inspector returns keyboard focus to the selected card (#119).
  useEscapeLayer(
    ESCAPE_LAYER.inspector,
    open && selectedNodeId !== null
      ? (event) => {
          const { target } = event;
          if (!(target instanceof Node) || !sectionRef.current?.contains(target)) return false;
          if (target instanceof HTMLElement) target.blur();
          findCardNodeElement(selectedNodeId)?.focus();
          return true;
        }
      : null,
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Card inspector"
      className="flex h-full flex-col overflow-y-auto"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-sm font-medium">
        <span>Inspector</span>
        {visibleSaveStatus !== 'idle' && (
          <span
            data-testid="inspector-save-status"
            aria-live="polite"
            className={
              visibleSaveStatus === 'error'
                ? 'text-xs font-normal text-destructive'
                : 'text-xs font-normal text-muted-foreground'
            }
          >
            {visibleSaveStatus === 'saving'
              ? 'Saving…'
              : visibleSaveStatus === 'error'
                ? 'Unsaved'
                : 'Saved'}
          </span>
        )}
      </header>
      {card && selectedNodeId ? (
        <CardEditor
          key={card.id}
          card={card}
          nodeId={selectedNodeId}
          open={open}
          onSaveStatus={handleSaveStatus}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Select a card to edit it.</p>
      )}
    </section>
  );
}

function ExcerptImage({ annotation }: { annotation: Annotation }) {
  const captureUrl = useStudySyncStore((state) => state.captureUrl);
  const [url, setUrl] = useState<string | null>(null);
  const annotationId = annotation.id;
  useEffect(() => {
    let cancelled = false;
    captureUrl(annotationId)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      // The card still works without its picture, which may have been removed from disk.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [captureUrl, annotationId]);
  return url ? (
    <img src={url} alt="Captured area" className="min-w-0 flex-1 rounded border bg-white" />
  ) : (
    <p className="min-w-0 flex-1 text-xs">Image excerpt</p>
  );
}

const parseTags = (value: string) => [
  ...new Set(
    value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];

function CardEditor({
  card,
  nodeId,
  open,
  onSaveStatus,
}: {
  card: NoteCard;
  nodeId: string;
  open: boolean;
  onSaveStatus: (cardId: string, status: SaveStatus) => void;
}) {
  const annotations = useStudySyncStore((state) => state.annotations);
  const updateCard = useStudySyncStore((state) => state.updateCard);
  const jumpToNode = useStudySyncStore((state) => state.jumpToNode);
  const inspectRequest = useStudySyncStore((state) => state.inspectRequest);
  const completeInspect = useStudySyncStore((state) => state.completeInspect);

  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState({
    title: card.title,
    notes: card.markdownNotes,
    tags: card.tags.join(', '),
  });

  // Mirrors the draft for debounced saves, blur, unmount, pagehide, and native
  // close flushes. Re-renders after a save keep `draft` intact so typing and caret
  // position are never interrupted (#117). Each edit increments `draftRevisionRef`
  // so an older failed write can never re-queue itself over a newer queued revision.
  const draftRevisionRef = useRef(0);
  const pendingRef = useRef<{ patch: CardPatch; revision: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const commit = (): Promise<void> => {
    clearTimer();
    const pending = pendingRef.current;
    if (!pending) {
      return inFlightRef.current ?? Promise.resolve();
    }
    const { patch, revision } = pending;
    pendingRef.current = null;
    // Skip persisting if the card was deleted before this flush ran (#116).
    if (!useStudySyncStore.getState().cards.some((candidate) => candidate.id === card.id)) {
      return inFlightRef.current ?? Promise.resolve();
    }
    if (mountedRef.current) onSaveStatus(card.id, 'saving');
    const previous = inFlightRef.current ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async (): Promise<'saved' | 'skipped' | 'failed'> => {
        if (!useStudySyncStore.getState().cards.some((candidate) => candidate.id === card.id)) {
          return 'skipped';
        }
        try {
          const ok = await updateCard(card.id, patch);
          return ok ? 'saved' : 'failed';
        } catch {
          return 'failed';
        }
      })
      .then((outcome) => {
        if (outcome === 'failed') {
          // Only retain a failed draft if it is still the latest edit revision (#117).
          if (
            revision === draftRevisionRef.current &&
            pendingRef.current === null &&
            useStudySyncStore.getState().cards.some((candidate) => candidate.id === card.id)
          ) {
            pendingRef.current = { patch, revision };
            if (mountedRef.current) onSaveStatus(card.id, 'error');
          }
          return;
        }
        if (
          outcome === 'saved' &&
          revision === draftRevisionRef.current &&
          inFlightRef.current === next &&
          pendingRef.current === null
        ) {
          if (mountedRef.current) {
            onSaveStatus(card.id, 'saved');
          }
        }
      })
      .finally(() => {
        if (inFlightRef.current === next) {
          inFlightRef.current = null;
        }
      });
    inFlightRef.current = next;
    return next;
  };
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  useEffect(() => {
    mountedRef.current = true;
    const onPageHide = () => {
      void commitRef.current();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void commitRef.current();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unregisterFlush = registerBeforeCloseFlush({
      isDirty: () => pendingRef.current !== null || inFlightRef.current !== null,
      flush: async () => {
        await commitRef.current();
        // If an in-flight write failed and restored `pendingRef`, retry once before closing.
        if (pendingRef.current !== null) {
          await commitRef.current();
        }
      },
    });
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unregisterFlush();
      void commitRef.current();
    };
  }, []);

  // Opening the Inspector from a card (double-click or Edit Card) focuses Notes (#119).
  useEffect(() => {
    if (!open || !inspectRequest || inspectRequest.nodeId !== nodeId) return;
    const notes = notesRef.current;
    if (notes) {
      notes.focus();
      const end = notes.value.length;
      notes.setSelectionRange(end, end);
    }
    completeInspect(inspectRequest.nonce);
  }, [open, inspectRequest, nodeId, completeInspect]);

  const edit = (next: typeof draft) => {
    setDraft(next);
    draftRevisionRef.current += 1;
    pendingRef.current = {
      revision: draftRevisionRef.current,
      patch: {
        title: next.title.trim() || card.title,
        markdownNotes: next.notes,
        tags: parseTags(next.tags),
      },
    };
    onSaveStatus(card.id, 'saving');
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void commitRef.current();
    }, CARD_SAVE_DEBOUNCE_MS);
  };

  const excerpts = card.annotationIds
    .map((id) => annotations.find((annotation) => annotation.id === id))
    .filter((annotation) => annotation !== undefined);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Title
        <Input
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
          onBlur={() => void commit()}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Notes
        <Textarea
          ref={notesRef}
          value={draft.notes}
          placeholder="Write in Markdown…"
          onChange={(event) => edit({ ...draft, notes: event.target.value })}
          onBlur={() => void commit()}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Tags
        <Input
          value={draft.tags}
          placeholder="comma, separated"
          onChange={(event) => edit({ ...draft, tags: event.target.value })}
          onBlur={() => void commit()}
        />
      </label>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Excerpts</h3>
        {excerpts.length === 0 && (
          <p data-testid="inspector-source-removed" className="text-xs text-muted-foreground">
            Source removed. The highlight this card came from was deleted; its notes and tags are
            kept.
          </p>
        )}
        {excerpts.map((annotation) => (
          <div key={annotation.id} className="flex items-start gap-1 rounded-md bg-muted p-2">
            {annotation.excerptImagePath ? (
              <ExcerptImage annotation={annotation} />
            ) : (
              <p className="min-w-0 flex-1 text-xs">{annotation.excerptText}</p>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Jump to this excerpt"
              className="size-6"
              onClick={() => jumpToNode(nodeId, annotation.id)}
            >
              <Link2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-auto border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={commandTooltip('Delete Card', 'edit.deleteCard')}
          className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            void commit();
            runCommand('edit.deleteCard', 'toolbar');
          }}
        >
          <Trash2 />
          Delete Card
        </Button>
      </div>
    </div>
  );
}
