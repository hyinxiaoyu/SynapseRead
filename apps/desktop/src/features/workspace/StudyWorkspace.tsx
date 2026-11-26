import { Maximize, Minimize, Network, PanelRight, Glasses, X } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { type Layout, usePanelRef } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { KeyboardShortcutsDialog } from '@/features/commands/KeyboardShortcutsDialog';
import { useDefaultContextMenuGuard } from '@/features/commands/contextMenu';
import { ESCAPE_LAYER, useEscapeLayer } from '@/features/commands/escape';
import {
  type CommandHandlers,
  isEditableShortcutTarget,
  runCommand,
  useCommands,
} from '@/features/commands/registry';
import { useNativeMenu } from '@/features/commands/useNativeMenu';
import { InspectorPane } from '@/features/inspector/InspectorPane';
import { LanImportDialog } from '@/features/lanSync/LanImportDialog';
import { LanShareDialog } from '@/features/lanSync/LanShareDialog';
import { LanShareIndicator } from '@/features/lanSync/LanShareIndicator';
import { MindMapPane } from '@/features/mindmap/MindMapPane';
import { excerptNoticeText } from '@/features/mindmap/nestingLabel';
import { useCardDeletedNotice } from '@/features/mindmap/useCardDeletedNotice';
import { ReaderNotice } from '@/features/reader/ReaderNotice';
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
import { SUPPORTED_FORMAT_LIST } from '@/lib/documentFormats';
import { flushBeforeClose } from '@/lib/flushBeforeClose';
import { announceInLiveRegion } from '@/lib/liveRegion';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type { WorkspacePaneLayout } from '@/types/domain';

const EMPTY_SLOTS: ToolbarSlots = { leading: null, center: null, trailing: null };
const DEFAULT_MIND_MAP_SIZE = 35;
const DEFAULT_INSPECTOR_SIZE = 20;
const MIN_READER_SIZE = 20;

const roundPercent = (value: number) => Math.round(value * 10) / 10;

function computeInitialPanelLayout(
  paneLayout: WorkspacePaneLayout,
  immersive: boolean,
): { reader: number; mindmap: number; inspector: number } {
  if (immersive) {
    return { reader: 100, mindmap: 0, inspector: 0 };
  }
  let mindmap = paneLayout.mindMapOpen ? (paneLayout.mindMapSize ?? DEFAULT_MIND_MAP_SIZE) : 0;
  let inspector = paneLayout.inspectorOpen
    ? (paneLayout.inspectorSize ?? DEFAULT_INSPECTOR_SIZE)
    : 0;
  const maxCombined = 100 - MIN_READER_SIZE;
  if (mindmap + inspector > maxCombined) {
    const excess = mindmap + inspector - maxCombined;
    const trimMindMap = Math.min(excess, Math.max(0, mindmap - DEFAULT_MIND_MAP_SIZE));
    mindmap -= trimMindMap;
    const remaining = excess - trimMindMap;
    if (remaining > 0) {
      inspector = Math.max(DEFAULT_INSPECTOR_SIZE, inspector - remaining);
    }
  }
  const reader = Math.max(MIN_READER_SIZE, 100 - mindmap - inspector);
  return { reader, mindmap, inspector };
}

const isFileDrag = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
  (event.dataTransfer?.files?.length ?? 0) > 0;

/** Reader | MindMap | Inspector. Pane state and widths persist across launches (#119). */
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
  const paneLayout = useStudySyncStore((state) => state.paneLayout);
  const setPaneLayout = useStudySyncStore((state) => state.setPaneLayout);
  const fullscreen = useStudySyncStore((state) => state.fullscreen);
  const setFullscreen = useStudySyncStore((state) => state.setFullscreen);
  const chromeStyle = useStudySyncStore((state) => state.chromeStyle);
  const hasActiveDocument = useStudySyncStore((state) => state.activeDocumentId !== null);
  const hasReaderSelection = useStudySyncStore((state) => state.selection !== null);
  const readingTheme = useResolvedReadingTheme(
    useStudySyncStore((state) => state.readingPreferences.theme),
  );
  const readerChrome = useReaderChromeTheme();
  const revealRequest = useStudySyncStore((state) => state.revealRequest);
  const inspectRequest = useStudySyncStore((state) => state.inspectRequest);
  const excerptNonce = useStudySyncStore((state) => state.excerptNonce);
  const lastExcerptParentTitle = useStudySyncStore((state) => state.lastExcerptParentTitle);
  const revealNode = useStudySyncStore((state) => state.revealNode);
  const completeReveal = useStudySyncStore((state) => state.completeReveal);
  const deletedAnnotationCount = useStudySyncStore(
    (state) => state.deletedAnnotationHistory.length,
  );
  const undoRemoveAnnotation = useStudySyncStore((state) => state.undoRemoveAnnotation);
  const onMenuCommand = useStudySyncStore((state) => state.onMenuCommand);
  const setMenuItemStates = useStudySyncStore((state) => state.setMenuItemStates);
  const onBeforeClose = useStudySyncStore((state) => state.onBeforeClose);
  const lanShareSnapshot = useStudySyncStore((state) => state.lanShare.snapshot);
  const refreshLanShareStatus = useStudySyncStore((state) => state.refreshLanShareStatus);
  const lanImportPhase = useStudySyncStore((state) => state.lanImport.phase);

  const mindMapRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const excerptStatusRef = useRef<HTMLParagraphElement>(null);
  const dragDepthRef = useRef(0);
  const suppressLayoutPersistRef = useRef(false);
  const [initialLayout, setInitialLayout] = useState<{
    reader: number;
    mindmap: number;
    inspector: number;
  } | null>(null);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [htmlDragging, setHtmlDragging] = useState(false);
  const [slots, setSlots] = useState<ToolbarSlots>(EMPTY_SLOTS);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [isImportPreparingFlush, setIsImportPreparingFlush] = useState(false);
  /** The panes focus mode collapsed, to reopen when it ends. */
  const [panesBeforeImmersive, setPanesBeforeImmersive] = useState<{
    mindMap: boolean;
    inspector: boolean;
  } | null>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Flush unsaved Inspector edits before the native window closes or quits (#117).
  useEffect(() => onBeforeClose(flushBeforeClose), [onBeforeClose]);

  const isSharingActive = lanShareSnapshot.status.state !== 'off';
  useEffect(() => {
    if (!isSharingActive || shareDialogOpen) return;
    const poll = window.setInterval(() => {
      void refreshLanShareStatus();
    }, 3000);
    return () => window.clearInterval(poll);
  }, [isSharingActive, refreshLanShareStatus, shareDialogOpen]);

  const ready = status === 'ready';

  if (ready && initialLayout === null) {
    const restored = computeInitialPanelLayout(paneLayout, immersive);
    setInitialLayout(restored);
    setMindMapOpen(restored.mindmap > 0);
    setInspectorOpen(restored.inspector > 0);
    if (immersive && (paneLayout.mindMapOpen || paneLayout.inspectorOpen)) {
      setPanesBeforeImmersive({
        mindMap: paneLayout.mindMapOpen,
        inspector: paneLayout.inspectorOpen,
      });
    }
  }

  useEffect(() => {
    const statusNode = excerptStatusRef.current;
    if (!statusNode || !ready || excerptNonce === 0) return;
    return announceInLiveRegion(statusNode, excerptNoticeText(lastExcerptParentTitle));
  }, [ready, excerptNonce, lastExcerptParentTitle]);

  // The webview's own context menu is a browser's, not the app's: it acts on the
  // document the app is showing. The browser preview keeps it, which is a
  // development tool there (#84).
  useDefaultContextMenuGuard(backendKind === 'tauri' || !import.meta.env.DEV);

  useNativeMenu(onMenuCommand, setMenuItemStates);

  const openMindMap = useCallback(
    (persist = true) => {
      const panel = mindMapRef.current;
      if (!panel) return;
      if (panel.isCollapsed()) {
        const savedSize = useStudySyncStore.getState().paneLayout.mindMapSize;
        if (savedSize !== null) {
          panel.resize(`${savedSize}%`);
          if (panel.isCollapsed()) panel.expand();
        } else {
          panel.expand();
        }
      }
      setMindMapOpen(true);
      if (persist && !useStudySyncStore.getState().immersive) {
        setPaneLayout({ mindMapOpen: true });
      }
    },
    [mindMapRef, setPaneLayout],
  );

  const closeMindMap = useCallback(
    (persist = true) => {
      const panel = mindMapRef.current;
      if (!panel) return;
      if (!panel.isCollapsed()) panel.collapse();
      setMindMapOpen(false);
      if (persist && !useStudySyncStore.getState().immersive) {
        setPaneLayout({ mindMapOpen: false });
      }
    },
    [mindMapRef, setPaneLayout],
  );

  const toggleMindMap = useCallback(() => {
    const panel = mindMapRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) openMindMap();
    else closeMindMap();
  }, [mindMapRef, openMindMap, closeMindMap]);

  const openInspector = useCallback(
    (persist = true) => {
      const panel = inspectorRef.current;
      if (!panel) return;
      if (panel.isCollapsed()) {
        const savedSize = useStudySyncStore.getState().paneLayout.inspectorSize;
        if (savedSize !== null) {
          panel.resize(`${savedSize}%`);
          if (panel.isCollapsed()) panel.expand();
        } else {
          panel.expand();
        }
      }
      setInspectorOpen(true);
      if (persist && !useStudySyncStore.getState().immersive) {
        setPaneLayout({ inspectorOpen: true });
      }
    },
    [inspectorRef, setPaneLayout],
  );

  const closeInspector = useCallback(
    (persist = true) => {
      const panel = inspectorRef.current;
      if (!panel) return;
      if (!panel.isCollapsed()) panel.collapse();
      setInspectorOpen(false);
      if (persist && !useStudySyncStore.getState().immersive) {
        setPaneLayout({ inspectorOpen: false });
      }
    },
    [inspectorRef, setPaneLayout],
  );

  const toggleInspector = useCallback(() => {
    const panel = inspectorRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) openInspector();
    else closeInspector();
  }, [inspectorRef, openInspector, closeInspector]);

  // Double-clicking a card or invoking Edit Card opens the Inspector if collapsed (#119).
  useEffect(() => {
    if (!ready || !inspectRequest) return;
    if (inspectorRef.current?.isCollapsed() || !inspectorOpen) {
      openInspector();
    }
  }, [ready, inspectRequest, inspectorRef, inspectorOpen, openInspector]);

  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      const mindmap = layout.mindmap;
      const inspector = layout.inspector;
      if (
        mindmap === undefined ||
        inspector === undefined ||
        Number.isNaN(mindmap) ||
        Number.isNaN(inspector)
      ) {
        return;
      }
      const nextMindMapOpen = mindmap > 0;
      const nextInspectorOpen = inspector > 0;
      setMindMapOpen(nextMindMapOpen);
      setInspectorOpen(nextInspectorOpen);
      if (suppressLayoutPersistRef.current || useStudySyncStore.getState().immersive) return;
      setPaneLayout({
        mindMapOpen: nextMindMapOpen,
        inspectorOpen: nextInspectorOpen,
        ...(mindmap >= DEFAULT_MIND_MAP_SIZE ? { mindMapSize: roundPercent(mindmap) } : {}),
        ...(inspector >= DEFAULT_INSPECTOR_SIZE ? { inspectorSize: roundPercent(inspector) } : {}),
      });
    },
    [setPaneLayout],
  );

  // Focus mode collapses the MindMap and inspector and restores them afterwards,
  // leaving the persisted pane layout untouched.
  const changeImmersive = (next: boolean) => {
    if (next === immersive) return;
    suppressLayoutPersistRef.current = true;
    try {
      if (next) {
        setPanesBeforeImmersive({ mindMap: mindMapOpen, inspector: inspectorOpen });
        if (mindMapOpen) closeMindMap(false);
        if (inspectorOpen) closeInspector(false);
      } else if (panesBeforeImmersive) {
        if (panesBeforeImmersive.mindMap && !mindMapOpen) openMindMap(false);
        if (panesBeforeImmersive.inspector && !inspectorOpen) openInspector(false);
        setPanesBeforeImmersive(null);
      }
      setImmersive(next);
    } finally {
      queueMicrotask(() => {
        suppressLayoutPersistRef.current = false;
      });
    }
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

  const isLanImportBusy =
    lanImportPhase === 'connecting' ||
    lanImportPhase === 'planning' ||
    lanImportPhase === 'importing' ||
    lanImportPhase === 'disconnecting' ||
    isImportPreparingFlush;
  // Share cannot open while Import is mounted or holds a transition lock (`#170`):
  // unmounting Import mid-session would skip `disconnectLanImport()`.
  const isShareBlockedByImport = importDialogOpen || isLanImportBusy;

  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openShareDialog = useCallback(() => {
    if (isShareBlockedByImport) return;
    setShareDialogOpen(true);
  }, [isShareBlockedByImport]);
  const closeShareDialog = useCallback(() => setShareDialogOpen(false), []);
  const openImportDialog = useCallback(() => {
    if (shareDialogOpen) return;
    setImportDialogOpen(true);
  }, [shareDialogOpen]);
  const closeImportDialog = useCallback(() => setImportDialogOpen(false), []);

  const workspaceCommands: CommandHandlers = {
    'file.shareOnNetwork': {
      run: openShareDialog,
      enabled: !isShareBlockedByImport,
    },
    'file.importFromDevice': {
      run: openImportDialog,
      enabled: !shareDialogOpen,
    },
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
  };
  if (deletedAnnotationCount > 0) {
    workspaceCommands['edit.undoDelete'] = {
      run: () => void undoRemoveAnnotation(),
      enabled: ready,
    };
  }
  useCommands(workspaceCommands);

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
  // A card the collapsed MindMap could not show: say it was added, and offer to
  // open the map at it. An open map reveals it itself.
  const pendingReveal = ready && !mindMapOpen ? revealRequest : null;
  // Both notices share one stack, so their keys are namespaced: a shared key
  // would hand the deletion notice the excerpt notice's node and its fade timer.
  const excerptNotice = pendingReveal ? (
    <ReaderNotice
      key={`excerpt-${pendingReveal.nonce}`}
      tone="info"
      testId="excerpt-added-notice"
      announce={false}
      action={{
        label: 'Show',
        onClick: () => {
          revealNode(pendingReveal.nodeId);
          if (mindMapRef.current?.isCollapsed()) toggleMindMap();
        },
      }}
      onDismiss={() => completeReveal(pendingReveal.nonce)}
    >
      {excerptNoticeText(pendingReveal.parentTitle)}
    </ReaderNotice>
  ) : null;
  const cardDeleted = useCardDeletedNotice();

  const panelDefaultLayout = initialLayout ?? { reader: 100, mindmap: 0, inspector: 0 };

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
            Drop {SUPPORTED_FORMAT_LIST} files to open
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
              <LanShareIndicator
                snapshot={lanShareSnapshot}
                variant="toolbar"
                disabled={isShareBlockedByImport}
                onClick={openShareDialog}
              />
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

        <div className="relative min-h-0 flex-1">
          {status === 'ready' ? (
            <ResizablePanelGroup
              orientation="horizontal"
              defaultLayout={panelDefaultLayout}
              onLayoutChanged={handleLayoutChanged}
            >
              <ResizablePanel
                id="reader"
                defaultSize={`${panelDefaultLayout.reader}%`}
                minSize={`${MIN_READER_SIZE}%`}
              >
                <ReaderPane
                  notice={excerptNotice}
                  // Undo is only useful now, so it does not wait for focus mode to end.
                  immediateNotice={cardDeleted.notice}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                id="mindmap"
                panelRef={mindMapRef}
                defaultSize={`${panelDefaultLayout.mindmap}%`}
                minSize={`${DEFAULT_MIND_MAP_SIZE}%`}
                collapsible
                onResize={(size) => {
                  if (!Number.isNaN(size.asPercentage)) setMindMapOpen(size.asPercentage > 0);
                }}
              >
                <MindMapPane open={mindMapOpen} inspectorOpen={inspectorOpen} />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                id="inspector"
                panelRef={inspectorRef}
                defaultSize={`${panelDefaultLayout.inspector}%`}
                minSize={`${DEFAULT_INSPECTOR_SIZE}%`}
                collapsible
                onResize={(size) => {
                  if (!Number.isNaN(size.asPercentage)) setInspectorOpen(size.asPercentage > 0);
                }}
              >
                <InspectorPane open={inspectorOpen} />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {status === 'error' ? 'SynapseRead could not load its data.' : 'Loading…'}
            </div>
          )}
        </div>
        {immersive && isSharingActive && (
          <LanShareIndicator
            snapshot={lanShareSnapshot}
            variant="floating"
            disabled={isShareBlockedByImport}
            onClick={openShareDialog}
          />
        )}
        <LanShareDialog open={shareDialogOpen} onClose={closeShareDialog} />
        <LanImportDialog
          open={importDialogOpen}
          onClose={closeImportDialog}
          onCloseFlushBusyChange={setIsImportPreparingFlush}
        />
        {shortcutsOpen && <KeyboardShortcutsDialog onClose={closeShortcuts} />}
        <p
          ref={excerptStatusRef}
          data-testid="excerpt-status"
          role="status"
          aria-atomic="true"
          className="sr-only"
        />
        {cardDeleted.liveRegion}
      </main>
    </ToolbarSlotsContext.Provider>
  );
}
