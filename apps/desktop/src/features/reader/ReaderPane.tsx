import { FolderOpen, Quote, X } from 'lucide-react';
import { type ComponentType, useCallback, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { viewerRegistry } from '@/features/reader/viewerRegistry';
import { cn } from '@/lib/utils';
import { selectHighlights, useStudySyncStore } from '@/stores/useStudySyncStore';
import type { AnchorLocation, DocumentViewerProps, StudyDocument } from '@/types/domain';

export function ReaderPane() {
  const documents = useStudySyncStore((state) => state.documents);
  const openDocumentIds = useStudySyncStore((state) => state.openDocumentIds);
  const activeDocumentId = useStudySyncStore((state) => state.activeDocumentId);
  const selection = useStudySyncStore((state) => state.selection);
  const isExcerpting = useStudySyncStore((state) => state.isExcerpting);
  const openDocument = useStudySyncStore((state) => state.openDocument);
  const activateDocument = useStudySyncStore((state) => state.activateDocument);
  const closeDocument = useStudySyncStore((state) => state.closeDocument);
  const excerptSelection = useStudySyncStore((state) => state.excerptSelection);

  const openDocuments = useMemo(
    () =>
      openDocumentIds
        .map((id) => documents.find((document) => document.id === id))
        .filter((document) => document !== undefined),
    [openDocumentIds, documents],
  );
  const activeDocument = openDocuments.find((document) => document.id === activeDocumentId);

  return (
    <section aria-label="Document reader" className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <div
          role="tablist"
          aria-label="Open documents"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {openDocuments.map((document) => {
            const isActive = document.id === activeDocumentId;
            return (
              <div
                key={document.id}
                className={cn(
                  'flex max-w-48 shrink-0 items-center rounded-md text-sm',
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="truncate py-1 pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => activateDocument(document.id)}
                >
                  {document.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${document.title}`}
                  className="mr-1 rounded p-0.5 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => closeDocument(document.id)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void openDocument()}>
          <FolderOpen />
          Open
        </Button>
        <Button
          size="sm"
          disabled={!selection || isExcerpting}
          // Keeps the reader's text selection alive through the click in every engine.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void excerptSelection()}
        >
          <Quote />
          Excerpt to MindMap
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        {/*
          Every open tab stays mounted so it keeps its scroll position, loaded text,
          and parsed document. `visibility` rather than `display: none` keeps layout
          alive; a box with no layout loses its scroll offset.
        */}
        {openDocuments.map((document) => {
          const isActive = document.id === activeDocumentId;
          return (
            <div
              key={document.id}
              className="absolute inset-0"
              style={{ visibility: isActive ? 'visible' : 'hidden' }}
              inert={!isActive}
            >
              <DocumentTab document={document} isActive={isActive} />
            </div>
          );
        })}
        {!activeDocument && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Open a PDF, EPUB, or TXT file to start reading.
          </div>
        )}
      </div>
    </section>
  );
}

function DocumentTab({ document, isActive }: { document: StudyDocument; isActive: boolean }) {
  const content = useStudySyncStore((state) => state.content);
  const annotations = useStudySyncStore((state) => state.annotations);
  const jumpRequest = useStudySyncStore((state) =>
    state.jumpRequest?.documentId === document.id ? state.jumpRequest : null,
  );
  const setSelection = useStudySyncStore((state) => state.setSelection);
  const completeJump = useStudySyncStore((state) => state.completeJump);
  const reportCursor = useStudySyncStore((state) => state.reportCursor);

  const highlights = useMemo(
    () => selectHighlights(annotations, document.id),
    [annotations, document.id],
  );
  const onCursorChange = useCallback(
    (anchor: AnchorLocation) => reportCursor(document.id, anchor),
    [reportCursor, document.id],
  );

  // Safe: the entry is looked up by this document's own format.
  const Viewer = viewerRegistry[document.format] as ComponentType<DocumentViewerProps>;
  return (
    <Viewer
      document={document}
      isActive={isActive}
      content={content}
      highlights={highlights}
      jumpRequest={jumpRequest}
      onSelectionChange={setSelection}
      onJumpHandled={completeJump}
      onCursorChange={onCursorChange}
    />
  );
}
