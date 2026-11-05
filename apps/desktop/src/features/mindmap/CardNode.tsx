import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { Link2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

export type CardFlowNode = Node<{ cardId: string }, 'card'>;

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  const card = useStudySyncStore((state) => state.cards.find((c) => c.id === data.cardId));
  const jumpToNode = useStudySyncStore((state) => state.jumpToNode);
  const hasSource = (card?.annotationIds.length ?? 0) > 0;

  return (
    <div
      className={cn(
        'flex w-60 items-start gap-1 rounded-lg border bg-card p-3 text-card-foreground shadow-sm',
        selected && 'ring-2 ring-ring',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <p className="line-clamp-3 min-w-0 flex-1 text-sm">{card?.title}</p>
      {hasSource && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Jump to source of ${card?.title}`}
          className="nodrag -mt-1 -mr-1 size-7"
          onClick={() => jumpToNode(id)}
        >
          <Link2 />
        </Button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
