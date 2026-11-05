import { Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { Annotation, CardPatch, NoteCard } from '@/types/domain';

export function InspectorPane() {
  const selectedNodeId = useStudySyncStore((state) => state.selectedNodeId);
  const node = useStudySyncStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
  const card = useStudySyncStore((state) =>
    node ? state.cards.find((c) => c.id === node.cardId) : undefined,
  );

  return (
    <section aria-label="Card inspector" className="flex h-full flex-col overflow-y-auto">
      <header className="flex h-11 shrink-0 items-center border-b px-4 text-sm font-medium">
        Inspector
      </header>
      {card && selectedNodeId ? (
        <CardEditor key={card.id} card={card} nodeId={selectedNodeId} />
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

function CardEditor({ card, nodeId }: { card: NoteCard; nodeId: string }) {
  const annotations = useStudySyncStore((state) => state.annotations);
  const updateCard = useStudySyncStore((state) => state.updateCard);
  const jumpToNode = useStudySyncStore((state) => state.jumpToNode);

  const [draft, setDraft] = useState({
    title: card.title,
    notes: card.markdownNotes,
    tags: card.tags.join(', '),
  });

  // Mirrors the draft for the unmount flush below. Selecting another card
  // remounts this editor, which must not lose edits that were never blurred.
  const pendingRef = useRef<CardPatch | null>(null);
  const commit = () => {
    const patch = pendingRef.current;
    pendingRef.current = null;
    if (patch) void updateCard(card.id, patch);
  };
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);

  const edit = (next: typeof draft) => {
    setDraft(next);
    pendingRef.current = {
      title: next.title.trim() || card.title,
      markdownNotes: next.notes,
      tags: parseTags(next.tags),
    };
  };

  const excerpts = card.annotationIds
    .map((id) => annotations.find((annotation) => annotation.id === id))
    .filter((annotation) => annotation !== undefined);

  return (
    <div className="flex flex-col gap-4 p-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Title
        <Input
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
          onBlur={commit}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Notes
        <Textarea
          value={draft.notes}
          placeholder="Write in Markdown…"
          onChange={(event) => edit({ ...draft, notes: event.target.value })}
          onBlur={commit}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Tags
        <Input
          value={draft.tags}
          placeholder="comma, separated"
          onChange={(event) => edit({ ...draft, tags: event.target.value })}
          onBlur={commit}
        />
      </label>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Excerpts</h3>
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
    </div>
  );
}
