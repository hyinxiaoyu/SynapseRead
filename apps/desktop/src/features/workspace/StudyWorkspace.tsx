import { PanelRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { InspectorPane } from '@/features/inspector/InspectorPane';
import { MindMapPane } from '@/features/mindmap/MindMapPane';
import { ReaderPane } from '@/features/reader/ReaderPane';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

/** Reader | MindMap | Inspector. The inspector collapses for a 2-pane layout. */
export function StudyWorkspace() {
  const status = useStudySyncStore((state) => state.status);
  const error = useStudySyncStore((state) => state.error);
  const backendKind = useStudySyncStore((state) => state.backendKind);
  const notebookTitle = useStudySyncStore((state) => state.notebook?.title);
  const initialize = useStudySyncStore((state) => state.initialize);
  const dismissError = useStudySyncStore((state) => state.dismissError);

  const inspectorRef = usePanelRef();
  const [inspectorOpen, setInspectorOpen] = useState(true);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const toggleInspector = () => {
    const panel = inspectorRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  return (
    <main className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="font-semibold">SynapseRead</span>
        {notebookTitle && <span className="text-muted-foreground">{notebookTitle}</span>}
        {backendKind === 'memory' && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            Browser preview: nothing is saved
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          aria-pressed={inspectorOpen}
          onClick={toggleInspector}
        >
          <PanelRight />
        </Button>
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
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="reader" defaultSize="45%" minSize="20%">
              <ReaderPane />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="mindmap" defaultSize="35%" minSize="20%">
              <MindMapPane />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="inspector"
              panelRef={inspectorRef}
              defaultSize="20%"
              minSize="15%"
              collapsible
              onResize={(size) => setInspectorOpen(size.asPercentage > 0)}
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
