import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { formatCardSource } from '@/lib/sourceAttribution';
import { cn } from '@/lib/utils';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

export type CardFlowNode = Node<{ cardId: string }, 'card'>;

const MAX_VISIBLE_TAGS = 3;

/** Flattens light Markdown syntax so a card face shows a clean plain-text preview. */
export function summarizeMarkdownNotes(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(?:\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+))+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function CardCaptureThumbnail({ annotationId, alt }: { annotationId: string; alt: string }) {
  const captureUrl = useStudySyncStore((state) => state.captureUrl);
  const [state, setState] = useState<{
    status: 'loading' | 'loaded' | 'missing';
    url: string | null;
  }>({
    status: 'loading',
    url: null,
  });

  useEffect(() => {
    let cancelled = false;
    captureUrl(annotationId)
      .then((resolved) => {
        if (cancelled) return;
        setState(resolved ? { status: 'loaded', url: resolved } : { status: 'missing', url: null });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'missing', url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [captureUrl, annotationId]);

  // Reserve a fixed-height slot across loading, loaded, and fallback states so async
  // thumbnail resolution never causes the card to grow over neighboring cards (#128).
  if (state.status === 'missing') {
    return (
      <div
        data-testid="card-capture-slot"
        className="mt-1.5 flex h-24 w-full items-center justify-center rounded border border-dashed bg-muted/60 px-2 text-center"
      >
        <p data-testid="card-capture-fallback" className="text-[11px] text-muted-foreground">
          Capture unavailable
        </p>
      </div>
    );
  }
  if (state.status !== 'loaded' || !state.url) {
    return (
      <div
        data-testid="card-capture-slot"
        aria-busy="true"
        className="mt-1.5 flex h-24 w-full items-center justify-center rounded border bg-muted/40"
      />
    );
  }

  return (
    <div
      data-testid="card-capture-slot"
      className="mt-1.5 flex h-24 w-full items-center justify-center overflow-hidden rounded border bg-white"
    >
      <img
        data-testid="card-capture-thumbnail"
        src={state.url}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-contain"
        onError={() => setState({ status: 'missing', url: null })}
      />
    </div>
  );
}

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  const card = useStudySyncStore((state) => state.cards.find((c) => c.id === data.cardId));
  const captureAnnotationId = useStudySyncStore((state) => {
    const target = state.cards.find((c) => c.id === data.cardId);
    if (!target || target.annotationIds.length === 0) return null;
    for (const annId of target.annotationIds) {
      const annotation = state.annotations.find((candidate) => candidate.id === annId);
      if (annotation?.excerptImagePath) return annotation.id;
    }
    return null;
  });
  const sourceLabel = useStudySyncStore((state) => {
    const target = state.cards.find((c) => c.id === data.cardId);
    return target ? formatCardSource(target, state.annotations, state.documents) : null;
  });
  const jumpToNode = useStudySyncStore((state) => state.jumpToNode);
  const hasSource = (card?.annotationIds.length ?? 0) > 0;
  const notesPreview = card ? summarizeMarkdownNotes(card.markdownNotes) : '';
  const visibleTags = card ? card.tags.slice(0, MAX_VISIBLE_TAGS) : [];
  const hiddenTagCount = card ? Math.max(0, card.tags.length - MAX_VISIBLE_TAGS) : 0;

  return (
    <div
      className={cn(
        'flex w-60 items-start gap-1 rounded-lg border bg-card p-3 text-card-foreground shadow-sm',
        selected && 'ring-2 ring-ring',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-sm font-medium break-words">{card?.title}</p>
        {hasSource && sourceLabel && (
          <p
            data-testid="card-source-attribution"
            title={sourceLabel}
            className="mt-1 truncate text-[11px] leading-snug text-muted-foreground"
          >
            {sourceLabel}
          </p>
        )}
        {captureAnnotationId && (
          <CardCaptureThumbnail
            key={captureAnnotationId}
            annotationId={captureAnnotationId}
            alt={card?.title || 'Captured area'}
          />
        )}
        {notesPreview && (
          <p
            data-testid="card-notes-preview"
            className="mt-1.5 line-clamp-2 text-xs text-muted-foreground break-words"
          >
            {notesPreview}
          </p>
        )}
        {visibleTags.length > 0 && (
          <div data-testid="card-tags" className="mt-1.5 flex flex-wrap gap-1">
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className="max-w-[7rem] truncate rounded bg-secondary px-1.5 py-0.5 text-[11px] leading-tight text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span
                data-testid="card-tags-overflow"
                className="rounded bg-secondary px-1.5 py-0.5 text-[11px] leading-tight text-secondary-foreground"
              >
                +{hiddenTagCount}
              </span>
            )}
          </div>
        )}
        {card && !hasSource && (
          // A card whose highlight was deleted stays on the canvas until deleted or undone (#97).
          <p data-testid="card-source-removed" className="mt-1 text-xs text-muted-foreground">
            Source removed
          </p>
        )}
      </div>
      {hasSource && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            sourceLabel
              ? `Jump to source of ${card?.title} (${sourceLabel})`
              : `Jump to source of ${card?.title}`
          }
          className="nodrag -mt-1 -mr-1 size-7 shrink-0"
          // Stop propagation so jumping back to source does not select the card as
          // the parent for later excerpts (#127).
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            jumpToNode(id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
            }
          }}
        >
          <Link2 />
        </Button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
