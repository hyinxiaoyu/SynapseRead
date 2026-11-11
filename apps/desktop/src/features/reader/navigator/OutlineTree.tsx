import { ChevronRight } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export interface OutlineNode<T = string | number> {
  id: string;
  label: string;
  target: T | null;
  children: readonly OutlineNode<T>[];
  /** Right-aligned secondary text, such as a page number, where the format has one. */
  hint?: string;
}

interface IndexedNode<T> {
  node: OutlineNode<T>;
  parentId: string | null;
  /** Position in document (preorder) order. */
  order: number;
}

export interface OutlineRow<T> {
  node: OutlineNode<T>;
  level: number;
  parentId: string | null;
  posinset: number;
  setsize: number;
  order: number;
}

export function indexOutline<T>(items: readonly OutlineNode<T>[]): Map<string, IndexedNode<T>> {
  const index = new Map<string, IndexedNode<T>>();
  const walk = (nodes: readonly OutlineNode<T>[], parentId: string | null) => {
    for (const node of nodes) {
      index.set(node.id, { node, parentId, order: index.size });
      walk(node.children, node.id);
    }
  };
  walk(items, null);
  return index;
}

/** The ids from the root down to `id`, inclusive. */
export function outlinePath<T>(index: Map<string, IndexedNode<T>>, id: string | null): string[] {
  const path: string[] = [];
  let cursor = id;
  while (cursor !== null) {
    const entry = index.get(cursor);
    if (!entry) break;
    path.unshift(cursor);
    cursor = entry.parentId;
  }
  return path;
}

/**
 * The rows a tree shows: children only under expanded nodes, or, while filtering,
 * every node that matches or has a matching descendant.
 */
export function visibleOutlineRows<T>(
  items: readonly OutlineNode<T>[],
  index: Map<string, IndexedNode<T>>,
  expanded: ReadonlySet<string>,
  filter: string,
): OutlineRow<T>[] {
  const needle = filter.trim().toLowerCase();
  const matches = new Map<string, boolean>();
  const matchOf = (node: OutlineNode<T>): boolean => {
    const cached = matches.get(node.id);
    if (cached !== undefined) return cached;
    const own = node.label.toLowerCase().includes(needle);
    // Visit every child so each caches its own answer.
    const childMatches = node.children.map(matchOf).some(Boolean);
    const result = own || childMatches;
    matches.set(node.id, result);
    return result;
  };

  const rows: OutlineRow<T>[] = [];
  const walk = (nodes: readonly OutlineNode<T>[], level: number, parentId: string | null) => {
    const shown = needle ? nodes.filter(matchOf) : nodes;
    shown.forEach((node, position) => {
      rows.push({
        node,
        level,
        parentId,
        posinset: position + 1,
        setsize: shown.length,
        order: index.get(node.id)?.order ?? 0,
      });
      if (node.children.length > 0 && (needle !== '' || expanded.has(node.id))) {
        walk(node.children, level + 1, node.id);
      }
    });
  };
  walk(items, 1, null);
  return rows;
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export interface OutlineTreeProps<T> {
  items: readonly OutlineNode<T>[];
  /** The section the reader is in; its path starts expanded. */
  currentId: string | null;
  filter?: string;
  /** Shows sections before the current one in a subdued color. */
  dimRead?: boolean;
  emptyMessage: string;
  onSelect: (target: T) => void;
  /**
   * Called after Return opens a section, so the keyboard goes back to the page:
   * a reader who just jumped wants to read, not to keep walking the tree.
   */
  onReturnFocus?: () => void;
}

/**
 * The table of contents as an ARIA tree, after Preview's outline: disclosure
 * triangles, only the current chapter's path expanded, titles that wrap rather
 * than truncate, and the current section marked and kept in view.
 */
export function OutlineTree<T>({
  items,
  currentId,
  filter = '',
  dimRead = false,
  emptyMessage,
  onSelect,
  onReturnFocus,
}: OutlineTreeProps<T>) {
  const baseId = useId();
  const index = useMemo(() => indexOutline(items), [items]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(outlinePath(index, currentId)),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // A new location (or an outline that just loaded) opens the path to it, and
  // leaves whatever the reader expanded by hand.
  const [expandedFor, setExpandedFor] = useState({ index, currentId });
  if (expandedFor.index !== index || expandedFor.currentId !== currentId) {
    setExpandedFor({ index, currentId });
    const path = outlinePath(index, currentId);
    if (path.some((id) => !expanded.has(id))) {
      setExpanded(new Set([...expanded, ...path]));
    }
  }

  const filtering = filter.trim() !== '';
  const rows = useMemo(
    () => visibleOutlineRows(items, index, expanded, filter),
    [items, index, expanded, filter],
  );

  const currentPath = useMemo(() => new Set(outlinePath(index, currentId)), [index, currentId]);
  const currentOrder = currentId !== null ? (index.get(currentId)?.order ?? -1) : -1;
  const tabStop =
    rows.find((row) => row.node.id === focusedId)?.node.id ??
    rows.find((row) => row.node.id === currentId)?.node.id ??
    rows[0]?.node.id ??
    null;

  useEffect(() => {
    if (currentId === null) return;
    const element = rowRefs.current.get(currentId);
    element?.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [currentId, rows]);

  const focusRow = (id: string | undefined) => {
    if (id === undefined) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };

  const setNodeExpanded = (id: string, value: boolean) => {
    const next = new Set(expanded);
    if (value) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const activate = (node: OutlineNode<T>) => {
    if (node.target !== null) onSelect(node.target);
    else if (node.children.length > 0) setNodeExpanded(node.id, !expanded.has(node.id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, rowIndex: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const row = rows[rowIndex];
    if (!row) return;
    const { node } = row;
    const hasChildren = node.children.length > 0;
    const isOpen = filtering || expanded.has(node.id);
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[rowIndex + 1]?.node.id);
        break;
      case 'ArrowUp':
        focusRow(rows[rowIndex - 1]?.node.id);
        break;
      case 'Home':
        focusRow(rows[0]?.node.id);
        break;
      case 'End':
        focusRow(rows.at(-1)?.node.id);
        break;
      case 'ArrowRight':
        if (!hasChildren) break;
        if (!isOpen) setNodeExpanded(node.id, true);
        else focusRow(rows[rowIndex + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (hasChildren && isOpen && !filtering) setNodeExpanded(node.id, false);
        else if (row.parentId !== null) focusRow(row.parentId);
        break;
      case 'Enter':
      case ' ':
        activate(node);
        // Only a jump leaves the tree: expanding a branch keeps the keyboard here.
        if (node.target !== null) onReturnFocus?.();
        break;
      case '*': {
        // Expand every sibling of the focused item.
        const siblings =
          row.parentId === null
            ? items
            : (index.get(row.parentId)?.node.children ?? ([] as readonly OutlineNode<T>[]));
        setExpanded(
          new Set([
            ...expanded,
            ...siblings.filter((sibling) => sibling.children.length > 0).map((s) => s.id),
          ]),
        );
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  if (items.length === 0) {
    return (
      <div data-testid="reader-toc" className="px-3 py-4 text-[13px] text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div data-testid="reader-toc" className="px-1.5 py-1">
      {rows.length === 0 ? (
        <p className="px-2 py-3 text-[13px] text-muted-foreground">No matching sections.</p>
      ) : (
        <ul role="tree" aria-label="Table of contents" className="text-[13px] leading-snug">
          {rows.map((row, rowIndex) => {
            const { node, level } = row;
            const hasChildren = node.children.length > 0;
            const isOpen = filtering || expanded.has(node.id);
            const isCurrent = node.id === currentId;
            const isRead =
              dimRead && currentOrder >= 0 && row.order < currentOrder && !currentPath.has(node.id);
            return (
              <li
                key={node.id}
                id={`${baseId}-${node.id}`}
                ref={(element) => {
                  if (element) rowRefs.current.set(node.id, element);
                  else rowRefs.current.delete(node.id);
                }}
                role="treeitem"
                aria-level={level}
                aria-posinset={row.posinset}
                aria-setsize={row.setsize}
                aria-expanded={hasChildren ? isOpen : undefined}
                aria-current={isCurrent ? 'location' : undefined}
                aria-disabled={node.target === null ? true : undefined}
                aria-label={node.label}
                title={node.label}
                tabIndex={node.id === tabStop ? 0 : -1}
                data-testid="toc-item"
                data-read={isRead || undefined}
                onFocus={() => setFocusedId(node.id)}
                onClick={() => {
                  setFocusedId(node.id);
                  activate(node);
                }}
                onKeyDown={(event) => onKeyDown(event, rowIndex)}
                className={cn(
                  'relative flex cursor-default items-start rounded-md py-1 pr-2 outline-none select-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isCurrent
                    ? 'bg-accent/70 font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-primary'
                    : isRead
                      ? 'text-muted-foreground'
                      : 'text-foreground/90',
                  node.target === null && !hasChildren && 'opacity-60',
                )}
                // 16 px per level; the triangle column makes wrapped lines hang.
                style={{ paddingLeft: 4 + (level - 1) * 16 }}
              >
                <span
                  aria-hidden="true"
                  data-testid={hasChildren ? 'toc-disclosure' : undefined}
                  className="flex h-[1lh] w-4 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={(event) => {
                    if (!hasChildren || filtering) return;
                    event.stopPropagation();
                    setFocusedId(node.id);
                    setNodeExpanded(node.id, !isOpen);
                  }}
                >
                  {hasChildren && (
                    <ChevronRight
                      className={cn(
                        'size-3 transition-transform motion-reduce:transition-none',
                        isOpen && 'rotate-90',
                      )}
                    />
                  )}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 break-words">{node.label}</span>
                {node.hint && (
                  <span className="shrink-0 pl-2 text-[11px] font-normal text-muted-foreground tabular-nums">
                    {node.hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
