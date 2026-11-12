import { AlertTriangle, Clock, FileCheck, FolderOpen, Link2, Quote, X } from 'lucide-react';
import {
  Component,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { commandTooltip } from '@/features/commands/commands';
import { isEditableShortcutTarget, useCommands } from '@/features/commands/registry';
import { useReaderChromeTheme } from '@/features/reader/appearance/useReaderChromeTheme';
import { requestActivePageFocus } from '@/features/reader/focusPage';
import { viewerRegistry } from '@/features/reader/viewerRegistry';
import { cn, describeError } from '@/lib/utils';
import { useDismissOnOutside } from '@/features/reader/useDismissOnOutside';
import {
  selectBookmarks,
  selectDocumentAnnotations,
  selectHighlights,
  selectRecentDocuments,
  selectReopenableDocumentId,
  useStudySyncStore,
} from '@/stores/useStudySyncStore';
import {
  type AnchorLocation,
  type Annotation,
  type AnnotationPatch,
  defaultBookmarkLabel,
  type DocumentSourceStatus,
  type DocumentViewerProps,
  type PdfLayout,
  type StudyDocument,
} from '@/types/domain';

export function describeResumeLocation(document: StudyDocument): string {
  const anchor = document.lastCursorAnchor;
  if (!anchor) return 'Start reading';
  const progress = document.lastProgress;
  const percent =
    typeof progress === 'number' && Number.isFinite(progress)
      ? `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`
      : null;
  // An EPUB position is a chapter file name, which means nothing to a reader, so
  // it says only how far in the reader is, once the book's text has been measured.
  if (anchor.format === 'epub')
    return percent ? `Continue reading · ${percent}` : 'Continue reading';
  const place = defaultBookmarkLabel(anchor);
  return `Continue reading · ${percent ? `${place} · ${percent}` : place}`;
}

interface TabErrorBoundaryProps {
  document: StudyDocument;
  onCloseTab: () => void;
  children: ReactNode;
}

interface TabErrorBoundaryState {
  error: Error | null;
}

class TabErrorBoundary extends Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  override state: TabErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { error };
  }

  override render() {
    const { error } = this.state;
    const { document, onCloseTab, children } = this.props;
    if (error) {
      return (
        <div
          role="alert"
          data-testid="broken-document-fallback"
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        >
          <AlertTriangle className="size-6 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Could not render {document.title}</p>
            <p className="max-w-md text-xs text-muted-foreground">{describeError(error)}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCloseTab}>
            Close tab
          </Button>
        </div>
      );
    }
    return children;
  }
}

export function ReaderPane() {
  const documents = useStudySyncStore((state) => state.documents);
  const openDocumentIds = useStudySyncStore((state) => state.openDocumentIds);
  const activeDocumentId = useStudySyncStore((state) => state.activeDocumentId);
  const selection = useStudySyncStore((state) => state.selection);
  const isExcerpting = useStudySyncStore((state) => state.isExcerpting);
  const openDocument = useStudySyncStore((state) => state.openDocument);
  const reopenRecentDocument = useStudySyncStore((state) => state.reopenRecentDocument);
  const reopenClosedDocument = useStudySyncStore((state) => state.reopenClosedDocument);
  const closedDocumentIds = useStudySyncStore((state) => state.closedDocumentIds);
  const activateDocument = useStudySyncStore((state) => state.activateDocument);
  const closeDocument = useStudySyncStore((state) => state.closeDocument);
  const excerptSelection = useStudySyncStore((state) => state.excerptSelection);
  const immersive = useStudySyncStore((state) => state.immersive);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const chromeTheme = useReaderChromeTheme();

  const openDocuments = useMemo(
    () =>
      openDocumentIds
        .map((id) => documents.find((document) => document.id === id))
        .filter((document) => document !== undefined),
    [openDocumentIds, documents],
  );
  const recentDocuments = useMemo(() => selectRecentDocuments(documents), [documents]);
  const activeDocument = openDocuments.find((document) => document.id === activeDocumentId);
  const canReopenClosedTab =
    selectReopenableDocumentId(closedDocumentIds, openDocumentIds, documents) !== null;

  /** Next or previous tab, wrapping around at the ends, as Safari's do. */
  const stepTab = (direction: 1 | -1) => {
    if (activeDocumentId === null || openDocuments.length < 2) return;
    const index = openDocuments.findIndex((document) => document.id === activeDocumentId);
    const next = openDocuments[(index + direction + openDocuments.length) % openDocuments.length];
    if (next) activateDocument(next.id);
  };

  useCommands({
    'file.open': { run: () => void openDocument() },
    'file.closeTab': {
      run: () => {
        if (activeDocumentId !== null) closeDocument(activeDocumentId);
      },
      enabled: activeDocumentId !== null,
    },
    'file.reopenClosedTab': {
      run: () => void reopenClosedDocument(),
      enabled: canReopenClosedTab,
    },
    'window.nextTab': { run: () => stepTab(1), enabled: openDocuments.length > 1 },
    'window.previousTab': { run: () => stepTab(-1), enabled: openDocuments.length > 1 },
    'edit.excerpt': {
      run: () => void excerptSelection(),
      enabled: selection !== null && !isExcerpting,
    },
  });

  useDismissOnOutside(recentMenuOpen, () => setRecentMenuOpen(false));

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      if (openDocuments.length <= 1) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % openDocuments.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + openDocuments.length) % openDocuments.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = openDocuments.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      const targetDoc = openDocuments[nextIndex];
      if (!targetDoc) return;
      activateDocument(targetDoc.id);
      const tabButton = window.document.getElementById(`reader-tab-${targetDoc.id}`);
      if (tabButton instanceof HTMLElement) {
        tabButton.focus();
      }
    },
    [activateDocument, openDocuments],
  );

  const handleOpenRecent = useCallback(
    (documentId: string) => {
      setRecentMenuOpen(false);
      void reopenRecentDocument(documentId);
    },
    [reopenRecentDocument],
  );

  const releaseTabPointerFocus = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // Clicking a tab or its close button picks a document to read, not to step through
    // the tablist: keep pointer focus off the tab strip and flush any active editable
    // field's `onBlur` commit/reset handler before activation or close (#50, #64).
    event.preventDefault();
    const active = window.document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.closest('[role="tablist"]') !== null || isEditableShortcutTarget(active))
    ) {
      active.blur();
    }
  }, []);

  return (
    <section
      aria-label="Document reader"
      data-reading-theme={chromeTheme.theme ?? undefined}
      className="flex h-full flex-col bg-background text-foreground"
      style={chromeTheme.style}
    >
      {/* Focus mode hides the tabs; Esc or the toolbar brings them back. */}
      <header
        className={cn(
          'relative flex h-10 shrink-0 items-center gap-1 border-b px-2',
          immersive && 'hidden',
        )}
      >
        <div
          role="tablist"
          aria-label="Open documents"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {openDocuments.map((document, index) => {
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
                  id={`reader-tab-${document.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`reader-tabpanel-${document.id}`}
                  tabIndex={isActive ? 0 : -1}
                  className="truncate py-1 pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onMouseDown={releaseTabPointerFocus}
                  onClick={() => {
                    activateDocument(document.id);
                    requestActivePageFocus();
                  }}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {document.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${document.title}`}
                  title={`Close ${document.title}`}
                  className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                  onMouseDown={releaseTabPointerFocus}
                  onClick={() => {
                    closeDocument(document.id);
                    requestActivePageFocus();
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        {recentDocuments.length > 0 && (
          <Button
            variant={recentMenuOpen ? 'selected' : 'ghost'}
            size="sm"
            aria-label="Recent documents"
            aria-pressed={recentMenuOpen}
            data-testid="recent-documents-toggle"
            onClick={() => setRecentMenuOpen((open) => !open)}
          >
            <Clock />
            Recent
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          title={commandTooltip('Open', 'file.open')}
          onClick={() => void openDocument()}
        >
          <FolderOpen />
          Open
        </Button>
        <ExcerptButton
          hasSelection={selection !== null}
          busy={isExcerpting}
          onExcerpt={() => void excerptSelection()}
        />
        {recentMenuOpen && recentDocuments.length > 0 && (
          <div
            role="region"
            aria-label="Recent documents"
            data-testid="recent-documents-menu"
            data-reader-popover=""
            className="absolute top-10 right-2 z-30 w-80 origin-top-right animate-in rounded-md border bg-background p-1.5 shadow-md animation-duration-150 fade-in-0 slide-in-from-top-1 zoom-in-[0.96] motion-reduce:animate-none"
          >
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Recent documents</p>
            <ol data-testid="recent-documents-list" className="max-h-60 divide-y overflow-y-auto">
              {recentDocuments.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    data-testid="recent-document-item"
                    data-document-format={document.format}
                    onClick={() => handleOpenRecent(document.id)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{document.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {describeResumeLocation(document)}
                      </p>
                    </div>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                      {document.format}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
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
              id={`reader-tabpanel-${document.id}`}
              role="tabpanel"
              aria-labelledby={`reader-tab-${document.id}`}
              className="absolute inset-0"
              style={{ visibility: isActive ? 'visible' : 'hidden' }}
              inert={!isActive}
            >
              <TabErrorBoundary document={document} onCloseTab={() => closeDocument(document.id)}>
                <DocumentTab
                  document={document}
                  isActive={isActive}
                  onCloseTab={() => closeDocument(document.id)}
                />
              </TabErrorBoundary>
            </div>
          );
        })}
        {!activeDocument && (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-6 text-center text-sm text-muted-foreground">
            <p>Open a PDF, EPUB, or TXT file to start reading.</p>
            {recentDocuments.length > 0 && (
              <div
                role="region"
                aria-label="Recent documents"
                data-testid="empty-state-recent-documents"
                className="w-full max-w-md rounded-md border bg-background p-3 text-left shadow-xs"
              >
                <p className="mb-2 text-xs font-medium text-muted-foreground">Continue reading</p>
                <ol data-testid="recent-documents-list" className="divide-y">
                  {recentDocuments.map((document) => (
                    <li key={document.id}>
                      <button
                        type="button"
                        data-testid="recent-document-item"
                        data-document-format={document.format}
                        onClick={() => handleOpenRecent(document.id)}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-foreground">{document.title}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {describeResumeLocation(document)}
                          </p>
                        </div>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                          {document.format}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Why Excerpt to MindMap cannot run, for its tooltip. */
export function excerptUnavailableReason(hasSelection: boolean, busy: boolean): string | null {
  if (busy) return 'Saving the last excerpt…';
  if (!hasSelection) return 'Select text or capture an area in the document to excerpt it';
  return null;
}

/**
 * The primary action only once there is something to excerpt. Until then it is a
 * ghost button, and its tooltip says why: a disabled control shows no tooltip of
 * its own, so the wrapper carries it.
 */
function ExcerptButton({
  hasSelection,
  busy,
  onExcerpt,
}: {
  hasSelection: boolean;
  busy: boolean;
  onExcerpt: () => void;
}) {
  const reason = excerptUnavailableReason(hasSelection, busy);
  const tooltip = commandTooltip('Excerpt to MindMap', 'edit.excerpt');
  return (
    <span
      title={reason ? `${tooltip}: ${reason}` : tooltip}
      data-testid="excerpt-button-wrapper"
      className="inline-flex"
    >
      <Button
        size="sm"
        variant={reason ? 'ghost' : 'default'}
        data-testid="excerpt-button"
        aria-description={reason ?? undefined}
        disabled={reason !== null}
        // Keeps the reader's text selection alive through the click in every engine.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onExcerpt}
      >
        <Quote />
        Excerpt to MindMap
      </Button>
    </span>
  );
}

function SourceRecoveryDialog({
  document,
  status,
  annotations,
  bookmarksCount,
  onRelinkFile,
  onConfirmChangedInPlace,
  onCloseTab,
}: {
  document: StudyDocument;
  status: DocumentSourceStatus;
  annotations: readonly Annotation[];
  bookmarksCount: number;
  onRelinkFile: () => void;
  onConfirmChangedInPlace: () => void;
  onCloseTab: () => void;
}) {
  const isMissing = status.state === 'missing';
  return (
    <div
      role="alert"
      data-testid="source-recovery-dialog"
      data-source-state={status.state}
      className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center text-sm"
    >
      <AlertTriangle className="size-7 text-amber-500" />
      <div className="max-w-lg space-y-1.5">
        <h3 className="font-semibold text-foreground">
          {isMissing
            ? `${document.title} could not be found at its original location`
            : `${document.title} has changed on disk`}
        </h3>
        <p className="text-xs text-muted-foreground">
          {isMissing
            ? 'The source file was moved, renamed, or deleted. Relink it to continue reading. Your saved notes, highlights, and MindMap cards are preserved.'
            : 'The file content no longer matches the SHA-256 fingerprint recorded when your notes were created. Stale anchors are never silently applied to a changed file.'}
        </p>
        <p className="font-mono text-[11px] break-all text-muted-foreground">
          Path: {document.filePath}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" data-testid="relink-file-button" onClick={onRelinkFile}>
          <Link2 />
          Relink file…
        </Button>
        {!isMissing && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="confirm-changed-file-button"
            onClick={onConfirmChangedInPlace}
          >
            <FileCheck />
            Use updated file
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onCloseTab}>
          Close tab
        </Button>
      </div>
      {(annotations.length > 0 || bookmarksCount > 0) && (
        <div
          data-testid="preserved-notes-summary"
          className="w-full max-w-lg rounded-md border bg-muted/20 p-3 text-left text-xs"
        >
          <p className="mb-1.5 font-medium text-foreground">
            Preserved study records ({annotations.length} annotations, {bookmarksCount} bookmarks)
          </p>
          {annotations.length > 0 && (
            <ul className="max-h-40 divide-y overflow-y-auto">
              {annotations.map((annotation) => (
                <li
                  key={annotation.id}
                  data-testid="preserved-annotation-item"
                  className="py-1.5 text-xs"
                >
                  {annotation.excerptText && (
                    <p className="truncate font-medium text-foreground">
                      “{annotation.excerptText}”
                    </p>
                  )}
                  {annotation.note && (
                    <p className="truncate text-muted-foreground">{annotation.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DocumentTab({
  document,
  isActive,
  onCloseTab,
}: {
  document: StudyDocument;
  isActive: boolean;
  onCloseTab: () => void;
}) {
  const content = useStudySyncStore((state) => state.content);
  const sourceStatus = useStudySyncStore(
    (state) => state.documentSourceStatuses[document.id] ?? null,
  );
  const relinkedNonce = useStudySyncStore(
    (state) => state.relinkedNonceByDocumentId[document.id] ?? 0,
  );
  const relinkDocument = useStudySyncStore((state) => state.relinkDocument);
  const annotations = useStudySyncStore((state) => state.annotations);
  const deletedAnnotationHistory = useStudySyncStore((state) => state.deletedAnnotationHistory);
  const allBookmarks = useStudySyncStore((state) => state.bookmarks);
  const readingPreferences = useStudySyncStore((state) => state.readingPreferences);
  const updateReadingPreferences = useStudySyncStore((state) => state.updateReadingPreferences);
  const isPdf = document.format === 'pdf';
  const pdfLayout = useStudySyncStore((state) =>
    isPdf ? state.pdfLayouts[document.id] : undefined,
  );
  const loadPdfLayout = useStudySyncStore((state) => state.loadPdfLayout);
  const savePdfLayout = useStudySyncStore((state) => state.savePdfLayout);
  const addBookmark = useStudySyncStore((state) => state.addBookmark);
  const removeBookmark = useStudySyncStore((state) => state.removeBookmark);
  const createAnnotationFromSelection = useStudySyncStore(
    (state) => state.createAnnotationFromSelection,
  );
  const updateAnnotation = useStudySyncStore((state) => state.updateAnnotation);
  const removeAnnotation = useStudySyncStore((state) => state.removeAnnotation);
  const undoRemoveAnnotation = useStudySyncStore((state) => state.undoRemoveAnnotation);
  const jumpRequest = useStudySyncStore((state) =>
    state.jumpRequest?.documentId === document.id ? state.jumpRequest : null,
  );
  const setSelection = useStudySyncStore((state) => state.setSelection);
  const completeJump = useStudySyncStore((state) => state.completeJump);
  const reportCursor = useStudySyncStore((state) => state.reportCursor);
  const immersive = useStudySyncStore((state) => state.immersive);
  const isExcerpting = useStudySyncStore((state) => state.isExcerpting);
  const excerptSelection = useStudySyncStore((state) => state.excerptSelection);

  const highlights = useMemo(
    () => selectHighlights(annotations, document.id),
    [annotations, document.id],
  );
  const documentAnnotations = useMemo(
    () => selectDocumentAnnotations(annotations, document.id),
    [annotations, document.id],
  );
  const bookmarks = useMemo(
    () => selectBookmarks(allBookmarks, document.id),
    [allBookmarks, document.id],
  );
  const onCursorChange = useCallback(
    (anchor: AnchorLocation, progress?: number) => reportCursor(document.id, anchor, progress),
    [reportCursor, document.id],
  );
  const onPreferencesChange = useCallback(
    (patch: Partial<typeof readingPreferences>) => {
      void updateReadingPreferences(patch);
    },
    [updateReadingPreferences],
  );
  const pdfLayoutLoaded = pdfLayout !== undefined;
  useEffect(() => {
    if (isPdf && !pdfLayoutLoaded) void loadPdfLayout(document.id);
  }, [isPdf, pdfLayoutLoaded, loadPdfLayout, document.id]);
  const onPdfLayoutChange = useCallback(
    (layout: PdfLayout) => {
      void savePdfLayout(document.id, layout);
    },
    [savePdfLayout, document.id],
  );
  const onAddBookmark = useCallback(
    (anchor: AnchorLocation, label?: string) => {
      void addBookmark(document.id, anchor, label);
    },
    [addBookmark, document.id],
  );
  const onRemoveBookmark = useCallback(
    (bookmarkId: string) => {
      void removeBookmark(bookmarkId);
    },
    [removeBookmark],
  );
  const onCreateAnnotation = useCallback(
    (options?: { color?: string; note?: string }) => {
      void createAnnotationFromSelection(options);
    },
    [createAnnotationFromSelection],
  );
  const onUpdateAnnotation = useCallback(
    (annotationId: string, patch: AnnotationPatch) => {
      void updateAnnotation(annotationId, patch);
    },
    [updateAnnotation],
  );
  const onDeleteAnnotation = useCallback(
    (annotationId: string) => {
      void removeAnnotation(annotationId);
    },
    [removeAnnotation],
  );
  const onUndoAnnotationDelete = useCallback(() => {
    void undoRemoveAnnotation();
  }, [undoRemoveAnnotation]);
  const onExcerptSelection = useCallback(() => {
    void excerptSelection();
  }, [excerptSelection]);

  if (sourceStatus && sourceStatus.state !== 'ok') {
    return (
      <SourceRecoveryDialog
        document={document}
        status={sourceStatus}
        annotations={documentAnnotations}
        bookmarksCount={bookmarks.length}
        onRelinkFile={() => void relinkDocument(document.id, false)}
        onConfirmChangedInPlace={() => void relinkDocument(document.id, true)}
        onCloseTab={onCloseTab}
      />
    );
  }

  // The viewer reads its layout once, on mount, so it waits for the saved one
  // rather than opening in the default and jumping.
  if (isPdf && !pdfLayout) {
    return <div className="p-6 text-sm text-muted-foreground">Opening {document.title}…</div>;
  }

  // Safe: the entry is looked up by this document's own format.
  const Viewer = viewerRegistry[document.format] as ComponentType<DocumentViewerProps>;
  return (
    <Viewer
      key={`${document.id}:${relinkedNonce}`}
      document={document}
      isActive={isActive}
      chromeHidden={immersive}
      content={content}
      highlights={highlights}
      jumpRequest={jumpRequest}
      onSelectionChange={setSelection}
      onJumpHandled={completeJump}
      onCursorChange={onCursorChange}
      preferences={readingPreferences}
      onPreferencesChange={onPreferencesChange}
      {...(pdfLayout ? { pdfLayout, onPdfLayoutChange } : {})}
      bookmarks={bookmarks}
      onAddBookmark={onAddBookmark}
      onRemoveBookmark={onRemoveBookmark}
      annotations={documentAnnotations}
      onCreateAnnotation={onCreateAnnotation}
      onUpdateAnnotation={onUpdateAnnotation}
      onDeleteAnnotation={onDeleteAnnotation}
      canUndoAnnotationDelete={deletedAnnotationHistory.length > 0}
      onUndoAnnotationDelete={onUndoAnnotationDelete}
      onExcerptSelection={onExcerptSelection}
      canExcerpt={!isExcerpting}
    />
  );
}
