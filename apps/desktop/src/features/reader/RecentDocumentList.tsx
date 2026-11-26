import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { describeResumeLocation } from '@/features/reader/resumeLocation';
import { documentFormatLabel } from '@/lib/documentFormats';
import { cn } from '@/lib/utils';
import type { StudyDocument } from '@/types/domain';

/** Default maximum entries shown in the empty-state Continue reading card before expanding. */
export const RECENT_EMPTY_STATE_LIMIT = 8;

export interface RecentDocumentListProps {
  documents: readonly StudyDocument[];
  onOpen: (documentId: string) => void;
  onRemove: (documentId: string) => void;
  limit?: number | undefined;
  className?: string | undefined;
}

/**
 * Renders the Recent / Continue reading list with optional truncation and per-item
 * removal, keeping focus inside the list when an entry is removed.
 */
export function RecentDocumentList({
  documents,
  onOpen,
  onRemove,
  limit,
  className,
}: RecentDocumentListProps) {
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const openButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocusRef = useRef<{ removedId: string; targetId: string | null } | null>(null);

  const hasOverflow = limit !== undefined && documents.length > limit;
  const visibleDocuments = hasOverflow && !showAll ? documents.slice(0, limit) : documents;

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    if (documents.some((doc) => doc.id === pending.removedId)) return;
    pendingFocusRef.current = null;
    if (pending.targetId === null) return;
    const active = window.document.activeElement;
    const focusWasInListOrUnmounted =
      active === null ||
      active === window.document.body ||
      (listRef.current?.contains(active) ?? false);
    if (!focusWasInListOrUnmounted) return;
    openButtonRefs.current.get(pending.targetId)?.focus();
  }, [documents, showAll]);

  const handleRemove = (documentId: string) => {
    const index = documents.findIndex((doc) => doc.id === documentId);
    const nextTarget = index === -1 ? null : (documents[index + 1] ?? documents[index - 1] ?? null);
    pendingFocusRef.current = { removedId: documentId, targetId: nextTarget?.id ?? null };
    onRemove(documentId);
  };

  return (
    <>
      <ol ref={listRef} data-testid="recent-documents-list" className={cn('divide-y', className)}>
        {visibleDocuments.map((document) => (
          <li key={document.id} className="group relative flex items-center">
            <button
              ref={(element) => {
                if (element) openButtonRefs.current.set(document.id, element);
                else openButtonRefs.current.delete(document.id);
              }}
              type="button"
              data-testid="recent-document-item"
              data-document-id={document.id}
              data-document-format={document.format}
              onClick={() => onOpen(document.id)}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{document.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {describeResumeLocation(document)}
                </p>
              </div>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                {documentFormatLabel(document)}
              </span>
            </button>
            <button
              type="button"
              data-testid="recent-document-remove"
              aria-label={`Remove ${document.title} from Recent`}
              title="Remove from Recent"
              onClick={() => handleRemove(document.id)}
              className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity outline-none hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
      {hasOverflow && !showAll && (
        <div className="mt-2 border-t pt-2">
          <button
            type="button"
            data-testid="recent-documents-show-all"
            onClick={() => setShowAll(true)}
            className="w-full rounded px-2 py-1 text-center text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Show all ({documents.length})
          </button>
        </div>
      )}
    </>
  );
}
