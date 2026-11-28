import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { DroppedDocumentsPayload, StudyBackend } from '@/lib/backend/types';
import { detectPlatform } from '@/lib/platform';
import {
  type Annotation,
  type Bookmark,
  type CatalogBookClassification,
  type CreatedCard,
  type CreatedExcerpt,
  type DeletedCard,
  type DocumentSourceStatus,
  type LanImportExecutionReport,
  type LanImportPlanResult,
  type LanImportSessionInfo,
  type LanInterface,
  type LanShareSnapshot,
  type MindMapEdge,
  type NoteCard,
  type NotebookGraph,
  type PdfLayout,
  type ReadingPreferences,
  type RelinkDocumentResult,
  type RestoredAnnotation,
  type RestoredCard,
  type StudyDocument,
  type StudyNotebook,
  type TextChunk,
  type WorkspaceSession,
  isCatalogBookClassification,
  isLanImportExecutionReport,
  isLanImportPlanResult,
  isLanImportProgress,
  isLanImportSessionInfo,
  isLanInterface,
  isLanShareEventPayload,
  isLanShareSnapshot,
  isPlanProgress,
} from '@/types/domain';

function assertPayload<T>(value: unknown, guard: (v: unknown) => v is T, label: string): T {
  if (!guard(value)) {
    throw { code: 'internal', message: `invalid ${label} payload` };
  }
  return value;
}

function assertPayloadArray<T>(value: unknown, guard: (v: unknown) => v is T, label: string): T[] {
  if (!Array.isArray(value) || !value.every(guard)) {
    throw { code: 'internal', message: `invalid ${label} payload` };
  }
  return value;
}

const DOCUMENTS_DROPPED_EVENT = 'synapse://documents-dropped';
const BEFORE_CLOSE_EVENT = 'synapse://before-close';
const LAN_SHARE_EVENT = 'synapse://lan-share-event';
const MENU_COMMAND_EVENT = 'menu-command';

/**
 * `listen` resolves asynchronously; this unsubscribes even when disposed before
 * then, and drops anything delivered in between.
 */
function subscribe(start: (isLive: () => boolean) => Promise<UnlistenFn>): () => void {
  let disposed = false;
  let stop: UnlistenFn | null = null;
  void start(() => !disposed).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}

export function createTauriBackend(): StudyBackend {
  return {
    kind: 'tauri',
    // Only macOS gets the overlay title bar: see `create_main_window` in `lib.rs`.
    chromeStyle: detectPlatform() === 'mac' ? 'overlay' : 'standard',

    pickDocument: () => invoke<StudyDocument | null>('pick_document'),
    dropFiles: async () => ({ documents: [], errors: [] }),
    onFileDrop(listener) {
      let disposed = false;
      const unlisteners: UnlistenFn[] = [];
      const bind = <T>(event: string, handler: (payload: T) => void) => {
        void listen<T>(event, (target) => {
          if (!disposed) handler(target.payload);
        }).then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        });
      };
      bind(TauriEvent.DRAG_ENTER, () => listener({ type: 'enter' }));
      bind(TauriEvent.DRAG_LEAVE, () => listener({ type: 'leave' }));
      bind(TauriEvent.DRAG_DROP, () => listener({ type: 'leave' }));
      bind<DroppedDocumentsPayload>(DOCUMENTS_DROPPED_EVENT, (payload) => {
        listener({
          type: 'drop',
          documents: payload.documents,
          errors: payload.errors,
        });
      });
      return () => {
        disposed = true;
        for (const unlisten of unlisteners) unlisten();
      };
    },
    listDocuments: () => invoke<StudyDocument[]>('list_documents'),
    updateDocumentCursor: (documentId, anchor, progress) =>
      invoke('update_document_cursor', { documentId, anchor, progress: progress ?? null }),
    touchDocumentOpened: (documentId) =>
      invoke<StudyDocument>('touch_document_opened', { documentId }),
    hideDocumentFromRecent: (documentId) =>
      invoke<StudyDocument>('hide_document_from_recent', { documentId }),
    setDocumentDisplayTitle: (documentId, displayTitle, expectedFileHash) =>
      invoke<StudyDocument | null>('set_document_display_title', {
        documentId,
        displayTitle,
        expectedFileHash,
      }),
    verifyDocumentSource: (documentId) =>
      invoke<DocumentSourceStatus>('verify_document_source', { documentId }),
    relinkDocument: (documentId, confirmInPlace) =>
      invoke<RelinkDocumentResult | null>('relink_document', {
        documentId,
        confirmInPlace: confirmInPlace ?? false,
      }),
    getWorkspaceSession: () => invoke<WorkspaceSession>('get_workspace_session'),
    saveWorkspaceSession: (session) =>
      invoke<WorkspaceSession>('save_workspace_session', { session }),

    createNotebook: (title) => invoke<StudyNotebook>('create_notebook', { title }),
    listNotebooks: () => invoke<StudyNotebook[]>('list_notebooks'),
    saveNotebookViewport: (notebookId, viewport) =>
      invoke('save_notebook_viewport', { notebookId, viewport }),
    loadNotebookGraph: (notebookId) => invoke<NotebookGraph>('load_notebook_graph', { notebookId }),

    createExcerpt: (input) => invoke<CreatedExcerpt>('create_excerpt', { input }),
    createCardForAnnotation: (input) =>
      invoke<CreatedCard>('create_card_for_annotation', { input }),
    createAnnotation: (input) => invoke<Annotation>('create_annotation', { input }),
    updateAnnotation: (annotationId, patch) =>
      invoke<Annotation>('update_annotation', { annotationId, patch }),
    deleteAnnotation: (annotationId) => invoke('delete_annotation', { annotationId }),
    restoreAnnotation: (annotationId) =>
      invoke<RestoredAnnotation>('restore_annotation', { annotationId }),
    updateCard: (cardId, patch) => invoke<NoteCard>('update_card', { cardId, patch }),
    deleteCard: (cardId) => invoke<DeletedCard>('delete_card', { cardId }),
    restoreCard: (cardId) => invoke<RestoredCard>('restore_card', { cardId }),
    updateNodeLayout: (nodeId, patch) => invoke('update_node_layout', { nodeId, patch }),
    createEdge: (notebookId, sourceNodeId, targetNodeId, label) =>
      invoke<MindMapEdge>('create_edge', { notebookId, sourceNodeId, targetNodeId, label }),
    deleteEdge: (edgeId) => invoke('delete_edge', { edgeId }),

    async captureUrl(annotationId) {
      const path = await invoke<string | null>('capture_path', { annotationId });
      return path === null ? null : convertFileSrc(path);
    },

    getReadingPreferences: () => invoke<ReadingPreferences>('get_reading_preferences'),
    saveReadingPreferences: (preferences) =>
      invoke<ReadingPreferences>('save_reading_preferences', { preferences }),

    getPdfLayout: (documentId) => invoke<PdfLayout>('get_pdf_layout', { documentId }),
    savePdfLayout: (documentId, layout) =>
      invoke<PdfLayout>('save_pdf_layout', { documentId, layout }),

    listBookmarks: () => invoke<Bookmark[]>('list_bookmarks'),
    createBookmark: (input) => invoke<Bookmark>('create_bookmark', { input }),
    deleteBookmark: (bookmarkId) => invoke('delete_bookmark', { bookmarkId }),

    onMenuCommand: (listener) =>
      subscribe((isLive) =>
        listen<{ commandId: string }>(MENU_COMMAND_EVENT, (event) => {
          if (isLive()) listener(event.payload.commandId);
        }),
      ),
    setMenuItemStates: (states) => invoke('set_menu_item_states', { states }),
    isFullscreen: () => getCurrentWindow().isFullscreen(),
    setFullscreen: (fullscreen) => getCurrentWindow().setFullscreen(fullscreen),
    onFullscreenChange(listener) {
      const window = getCurrentWindow();
      let last: boolean | null = null;
      // Neither the green button nor Esc reports full screen directly; a resize does.
      return subscribe((isLive) =>
        window.onResized(() => {
          void window.isFullscreen().then((fullscreen) => {
            if (!isLive() || fullscreen === last) return;
            last = fullscreen;
            listener(fullscreen);
          });
        }),
      );
    },
    onBeforeClose: (listener) =>
      subscribe((isLive) =>
        listen<{ token: number }>(BEFORE_CLOSE_EVENT, (event) => {
          if (!isLive()) return;
          void listener()
            .catch(() => undefined)
            .finally(() => {
              void invoke('confirm_flush_before_close', { token: event.payload.token }).catch(
                () => undefined,
              );
            });
        }),
      ),

    // The asset protocol enforces its scope in Rust, whatever this URL names.
    loadDocumentSource: async (document) => ({
      kind: 'url',
      url: convertFileSrc(document.filePath),
    }),

    readTextStream(documentId, encoding, onChunk, signal) {
      const streamId = crypto.randomUUID();
      if (signal?.aborted) {
        void invoke<boolean>('cancel_text_stream', { streamId });
        return Promise.resolve(0);
      }
      const onAbort = () => {
        void invoke<boolean>('cancel_text_stream', { streamId });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const channel = new Channel<TextChunk>();
      channel.onmessage = (chunk) => {
        if (!signal?.aborted) onChunk(chunk);
      };
      return invoke<number>('read_text_stream', {
        documentId,
        encoding,
        streamId,
        onChunk: channel,
      }).finally(() => {
        signal?.removeEventListener('abort', onAbort);
      });
    },

    // ---- LAN Book Sync (1:1 audited against `apps/desktop/src-tauri/src/ipc_tests.rs`) ----

    lanListInterfaces: async () =>
      assertPayloadArray<LanInterface>(
        await invoke<unknown>('lan_list_interfaces'),
        isLanInterface,
        'lan_list_interfaces',
      ),
    lanShareStart: async (input) => {
      const result = await invoke<unknown>('lan_share_start', {
        input: {
          documentIds: input.documentIds,
          positions: input.positions,
          bookmarks: input.bookmarks,
          interfaceIp: input.interfaceIp ?? null,
        },
      });
      return result === null
        ? null
        : assertPayload<LanShareSnapshot>(result, isLanShareSnapshot, 'lan_share_start');
    },
    lanShareStatus: async () =>
      assertPayload<LanShareSnapshot>(
        await invoke<unknown>('lan_share_status'),
        isLanShareSnapshot,
        'lan_share_status',
      ),
    lanShareRegenerateCode: async () =>
      assertPayload<LanShareSnapshot>(
        await invoke<unknown>('lan_share_regenerate_code'),
        isLanShareSnapshot,
        'lan_share_regenerate_code',
      ),
    lanShareStop: async () =>
      assertPayload<LanShareSnapshot>(
        await invoke<unknown>('lan_share_stop'),
        isLanShareSnapshot,
        'lan_share_stop',
      ),
    lanShareDisconnectPeer: async () =>
      assertPayload<LanShareSnapshot>(
        await invoke<unknown>('lan_share_disconnect_peer'),
        isLanShareSnapshot,
        'lan_share_disconnect_peer',
      ),
    onLanShareEvent: (listener) =>
      subscribe((isLive) =>
        listen<unknown>(LAN_SHARE_EVENT, (event) => {
          if (isLive() && isLanShareEventPayload(event.payload)) {
            listener(event.payload);
          }
        }),
      ),

    lanImportConnect: async (input) =>
      assertPayload<LanImportSessionInfo>(
        await invoke<unknown>('lan_import_connect', {
          input: {
            address: input.address,
            code: input.code,
            operationId: input.operationId ?? null,
          },
        }),
        isLanImportSessionInfo,
        'lan_import_connect',
      ),
    lanImportCatalog: async (sessionId) =>
      assertPayloadArray<CatalogBookClassification>(
        await invoke<unknown>('lan_import_catalog', { sessionId }),
        isCatalogBookClassification,
        'lan_import_catalog',
      ),
    async lanImportPlan(input, onProgress) {
      const channel = new Channel<unknown>();
      channel.onmessage = (progress) => {
        if (isPlanProgress(progress)) onProgress(progress);
      };
      return assertPayload<LanImportPlanResult>(
        await invoke<unknown>('lan_import_plan', {
          input: {
            sessionId: input.sessionId,
            bookIds: input.bookIds,
            operationId: input.operationId ?? null,
          },
          onProgress: channel,
        }),
        isLanImportPlanResult,
        'lan_import_plan',
      );
    },
    async lanImportExecute(input, onProgress) {
      const channel = new Channel<unknown>();
      channel.onmessage = (progress) => {
        if (isLanImportProgress(progress)) onProgress(progress);
      };
      return assertPayload<LanImportExecutionReport>(
        await invoke<unknown>('lan_import_execute', {
          input: {
            sessionId: input.sessionId,
            planId: input.planId,
            decisions: input.decisions,
            operationId: input.operationId ?? null,
          },
          onProgress: channel,
        }),
        isLanImportExecutionReport,
        'lan_import_execute',
      );
    },
    lanImportCancel: (operationId) => invoke<boolean>('lan_import_cancel', { operationId }),
    lanImportDisconnect: (sessionId) => invoke('lan_import_disconnect', { sessionId }),
  };
}
