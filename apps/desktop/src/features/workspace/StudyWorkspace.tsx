import { Network, PanelRight, X } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { InspectorPane } from '@/features/inspector/InspectorPane';
import { MindMapPane } from '@/features/mindmap/MindMapPane';
import { ReaderPane } from '@/features/reader/ReaderPane';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const isFileDrag = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
  (event.dataTransfer?.files?.length ?? 0) > 0;

/** Reader | MindMap | Inspector. MindMap and Inspector start collapsed for full-screen reading. */
export function StudyWorkspace() {
  const status = useStudySyncStore((state) => state.status);
  const error = useStudySyncStore((state) => state.error);
  const backendKind = useStudySyncStore((state) => state.backendKind);
  const notebookTitle = useStudySyncStore((state) => state.notebook?.title);
  const isDraggingFile = useStudySyncStore((state) => state.isDraggingFile);
  const initialize = useStudySyncStore((state) => state.initialize);
  const dismissError = useStudySyncStore((state) => state.dismissError);
  const dropFiles = useStudySyncStore((state) => state.dropFiles);

  const mindMapRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const dragDepthRef = useRef(0);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [htmlDragging, setHtmlDragging] = useState(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const toggleMindMap = () => {
    const panel = mindMapRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setMindMapOpen(true);
    } else {
      panel.collapse();
      setMindMapOpen(false);
    }
  };

  const toggleInspector = () => {
    const panel = inspectorRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setInspectorOpen(true);
    } else {
      panel.collapse();
      setInspectorOpen(false);
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setHtmlDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setHtmlDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setHtmlDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      void dropFiles(files);
    }
  };

  const showDropOverlay = isDraggingFile || htmlDragging;

  return (
    <main
      className="relative flex h-full flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showDropOverlay && (
        <div
          role="status"
          aria-label="Drop files to open"
          className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-foreground backdrop-blur-xs"
        >
          Drop PDF, EPUB, TXT, or Markdown files to open
        </div>
      )}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="font-semibold">SynapseRead</span>
        {notebookTitle && <span className="text-muted-foreground">{notebookTitle}</span>}
        {backendKind === 'memory' && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            Browser preview: nothing is saved
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={mindMapOpen ? 'Hide MindMap' : 'Show MindMap'}
            aria-pressed={mindMapOpen}
            onClick={toggleMindMap}
          >
            <Network />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            aria-pressed={inspectorOpen}
            onClick={toggleInspector}
          >
            <PanelRight />
          </Button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Dismiss error"
            onClick={dismissError}
          >
            <X />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {status === 'ready' ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={{ reader: 100, mindmap: 0, inspector: 0 }}
          >
            <ResizablePanel id="reader" defaultSize="100%" minSize="20%">
              <ReaderPane />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="mindmap"
              panelRef={mindMapRef}
              defaultSize="0%"
              minSize="35%"
              collapsible
              onResize={(size) => {
                if (!Number.isNaN(size.asPercentage)) setMindMapOpen(size.asPercentage > 0);
              }}
            >
              <MindMapPane />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="inspector"
              panelRef={inspectorRef}
              defaultSize="0%"
              minSize="20%"
              collapsible
              onResize={(size) => {
                if (!Number.isNaN(size.asPercentage)) setInspectorOpen(size.asPercentage > 0);
              }}
            >
              <InspectorPane />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {status === 'error' ? 'SynapseRead could not load its data.' : 'Loading…'}
          </div>
        )}
      </div>
    </main>
  );
}
