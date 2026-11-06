import { cn } from '@/lib/utils';

export interface OutlineNode<T = string | number> {
  id: string;
  label: string;
  target: T | null;
  children: readonly OutlineNode<T>[];
}

interface OutlineListProps<T> {
  items: readonly OutlineNode<T>[];
  isActive?: (target: T) => boolean;
  onSelect: (target: T) => void;
  depth?: number;
}

function OutlineList<T>({ items, isActive, onSelect, depth = 0 }: OutlineListProps<T>) {
  return (
    <ol className={cn('space-y-0.5', depth > 0 && 'mt-0.5 ml-3 border-l border-border/70 pl-2')}>
      {items.map((item) => {
        const target = item.target;
        const active = target !== null && Boolean(isActive?.(target));
        return (
          <li key={item.id}>
            <button
              type="button"
              disabled={target === null}
              aria-current={active ? 'location' : undefined}
              onClick={() => {
                if (target !== null) onSelect(target);
              }}
              className={cn(
                'w-full truncate rounded px-2 py-1 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
              )}
              title={item.label}
            >
              {item.label}
            </button>
            {item.children.length > 0 && (
              <OutlineList
                items={item.children}
                {...(isActive ? { isActive } : {})}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface OutlineSidebarProps<T> {
  items: readonly OutlineNode<T>[];
  isActive?: (target: T) => boolean;
  emptyMessage: string;
  onSelect: (target: T) => void;
}

export function OutlineSidebar<T>({
  items,
  isActive,
  emptyMessage,
  onSelect,
}: OutlineSidebarProps<T>) {
  return (
    <aside
      aria-label="Table of contents"
      data-testid="reader-toc"
      className="w-60 shrink-0 overflow-y-auto border-r bg-background p-2 text-xs"
    >
      {items.length === 0 ? (
        <p className="px-2 py-4 text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <OutlineList items={items} {...(isActive ? { isActive } : {})} onSelect={onSelect} />
      )}
    </aside>
  );
}
