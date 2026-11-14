import { Maximize, Minimize, Network, PanelRight, Glasses, X } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { KeyboardShortcutsDialog } from '@/features/commands/KeyboardShortcutsDialog';
import { useDefaultContextMenuGuard } from '@/features/commands/contextMenu';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import { isEditableShortcutTarget, runCommand, useCommands } from '@/features/commands/registry';
import { useNativeMenu } from '@/features/commands/useNativeMenu';
import { InspectorPane } from '@/features/inspector/InspectorPane';
import { MindMapPane } from '@/features/mindmap/MindMapPane';
import { ReaderPane } from '@/features/reader/ReaderPane';
import {
  type ToolbarSlots,
  ToolbarButton,
  ToolbarSeparator,
  ToolbarSlotsContext,
} from '@/features/reader/ReaderToolbar';
import { pageSurfaceStyle } from '@/features/reader/appearance/themes';
import { useReaderChromeTheme } from '@/features/reader/appearance/useReaderChromeTheme';
import { useResolvedReadingTheme } from '@/features/reader/appearance/useResolvedTheme';
import { UnifiedToolbar } from '@/features/workspace/UnifiedToolbar';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const EMPTY_SLOTS: ToolbarSlots = { leading: null, center: null, trailing: null };

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
  const immersive = useStudySyncStore((state) => state.immersive);
  const setImmersive = useStudySyncStore((state) => state.setImmersive);
  const fullscreen = useStudySyncStore((state) => state.fullscreen);
  const setFullscreen = useStudySyncStore((state) => state.setFullscreen);
  const chromeStyle = useStudySyncStore((state) => state.chromeStyle);
  const hasActiveDocument = useStudySyncStore((state) => state.activeDocumentId !== null);
  const hasReaderSelection = useStudySyncStore((state) => state.selection !== null);
  const readingTheme = useResolvedReadingTheme(
    useStudySyncStore((state) => state.readingPreferences.theme),
  );
  const readerChrome = useReaderChromeTheme();
  const onMenuCommand = useStudySyncStore((state) => state.onMenuCommand);
  const setMenuItemStates = useStudySyncStore((state) => state.setMenuItemStates);

  const mindMapRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const dragDepthRef = useRef(0);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [htmlDragging, setHtmlDragging] = useState(false);
  const [slots, setSlots] = useState<ToolbarSlots>(EMPTY_SLOTS);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** The panes focus mode collapsed, to reopen when it ends. */
  const panesBeforeImmersive = useRef<{ mindMap: boolean; inspector: boolean } | null>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // The webview's own context menu is a browser's, not the app's: it acts on the
  // document the app is showing. The browser preview keeps it, which is a
  // development tool there (#84).
  useDefaultContextMenuGuard(backendKind === 'tauri' || !import.meta.env.DEV);

  useNativeMenu(onMenuCommand, setMenuItemStates);

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

  // Focus mode collapses the MindMap and inspector and restores them afterwards.
  const changeImmersive = (next: boolean) => {
    if (next === immersive) return;
    if (next) {
      panesBeforeImmersive.current = { mindMap: mindMapOpen, inspector: inspectorOpen };
      if (mindMapOpen) toggleMindMap();
      if (inspectorOpen) toggleInspector();
    } else if (panesBeforeImmersive.current) {
      if (panesBeforeImmersive.current.mindMap && !mindMapOpen) toggleMindMap();
      if (panesBeforeImmersive.current.inspector && !inspectorOpen) toggleInspector();
      panesBeforeImmersive.current = null;
    }
    setImmersive(next);
  };
  const changeImmersiveRef = useRef(changeImmersive);
  useEffect(() => {
    changeImmersiveRef.current = changeImmersive;
  });

  // Esc leaves focus mode once nothing above it in the Esc order is open.
  useEscapeLayer(
    ESCAPE_LAYER.focusMode,
    immersive
      ? (event) => {
          // A popover from the toolbar closes itself; text entry keeps its Esc.
          if (document.querySelector('[data-reader-popover]')) return false;
          if (isEditableShortcutTarget(event.target)) return false;
          changeImmersiveRef.current(false);
          return true;
        }
      : null,
  );

  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const ready = status === 'ready';

  useCommands({
    'window.mindMap': {
      run: toggleMindMap,
      enabled: ready,
      title: mindMapOpen ? 'Hide MindMap' : 'Show MindMap',
    },
    'window.inspector': {
      run: toggleInspector,
      enabled: ready,
      title: inspectorOpen ? 'Hide Inspector' : 'Show Inspector',
    },
    'view.immersive': {
      run: () => changeImmersive(!immersive),
      enabled: ready,
      title: immersive ? 'Exit Focus Mode' : 'Enter Focus Mode',
    },
    'view.fullScreen': {
      run: () => void setFullscreen(!fullscreen),
      title: fullscreen ? 'Exit Full Screen' : 'Enter Full Screen',
    },
    'help.shortcuts': { run: () => setShortcutsOpen((open) => !open) },
  });

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
    <ToolbarSlotsContext.Provider value={slots}>
      <main
        className="relative flex h-full flex-col"
        // Focus mode: the whole window takes the page's theme color.
        style={immersive ? pageSurfaceStyle(readingTheme) : undefined}
        data-immersive={immersive || undefined}
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
        <UnifiedToolbar
          chromeStyle={chromeStyle}
          themeStyle={readerChrome.style}
          readingTheme={readerChrome.theme}
          fullscreen={fullscreen}
          immersive={immersive}
          hasReaderSelection={hasReaderSelection}
          showFallbackTitle={!hasActiveDocument}
          fallbackTitle={
            <span className="truncate text-xs font-semibold text-muted-foreground">
              {notebookTitle}
            </span>
          }
          onSlotsChange={setSlots}
          workspaceControls={
            <>
              {backendKind === 'memory' && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground @max-6xl/toolbar:hidden">
                  Preview: nothing is saved
                </span>
              )}
              <ToolbarSeparator />
              <ToolbarButton
                icon={immersive ? Minimize : Glasses}
                label={immersive ? 'Exit focus mode' : 'Enter focus mode'}
                command="view.immersive"
                pressed={immersive}
                disabled={!ready}
                onClick={() => runCommand('view.immersive', 'toolbar')}
              />
              <ToolbarButton
                icon={fullscreen ? Minimize : Maximize}
                label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
                command="view.fullScreen"
                pressed={fullscreen}
                collapse="lg"
                onClick={() => runCommand('view.fullScreen', 'toolbar')}
              />
              <ToolbarButton
                icon={Network}
                label={mindMapOpen ? 'Hide MindMap' : 'Show MindMap'}
                command="window.mindMap"
                pressed={mindMapOpen}
                disabled={!ready}
                onClick={toggleMindMap}
              />
              <ToolbarButton
                icon={PanelRight}
                label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
                command="window.inspector"
                pressed={inspectorOpen}
                disabled={!ready}
                onClick={toggleInspector}
              />
            </>
          }
        />

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
        {shortcutsOpen && <KeyboardShortcutsDialog onClose={closeShortcuts} />}
      </main>
    </ToolbarSlotsContext.Provider>
  );
}
