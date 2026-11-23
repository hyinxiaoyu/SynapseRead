import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import {
  buildConflictOverrideDecision,
  buildImportDecisions,
  collectOpenDocumentIdsForPositionImport,
  createInitialDecisions,
  type EditableBookDecision,
  mergeExecutionReports,
} from '@/features/lanSync/importDecisions';
import {
  LanImportCatalogFooter,
  LanImportCatalogStep,
} from '@/features/lanSync/LanImportCatalogStep';
import {
  LanImportConnectFooter,
  LanImportConnectStep,
  useLanImportConnect,
} from '@/features/lanSync/LanImportConnectStep';
import {
  LanImportPreviewFooter,
  LanImportPreviewStep,
} from '@/features/lanSync/LanImportPreviewStep';
import {
  LanImportProgressFooter,
  LanImportProgressStep,
  LanImportResultsFooter,
  LanImportResultsStep,
} from '@/features/lanSync/LanImportProgressResultsStep';
import { LanSyncDialog } from '@/features/lanSync/LanSyncDialog';
import { useStudySyncStore } from '@/stores/useStudySyncStore';
import type {
  BookImportDecision,
  LanImportExecutionReport,
  LanImportPlanResult,
} from '@/types/domain';

export function LanImportDialog({
  open,
  onClose,
  onCloseFlushBusyChange,
}: {
  open: boolean;
  onClose: () => void;
  onCloseFlushBusyChange?: (busy: boolean) => void;
}) {
  if (!open) return null;
  return (
    <LanImportDialogBody
      onClose={onClose}
      {...(onCloseFlushBusyChange ? { onCloseFlushBusyChange } : {})}
    />
  );
}

function LanImportDialogBody({
  onClose,
  onCloseFlushBusyChange,
}: {
  onClose: () => void;
  onCloseFlushBusyChange?: (busy: boolean) => void;
}) {
  const lanImport = useStudySyncStore((state) => state.lanImport);
  const planLanImport = useStudySyncStore((state) => state.planLanImport);
  const executeLanImport = useStudySyncStore((state) => state.executeLanImport);
  const cancelLanImportOperation = useStudySyncStore((state) => state.cancelLanImportOperation);
  const backToLanImportCatalog = useStudySyncStore((state) => state.backToLanImportCatalog);
  const disconnectLanImport = useStudySyncStore((state) => state.disconnectLanImport);
  const closeDocumentAndFlush = useStudySyncStore((state) => state.closeDocumentAndFlush);
  const lockDocument = useStudySyncStore((state) => state.lockDocument);
  const reopenRecentDocument = useStudySyncStore((state) => state.reopenRecentDocument);

  const addressInputRef = useRef<HTMLInputElement>(null);
  const connectController = useLanImportConnect();

  const [catalogSelection, setCatalogSelection] = useState<{
    sessionId: string | null;
    ids: ReadonlySet<string>;
  }>(() => ({
    sessionId: lanImport.session?.sessionId ?? null,
    ids: new Set(),
  }));

  const [decisionState, setDecisionState] = useState<{
    forPlan: LanImportPlanResult | null;
    map: Record<string, EditableBookDecision>;
  }>(() => ({
    forPlan: lanImport.plan,
    map: lanImport.plan ? createInitialDecisions(lanImport.plan) : {},
  }));

  const [isPreparingCloseFlush, setIsPreparingCloseFlush] = useState(false);
  const [isDisconnectingLocal, setIsDisconnectingLocal] = useState(false);
  const [lastSubmittedDecisions, setLastSubmittedDecisions] = useState<BookImportDecision[]>([]);
  const [mergedReport, setMergedReport] = useState<LanImportExecutionReport | null>(null);
  const closingRef = useRef(false);
  const disconnectingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onCloseFlushBusyChange?.(isPreparingCloseFlush);
    return () => {
      onCloseFlushBusyChange?.(false);
    };
  }, [isPreparingCloseFlush, onCloseFlushBusyChange]);

  const currentSessionId = lanImport.session?.sessionId ?? null;
  const eligibleCatalogIds = useMemo(
    () => new Set(lanImport.catalog.filter((book) => book.eligible).map((book) => book.bookId)),
    [lanImport.catalog],
  );

  const selectedBookIds = useMemo(() => {
    if (catalogSelection.sessionId !== currentSessionId) {
      return new Set<string>();
    }
    const filtered = new Set<string>();
    for (const id of catalogSelection.ids) {
      if (eligibleCatalogIds.has(id)) {
        filtered.add(id);
      }
    }
    return filtered;
  }, [catalogSelection.ids, catalogSelection.sessionId, currentSessionId, eligibleCatalogIds]);

  const effectiveDecisionsMap = useMemo(() => {
    if (lanImport.plan !== null && decisionState.forPlan !== lanImport.plan) {
      return createInitialDecisions(lanImport.plan);
    }
    return decisionState.map;
  }, [decisionState.forPlan, decisionState.map, lanImport.plan]);

  const isBusyTransfer =
    lanImport.phase === 'planning' || lanImport.phase === 'importing' || isPreparingCloseFlush;
  const isDisconnecting = isDisconnectingLocal || lanImport.phase === 'disconnecting';

  const activeReport = mergedReport ?? lanImport.executionReport;

  const effectiveStep:
    'connect' | 'disconnecting' | 'catalog' | 'preview' | 'importing' | 'results' = (() => {
    if (isDisconnecting) return 'disconnecting';
    if (isPreparingCloseFlush || lanImport.phase === 'importing') return 'importing';
    if (lanImport.phase === 'results' && activeReport !== null) return 'results';
    if (lanImport.phase === 'preview' && lanImport.plan !== null) return 'preview';
    if (lanImport.phase === 'catalog' || lanImport.phase === 'planning') return 'catalog';
    return 'connect';
  })();

  const beginDisconnect = useCallback(
    (options: {
      closeDialog: boolean;
      openDocumentId?: string;
      clearReport?: boolean;
      cancelPendingConnect?: boolean;
    }) => {
      if (isBusyTransfer || disconnectingRef.current || closingRef.current) return;
      if (options.clearReport) {
        setMergedReport(null);
        setLastSubmittedDecisions([]);
      }
      if (options.cancelPendingConnect) {
        // `disconnectLanImport()` below cancels the active backend operation once.
        connectController.cancel({ cancelBackend: false });
      }

      const { lanImport: currentImport } = useStudySyncStore.getState();
      const needsAsyncTeardown =
        currentImport.session !== null || currentImport.activeOperationId !== null;

      // Avoid flashing "Disconnecting…" when closing an unpaired, idle form.
      if (options.closeDialog && !needsAsyncTeardown && !options.openDocumentId) {
        closingRef.current = true;
        void disconnectLanImport();
        onClose();
        return;
      }

      disconnectingRef.current = true;
      if (options.closeDialog) {
        closingRef.current = true;
      }
      setIsDisconnectingLocal(true);

      void disconnectLanImport().finally(() => {
        disconnectingRef.current = false;
        if (!mountedRef.current) return;
        setIsDisconnectingLocal(false);
        if (options.closeDialog) {
          onClose();
          if (options.openDocumentId) {
            void reopenRecentDocument(options.openDocumentId);
          }
        }
      });
    },
    [connectController, disconnectLanImport, isBusyTransfer, onClose, reopenRecentDocument],
  );

  const handleClose = useCallback(() => {
    beginDisconnect({
      closeDialog: true,
      cancelPendingConnect: effectiveStep === 'connect',
    });
  }, [beginDisconnect, effectiveStep]);

  const handleInDialogDisconnect = useCallback(() => {
    beginDisconnect({ closeDialog: false });
  }, [beginDisconnect]);

  const handleToggleCatalogBook = useCallback(
    (bookId: string) => {
      setCatalogSelection((prev) => {
        const base = prev.sessionId === currentSessionId ? new Set(prev.ids) : new Set<string>();
        if (base.has(bookId)) base.delete(bookId);
        else base.add(bookId);
        return { sessionId: currentSessionId, ids: base };
      });
    },
    [currentSessionId],
  );

  const handleSelectAllEligible = useCallback(
    (ids: readonly string[]) => {
      setCatalogSelection({
        sessionId: currentSessionId,
        ids: new Set(ids),
      });
    },
    [currentSessionId],
  );

  const handleClearCatalogSelection = useCallback(() => {
    setCatalogSelection({
      sessionId: currentSessionId,
      ids: new Set(),
    });
  }, [currentSessionId]);

  const handleUpdateDecision = useCallback(
    (bookId: string, next: EditableBookDecision) => {
      const currentPlan = lanImport.plan;
      setDecisionState((prev) => {
        const base =
          currentPlan !== null && prev.forPlan !== currentPlan
            ? createInitialDecisions(currentPlan)
            : prev.map;
        return {
          forPlan: currentPlan,
          map: {
            ...base,
            [bookId]: next,
          },
        };
      });
    },
    [lanImport.plan],
  );

  const runImportBatch = useCallback(
    async (
      decisionsToRun: BookImportDecision[],
      options: { resetPrevious: boolean; mode: 'batch' | 'conflictOverride' },
    ) => {
      if (
        decisionsToRun.length === 0 ||
        disconnectingRef.current ||
        closingRef.current ||
        useStudySyncStore.getState().lanImport.phase === 'disconnecting'
      ) {
        return;
      }
      if (options.resetPrevious) {
        setMergedReport(null);
      }
      if (options.mode === 'batch') {
        setLastSubmittedDecisions(decisionsToRun);
      }

      const releases: Array<() => void> = [];
      try {
        const currentPlan = useStudySyncStore.getState().lanImport.plan;
        const docsToClose = currentPlan
          ? collectOpenDocumentIdsForPositionImport(
              currentPlan,
              decisionsToRun,
              useStudySyncStore.getState().openDocumentIds,
            )
          : [];

        if (docsToClose.length > 0) {
          setIsPreparingCloseFlush(true);
          for (const documentId of docsToClose) {
            releases.push(lockDocument(documentId));
          }
          for (const documentId of docsToClose) {
            await closeDocumentAndFlush(documentId);
          }
          setIsPreparingCloseFlush(false);
        }

        const nextReport = await executeLanImport(decisionsToRun);
        if (nextReport !== null) {
          setMergedReport((prev) =>
            mergeExecutionReports(options.resetPrevious ? null : prev, nextReport, decisionsToRun),
          );
        }
      } finally {
        setIsPreparingCloseFlush(false);
        for (const release of releases) {
          release();
        }
      }
    },
    [closeDocumentAndFlush, executeLanImport, lockDocument],
  );

  const handleBackToCatalog = useCallback(() => {
    if (isBusyTransfer || isDisconnecting || disconnectingRef.current || closingRef.current) {
      return;
    }
    setMergedReport(null);
    setLastSubmittedDecisions([]);
    void backToLanImportCatalog();
  }, [backToLanImportCatalog, isBusyTransfer, isDisconnecting]);

  const handleContinueReading = useCallback(
    (documentId: string) => {
      beginDisconnect({ closeDialog: true, openDocumentId: documentId });
    },
    [beginDisconnect],
  );

  const handleDone = useCallback(() => {
    beginDisconnect({ closeDialog: true });
  }, [beginDisconnect]);

  const handleResultsReconnect = useCallback(() => {
    beginDisconnect({ closeDialog: false, clearReport: true });
  }, [beginDisconnect]);

  const stepDescription = (() => {
    switch (effectiveStep) {
      case 'connect':
        return 'Connect to another SynapseRead desktop app sharing on the same local network.';
      case 'disconnecting':
        return 'Ending the pairing session with the source device.';
      case 'catalog':
        return 'Choose which shared books to inspect before importing.';
      case 'preview':
        return 'Review file downloads, reading positions, and bookmarks for each selected book.';
      case 'importing':
        return 'Verifying files and saving imported reading data.';
      case 'results':
        return 'Review what was imported during this batch.';
    }
  })();

  const footer = (() => {
    switch (effectiveStep) {
      case 'connect':
        return <LanImportConnectFooter controller={connectController} onClose={handleClose} />;
      case 'disconnecting':
        return (
          <>
            <span className="text-xs text-muted-foreground">Disconnecting from source device…</span>
            <Button type="button" variant="outline" size="sm" disabled>
              Disconnecting…
            </Button>
          </>
        );
      case 'catalog':
        return (
          <LanImportCatalogFooter
            selectedCount={selectedBookIds.size}
            eligibleCount={eligibleCatalogIds.size}
            isPlanning={lanImport.phase === 'planning'}
            onReview={() => {
              if (disconnectingRef.current || closingRef.current) return;
              void planLanImport([...selectedBookIds]);
            }}
            onCloseAndDisconnect={handleClose}
          />
        );
      case 'preview':
        return (
          lanImport.plan && (
            <LanImportPreviewFooter
              plan={lanImport.plan}
              decisionsMap={effectiveDecisionsMap}
              isBusy={isBusyTransfer || isDisconnecting}
              onBackToCatalog={handleBackToCatalog}
              onDisconnect={handleInDialogDisconnect}
              onStartImport={() => {
                if (!lanImport.plan || disconnectingRef.current || closingRef.current) return;
                const decisions = buildImportDecisions(lanImport.plan, effectiveDecisionsMap);
                void runImportBatch(decisions, { resetPrevious: true, mode: 'batch' });
              }}
            />
          )
        );
      case 'importing':
        return (
          <LanImportProgressFooter
            isPreparingCloseFlush={isPreparingCloseFlush}
            onCancel={() => void cancelLanImportOperation()}
          />
        );
      case 'results':
        return (
          activeReport && (
            <LanImportResultsFooter
              report={activeReport}
              lastSubmittedDecisions={lastSubmittedDecisions}
              isBusy={isBusyTransfer || isDisconnecting}
              onRetryFailed={(retryDecisions) =>
                void runImportBatch(retryDecisions, { resetPrevious: false, mode: 'batch' })
              }
              onBackToCatalog={handleBackToCatalog}
              onReconnect={handleResultsReconnect}
              onDone={handleDone}
            />
          )
        );
    }
  })();

  return (
    <LanSyncDialog
      open
      title="Import from Another Device"
      description={stepDescription}
      testId="lan-import-dialog"
      size="lg"
      dismissible={!isBusyTransfer && !isDisconnecting}
      dismissBlockedHint={
        isDisconnecting
          ? 'Disconnecting from source device…'
          : 'Cancel the active transfer before closing.'
      }
      {...(effectiveStep === 'connect' ? { initialFocusRef: addressInputRef } : {})}
      onClose={handleClose}
      footer={footer}
    >
      {effectiveStep === 'connect' && (
        <LanImportConnectStep controller={connectController} addressInputRef={addressInputRef} />
      )}
      {effectiveStep === 'disconnecting' && (
        <div
          role="status"
          data-testid="lan-import-disconnecting"
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-foreground"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>Disconnecting…</span>
        </div>
      )}
      {effectiveStep === 'catalog' && (
        <LanImportCatalogStep
          selectedBookIds={selectedBookIds}
          onToggleBook={handleToggleCatalogBook}
          onSelectAllEligible={handleSelectAllEligible}
          onClearSelection={handleClearCatalogSelection}
          onDisconnect={handleInDialogDisconnect}
        />
      )}
      {effectiveStep === 'preview' && lanImport.plan && (
        <LanImportPreviewStep
          plan={lanImport.plan}
          decisionsMap={effectiveDecisionsMap}
          isPreparingCloseFlush={isPreparingCloseFlush}
          onUpdateDecision={handleUpdateDecision}
        />
      )}
      {effectiveStep === 'importing' && (
        <LanImportProgressStep isPreparingCloseFlush={isPreparingCloseFlush} />
      )}
      {effectiveStep === 'results' && activeReport && (
        <LanImportResultsStep
          report={activeReport}
          plan={lanImport.plan}
          isBusy={isBusyTransfer}
          onResolveConflict={(bookId) =>
            void runImportBatch([buildConflictOverrideDecision(bookId)], {
              resetPrevious: false,
              mode: 'conflictOverride',
            })
          }
          onContinueReading={handleContinueReading}
        />
      )}
    </LanSyncDialog>
  );
}
