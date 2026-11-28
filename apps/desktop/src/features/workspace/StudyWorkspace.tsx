import { Maximize, Minimize, Network, PanelRight, Glasses, X } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type Layout,
  type LayoutChangedMeta,
  useGroupRef,
  usePanelRef,
} from 'react-resizable-panels';

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
import {
  DEFAULT_INSPECTOR_SIZE,
  DEFAULT_MIND_MAP_SIZE,
  MAX_INSPECTOR_SIZE,
  MAX_MIND_MAP_SIZE,
  type PanelLayout,
  type PreferredSidePane,
  clampInspectorSize,
  clampMindMapSize,
  computePanelLayout,
  effectiveMinReaderPercent,
} from '@/features/workspace/paneLayout';
import { SUPPORTED_FORMAT_LIST } from '@/lib/documentFormats';
import { flushBeforeClose } from '@/lib/flushBeforeClose';
import { announceInLiveRegion } from '@/lib/liveRegion';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const EMPTY_SLOTS: ToolbarSlots = { leading: null, center: null, trailing: null };

const isFileDrag = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
  (event.dataTransfer?.files?.length ?? 0) > 0 ||
  Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file');

/** Reader | MindMap | Inspector. Pane state and widths persist across launches (#119). */
export function StudyWorkspace() {
  const status = useStudySyncStore((state) => state.status);
  const error = useStudySyncStore((state) => state.error);
  const dropNotice = useStudySyncStore((state) => state.dropNotice);
  const backendKind = useStudySyncStore((state) => state.backendKind);
  const notebookTitle = useStudySyncStore((state) => state.notebook?.title);
  const isDraggingFile = useStudySyncStore((state) => state.isDraggingFile);
  const initialize = useStudySyncStore((state) => state.initialize);
  const dismissError = useStudySyncStore((state) => state.dismissError);
  const dismissDropNotice = useStudySyncStore((state) => state.dismissDropNotice);
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

  const groupRef = useGroupRef();
  const mindMapRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const panelContainerRef = useRef<HTMLDivElement>(null);
  const excerptStatusRef = useRef<HTMLParagraphElement>(null);
  const dropStatusRef = useRef<HTMLParagraphElement>(null);
  const dragDepthRef = useRef(0);
  const suppressLayoutPersistRef = useRef(false);
  const containerWidthRef = useRef(0);
  const openPanesRef = useRef({ mindMap: false, inspector: false });
  const [containerWidth, setContainerWidth] = useState(0);
  const [initialLayout, setInitialLayout] = useState<PanelLayout | null>(null);
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

  const getContainerWidth = useCallback(() => {
    const liveWidth = panelContainerRef.current?.clientWidth ?? 0;
    return liveWidth > 0 ? liveWidth : containerWidthRef.current;
  }, []);

  if (ready && initialLayout === null) {
    const restored = computePanelLayout(paneLayout, immersive, containerWidth);
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

  useLayoutEffect(() => {
    openPanesRef.current = { mindMap: mindMapOpen, inspector: inspectorOpen };
  }, [mindMapOpen, inspectorOpen]);

  useLayoutEffect(() => {
    const element = panelContainerRef.current;
    if (!element) return;
    const syncWidth = (width: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      const rounded = Math.round(width);
      if (containerWidthRef.current === rounded) return;
      containerWidthRef.current = rounded;
      setContainerWidth(rounded);
      const group = groupRef.current;
      if (!group) return;
      const current = group.getLayout();
      const reader = current.reader;
      const mindmap = current.mindmap ?? 0;
      const inspector = current.inspector ?? 0;
      if (reader === undefined || Number.isNaN(reader)) return;
      const minReader = effectiveMinReaderPercent(rounded);
      if ((mindmap > 0 || inspector > 0) && reader < minReader - 0.1) {
        const storeLayout = useStudySyncStore.getState().paneLayout;
        const safe = computePanelLayout(
          {
            mindMapOpen: mindmap > 0,
            inspectorOpen: inspector > 0,
            mindMapSize: mindmap > 0 ? mindmap : storeLayout.mindMapSize,
            inspectorSize: inspector > 0 ? inspector : storeLayout.inspectorSize,
          },
          false,
          rounded,
          'mindmap',
        );
        suppressLayoutPersistRef.current = true;
        try {
          const applied = group.setLayout(safe);
          const nextMindMap = (applied.mindmap ?? safe.mindmap) > 0;
          const nextInspector = (applied.inspector ?? safe.inspector) > 0;
          openPanesRef.current = { mindMap: nextMindMap, inspector: nextInspector };
          setMindMapOpen(nextMindMap);
          setInspectorOpen(nextInspector);
        } finally {
          queueMicrotask(() => {
            suppressLayoutPersistRef.current = false;
          });
        }
      }
    };
    syncWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      syncWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [groupRef]);

  useEffect(() => {
    const statusNode = excerptStatusRef.current;
    if (!statusNode || !ready || excerptNonce === 0) return;
    return announceInLiveRegion(statusNode, excerptNoticeText(lastExcerptParentTitle));
  }, [ready, excerptNonce, lastExcerptParentTitle]);

  useEffect(() => {
    const statusNode = dropStatusRef.current;
    if (!statusNode || !ready || !dropNotice) return;
    return announceInLiveRegion(statusNode, dropNotice.message);
  }, [ready, dropNotice]);

  // The webview's own context menu is a browser's, not the app's: it acts on the
  // document the app is showing. The browser preview keeps it, which is a
  // development tool there (#84).
  useDefaultContextMenuGuard(backendKind === 'tauri' || !import.meta.env.DEV);

  useNativeMenu(onMenuCommand, setMenuItemStates);

  // Applies a target 3-panel layout atomically when the group has measured dimensions
  // (all real browsers/webviews), and falls back to collapse/expand in zero-width
  // jsdom tests where `react-resizable-panels` defers `group.setLayout`.
  const applyGroupLayout = useCallback(
    (nextLayout: PanelLayout): PanelLayout => {
      const group = groupRef.current;
      if (group && Object.keys(group.getLayout()).length > 0) {
        const applied = group.setLayout(nextLayout);
        return {
          reader: applied.reader ?? nextLayout.reader,
          mindmap: applied.mindmap ?? nextLayout.mindmap,
          inspector: applied.inspector ?? nextLayout.inspector,
        };
      }
      const mindMapPanel = mindMapRef.current;
      const inspectorPanel = inspectorRef.current;
      if (nextLayout.mindmap === 0) mindMapPanel?.collapse();
      else mindMapPanel?.expand();
      if (nextLayout.inspector === 0) inspectorPanel?.collapse();
      else inspectorPanel?.expand();
      return nextLayout;
    },
    [groupRef, inspectorRef, mindMapRef],
  );

  // Set the entire group layout explicitly on show/hide so hiding a side pane
  // returns its width to the reader instead of inflating the sibling pane (#180).
  const applyPaneVisibility = useCallback(
    (
      nextOpen: { mindMapOpen: boolean; inspectorOpen: boolean },
      options: { persist?: boolean; preferKeep?: PreferredSidePane } = {},
    ) => {
      if (!groupRef.current) return;
      const { persist = true, preferKeep = 'mindmap' } = options;
      const storeState = useStudySyncStore.getState();
      const nextLayout = computePanelLayout(
        {
          ...storeState.paneLayout,
          mindMapOpen: nextOpen.mindMapOpen,
          inspectorOpen: nextOpen.inspectorOpen,
        },
        false,
        getContainerWidth(),
        preferKeep,
      );
      suppressLayoutPersistRef.current = true;
      try {
        const applied = applyGroupLayout(nextLayout);
        const appliedMindMapOpen = applied.mindmap > 0;
        const appliedInspectorOpen = applied.inspector > 0;
        openPanesRef.current = { mindMap: appliedMindMapOpen, inspector: appliedInspectorOpen };
        setMindMapOpen(appliedMindMapOpen);
        setInspectorOpen(appliedInspectorOpen);
        if (persist && !storeState.immersive) {
          setPaneLayout({
            mindMapOpen: appliedMindMapOpen,
            inspectorOpen: appliedInspectorOpen,
          });
        }
      } finally {
        queueMicrotask(() => {
          suppressLayoutPersistRef.current = false;
        });
      }
    },
    [applyGroupLayout, getContainerWidth, groupRef, setPaneLayout],
  );

  const openMindMap = useCallback(
    (persist = true) => {
      applyPaneVisibility(
        { mindMapOpen: true, inspectorOpen: openPanesRef.current.inspector },
        { persist, preferKeep: 'mindmap' },
      );
    },
    [applyPaneVisibility],
  );

  const closeMindMap = useCallback(
    (persist = true) => {
      applyPaneVisibility(
        { mindMapOpen: false, inspectorOpen: openPanesRef.current.inspector },
        { persist, preferKeep: 'inspector' },
      );
    },
    [applyPaneVisibility],
  );

  const toggleMindMap = useCallback(() => {
    if (openPanesRef.current.mindMap) closeMindMap();
    else openMindMap();
  }, [openMindMap, closeMindMap]);

  const openInspector = useCallback(
    (persist = true) => {
      applyPaneVisibility(
        { mindMapOpen: openPanesRef.current.mindMap, inspectorOpen: true },
        { persist, preferKeep: 'inspector' },
      );
    },
    [applyPaneVisibility],
  );

  const closeInspector = useCallback(
    (persist = true) => {
      applyPaneVisibility(
        { mindMapOpen: openPanesRef.current.mindMap, inspectorOpen: false },
        { persist, preferKeep: 'mindmap' },
      );
    },
    [applyPaneVisibility],
  );

  const toggleInspector = useCallback(() => {
    if (openPanesRef.current.inspector) closeInspector();
    else openInspector();
  }, [openInspector, closeInspector]);

  // Double-clicking a card or invoking Edit Card opens the Inspector if collapsed (#119).
  useEffect(() => {
    if (!ready || !inspectRequest) return;
    if (inspectorRef.current?.isCollapsed() || !inspectorOpen) {
      openInspector();
    }
  }, [ready, inspectRequest, inspectorRef, inspectorOpen, openInspector]);

  // "Show in MindMap" from a highlight opens the MindMap if collapsed (#124).
  useEffect(() => {
    if (!ready || !revealRequest?.openMindMap) return;
    if (mindMapRef.current?.isCollapsed() || !mindMapOpen) {
      openMindMap();
    }
  }, [ready, revealRequest, mindMapRef, mindMapOpen, openMindMap]);

  const handleLayoutChanged = useCallback(
    (layout: Layout, meta?: LayoutChangedMeta) => {
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
      const prevMindMapOpen = openPanesRef.current.mindMap;
      const prevInspectorOpen = openPanesRef.current.inspector;
      openPanesRef.current = { mindMap: nextMindMapOpen, inspector: nextInspectorOpen };
      setMindMapOpen(nextMindMapOpen);
      setInspectorOpen(nextInspectorOpen);
      // Persist pane sizes only from direct handle drags, never from sibling
      // collapse/expand or window-resize constraint adjustments (#180).
      if (
        !meta?.isUserInteraction ||
        suppressLayoutPersistRef.current ||
        useStudySyncStore.getState().immersive
      ) {
        return;
      }
      const requested = meta.requestedLayout ?? layout;
      const requestedMindMap = requested.mindmap ?? mindmap;
      const requestedInspector = requested.inspector ?? inspector;
      const mindMapJustCollapsed = prevMindMapOpen && !nextMindMapOpen;
      const inspectorJustCollapsed = prevInspectorOpen && !nextInspectorOpen;
      setPaneLayout({
        mindMapOpen: nextMindMapOpen,
        inspectorOpen: nextInspectorOpen,
        ...(!inspectorJustCollapsed && requestedMindMap >= DEFAULT_MIND_MAP_SIZE
          ? { mindMapSize: clampMindMapSize(requestedMindMap) }
          : {}),
        ...(!mindMapJustCollapsed && requestedInspector >= DEFAULT_INSPECTOR_SIZE
          ? { inspectorSize: clampInspectorSize(requestedInspector) }
          : {}),
      });
    },
    [setPaneLayout],
  );

  // Focus mode collapses the MindMap and inspector and restores them afterwards,
  // leaving the persisted pane layout untouched.
  const changeImmersive = (next: boolean) => {
    if (next === immersive) return;
    if (next) {
      setPanesBeforeImmersive({
        mindMap: openPanesRef.current.mindMap,
        inspector: openPanesRef.current.inspector,
      });
      if (openPanesRef.current.mindMap || openPanesRef.current.inspector) {
        applyPaneVisibility({ mindMapOpen: false, inspectorOpen: false }, { persist: false });
      }
    } else if (panesBeforeImmersive) {
      applyPaneVisibility(
        {
          mindMapOpen: panesBeforeImmersive.mindMap,
          inspectorOpen: panesBeforeImmersive.inspector,
        },
        { persist: false, preferKeep: 'mindmap' },
      );
      setPanesBeforeImmersive(null);
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
    const files: File[] = [];
    const directoryIndices = new Set<number>();
    const items = Array.from(event.dataTransfer?.items ?? []).filter(
      (item) => item.kind === 'file',
    );
    if (items.length > 0) {
      for (const item of items) {
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
        const file = item.getAsFile();
        if (entry?.isDirectory) {
          directoryIndices.add(files.length);
          files.push(file ?? new File([], entry.name));
        } else if (file) {
          files.push(file);
        }
      }
    } else {
      files.push(...Array.from(event.dataTransfer?.files ?? []));
    }
    if (files.length > 0) {
      void (directoryIndices.size > 0 ? dropFiles(files, { directoryIndices }) : dropFiles(files));
    }
  };

  const showDropOverlay = isDraggingFile || htmlDragging;
  // A card the collapsed MindMap could not show: say it was added, and offer to
  // open the map at it. An open map reveals it itself, and explicit "Show in
  // MindMap" requests open the map directly without showing this notice (#124).
  const pendingReveal = ready && !mindMapOpen && !revealRequest?.openMindMap ? revealRequest : null;
  // Notices share one stack, so their keys are namespaced: a shared key
  // would hand one notice another's node and fade timer.
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
  const dropFailureNotice = dropNotice ? (
    <ReaderNotice
      key={`drop-failure-${dropNotice.nonce}`}
      tone="warning"
      testId="drop-failure-notice"
      announce={false}
      onDismiss={dismissDropNotice}
    >
      {dropNotice.message}
    </ReaderNotice>
  ) : null;
  const cardDeleted = useCardDeletedNotice();
  const immediateNotice =
    dropFailureNotice || cardDeleted.notice ? (
      <>
        {dropFailureNotice}
        {cardDeleted.notice}
      </>
    ) : null;

  const panelDefaultLayout = initialLayout ?? { reader: 100, mindmap: 0, inspector: 0 };
  const minReaderPercent = effectiveMinReaderPercent(containerWidth);

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

        <div ref={panelContainerRef} className="relative min-h-0 flex-1">
          {status === 'ready' ? (
            <ResizablePanelGroup
              groupRef={groupRef}
              orientation="horizontal"
              defaultLayout={panelDefaultLayout}
              onLayoutChanged={handleLayoutChanged}
            >
              <ResizablePanel
                id="reader"
                defaultSize={`${panelDefaultLayout.reader}%`}
                minSize={`${minReaderPercent}%`}
              >
                <ReaderPane
                  notice={excerptNotice}
                  // Undo and partial-drop notices apply immediately, even in focus mode.
                  immediateNotice={immediateNotice}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                id="mindmap"
                panelRef={mindMapRef}
                defaultSize={`${panelDefaultLayout.mindmap}%`}
                minSize={`${DEFAULT_MIND_MAP_SIZE}%`}
                maxSize={`${MAX_MIND_MAP_SIZE}%`}
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
                maxSize={`${MAX_INSPECTOR_SIZE}%`}
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
        <p
          ref={dropStatusRef}
          data-testid="drop-status"
          role="status"
          aria-atomic="true"
          className="sr-only"
        />
        {cardDeleted.liveRegion}
      </main>
    </ToolbarSlotsContext.Provider>
  );
}
