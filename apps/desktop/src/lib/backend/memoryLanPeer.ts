import {
  type AnchorLocation,
  type BookImportDecision,
  type BookPlanSummary,
  type BookSyncState,
  type Bookmark,
  type BookmarkPlanSkipReason,
  type CatalogBookClassification,
  type DocumentFormat,
  INITIAL_LAN_SHARE_SNAPSHOT,
  type IpcError,
  type LanBookImportResult,
  type LanComponentOutcome,
  type LanImportConnectInput,
  type LanImportExecuteInput,
  type LanImportExecutionReport,
  type LanImportPlanInput,
  type LanImportPlanResult,
  type LanImportProgress,
  type LanImportSessionInfo,
  type LanInterface,
  type LanShareEventPayload,
  type LanShareSnapshot,
  type LanShareStartInput,
  type ListenerStopReason,
  type PeerRejectReason,
  type PlanProgress,
  type PlannedBookmarkPreview,
  type SharePermissions,
  type StudyDocument,
  bookmarkLocationKey,
  defaultBookmarkLabel,
} from '@/types/domain';
import type { MemoryFile } from '@/lib/backend/memoryBackend';

export interface MemoryLanPeerBookmark {
  anchor: AnchorLocation | null;
  label: string | null;
  createdAt?: string | null;
  skipReason?: BookmarkPlanSkipReason;
}

export interface MemoryLanPeerBook {
  /** Content hash (e.g. `memory:...` or 64-char hex). Defaults to `hashBytes(bytes)`. */
  bookId?: string;
  title: string;
  format: DocumentFormat | null;
  rawFormat?: string;
  extension: string;
  bytes?: Uint8Array;
  fileAvailable?: boolean;
  position?: { anchor: AnchorLocation; progress: number | null } | null;
  bookmarks?: MemoryLanPeerBookmark[];
  /** Optional synthetic error injected when executing file transfer for this book. */
  fileError?: IpcError;
}

export interface MemoryLanPeerOptions {
  interfaces?: LanInterface[];
  /** Set `false` to simulate declining the native OS share confirmation dialog. */
  confirmShare?: boolean;
  /** Expected pairing code for `lanImportConnect` (default `"123456"`). */
  pairingCode?: string;
  /** Permissions advertised by the fake peer (default both `true`). */
  permissions?: SharePermissions;
  /** Custom remote catalog; when omitted, uses a built-in deterministic catalog. */
  books?: MemoryLanPeerBook[];
  /** Optional one-shot or persistent errors keyed by command name. */
  errors?: Partial<
    Record<
      | 'lanListInterfaces'
      | 'lanShareStart'
      | 'lanImportConnect'
      | 'lanImportCatalog'
      | 'lanImportPlan'
      | 'lanImportExecute',
      IpcError
    >
  >;
  /** Optional async hook called before each book in plan/execute/commit (for deterministic cancellation tests). */
  onBeforeBookStep?: (phase: 'plan' | 'execute' | 'commit', bookId: string) => Promise<void>;
}

export interface MemoryLanHostContext {
  files: Record<string, MemoryFile>;
  documents: Map<string, StudyDocument>;
  bookmarks: Map<string, Bookmark>;
  hashBytes: (bytes: Uint8Array) => string;
  readFile: (path: string) => Promise<Uint8Array>;
  monotonicNow: () => string;
  fail: (code: string, message: string) => IpcError;
}

export type MemoryLanCommandName =
  | 'lanListInterfaces'
  | 'lanShareStart'
  | 'lanImportConnect'
  | 'lanImportCatalog'
  | 'lanImportPlan'
  | 'lanImportExecute';

export type MemoryLanStepPhase = 'plan' | 'execute' | 'commit';

export interface MemoryLanPeerStats {
  connectCount: number;
  catalogCount: number;
  planCount: number;
  executeCount: number;
  cancelCount: number;
  disconnectCount: number;
  lastRequestedDecisions: BookImportDecision[];
}

export interface MemoryLanTestController {
  setInterfaces(nextInterfaces: LanInterface[]): void;
  setBooks(books: MemoryLanPeerBook[] | null): void;
  setPermissions(permissions: SharePermissions): void;
  setNextError(command: MemoryLanCommandName, error: IpcError): void;
  setPersistentError(command: MemoryLanCommandName, error: IpcError | null): void;
  simulateSharePaired(peerIp?: string): LanShareSnapshot;
  simulateShareCodeLocked(): LanShareSnapshot;
  simulateSharePeerBlocked(peerIp: string, reason?: PeerRejectReason): LanShareSnapshot;
  simulateShareStopped(reason: ListenerStopReason, errorCode?: string | null): LanShareSnapshot;
  pauseNextTransfer(phase?: MemoryLanStepPhase): void;
  releasePausedTransfer(): void;
  mutateLocalFile(documentId: string, bytes: Uint8Array): void;
  mutateLocalCursor(
    documentId: string,
    anchor: AnchorLocation | null,
    progress: number | null,
  ): void;
  listLocalDocuments(): StudyDocument[];
  getPeerStats(): MemoryLanPeerStats;
}

const DEFAULT_INTERFACES: LanInterface[] = [
  {
    name: 'en0',
    subnet: { ip: '192.168.1.42', netmask: '255.255.255.0', prefixLen: 24 },
  },
];

const DEFAULT_PAIRING_CODE = '123456';
const DEFAULT_PORT = 49319;
const MAX_FAILED_ATTEMPTS = 5;
const SHARE_CODES = ['482913', '739104', '615287', '904321'] as const;

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function isPrivateOrLinkLocalIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function parsePrivateLanAddress(raw: string): string | null {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(':');
  const host = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  const portStr = colonIdx === -1 ? String(DEFAULT_PORT) : trimmed.slice(colonIdx + 1);
  if (!isPrivateOrLinkLocalIpv4(host)) return null;
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${host}:${port}`;
}

function anchorsEqual(a: AnchorLocation | null, b: AnchorLocation | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function cursorsEqual(
  a: { anchor: AnchorLocation | null; progress: number | null },
  b: { anchor: AnchorLocation | null; progress: number | null },
): boolean {
  return anchorsEqual(a.anchor, b.anchor) && a.progress === b.progress;
}

function buildDefaultPeerBooks(hashBytes: (bytes: Uint8Array) => string): MemoryLanPeerBook[] {
  const novelBytes = encodeUtf8(
    'Chapter 1\n\nIt was a bright cold day in April, and the clocks were striking thirteen.\n',
  );
  const markdownBytes = encodeUtf8('# Shared Reading Notes\n\nSynced over local network.\n');
  const altVersionBytes = encodeUtf8('Alternate edition text content for same-title matching.\n');
  return [
    {
      bookId: hashBytes(novelBytes),
      title: 'Remote Novel',
      format: 'txt',
      extension: 'txt',
      bytes: novelBytes,
      fileAvailable: true,
      position: {
        anchor: { format: 'txt', startByteOffset: 11, endByteOffset: 24, lineIndex: 2 },
        progress: 0.25,
      },
      bookmarks: [
        {
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 9, lineIndex: 0 },
          label: 'Chapter 1',
          createdAt: '2026-11-18T10:00:00.000Z',
        },
        {
          anchor: null,
          label: 'Unsupported future anchor',
          skipReason: { kind: 'unsupportedAnchor', reason: 'unrecognized anchor format' },
        },
      ],
    },
    {
      bookId: hashBytes(markdownBytes),
      title: 'Shared Reading Notes',
      format: 'txt',
      extension: 'md',
      bytes: markdownBytes,
      fileAvailable: true,
      position: null,
      bookmarks: [],
    },
    {
      bookId: hashBytes(altVersionBytes),
      title: 'sample',
      format: 'txt',
      extension: 'txt',
      bytes: altVersionBytes,
      fileAvailable: true,
      position: null,
      bookmarks: [],
    },
    {
      bookId: 'b'.repeat(64),
      title: 'Offline Archive',
      format: 'txt',
      extension: 'txt',
      fileAvailable: false,
    },
    {
      bookId: 'c'.repeat(64),
      title: 'Unsupported Format Book',
      format: null,
      rawFormat: 'djvu',
      extension: 'djvu',
      fileAvailable: true,
    },
  ];
}

interface ResolvedPeerBook {
  bookId: string;
  title: string;
  format: DocumentFormat | null;
  rawFormat: string;
  extension: string;
  bytes: Uint8Array | null;
  sizeBytes: number;
  fileAvailable: boolean;
  position: { anchor: AnchorLocation; progress: number | null } | null;
  bookmarks: MemoryLanPeerBookmark[];
  fileError?: IpcError;
}

interface InternalCursorSnapshot {
  anchor: AnchorLocation | null;
  progress: number | null;
}

interface InternalPlannedBook {
  peer: ResolvedPeerBook;
  summary: BookPlanSummary;
  expectedCursor: InternalCursorSnapshot;
  conflictCursor: InternalCursorSnapshot | null;
  /** Plan-approved remote position (`null` when `positions` permission is off or ineligible). */
  plannedPosition: { anchor: AnchorLocation; progress: number | null } | null;
  importableBookmarks: Map<number, MemoryLanPeerBookmark>;
}

interface InternalPlan {
  books: InternalPlannedBook[];
}

interface InternalReceiverSession {
  address: string;
  permissions: SharePermissions;
  catalog: ResolvedPeerBook[];
  plans: Map<string, InternalPlan>;
  executingPlans: Set<string>;
}

export function createMemoryLanAdapterWithController(
  host: MemoryLanHostContext,
  options: MemoryLanPeerOptions = {},
) {
  return createMemoryLanAdapterInner(host, options);
}

export function createMemoryLanAdapter(
  host: MemoryLanHostContext,
  options: MemoryLanPeerOptions = {},
) {
  return createMemoryLanAdapterInner(host, options).adapter;
}

function createMemoryLanAdapterInner(
  host: MemoryLanHostContext,
  options: MemoryLanPeerOptions = {},
) {
  let interfaces = options.interfaces ? [...options.interfaces] : [...DEFAULT_INTERFACES];
  const confirmShare = options.confirmShare ?? true;
  const expectedCode = options.pairingCode ?? DEFAULT_PAIRING_CODE;
  let peerPermissions: SharePermissions = options.permissions
    ? { ...options.permissions }
    : { positions: true, bookmarks: true };
  let customBooks: MemoryLanPeerBook[] | null = options.books ?? null;
  const persistentErrors: Partial<Record<MemoryLanCommandName, IpcError>> = { ...options.errors };
  const nextErrors: Partial<Record<MemoryLanCommandName, IpcError>> = {};

  let pausedPhaseTarget: MemoryLanStepPhase | null = null;
  let pausedTransferWaiter: (() => void) | null = null;

  const stats: MemoryLanPeerStats = {
    connectCount: 0,
    catalogCount: 0,
    planCount: 0,
    executeCount: 0,
    cancelCount: 0,
    disconnectCount: 0,
    lastRequestedDecisions: [],
  };

  let shareSnapshot: LanShareSnapshot = { ...INITIAL_LAN_SHARE_SNAPSHOT };
  let shareCodeIndex = 0;
  const shareListeners = new Set<(payload: LanShareEventPayload) => void>();

  let failedPairAttempts = 0;
  const sessions = new Map<string, InternalReceiverSession>();
  const activeOps = new Map<string, { sessionId: string | null; cancelled: boolean }>();

  const emitShareEvent = (payload: LanShareEventPayload) => {
    for (const listener of shareListeners) {
      listener(payload);
    }
  };

  const takeCommandError = (command: MemoryLanCommandName): IpcError | null => {
    const once = nextErrors[command];
    if (once !== undefined) {
      delete nextErrors[command];
      return once;
    }
    return persistentErrors[command] ?? null;
  };

  const maybePauseOrHook = async (phase: MemoryLanStepPhase, bookId: string): Promise<void> => {
    if (options.onBeforeBookStep) {
      await options.onBeforeBookStep(phase, bookId);
    }
    if (pausedPhaseTarget === phase) {
      pausedPhaseTarget = null;
      await new Promise<void>((resolve) => {
        pausedTransferWaiter = () => {
          pausedTransferWaiter = null;
          resolve();
        };
      });
    }
  };

  const resolvePeerBooks = (): ResolvedPeerBook[] => {
    const raw = customBooks ?? buildDefaultPeerBooks(host.hashBytes);
    return raw.map((book) => {
      const bytes = book.bytes ?? null;
      const bookId = book.bookId ?? (bytes ? host.hashBytes(bytes) : '0'.repeat(64));
      const resolved: ResolvedPeerBook = {
        bookId,
        title: book.title,
        format: book.format,
        rawFormat: book.rawFormat ?? book.format ?? 'unknown',
        extension: book.extension,
        bytes,
        sizeBytes: bytes?.byteLength ?? 0,
        fileAvailable: book.fileAvailable ?? bytes !== null,
        position: book.position ?? null,
        bookmarks: book.bookmarks ?? [],
      };
      if (book.fileError !== undefined) {
        resolved.fileError = book.fileError;
      }
      return resolved;
    });
  };

  const classifyBook = async (
    peer: ResolvedPeerBook,
    verifyHash: boolean,
  ): Promise<{
    state: BookSyncState;
    localDoc: StudyDocument | null;
  }> => {
    if (peer.format === null || peer.format === 'md') {
      return { state: 'formatMismatch', localDoc: null };
    }
    const localByHash =
      [...host.documents.values()].find((doc) => doc.fileHash === peer.bookId) ?? null;

    if (localByHash) {
      if (localByHash.format !== peer.format) {
        return { state: 'formatMismatch', localDoc: localByHash };
      }
      if (!(localByHash.filePath in host.files)) {
        return {
          state: peer.fileAvailable ? 'missingFile' : 'sourceUnavailable',
          localDoc: localByHash,
        };
      }
      try {
        const localBytes = await host.readFile(localByHash.filePath);
        if (verifyHash && host.hashBytes(localBytes) !== localByHash.fileHash) {
          return { state: 'localFileChanged', localDoc: localByHash };
        }
      } catch {
        return {
          state: peer.fileAvailable ? 'missingFile' : 'sourceUnavailable',
          localDoc: localByHash,
        };
      }
      return { state: 'alreadyPresent', localDoc: localByHash };
    }

    if (!peer.fileAvailable) {
      return { state: 'sourceUnavailable', localDoc: null };
    }

    const normalizedTitle = peer.title.trim().toLowerCase();
    const sameTitle = [...host.documents.values()].find(
      (doc) => doc.title.trim().toLowerCase() === normalizedTitle,
    );
    if (sameTitle) {
      return { state: 'sameTitleDifferentVersion', localDoc: null };
    }
    return { state: 'new', localDoc: null };
  };

  const isEligible = (state: BookSyncState): boolean =>
    state === 'new' ||
    state === 'alreadyPresent' ||
    state === 'missingFile' ||
    state === 'sameTitleDifferentVersion';

  const needsFileDownload = (state: BookSyncState): boolean =>
    state === 'new' || state === 'missingFile' || state === 'sameTitleDifferentVersion';

  const registerOp = (
    operationId?: string | null,
    sessionId: string | null = null,
  ): { key: string; state: { sessionId: string | null; cancelled: boolean } } => {
    const key = operationId && operationId.trim().length > 0 ? operationId : crypto.randomUUID();
    const prev = activeOps.get(key);
    if (prev) prev.cancelled = true;
    const state = { sessionId, cancelled: false };
    activeOps.set(key, state);
    return { key, state };
  };

  const adapter = {
    async lanListInterfaces(): Promise<LanInterface[]> {
      const err = takeCommandError('lanListInterfaces');
      if (err) throw err;
      return interfaces.map((iface) => ({ ...iface, subnet: { ...iface.subnet } }));
    },

    async lanShareStart(input: LanShareStartInput): Promise<LanShareSnapshot | null> {
      const err = takeCommandError('lanShareStart');
      if (err) throw err;
      if (input.documentIds.length === 0) {
        throw host.fail('lan_scope_denied', 'select at least one book to share');
      }
      if (shareSnapshot.status.state !== 'off') {
        throw host.fail('lan_session_busy', 'sharing is already active');
      }
      for (const id of input.documentIds) {
        if (!host.documents.has(id)) {
          throw host.fail('not_found', `document ${id} not found`);
        }
      }
      const selected = input.interfaceIp
        ? interfaces.find((iface) => iface.subnet.ip === input.interfaceIp)
        : interfaces[0];
      if (!selected) {
        throw host.fail('lan_address_unavailable', 'no eligible local network interface found');
      }
      if (!confirmShare) return null;

      const code = SHARE_CODES[shareCodeIndex % SHARE_CODES.length] ?? '482913';
      shareCodeIndex += 1;
      shareSnapshot = {
        status: { state: 'listening', failedAttempts: 0, maxFailedAttempts: MAX_FAILED_ATTEMPTS },
        address: `${selected.subnet.ip}:${DEFAULT_PORT}`,
        interfaceName: selected.name,
        pairingCode: code,
        codeExpiresAtMs: Date.now() + 10 * 60 * 1000,
        permissions: { positions: input.positions, bookmarks: input.bookmarks },
        sharedBookCount: new Set(input.documentIds).size,
        blockedPeerCount: 0,
        lastBlockedPeerIp: null,
        lastStopReason: null,
        lastStopErrorCode: null,
      };
      return { ...shareSnapshot };
    },

    async lanShareStatus(): Promise<LanShareSnapshot> {
      return { ...shareSnapshot };
    },

    async lanShareRegenerateCode(): Promise<LanShareSnapshot> {
      if (
        shareSnapshot.status.state !== 'listening' &&
        shareSnapshot.status.state !== 'codeLocked'
      ) {
        throw host.fail('lan_auth_expired', 'no active unpaired sharing session');
      }
      const nextCode = SHARE_CODES[shareCodeIndex % SHARE_CODES.length] ?? '739104';
      shareCodeIndex += 1;
      shareSnapshot = {
        ...shareSnapshot,
        status: { state: 'listening', failedAttempts: 0, maxFailedAttempts: MAX_FAILED_ATTEMPTS },
        pairingCode: nextCode,
        codeExpiresAtMs: Date.now() + 10 * 60 * 1000,
      };
      return { ...shareSnapshot };
    },

    async lanShareStop(): Promise<LanShareSnapshot> {
      const wasActive = shareSnapshot.status.state !== 'off';
      shareSnapshot = {
        ...INITIAL_LAN_SHARE_SNAPSHOT,
        lastStopReason: wasActive ? 'stoppedByUser' : shareSnapshot.lastStopReason,
      };
      if (wasActive) {
        emitShareEvent({
          event: { kind: 'stopped', reason: 'stoppedByUser', errorCode: null },
          snapshot: { ...shareSnapshot },
        });
      }
      return { ...shareSnapshot };
    },

    async lanShareDisconnectPeer(): Promise<LanShareSnapshot> {
      const wasActive = shareSnapshot.status.state !== 'off';
      shareSnapshot = {
        ...INITIAL_LAN_SHARE_SNAPSHOT,
        lastStopReason: wasActive ? 'stoppedByUser' : shareSnapshot.lastStopReason,
      };
      if (wasActive) {
        emitShareEvent({
          event: { kind: 'stopped', reason: 'stoppedByUser', errorCode: null },
          snapshot: { ...shareSnapshot },
        });
      }
      return { ...shareSnapshot };
    },

    onLanShareEvent(listener: (payload: LanShareEventPayload) => void): () => void {
      shareListeners.add(listener);
      return () => {
        shareListeners.delete(listener);
      };
    },

    async lanImportConnect(input: LanImportConnectInput): Promise<LanImportSessionInfo> {
      stats.connectCount += 1;
      const err = takeCommandError('lanImportConnect');
      if (err) throw err;
      if (!/^\d{6}$/.test(input.code)) {
        throw host.fail('lan_auth_invalid', 'pairing code must be exactly 6 digits');
      }
      const normalized = parsePrivateLanAddress(input.address);
      if (!normalized) {
        throw host.fail('lan_address_invalid', `invalid LAN address: ${input.address}`);
      }
      const op = registerOp(input.operationId, null);
      try {
        if (op.state.cancelled) throw host.fail('lan_cancelled', 'LAN operation cancelled');
        if (failedPairAttempts >= MAX_FAILED_ATTEMPTS) {
          throw host.fail('lan_attempts_exceeded', 'pairing attempt limit exceeded');
        }
        if (input.code !== expectedCode) {
          failedPairAttempts += 1;
          if (failedPairAttempts >= MAX_FAILED_ATTEMPTS) {
            throw host.fail('lan_attempts_exceeded', 'pairing attempt limit exceeded');
          }
          throw host.fail('lan_auth_invalid', 'invalid pairing code');
        }
        failedPairAttempts = 0;
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
          address: normalized,
          permissions: { ...peerPermissions },
          catalog: [],
          plans: new Map(),
          executingPlans: new Set(),
        });
        return {
          sessionId,
          address: normalized,
          idleTimeoutSeconds: 600,
          permissions: { ...peerPermissions },
        };
      } finally {
        activeOps.delete(op.key);
      }
    },

    async lanImportCatalog(sessionId: string): Promise<CatalogBookClassification[]> {
      stats.catalogCount += 1;
      const err = takeCommandError('lanImportCatalog');
      if (err) throw err;
      const session = sessions.get(sessionId);
      if (!session) throw host.fail('lan_auth_expired', 'receiver session expired');
      const peerBooks = resolvePeerBooks();
      session.catalog = peerBooks;

      const results: CatalogBookClassification[] = [];
      for (const peer of peerBooks) {
        // Catalog uses cheap stat-only classification (`F-19`: verifyHash = false).
        const { state, localDoc } = await classifyBook(peer, false);
        results.push({
          bookId: peer.bookId,
          title: peer.title,
          format: peer.format,
          rawFormat: peer.rawFormat,
          extension: peer.extension,
          sizeBytes: peer.sizeBytes,
          fileAvailable: peer.fileAvailable,
          hasPosition: session.permissions.positions ? peer.position !== null : null,
          bookmarkCount: session.permissions.bookmarks ? peer.bookmarks.length : null,
          state,
          eligible: isEligible(state),
          needsFileDownload: needsFileDownload(state),
          localDocumentId: localDoc?.id ?? null,
          localTitle: localDoc?.title ?? null,
        });
      }
      return results;
    },

    async lanImportPlan(
      input: LanImportPlanInput,
      onProgress: (progress: PlanProgress) => void,
    ): Promise<LanImportPlanResult> {
      stats.planCount += 1;
      const err = takeCommandError('lanImportPlan');
      if (err) throw err;
      const session = sessions.get(input.sessionId);
      if (!session) throw host.fail('lan_auth_expired', 'receiver session expired');
      const op = registerOp(input.operationId, input.sessionId);

      try {
        const seen = new Set<string>();
        const selected = input.bookIds
          .filter((id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .map((id) => session.catalog.find((b) => b.bookId === id))
          .filter((b): b is ResolvedPeerBook => b !== undefined);

        const plannedBooks: InternalPlannedBook[] = [];
        for (let idx = 0; idx < selected.length; idx += 1) {
          const peer = selected[idx];
          if (!peer) continue;
          await maybePauseOrHook('plan', peer.bookId);
          if (op.state.cancelled) {
            throw host.fail('lan_cancelled', 'LAN operation cancelled');
          }

          // Planner verifies selected alreadyPresent files for localFileChanged (`F-19`).
          const { state, localDoc } = await classifyBook(peer, true);
          const eligible = isEligible(state);
          const needsDownload = needsFileDownload(state);

          const expectedCursor: InternalCursorSnapshot = {
            anchor: localDoc?.lastCursorAnchor ?? null,
            progress: localDoc?.lastProgress ?? null,
          };

          const remotePos = session.permissions.positions && eligible ? peer.position : null;
          const localHasPos = expectedCursor.anchor !== null;
          const differs =
            remotePos !== null &&
            !cursorsEqual(expectedCursor, {
              anchor: remotePos.anchor,
              progress: remotePos.progress,
            });
          const defaultAdopt = remotePos !== null && (!localHasPos || state === 'new');

          const existingKeys = new Set<string>();
          if (localDoc) {
            for (const bm of host.bookmarks.values()) {
              if (bm.documentId === localDoc.id) {
                existingKeys.add(bookmarkLocationKey(bm.anchor));
              }
            }
          }

          const entries: PlannedBookmarkPreview[] = [];
          const importableBookmarks = new Map<number, MemoryLanPeerBookmark>();
          let newCount = 0;
          let existingCount = 0;
          let skippedCount = 0;

          if (session.permissions.bookmarks && eligible) {
            for (let bIdx = 0; bIdx < peer.bookmarks.length; bIdx += 1) {
              const entry = peer.bookmarks[bIdx];
              if (!entry) continue;
              if (entry.skipReason || !entry.anchor) {
                skippedCount += 1;
                entries.push({
                  index: bIdx,
                  label: entry.label,
                  createdAt: entry.createdAt ?? null,
                  status: {
                    status: 'skipped',
                    reason: entry.skipReason ?? { kind: 'invalidAnchor' },
                  },
                });
                continue;
              }
              if (peer.format && entry.anchor.format !== peer.format) {
                skippedCount += 1;
                entries.push({
                  index: bIdx,
                  label: entry.label,
                  createdAt: entry.createdAt ?? null,
                  status: { status: 'skipped', reason: { kind: 'formatMismatch' } },
                });
                continue;
              }
              const key = bookmarkLocationKey(entry.anchor);
              if (existingKeys.has(key)) {
                existingCount += 1;
                entries.push({
                  index: bIdx,
                  label: entry.label ?? defaultBookmarkLabel(entry.anchor),
                  createdAt: entry.createdAt ?? null,
                  status: { status: 'existing' },
                });
              } else {
                newCount += 1;
                importableBookmarks.set(bIdx, entry);
                entries.push({
                  index: bIdx,
                  label: entry.label ?? defaultBookmarkLabel(entry.anchor),
                  createdAt: entry.createdAt ?? null,
                  status: { status: 'new' },
                });
              }
            }
          }

          const summary: BookPlanSummary = {
            bookId: peer.bookId,
            title: peer.title,
            format: peer.format,
            extension: peer.extension,
            sizeBytes: peer.sizeBytes,
            state,
            eligible,
            needsFileDownload: needsDownload,
            localDocumentId: localDoc?.id ?? null,
            localTitle: localDoc?.title ?? null,
            position: {
              remoteAvailable: remotePos !== null,
              remoteProgress: remotePos?.progress ?? null,
              localHasPosition: localHasPos,
              localProgress: expectedCursor.progress,
              differs,
              defaultAdopt,
            },
            bookmarks: {
              newCount,
              existingCount,
              skippedCount,
              entries,
              defaultImport: eligible && newCount > 0,
            },
          };

          plannedBooks.push({
            peer,
            summary,
            expectedCursor,
            conflictCursor: null,
            plannedPosition: remotePos,
            importableBookmarks,
          });

          onProgress({
            completedBooks: idx + 1,
            totalBooks: selected.length,
            bookId: peer.bookId,
          });
        }

        const planId = crypto.randomUUID();
        session.plans.set(planId, { books: plannedBooks });

        const defaultDecisions: BookImportDecision[] = plannedBooks
          .filter((b) => b.summary.eligible)
          .map((b) => ({
            bookId: b.summary.bookId,
            importFile: b.summary.needsFileDownload,
            importPosition: b.summary.position.defaultAdopt,
            importBookmarks: b.summary.bookmarks.defaultImport,
            overridePositionConflict: false,
          }));

        return {
          planId,
          summary: { books: plannedBooks.map((b) => b.summary) },
          defaultDecisions,
        };
      } finally {
        activeOps.delete(op.key);
      }
    },

    async lanImportExecute(
      input: LanImportExecuteInput,
      onProgress: (progress: LanImportProgress) => void,
    ): Promise<LanImportExecutionReport> {
      stats.executeCount += 1;
      stats.lastRequestedDecisions = input.decisions.map((d) => ({ ...d }));
      const err = takeCommandError('lanImportExecute');
      if (err) throw err;
      const session = sessions.get(input.sessionId);
      if (!session) throw host.fail('lan_auth_expired', 'receiver session expired');
      if (session.executingPlans.has(input.planId)) {
        throw host.fail('lan_transfer_busy', 'import plan is already executing');
      }
      const plan = session.plans.get(input.planId);
      if (!plan) throw host.fail('not_found', 'import plan not found');

      session.executingPlans.add(input.planId);
      const op = registerOp(input.operationId, input.sessionId);
      const results: LanBookImportResult[] = [];
      let cancelled = false;

      try {
        for (let idx = 0; idx < input.decisions.length; idx += 1) {
          const decision = input.decisions[idx];
          if (!decision) continue;
          const planned = plan.books.find((b) => b.summary.bookId === decision.bookId);
          if (!planned) continue;

          await maybePauseOrHook('execute', planned.peer.bookId);

          if (op.state.cancelled) {
            cancelled = true;
            const result: LanBookImportResult = {
              bookId: planned.peer.bookId,
              documentId: planned.summary.localDocumentId,
              state: planned.summary.state,
              file: { status: 'cancelled' },
              position: { status: 'cancelled' },
              bookmarks: { status: 'cancelled' },
              bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
            };
            results.push(result);
            onProgress({
              phase: 'bookCompleted',
              bookId: planned.peer.bookId,
              bookIndex: idx,
              totalBooks: input.decisions.length,
              result,
            });
            continue;
          }

          onProgress({
            phase: 'bookStarted',
            bookId: planned.peer.bookId,
            bookIndex: idx,
            totalBooks: input.decisions.length,
          });

          if (!planned.summary.eligible || !planned.peer.format) {
            const result: LanBookImportResult = {
              bookId: planned.peer.bookId,
              documentId: planned.summary.localDocumentId,
              state: planned.summary.state,
              file: { status: 'blocked', reason: planned.summary.state },
              position: { status: 'skipped' },
              bookmarks: { status: 'skipped' },
              bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
            };
            results.push(result);
            onProgress({
              phase: 'bookCompleted',
              bookId: planned.peer.bookId,
              bookIndex: idx,
              totalBooks: input.decisions.length,
              result,
            });
            continue;
          }

          let fileOutcome: LanComponentOutcome = { status: 'skipped' };
          let targetDoc: StudyDocument | null = planned.summary.localDocumentId
            ? (host.documents.get(planned.summary.localDocumentId) ?? null)
            : null;
          const fileRequiredButSkipped = planned.summary.needsFileDownload && !decision.importFile;

          if (decision.importFile && planned.summary.needsFileDownload) {
            if (planned.peer.fileError) {
              fileOutcome = { status: 'failed', error: planned.peer.fileError };
            } else if (!planned.peer.bytes) {
              fileOutcome = {
                status: 'failed',
                error: { code: 'lan_source_changed', message: 'source bytes unavailable' },
              };
            } else {
              const totalBytes = planned.peer.bytes.byteLength;
              onProgress({
                phase: 'fileTransfer',
                bookId: planned.peer.bookId,
                downloadedBytes: totalBytes,
                totalBytes,
              });
              // Yield so a synchronous `lanImportCancel` issued inside the
              // `fileTransfer` progress listener (or an injected commit hook)
              // is observed BEFORE publishing the file or mutating documents.
              if (options.onBeforeBookStep || pausedPhaseTarget === 'commit') {
                await maybePauseOrHook('commit', planned.peer.bookId);
              } else {
                await Promise.resolve();
              }
              if (op.state.cancelled) {
                cancelled = true;
                const result: LanBookImportResult = {
                  bookId: planned.peer.bookId,
                  documentId: planned.summary.localDocumentId,
                  state: planned.summary.state,
                  file: { status: 'cancelled' },
                  position: { status: 'cancelled' },
                  bookmarks: { status: 'cancelled' },
                  bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
                };
                results.push(result);
                onProgress({
                  phase: 'bookCompleted',
                  bookId: planned.peer.bookId,
                  bookIndex: idx,
                  totalBooks: input.decisions.length,
                  result,
                });
                continue;
              }
              // Bounded re-verification loop: re-read the live document, verify its
              // on-disk bytes and hash, recheck cancellation, and if the document's
              // path/hash changed during async `readFile` (e.g. concurrent `relinkDocument`),
              // discard the stale read result and re-verify the current record.
              const MAX_COMMIT_VERIFY_ATTEMPTS = 3;
              let existingFileState:
                'none' | 'healthy' | 'missing' | 'changed' | 'cancelled' | 'unstable' = 'none';

              for (let attempt = 0; attempt < MAX_COMMIT_VERIFY_ATTEMPTS; attempt += 1) {
                const byId = targetDoc ? host.documents.get(targetDoc.id) : undefined;
                targetDoc =
                  (byId && byId.fileHash === planned.peer.bookId ? byId : null) ??
                  [...host.documents.values()].find(
                    (doc) => doc.fileHash === planned.peer.bookId,
                  ) ??
                  null;

                if (!targetDoc) {
                  existingFileState = 'none';
                  break;
                }

                const checkedDocId = targetDoc.id;
                const checkedPath = targetDoc.filePath;
                const checkedHash = targetDoc.fileHash;
                if (!(checkedPath in host.files)) {
                  existingFileState = 'missing';
                  break;
                }

                let readBytes: Uint8Array | null = null;
                try {
                  readBytes = await host.readFile(checkedPath);
                } catch {
                  readBytes = null;
                }

                // Recheck cancellation immediately after async `readFile` on both
                // success and failure paths before any file or metadata mutation.
                if (op.state.cancelled) {
                  existingFileState = 'cancelled';
                  break;
                }

                const afterReadDoc = host.documents.get(checkedDocId) ?? null;
                if (
                  afterReadDoc &&
                  afterReadDoc.filePath === checkedPath &&
                  afterReadDoc.fileHash === checkedHash
                ) {
                  targetDoc = afterReadDoc;
                  existingFileState =
                    readBytes === null
                      ? 'missing'
                      : host.hashBytes(readBytes) === checkedHash
                        ? 'healthy'
                        : 'changed';
                  break;
                }

                // Path or hash changed concurrently (e.g. `relinkDocument`): discard
                // stale bytes and re-verify the current record on the next iteration.
                targetDoc = null;
                existingFileState = 'unstable';
              }

              if (existingFileState === 'cancelled') {
                cancelled = true;
                const result: LanBookImportResult = {
                  bookId: planned.peer.bookId,
                  documentId: planned.summary.localDocumentId,
                  state: planned.summary.state,
                  file: { status: 'cancelled' },
                  position: { status: 'cancelled' },
                  bookmarks: { status: 'cancelled' },
                  bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
                };
                results.push(result);
                onProgress({
                  phase: 'bookCompleted',
                  bookId: planned.peer.bookId,
                  bookIndex: idx,
                  totalBooks: input.decisions.length,
                  result,
                });
                continue;
              }

              if (existingFileState === 'unstable') {
                const result: LanBookImportResult = {
                  bookId: planned.peer.bookId,
                  documentId: planned.summary.localDocumentId,
                  state: planned.summary.state,
                  file: {
                    status: 'failed',
                    error: {
                      code: 'lan_source_changed',
                      message: 'local document changed repeatedly during verification',
                    },
                  },
                  position: { status: 'skipped' },
                  bookmarks: { status: 'skipped' },
                  bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
                };
                results.push(result);
                onProgress({
                  phase: 'bookCompleted',
                  bookId: planned.peer.bookId,
                  bookIndex: idx,
                  totalBooks: input.decisions.length,
                  result,
                });
                continue;
              }

              if (targetDoc && existingFileState === 'changed') {
                planned.summary.localDocumentId = targetDoc.id;
                planned.summary.localTitle = targetDoc.title;
                planned.summary.state = 'localFileChanged';
                planned.summary.eligible = false;
                planned.summary.needsFileDownload = false;
                const result: LanBookImportResult = {
                  bookId: planned.peer.bookId,
                  documentId: targetDoc.id,
                  state: 'localFileChanged',
                  file: { status: 'blocked', reason: 'localFileChanged' },
                  position: { status: 'skipped' },
                  bookmarks: { status: 'skipped' },
                  bookmarkCounts: { inserted: 0, existing: 0, skipped: 0 },
                };
                results.push(result);
                onProgress({
                  phase: 'bookCompleted',
                  bookId: planned.peer.bookId,
                  bookIndex: idx,
                  totalBooks: input.decisions.length,
                  result,
                });
                continue;
              }

              if (targetDoc && existingFileState === 'healthy') {
                fileOutcome = { status: 'skipped' };
              } else {
                const originalExt =
                  targetDoc?.filePath.split('.').pop()?.toLowerCase() ?? planned.peer.extension;
                const destPath = targetDoc?.filePath.startsWith('/library/')
                  ? targetDoc.filePath
                  : `/library/${planned.peer.bookId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${originalExt}`;
                host.files[destPath] = planned.peer.bytes;

                if (targetDoc) {
                  const repaired: StudyDocument = {
                    ...targetDoc,
                    filePath: destPath,
                  };
                  host.documents.set(repaired.id, repaired);
                  targetDoc = repaired;
                } else {
                  const created: StudyDocument = {
                    id: crypto.randomUUID(),
                    title: planned.peer.title,
                    filePath: destPath,
                    fileHash: planned.peer.bookId,
                    format: planned.peer.format,
                    encoding: 'utf-8',
                    lastCursorAnchor: null,
                    lastProgress: null,
                    createdAt: host.monotonicNow(),
                    lastOpenedAt: null,
                  };
                  host.documents.set(created.id, created);
                  targetDoc = created;
                }
                fileOutcome = { status: 'applied' };
              }
              // Update plan state in-place so retrying the same planId never
              // creates duplicate records (mirrors Rust `ImportPlan`).
              planned.summary.localDocumentId = targetDoc.id;
              planned.summary.localTitle = targetDoc.title;
              planned.summary.state = 'alreadyPresent';
              planned.summary.needsFileDownload = false;
            }
          }

          let positionOutcome: LanComponentOutcome = { status: 'skipped' };
          if (
            !fileRequiredButSkipped &&
            decision.importPosition &&
            targetDoc &&
            planned.plannedPosition &&
            fileOutcome.status !== 'failed'
          ) {
            const currentCursor: InternalCursorSnapshot = {
              anchor: targetDoc.lastCursorAnchor,
              progress: targetDoc.lastProgress ?? null,
            };
            const casExpected =
              decision.overridePositionConflict && planned.conflictCursor !== null
                ? planned.conflictCursor
                : planned.expectedCursor;

            if (!cursorsEqual(currentCursor, casExpected)) {
              planned.conflictCursor = currentCursor;
              positionOutcome = {
                status: 'conflict',
                code: 'lan_position_conflict',
                hasCurrentPosition: currentCursor.anchor !== null,
                currentProgress: currentCursor.progress,
              };
            } else {
              const updated: StudyDocument = {
                ...targetDoc,
                lastCursorAnchor: planned.plannedPosition.anchor,
                lastProgress: planned.plannedPosition.progress,
              };
              host.documents.set(updated.id, updated);
              targetDoc = updated;
              planned.expectedCursor = {
                anchor: updated.lastCursorAnchor,
                progress: updated.lastProgress ?? null,
              };
              planned.conflictCursor = null;
              positionOutcome = { status: 'applied' };
            }
          }

          let bookmarksOutcome: LanComponentOutcome = { status: 'skipped' };
          let inserted = 0;
          let existing = planned.summary.bookmarks.existingCount;
          const skipped = planned.summary.bookmarks.skippedCount;

          if (
            !fileRequiredButSkipped &&
            decision.importBookmarks &&
            targetDoc &&
            fileOutcome.status !== 'failed'
          ) {
            const allowedIndices = decision.selectedBookmarkIndices
              ? new Set(decision.selectedBookmarkIndices)
              : null;
            const existingKeys = new Set<string>();
            for (const bm of host.bookmarks.values()) {
              if (bm.documentId === targetDoc.id) {
                existingKeys.add(bookmarkLocationKey(bm.anchor));
              }
            }
            for (const [bIdx, entry] of planned.importableBookmarks.entries()) {
              if (allowedIndices !== null && !allowedIndices.has(bIdx)) continue;
              if (!entry.anchor) continue;
              const key = bookmarkLocationKey(entry.anchor);
              if (existingKeys.has(key)) {
                existing += 1;
                continue;
              }
              existingKeys.add(key);
              const created: Bookmark = {
                id: crypto.randomUUID(),
                documentId: targetDoc.id,
                anchor: entry.anchor,
                label: entry.label ?? defaultBookmarkLabel(entry.anchor),
                createdAt: entry.createdAt ?? host.monotonicNow(),
              };
              host.bookmarks.set(created.id, created);
              inserted += 1;
            }
            bookmarksOutcome = inserted > 0 ? { status: 'applied' } : { status: 'skipped' };
          }

          const result: LanBookImportResult = {
            bookId: planned.peer.bookId,
            documentId: targetDoc?.id ?? null,
            state: planned.summary.state,
            file: fileOutcome,
            position: positionOutcome,
            bookmarks: bookmarksOutcome,
            bookmarkCounts: { inserted, existing, skipped },
          };
          results.push(result);
          onProgress({
            phase: 'bookCompleted',
            bookId: planned.peer.bookId,
            bookIndex: idx,
            totalBooks: input.decisions.length,
            result,
          });
        }

        return { books: results, cancelled };
      } finally {
        session.executingPlans.delete(input.planId);
        activeOps.delete(op.key);
      }
    },

    async lanImportCancel(operationId: string): Promise<boolean> {
      stats.cancelCount += 1;
      const op = activeOps.get(operationId);
      if (!op) return false;
      op.cancelled = true;
      return true;
    },

    async lanImportDisconnect(sessionId: string): Promise<void> {
      stats.disconnectCount += 1;
      for (const op of activeOps.values()) {
        if (op.sessionId === sessionId) {
          op.cancelled = true;
        }
      }
      sessions.delete(sessionId);
    },
  };

  const controller: MemoryLanTestController = {
    setInterfaces(nextInterfaces) {
      interfaces = nextInterfaces.map((iface) => ({ ...iface, subnet: { ...iface.subnet } }));
    },
    setBooks(books) {
      customBooks = books ? [...books] : null;
    },
    setPermissions(permissions) {
      peerPermissions = { ...permissions };
    },
    setNextError(command, error) {
      nextErrors[command] = error;
    },
    setPersistentError(command, error) {
      if (error === null) {
        delete persistentErrors[command];
      } else {
        persistentErrors[command] = error;
      }
    },
    simulateSharePaired(peerIp = '192.168.1.99') {
      shareSnapshot = {
        ...shareSnapshot,
        status: { state: 'paired', peerIp },
        pairingCode: null,
        codeExpiresAtMs: null,
      };
      return { ...shareSnapshot };
    },
    simulateShareCodeLocked() {
      shareSnapshot = {
        ...shareSnapshot,
        status: {
          state: 'codeLocked',
        },
        pairingCode: null,
        codeExpiresAtMs: null,
      };
      return { ...shareSnapshot };
    },
    simulateSharePeerBlocked(peerIp, reason = 'outOfSubnet') {
      const totalBlocked = shareSnapshot.blockedPeerCount + 1;
      shareSnapshot = {
        ...shareSnapshot,
        blockedPeerCount: totalBlocked,
        lastBlockedPeerIp: peerIp,
      };
      emitShareEvent({
        event: { kind: 'peerBlocked', peerIp, reason, totalBlocked },
        snapshot: { ...shareSnapshot },
      });
      return { ...shareSnapshot };
    },
    simulateShareStopped(reason, errorCode = null) {
      shareSnapshot = {
        ...INITIAL_LAN_SHARE_SNAPSHOT,
        lastStopReason: reason,
        lastStopErrorCode: errorCode,
      };
      emitShareEvent({
        event: { kind: 'stopped', reason, errorCode },
        snapshot: { ...shareSnapshot },
      });
      return { ...shareSnapshot };
    },
    pauseNextTransfer(phase = 'commit') {
      pausedPhaseTarget = phase;
    },
    releasePausedTransfer() {
      pausedTransferWaiter?.();
    },
    mutateLocalFile(documentId, bytes) {
      const doc = host.documents.get(documentId);
      if (!doc) throw host.fail('not_found', `document not found: ${documentId}`);
      host.files[doc.filePath] = new Uint8Array(bytes);
    },
    mutateLocalCursor(documentId, anchor, progress) {
      const doc = host.documents.get(documentId);
      if (!doc) throw host.fail('not_found', `document not found: ${documentId}`);
      host.documents.set(documentId, {
        ...doc,
        lastCursorAnchor: anchor,
        lastProgress: progress,
      });
    },
    listLocalDocuments() {
      return [...host.documents.values()].map((doc) => ({ ...doc }));
    },
    getPeerStats() {
      return {
        ...stats,
        lastRequestedDecisions: stats.lastRequestedDecisions.map((d) => ({ ...d })),
      };
    },
  };

  return { adapter, controller };
}
