import { Check, Copy, RefreshCw, ShieldAlert, Wifi } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LanSyncDialog } from '@/features/lanSync/LanSyncDialog';
import {
  describeLanError,
  describeShareStopReason,
  formatCountdown,
} from '@/features/lanSync/lanSyncCopy';
import { documentFormatLabel } from '@/lib/documentFormats';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const ACTIVE_SHARE_POLL_MS = 2000;
const COUNTDOWN_TICK_MS = 1000;

export function LanShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <LanShareDialogBody onClose={onClose} />;
}

function LanShareDialogBody({ onClose }: { onClose: () => void }) {
  const documents = useStudySyncStore((state) => state.documents);
  const lanShare = useStudySyncStore((state) => state.lanShare);
  const loadLanInterfaces = useStudySyncStore((state) => state.loadLanInterfaces);
  const startLanShare = useStudySyncStore((state) => state.startLanShare);
  const refreshLanShareStatus = useStudySyncStore((state) => state.refreshLanShareStatus);
  const regenerateLanShareCode = useStudySyncStore((state) => state.regenerateLanShareCode);
  const stopLanShare = useStudySyncStore((state) => state.stopLanShare);
  const disconnectLanSharePeer = useStudySyncStore((state) => state.disconnectLanSharePeer);
  const clearLanShareError = useStudySyncStore((state) => state.clearLanShareError);

  const [scopeMode, setScopeMode] = useState<'all' | 'selected'>('all');
  const [selectedBookIds, setSelectedBookIds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [includePositions, setIncludePositions] = useState(true);
  const [includeBookmarks, setIncludeBookmarks] = useState(true);
  const [preferredInterfaceIp, setPreferredInterfaceIp] = useState<string>('');
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const addressRef = useRef<HTMLSpanElement>(null);
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined);

  const { snapshot, interfaces, loading, error } = lanShare;
  const isActive = snapshot.status.state !== 'off';
  const codeExpiresAtMs = snapshot.codeExpiresAtMs;

  useEffect(() => {
    void refreshLanShareStatus();
    return () => {
      window.clearTimeout(copyFeedbackTimerRef.current);
    };
  }, [refreshLanShareStatus]);

  useEffect(() => {
    if (!isActive) {
      void loadLanInterfaces();
    }
  }, [isActive, loadLanInterfaces]);

  useEffect(() => {
    if (!isActive) return;
    const poll = window.setInterval(() => {
      void refreshLanShareStatus();
    }, ACTIVE_SHARE_POLL_MS);
    return () => window.clearInterval(poll);
  }, [isActive, refreshLanShareStatus]);

  useEffect(() => {
    if (!isActive || codeExpiresAtMs === null) return;
    const tick = window.setInterval(() => {
      setNowMs(Date.now());
    }, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(tick);
  }, [isActive, codeExpiresAtMs]);

  const effectiveSelectedInterfaceIp = useMemo(() => {
    if (
      preferredInterfaceIp.length > 0 &&
      interfaces.some((iface) => iface.subnet.ip === preferredInterfaceIp)
    ) {
      return preferredInterfaceIp;
    }
    return interfaces[0]?.subnet.ip ?? '';
  }, [interfaces, preferredInterfaceIp]);

  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return documents;
    return documents.filter(
      (doc) =>
        doc.title.toLowerCase().includes(query) ||
        documentFormatLabel(doc).toLowerCase().includes(query),
    );
  }, [documents, searchQuery]);

  const validSelectedIds = useMemo(() => {
    const valid = new Set(documents.map((doc) => doc.id));
    return [...selectedBookIds].filter((id) => valid.has(id));
  }, [documents, selectedBookIds]);

  const targetDocumentIds = useMemo(
    () => (scopeMode === 'all' ? documents.map((doc) => doc.id) : validSelectedIds),
    [documents, scopeMode, validSelectedIds],
  );

  const toggleBookSelection = (documentId: string) => {
    setSelectedBookIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };

  const handleStart = async () => {
    clearLanShareError();
    await startLanShare({
      documentIds: targetDocumentIds,
      positions: includePositions,
      bookmarks: includeBookmarks,
      ...(effectiveSelectedInterfaceIp.length > 0
        ? { interfaceIp: effectiveSelectedInterfaceIp }
        : {}),
    });
  };

  const handleCopyAddress = async () => {
    if (!snapshot.address) return;
    const selectAddressNode = () => {
      const node = addressRef.current;
      if (!node || typeof window.getSelection !== 'function') return;
      const selection = window.getSelection();
      if (!selection) return;
      const range = window.document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    window.clearTimeout(copyFeedbackTimerRef.current);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(snapshot.address);
        setCopyFeedback('copied');
      } else {
        selectAddressNode();
        setCopyFeedback('fallback');
      }
    } catch {
      selectAddressNode();
      setCopyFeedback('fallback');
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback('idle');
    }, 2500);
  };

  const statusBadge = (() => {
    switch (snapshot.status.state) {
      case 'listening':
        return (
          <span
            data-testid="lan-share-status-badge"
            data-share-state="listening"
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:text-emerald-100"
          >
            Listening
          </span>
        );
      case 'codeLocked':
        return (
          <span
            data-testid="lan-share-status-badge"
            data-share-state="codeLocked"
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-100"
          >
            Code locked
          </span>
        );
      case 'paired':
        return (
          <span
            data-testid="lan-share-status-badge"
            data-share-state="paired"
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:text-emerald-100"
          >
            Connected
          </span>
        );
      case 'off':
        return null;
    }
  })();

  const errorPresentation = error ? describeLanError(error) : null;
  const stopSummary =
    !isActive && snapshot.lastStopReason !== null
      ? describeShareStopReason(snapshot.lastStopReason, snapshot.lastStopErrorCode)
      : null;

  const canStart =
    !loading &&
    documents.length > 0 &&
    targetDocumentIds.length > 0 &&
    interfaces.length > 0 &&
    effectiveSelectedInterfaceIp.length > 0;

  return (
    <LanSyncDialog
      open
      title="Share Books on This Network"
      description={
        isActive
          ? 'Enter this address and 6-digit code on another device to copy books from this library.'
          : 'Start a temporary session so another SynapseRead device on your local network can copy books.'
      }
      headerExtra={statusBadge}
      onClose={onClose}
      dismissible
      testId="lan-share-dialog"
      footer={
        isActive ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {snapshot.status.state === 'paired' && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="lan-share-disconnect-peer"
                  disabled={loading}
                  onClick={() => void disconnectLanSharePeer()}
                >
                  Disconnect receiver
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                data-testid="lan-share-stop"
                disabled={loading}
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => void stopLanShare()}
              >
                Stop sharing
              </Button>
            </div>
            <Button size="sm" data-testid="lan-share-close" onClick={onClose}>
              Hide
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {documents.length === 0
                ? 'Open a book first to add it to your library.'
                : `${targetDocumentIds.length} ${targetDocumentIds.length === 1 ? 'book' : 'books'} selected`}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="lan-share-start"
                disabled={!canStart}
                onClick={() => void handleStart()}
              >
                {loading ? 'Starting…' : 'Start sharing'}
              </Button>
            </div>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm">
        {errorPresentation && (
          <div
            role="alert"
            data-testid="lan-share-error"
            className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-destructive">{errorPresentation.title}</p>
              <button
                type="button"
                className="text-muted-foreground underline hover:text-foreground"
                onClick={clearLanShareError}
              >
                Dismiss
              </button>
            </div>
            <p className="text-foreground">{errorPresentation.detail}</p>
            {errorPresentation.hints.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {errorPresentation.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {stopSummary && (
          <div
            role="status"
            data-testid="lan-share-stop-banner"
            data-stop-reason={snapshot.lastStopReason ?? undefined}
            className={
              stopSummary.tone === 'warning'
                ? 'rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-100'
                : 'rounded-md border bg-muted/40 p-3 text-xs text-foreground'
            }
          >
            <p className="font-semibold">{stopSummary.badge}</p>
            <p className="mt-0.5">{stopSummary.message}</p>
          </div>
        )}

        {!isActive ? (
          <>
            <section aria-label="Books to share" className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Books to share
              </h3>
              <div role="radiogroup" aria-label="Share scope" className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-accent/50">
                  <input
                    type="radio"
                    name="lan-share-scope"
                    data-testid="lan-share-scope-all"
                    checked={scopeMode === 'all'}
                    onChange={() => setScopeMode('all')}
                  />
                  <span className="font-medium text-foreground">
                    Entire library ({documents.length} {documents.length === 1 ? 'book' : 'books'})
                  </span>
                </label>

                <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-accent/50">
                  <input
                    type="radio"
                    name="lan-share-scope"
                    data-testid="lan-share-scope-selected"
                    checked={scopeMode === 'selected'}
                    onChange={() => setScopeMode('selected')}
                  />
                  <span className="font-medium text-foreground">
                    Selected books ({validSelectedIds.length} selected)
                  </span>
                </label>
              </div>

              {scopeMode === 'selected' && (
                <div
                  data-testid="lan-share-book-picker"
                  className="space-y-2 rounded-md border bg-muted/20 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="search"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Filter books…"
                      aria-label="Filter books to share"
                      data-testid="lan-share-book-search"
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={documents.length === 0}
                      onClick={() => setSelectedBookIds(new Set(documents.map((doc) => doc.id)))}
                    >
                      Select all
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={validSelectedIds.length === 0}
                      onClick={() => setSelectedBookIds(new Set())}
                    >
                      Clear
                    </Button>
                  </div>

                  {documents.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">
                      No books in this library yet.
                    </p>
                  ) : filteredDocuments.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">
                      No books match “{searchQuery}”.
                    </p>
                  ) : (
                    <ul className="max-h-44 divide-y overflow-y-auto rounded border bg-background">
                      {filteredDocuments.map((doc) => {
                        const checked = selectedBookIds.has(doc.id);
                        return (
                          <li key={doc.id}>
                            <label className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-xs hover:bg-accent/40">
                              <span className="flex min-w-0 items-center gap-2">
                                <input
                                  type="checkbox"
                                  data-testid={`lan-share-book-checkbox-${doc.id}`}
                                  checked={checked}
                                  onChange={() => toggleBookSelection(doc.id)}
                                />
                                <span className="truncate font-medium text-foreground">
                                  {doc.title}
                                </span>
                              </span>
                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                                {documentFormatLabel(doc)}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <section aria-label="Included reading data" className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Included reading data
              </h3>
              <div className="space-y-1.5 rounded-md border p-3 text-xs">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="lan-share-perm-positions"
                    checked={includePositions}
                    onChange={(event) => setIncludePositions(event.target.checked)}
                  />
                  <span className="font-medium text-foreground">Reading positions</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="lan-share-perm-bookmarks"
                    checked={includeBookmarks}
                    onChange={(event) => setIncludeBookmarks(event.target.checked)}
                  />
                  <span className="font-medium text-foreground">Bookmarks</span>
                </label>
                <p className="pt-1 text-[11px] text-muted-foreground">
                  Highlights, notes, captures, MindMap cards, and local file paths are never shared.
                </p>
              </div>
            </section>

            <section aria-label="Local network interface" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Local network interface
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={loading}
                  onClick={() => void loadLanInterfaces()}
                >
                  <RefreshCw className="size-3.5" />
                  Refresh
                </Button>
              </div>

              {interfaces.length === 0 ? (
                <div
                  data-testid="lan-share-no-interfaces"
                  className="rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-100"
                >
                  No eligible local Wi-Fi or Ethernet interface detected. Connect to a local network
                  and click Refresh.
                </div>
              ) : interfaces.length === 1 && interfaces[0] ? (
                <div
                  data-testid="lan-share-single-interface"
                  className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs"
                >
                  <Wifi className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium text-foreground">{interfaces[0].name}</span>
                  <span className="font-mono text-muted-foreground">
                    {interfaces[0].subnet.ip}/{interfaces[0].subnet.prefixLen}
                  </span>
                </div>
              ) : (
                <select
                  aria-label="Local network interface"
                  data-testid="lan-share-interface-select"
                  value={effectiveSelectedInterfaceIp}
                  onChange={(event) => setPreferredInterfaceIp(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.subnet.ip}`} value={iface.subnet.ip}>
                      {iface.name} — {iface.subnet.ip}/{iface.subnet.prefixLen}
                    </option>
                  ))}
                </select>
              )}
            </section>

            <div
              data-testid="lan-share-plaintext-notice"
              className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-xs text-foreground"
            >
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
              <div>
                <p className="font-medium">
                  Use only on networks you trust. Transfers are not encrypted.
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Before opening the network listener, your system will ask you to confirm sharing.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <section
              aria-label="Connection details"
              className="space-y-3 rounded-md border bg-muted/20 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-muted-foreground">Address</p>
                  <span
                    ref={addressRef}
                    data-testid="lan-share-address"
                    className="inline-block select-all font-mono text-base font-semibold text-foreground"
                  >
                    {snapshot.address ?? '—'}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="lan-share-copy-address"
                  disabled={!snapshot.address}
                  onClick={() => void handleCopyAddress()}
                >
                  {copyFeedback === 'copied' ? (
                    <>
                      <Check className="size-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5" />
                      Copy address
                    </>
                  )}
                </Button>
              </div>
              <p className="sr-only" aria-live="polite">
                {copyFeedback === 'copied'
                  ? 'Address copied to clipboard.'
                  : copyFeedback === 'fallback'
                    ? 'Address selected for manual copy.'
                    : ''}
              </p>
              {copyFeedback === 'fallback' && (
                <p className="text-[11px] text-muted-foreground">
                  Address selected — press Copy to copy it manually.
                </p>
              )}

              {snapshot.status.state === 'listening' && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-muted-foreground">Pairing code</p>
                    <div className="flex items-baseline gap-3">
                      <span
                        data-testid="lan-share-code"
                        className="select-all font-mono text-2xl font-bold tracking-[0.2em] text-foreground"
                      >
                        {snapshot.pairingCode ?? '------'}
                      </span>
                      {snapshot.codeExpiresAtMs !== null && (
                        <span
                          data-testid="lan-share-countdown"
                          className="text-xs tabular-nums text-muted-foreground"
                        >
                          Expires in {formatCountdown(snapshot.codeExpiresAtMs - nowMs)}
                        </span>
                      )}
                    </div>
                    {snapshot.status.failedAttempts > 0 && (
                      <p
                        data-testid="lan-share-failed-attempts"
                        className="text-xs text-amber-800 dark:text-amber-200"
                      >
                        {snapshot.status.failedAttempts} of {snapshot.status.maxFailedAttempts}{' '}
                        incorrect attempts used
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="lan-share-regenerate-code"
                    disabled={loading}
                    onClick={() => void regenerateLanShareCode()}
                  >
                    <RefreshCw className="size-3.5" />
                    Regenerate code
                  </Button>
                </div>
              )}

              {snapshot.status.state === 'codeLocked' && (
                <div
                  role="alert"
                  data-testid="lan-share-code-locked"
                  className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
                      Code locked after 5 failed attempts
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Generate a new 6-digit code to allow a device to pair.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    data-testid="lan-share-regenerate-code"
                    disabled={loading}
                    onClick={() => void regenerateLanShareCode()}
                  >
                    <RefreshCw className="size-3.5" />
                    Regenerate code
                  </Button>
                </div>
              )}

              {snapshot.status.state === 'paired' && (
                <div
                  data-testid="lan-share-paired-peer"
                  className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs"
                >
                  <div>
                    <p className="font-medium text-muted-foreground">Connected receiver</p>
                    <p
                      data-testid="lan-share-peer-ip"
                      className="font-mono text-sm font-semibold text-foreground"
                    >
                      {snapshot.status.peerIp}
                    </p>
                  </div>
                  <span className="text-muted-foreground">Session expires after 10 min idle</span>
                </div>
              )}
            </section>

            <section
              aria-label="Session scope"
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="rounded bg-muted px-2 py-0.5 font-medium text-foreground">
                {snapshot.sharedBookCount} {snapshot.sharedBookCount === 1 ? 'book' : 'books'}
              </span>
              {snapshot.interfaceName && (
                <span className="rounded bg-muted px-2 py-0.5">{snapshot.interfaceName}</span>
              )}
              {snapshot.permissions && (
                <>
                  <span className="rounded bg-muted px-2 py-0.5">
                    Positions: {snapshot.permissions.positions ? 'Included' : 'Off'}
                  </span>
                  <span className="rounded bg-muted px-2 py-0.5">
                    Bookmarks: {snapshot.permissions.bookmarks ? 'Included' : 'Off'}
                  </span>
                </>
              )}
            </section>

            {snapshot.blockedPeerCount > 0 && (
              <div
                role="status"
                data-testid="lan-share-blocked-peer-notice"
                className="rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-100"
              >
                <p className="font-semibold">
                  Blocked {snapshot.blockedPeerCount} out-of-subnet connection{' '}
                  {snapshot.blockedPeerCount === 1 ? 'attempt' : 'attempts'}
                  {snapshot.lastBlockedPeerIp ? ` (latest: ${snapshot.lastBlockedPeerIp})` : ''}
                </p>
                <p className="mt-0.5">
                  Only devices on the same local Wi-Fi or Ethernet subnet can connect. Check that
                  the other device is not on a VPN, separate VLAN, or guest network.
                </p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Use only on networks you trust. Transfers are not encrypted. Closing this window keeps
              sharing active in the toolbar.
            </p>
          </>
        )}
      </div>
    </LanSyncDialog>
  );
}
